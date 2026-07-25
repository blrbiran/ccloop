import type { OwnerRecord, OwnerTransferRecord, ReconciliationRecord } from "../runtime/types.js";
import type { RunState, RunStatus } from "../state/types.js";

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
