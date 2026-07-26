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

import {
  isLeaseFresh,
  LEASE_TTL_MS,
  parseOwnerRecordForLease,
  RunLeaseHeldError,
} from "../../src/ownership/lease.js";

describe("isLeaseFresh", () => {
  const affirmedAt = "2026-07-26T10:00:00.000Z";
  const affirmedAtMs = Date.parse(affirmedAt);

  it("is fresh strictly inside the TTL and not fresh at exactly the TTL", () => {
    const record = ownerRecord({ leaseAffirmedAt: affirmedAt });

    expect(isLeaseFresh(record, affirmedAtMs + LEASE_TTL_MS - 1, LEASE_TTL_MS)).toBe(true);
    // The boundary is `<`, not `<=`: at exactly the TTL the lease has expired. Pinned
    // because an off-by-one here is the difference between refusing and not refusing.
    expect(isLeaseFresh(record, affirmedAtMs + LEASE_TTL_MS, LEASE_TTL_MS)).toBe(false);
  });

  // §10: a lease that reads fresh for too long only adds refusals, which is the safe
  // direction. So a timestamp from the future is fresh, deliberately, and not an error.
  it("treats a lease affirmed in the future as fresh (refusing is the safe direction)", () => {
    const record = ownerRecord({ leaseAffirmedAt: affirmedAt });
    expect(isLeaseFresh(record, affirmedAtMs - 60_000, LEASE_TTL_MS)).toBe(true);
  });

  // §5: null is NOT an expired lease — it is no lease at all. Both answer "not fresh"
  // here, but the gate branches on them differently, so the distinction is drawn there.
  it("reports not-fresh for a null lease and for an absent field", () => {
    expect(isLeaseFresh(ownerRecord({ leaseAffirmedAt: null }), affirmedAtMs, LEASE_TTL_MS)).toBe(false);

    const legacy = ownerRecord();
    delete (legacy as { leaseAffirmedAt?: unknown }).leaseAffirmedAt;
    expect(isLeaseFresh(legacy, affirmedAtMs, LEASE_TTL_MS)).toBe(false);
  });

  // §5: belt-and-braces only. The governing rule for a malformed record is refusal, and
  // that is parseOwnerRecordForLease's job — this predicate must never be the thing that
  // decides a corrupt record is safe.
  it("defensively reports not-fresh for an unparseable timestamp", () => {
    const record = ownerRecord({ leaseAffirmedAt: "not-a-timestamp" });
    expect(isLeaseFresh(record, affirmedAtMs, LEASE_TTL_MS)).toBe(false);
  });
});

describe("parseOwnerRecordForLease", () => {
  it("accepts a well-formed record unchanged, preserving key order for CAS comparison", () => {
    const record = ownerRecord({ leaseAffirmedAt: "2026-07-26T10:00:00.000Z" });
    const parsed = parseOwnerRecordForLease(JSON.parse(JSON.stringify(record)));

    expect(JSON.stringify(parsed)).toBe(JSON.stringify(record));
  });

  it("accepts a legacy record with no leaseAffirmedAt field and does not add one", () => {
    const legacy = ownerRecord();
    delete (legacy as { leaseAffirmedAt?: unknown }).leaseAffirmedAt;

    const parsed = parseOwnerRecordForLease(JSON.parse(JSON.stringify(legacy)));

    // Adding the key would change the JSON and break every later CAS against this record.
    expect("leaseAffirmedAt" in parsed).toBe(false);
  });

  // §7: these are exactly the shapes readOwnerRecordRaw accepts silently. Each must be a
  // refusal, never "no lease here".
  it.each([
    ["not an object", 42],
    ["null", null],
    ["an array", []],
    ["a missing currentProcessInstanceId", { currentOwnerEpoch: 1 }],
    ["an empty currentProcessInstanceId", { currentProcessInstanceId: "", currentOwnerEpoch: 1 }],
    ["a missing currentOwnerEpoch", { currentProcessInstanceId: "pid:1:1" }],
    ["a non-integer currentOwnerEpoch", { currentProcessInstanceId: "pid:1:1", currentOwnerEpoch: 1.5 }],
    ["a non-string, non-null leaseAffirmedAt", { currentProcessInstanceId: "pid:1:1", currentOwnerEpoch: 1, leaseAffirmedAt: 12345 }],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseOwnerRecordForLease(raw)).toThrow(/owner record is structurally invalid/);
  });
});

describe("RunLeaseHeldError", () => {
  // The CLI prints error.message for `instanceof Error` (src/cli.ts), so an operator's
  // only view of WHY a resume was refused is this string.
  it("names the holder and the remaining TTL in its message", () => {
    const error = new RunLeaseHeldError("pid:4242:1700000000000", 45_000);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RunLeaseHeldError");
    expect(error.message).toContain("pid:4242:1700000000000");
    expect(error.message).toContain("45000");
    expect(error.holderProcessInstanceId).toBe("pid:4242:1700000000000");
    expect(error.remainingTtlMs).toBe(45_000);
  });
});
