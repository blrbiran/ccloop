# Final Branch Fix Report — D Scenario Boundary Classification

## Scope
- Implemented only the two final whole-branch review findings.
- Kept product changes limited to `/validation/v1/lib/evidence.ts` and `/src/controller/runLoop.ts` plus focused regressions in the matching test files.

## Fixes

### 1. Raw Layer A contradiction detection for Scenario D
- Updated `hasContradictoryLayerAEvidence(...)` to treat raw Layer A artifact observation as authoritative when checking contradictions.
- Added `hasObservedLayerAArtifact(...)` so contradiction checks treat `execution.json`, `diff.patch`, and `stdout-stderr.log` as observed evidence when the file is physically present even if Scenario D normalization marks the artifact `INVALID` instead of `PRESENT`.
- This closes the review gap where contradictory execute/diff/log evidence could be hidden by Scenario D normalization and incorrectly fall through to `EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE` instead of `BOUNDARY_UNRESOLVED`.
- Added a focused regression proving that a raw Layer A `diff.patch` presence under Scenario D still classifies as `BOUNDARY_UNRESOLVED`.

### 2. `git status --porcelain=v1 -z` rename/copy parsing
- Removed the physical NUL byte from `parseChangedPathsFromGitStatus(...)` and switched the helper to the escaped delimiter `"\0"`.
- Corrected rename/copy handling so porcelain `-z` records are parsed as `to\0from\0`: the current entry path is kept as the destination path and the following source-path token is skipped.
- Exported the helper and added a small direct regression test covering rename, copy, modified, and quoted-path records.

## Verification
- `ECC_GATEGUARD=off DISABLE_OMC=1 npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification" test -- tests/controller/runLoop.integration.test.ts`
  - PASS (`35 passed`)
- `ECC_GATEGUARD=off DISABLE_OMC=1 npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification" test -- tests/validation/evidence.test.ts`
  - PASS (`33 passed`)
- `ECC_GATEGUARD=off DISABLE_OMC=1 npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification" test`
  - PASS (`14 files, 193 tests passed`)

## Notes
- I did not reopen unrelated branch surfaces.
- `.superpowers/sdd/progress.md` had unrelated pre-existing modifications and was intentionally left out of the scoped fix set.


## Follow-up Fixes

### 3. `execution-recovery.json` contradiction handling in Scenario D
- Strengthened `hasContradictoryLayerAEvidence(...)` so controller-owned `execution-recovery.json` counts as Layer A boundary evidence alongside raw execute/diff/log observation.
- This now forces `BOUNDARY_UNRESOLVED` when recovery evidence exists without `attempt_started`, or with `attempt_started` but without `execute_started`, keeping those event-chain contradictions out of `EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE`.
- Added two focused regressions covering both recovery-backed contradiction shapes.

### 4. README historical reclassification example
- Added a concise operator-facing `finalize-review.ts` example for historical D reclassification.
- Documented the explicit `--reclassify-from` flow and that it writes `review-reclassified.json` instead of overwriting `review.json`.

## Verification (follow-up)
- `ECC_GATEGUARD=off DISABLE_OMC=1 npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification" test -- tests/validation/evidence.test.ts`
  - PASS (`35 passed`)
- `ECC_GATEGUARD=off DISABLE_OMC=1 npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification" test`
  - PASS (`14 files, 195 tests passed`)

## Self-review (follow-up)
- Scope stayed limited to the D classifier contradiction matrix, focused validation regressions, the requested README example, and required bookkeeping/report files.
- I did not change A/B/C/E rules, budgets, retry policy, or review immutability semantics.
