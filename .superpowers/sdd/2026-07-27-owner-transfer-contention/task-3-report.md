# Task 3 report: `LeaseHeartbeat.runExclusive`

## What changed and why

Both writers of §6 — the periodic/event-driven affirm and, starting with Task 4, the run
loop's owner-transfer — have to be serialized against each other so the heartbeat cannot
undo its own process's transfer between the transfer's read and its CAS. Task 3 adds the
primitive that provides that serialization: `runExclusive`, a third way to schedule work
onto the same internal `queue` that `affirmNow` already uses.

### `src/controller/leaseHeartbeat.ts`

**Type** (`:19-25`): added
```ts
runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
```

**Implementation** (`:196-203`, immediately after `affirmNow`):
```ts
const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};
```

**Return statement** (`:311`): now returns `{ adopt, affirmNow, assertHeld, runExclusive, stop }`.

`assertHeld` was left untouched and outside the queue, per the brief's instruction — it is
still the exactly-once supersession gate described at `:74-78`, and moving it into `queue`
would make it wait behind an affirm or a transfer, which it must never do.

### `src/controller/runLoop.ts`

`INERT_LEASE_HEARTBEAT` (`:838-845`) gained:
```ts
runExclusive: (fn) => fn(),
```
It executes `fn` and returns its result — a no-op here would silently delete every owner
transfer performed by a run driven without a live heartbeat (this is `runLoopFromState`'s
default, `:859`).

I also **exported** `INERT_LEASE_HEARTBEAT` (previously module-private). It has no other
consumer to protect and there is no other way to pin its `runExclusive` behavior directly in
a test without either exporting it or exercising it indirectly through a whole `runLoop`
run — exporting is the surgical option.

### `tests/controller/leaseLifecycle.integration.test.ts`

Three hand-written `LeaseHeartbeat` object literals (a spy heartbeat and two guard-refusal
heartbeats used to drive `runLoopFromState` directly) each needed `runExclusive: (fn) =>
fn()` added — the type gained a required field, so these literals stopped satisfying it.
None of the three scenarios exercises `runExclusive`; each is otherwise unchanged.

## Keeping the stored chain and the returned promise distinct

`result` (`queue.then(fn, fn)`) is what settles exactly as `fn` does — that's what
`runExclusive` returns. What gets written back into `queue` is a *different* promise,
derived from `result` via a second `.then` that maps both outcomes (fulfilled or rejected)
to a plain resolution. So:

- The caller of `runExclusive` sees `fn`'s own outcome, success or failure.
- `queue` itself can never become a rejected promise, no matter what `fn` does — every
  future consumer of `queue` (the next `affirmNow`, the next `runExclusive`, `stop`'s
  `await queue.catch(() => {})`) is chained behind a promise guaranteed to resolve.

I did **not** copy `affirmNow`'s `queue = queue.then(x, x); return queue` shape — that
reuses one promise for both roles, which only stays safe there because `runAffirm` itself
never rejects.

## Tests, with mutation evidence

All three live in `tests/controller/leaseHeartbeat.test.ts`.

### 1. Serialization — "does not invoke the due affirm's write until an in-flight
   runExclusive fn resolves" (new describe block `runExclusive shares the serialization
   queue with affirmNow`)

This one needed a design change partway through. My first attempt drove a *real* affirm via
`vi.advanceTimersByTimeAsync` and polled `owner-record.json` mid-flight to check the affirm
hadn't run yet. That version passed against **both** the correct implementation and a
broken one (mutation 1, below) — a real affirm's completion depends on several real
filesystem round trips (lock, read, write, rename, unlock), and neither the correct nor the
broken run had actually reached disk yet after a bounded number of microtask flushes, for
reasons unrelated to serialization. A test that can't fail is wrong (Rule 9), so I replaced
it: `affirmOwnerLease` (from `../../src/persistence/fileStore.js`) is mocked via
`vi.doMock`/`vi.resetModules` to a plain, test-controlled deferred promise. With no real I/O
left in the picture, "was the affirm's write even invoked before `fn` resolved" becomes an
exact, race-free assertion driven by two controlled gates (`fnGate`, `affirmGate`) and a
shared `order` array.

- Kick off `heartbeat.runExclusive(fn)` where `fn` pushes `"fn:start"`, awaits `fnGate`,
  pushes `"fn:end"`.
- Immediately call `heartbeat.affirmNow()` — the "due affirm," queued right behind `fn`.
- After two microtask flushes: assert `order` is exactly `["fn:start"]`.
- Release `fnGate`, await the `runExclusive` promise, flush two more microtasks: assert
  `order` is `["fn:start", "fn:end", "affirm:start"]`.
- Release `affirmGate`, await the affirm promise: assert
  `order` is `["fn:start", "fn:end", "affirm:start", "affirm:end"]`.

**Mutation (matches brief's mutation 1):** `runExclusive` calls `fn()` directly, without
touching `queue` at all:
```ts
const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => fn();
```
**Observed failure:**
```
AssertionError: expected [ 'fn:start', 'affirm:start' ] to deeply equal [ 'fn:start' ]
```
`affirmNow`'s own chain found `queue` untouched (still the original resolved promise) and
invoked `runAffirm` — which reached the mocked `affirmOwnerLease` — immediately, before `fn`
had resolved. Restored; suite re-verified green.

### 2. Requirement 10 — "a rejecting fn propagates to its caller, and the queue stays
   usable for what follows" (`startLeaseHeartbeat` describe block)

Spec requirement 10: *"A rejected `fn` propagates out of `runExclusive` and leaves the
queue usable for a subsequent affirm."* The test:
1. `runExclusive(() => { throw boom })` rejects with `boom` — asserted directly.
2. A **second** `runExclusive` call (`async () => "second-result"`) must resolve with its
   own result, not inherit the first call's rejection.
3. `affirmNow()` after that must still run: `leaseAffirmedAt` is non-null afterward.

Check 2 needed adding beyond what the brief's wording literally asks for ("a subsequent
affirm still runs"). I verified empirically (see below) that `affirmNow`'s own call site —
`queue.then(runAffirm, runAffirm)`, unchanged, dual-handler — self-heals a rejected `queue`
no matter what shape the *previous* write to `queue` used, because a dual-handler `.then`
invokes its handler regardless of whether the upstream promise fulfilled or rejected. So a
mutated `runExclusive` that mirrors that exact dual-handler shape (`queue = queue.then(fn,
fn); return queue`) does *not* actually break "subsequent affirm still runs" — I confirmed
this with a small standalone Node script before trusting a test built only around that
check. What *does* break under a poisoned queue is a **subsequent single-handler consumer**
of `queue` (a second `runExclusive` call, in a mutation using `.then(fn)` with no
`onRejected`) inheriting the stale rejection instead of running its own `fn` — check 2
targets exactly that.

**Correction (review round 2):** the mutation I originally recorded here — `queue =
queue.then(fn) as unknown as Promise<void>; return queue as unknown as Promise<T>;` — needs
two `as unknown as` casts to even compile, because it reuses `queue = queue.then(...)`
directly against a variable typed `Promise<void>`. That is not a mutation a plausible wrong
implementation would produce, so while it does make this test fail (second
`runExclusive(async () => "second-result")` rejects with the first call's stale `boom`
instead of running its own `fn`), it doesn't discharge the verification this test is
actually for. See "Fix (review round 2)" below for the realistic mutation
(`queue = result.then(() => undefined)`, no casts needed) and why it passes this test in
full — the actual gap it exposes needed a different, new test.

### 3. `INERT_LEASE_HEARTBEAT.runExclusive` — "executes fn and returns its result"
   (new describe block `INERT_LEASE_HEARTBEAT.runExclusive`)

Asserts `INERT_LEASE_HEARTBEAT.runExclusive(async () => "transferred")` resolves to
`"transferred"`, and that a side-effecting `fn` actually runs (a `calls` array is populated).

**Mutation (matches brief's mutation 3):**
```ts
runExclusive: async () => undefined,
```
**Observed failure (test):**
```
AssertionError: expected undefined to be 'transferred' // Object.is equality
```
**Observed failure (typecheck)**, as a bonus — this mutation doesn't even type-check against
the generic signature:
```
src/controller/runLoop.ts(846,29): error TS2322: Type 'Promise<undefined>' is not
assignable to type 'Promise<T>'.
```
Restored; suite and typecheck re-verified green.

## Verification

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.json
(clean)

$ npm run build
> tsc -p tsconfig.json && ...
(clean)

$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
 Test Files  23 passed (23)
      Tests  366 passed (366)
```
366 = 363 baseline + 3 new tests. No existing test was weakened or deleted; the three
`LeaseHeartbeat` literals touched in `leaseLifecycle.integration.test.ts` only gained the
new required field.

## What I deliberately did not do

- **Did not touch `assertHeld`.** It stays outside `queue`, per the brief and the existing
  comments at `:74-78`.
- **Did not add a `stopped`/`superseded` check inside `runExclusive`.** It takes no position
  on either — it only serializes. Refusal is Task 5's job.
- **Did not implement or call `runExclusive` from `persistOwnerTransfer`/the run loop.**
  That wiring — wrapping the read → evaluate → CAS → `adopt` span described in the design
  doc §4 — is Task 4's job, not this one's.
- **Did not add a wall-clock-sleep-based test.** The serialization test originally reached
  for `vi.advanceTimersByTimeAsync` plus real disk polling; once I found that didn't
  actually discriminate correct from broken (see test 1 above), I replaced the real I/O with
  a mocked `affirmOwnerLease` rather than reach for a real timer/sleep, since the suite
  already carries one timing-dependent test flagged as a flake risk.
- **Correction (review round 2) — the dual-handler mirror claim below was wrong as
  originally stated.** I had written that the dual-handler mirror (`queue = queue.then(fn,
  fn); return queue`) was *undistinguishable from the correct implementation by any test* —
  that conclusion was wrong. My empirical finding underneath it was right (it self-heals for
  every *awaited* consumer in this suite, via the same `.then(onFulfilled, onRejected)`
  self-healing on an already-rejected promise I verified with a standalone Node script), but
  self-healing for an *awaited* caller says nothing about a fire-and-forget or
  deferred-`await` caller: with one of those, the rejection lands on `queue` and nothing
  consumes it until the next write to `queue` — up to a full `LEASE_HEARTBEAT_INTERVAL_MS`
  away — producing an `unhandledRejection` the correct implementation cannot produce. See
  "Fix (review round 2)" below for the test that exercises exactly that shape. It is still
  true that this specific mirror needs two `as unknown as` casts to compile (unlike the
  realistic mutation in the fix below), which is why I did not chase a test built
  specifically against it — but "no test could exist" was the wrong conclusion to draw from
  that.

## Fix (review round 2)

Review finding (Important): the untested case was misidentified. The dual-handler mirror
needs two casts to compile and isn't what a real implementer would write. The mutation that
actually is plausible — and that no existing test caught — is dropping `onRejected` from
just the *stored* mapper, keeping the read side (`queue.then(fn, fn)`) untouched:

```ts
const result = queue.then(fn, fn);
queue = result.then(() => undefined);   // one argument, not two — the bug
return result;
```

This **typechecks cleanly** (`Promise<undefined>` unifies with `Promise<void>` with no cast
needed — unlike either mutation I'd tried before). It also **passes the existing
requirement-10 test in full**, which I re-confirmed by applying it and running that test in
isolation: the second `runExclusive` call's own read of `queue` (`queue.then(fn2, fn2)`) is
itself dual-handler, so it self-heals a rejected `queue` regardless of what shape the
*previous* write used — the requirement-10 test can never observe this bug, no matter how
it's extended, as long as it only ever drives further *awaited* operations through `queue`.

What it actually produces: `queue` sits rejected with no handler attached to it until the
next write — the next timer-driven `affirmNow()`, up to a full `LEASE_HEARTBEAT_INTERVAL_MS`
away. Nothing in `src/` installs a `process.on("unhandledRejection", ...)` listener, so in
production this is Node's default unhandled-rejection behavior: process termination. On a
lease-holding run loop, that turns a normal, expected outcome under contention (a transfer's
`fn` rejecting with `OwnerTransferPreconditionError`, or a real I/O failure) into a crash.

### New test

`tests/controller/leaseHeartbeat.test.ts`, in the real-timer describe block
`runExclusive shares the serialization queue with affirmNow` (not the fake-timer
`startLeaseHeartbeat` block, since nothing about this test needs the fake clock):

```
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

    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    await heartbeat.stop();
  }
});
```

The `setImmediate` gap is deliberate: it ends the turn with nothing else chained onto
`queue` (no `affirmNow`, no second `runExclusive`), so a rejected-and-unhandled `queue` has
nowhere to hide behind a self-healing read.

### Mutation evidence

Applied the exact mutation from the finding to `src/controller/leaseHeartbeat.ts`:
```ts
const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = queue.then(fn, fn);
  queue = result.then(() => undefined);
  return result;
};
```

`npm run typecheck` — clean, confirming the mutation compiles with no casts:
```
> tsc --noEmit -p tsconfig.json
(clean)
```

`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts`:
```
(node:86497) PromiseRejectionHandledWarning: Promise rejection was handled asynchronously (rejection id: 169)
 ❯ tests/controller/leaseHeartbeat.test.ts (19 tests | 1 failed) 319ms
   × runExclusive shares the serialization queue with affirmNow > runExclusive: a rejecting fn leaves the shared queue resolved — no unhandled rejection 6ms
     → expected [ Error: boom ] to deeply equal []

 FAIL  tests/controller/leaseHeartbeat.test.ts > runExclusive shares the serialization queue with affirmNow > runExclusive: a rejecting fn leaves the shared queue resolved — no unhandled rejection
AssertionError: expected [ Error: boom ] to deeply equal []
- Array []
+ Array [
+   [Error: boom],
+ ]
 ❯ tests/controller/leaseHeartbeat.test.ts:476:25

 Test Files  1 failed (1)
      Tests  1 failed | 18 passed (19)
```

Exactly as predicted: `boom` reached `process`'s `unhandledRejection` event. The other 18
tests were unaffected — this specific bug is invisible to all of them, confirming the
finding that it was genuinely untested before this fix.

Reverted the mutation (restored the correct two-argument absorbing mapper) and re-ran full
verification:

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.json
(clean)

$ npm run build
> tsc -p tsconfig.json && ...
(clean)

$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts
 Test Files  1 passed (1)
      Tests  19 passed (19)

$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
 Test Files  23 passed (23)
      Tests  367 passed (367)
```

367 = 363 baseline + 4 new tests (the 3 from the first pass, plus this one). No source
change was needed or made — the implementation was already correct; only the missing test
was added.

