import { describe, expect, it } from "vitest";
import { applyOwnerEpochTransfer } from "../../src/ownership/ownerController.js";
import type { OwnerRecord } from "../../src/runtime/types.js";

function ownerRecord(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1:t0",
    currentOwnerEpoch: 1,
    currentProcessInstanceId: "pid:100:1000",
    lastAffirmedAt: "2026-07-26T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
    ...overrides,
  };
}

describe("leaseAffirmedAt is written only by the heartbeat", () => {
  // §5.0: an owner transfer hands the run to a new owner who is NOT yet running it.
  // If the transfer carried the prior lease forward, the new owner's own resume would
  // meet a fresh lease naming someone else and be refused for a full TTL.
  it("an owner transfer clears the lease rather than carrying it forward", () => {
    const prior = ownerRecord({ leaseAffirmedAt: "2026-07-26T10:00:00.000Z" });

    const { nextOwnerRecord } = applyOwnerEpochTransfer(
      prior,
      "pid:200:2000",
      "2026-07-26T10:00:05.000Z",
      "owner lost after reconciliation",
    );

    expect(nextOwnerRecord.leaseAffirmedAt).toBeNull();
    expect(nextOwnerRecord.currentProcessInstanceId).toBe("pid:200:2000");
  });
});
