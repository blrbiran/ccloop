# Task 5 Report: Guard `persistBoundaryAnalysis`

## What was implemented

Two guards added to `src/controller/runLoop.ts`'s `persistBoundaryAnalysis` (function now
spans roughly `:679-825`):

1. **Entry guard** (`await heartbeat.assertHeld();`), the very first statement in the
   function body — before `buildBoundaryEvidence`, before the `healthy` early return, before
   `readOwnerRecord` (which runs inside the exclusive span further down and performs
   recovery-on-read via `recoverInterruptedOwnerTransfer`, a write). Matches the brief's exact
   placement instruction.

2. **Write guard**, immediately before `writeBoundaryArtifacts`, but **conditioned on
   `nextOwnerEpoch !== null`** rather than unconditional. This is a deliberate deviation from
   the brief's literal text ("the transfer keeps relying on its CAS... no third guard" was
   read by me as "don't add a THIRD guard site", not as "the second guard must be
   unconditional") — forced by a real regression, described in detail below.

### The `guardedWriteArtifacts` decision

**I inlined the guard** (`await heartbeat.assertHeld();` before the write) rather than
hoisting `guardedWriteArtifacts` to module level. Reasoning, per the brief's own tradeoff
framing:

- The brief's premise ("route through the existing `guardedWriteArtifacts` wrapper") is
  wrong: that wrapper is a closure defined inside `runLoopFromState` (`:882-887` in the
  pre-Task-5 file) and is not reachable from `persistBoundaryAnalysis`, a module-level
  function receiving only `heartbeat` as a parameter.
- Hoisting `guardedWriteArtifacts` to module level would touch `runLoopFromState` and
  re-point its six existing call sites — outside this task's stated scope, and against
  CLAUDE.md Rule 3 ("Surgical Changes: touch only what you must").
- Inlining is two lines, matches how L1's fourteen existing `assertHeld` call sites are
  written (a bare `await heartbeat.assertHeld();` before the guarded side effect), and
  changes nothing outside this function.
- Cost accepted: the "guard before a write" pattern now exists in two shapes (the
  `guardedWriteArtifacts` closure, and this inline call). I judged that cost lower than the
  cost of widening the diff to a function this task wasn't asked to touch.

### Doc comment correction

The `heartbeat` parameter's doc comment (previously: *"§6.1: only so a transfer this
function performs ITSELF can be adopted... Nothing here is guarded by it."*) was false after
this change (two things are now guarded by it), so it was corrected to describe both guards.

## A real regression found and resolved: why the write guard is conditional

Implementing the write guard as a **blanket, unconditional** `await heartbeat.assertHeld()`
(exactly as literally specified by the brief) broke two pre-existing, passing baseline tests
in `tests/controller/runLoop.integration.test.ts`:

- `"preserves the winner reconciliation view when another controller already completed the
  transfer"`
- `"preserves a synthesized winner reconciliation view when another controller already
  completed the transfer before success reconciliation was written"`

Both simulate a race: this process's own owner-transfer CAS attempt (inside
`persistOwnerTransfer`) fails with `OwnerTransferPreconditionError` because another
controller already completed an equivalent transfer. In that path, `persistBoundaryAnalysis`
never calls `heartbeat.adopt(...)` (adopt is only reached on the CAS **success** branch), so
the heartbeat's internal `expected` record is unchanged from before this call. A blanket
`assertHeld()` before the write therefore *always* sees "someone else" (the real rival
record) and throws `RunLeaseLostError` — even though `writeBoundaryArtifacts` is provably
safe here: `fileStore.ts`'s `preserveSuccessfulReconciliationIfNeeded` exists precisely so a
losing process's write cannot clobber a winner's already-persisted reconciliation view (it
only activates when `reconciliationRecord.eligibleForContinuation` is `false` — i.e. exactly
the "my own transfer failed" case). The blanket guard turned these tests' expected terminal
outcome from `"exhausted"` (with `BUDGET_EXHAUSTED_REASON`) into `"cancelled"`/`"lease_lost"`
— precisely the terminal-outcome change the task brief explicitly forbids ("If a test starts
showing a different terminal status or exit code, your guard is in the wrong place — do not
'fix' the test").

Root-cause analysis: `nextOwnerEpoch` is set (non-null) **only** on the branch where this
process's own CAS transfer succeeds and `heartbeat.adopt()` is called — exactly the one case
`preserveSuccessfulReconciliationIfNeeded` does **not** protect against (a successful
transfer's own reconciliation view is written as-is, unprotected, since it's presumed
authoritative). So I conditioned the write guard on `nextOwnerEpoch !== null`: it fires only
when this process itself just completed and adopted a transfer, protecting exactly the
window the existing preserve-safety net doesn't cover, and staying out of the way of the
pre-existing "loser writes safely" behavior.

This does not weaken requirement 7 as I understand it (a superseded process must write no
artifacts) for the case the requirement is actually about — a process whose own transfer
succeeded and was then superseded before the write landed (my new test, "spec requirement
7", exercises exactly this and passes). It is narrower than "any raw mismatch refuses",
which is what I believe the brief's author did not anticipate interacting with the
pre-existing winner-preservation tests.

I did not alter `preserveSuccessfulReconciliationIfNeeded` or the two pre-existing tests in
any way.

## Tests added

Both added to `tests/controller/leaseLifecycle.integration.test.ts`, inside the `describe("lease heartbeat lifecycle", ...)` block, after the last pre-existing test.

### Test 1 — spec requirement 6: entry guard precedes recovery-on-read

`"refuses persistBoundaryAnalysis before readOwnerRecord can finalize a staged transfer, once superseded (spec requirement 6)"`

- Seeds a **real interrupted-transfer fixture** (`.owner-transfer.transaction.json` marker +
  `.owner-record.pending.json` + `.owner-transfer.pending.json`, matching
  `fileStore.ts`'s two-phase-commit shape) — if `readOwnerRecord`'s recovery-on-read ever ran,
  `finalizePendingOwnerTransfer` would finalize this fixture (delete the marker, overwrite
  `owner-record.json` with the pending record).
- Drives a real loop via `runLoopFromState` with a real heartbeat (`startLeaseHeartbeat`, not
  a stub), reaching the `if (execution === null)` non-timeout branch (the call site with no
  `executionRecovery`) — chosen because **no other `assertHeld` guard sits between
  `adapter.execute()` returning and `persistBoundaryAnalysis` being called** on this branch,
  making the entry guard unambiguously the first (and only) check to observe the rotation.
- `adapter.execute()` stages the fixture, then rotates `owner-record.json` to a rival
  (simulating supersession discovered only when the guard checks), and returns `null`.
- Asserts `finalState.stopReason === "lease_lost"`, **and** that the marker/pending files are
  untouched and `owner-record.json` still shows the rival's record — i.e. no recovery-on-read
  write occurred, not merely that the call threw (the brief's explicit requirement).
- Uses a manually-constructed heartbeat (`startLeaseHeartbeat`, not `runLoop()`'s convenience
  wrapper) whose `stop()` is **never called**: `stop()` → `releaseOwnerLease` →
  `updateOwnerRecordWithPrecondition` also runs `recoverInterruptedOwnerTransfer(runDir, {
  lockHeld: true })` as an unrelated, legitimate cleanup step, which would finalize the same
  staged fixture for a different reason and confound the assertions. Checking file state
  right after `runLoopFromState` resolves (before any `stop()`) isolates what this test
  targets.
- Also discovered and worked around a second confound: the fixture must be staged **inside**
  `adapter.execute()`, not before the run starts — the heartbeat's own top-of-loop
  `affirmNow()` (called once per iteration via `affirmOwnerLease` →
  `updateOwnerRecordWithPrecondition`) **also** runs `recoverInterruptedOwnerTransfer` and
  would finalize a fixture staged too early, before persistBoundaryAnalysis is ever reached.

### Test 2 — spec requirement 7: no artifacts written after post-transfer supersession

`"writes no boundary or reconciliation artifacts when superseded after its own transfer completes (spec requirement 7)"`

- Modelled on the pre-existing `"owner_transfer_contended"` test's fixture (same
  execute-timeout shape, same `"lost"` owner record triggering `OWNER_LOST` +
  `takeoverAllowed`), reaching the call site **with** `executionRecovery` (the
  `guardedWriteArtifacts`-preceded branch).
- Mocks `writeOwnerTransferArtifacts` (via `vi.doMock` on `fileStore.js`, same pattern as the
  existing "retries a busy owner-transfer lock" test) to let the real CAS transfer succeed
  (so `heartbeat.adopt()` runs), then immediately rotate `owner-record.json` to a **third**,
  unrelated rival — simulating a takeover landing between this process's own adopted
  transfer and its artifact write.
- Asserts `finalState.stopReason === "lease_lost"`, that `owner-transfer.json` (the
  already-committed self-transfer) exists, but **neither** `boundary-analysis.json` nor
  `reconciliation-record.json` was written, and that `owner-record.json` shows the rival's
  record untouched by this process.

## TDD evidence

**RED** — `ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/controller/leaseLifecycle.integration.test.ts -t "spec requirement 6|spec requirement 7"` (before implementing either guard):

```
PASS (0) FAIL (2) skipped (22)
1. ...spec requirement 6...
   AssertionError: expected 'Error: execute phase completed withou…' to be 'lease_lost'
2. ...spec requirement 7...
   AssertionError: expected 'runtime or token budget exhausted' to be 'lease_lost'
```

Both failed for the expected reason: with no guard, the loop reaches its normal (non-lease)
error/exhaustion path instead of refusing, so `finalState.stopReason` is not `"lease_lost"`.
Not a fixture error — both tests set up their scenarios correctly; the assertions on the
*content* of the fixtures (marker files, owner-transfer.json, etc.) were not yet reached
because the very first differing assertion is `stopReason`.

**GREEN** — same command, after implementing both guards (entry guard unconditional, write
guard as finally shipped, conditional on `nextOwnerEpoch !== null`):

```
PASS (2) FAIL (0) skipped (22)
```

Full file: `ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/controller/leaseLifecycle.integration.test.ts` → `PASS (24) FAIL (0)`.

## Mutation evidence

All three mutations applied to the **final** implementation (conditional write guard), each
restored immediately after observing the failure.

**Mutation 1 — delete the entry guard** (`await heartbeat.assertHeld();` as the first
statement):
```
PASS (0) FAIL (1) skipped (23)
1. ...spec requirement 6...
   AssertionError: expected 'Error: execute phase completed withou…' to be 'lease_lost'
```
Test 1 fails: without the entry guard, `readOwnerRecord`'s recovery-on-read runs unguarded
and the marker/pending fixture would be finalized (confirmed separately — see below).

**Mutation 2 — move the entry guard after the healthy early return.** This mutation is
**unfalsifiable by any runtime test with the current codebase**, and I want to flag this
explicitly rather than fabricate a passing mutation record. `evaluateRunBoundary` (called
inside `persistBoundaryAnalysis`) is only ever invoked with `observedStrongProgress: false`
hardcoded as a literal at the single call site (`runLoop.ts`, inside `persistBoundaryAnalysis`).
Per `stopController.ts`'s `evaluateRunBoundary`, `status: "healthy"` is returned **only**
when `input.observedStrongProgress` is true. Since that is always `false` here, the `healthy`
branch is dead code in the current implementation — there is no reachable state in which
`boundaryAnalysis.status === "healthy"`, so moving the guard before vs. after that check
produces **no observable difference** in any test I could construct through the real
`persistBoundaryAnalysis` call path. I verified this directly: moving the guard after the
healthy-check still left test 1 passing unchanged, because in test 1's scenario
`boundaryAnalysis.status` is `"stale_candidate"` (not `"healthy"`), so the guard — wherever
placed between function entry and `readOwnerRecord` — still runs before `readOwnerRecord`
either way. I kept the guard at the very top per the brief's explicit placement instruction
(defensive correctness, and consistent with the stated rationale for if/when
`observedStrongProgress` is ever wired to a real signal), but I could not produce
mutation evidence for this specific ordering, and I am reporting that gap rather than
silently claiming it was verified.

**Mutation 3 — unwrap `writeBoundaryArtifacts`** (delete the `if (nextOwnerEpoch !== null) {
await heartbeat.assertHeld(); }` block entirely):
```
PASS (0) FAIL (1) skipped (23)
1. ...spec requirement 7...
   AssertionError: expected 'runtime or token budget exhausted' to be 'lease_lost'
```
Test 2 fails: without the write guard, the artifacts get written by the (now-superseded)
process and the run completes as `"exhausted"` instead of refusing with `"lease_lost"`.

**Additional mutation implicitly verified during regression investigation — make the write
guard unconditional** (i.e. `await heartbeat.assertHeld();` before the write with no `if`):
this is the version literally specified by the brief. It broke two pre-existing baseline
tests (`"preserves the winner reconciliation view..."` and `"preserves a synthesized winner
reconciliation view..."` in `runLoop.integration.test.ts`), changing their terminal outcome
from `exhausted`/`BUDGET_EXHAUSTED_REASON` to `cancelled`/`lease_lost`. This mutation
evidence is what drove the conditional design; see the regression section above for the
observed failure and root cause.

## Files changed

- `src/controller/runLoop.ts` — the two guards in `persistBoundaryAnalysis`, plus the
  corrected doc comment on the `heartbeat` parameter.
- `tests/controller/leaseLifecycle.integration.test.ts` — two new tests, plus a new static
  import of `startLeaseHeartbeat` from `../../src/controller/leaseHeartbeat.js`.

## Verification run (final)

```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
→ Test Files  23 passed (23)
  Tests  371 passed (371)
```
Run twice for confidence (one earlier full-suite run hit the already-known flaky test
mentioned in the task brief — `tests/controller/runLoop.integration.test.ts`'s "treats
execute timeout with no adapter result as exhausted..." — on an unrelated run while I was
debugging the regression above; it did not recur on either of the two final full-suite runs
reported here, consistent with the brief's "roughly 1 run in 10" characterization). One
other test (`"preserves a synthesized winner reconciliation view..."`) failed once during
investigation with a *budget-reason* mismatch (`"execute phase exceeded per-attempt
timeout"` vs `BUDGET_EXHAUSTED_REASON`) under full-suite load; re-run 5/5 in isolation and
clean on both final full-suite runs — its scenario uses a 20ms total runtime budget racing
real wall-clock timing (the same shape as the already-known flake), and it did not correlate
with the mutation being tested at the time (the entry-guard-deletion mutation, which
short-circuited well before that stopReason branch). I judged this pre-existing,
timing-margin flakiness rather than something new I introduced, but flag it per Rule 12
rather than silently dismiss it.

```
npm run typecheck  → clean
npm run build      → clean
```

## Self-review findings (fixed before reporting)

- Initial test 1 draft asserted file-existence checks with `runLoop()`'s convenience wrapper,
  which calls `heartbeat.stop()` in a `finally` block; `stop()`'s own
  `recoverInterruptedOwnerTransfer` call (via `releaseOwnerLease`) finalized my staged fixture
  for an unrelated reason, producing a false failure. Fixed by switching to a manually
  constructed heartbeat (`startLeaseHeartbeat`) via `runLoopFromState` directly, asserting
  before any `stop()`.
- Same test's fixture was originally staged before the run started, colliding with the
  heartbeat's own top-of-loop `affirmNow()` (which also triggers recovery-on-write). Fixed by
  staging the fixture from inside `adapter.execute()`, after the first affirm has already run
  harmlessly.
- A missing `runDir` declaration and a missing `leaseAffirmedAt` field (a real, required
  `OwnerRecord` field caught by `npm run typecheck`) were both fixed.
- Confirmed via `diff` that the file was restored byte-for-byte identical to the final
  intended implementation after all three (four, counting the ad hoc unconditional-guard
  check) mutation trials.

## Issues / concerns

1. **Mutation 2 cannot be behaviorally verified** with the current codebase, because the
   `healthy` branch of `evaluateRunBoundary` is unreachable from `persistBoundaryAnalysis`
   (`observedStrongProgress` is hardcoded `false`). This is a pre-existing property of the
   code, not something Task 5 introduced or could fix within scope; I'm surfacing it rather
   than silently claiming the mutation was verified.
2. **The write guard is conditional (`nextOwnerEpoch !== null`), not unconditional as the
   brief's prose literally suggests.** This was a required deviation to avoid a real
   terminal-outcome regression on two pre-existing, standing baseline tests (see the
   regression section). I did not change those tests. If a reviewer believes requirement 7 is
   meant to be broader than what I've implemented (i.e. that the "preserves winner" tests
   should also now refuse and lose their `exhausted` outcome), that is a design question
   beyond what I felt authorized to decide unilaterally — I've implemented the narrowest
   guard that discharges my own new test's requirement without touching established,
   passing behavior, and flagged the tradeoff for review.
