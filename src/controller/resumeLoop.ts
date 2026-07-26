import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadContract } from "../contract/loadContract.js";
import {
  appendEvent,
  claimOwnerRecordWithPrecondition,
  readOwnerRecord,
  readOwnerTransferRecord,
  readReconciliationRecord,
  readRunState,
} from "../persistence/fileStore.js";
import type { OwnerRecord, OwnerTransferRecord, ReconciliationRecord, RuntimeAdapter } from "../runtime/types.js";
import { buildProcessInstanceId } from "../runtime/processIdentity.js";
import type { RunState, RunStatus } from "../state/types.js";
import { checkRunLease } from "./leaseGate.js";
import { startLeaseHeartbeat } from "./leaseHeartbeat.js";
import { cleanupAttemptWorkspaceBestEffort, runLoopFromState } from "./runLoop.js";

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

export async function resumeLoop(runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
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
    [ownerRecord, ownerTransfer, reconciliation, runState, contract] = await Promise.all([
      readOwnerRecord(runDir),
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
    await claimOwnerRecordWithPrecondition(runDir, ownerRecord, nextOwnerRecord);
  } catch (error) {
    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail: `claim CAS failed: ${String(error)}` });
    throw new ResumeNotEligibleError(`claim CAS failed: ${String(error)}`);
  }

  await appendEvent(runDir, {
    type: "resume_adopted",
    at: new Date().toISOString(),
    detail: `epoch ${ownerRecord.currentOwnerEpoch}: ${ownerTransfer.priorProcessInstanceId} -> ${buildProcessInstanceId()}`,
  });

  // §6.0: started only now — after the CAS claim has succeeded, so the record on disk names
  // this process — and never before, so it can never affirm a lease this process does not
  // hold. nextOwnerRecord is exactly what claimOwnerRecordWithPrecondition wrote, so it is
  // the correct starting `expected` record for the heartbeat's CAS chain.
  const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: nextOwnerRecord, onLeaseLost: () => {} });

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

    return await runLoopFromState(contract, runDir, adapter, resumedState, heartbeat);
  } finally {
    // §6.0: every exit path — normal completion, stop-boundary exit, and any throw.
    await heartbeat.stop();
  }
}
