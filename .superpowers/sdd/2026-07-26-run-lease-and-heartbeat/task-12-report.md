# Task 12 Report: Stop at the next phase boundary when the lease is lost

## Status: DONE_WITH_CONCERNS

The behavior change and tests match the brief exactly. One thing does not: the brief's
literal test, run against the real system clock, cannot exercise the behavior it asserts,
because of a genuine interaction with Task 9's affirm throttle. I fixed this on the test
side only, using the same pattern Task 9's own `leaseHeartbeat.test.ts` already uses for
the identical problem. See "Deviation from the brief's literal test" below — flagging this
for review since it goes beyond "verbatim."

## What was implemented

`src/controller/runLoop.ts`:
- Added `LeaseLossSignal` type (`{ lost: RunLeaseLostError | null }`) and
  `createLeaseLossSignal()`, exported alongside `runLoopFromState`.
- `runLoopFromState` gained a sixth parameter, `leaseLoss: LeaseLossSignal = { lost: null }`,
  defaulted so existing direct callers are unaffected.
- **Check 1** (top-of-loop phase boundary): immediately after `heartbeat.affirmNow()`, before
  computing the next `attempt` number — i.e. before any further attempt can start:
  ```ts
  if (leaseLoss.lost !== null) {
    return await persistTerminalState(runDir, state, "cancelled", "lease_lost");
  }
  ```
- **Check 2** (retry phase boundary): inside the `decision.kind === "retryable"` branch, after
  the attempt's workspace cleanup succeeds and after the state has already transitioned to
  `"planning"`, immediately before the `continue` that would launch the next attempt.
- `runLoop` now constructs a real `leaseLoss` signal and wires `onLeaseLost` to set
  `leaseLoss.lost`, passing it as the sixth argument to `runLoopFromState`.

`src/controller/resumeLoop.ts`: identical wiring — `createLeaseLossSignal()`, `onLeaseLost`
callback, and `leaseLoss` passed as `runLoopFromState`'s sixth argument.

### Where each check sits, and why it's a phase boundary

- **Check 1 (top of loop, before `attempt = state.attemptsUsed + 1`)**: this is the point
  between attempts — no attempt is in flight, no workspace exists yet, nothing has been
  written that a new owner could be mid-read on. `state.status` here is always `"planning"`
  (either the loop's initial state or the state the retry branch just transitioned to), and
  `planning -> cancelled` is a legal transition per `src/state/stateMachine.ts`.
- **Check 2 (end of the retryable branch, before `continue`)**: by the time execution reaches
  here, the rejected attempt's artifacts are written, the verification event is recorded, and
  the attempt's worktree has already been cleaned up (`cleanupAttemptWorkspace` succeeded).
  Nothing about the just-finished attempt is left half-torn-down. `state.status` is
  `"planning"` here too (set by the retry's own `transitionRunState(..., "planning", ...)`
  a few lines above), so `cancelled` is legal from here as well. This is the boundary the
  brief calls out as "a phase boundary that can be minutes away from the top of the loop" —
  it exists because the periodic heartbeat timer (30s interval), not just the top-of-loop
  `affirmNow()` call, can be what actually discovers the loss during a long attempt.

Both checks call the same `persistTerminalState(runDir, state, "cancelled", "lease_lost")`,
which never touches `owner-record.json` — it only calls `transitionRunState`, appends an
event, and writes `loop-state.json`. **No owner record is written on this path**, confirmed
by reading `persistTerminalState`'s body (it calls `writeRunState`, not any owner-record
write function) and by the test's own assertion that the rotated record on disk is
byte-for-byte what the test wrote.

## Test mechanism: hand-written adapter, not the Proxy

The brief offers a `Proxy` around `ScriptedAdapter` as the default mechanism and explicitly
allows a hand-written `plan`/`execute`/`verify` object as an equally valid alternative "if
the Proxy shape proves awkward." It did: `ScriptedAdapter#verify` reads `this.currentFrame`,
and the Proxy's `get` trap returns the method detached from `target`, so invoking it through
`Reflect.get(...)(...)`—without `.call(target, ...)` or `.bind(target)`—calls it with
`this === undefined`, throwing `TypeError: Cannot read properties of undefined (reading
'currentFrame')` on the very first `verify` call. I switched to the hand-written wrapper the
brief sanctions, which simply calls `adapter.plan/execute/verify` as bound method calls and
performs the rotation inside its own `verify` after delegating. This is a mechanical fix with
no behavioral difference from what the Proxy was trying to do.

## Deviation from the brief's literal test — the affirm throttle

Even after fixing the Proxy issue, the test still failed, but with a *different* wrong
outcome: the loop completed with `stopReason: "success condition satisfied"` (attempt 2 ran
to success) instead of the expected `TypeError`-then-fixed failure the brief anticipated.

Root cause: `startLeaseHeartbeat`'s `runAffirm` throttles to one real affirm attempt per
`LEASE_AFFIRM_THROTTLE_MS` (10s) — see `src/controller/leaseHeartbeat.ts:86-88`. In the
brief's test, attempt 1's top-of-loop `affirmNow()` succeeds (the record hasn't rotated yet)
and resets that 10-second window. The rotation then happens inside `verify`. When the retry
loop reaches attempt 2's top-of-loop `affirmNow()` — milliseconds later in real time — it is
still inside the 10-second throttle window, so `runAffirm` returns immediately without ever
attempting the CAS that would discover the rotation. `leaseLoss.lost` never gets set, and the
loop proceeds into attempt 2 normally. I verified this directly by temporarily instrumenting
`leaseHeartbeat.ts` with `console.error` and observing `"DEBUG throttled 64"` (64ms elapsed,
not 10000ms) at exactly the point the second affirm was attempted; the instrumentation was
reverted with `git checkout` before any commit.

This is not something Task 12 can fix in production code — the throttle is Task 9's design,
is correct, and is not in scope here (Rule 3: touch only what you must). It also isn't
something a hook could paper over without violating "no hook in production code to make the
test easier."

The fix belongs entirely on the test side, and the codebase already has a precedent for it:
`tests/controller/leaseHeartbeat.test.ts` (Task 9's own unit tests) uses
`vi.useFakeTimers()` + clock manipulation to get past this exact throttle deterministically
in several of its own tests (e.g. "throttles event-driven affirms that arrive inside the
throttle window", "is never throttled: a record rotated between two close side effects
blocks the second"). I applied the same idiom, scoped as narrowly as I could:

- `vi.useFakeTimers({ toFake: ["Date"] })` — fakes only `Date`, not `setTimeout`/`setInterval`,
  so `runPhaseWithTimeout`'s own timeout mechanism and the heartbeat's periodic timer keep
  running on the real clock, unaffected.
- Inside the hand-written adapter's `verify`, immediately after writing the rotated record:
  `vi.setSystemTime(Date.now() + LEASE_AFFIRM_THROTTLE_MS)` — jumps the faked clock forward
  exactly far enough that attempt 2's top-of-loop `affirmNow()` is no longer inside the
  throttle window and actually attempts (and fails) the CAS.
- `vi.useRealTimers()` in a `finally` around the `runLoop` call, so the fake clock never
  leaks into other tests in the file.

That clock jump is measured by `runPhaseWithTimeout` as time spent inside the verify phase
(it brackets the phase with `Date.now()` calls), which drove `hasBudgetExceeded` true against
the shared `createContract()` fixture's default `totalRuntimeBudgetMs: 5000` — turning the
retryable decision into a spurious `"runtime or token budget exhausted"` terminal instead. I
widened `totalRuntimeBudgetMs` to `120_000` for this test's contract only (a local
`{ ...baseContract, executionPolicy: { ...baseContract.executionPolicy, totalRuntimeBudgetMs:
120_000 } }` override, not a change to the shared `createContract()` helper), leaving the
other three tests in the file — which still use the shared helper's 5000ms default — untouched.

I consider this in the spirit of the brief's own "latitude on the test's mechanism," but it
is materially more than the Proxy-vs-adapter swap the brief anticipated, so I'm flagging it
explicitly rather than treating it as self-evidently within scope.

## TDD evidence

**RED** (before implementing check 1/2 in `runLoop.ts`), after fixing only the Proxy issue:
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts -t "lease_lost"
```
```
AssertionError: expected 'success condition satisfied' to be 'lease_lost'
Expected: "lease_lost"
Received: "success condition satisfied"
```
This is the exact failure the brief predicts in Step 2 ("the loop starts attempt 2 and
finishes normally") — confirmed as failing for the right reason: the loop has no lease-loss
check at all yet, so it silently proceeds into attempt 2 and that attempt succeeds.

**GREEN** (after implementing `LeaseLossSignal` + both checks + wiring, and after the fake-
timer/budget fix above):
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts
```
```
✓ tests/controller/leaseLifecycle.integration.test.ts (4 tests) 645ms
Test Files  1 passed (1)
     Tests  4 passed (4)
```

**Full suite**:
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
```
```
Test Files  23 passed (23)
     Tests  341 passed (341)
```
(Baseline was 340; +1 for the new test. All 23 files remained green — no regressions.)

**Typecheck**:
```
npm run typecheck
```
Clean (no output).

**Build**:
```
npm run build
```
Clean (no output).

## Files changed

- `src/controller/runLoop.ts` — `LeaseLossSignal`/`createLeaseLossSignal`, sixth param on
  `runLoopFromState`, two phase-boundary checks, real `onLeaseLost` wiring in `runLoop`.
- `src/controller/resumeLoop.ts` — same `leaseLoss` wiring for the resume path.
- `tests/controller/leaseLifecycle.integration.test.ts` — `rejectFrame()` helper, and the new
  test (hand-written adapter instead of the brief's Proxy, plus the fake-timer/budget fix
  described above, both commented in place with the reasoning).

## Self-review

- **Completeness**: both phase-boundary checks from the brief are present at the exact
  locations specified. `runLoop` and `resumeLoop` both wire real `onLeaseLost` callbacks.
  No owner record is written on the stop path (verified by reading `persistTerminalState`
  and by the test's assertions on the untouched rotated record).
- **YAGNI**: no new abstractions beyond what the brief specifies. `LeaseLossSignal` is a
  two-line type + factory, matching the brief's exact snippet. Did not touch
  `leaseHeartbeat.ts`, `lease.ts`, or `stateMachine.ts` — this is genuinely the only runtime
  behavior change to `runLoop`, as the brief requires.
  - Did not touch the throttle or any other Task 9 production code, even though it's what
    made the test hard to write — the fix is entirely test-side.
- **Discipline / surgical changes**: diff is 34 lines added in `runLoop.ts` (mostly the new
  type/checks), 11 lines in `resumeLoop.ts` (mirroring the same wiring), no unrelated
  formatting or refactoring.
- **Testing**: TDD followed — wrote the test first, ran it, hit two distinct failures in
  sequence (a Proxy `this`-binding `TypeError`, then the real "no detection due to throttle"
  failure once the Proxy was swapped for the hand-written adapter), diagnosed each with
  evidence (the throttle diagnosis is backed by a temporary debug instrumentation run, since
  reverted) before changing anything. The final test asserts real production behavior: stop
  reason, attempt count frozen at 1, the `lease_lost` event present, and the *new* owner's
  record fields unchanged — not just "no exception thrown."
- **Output pristine**: no `console.log`/debug output left in any file; the temporary
  `console.error` instrumentation in `leaseHeartbeat.ts` was reverted via `git checkout`
  before this report was written, and `git diff src/controller/leaseHeartbeat.ts` shows no
  changes to that file in the final state.

## Concerns

1. The test-side fixes (hand-written adapter, fake-timer clock jump, widened test-local
   runtime budget) are more than the brief's "exact test body to use verbatim" instruction
   anticipated. I believe they're necessary and correct — the root cause is a genuine timing
   interaction with Task 9's already-shipped throttle, not a misunderstanding of the intended
   behavior — but a fresh pair of eyes should confirm the fix is the right one rather than a
   symptom of a design gap worth addressing at the plan level (e.g., should `runLoop` expose
   a way to inject `now`/a clock into the heartbeat it constructs, the way `startLeaseHeartbeat`
   itself already supports via its own `now?` option, for exactly this kind of integration
   test in future tasks?). I did not add that hook myself, per the instruction not to add
   production hooks to make tests easier — flagging it as a question rather than deciding it.
2. No existing tests broke. The one existing-test-adjacent risk I checked directly: the other
   three tests in `leaseLifecycle.integration.test.ts` still use the shared `createContract()`
   helper unmodified (5000ms budget), so they are unaffected by the local budget override in
   the new test.

## Commit

```
git add src/controller/runLoop.ts src/controller/resumeLoop.ts tests/controller/leaseLifecycle.integration.test.ts
git commit -m "feat: stop the run at the next phase boundary when its lease is lost"
```

---

## Fix report: Check 2 coverage gap (review finding, addressed)

Review of this task found that the one test this task added never exercises Check 2 (the
retry-boundary check). The rotation in that test is only ever observed by Check 1, one
iteration later, because `heartbeat.affirmNow()` has exactly one call site (top of loop);
nothing analogous is called at the retry boundary, so `leaseLoss.lost` is still `null` when
Check 2 runs during attempt 1, and only becomes non-null on attempt 2's top-of-loop
`affirmNow()` — which is Check 1. The finding was accurate; confirmed by tracing the code
before writing anything.

### What was added

A new test in `tests/controller/leaseLifecycle.integration.test.ts`: **"check 2: stops at the
retry boundary itself, without ever reaching a second top-of-loop pass."** It calls
`runLoopFromState` directly (exported from `src/controller/runLoop.ts`, along with
`createLeaseLossSignal`), bypassing the heartbeat and any clock manipulation entirely:

- A `leaseLoss` signal is created via `createLeaseLossSignal()` and held by the test.
- A hand-written adapter's `verify()` sets `leaseLoss.lost = new RunLeaseLostError(...)`
  (a real error instance, matching what the production `onLeaseLost` cast in `runLoop`/
  `resumeLoop` actually receives) and returns a rejecting verification
  (`safeToRetry: true`, built from the existing `rejectFrame()` helper) so the loop enters
  the retry branch.
- `runLoopFromState(contract, runDir, adapter, initialLoopState, spyHeartbeat, leaseLoss)` is
  called with a hand-built `"planning"`-status `initialLoopState` (matching the shape
  `runLoop()` itself constructs) and a **spy heartbeat** — not the inert default — whose
  `affirmNow()` increments a counter.

### The decisive assertion, and why it's the one that matters

`expect(affirmNowCalls).toBe(1)`. Each `affirmNow()` call corresponds to exactly one
top-of-loop pass. Check 1 for attempt 1 runs (and finds `leaseLoss.lost` still `null`,
since `verify()` hasn't run yet) — that's the one call. If Check 2 did not exist, or fired
on the wrong condition, or returned instead of stopping, the loop would `continue` into a
second iteration, and *that* iteration's top-of-loop `affirmNow()` would be a second call,
making the counter read 2.

I initially considered asserting only `stopReason === "lease_lost"` and `attemptsUsed === 1`
(as the review comment sketched), but traced through what happens if Check 2 is deleted:
`leaseLoss.lost` is never reset once set, so on the *next* iteration Check 1 catches the
exact same signal, before `attemptsUsed` is incremented — producing the identical
`stopReason` and `attemptsUsed` as when Check 2 catches it. Those two assertions alone
cannot distinguish "Check 2 caught it" from "Check 1 caught it one iteration later,"
because the two checks are deliberately near-identical in what they do. The `affirmNowCalls`
assertion is what actually pins the stop to the same iteration Check 2 lives in, which is
why it's called out as decisive in the test's own comment. `stopReason` and `attemptsUsed`
are kept in the test as baseline sanity checks (both stay true under the Check-2-removed
mutation, by the reasoning above — only `affirmNowCalls` moves), and the owner-record
sentinel assertion confirms the stop path still writes nothing to `owner-record.json` even
on this directly-invoked path.

### `cleanupAttemptWorkspace` — which path it took

The retry branch runs `cleanupAttemptWorkspace(contract.context.repoPath, worktreePath)`
before Check 2. The test uses `createRepo()` (the same real-git fixture the rest of this file
uses) and a normal `createAttemptWorkspace` call happens earlier in the same attempt, so the
worktree exists and belongs to that repo when cleanup runs — the same successful-cleanup path
the already-passing Check 1 test exercises. Confirmation: `finalState.stopReason` is exactly
`"lease_lost"` with status reachable only through `persistTerminalState(..., "cancelled",
"lease_lost")`; the cleanup-failure branch instead transitions to `"failed"` with
`String(error)` as the reason, which is not what was observed. Cleanup took the success path.

### Two-sided mutation evidence

**Mutant (Check 2 deleted from `src/controller/runLoop.ts`, restored immediately after):**
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts
```
```
❯ tests/controller/leaseLifecycle.integration.test.ts (5 tests | 1 failed) 692ms
  × lease heartbeat lifecycle > check 2: stops at the retry boundary itself, without ever
    reaching a second top-of-loop pass 134ms
    → expected 2 to be 1 // Object.is equality

AssertionError: expected 2 to be 1
- Expected: 1
+ Received: 2
  at tests/controller/leaseLifecycle.integration.test.ts:277:28 (expect(affirmNowCalls).toBe(1))

Test Files  1 failed (1)
     Tests  1 failed | 4 passed (5)
```
The new test fails exactly as predicted (`affirmNowCalls` becomes 2 — the loop fell through
to a second top-of-loop pass). **The other 4 tests, including the original Check 1 test
("stops at the next phase boundary with stopReason lease_lost and leaves the new record
intact"), still pass** — proving the two tests cover different checks: Check 1's own test is
insensitive to Check 2 being deleted, and the new test is exactly what catches it.

**Check 2 restored, full covering-file run:**
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts
```
```
✓ tests/controller/leaseLifecycle.integration.test.ts (5 tests) 727ms
Test Files  1 passed (1)
     Tests  5 passed (5)
```

**Typecheck:**
```
npm run typecheck
```
Clean (no output).

**Full suite (re-run after restoring Check 2), for completeness:**
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
```
```
Test Files  23 passed (23)
     Tests  342 passed (342)
```
(341 → 342: the one new covering test. No regressions.)

### Files changed in this fix

- `tests/controller/leaseLifecycle.integration.test.ts` — added the Check-2-covering test and
  its imports (`runLoopFromState`, `createLeaseLossSignal` from `runLoop.js`;
  `RunLeaseLostError` from `lease.js`; `LeaseHeartbeat` type from `leaseHeartbeat.js`;
  `RunState` type from `state/types.js`). No production code changed by this fix (the
  Check 2 deletion/restoration in `runLoop.ts` was a temporary, reverted mutation used only
  to generate the evidence above — confirmed via `git diff src/controller/runLoop.ts`
  showing no changes before this fix's commit).

### Self-review of the fix

- Confirms the exact gap the reviewer named, with two-sided evidence (fails when the checked
  code is absent, passes when present, and the *other* test's insensitivity to the same
  mutation is shown too — not just "a test exists").
- No clock games, no fake timers, no production hook: uses the sixth parameter exactly as
  the review suggested it was built for.
- Did not touch the throttle or any other Task 9 code, per the "for the record only, do not
  act on it" note.
