import { access, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { applyOwnerEpochTransfer } from "../ownership/ownerController.js";
import { classifyOwnerProcess } from "../ownership/ownerLiveness.js";
import { appendEvent, writeOwnerTransferArtifacts } from "../persistence/fileStore.js";
import { buildProcessInstanceId } from "../runtime/processIdentity.js";
import type { OwnerRecord, ReconciliationRecord } from "../runtime/types.js";
import type { RunState } from "../state/types.js";

export const CRASH_ADOPTION_REASON = "owner process confirmed dead by resume";
const BOUNDARY = { planning: "planning", executing: "execute", verifying: "verify" } as const;

/** Spec 2026-10-02 crash-resume §4.3 step 3: a run directory inside an Orca control source dir is Orca's to recover. */
export async function isOrcaControlRunDir(runDir: string): Promise<boolean> {
  if (basename(runDir) !== "run") return false;
  return stat(join(dirname(runDir), "control")).then((s) => s.isDirectory(), () => false);
}

/**
 * Spec §4.3 step 6, first half: the run has no owner-transfer.json (its loop was killed before publishing one), so
 * it may be adopted only when its owner process is confirmed dead; `alive` and `undetermined` both refuse. Runs
 * BEFORE any reaping (controller ruling, Task 6 fix round 1): a resume that is about to refuse because the owner may
 * be alive must not first signal that owner's process groups.
 */
export async function confirmOwnerDead(
  ownerRecord: OwnerRecord,
  deps: { classify?: typeof classifyOwnerProcess } = {},
): Promise<{ ok: true; reason: string } | { ok: false; reason: string }> {
  const owner = await (deps.classify ?? classifyOwnerProcess)(ownerRecord);
  if (owner.verdict !== "dead") return { ok: false, reason: `no owner transfer and the owner is ${owner.verdict}: ${owner.reason}` };
  return { ok: true, reason: owner.reason };
}

/**
 * Spec §4.3 step 6, second half, called only after confirmOwnerDead answered ok (its reason is `ownerDeadReason`)
 * and the run's orphans were reaped. The write goes through the existing transfer transaction with `ownerRecord` as
 * the CAS expectation, so of two racing resumes exactly one adopts; that write's lock and CAS errors are thrown for
 * the caller to map. A failure to record the event after the write committed is returned as its own refusal.
 */
export async function adoptCrashedRun(
  runDir: string,
  ownerRecord: OwnerRecord,
  runState: RunState,
  ownerDeadReason: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const boundary = BOUNDARY[runState.status as keyof typeof BOUNDARY];
  if (boundary === undefined) return { ok: false, reason: `run status ${runState.status} is not resumable` };
  const at = new Date().toISOString();
  const transfer = applyOwnerEpochTransfer(ownerRecord, buildProcessInstanceId(), at, CRASH_ADOPTION_REASON);
  const reconciliation: ReconciliationRecord = {
    staleSuspicionBasis: [`lease not fresh (leaseAffirmedAt ${String(ownerRecord.leaseAffirmedAt ?? null)})`, ownerDeadReason],
    staleConfirmed: true,
    ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: boundary,
    conflictingEvidence: [],
    takeoverPermission: { allowed: true, reason: CRASH_ADOPTION_REASON },
    priorOwnerEpoch: ownerRecord.currentOwnerEpoch,
    newOwnerEpoch: transfer.transferRecord.newOwnerEpoch,
    eligibleForContinuation: true,
  };
  // A reconciliation record without a transfer is what a contended earlier transfer leaves (newOwnerEpoch null);
  // this write replaces it, and the event says so.
  const replaced = await access(join(runDir, "reconciliation-record.json")).then(() => true, () => false);
  await writeOwnerTransferArtifacts(runDir, ownerRecord, transfer.nextOwnerRecord, transfer.transferRecord, reconciliation);
  try {
    await appendEvent(runDir, {
      type: "owner_crash_adopted",
      at,
      detail: `epoch ${transfer.transferRecord.priorOwnerEpoch} -> ${transfer.transferRecord.newOwnerEpoch}: ${ownerRecord.currentProcessInstanceId} confirmed dead (${ownerDeadReason})${replaced ? "; replaced a reconciliation record that had no transfer" : ""}`,
    });
  } catch (error) {
    return { ok: false, reason: `adoption committed but its event could not be recorded: ${String(error)}` };
  }
  return { ok: true };
}
