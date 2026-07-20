# Task 4 Report — Preserve historical reviews and add explicit reclassification output

## Outcome
- Status: DONE
- Scope stayed within Task 4: only `validation/v1/lib/evidence.ts`, `validation/v1/scripts/finalize-review.ts`, `tests/validation/evidence.test.ts`, and required OpenWolf/report metadata were changed.
- Strong spec semantics were implemented: historical `review.json` remains immutable, and reclassification is emitted separately as `review-reclassified.json` with the required metadata.

## What Changed
- Added `ReclassifiedReview` plus schema validation in `/Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification/validation/v1/lib/evidence.ts`.
- Extended `/Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification/validation/v1/scripts/finalize-review.ts` with an explicit reclassification mode:
  - `--reclassify-from <path>`
  - `--boundary-classification <DBoundaryClassification>`
  - `--rule-version <string>`
  - one or more `--evidence-reference <path>`
- In reclassification mode, the CLI now reads and validates the original historical `review.json`, validates the new review payload, and writes `/Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification/.../review-reclassified.json` instead of overwriting `review.json`.
- Preserved the canonical-path entrypoint guard pattern in `finalize-review.ts` so CLI execution remains correct under macOS realpath aliasing.

## TDD Record
1. Added a new RED regression in `/Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification/tests/validation/evidence.test.ts` proving that reclassification must:
   - leave `review.json` untouched;
   - write `review-reclassified.json`; and
   - include `original`, `reclassified`, `boundaryClassification`, `ruleVersion`, and exact Layer A `evidenceReferences`.
2. Ran the focused suite and confirmed failure against the old behavior (`review.json already exists`).
3. Implemented the minimal product changes above.
4. Re-ran the focused suite and confirmed the new test passes.

## Verification
- Focused: `ECC_GATEGUARD=off DISABLE_OMC=1 npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification test -- tests/validation/evidence.test.ts`
  - PASS (`32` tests)
- Full suite: `ECC_GATEGUARD=off DISABLE_OMC=1 npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification test`
  - PASS (`191` tests)
- Typecheck: `ECC_GATEGUARD=off DISABLE_OMC=1 npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification run typecheck`
  - PASS
- Build: `ECC_GATEGUARD=off DISABLE_OMC=1 npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/d-scenario-boundary-classification run build`
  - PASS

## Self-Review
- Confirmed `review.json` overwrite protection is unchanged for normal finalize-review writes.
- Confirmed reclassification requires explicit metadata rather than silently switching on alternate output naming.
- Confirmed the reclassification payload records both original and reclassified review content, matching the approved stronger spec rather than the weaker plain-Review fallback.
- Confirmed no new paid run was introduced.
- Confirmed scope stayed tight to Task 4 behavior.

## Commit
- Created after verification: see git history for the Task 4 commit recorded during completion.

## Concerns
- None.
