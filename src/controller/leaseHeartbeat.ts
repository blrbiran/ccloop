import {
  LEASE_AFFIRM_THROTTLE_MS,
  LEASE_HEARTBEAT_INTERVAL_MS,
  LEASE_VERIFY_READ_ATTEMPTS,
  LEASE_VERIFY_RETRY_DELAY_MS,
  parseOwnerRecordForLease,
  RunHeartbeatStoppedError,
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
  adopt: (record: OwnerRecord) => void;
  affirmNow: () => Promise<void>;
  assertHeld: () => Promise<void>;
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
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

  // appendEvent is a raw appendFile with no internal guard, so it can reject on real I/O
  // failure. Losing the event log must not cost us the stop signal or the refusal that follows
  // it, so it is swallowed here rather than left to propagate: out of runAffirm's catch block
  // it would be unguarded (the timer path fires via a bare `void affirmNow()`, turning any
  // throw into an unhandled rejection instead of the swallow-and-retry the spec requires), and
  // out of assertHeld it would REPLACE a lease refusal with an I/O error — failing open on the
  // one path whose entire job is to fail closed.
  const appendLeaseEvent = async (type: string, detail: string): Promise<void> => {
    try {
      await appendEvent(options.runDir, { type, at: new Date(now()).toISOString(), detail });
    } catch {
      // Swallowed by contract: the stop signal and the refusal must still fire without it.
    }
  };

  // §6.1: both sides of the comparison, which is the whole point of the event — "who took this
  // run over". Only this module can produce it: `expected` is closure state, and the error
  // thrown to the control loop carries the observed side alone.
  const describeSupersession = (persisted: OwnerRecord): string =>
    `expected ${expected.currentProcessInstanceId} at epoch ${expected.currentOwnerEpoch}, observed ${persisted.currentProcessInstanceId} at epoch ${persisted.currentOwnerEpoch}`;

  // §6.1: the ONE place supersession is concluded, so the event recording it is appended
  // exactly once whichever mechanism reaches the conclusion first.
  //
  // Both entry points can reach this CONCURRENTLY: assertHeld is deliberately not part of the
  // `queue` chain that serializes the two writers (it takes no lock and must never wait behind
  // an affirm), so a guard can conclude while a runAffirm that has already passed its
  // `stopped || superseded` entry check is still awaiting its CAS write. That runAffirm then
  // gets its precondition failure, re-reads, and arrives here second.
  //
  // The check therefore has to precede the assignment: on the heartbeat-first path this call is
  // itself what sets the flag, so testing it afterwards would suppress the event on the very
  // path that is supposed to emit it.
  const concludeSupersededOnce = async (persisted: OwnerRecord): Promise<void> => {
    if (superseded) {
      return;
    }

    superseded = true;
    await appendLeaseEvent("lease_lost", describeSupersession(persisted));
  };

  const concludeLeaseLost = async (persisted: OwnerRecord): Promise<void> => {
    await concludeSupersededOnce(persisted);

    // NOT behind the same gate, deliberately. `superseded` records that supersession has been
    // CONCLUDED, not that the caller has been SIGNALLED: assertHeld sets the flag and never
    // signals (it throws into its caller instead), so gating this on the flag would suppress
    // the only signal there is in exactly the interleaving above, leaving the caller's
    // leaseLoss slot null. A redundant signal costs nothing — it is an idempotent assignment
    // to a caller-owned slot, and by §8's no-new-authority rule it can only ever cause a stop.
    //
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

  // §6.1's companion to the "adopt what affirmOwnerLease returns" rule, for the one writer of
  // the owner record that is NOT affirmOwnerLease: a reconciliation transfer performed by THIS
  // process (runLoop's persistBoundaryAnalysis), which rotates the epoch to this same process.
  // Without it, `expected` still holds the pre-transfer epoch and the very next comparison
  // reads its own transfer as somebody else's takeover — a lease_lost event naming this process
  // on both sides, and a refusal of this process's own remaining side effects.
  //
  // Never clears `superseded`. Once supersession has been CONCLUDED the refusal is permanent:
  // adopting a record afterwards would make namesSomeoneElse pass again and let a run that has
  // already been told it lost the lease resume acting, which is precisely the real refusal this
  // method must not weaken. So a post-supersession adopt is dropped, leaving `expected` naming
  // the record this process was superseded from and every later assertHeld still refusing.
  const adopt = (record: OwnerRecord): void => {
    if (superseded) {
      return;
    }

    expected = record;
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
        // Parsed, not merely read — the same validation assertHeld applies, because this is the
        // same ONE criterion. readOwnerRecordWithoutRecovery is a bare JSON.parse plus a cast,
        // so a well-formed-JSON record of the wrong SHAPE would otherwise reach
        // namesSomeoneElse with currentOwnerEpoch === undefined, differ from `expected`, and be
        // concluded as supersession — asserting exactly what could not be read. A record this
        // process cannot validate is a transient failure, classified here as assertHeld
        // classifies it: unverifiable, retried on the next tick, never proof of a takeover.
        persisted = parseOwnerRecordForLease(await readOwnerRecordWithoutRecovery(options.runDir));
      } catch {
        return; // cannot re-read or cannot parse: transient, retry next tick. Not proof of anything.
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

  // Task 3: the second writer of §6's shared serialization, alongside affirmNow. Unlike
  // runAffirm, `fn` is caller-supplied and CAN reject — so this must not copy affirmNow's
  // `queue = queue.then(x, x); return queue` shape verbatim. That shape is safe there only
  // because runAffirm never rejects; reusing it here would store the very promise that
  // carries fn's rejection back into `queue`, and every future scheduling that promise
  // partakes in from then on. `result` (returned to the caller) and the value stored back
  // into `queue` are deliberately two DIFFERENT promises: `result` settles exactly as `fn`
  // does, while the stored one is derived from `result` but maps both outcomes to a plain
  // resolution, so the shared queue itself never becomes a rejected promise.
  //
  // Task B1 / L3 §5.3 supersedes the note that stood here ("takes no position on `stopped` or
  // `superseded` — it only serializes; refusal is Task 5's job"). It still takes no position on
  // `superseded`: that remains assertHeld's one decision. It DOES refuse on `stopped`, and that
  // is not a second, weaker copy of assertHeld's refusal, because assertHeld never reads
  // `stopped` at all — it answers "is this run still ours" from the persisted owner record,
  // while `stopped` answers "does this process still intend to act", which is pure in-process
  // state with no other home.
  //
  // The check runs at the head of the queued continuation, so it is evaluated BEFORE `fn` and
  // never after `fn` settles. That ordering is load-bearing, not a style choice: `fn` at the one
  // production call site (persistBoundaryAnalysis, runLoop.ts) is the read -> evaluate -> CAS
  // transfer span that publishes reconciliation-record.json transactionally, and a refusal
  // raised after it would abandon a COMPLETED publish onto the non-terminal return path B1 adds
  // in runLoopFromState's outer catch. `stopped` is only ever set, never cleared, so checking
  // here also covers a call that was made before stop() and only reaches the head afterwards.
  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const refuseIfStopped = async (): Promise<T> => {
      if (stopped) {
        throw new RunHeartbeatStoppedError(
          `run heartbeat has stopped: refusing an exclusive owner-record operation for ${expected.currentProcessInstanceId} at epoch ${expected.currentOwnerEpoch}`,
        );
      }

      return await fn();
    };

    const result = queue.then(refuseIfStopped, refuseIfStopped);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
        //
        // §6.1 requires the run to record the observed and expected owner records when it
        // concludes supersession, and that consequence belongs to the CONCLUSION, not to the
        // mechanism that reaches it. Appending here is what makes it reachable at all: setting
        // `superseded` makes runAffirm return early forever, so once a guard concludes, the
        // heartbeat can never append the event afterwards. Since §8.1's guards run before every
        // side effect, the guard normally wins that race — leaving, without this, a run that
        // stopped for a lease reason with nothing on disk naming who took it over.
        //
        // Routed through the shared conclusion so the exactly-once gate is ONE gate rather than
        // two similar ones: the heartbeat's own path can be in flight concurrently with this
        // call and would otherwise append a second, duplicate record of the same conclusion.
        await concludeSupersededOnce(persisted);

        throw new RunLeaseLostError(
          `run lease lost: owner record now names ${persisted.currentProcessInstanceId} at epoch ${persisted.currentOwnerEpoch}`,
        );
      }

      return;
    }

    // A DISTINCT type, deliberately: this path refuses without concluding supersession, so it
    // must not append `lease_lost` — there is no observed owner to name, and claiming one would
    // assert exactly what could not be read. It is recorded all the same because a refusal that
    // leaves no trace is indistinguishable from a run that simply stopped, and on the
    // already-terminal path in runLoopFromState this event is the only trace there is.
    await appendLeaseEvent(
      "lease_unverifiable",
      `expected ${expected.currentProcessInstanceId} at epoch ${expected.currentOwnerEpoch}, owner record unreadable after ${LEASE_VERIFY_READ_ATTEMPTS} attempts: ${String(lastError)}`,
    );

    throw new RunLeaseUnverifiableError(
      `run lease could not be verified after ${LEASE_VERIFY_READ_ATTEMPTS} attempts: ${String(lastError)}`,
    );
  };

  return { adopt, affirmNow, assertHeld, runExclusive, stop };
}
