import type { OwnerRecord, OwnerTransferRecord } from "../runtime/types.js";
import type { OwnershipEvaluation, OwnershipEvaluationInput } from "../state/types.js";

export function evaluateOwnership(input: OwnershipEvaluationInput): OwnershipEvaluation {
  if (input.knownSupersedingEpoch !== null) {
    return {
      verdict: "OWNER_SUPERSEDED",
      reasons: [`owner epoch ${input.ownerRecord.currentOwnerEpoch} superseded by ${input.knownSupersedingEpoch}`],
      takeoverAllowed: false,
      lastTrustedBoundary: input.lastTrustedBoundary,
    };
  }

  if (input.currentProcessStillTrusted || input.supportingContinuityEvidence.length > 0) {
    return {
      verdict: "OWNER_VALID",
      reasons: ["current owner still has trusted continuity evidence"],
      takeoverAllowed: false,
      lastTrustedBoundary: input.lastTrustedBoundary,
    };
  }

  if (input.boundaryAnalysis.status !== "stale_candidate") {
    return {
      verdict: "OWNER_UNDECIDABLE",
      reasons: ["owner loss cannot be proven without stale-candidate evidence"],
      takeoverAllowed: false,
      lastTrustedBoundary: input.lastTrustedBoundary,
    };
  }

  if (input.persistedOwnerStillSupported) {
    return {
      verdict: "OWNER_UNDECIDABLE",
      reasons: ["persisted owner truth still supports the current owner"],
      takeoverAllowed: false,
      lastTrustedBoundary: input.lastTrustedBoundary,
    };
  }

  if (input.lastTrustedBoundary === "unknown") {
    return {
      verdict: "OWNER_UNDECIDABLE",
      reasons: ["last trusted boundary is unknown"],
      takeoverAllowed: false,
      lastTrustedBoundary: input.lastTrustedBoundary,
    };
  }

  return {
    verdict: "OWNER_LOST",
    reasons: [input.boundaryAnalysis.staleCandidateReason ?? "stale continuity evidence"],
    takeoverAllowed: true,
    lastTrustedBoundary: input.lastTrustedBoundary,
  };
}

export function applyOwnerEpochTransfer(
  ownerRecord: OwnerRecord,
  nextProcessInstanceId: string,
  at: string,
  reason: string,
): { nextOwnerRecord: OwnerRecord; transferRecord: OwnerTransferRecord } {
  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;

  return {
    nextOwnerRecord: {
      ...ownerRecord,
      currentOwnerEpoch: nextEpoch,
      currentProcessInstanceId: nextProcessInstanceId,
      lastAffirmedAt: at,
      ownerStatus: "current",
      supersededByEpoch: null,
    },
    transferRecord: {
      priorOwnerEpoch: ownerRecord.currentOwnerEpoch,
      newOwnerEpoch: nextEpoch,
      priorProcessInstanceId: ownerRecord.currentProcessInstanceId,
      newProcessInstanceId: nextProcessInstanceId,
      transferredAt: at,
      reason,
      eligibleForContinuation: true,
    },
  };
}
