import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  affirmOwnerLease,
  OwnerTransferPreconditionError,
  readOwnerRecordWithoutRecovery,
  releaseOwnerLease,
} from "../../src/persistence/fileStore.js";
import type { OwnerRecord } from "../../src/runtime/types.js";

function record(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1:t0",
    currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:100:1000",
    lastAffirmedAt: "2026-07-26T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
    ...overrides,
  };
}

async function seed(owner: OwnerRecord): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-lease-"));
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify(owner, null, 2));
  return runDir;
}

async function readOwner(runDir: string): Promise<OwnerRecord> {
  return JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as OwnerRecord;
}

describe("affirmOwnerLease", () => {
  it("advances both timestamps and returns exactly the record it persisted", async () => {
    const runDir = await seed(record());

    const written = await affirmOwnerLease(runDir, record(), "2026-07-26T10:00:30.000Z");

    expect(written.leaseAffirmedAt).toBe("2026-07-26T10:00:30.000Z");
    // §6: the ownership design's named freshness anchor stops being dead.
    expect(written.lastAffirmedAt).toBe("2026-07-26T10:00:30.000Z");
    expect(await readOwner(runDir)).toEqual(written);
  });

  it("leaves epoch, status and supersession untouched", async () => {
    const runDir = await seed(record());

    const written = await affirmOwnerLease(runDir, record(), "2026-07-26T10:00:30.000Z");

    expect(written.currentOwnerEpoch).toBe(2);
    expect(written.ownerStatus).toBe("current");
    expect(written.supersededByEpoch).toBeNull();
    expect(written.currentProcessInstanceId).toBe("pid:100:1000");
  });

  // §6.1: the returned record is the caller's next `expected`. If the returned record did
  // not compare equal to what is on disk, the very next affirm would fail its own CAS.
  it("supports three consecutive affirms when each adopts the returned record", async () => {
    const runDir = await seed(record());

    let expected = record();
    for (const at of ["10:00:30", "10:01:00", "10:01:30"]) {
      expected = await affirmOwnerLease(runDir, expected, `2026-07-26T${at}.000Z`);
    }

    expect(expected.leaseAffirmedAt).toBe("2026-07-26T10:01:30.000Z");
  });

  it("throws OwnerTransferPreconditionError when the persisted record has moved on", async () => {
    const runDir = await seed(record({ currentOwnerEpoch: 3 }));

    await expect(affirmOwnerLease(runDir, record(), "2026-07-26T10:00:30.000Z")).rejects.toBeInstanceOf(
      OwnerTransferPreconditionError,
    );
  });

  it("affirms a legacy record that has no leaseAffirmedAt field", async () => {
    const legacy = record();
    delete (legacy as { leaseAffirmedAt?: unknown }).leaseAffirmedAt;
    const runDir = await seed(legacy as OwnerRecord);

    const written = await affirmOwnerLease(runDir, legacy as OwnerRecord, "2026-07-26T10:00:30.000Z");

    expect(written.leaseAffirmedAt).toBe("2026-07-26T10:00:30.000Z");
  });
});

describe("releaseOwnerLease", () => {
  it("clears only leaseAffirmedAt", async () => {
    const runDir = await seed(record({ leaseAffirmedAt: "2026-07-26T10:00:30.000Z" }));

    await releaseOwnerLease(runDir, record({ leaseAffirmedAt: "2026-07-26T10:00:30.000Z" }));

    const persisted = await readOwner(runDir);
    expect(persisted.leaseAffirmedAt).toBeNull();
    expect(persisted.lastAffirmedAt).toBe("2026-07-26T10:00:00.000Z");
    expect(persisted.currentOwnerEpoch).toBe(2);
  });

  // §6.0: on the lease_lost path the record already belongs to the new owner. The release
  // must fail its CAS rather than unconditionally clearing a lease the new owner has
  // already begun affirming.
  it("refuses to clear a lease on a record this process no longer owns", async () => {
    const newOwner = record({
      currentOwnerEpoch: 3,
      currentProcessInstanceId: "pid:999:9000",
      leaseAffirmedAt: "2026-07-26T10:05:00.000Z",
    });
    const runDir = await seed(newOwner);

    await expect(
      releaseOwnerLease(runDir, record({ leaseAffirmedAt: "2026-07-26T10:00:30.000Z" })),
    ).rejects.toBeInstanceOf(OwnerTransferPreconditionError);

    expect((await readOwner(runDir)).leaseAffirmedAt).toBe("2026-07-26T10:05:00.000Z");
  });
});

describe("readOwnerRecordWithoutRecovery", () => {
  // §7.1: readOwnerRecord runs recoverInterruptedOwnerTransfer first, which finalizes
  // pending transfers and deletes staging files — both writes. A refusal must never
  // trigger crash recovery as a side effect, so the gate uses this read instead.
  it("does not finalize a staged transfer the way readOwnerRecord would", async () => {
    const runDir = await seed(record());
    const staged = record({ currentOwnerEpoch: 3, currentProcessInstanceId: "pid:999:9000" });
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(staged, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.pending.json"),
      JSON.stringify({ priorOwnerEpoch: 2, newOwnerEpoch: 3, priorProcessInstanceId: "pid:100:1000", newProcessInstanceId: "pid:999:9000", transferredAt: "2026-07-26T10:00:10.000Z", reason: "t", eligibleForContinuation: true }, null, 2),
    );
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: "2026-07-26T10:00:10.000Z", finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );

    const read = await readOwnerRecordWithoutRecovery(runDir);

    expect(read.currentOwnerEpoch).toBe(2);
    expect((await readOwner(runDir)).currentOwnerEpoch).toBe(2);
  });

  it("propagates ENOENT when there is no owner record", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-lease-"));

    await expect(readOwnerRecordWithoutRecovery(runDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
