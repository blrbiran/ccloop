import {
  LEASE_AFFIRM_THROTTLE_MS,
  LEASE_HEARTBEAT_INTERVAL_MS,
  LEASE_VERIFY_READ_ATTEMPTS,
  LEASE_VERIFY_RETRY_DELAY_MS,
  parseOwnerRecordForLease,
  RunLeaseLostError,
  RunLeaseUnverifiableError,
} from "../ownership/lease.js";
import {
  affirmOwnerLease,
  appendEvent,
  OwnerTransferPreconditionError,
  readOwnerRecordWithoutRecovery,
  releaseOwnerLease,
} from "../persistence/fileStore.js";
import type { OwnerRecord } from "../runtime/types.js";

export type LeaseHeartbeat = {
  affirmNow: () => Promise<void>;
  assertHeld: () => Promise<void>;
  stop: () => Promise<void>;
};

export function startLeaseHeartbeat(options: {
  runDir: string;
  ownerRecord: OwnerRecord;
  onLeaseLost: (error: unknown) => void;
  now?: () => number;
}): LeaseHeartbeat {
  const now = options.now ?? (() => Date.now());
  // §6.1: each successful affirm changes the record, so the one we compared against is
  // stale the moment it succeeds. We adopt what affirmOwnerLease returns, every time.
  let expected = options.ownerRecord;
  let lastAffirmAtMs = Number.NEGATIVE_INFINITY;
  let stopped = false;
  let superseded = false;
  // Both writers of §6 funnel through here, so serialize them: the throttle alone does not
  // stop two calls in the same tick from racing the owner-transfer lock.
  let queue: Promise<void> = Promise.resolve();

  // §6.1 / §8: the ONE criterion for supersession, shared with assertHeld. A record that
  // differs for reasons this process cannot explain is a transient failure, not proof.
  const namesSomeoneElse = (persisted: OwnerRecord): boolean =>
    persisted.currentOwnerEpoch !== expected.currentOwnerEpoch
    || persisted.supersededByEpoch !== null
    || persisted.currentProcessInstanceId !== expected.currentProcessInstanceId;

  const concludeLeaseLost = async (persisted: OwnerRecord): Promise<void> => {
    superseded = true;

    // appendEvent is a raw appendFile with no internal guard, so it can reject on real I/O
    // failure. Losing the event log must not cost us the stop signal below, so it is swallowed
    // here rather than left to propagate out of runAffirm's catch block unguarded (which the
    // timer path fires via a bare `void affirmNow()`, turning any throw here into an unhandled
    // rejection instead of the swallow-and-retry the spec requires).
    try {
      await appendEvent(options.runDir, {
        type: "lease_lost",
        at: new Date(now()).toISOString(),
        detail: `expected ${expected.currentProcessInstanceId} at epoch ${expected.currentOwnerEpoch}, observed ${persisted.currentProcessInstanceId} at epoch ${persisted.currentOwnerEpoch}`,
      });
    } catch {
      // Swallowed: the stop signal below must still fire even without an event record of it.
    }

    // onLeaseLost is caller-supplied. The same "never throws into the caller" contract that
    // covers this module's own I/O has to cover a misbehaving callback too, so it is guarded
    // deliberately rather than left to accidentally propagate.
    try {
      options.onLeaseLost(
        new RunLeaseLostError(
          `run lease lost: owner record now names ${persisted.currentProcessInstanceId} at epoch ${persisted.currentOwnerEpoch}`,
        ),
      );
    } catch {
      // Swallowed: a broken caller callback must not turn into an unhandled rejection either.
    }
  };

  const runAffirm = async (): Promise<void> => {
    if (stopped || superseded) {
      return;
    }

    if (now() - lastAffirmAtMs < LEASE_AFFIRM_THROTTLE_MS) {
      return;
    }

    try {
      expected = await affirmOwnerLease(options.runDir, expected, new Date(now()).toISOString());
      lastAffirmAtMs = now();
    } catch (error) {
      // §6: a failure that is not a precondition failure — lock contention, transient I/O —
      // is swallowed and retried on the next tick. It must never throw into the control loop.
      if (!(error instanceof OwnerTransferPreconditionError)) {
        return;
      }

      let persisted: OwnerRecord;
      try {
        persisted = await readOwnerRecordWithoutRecovery(options.runDir);
      } catch {
        return; // cannot re-read: transient, retry next tick. Not proof of anything.
      }

      if (!namesSomeoneElse(persisted)) {
        return;
      }

      await concludeLeaseLost(persisted);
    }
  };

  const affirmNow = (): Promise<void> => {
    queue = queue.then(runAffirm, runAffirm);
    return queue;
  };

  const timer = setInterval(() => {
    void affirmNow();
  }, LEASE_HEARTBEAT_INTERVAL_MS);

  // §6.0: so the timer never keeps the process alive. This does NOT substitute for stop() —
  // a run can end long before its process does. Guarded because fake-timer implementations
  // do not always provide unref.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    clearInterval(timer);
    await queue.catch(() => {});

    // §6.0: cancelling the timer is only half. Without this release, a run that has already
    // finished still reads as "somebody is running this" for up to one TTL and refuses the
    // next legitimate process. Best-effort: on the lease_lost path the CAS cannot match and
    // the write is swallowed, which is exactly right — a superseded process must not touch
    // the new owner's record.
    try {
      await releaseOwnerLease(options.runDir, expected);
    } catch {
      // Swallowed by contract: the lease simply ages out.
    }
  };

  const delay = (ms: number): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

  // §8.1: re-checked immediately before EVERY side effect, narrowing the window in which a
  // superseded owner can still act from one phase to one side effect.
  //
  // Reads the persisted record every time it is called: NOT subject to the affirm throttle
  // and caching nothing, because a throttled re-check degrades "fail closed before every
  // side effect" into "fail closed at most once per throttle window". The throttle exists
  // to keep the two WRITERS of §6 from thrashing the lock; this is a raw read and takes no
  // lock, so nothing is saved by skipping it.
  //
  // Fails CLOSED, unlike DoWhiz's thread_epoch_matches which proceeds on an unreadable
  // state file. Borrow the shape, invert the default.
  const assertHeld = async (): Promise<void> => {
    let lastError: unknown;

    for (let attempt = 0; attempt < LEASE_VERIFY_READ_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await delay(LEASE_VERIFY_RETRY_DELAY_MS);
      }

      let persisted: OwnerRecord;
      try {
        persisted = parseOwnerRecordForLease(await readOwnerRecordWithoutRecovery(options.runDir));
      } catch (error) {
        lastError = error;
        continue;
      }

      if (namesSomeoneElse(persisted)) {
        // The same criterion the heartbeat applies in §6.1, evaluated by whichever
        // mechanism observes it first — not a second, weaker test.
        superseded = true;
        throw new RunLeaseLostError(
          `run lease lost: owner record now names ${persisted.currentProcessInstanceId} at epoch ${persisted.currentOwnerEpoch}`,
        );
      }

      return;
    }

    throw new RunLeaseUnverifiableError(
      `run lease could not be verified after ${LEASE_VERIFY_READ_ATTEMPTS} attempts: ${String(lastError)}`,
    );
  };

  return { affirmNow, assertHeld, stop };
}
