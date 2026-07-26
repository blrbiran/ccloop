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
      leaseAffirmedAt: null,
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
    leaseFresh: "unknown" as const,
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
        leaseAffirmedAt: null,
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

  // §9.1 regression fence. In L1 no production caller ever passes `true`, so without this
  // the field could silently rot. Every existing case must be identical under "unknown"
  // AND under false — anything else means freshness leaked into a verdict path.
  it.each([false, "unknown"] as const)("changes no verdict when leaseFresh is %s", (leaseFresh) => {
    const cases = [
      baseInput,
      { ...baseInput, persistedOwnerStillSupported: true },
      { ...baseInput, ownerRecord: { ...baseInput.ownerRecord, ownerStatus: "lost" as const } },
      { ...baseInput, ownerRecord: { ...baseInput.ownerRecord, ownerStatus: "unknown" as const } },
      { ...baseInput, ownerRecord: { ...baseInput.ownerRecord, supersededByEpoch: 2 } },
      { ...baseInput, knownSupersedingEpoch: 3 },
      { ...baseInput, currentProcessStillTrusted: true, persistedOwnerStillSupported: true },
      { ...baseInput, lastTrustedBoundary: "unknown" as const },
      { ...baseInput, boundaryAnalysis: { ...baseInput.boundaryAnalysis, status: "healthy" as const } },
    ];

    for (const input of cases) {
      expect(evaluateOwnership({ ...input, leaseFresh })).toEqual(
        evaluateOwnership({ ...input, leaseFresh: "unknown" }),
      );
    }
  });

  // §4.2: a live lease is a counter-claim. It may only push toward refusal.
  it("blocks OWNER_LOST and takeover when the lease is fresh", () => {
    const withoutLease = evaluateOwnership(baseInput);
    expect(withoutLease.verdict).toBe("OWNER_LOST");
    expect(withoutLease.takeoverAllowed).toBe(true);

    const withLease = evaluateOwnership({ ...baseInput, leaseFresh: true });

    expect(withLease.verdict).toBe("OWNER_UNDECIDABLE");
    expect(withLease.takeoverAllowed).toBe(false);
    expect(withLease.reasons.join(" ")).toContain("live run lease");
  });

  it("blocks OWNER_LOST via the persisted-owner-lost path too when the lease is fresh", () => {
    const input = {
      ...baseInput,
      ownerRecord: { ...baseInput.ownerRecord, ownerStatus: "lost" as const },
    };
    expect(evaluateOwnership(input).verdict).toBe("OWNER_LOST");

    expect(evaluateOwnership({ ...input, leaseFresh: true }).verdict).toBe("OWNER_UNDECIDABLE");
  });

  // A fresh lease must not turn a refusal into a permission — it only ever adds refusals.
  it("never upgrades a verdict: OWNER_SUPERSEDED stays superseded under a fresh lease", () => {
    const input = {
      ...baseInput,
      ownerRecord: { ...baseInput.ownerRecord, supersededByEpoch: 2 },
    };

    expect(evaluateOwnership({ ...input, leaseFresh: true })).toEqual(evaluateOwnership(input));
  });
});
