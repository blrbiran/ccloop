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

**Mutation (matches brief's mutation 2, single-handler variant):**
```ts
const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  queue = queue.then(fn) as unknown as Promise<void>; // same object stored AND returned
  return queue as unknown as Promise<T>;
};
```
**Observed failure:**
```
AssertionError: promise rejected "Error: boom" instead of resolving
Caused by: Error: boom
```
The second `runExclusive(async () => "second-result")` call rejected with the *first*
call's stale `boom`, never invoking its own `fn` — exactly the poisoned-chain failure mode.
I also tried the more literal dual-handler mirror (`queue = queue.then(fn, fn); return
queue`) as a first attempt at this mutation and confirmed — as the Node experiment
predicted — that it does **not** fail this test (or any test in the suite): dual-handler
`.then` self-heals regardless of the previous promise's settlement, so it doesn't actually
violate requirement 10's stated properties even though it violates the "distinct promises"
structural requirement from the brief. I've recorded this as a known limit of test-based
verification for that specific structural shape (see "not done" below) — the check 2
addition is the strongest *behavioral* test available for the broken class of mutation, and
the source comment and design-doc citation explain why it must be a distinct promise. Both
mutations restored; suite re-verified green.

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
- **Left the dual-handler mirror mutation formally uncaught by any test.** I could not
  construct an observable-behavior test that distinguishes `queue = queue.then(fn, fn);
  return queue` (same object, dual-handler) from the correct implementation — it happens to
  self-heal for every consumer currently in the codebase (both `affirmNow` and a subsequent
  `runExclusive`, since JS's `.then(onFulfilled, onRejected)` invokes `onRejected` on an
  already-rejected promise regardless of when `.then` was called). I verified this with a
  standalone Node script rather than assert it from memory. This is flagged here rather than
  silently left as an assumed-covered case — the requirement 10 test still passes for the
  right reason (it covers the single-handler mutation, which is the one that actually
  breaks), but "same object for stored and returned" as a structural property is enforced by
  source comment and design-doc reference, not by a test that can currently fail on it.
