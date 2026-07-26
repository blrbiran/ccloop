# Task 10 Report: `assertHeld` — un-throttled, fail-closed

## Summary

Implemented `assertHeld()` in `src/controller/leaseHeartbeat.ts` exactly per the brief: a bounded-retry, uncached, unthrottled re-read of the owner record before every side effect. It resolves when the record still names this process at the expected epoch, rejects with `RunLeaseLostError` (`stopReason: "lease_lost"`) on a clean read naming someone else, and rejects with `RunLeaseUnverifiableError` (`stopReason: "lease_unverifiable"`) when the record cannot be read/validated after `LEASE_VERIFY_READ_ATTEMPTS` attempts spaced `LEASE_VERIFY_RETRY_DELAY_MS` apart.

No deviation from the brief's test bodies or implementation code was needed — copied verbatim.

## Files changed

- `src/controller/leaseHeartbeat.ts` — imports extended with `LEASE_VERIFY_READ_ATTEMPTS`, `LEASE_VERIFY_RETRY_DELAY_MS`, `parseOwnerRecordForLease`, `RunLeaseUnverifiableError`; the `assertHeld` stub replaced with the brief's implementation (retry loop, reuses `namesSomeoneElse`, sets `superseded = true` on a confirmed loss, fails closed on unverifiable reads).
- `tests/controller/leaseHeartbeat.test.ts` — appended a new top-level `describe("assertHeld", ...)` (sibling to, not nested inside, `describe("startLeaseHeartbeat", ...)`) with the brief's four tests verbatim.

## TDD evidence

**RED** — `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts -t "assertHeld"` against the Task 9 stub (`assertHeld` resolves unconditionally):

```
 ❯ tests/controller/leaseHeartbeat.test.ts (12 tests | 3 failed | 8 skipped) 13ms
   × assertHeld > is never throttled: a record rotated between two close side effects blocks the second
     → promise resolved "undefined" instead of rejecting
   × assertHeld > rejects as unverifiable — not as lost — when the record cannot be read
     → promise resolved "undefined" instead of rejecting
   × assertHeld > rejects as unverifiable when the record is structurally invalid
     → promise resolved "undefined" instead of rejecting
 Test Files  1 failed (1)
      Tests  3 failed | 1 passed | 8 skipped (12)
```

The 4 new tests report as "12 tests" total with only 3 failing because the fourth new test ("proceeds when a transient read failure clears within the retry budget") asserts `resolves.toBeUndefined()`, which the unconditionally-resolving stub also happens to satisfy — expected: that test can't distinguish the stub from a real implementation, only the other three can. This matches the brief's stated expectation ("FAIL — the stub resolves unconditionally") for the round.

**GREEN** — `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts` after implementing:

```
 ✓ tests/controller/leaseHeartbeat.test.ts (12 tests) 306ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

**Full suite** — `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`:

```
 Test Files  22 passed (22)
      Tests  337 passed (337)
```

22 files / 337 tests (baseline was 22 files / 333 tests; +4 new assertHeld tests, no regressions, no skips).

**Typecheck** — `npm run typecheck`: clean, no output beyond the `tsc --noEmit` invocation.

**Build** — `npm run build`: clean.

No unhandled rejection warnings or other stderr noise observed in any of the above runs (checked explicitly via `grep -iE "unhandled|warning|deprecat"` on the focused test output — no matches).

## Timer note

Followed the brief's instruction: the new `describe("assertHeld", ...)` is a sibling of `describe("startLeaseHeartbeat", ...)`, not nested inside it, so it does not inherit that describe's `beforeEach(() => vi.useFakeTimers())`. The first assertHeld test installs fake timers itself (`vi.useFakeTimers()` / `vi.setSystemTime(...)`) and tears them down at the end (`vi.useRealTimers()`); the other three tests (including the transient-failure-clears-in-real-time one) run under Vitest's default real timers. No fake/real timer interaction problems were encountered — the transient-failure test's `setTimeout(..., 10)` racing against `assertHeld`'s real `LEASE_VERIFY_RETRY_DELAY_MS` (50ms) delay behaved as the brief's code assumes.

## Self-review

- **Un-throttled**: confirmed by the first test — two `assertHeld()` calls 100ms apart (well inside `LEASE_AFFIRM_THROTTLE_MS` = 10,000ms) both perform a fresh read; the second correctly observes the rotated record and rejects. `assertHeld` reads via `readOwnerRecordWithoutRecovery` directly, with no throttle check and no cached `expected` short-circuit before the read (it only compares against `expected` via `namesSomeoneElse` after reading fresh).
- **Fail-closed**: an unparseable record and a structurally invalid record both retry up to `LEASE_VERIFY_READ_ATTEMPTS` times and then reject `lease_unverifiable` rather than resolving — verified by the two corresponding tests.
- **Criterion reuse**: `assertHeld` calls the same `namesSomeoneElse` closure the heartbeat's `runAffirm`/`concludeLeaseLost` path uses — no second criterion was written.
- **Side effects on rejection**: on a confirmed `lease_lost`, `assertHeld` sets the shared `superseded` flag (so subsequent `runAffirm` ticks become no-ops) but, per the brief's code, does not call `appendEvent`/`onLeaseLost` itself — that remains `concludeLeaseLost`'s job on the heartbeat's own affirm path. `assertHeld` is a synchronous-to-its-caller check; the caller (a later task, presumably the run controller) is expected to act on the thrown error. This is exactly what the brief specified, not an omission I introduced.
- **YAGNI**: no extra abstraction added beyond the brief's `delay` helper, which is scoped locally inside `startLeaseHeartbeat` and used only by `assertHeld`.
- **Style**: two-space indent, double quotes, `.js` extensions on the relative import — matches existing file conventions, no reformatting of untouched code.

No concerns to flag. Task complete as specified.

## Fix round: strengthen the "never throttled" test (review finding)

Review found the "never throttled" test only caught a throttle-reuse bug shaped as "assertHeld primes its own `lastAffirmAtMs`", not the more natural shape "assertHeld consults the periodic heartbeat's existing `lastAffirmAtMs`". In the original test, `lastAffirmAtMs` was never set (no affirm had ever landed, so it stayed at its `Number.NEGATIVE_INFINITY` default), so `now() - lastAffirmAtMs` was always `Infinity` — never `< LEASE_AFFIRM_THROTTLE_MS` — so a buggy `assertHeld` that checked the shared throttle state would never short-circuit in that test and the test would pass regardless.

### What changed

`tests/controller/leaseHeartbeat.test.ts`, the "is never throttled" test only: added `await heartbeat.affirmNow();` immediately after constructing the heartbeat, before the first `assertHeld()` call, so `lastAffirmAtMs` holds a recent real timestamp — the state a long-running process's heartbeat is actually in — before the two close-together `assertHeld()` calls run. Updated the test's leading comment to explain why the prime is there. No other test in the file was touched, and the other three `assertHeld` tests were re-run unchanged to confirm they still pass.

### Covering test

`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts`

### Commands and output

**Strengthened test against the correct implementation (must pass):**

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts
 ✓ tests/controller/leaseHeartbeat.test.ts (12 tests) 292ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

**Mutation check — bug added to `assertHeld`:**

```ts
const assertHeld = async (): Promise<void> => {
  if (now() - lastAffirmAtMs < LEASE_AFFIRM_THROTTLE_MS) { return; } // TEMP MUTATION FOR REVIEW EVIDENCE
  let lastError: unknown;
  ...
```

Strengthened test file, with the bug in place:

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts
 ❯ tests/controller/leaseHeartbeat.test.ts (12 tests | 4 failed) 15048ms
   × assertHeld > is never throttled: a record rotated between two close side effects blocks the second 5ms
     → promise resolved "undefined" instead of rejecting
   × assertHeld > rejects as unverifiable — not as lost — when the record cannot be read 5005ms
     → Test timed out in 5000ms.
   × assertHeld > rejects as unverifiable when the record is structurally invalid 5005ms
     → Test timed out in 5000ms.
   × assertHeld > proceeds when a transient read failure clears within the retry budget 5005ms
     → Test timed out in 5000ms.
 Test Files  1 failed (1)
      Tests  4 failed | 8 passed (12)
```

The target test fails exactly as the finding predicted: the second `assertHeld()` call resolves instead of rejecting, because `lastAffirmAtMs` was freshly primed by `affirmNow()` and the mutated code short-circuits on it. The three subsequent timeouts are a side effect specific to this failure mode, not new evidence: the first test's `rejects.toMatchObject` assertion throws synchronously when it doesn't reject, which skips that test's own `vi.useRealTimers()` cleanup, leaving fake timers installed for the tests that run after it in file order — those tests then hang waiting on real `setTimeout`s that fake time never advances. This is purely a test-isolation artifact of stopping the file mid-mutation; it does not occur with the real implementation (see the "after removing the mutation" run below) and does not weaken the evidence that the target test itself fails against the bug.

**Mutation check — same bug, old (pre-strengthening) test:**

Extracted the previously-committed test file (`git show <task-10-commit>:tests/controller/leaseHeartbeat.test.ts`) and ran only its "is never throttled" test with the same mutation still in place:

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts -t "is never throttled"
 ✓ tests/controller/leaseHeartbeat.test.ts (12 tests | 11 skipped) 6ms
 Test Files  1 passed (1)
      Tests  1 passed | 11 skipped (12)
```

Confirmed: the old test passes against the exact same mutation the strengthened test catches — direct evidence the strengthening was necessary, not just plausible. (`lastAffirmAtMs` is never primed in the old test, so `now() - (-Infinity)` never falls under the throttle threshold and the mutated `assertHeld` behaves identically to the correct one for that test's purposes.)

**Mutation removed, both files restored:**

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts
 ✓ tests/controller/leaseHeartbeat.test.ts (12 tests) 313ms
 Test Files  1 passed (1)
      Tests  12 passed (12)

$ npm run typecheck
> tsc --noEmit -p tsconfig.json
(clean, no output)
```

`git diff --stat -- src/controller/leaseHeartbeat.ts` confirmed empty after restoring — the mutation left no trace in the committed source; only the test file changed in this fix round.

### Result

Test strengthened, implementation untouched. Full suite was not re-run per the coordinator's reduced verification scope for this fix round (covering file + typecheck only, as instructed).
