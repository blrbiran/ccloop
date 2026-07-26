import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRunLease } from "../../src/controller/leaseGate.js";
import { LEASE_TTL_MS, RunLeaseHeldError } from "../../src/ownership/lease.js";
import type { OwnerRecord } from "../../src/runtime/types.js";

const NOW = Date.parse("2026-07-26T10:00:00.000Z");
const SELF = "pid:4242:2000";

function record(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1:t0",
    currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:100:1000",
    lastAffirmedAt: "2026-07-26T09:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
    ...overrides,
  };
}

async function seed(owner: unknown | undefined): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-gate-"));
  await writeFile(join(runDir, "events.jsonl"), "");
  if (owner !== undefined) {
    await writeFile(join(runDir, "owner-record.json"), typeof owner === "string" ? owner : JSON.stringify(owner, null, 2));
  }
  return runDir;
}

async function eventTypes(runDir: string): Promise<string[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line).type as string);
}

async function eventDetails(runDir: string): Promise<string[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line).detail as string);
}

describe("checkRunLease", () => {
  it("reports no_record and appends nothing when the file does not exist", async () => {
    const runDir = await seed(undefined);

    expect(await checkRunLease(runDir, SELF, NOW)).toEqual({ kind: "no_record" });
    expect(await eventTypes(runDir)).toEqual([]);
  });

  // §7 / §5.0: this is the post-transfer state. A run reconciliation has just handed to a
  // new owner is OWNED but NOT RUNNING, and its resume must not be refused.
  it("reports no_lease and takes no position when leaseAffirmedAt is null", async () => {
    const runDir = await seed(record({ leaseAffirmedAt: null }));

    expect(await checkRunLease(runDir, SELF, NOW)).toMatchObject({ kind: "no_lease" });
    expect(await eventTypes(runDir)).toEqual([]);
  });

  it("reports no_lease for a legacy record with no leaseAffirmedAt field at all", async () => {
    const legacy = record();
    delete (legacy as { leaseAffirmedAt?: unknown }).leaseAffirmedAt;
    const runDir = await seed(legacy);

    expect(await checkRunLease(runDir, SELF, NOW)).toMatchObject({ kind: "no_lease" });
  });

  it("refuses with RunLeaseHeldError naming the holder and remaining TTL", async () => {
    const runDir = await seed(
      record({ leaseAffirmedAt: new Date(NOW - 30_000).toISOString(), currentProcessInstanceId: "pid:100:1000" }),
    );

    await expect(checkRunLease(runDir, SELF, NOW)).rejects.toBeInstanceOf(RunLeaseHeldError);
    await expect(checkRunLease(runDir, SELF, NOW)).rejects.toMatchObject({
      holderProcessInstanceId: "pid:100:1000",
      remainingTtlMs: LEASE_TTL_MS - 30_000,
    });
  });

  // §5.1: the recycled-PID case. Same PID, earlier start time — NOT this process. An
  // implementation that compares only the pid segment lets an unrelated later process
  // walk straight through a live lease, defeating L1's single guarantee.
  it("refuses a fresh lease held by the same PID with an earlier start time", async () => {
    const runDir = await seed(
      record({ currentProcessInstanceId: "pid:4242:1000", leaseAffirmedAt: new Date(NOW - 1_000).toISOString() }),
    );

    await expect(checkRunLease(runDir, "pid:4242:2000", NOW)).rejects.toBeInstanceOf(RunLeaseHeldError);
  });

  it("refuses a fresh lease recorded in the legacy pid-only format", async () => {
    const runDir = await seed(
      record({ currentProcessInstanceId: "pid:4242", leaseAffirmedAt: new Date(NOW - 1_000).toISOString() }),
    );

    await expect(checkRunLease(runDir, "pid:4242:2000", NOW)).rejects.toBeInstanceOf(RunLeaseHeldError);
  });

  it("proceeds when the fresh lease is this process's own", async () => {
    const runDir = await seed(
      record({ currentProcessInstanceId: SELF, leaseAffirmedAt: new Date(NOW - 1_000).toISOString() }),
    );

    expect(await checkRunLease(runDir, SELF, NOW)).toMatchObject({ kind: "held_by_self" });
    expect(await eventTypes(runDir)).toEqual([]);
  });

  // §7: expiry authorizes nothing AND refuses nothing. It is an observation, recorded so
  // later layers can see it, and control passes unchanged to the gates that already exist.
  it("takes no position on an expired lease and records the observation", async () => {
    const affirmedAt = new Date(NOW - LEASE_TTL_MS - 1).toISOString();
    const runDir = await seed(record({ leaseAffirmedAt: affirmedAt }));

    expect(await checkRunLease(runDir, SELF, NOW)).toMatchObject({ kind: "expired" });
    expect(await eventTypes(runDir)).toEqual(["lease_expired_observed"]);
    // The instant this event names is consumed by later layers as "when the lease lapsed", so
    // it must be the EXPIRY instant (last affirmation + TTL), not the affirmation instant.
    // Written to fail against `expired at ${leaseAffirmedAt}`, which named the wrong one.
    expect(await eventDetails(runDir)).toEqual([
      `lease held by pid:100:1000 expired at ${new Date(Date.parse(affirmedAt) + LEASE_TTL_MS).toISOString()} (last affirmed ${affirmedAt})`,
    ]);
  });

  // A string leaseAffirmedAt is structurally valid, so an unparseable one reaches the expiry
  // branch (isLeaseFresh answers "not fresh"). There is no expiry instant to compute from it,
  // and computing one anyway throws RangeError — which would turn an observation the gate is
  // required to pass through into a crash that refuses the run.
  it("still passes control on, naming no expiry instant, when leaseAffirmedAt is unparseable", async () => {
    const runDir = await seed(record({ leaseAffirmedAt: "not-a-timestamp" }));

    expect(await checkRunLease(runDir, SELF, NOW)).toMatchObject({ kind: "expired" });
    expect(await eventDetails(runDir)).toEqual([
      "lease held by pid:100:1000 expired at an unparseable instant (last affirmed not-a-timestamp)",
    ]);
  });

  // §7: only ENOENT means "no lease". Everything else is a refusal — including the shapes
  // readOwnerRecordRaw would have accepted silently.
  it.each([
    ["malformed JSON", "{ not json"],
    ["a record missing currentProcessInstanceId", { currentOwnerEpoch: 2, leaseAffirmedAt: null }],
    ["a record with a non-string leaseAffirmedAt", { currentProcessInstanceId: "pid:1:1", currentOwnerEpoch: 2, leaseAffirmedAt: 12345 }],
  ])("refuses %s rather than treating it as absent", async (_label, owner) => {
    const runDir = await seed(owner);

    await expect(checkRunLease(runDir, SELF, NOW)).rejects.toThrow();
    await expect(checkRunLease(runDir, SELF, NOW)).rejects.not.toBeInstanceOf(RunLeaseHeldError);
  });
});
