import { describe, expect, it } from "vitest";
import { applyOwnerEpochTransfer, evaluateOwnership } from "../../src/ownership/ownerController.js";

describe("ownerController", () => {
  const baseInput = {
    ownerRecord: {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
    },
    persistedOwnerStillSupported: false,
    boundaryAnalysis: {
      status: "stale_candidate" as const,
      strongProgressAt: "2026-07-22T10:00:00.000Z",
      weakProgressAt: null,
      suspectReason: "healthy window exceeded",
      staleCandidateReason: "continuity evidence missing",
    },
    currentProcessStillTrusted: false,
    supportingContinuityEvidence: [] as string[],
    knownSupersedingEpoch: null,
    lastTrustedBoundary: "execute" as const,
  };

  it("returns OWNER_LOST only when persisted truth is no longer supported and no trusted continuity evidence remains", () => {
    const result = evaluateOwnership(baseInput);

    expect(result.verdict).toBe("OWNER_LOST");
    expect(result.takeoverAllowed).toBe(true);
  });

  it("returns OWNER_UNDECIDABLE when stale suspicion exists but persisted owner support is still unresolved", () => {
    const result = evaluateOwnership({
      ...baseInput,
      persistedOwnerStillSupported: true,
    });

    expect(result.verdict).toBe("OWNER_UNDECIDABLE");
    expect(result.takeoverAllowed).toBe(false);
  });

  it("returns OWNER_SUPERSEDED when a newer owner epoch already exists", () => {
    const result = evaluateOwnership({
      ...baseInput,
      ownerRecord: {
        ...baseInput.ownerRecord,
        supersededByEpoch: 2,
      },
      knownSupersedingEpoch: 2,
      boundaryAnalysis: {
        ...baseInput.boundaryAnalysis,
        staleCandidateReason: "new owner epoch already recorded",
      },
    });

    expect(result.verdict).toBe("OWNER_SUPERSEDED");
    expect(result.takeoverAllowed).toBe(false);
  });

  it("returns OWNER_UNDECIDABLE when supporting evidence contradicts unsupported persisted truth", () => {
    const result = evaluateOwnership({
      ...baseInput,
      currentProcessStillTrusted: true,
      supportingContinuityEvidence: ["same pid still alive"],
    });

    expect(result.verdict).toBe("OWNER_UNDECIDABLE");
    expect(result.verdict).not.toBe("OWNER_VALID");
    expect(result.takeoverAllowed).toBe(false);
  });

  it("returns OWNER_SUPERSEDED when the persisted owner record alone shows a superseding epoch", () => {
    const result = evaluateOwnership({
      ...baseInput,
      ownerRecord: {
        ...baseInput.ownerRecord,
        supersededByEpoch: 3,
      },
    });

    expect(result.verdict).toBe("OWNER_SUPERSEDED");
    expect(result.takeoverAllowed).toBe(false);
  });

  it("returns OWNER_UNDECIDABLE when an external superseding claim is not confirmed by the persisted owner record", () => {
    const result = evaluateOwnership({
      ...baseInput,
      knownSupersedingEpoch: 2,
    });

    expect(result.verdict).toBe("OWNER_UNDECIDABLE");
    expect(result.takeoverAllowed).toBe(false);
  });

  it("returns OWNER_UNDECIDABLE when persisted lost status conflicts with supporting continuity evidence", () => {
    const result = evaluateOwnership({
      ...baseInput,
      ownerRecord: {
        ...baseInput.ownerRecord,
        ownerStatus: "lost",
      },
      currentProcessStillTrusted: true,
      supportingContinuityEvidence: ["heartbeat still current"],
    });

    expect(result.verdict).toBe("OWNER_UNDECIDABLE");
    expect(result.takeoverAllowed).toBe(false);
  });

  it("rotates owner epoch atomically and emits a continuation-eligibility transfer record", () => {
    const result = applyOwnerEpochTransfer(
      {
        runId: "task-1",
        logicalSessionId: "task-1/session-1",
        currentOwnerEpoch: 1,
        currentProcessInstanceId: "pid:12345",
        lastAffirmedAt: "2026-07-22T10:00:00.000Z",
        ownerStatus: "current",
        supersededByEpoch: null,
      },
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    expect(result.nextOwnerRecord.currentOwnerEpoch).toBe(2);
    expect(result.nextOwnerRecord.currentProcessInstanceId).toBe("pid:67890");
    expect(result.transferRecord.priorOwnerEpoch).toBe(1);
    expect(result.transferRecord.newOwnerEpoch).toBe(2);
    expect(result.transferRecord.eligibleForContinuation).toBe(true);
  });
});
