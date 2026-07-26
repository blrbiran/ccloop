# Task 4 Report: `fileStore` — raw read, CAS affirm, CAS release

## Summary

Implemented exactly what the brief specified, in the brief's TDD order:

1. `readOwnerRecordWithoutRecovery(runDir)` — thin wrapper over the existing (unexported)
   `readOwnerRecordRaw`, with no call to `recoverInterruptedOwnerTransfer`. Used by the
   acquisition gate so a refusal never triggers crash recovery as a side effect.
2. `affirmOwnerLease(runDir, expected, nowIso)` — CAS write under the existing owner-transfer
   lock. Advances `leaseAffirmedAt` and `lastAffirmedAt` to `nowIso`, leaves every other field
   untouched, and returns the record it just wrote (the caller's next `expected`).
3. `releaseOwnerLease(runDir, expected)` — CAS write that sets `leaseAffirmedAt: null` and
   leaves every other field alone; throws `OwnerTransferPreconditionError` on mismatch.

Both CAS writers share a new private helper, `updateOwnerRecordWithPrecondition`, which
acquires the lock, runs `recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })`, reads
the persisted record via `readOwnerRecordRaw`, compares it to `expected` via `sameOwnerRecord`,
and — on match — builds the next record by spreading the **persisted** record (never `expected`,
never a fresh literal), writes it atomically, and returns it.

Also extracted `writeOwnerRecordAtomically(runDir, ownerRecord)` (unlink temp, write temp,
rename) and used it both in the new helper and to replace the four-line write tail of
`claimOwnerRecordWithPrecondition`, keeping that function's CAS mismatch message
(`"persisted owner record changed before resume could claim it"`) verbatim.

## Files changed

- `src/persistence/fileStore.ts` — added `readOwnerRecordWithoutRecovery`,
  `writeOwnerRecordAtomically`, `updateOwnerRecordWithPrecondition`, `affirmOwnerLease`,
  `releaseOwnerLease`; refactored the tail of `claimOwnerRecordWithPrecondition` to call
  `writeOwnerRecordAtomically`. No other function touched. `acquireOwnerTransferLock`,
  `parsePid`, and the lock record format are unmodified.
- `tests/persistence/leaseStore.test.ts` — new, copied verbatim from the brief (9 tests
  across `affirmOwnerLease`, `releaseOwnerLease`, `readOwnerRecordWithoutRecovery`).

## TDD evidence

**RED** — `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/persistence/leaseStore.test.ts`
run against the test file with none of the three functions yet implemented/exported:

```
FAIL  tests/persistence/leaseStore.test.ts > affirmOwnerLease > ... (5 tests)
  TypeError: affirmOwnerLease is not a function
FAIL  tests/persistence/leaseStore.test.ts > releaseOwnerLease > clears only leaseAffirmedAt
  TypeError: releaseOwnerLease is not a function
FAIL  tests/persistence/leaseStore.test.ts > releaseOwnerLease > refuses to clear a lease ...
  TypeError: releaseOwnerLease is not a function
FAIL  tests/persistence/leaseStore.test.ts > readOwnerRecordWithoutRecovery > ... (2 tests)
  TypeError: readOwnerRecordWithoutRecovery is not a function

Test Files  1 failed (1)
     Tests  9 failed (9)
```

This is the expected failure: the module under test didn't export those three names yet, so
every test that calls them threw a `TypeError` at the call site — not an assertion failure,
confirming the tests were exercising real missing code, not a typo in the test file.

**GREEN** — after implementing, ran the exact command from Step 4:
`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/persistence/leaseStore.test.ts tests/persistence/fileStore.test.ts`

```
✓ tests/persistence/leaseStore.test.ts (9 tests) 17ms
✓ tests/persistence/fileStore.test.ts (36 tests) 76ms

Test Files  2 passed (2)
     Tests  45 passed (45)
```

**Full suite** — `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`:

```
Test Files  20 passed (20)
     Tests  301 passed (301)
```

(Baseline was 19 files / 292 tests; this task adds exactly 1 file / 9 tests, landing at
20/301 — no other test's outcome changed.)

**Typecheck** — `npm run typecheck` → clean, no output beyond the `tsc --noEmit` invocation.

**Build** — `npm run build` → clean, no errors.

## Confirming the `claimOwnerRecordWithPrecondition` refactor is behavior-preserving

- The refactor is a pure extract-method: the four lines
  (`getOwnerTransferPaths` destructure → `safeUnlink` temp → `writeJsonFile` temp → `rename`
  temp to final) were lifted verbatim into `writeOwnerRecordAtomically(runDir, ownerRecord)`
  and the call site replaced with a single call to that helper. No control flow, ordering, or
  argument changed.
- The CAS mismatch throw (`OwnerTransferPreconditionError("persisted owner record changed
  before resume could claim it")`) is untouched — still the exact string from before the
  change, still thrown from the same place before the write helper is ever called.
- Verified with `git diff src/persistence/fileStore.ts`: the diff on
  `claimOwnerRecordWithPrecondition` is only the four lines replaced by one call; everything
  else in the function (lock acquire/release, `recoverInterruptedOwnerTransfer` call,
  `readOwnerRecordRaw`, `sameOwnerRecord` check) is unchanged.
- Ran the full pre-existing `tests/persistence/fileStore.test.ts` (36 tests, unmodified) both
  standalone and as part of the full 301-test suite; all 36 pass, including its own coverage
  of `claimOwnerRecordWithPrecondition`'s success and CAS-mismatch paths. Since that test file
  was not touched, this is strong evidence the refactor did not change observable behavior.

## Self-review

- **Completeness**: all three exports implemented exactly as specified in the brief; the
  `claimOwnerRecordWithPrecondition` refactor was done and verified.
- **Quality / YAGNI**: no code beyond what the brief specified. The shared
  `updateOwnerRecordWithPrecondition` helper is the brief's own design (its exact signature
  and body), not an invention — it's the natural common path between affirm and release and
  was requested implicitly by "reuse the shared write helper" language in the task instructions.
- **Discipline**: did not modify `acquireOwnerTransferLock`, `parsePid`, or the lock record
  shape (constraint 3). Did not add recovery to the new raw read, did not remove it from
  `readOwnerRecord` (constraint / "why" section). `buildNext` closures spread `persisted`, not
  `expected` or a fresh literal, preserving key order for the `sameOwnerRecord` JSON-string
  comparison, including for legacy records missing `leaseAffirmedAt`.
- **Testing**: test file copied verbatim from the brief per TDD-first instructions; confirmed
  RED before implementing, confirmed GREEN after. No test skipped, no `.only`/`.skip` left
  behind. Output pristine (no console noise, no warnings) in both the focused and full-suite
  runs.
- **Style**: two-space indent, double quotes, `.js` extensions on relative imports (test file
  imports `../../src/persistence/fileStore.js` and `../../src/runtime/types.js`), no default
  exports — matches existing file conventions.

## Concerns

None. The implementation matches the brief's code block verbatim (function bodies, comments,
error messages), and all verification steps (focused tests, full suite, typecheck, build) are
green.
