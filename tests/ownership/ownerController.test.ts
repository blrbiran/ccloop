import { describe, expect, it } from "vitest";
import { applyOwnerEpochTransfer, evaluateOwnership } from "../../src/ownership/ownerController.js";

describe("ownerController", () => {
  it("returns OWNER_LOST only when persisted truth is no longer supported and no trusted continuity evidence remains", () => {
    const result = evaluateOwnership({
      ownerRecord: {
        runId: "task-1",
        logicalSessionId: "task-1/session-1",
        currentOwnerEpoch: 1,
        currentProcessInstanceId: "pid:12345",
        lastAffirmedAt: "2026-07-22T10:00:00.000Z",
        ownerStatus: "current",
        supersededByEpoch: null,
      },
      persistedOwnerStillSupported: false,
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-22T10:00:00.000Z",
        weakProgressAt: null,
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      currentProcessStillTrusted: false,
      supportingContinuityEvidence: [],
      knownSupersedingEpoch: null,
      lastTrustedBoundary: "execute",
    });

    expect(result.verdict).toBe("OWNER_LOST");
    expect(result.takeoverAllowed).toBe(true);
  });

  it("returns OWNER_UNDECIDABLE when stale suspicion exists but persisted owner support is still unresolved", () => {
    const result = evaluateOwnership({
      ownerRecord: {
        runId: "task-1",
        logicalSessionId: "task-1/session-1",
        currentOwnerEpoch: 1,
        currentProcessInstanceId: "pid:12345",
        lastAffirmedAt: "2026-07-22T10:00:00.000Z",
        ownerStatus: "current",
        supersededByEpoch: null,
      },
      persistedOwnerStillSupported: true,
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-22T10:00:00.000Z",
        weakProgressAt: null,
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      currentProcessStillTrusted: false,
      supportingContinuityEvidence: [],
      knownSupersedingEpoch: null,
      lastTrustedBoundary: "execute",
    });

    expect(result.verdict).toBe("OWNER_UNDECIDABLE");
    expect(result.takeoverAllowed).toBe(false);
  });

  it("returns OWNER_SUPERSEDED when a newer owner epoch already exists", () => {
    const result = evaluateOwnership({
      ownerRecord: {
        runId: "task-1",
        logicalSessionId: "task-1/session-1",
        currentOwnerEpoch: 1,
        currentProcessInstanceId: "pid:12345",
        lastAffirmedAt: "2026-07-22T10:00:00.000Z",
        ownerStatus: "current",
        supersededByEpoch: 2,
      },
      persistedOwnerStillSupported: false,
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-22T10:00:00.000Z",
        weakProgressAt: null,
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "new owner epoch already recorded",
      },
      currentProcessStillTrusted: false,
      supportingContinuityEvidence: [],
      knownSupersedingEpoch: 2,
      lastTrustedBoundary: "execute",
    });

    expect(result.verdict).toBe("OWNER_SUPERSEDED");
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
