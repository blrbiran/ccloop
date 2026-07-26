# Task 11 Report: Heartbeat lifecycle in both controllers

## Summary

Wired `startLeaseHeartbeat` into both `runLoop` and `resumeLoop`, threaded the resulting
`LeaseHeartbeat` through `runLoopFromState` (new optional 5th parameter, defaulting to an
inert no-op heartbeat for backward compatibility), and added the event-driven
`heartbeat.affirmNow()` call at the top of the loop body per the brief's Step 4. Both call
sites start the heartbeat only after the owner record naming the process is durably on disk,
and both stop it via `try/finally` on every exit path.

## Placement (exact, per the "state explicitly" instruction)

- **`runLoop`** (`src/controller/runLoop.ts`): `startLeaseHeartbeat` is called immediately
  after `await writeOwnerRecord(runDir, ownerRecord)` and
  `await appendTransitionEvent(runDir, state, "loop_planning", ...)`. The subsequent call to
  `runLoopFromState` is wrapped in `try { ... } finally { await heartbeat.stop(); }`.
- **`resumeLoop`** (`src/controller/resumeLoop.ts`): `startLeaseHeartbeat` is called after
  `await claimOwnerRecordWithPrecondition(...)` succeeds and after the `resume_adopted` event
  is appended, using `nextOwnerRecord` (exactly what the CAS claim wrote) as the heartbeat's
  starting `ownerRecord`. `cleanupResidualWorktrees` and the call to `runLoopFromState` are
  both inside the `try` block; `finally { await heartbeat.stop(); }` covers both.
- **`runLoopFromState`**: gained a 5th parameter `heartbeat: LeaseHeartbeat =
  INERT_LEASE_HEARTBEAT` (inert = all three methods are async no-ops), so every existing
  direct caller (tests, and any code not yet passing a real heartbeat) keeps compiling and
  behaves exactly as before. `await heartbeat.affirmNow()` was added at the very top of the
  `while (true)` loop body, right after `await writeRunState(runDir, state)` and before
  `attempt = state.attemptsUsed + 1`. This affirm is permanent, not scaffolding — it's the
  §6 event-driven refresh at an attempt boundary.

## TDD evidence

**RED (Step 2, for the *wrong* reason, as the brief predicted):**

Command: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts`

Ran with the three new tests in place but *no* production wiring yet. Result: all 3 tests
**passed** — vacuously, because `leaseAffirmedAt` was already `null` (nothing had ever
affirmed it), so `expect(owner.leaseAffirmedAt).toBeNull()` was trivially true. This matches
exactly what the brief warned about in Step 2: the test cannot yet distinguish "released"
from "never taken." This is why the brief tells you to add the wiring (Steps 3-5, including
the `affirmNow()` call) before treating this test as meaningful.

**GREEN, verified genuine (not vacuous):**

After implementing Steps 3-5 (including `affirmNow()`), the 3 new tests passed. To confirm
this was a *real* pass and not still vacuous, I temporarily removed `heartbeat.stop()` from
`runLoop`'s `finally` block (kept everything else, including `affirmNow()`) and reran:

```
 × releases the lease when the loop returns... → expected '2026-07-26T12:20:31.279Z' to be null
 × releases the lease when the loop throws     → expected '2026-07-26T12:20:31.451Z' to be null
```

Both failed as expected, proving `leaseAffirmedAt` was genuinely non-null mid-run (the
`affirmNow()` call had set it) and that `stop()`'s release is what the test is actually
checking. I then restored the correct implementation and reran — all 3 passed again:

```
 ✓ tests/controller/leaseLifecycle.integration.test.ts (3 tests) 465ms
```

## Full verification

- `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run` → **23 files / 340 tests, all green**
  (baseline was 22/337; +1 file, +3 tests from the new lease-lifecycle test file).
- `npm run typecheck` → clean.
- `npm run build` → clean.
- Manually grepped test output for `unhandled|leak|warning|error` across the three touched
  test files — no matches. No leaked timers or unhandled rejections.

## An unplanned but necessary fix

Wiring `affirmNow()` broke one **pre-existing** test that the brief did not list for
modification: `tests/controller/runLoop.integration.test.ts` →
`"exhausts the run when adapter-reported token usage exceeds the token budget"`. That test
mocks `Date.now()` with a hand-rolled, order-dependent finite sequence
(`[1_000, 1_000, 1_600]`, falling back to `1_600` once exhausted) to pin down exact elapsed-time
math. `heartbeat.affirmNow()`'s `runAffirm()` calls `Date.now()` three times (throttle check,
`new Date(now())` for the affirm timestamp, and `lastAffirmAtMs = now()`) before the plan
phase's own `Date.now()` calls, shifting the sequence and causing the mocked plan-phase
`elapsedMs` to compute as `0` instead of `600`, which flowed into a wrong
`timeRemainingMs` (`5000` observed vs. `4400` expected).

This is a legitimate consequence of the required design change (an extra `Date.now()`
consumer now runs before the phase timing code), not a mistake in the new work. Per the
global constraint that the suite must stay green, I extended that test's timestamp array
from `[1_000, 1_000, 1_600]` to `[1_000, 1_000, 1_000, 1_000, 1_000, 1_600]` (three extra
`1_000`s for the heartbeat's calls) and updated its comment to explain the new call count.
No assertions in that test changed — only the mock's input sequence, to keep the same
600ms-elapsed-on-plan behavior the test was already asserting. Verified in isolation
(`... --run tests/controller/runLoop.integration.test.ts`, 46/46 green) and as part of the
full suite.

## Files changed

- `src/controller/runLoop.ts` — heartbeat start/stop in `runLoop`; `INERT_LEASE_HEARTBEAT`
  constant and 5th parameter + `affirmNow()` call in `runLoopFromState`.
- `src/controller/resumeLoop.ts` — heartbeat start/stop in `resumeLoop`, wrapping
  `cleanupResidualWorktrees` and the `runLoopFromState` call in `try/finally`.
- `tests/controller/leaseLifecycle.integration.test.ts` (new) — the brief's three tests, plus
  the five helper functions (`createRepo`, `createContract`, `seedEligibleRun`,
  `successFrame`, `readEventTypes`) copied from `tests/controller/resumeLoop.integration.test.ts`,
  matching this project's per-file-helper-copy convention.
- `tests/controller/runLoop.integration.test.ts` — extended one test's `Date.now()` mock
  sequence to account for the heartbeat's three additional calls (see above); no other
  changes.

## Self-review

- **Completeness**: all 7 brief steps done — tests written, RED confirmed for the documented
  (wrong) reason, both controllers wired, full suite + typecheck + build green, committed.
- **Quality/style**: two-space indent, double quotes, `.js` extensions on relative imports, no
  default exports — matches surrounding code. Comments added are `§`-anchored like the rest
  of the codebase's spec-referencing comment style.
- **YAGNI**: no speculative additions. `INERT_LEASE_HEARTBEAT` is exactly what the brief
  specifies, nothing more. Did not touch `assertHeld` wiring (not part of this task; that's
  a later task per the brief's own note that `affirmNow()` "is required by Task 13").
- **Testing discipline**: TDD order followed (test written first, RED observed for the
  brief's documented reason, then implementation). Verified the GREEN state is genuine, not
  vacuous, via a deliberate temporary regression (removing `stop()`) rather than trusting the
  first green run — this is the check the brief's own framing (§6.0 requirement 17) calls
  for. No skipped tests, no pristine-output violations.
- **Scope**: touched exactly the files the brief named, plus one additional test file fix
  required to keep the suite green (explained above, not silently done — flagged here per
  Rule 12 / fail loud).

## Concerns

None blocking. The one thing worth flagging explicitly (also called out above under
"unplanned but necessary fix"): the `runLoop.integration.test.ts` change was not in the
brief's file list. I judged it necessary and in-scope under the global constraint that the
suite must stay green, kept the change minimal (only the mock's input array and its
explanatory comment), and did not touch that test's assertions. Flagging for visibility
rather than treating it as self-evidently fine.
