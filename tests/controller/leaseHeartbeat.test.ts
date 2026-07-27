import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLeaseHeartbeat } from "../../src/controller/leaseHeartbeat.js";
import { INERT_LEASE_HEARTBEAT } from "../../src/controller/runLoop.js";
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

async function readEventTypes(runDir: string): Promise<string[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { type: string }).type);
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
    // The heartbeat-first path: this call is what sets `superseded`, so it must still emit.
    // Pinned explicitly because a gate placed AFTER that assignment rather than before it would
    // silently suppress the event on exactly this path (fix-round-2 review).
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; detail: string });
    const leaseLost = events.filter((event) => event.type === "lease_lost");
    expect(leaseLost).toHaveLength(1);
    expect(leaseLost[0].detail).toBe(`expected ${SELF} at epoch 2, observed pid:999:9000 at epoch 3`);
    await heartbeat.stop();
  });

  // Review finding (Task 9): concludeLeaseLost's appendEvent call was unguarded, so a real
  // I/O failure on the lease_lost event write would reject out of runAffirm's catch block —
  // an unhandled rejection on the timer path, and a thrown promise on a direct affirmNow()
  // call, either way violating "never throws into the caller". onLeaseLost must still fire
  // even though the event log write failed.
  it("never throws into the caller when the lease-lost event append fails", async () => {
    const runDir = await seed(record());
    const lost: unknown[] = [];
    const heartbeat = startLeaseHeartbeat({
      runDir,
      ownerRecord: record(),
      onLeaseLost: (error) => lost.push(error),
    });

    // Break the event log so concludeLeaseLost's appendEvent call fails: appendFile against a
    // directory rejects with EISDIR.
    await rm(join(runDir, "events.jsonl"));
    await mkdir(join(runDir, "events.jsonl"));

    // A genuine rotation: the CAS fails, the re-read confirms supersession, and
    // concludeLeaseLost attempts to append "lease_lost" against the now-broken event log.
    await writeFile(
      join(runDir, "owner-record.json"),
      JSON.stringify(record({ currentOwnerEpoch: 3, currentProcessInstanceId: "pid:999:9000" }), null, 2),
    );

    await expect(heartbeat.affirmNow()).resolves.toBeUndefined();
    expect(lost).toHaveLength(1); // the stop signal must still fire despite the failed event write

    await heartbeat.stop();
  });

  // §6.1 + §8's fail-closed table. The re-read that follows a failed CAS fed
  // readOwnerRecordWithoutRecovery's bare JSON.parse straight to namesSomeoneElse: a
  // well-formed-JSON record of the wrong SHAPE has no currentProcessInstanceId and no
  // supersededByEpoch, so it "differed" from `expected` and was concluded as supersession —
  // appending lease_lost and stopping the run on the strength of a record that could not be
  // read at all. assertHeld parses before comparing and classifies exactly this as
  // unverifiable; the heartbeat has to classify it the same way, since it is the same ONE
  // criterion: transient, retried on the next tick, never proof of a takeover.
  it("treats a structurally invalid record as transient rather than concluding supersession", async () => {
    const runDir = await seed(record());
    const lost: unknown[] = [];
    const heartbeat = startLeaseHeartbeat({
      runDir,
      ownerRecord: record(),
      onLeaseLost: (error) => lost.push(error),
    });

    // Well-formed JSON, wrong shape: the CAS fails its precondition, and the re-read that
    // follows cannot be validated.
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify({ currentOwnerEpoch: 2 }, null, 2));

    await expect(heartbeat.affirmNow()).resolves.toBeUndefined();

    expect(lost).toHaveLength(0);
    expect(await readEventTypes(runDir)).not.toContain("lease_lost");

    // And it must be a RETRY, not a permanent stop: once the record is readable again the next
    // affirm succeeds, which an implementation that had already concluded supersession — and so
    // returns early from runAffirm forever — could never do.
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(record(), null, 2));
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.affirmNow();

    expect((await readOwner(runDir)).leaseAffirmedAt).not.toBeNull();
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

  // Task 1 / spec §3 + §12 requirement 9: OwnerTransferLockBusyError is a SIBLING of
  // OwnerTransferPreconditionError, not a subclass, so `!(error instanceof
  // OwnerTransferPreconditionError)` here already treats it as transient by construction —
  // this test pins that the swallow-and-retry contract holds for the new class specifically,
  // not merely "some error class or other".
  it("treats a busy owner-transfer lock as transient: no lease_lost, no supersession concluded, retried next tick", async () => {
    const runDir = await seed(record());
    const lost: unknown[] = [];
    const heartbeat = startLeaseHeartbeat({
      runDir,
      ownerRecord: record(),
      onLeaseLost: (error) => lost.push(error),
    });

    // Fabricate a busy lock the same way tests/persistence/fileStore.test.ts does: a live pid
    // (this process) so stale-recovery declines to break it.
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: new Date().toISOString() }, null, 2),
    );

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.affirmNow();

    expect(lost).toHaveLength(0);
    expect(await readEventTypes(runDir)).not.toContain("lease_lost");
    // The affirm never went through (the lock acquisition failed before any read or write of
    // owner-record.json), so the record is exactly what seed() wrote: leaseAffirmedAt null.
    expect((await readOwner(runDir)).leaseAffirmedAt).toBeNull();

    // Free the lock: the NEXT tick must affirm normally, proving this was a retried transient
    // failure and not a permanent refusal.
    await rm(join(runDir, ".owner-transfer.lock"));
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.affirmNow();

    expect((await readOwner(runDir)).leaseAffirmedAt).not.toBeNull();
    expect(lost).toHaveLength(0);
    await heartbeat.stop();
  });

  // Task 3 / spec requirement 10 — the poisoned-chain killer. Requirement 10 asks for two
  // things: the rejection reaches the runExclusive caller, and the queue is still usable for a
  // subsequent affirm afterward (not deadlocked, not silently swallowed). A second runExclusive
  // call is checked too, for its own result rather than the first call's stale rejection: that
  // is the sharper version of "usable afterward" — an implementation that stores the very
  // promise carrying fn's rejection back into `queue` (rather than a distinct, always-resolving
  // one) can leave a single-handler-style consumer of `queue` inheriting that rejection forever
  // instead of ever invoking its own fn.
  it("runExclusive: a rejecting fn propagates to its caller, and the queue stays usable for what follows", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    const boom = new Error("boom");
    await expect(heartbeat.runExclusive(async () => {
      throw boom;
    })).rejects.toBe(boom);

    // A subsequent runExclusive call must run ITS OWN fn and carry ITS OWN result — not inherit
    // the previous call's rejection.
    await expect(heartbeat.runExclusive(async () => "second-result")).resolves.toBe("second-result");

    // Spec requirement 10's own wording: a subsequent affirm still runs too.
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.affirmNow();

    expect((await readOwner(runDir)).leaseAffirmedAt).not.toBeNull();
    await heartbeat.stop();
  });
});

// Task 3: runExclusive is the second writer of §6's shared serialization queue, alongside
// affirmNow. This proves the two share it: a due affirm queued behind an in-flight
// runExclusive `fn` must not reach its own write until `fn` settles.
//
// affirmOwnerLease is mocked to a test-controlled deferred promise rather than left as real
// filesystem I/O. A real affirm's completion depends on several real fs round trips (lock,
// read, write, rename, unlock — see the environment note on the first test in this file), so
// polling disk state or counting microtask turns while it is "supposed to be" blocked cannot
// distinguish correct serialization from a bug that lets it start early: neither the correct
// nor the broken run would have reached disk yet after a handful of microtask flushes, for
// unrelated real-I/O-timing reasons. Mocking removes that variable: both `fn` and the affirm
// are now plain, fully deterministic JS promises under this test's control, so "was the
// affirm's write even INVOKED before fn resolved" becomes an exact, race-free assertion.
describe("runExclusive shares the serialization queue with affirmNow", () => {
  afterEach(() => {
    vi.doUnmock("../../src/persistence/fileStore.js");
    vi.resetModules();
  });

  it("does not invoke the due affirm's write until an in-flight runExclusive fn resolves", async () => {
    vi.resetModules();

    const order: string[] = [];
    let releaseAffirm: (updated: OwnerRecord) => void = () => {};
    const affirmGate = new Promise<OwnerRecord>((resolve) => {
      releaseAffirm = resolve;
    });

    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );
      return {
        ...actual,
        affirmOwnerLease: async () => {
          order.push("affirm:start");
          const updated = await affirmGate;
          order.push("affirm:end");
          return updated;
        },
      };
    });

    const { startLeaseHeartbeat: mockedStartLeaseHeartbeat } = await import(
      "../../src/controller/leaseHeartbeat.js"
    );
    const runDir = await seed(record());
    const heartbeat = mockedStartLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    let releaseFn: () => void = () => {};
    const fnGate = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    const exclusive = heartbeat.runExclusive(async () => {
      order.push("fn:start");
      await fnGate;
      order.push("fn:end");
      return "fn-result";
    });

    // The due affirm: queued on the same shared queue immediately behind fn, exactly as the
    // interval timer queues it in production.
    const affirmPromise = heartbeat.affirmNow();

    // A couple of microtask turns are enough here (unlike the real-I/O case) because reaching
    // the mocked affirmOwnerLease requires no real I/O — only correct queue chaining. If
    // runExclusive failed to chain fn onto `queue`, affirmNow's own chain would find `queue`
    // still at its initial resolved state and invoke runAffirm immediately, pushing
    // "affirm:start" right here, before fn has even resolved.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["fn:start"]);

    releaseFn();
    await expect(exclusive).resolves.toBe("fn-result");

    // Now that fn has resolved, runAffirm's callback can run and reach the mocked
    // affirmOwnerLease.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["fn:start", "fn:end", "affirm:start"]);

    releaseAffirm(record({ leaseAffirmedAt: "2026-07-26T10:05:00.000Z" }));
    await affirmPromise;

    expect(order).toEqual(["fn:start", "fn:end", "affirm:start", "affirm:end"]);
    await heartbeat.stop();
  });

  // Review finding on this task: the property that actually needs a test is not "the stored
  // chain and the returned promise are structurally distinct objects" — it's that `queue`
  // itself is never left as a REJECTED promise with no handler attached to it. A caller that
  // correctly `await`s and catches `runExclusive`'s return value proves nothing about `queue`:
  // that value is `result`, not the stored mapper. If the stored mapper drops its `onRejected`
  // (`queue = result.then(() => undefined)`, one argument, versus the correct two), `queue`
  // becomes a rejected promise that nothing consumes until the NEXT write to it — the next
  // timer-driven `affirmNow()`, up to a full `LEASE_HEARTBEAT_INTERVAL_MS` away. No
  // `unhandledRejection` listener exists anywhere in src/, so in production Node's default
  // handling of that event terminates the process — on a path (a transfer failing with
  // `OwnerTransferPreconditionError`, or a real I/O error) that is a normal outcome under
  // contention, not a crash-worthy one.
  //
  // This is why requirement 10's own test (above, in the `startLeaseHeartbeat` describe block)
  // cannot catch this: it only ever observes the RETURNED promise (`result`), and a subsequent
  // `runExclusive`/`affirmNow` call's own dual-handler read of `queue` self-heals regardless of
  // whether the stored mapper was one-argument or two. Only listening for the process-level
  // event, with nothing else ever chaining onto `queue` in between, observes the stored
  // mapper's shape directly.
  it("runExclusive: a rejecting fn leaves the shared queue resolved — no unhandled rejection", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const boom = new Error("boom");
      await expect(heartbeat.runExclusive(async () => {
        throw boom;
      })).rejects.toBe(boom);

      // End the turn with nothing else chained onto `queue` — no affirmNow, no second
      // runExclusive — so a rejected-and-unhandled `queue` has nothing to hide behind.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      await heartbeat.stop();
    }
  });
});

describe("INERT_LEASE_HEARTBEAT.runExclusive", () => {
  // Task 3: INERT_LEASE_HEARTBEAT is the default heartbeat for runLoopFromState when a run is
  // driven without a live one. A no-op runExclusive would silently discard whatever `fn` does
  // — in production, an owner transfer — so it must actually execute `fn` and hand back its
  // result.
  it("executes fn and returns its result", async () => {
    await expect(INERT_LEASE_HEARTBEAT.runExclusive(async () => "transferred")).resolves.toBe(
      "transferred",
    );

    const calls: string[] = [];
    await INERT_LEASE_HEARTBEAT.runExclusive(async () => {
      calls.push("ran");
    });
    expect(calls).toEqual(["ran"]);
  });
});

describe("assertHeld", () => {
  // Every test below except the first depends on REAL timers: assertHeld's retry delay is a
  // setTimeout, so under a leaked fake clock those tests hang instead of failing. The first
  // test installs fake timers and un-installs them only on its success path, so a throw
  // anywhere inside it would otherwise poison the rest of the block. beforeEach rather than
  // afterEach: it also covers fake timers leaked from anywhere earlier in the file, not only
  // from a test inside this block.
  beforeEach(() => {
    vi.useRealTimers();
  });

  // §8.1, written to fail against an implementation that reuses the affirm throttle. A real
  // process reaches assertHeld with lastAffirmAtMs already recently set by the periodic
  // heartbeat — so this primes it with a genuine affirmNow() first, rather than leaving it at
  // its never-affirmed -Infinity default. An implementation that skips the read whenever
  // `now() - lastAffirmAtMs < LEASE_AFFIRM_THROTTLE_MS` would see a fresh lastAffirmAtMs here
  // and short-circuit on the second call, missing the rotation; only a real per-call read
  // catches it.
  it("is never throttled: a record rotated between two close side effects blocks the second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-07-26T10:00:00.000Z"));
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await heartbeat.affirmNow(); // primes lastAffirmAtMs with a recent, real affirm

    await expect(heartbeat.assertHeld()).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(100); // far inside LEASE_AFFIRM_THROTTLE_MS
    await writeFile(
      join(runDir, "owner-record.json"),
      JSON.stringify(record({ currentOwnerEpoch: 3, currentProcessInstanceId: "pid:999:9000" }), null, 2),
    );

    await expect(heartbeat.assertHeld()).rejects.toMatchObject({ stopReason: "lease_lost" });
    await heartbeat.stop();
    vi.useRealTimers();
  });

  // §8.1 row two: fail CLOSED. An unverifiable lease stops the run rather than letting it
  // act unverified — and deliberately does NOT claim supersession, hence the other reason.
  it("rejects as unverifiable — not as lost — when the record cannot be read", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await writeFile(join(runDir, "owner-record.json"), "{ not json");

    await expect(heartbeat.assertHeld()).rejects.toMatchObject({ stopReason: "lease_unverifiable" });
    await heartbeat.stop();
  });

  it("rejects as unverifiable when the record is structurally invalid", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await writeFile(join(runDir, "owner-record.json"), JSON.stringify({ currentOwnerEpoch: 2 }, null, 2));

    await expect(heartbeat.assertHeld()).rejects.toMatchObject({ stopReason: "lease_unverifiable" });
    await heartbeat.stop();
  });

  // Fix-round-2 review finding: the exactly-once gate was asymmetric. assertHeld gated its
  // append on `superseded`, but concludeLeaseLost set the flag and appended unconditionally —
  // and assertHeld is deliberately NOT part of the `queue` chain that serializes the two
  // writers, so the two can run concurrently and both append.
  //
  // The window is reached by construction, not by luck:
  //
  //   1. affirmNow() chains runAffirm onto an already-resolved queue, so runAffirm is scheduled
  //      as a MICROTASK and has not run when affirmNow() returns.
  //   2. assertHeld() is then called synchronously and runs up to its first await — issuing its
  //      single owner-record read before returning control.
  //   3. The microtask drains: runAffirm passes its `stopped || superseded` entry check (the
  //      flag is still false — this is the precondition of the race) and suspends inside
  //      affirmOwnerLease.
  //   4. assertHeld's ONE read resolves ahead of affirmOwnerLease's lock-acquire → recover →
  //      read → CAS chain (roughly eight filesystem round trips against one), concludes
  //      supersession, sets the flag and appends.
  //   5. runAffirm's CAS then fails its precondition, it re-reads, finds the rotation, and
  //      arrives at concludeLeaseLost SECOND — where the ungated append produced the duplicate.
  //
  // Real timers, because step 4's ordering rests on real filesystem work.
  it("appends one lease_lost event when a guard concludes while an affirm is already in flight", async () => {
    vi.useRealTimers();
    const runDir = await seed(record());
    const lost: unknown[] = [];
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: (error) => lost.push(error) });

    await writeFile(
      join(runDir, "owner-record.json"),
      JSON.stringify(record({ currentOwnerEpoch: 3, currentProcessInstanceId: "pid:999:9000" }), null, 2),
    );

    const affirmInFlight = heartbeat.affirmNow(); // deliberately not awaited: see step 1
    await expect(heartbeat.assertHeld()).rejects.toMatchObject({ stopReason: "lease_lost" });
    await expect(affirmInFlight).resolves.toBeUndefined(); // still must never throw into the caller

    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; detail: string });
    const leaseLost = events.filter((event) => event.type === "lease_lost");

    // The decisive assertion. Both mechanisms concluded the same supersession — the callback
    // below proves the affirm reached concludeLeaseLost after the guard had already set the
    // flag — and exactly one event records it.
    expect(leaseLost).toHaveLength(1);
    expect(leaseLost[0].detail).toBe(`expected ${SELF} at epoch 2, observed pid:999:9000 at epoch 3`);
    // The stop signal is NOT gated with the append: assertHeld only throws, so this callback is
    // the sole signal the control loop can observe, and suppressing it would lose it.
    expect(lost).toHaveLength(1);

    await heartbeat.stop();
  });

  // §8.1 row three: a transient failure that clears within the retry budget proceeds.
  it("proceeds when a transient read failure clears within the retry budget", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await writeFile(join(runDir, "owner-record.json"), "{ not json");
    setTimeout(() => {
      void writeFile(join(runDir, "owner-record.json"), JSON.stringify(record(), null, 2));
    }, 10);

    await expect(heartbeat.assertHeld()).resolves.toBeUndefined();
    await heartbeat.stop();
  });
});
