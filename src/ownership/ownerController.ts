import type { OwnerRecord, OwnerTransferRecord, OwnershipVerdict } from "../runtime/types.js";
import type { OwnershipEvaluation, OwnershipEvaluationInput } from "../state/types.js";

function createEvaluation(
  input: OwnershipEvaluationInput,
  verdict: OwnershipVerdict,
  reasons: string[],
  takeoverAllowed: boolean,
): OwnershipEvaluation {
  return {
    verdict,
    reasons,
    takeoverAllowed,
    lastTrustedBoundary: input.lastTrustedBoundary,
  };
}

export function evaluateOwnership(input: OwnershipEvaluationInput): OwnershipEvaluation {
  const hasSupportingContinuityEvidence =
    input.currentProcessStillTrusted || input.supportingContinuityEvidence.length > 0;

  if (input.ownerRecord.supersededByEpoch !== null) {
    if (
      input.knownSupersedingEpoch !== null
      && input.knownSupersedingEpoch !== input.ownerRecord.supersededByEpoch
    ) {
      return createEvaluation(
        input,
        "OWNER_UNDECIDABLE",
        ["persisted owner supersede epoch conflicts with other superseding evidence"],
        false,
      );
    }

    return createEvaluation(
      input,
      "OWNER_SUPERSEDED",
      [
        `persisted owner record shows owner epoch ${input.ownerRecord.currentOwnerEpoch} superseded by ${input.ownerRecord.supersededByEpoch}`,
      ],
      false,
    );
  }

  if (input.knownSupersedingEpoch !== null) {
    return createEvaluation(
      input,
      "OWNER_UNDECIDABLE",
      ["a newer owner epoch is claimed but the persisted owner record does not confirm it"],
      false,
    );
  }

  if (input.ownerRecord.ownerStatus === "unknown") {
    return createEvaluation(input, "OWNER_UNDECIDABLE", ["persisted owner record status is unknown"], false);
  }

  if (input.ownerRecord.ownerStatus === "lost") {
    if (input.persistedOwnerStillSupported) {
      return createEvaluation(
        input,
        "OWNER_UNDECIDABLE",
        ["persisted owner record marks the owner lost but persisted support still reports it valid"],
        false,
      );
    }

    if (hasSupportingContinuityEvidence) {
      return createEvaluation(
        input,
        "OWNER_UNDECIDABLE",
        ["supporting continuity evidence conflicts with persisted owner loss"],
        false,
      );
    }

    if (input.lastTrustedBoundary === "unknown") {
      return createEvaluation(input, "OWNER_UNDECIDABLE", ["last trusted boundary is unknown"], false);
    }

    return createEvaluation(
      input,
      "OWNER_LOST",
      [input.boundaryAnalysis.staleCandidateReason ?? "persisted owner record marks the owner lost"],
      true,
    );
  }

  if (hasSupportingContinuityEvidence) {
    if (!input.persistedOwnerStillSupported) {
      return createEvaluation(
        input,
        "OWNER_UNDECIDABLE",
        ["supporting continuity evidence conflicts with persisted owner truth"],
        false,
      );
    }

    return createEvaluation(
      input,
      "OWNER_VALID",
      ["current owner still has trusted continuity evidence"],
      false,
    );
  }

  if (input.boundaryAnalysis.status !== "stale_candidate") {
    return createEvaluation(
      input,
      "OWNER_UNDECIDABLE",
      ["owner loss cannot be proven without stale-candidate evidence"],
      false,
    );
  }

  if (input.persistedOwnerStillSupported) {
    return createEvaluation(
      input,
      "OWNER_UNDECIDABLE",
      ["persisted owner truth still supports the current owner"],
      false,
    );
  }

  if (input.lastTrustedBoundary === "unknown") {
    return createEvaluation(input, "OWNER_UNDECIDABLE", ["last trusted boundary is unknown"], false);
  }

  return createEvaluation(
    input,
    "OWNER_LOST",
    [input.boundaryAnalysis.staleCandidateReason ?? "stale continuity evidence"],
    true,
  );
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
