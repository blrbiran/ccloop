# Task 5 Report: `leaseFresh` becomes a required input to `evaluateOwnership`

## Status: DONE

## What was implemented

1. **`src/state/types.ts`** — added required field `leaseFresh: boolean | "unknown"` to
   `OwnershipEvaluationInput`, with the §9 comment explaining why it's required rather than
   optional-with-a-default.

2. **`src/ownership/ownerController.ts`** — renamed the existing exported `evaluateOwnership`
   to a private `evaluateOwnershipWithoutLease`, changing only the `export function` →
   `function` keyword and the name on that one line; the body is byte-for-byte unchanged.
   Added a new exported `evaluateOwnership` that calls `evaluateOwnershipWithoutLease` and
   then applies the live-lease rule afterward:
   - if `leaseFresh !== true`, return the inner evaluation unchanged
   - if the inner verdict isn't `OWNER_LOST` and takeover wasn't already allowed, return
     unchanged (no upgrade case exists, so this is effectively "only OWNER_LOST/takeoverAllowed
     paths get touched")
   - otherwise downgrade to `OWNER_UNDECIDABLE`, append the reason
     `"a live run lease contradicts owner loss"`, and force `takeoverAllowed: false`

3. **`src/controller/runLoop.ts`** — the single production construction site
   (`evaluateOwnershipFor` inside `persistBoundaryAnalysis`) now passes `leaseFresh: "unknown"`
   with the §9.1 comment noting no production supplier exists yet in L1.

4. **`tests/ownership/ownerController.test.ts`** — added `leaseFresh: "unknown" as const` to
   `baseInput`, and appended the four brief-specified tests: the `it.each([false, "unknown"])`
   regression fence over 9 varied cases, the two OWNER_LOST-blocking tests (direct boundary
   path and persisted-owner-lost path), and the never-upgrades-OWNER_SUPERSEDED test.

All code and test bodies were copied verbatim from the task brief (`task-5-brief.md`), with no
deviation.

## Construction sites

`grep -rln "evaluateOwnership(" --include="*.ts" src tests` found exactly three files:
`src/controller/runLoop.ts`, `src/ownership/ownerController.ts` (definition), and
`tests/ownership/ownerController.test.ts` (tests, updated via `baseInput`).

`npm run typecheck` after adding the required field to the type reported **zero** errors beyond
those already fixed — i.e., `src/controller/runLoop.ts` was the only production construction
site, and it now passes `leaseFresh: "unknown"`. No computed/derived value was introduced
anywhere; every site uses the literal string `"unknown"`.

## TDD evidence

**RED** — `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/ownership/ownerController.test.ts`
(after adding tests, before implementation):
```
✓ tests/ownership/ownerController.test.ts (13 tests | 2 failed)
  × blocks OWNER_LOST and takeover when the lease is fresh
    → expected 'OWNER_LOST' to be 'OWNER_UNDECIDABLE'
  × blocks OWNER_LOST via the persisted-owner-lost path too when the lease is fresh
    → expected 'OWNER_LOST' to be 'OWNER_UNDECIDABLE'
Test Files  1 failed (1)
     Tests  2 failed | 11 passed (13)
```
This is exactly the expected failure mode: `leaseFresh` was accepted at runtime (JS ignores the
extra property) but had no effect yet, so the two fresh-lease tests failed while everything else
(including the new regression-fence test, since `leaseFresh` wasn't consulted at all yet) passed.

**GREEN** — same command after implementation:
```
✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
Test Files  1 passed (1)
     Tests  13 passed (13)
```

**Full suite + typecheck + build**:
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
 Test Files  20 passed (20)
      Tests  306 passed (306)

npm run typecheck   → clean, no output beyond the tsc invocation
npm run build       → clean, no output beyond the build invocation
```
306 = the 301-test baseline + 5 new tests added in this task (1 parameterized fence test runs
twice, plus 3 more standalone tests → 5 net new `it` cases, consistent with the diff).

## Files changed

- `src/state/types.ts`
- `src/ownership/ownerController.ts`
- `src/controller/runLoop.ts`
- `tests/ownership/ownerController.test.ts`

## Self-review

- **Completeness**: all 8 brief steps executed in order (write failing tests → verify RED →
  add field → wrap logic → update production site → typecheck sweep found nothing else →
  full suite green → commit).
- **Structural guarantee honored**: diffed `evaluateOwnershipWithoutLease`'s body against the
  brief's unchanged listing — identical, only the signature line changed (`export function
  evaluateOwnership` → `function evaluateOwnershipWithoutLease`).
- **YAGNI**: no extra helpers, no derived/computed `leaseFresh` value anywhere, no changes
  outside the four listed files.
- **Regression fence integrity**: verified the fence test iterates 9 varied cases × 2 values
  (`false`, `"unknown"`) = 18 equality assertions, all passing, confirming no verdict path
  changes under non-`true` freshness.
- **Style**: two-space indent, double quotes, `.js` extensions on relative imports (untouched,
  pre-existing), no default exports — all consistent with existing file conventions.

## Concerns

None. No ambiguity encountered; the brief's exact code/tests were followed verbatim and all
verification gates passed on the first implementation attempt.
