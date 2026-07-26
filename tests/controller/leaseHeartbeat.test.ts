import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLeaseHeartbeat } from "../../src/controller/leaseHeartbeat.js";
import { LEASE_HEARTBEAT_INTERVAL_MS, LEASE_TTL_MS } from "../../src/ownership/lease.js";
import type { OwnerRecord } from "../../src/runtime/types.js";

const SELF = "pid:4242:2000";

function record(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1:t0",
    currentOwnerEpoch: 2,
    currentProcessInstanceId: SELF,
    lastAffirmedAt: "2026-07-26T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
    ...overrides,
  };
}

async function seed(owner: OwnerRecord): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-hb-"));
  await writeFile(join(runDir, "events.jsonl"), "");
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify(owner, null, 2));
  return runDir;
}

async function readOwner(runDir: string): Promise<OwnerRecord> {
  return JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as OwnerRecord;
}

describe("startLeaseHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-07-26T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // §6.1, written to fail against the naive implementation that keeps comparing against
  // its start-of-run record: that one fails its own second CAS roughly one interval in and
  // stops a perfectly healthy run.
  //
  // Environment note: this installed Vitest (2.1.9) advances its fake clock and fires the
  // interval without waiting for the real, multi-step filesystem CAS the heartbeat performs
  // (lock file, read, compare, write, rename, unlock) to land — advanceTimersByTimeAsync can
  // resolve before that write has been flushed to disk. `heartbeat.affirmNow()` is the fix:
  // it is chained onto the SAME internal queue the interval just enqueued onto, so awaiting
  // it necessarily waits for the interval's affirm to finish first (then throttles itself
  // into a no-op). It uses only the module's own public surface — no extra test machinery.
  it("keeps affirming across a TTL window with no external interference", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
      await heartbeat.affirmNow();
      seen.push((await readOwner(runDir)).leaseAffirmedAt as string);
    }

    expect(new Set(seen).size).toBe(3); // three distinct, advancing affirmations
    expect(Date.parse(seen[2]) - Date.parse(seen[0])).toBe(2 * LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.stop();
  });

  // §6: both writers funnel through one throttled affirmNow so they cannot thrash the
  // owner-transfer lock.
  it("throttles event-driven affirms that arrive inside the throttle window", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await heartbeat.affirmNow();
    const first = (await readOwner(runDir)).leaseAffirmedAt;

    await vi.advanceTimersByTimeAsync(1_000);
    await heartbeat.affirmNow();

    expect((await readOwner(runDir)).leaseAffirmedAt).toBe(first);
    await heartbeat.stop();
  });

  // §6.0. Written to fail against an implementation that only cancels the timer: that one
  // leaves leaseAffirmedAt frozen and refuses the next legitimate process for a full TTL.
  // Asserted while the last heartbeat is still well inside the TTL.
  it("releases the lease on stop, not merely cancelling the timer", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await heartbeat.affirmNow();
    expect((await readOwner(runDir)).leaseAffirmedAt).not.toBeNull();

    await heartbeat.stop();

    expect((await readOwner(runDir)).leaseAffirmedAt).toBeNull();
    expect(Date.now() - Date.parse(record().lastAffirmedAt)).toBeLessThan(LEASE_TTL_MS);
  });

  // Requirement 4: assert the absence of AFFIRMS, not the absence of writes — stop() is
  // required to make exactly one write, the release.
  it("performs no further affirm after stop", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.stop();

    await vi.advanceTimersByTimeAsync(5 * LEASE_HEARTBEAT_INTERVAL_MS);

    expect((await readOwner(runDir)).leaseAffirmedAt).toBeNull();
  });

  // §6.0: on the lease_lost path the record belongs to the new owner. The release must
  // fail its CAS and be swallowed — never an unconditional write that could clear a lease
  // the new owner has already begun affirming.
  it("swallows a failed release and leaves the new owner's lease intact", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });
    await heartbeat.affirmNow();

    const newOwner = record({
      currentOwnerEpoch: 3,
      currentProcessInstanceId: "pid:999:9000",
      leaseAffirmedAt: "2026-07-26T10:05:00.000Z",
    });
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(newOwner, null, 2));

    await expect(heartbeat.stop()).resolves.toBeUndefined();

    expect((await readOwner(runDir)).leaseAffirmedAt).toBe("2026-07-26T10:05:00.000Z");
  });

  // §6.1: a failed CAS is NOT by itself proof of supersession. Only a re-read showing the
  // record no longer names this process at this epoch concludes it.
  it("reports lease loss only after a re-read confirms a different owner", async () => {
    const runDir = await seed(record());
    const lost: unknown[] = [];
    const heartbeat = startLeaseHeartbeat({
      runDir,
      ownerRecord: record(),
      onLeaseLost: (error) => lost.push(error),
    });

    // A record that differs but still names this process at this epoch: transient.
    await writeFile(
      join(runDir, "owner-record.json"),
      JSON.stringify(record({ lastAffirmedAt: "2026-07-26T10:00:05.000Z" }), null, 2),
    );
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    // See the environment note on the first test above: drain the interval-queued attempt
    // through the same public affirmNow() before inspecting outcomes.
    await heartbeat.affirmNow();
    expect(lost).toHaveLength(0);

    // Now a genuine rotation.
    await writeFile(
      join(runDir, "owner-record.json"),
      JSON.stringify(record({ currentOwnerEpoch: 3, currentProcessInstanceId: "pid:999:9000" }), null, 2),
    );
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.affirmNow();

    expect(lost).toHaveLength(1);
    const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
    expect(raw).toContain("lease_lost");
    await heartbeat.stop();
  });

  it("never throws into the caller when a heartbeat write fails", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await writeFile(join(runDir, "owner-record.json"), "{ not json");

    await expect(heartbeat.affirmNow()).resolves.toBeUndefined();
    // Environment note: this installed Vitest (2.1.9) resolves advanceTimersByTimeAsync with
    // its own chainable `vi` utils object, not undefined (see node_modules/vitest/dist/chunks
    // /vi.DgezovHB.js:3758-3761) — so `.resolves.toBeUndefined()` fails here regardless of
    // this module's behavior. A bare await still fails the test if the call throws/rejects,
    // which is the actual thing this assertion needs to verify.
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.stop();
  });
});
