import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadContract } from "../contract/loadContract.js";
import {
  appendEvent,
  claimOwnerRecordWithPrecondition,
  OwnerTransferLockBusyError,
  readOwnerRecord,
  readOwnerTransferRecord,
  readReconciliationRecord,
  readRunState,
} from "../persistence/fileStore.js";
import type { OwnerRecord, OwnerTransferRecord, ReconciliationRecord, RuntimeAdapter } from "../runtime/types.js";
import { buildProcessInstanceId } from "../runtime/processIdentity.js";
import type { RunState, RunStatus } from "../state/types.js";
import type { RunLeaseLostError } from "../ownership/lease.js";
import { checkRunLease } from "./leaseGate.js";
import { startLeaseHeartbeat } from "./leaseHeartbeat.js";
import {
  cleanupAttemptWorkspaceBestEffort,
  createLeaseLossSignal,
  OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS,
  OWNER_TRANSFER_LOCK_RETRY_DELAY_MS,
  runLoopFromState,
} from "./runLoop.js";
import type { StopRequestSignal } from "./runLoop.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Package 2 / §13 4th entry, review round 2 (I-1). D2 made writeBoundaryArtifacts take
// .owner-transfer.lock on EVERY stale_candidate boundary write, so this claim — which takes the
// same lock — can now meet a holder that is merely writing a boundary artifact, where before D2 it
// met one only during an actual transfer or claim. That turned a near-impossible collision into a
// routine one, and with no retry here it surfaced as a resume refused for a contention that clears
// in microseconds.
//
// Bounded retry, lock-busy only, is this codebase's existing answer to exactly this error, and the
// shape below is persistOwnerTransfer's (spec §5.2 requirements 1 and 2) with nothing added: the
// same two exported constants, the same "retry busy, rethrow everything else, rethrow on the last
// attempt" test. A CAS mismatch is NOT retried, for persistOwnerTransfer's own stated reason —
// retrying it would re-run the CAS against evidence this resume never evaluated.
//
// claimOwnerRecordWithPrecondition itself is deliberately NOT touched. The retry belongs to the
// caller here exactly as it belongs to persistOwnerTransfer there, so the fail-fast primitive keeps
// its meaning for every other caller, and this change stays inside resume's own policy.
//
// The refusal is still recorded exactly once: this helper only decides WHEN to give up, and the
// single appendEvent in the call site's catch below is untouched.
async function claimOwnerRecordWithBoundedLockRetry(
  runDir: string,
  expectedOwnerRecord: OwnerRecord,
  nextOwnerRecord: OwnerRecord,
): Promise<void> {
  for (let attempt = 0; attempt < OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await delay(OWNER_TRANSFER_LOCK_RETRY_DELAY_MS);
    }

    try {
      await claimOwnerRecordWithPrecondition(runDir, expectedOwnerRecord, nextOwnerRecord);
      return;
    } catch (error) {
      const isLastAttempt = attempt === OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS - 1;
      if (!(error instanceof OwnerTransferLockBusyError) || isLastAttempt) {
        throw error;
      }
    }
  }
}

export class ResumeNotEligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeNotEligibleError";
  }
}

export type ResumeGateInput = {
  ownerRecord: OwnerRecord;
  ownerTransfer: OwnerTransferRecord;
  reconciliation: ReconciliationRecord;
  runState: RunState;
};

export type ResumeEligibility = { ok: true } | { ok: false; reason: string };

const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "verifying"];

export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibility {
  const { ownerRecord, ownerTransfer, reconciliation, runState } = input;

  if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {
    return { ok: false, reason: "owner-transfer is not eligible for continuation" };
  }
  if (reconciliation.eligibleForContinuation !== true) {
    return { ok: false, reason: "reconciliation-record is not eligible for continuation" };
  }
  if (reconciliation.ownershipVerdict !== "OWNER_LOST") {
    return { ok: false, reason: `reconciliation verdict is ${reconciliation.ownershipVerdict}, expected OWNER_LOST` };
  }
  if (reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
    return { ok: false, reason: "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch" };
  }
  if (ownerRecord.supersededByEpoch !== null) {
    return { ok: false, reason: `owner epoch is superseded by ${ownerRecord.supersededByEpoch}` };
  }
  if (ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
    return { ok: false, reason: "published eligibility has been superseded by a newer owner epoch" };
  }
  if (ownerRecord.ownerStatus !== "current") {
    return { ok: false, reason: `owner status is ${ownerRecord.ownerStatus}, expected current` };
  }
  if (!RESUMABLE_STATUSES.includes(runState.status)) {
    return { ok: false, reason: `run status ${runState.status} is not resumable` };
  }

  return { ok: true };
}

async function cleanupResidualWorktrees(repoPath: string, runDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(join(runDir, "worktrees"));
  } catch {
    return; // no residual worktrees dir — nothing to clean
  }
  for (const name of names) {
    await cleanupAttemptWorkspaceBestEffort(
      repoPath,
      join(runDir, "worktrees", name),
      runDir,
      "best-effort cleanup of residual worktree before resume",
    );
  }
}

// A8 §4.3: same shape as RunLoopFromStateOptions — an optional parameter OBJECT, so the 14
// existing two-argument call sites stay untouched and later layers add keys rather than
// positions.
export type ResumeLoopOptions = {
  onReconciliationWriteAbandoned?: (detail: string) => void;
  // Task B2: forwarded to runLoopFromState below, never read here. resumeLoop's own refusals
  // (the lease gate, the eligibility gate, the claim CAS) all run before the loop exists, and a
  // stop request is not a reason to refuse a resume — it is a reason for the loop this resume
  // starts to return at its first phase boundary.
  stopRequested?: StopRequestSignal;
  // Task C1 / L3 §6: fired exactly once, after the `resume_adopted` event has been appended and
  // before runLoopFromState is entered — i.e. at the instant all four refusals are behind us and
  // this process has adopted the run. sweepRuns counts its --max-runs quota here rather than at
  // this function's return, because a throw out of runLoopFromState's pre-try head (writeRunState
  // / affirmNow) would otherwise refund a run whose paid attempts had already happened. Called
  // before the heartbeat exists, so a callback that throws leaves nothing started to stop; it
  // does abort this resume after the adoption event, which is the caller's own risk to take.
  onAdopted?: () => void;
};

export async function resumeLoop(
  runDir: string,
  adapter: RuntimeAdapter,
  options?: ResumeLoopOptions,
): Promise<RunState> {
  await appendEvent(runDir, { type: "resume_requested", at: new Date().toISOString(), detail: runDir });

  // §7: the lease check runs BEFORE the eligibility gate and before the owner-record
  // claim, so a live lease refuses earlier and more cheaply than any eligibility
  // reasoning. It is an ADDITIONAL refusal layered on top of — never in place of — the
  // eligibility gate and the CAS precondition below.
  try {
    await checkRunLease(runDir, buildProcessInstanceId());
  } catch (error) {
    await appendEvent(runDir, {
      type: "resume_denied",
      at: new Date().toISOString(),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  let ownerRecord;
  let ownerTransfer;
  let reconciliation;
  let runState;
  let contract;
  try {
    // Package 2 whole-branch review, Lane 1 finding I-4. readOwnerRecord is awaited FIRST, on its
    // own, and the rest are read only afterwards. It is the one read here that is not a read: it
    // runs recoverInterruptedOwnerTransfer, which takes the transfer lock, reads the marker and
    // performs the transaction's three renames. Issued inside the same Promise.all, the unguarded
    // readReconciliationRecord starts in the same tick and does not wait for that recovery, so a
    // run interrupted between rename #2 (owner-record.json) and rename #3
    // (reconciliation-record.json) — a real gap in finalizeOrder — was read mid-transaction: the
    // third file was still absent, the ENOENT hit the catch below, and the run was refused with
    // "cannot read run artifacts" although nothing was wrong with it that the recovery already in
    // flight was not about to fix. It healed on the NEXT resume, which is what hid this.
    //
    // Sequencing adds no guarantee and no new refusal; it only lets the reads that follow observe
    // what the recovery committed. It also matches the division of labour leaseGate already has
    // with readOwnerRecordWithoutRecovery: the path that goes on to claim is the one that performs
    // recovery, and everyone else reads what it published.
    ownerRecord = await readOwnerRecord(runDir);
    [ownerTransfer, reconciliation, runState, contract] = await Promise.all([
      readOwnerTransferRecord(runDir),
      readReconciliationRecord(runDir),
      readRunState(runDir),
      loadContract(join(runDir, "loop-contract.json")),
    ]);
  } catch (error) {
    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail: `cannot read run artifacts: ${String(error)}` });
    throw new ResumeNotEligibleError(`cannot read run artifacts: ${String(error)}`);
  }

  const eligibility = evaluateResumeEligibility({ ownerRecord, ownerTransfer, reconciliation, runState });
  if (!eligibility.ok) {
    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail: eligibility.reason });
    throw new ResumeNotEligibleError(eligibility.reason);
  }

  const nextOwnerRecord = {
    ...ownerRecord,
    currentProcessInstanceId: buildProcessInstanceId(),
    lastAffirmedAt: new Date().toISOString(),
    leaseAffirmedAt: null,
  };
  try {
    await claimOwnerRecordWithBoundedLockRetry(runDir, ownerRecord, nextOwnerRecord);
  } catch (error) {
    // §3: stays fail-closed either way, but a busy lock never evaluated a CAS, so the detail
    // must not claim one did.
    const detail = error instanceof OwnerTransferLockBusyError
      ? `owner-transfer lock busy: ${String(error)}`
      : `claim CAS failed: ${String(error)}`;
    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail });
    throw new ResumeNotEligibleError(detail);
  }

  await appendEvent(runDir, {
    type: "resume_adopted",
    at: new Date().toISOString(),
    detail: `epoch ${ownerRecord.currentOwnerEpoch}: ${ownerTransfer.priorProcessInstanceId} -> ${buildProcessInstanceId()}`,
  });

  options?.onAdopted?.();

  // §6.0: started only now — after the CAS claim has succeeded, so the record on disk names
  // this process — and never before, so it can never affirm a lease this process does not
  // hold. nextOwnerRecord is exactly what claimOwnerRecordWithPrecondition wrote, so it is
  // the correct starting `expected` record for the heartbeat's CAS chain.
  const leaseLoss = createLeaseLossSignal();
  const heartbeat = startLeaseHeartbeat({
    runDir,
    ownerRecord: nextOwnerRecord,
    onLeaseLost: (error) => {
      leaseLoss.lost = error as RunLeaseLostError;
    },
  });

  try {
    await cleanupResidualWorktrees(contract.context.repoPath, runDir);

    // The interrupted attempt (and its worktree) is discarded by cleanup above, so resume
    // always restarts from a fresh "planning" phase for the next attempt — regardless of
    // which resumable status ("planning" | "executing" | "verifying") the run was
    // interrupted at. runLoopFromState requires status "planning" on entry to legally
    // transition to "executing" once the plan phase completes (see legalTransitions in
    // ../state/stateMachine.js); "executing" -> "planning" is not itself a legal transition,
    // so this normalizes the persisted state directly rather than routing through
    // transitionRunState.
    const resumedState: RunState =
      runState.status === "planning"
        ? runState
        : { ...runState, status: "planning", waitingOnHuman: false, lastTransitionAt: new Date().toISOString() };

    return await runLoopFromState(contract, runDir, adapter, resumedState, heartbeat, leaseLoss, {
      onReconciliationWriteAbandoned: options?.onReconciliationWriteAbandoned,
      stopRequested: options?.stopRequested,
    });
  } finally {
    // §6.0: every exit path — normal completion, stop-boundary exit, and any throw.
    await heartbeat.stop();
  }
}
