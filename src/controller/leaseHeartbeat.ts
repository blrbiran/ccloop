import {
  LEASE_AFFIRM_THROTTLE_MS,
  LEASE_HEARTBEAT_INTERVAL_MS,
  RunLeaseLostError,
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
    await appendEvent(options.runDir, {
      type: "lease_lost",
      at: new Date(now()).toISOString(),
      detail: `expected ${expected.currentProcessInstanceId} at epoch ${expected.currentOwnerEpoch}, observed ${persisted.currentProcessInstanceId} at epoch ${persisted.currentOwnerEpoch}`,
    });
    options.onLeaseLost(
      new RunLeaseLostError(
        `run lease lost: owner record now names ${persisted.currentProcessInstanceId} at epoch ${persisted.currentOwnerEpoch}`,
      ),
    );
  };

  const runAffirm = async (): Promise<void> => {
    if (stopped || superseded) {
      return;
    }

    if (now() - lastAffirmAtMs < LEASE_AFFIRM_THROTTLE_MS) {
      return;
    }

    // Captured before the CAS await, not after: the write lands at this instant, and
    // throttling has to measure from it. Reading now() again post-await would instead read
    // whatever the clock has become by the time the (arbitrarily delayed) I/O settles, which
    // can wrongly push the throttle window forward and stall a legitimate next affirm.
    const attemptAtMs = now();

    try {
      expected = await affirmOwnerLease(options.runDir, expected, new Date(attemptAtMs).toISOString());
      lastAffirmAtMs = attemptAtMs;
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

  const assertHeld = async (): Promise<void> => {
    // Filled in by Task 10.
  };

  return { affirmNow, assertHeld, stop };
}
