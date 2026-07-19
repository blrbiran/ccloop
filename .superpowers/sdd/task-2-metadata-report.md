# Task 2 Metadata Boundary Report

## Scope
Implemented Task 2 in the requested code surface:
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-metadata-boundary/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-metadata-boundary/tests/validation/prepareA04.test.ts`

Also updated OpenWolf project memory files required by the repo workflow:
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-metadata-boundary/.wolf/buglog.json`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-metadata-boundary/.wolf/cerebrum.md`

## Changes made
1. Added focused Task 2 regression tests for the metadata-backed boundary:
   - missing legacy worktree is only a soft signal;
   - missing `usageEvidenceSpec` hard-blocks prepare;
   - insufficient contradiction confirmation hard-blocks prepare;
   - non-distinct backup branch hard-blocks prepare.
2. Replaced the temporary legacy runtime bridge in `validation/v1/lib/a04.ts` with a real metadata-backed inspection implementation:
   - introduced `A04_REQUIRED_METADATA_PATHS`;
   - exported `inspectMetadataBackedA04History(repoRoot)`;
   - read the four required metadata documents directly from the current repo;
   - inspected the retained backup branch with `rev-parse` plus `merge-base`;
   - downgraded retained stashes, legacy evidence worktree, and legacy preserved `.validation-runs/` tree to soft signals only.
3. Added machine-checkable contradiction helpers so the runtime summary now reports structured `CONFIRMED` / `INSUFFICIENT` results instead of relying on ad hoc legacy inspection objects.
4. Added hard-blocker enforcement inside `prepareA04(...)`:
   - every `requiredSources.*` entry must be `PRESENT`;
   - backup branch must remain distinct from `main` and locally reachable;
   - every contradiction check must be `CONFIRMED`;
   - `softSignals` do not block non-paid prepare.
5. Mapped hard-blocker error messages to human-readable labels so the focused tests assert the intended semantics rather than camelCase keys.
6. Self-review confirmed the runtime no longer returns the old `legacyInspection as unknown as ReadOnlyInspection` bridge and no longer hard-depends on preserved legacy evidence paths for blocking behavior.

## Verification
### Focused tests (red)
Command:
```bash
npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/a04-metadata-boundary test -- --run tests/validation/prepareA04.test.ts
```
Initial result: FAIL as expected (`3` new hard-blocker tests failed before the implementation change).

### Focused tests (green)
Command:
```bash
npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/a04-metadata-boundary test -- --run tests/validation/prepareA04.test.ts
```
Final result: PASS (`41/41` tests)

## Commit
- `7082bad` — `feat: add metadata-backed A-04 inspection`

## Self-review
- Verified `defaultInspectReadOnlyInspection(...)` now delegates to `inspectMetadataBackedA04History(...)`.
- Verified runtime blockers are derived from `requiredSources` plus `contradictionChecks`, not legacy worktree/tree presence.
- Verified the fixed A-04 envelope and approval semantics were not changed.
- Verified the new tests cover the intended hard-blocker vs soft-signal split.

## Concern
The implementation is complete for Task 2, but the commit includes `.wolf/buglog.json` and `.wolf/cerebrum.md` alongside the requested code/test files because this repo’s OpenWolf workflow requires those updates when learning/fixing a bug. The post-commit report/anatomy/memory updates are not included in `7082bad`.


## 2026-07-19 Review fix wave
### Follow-up changes
1. Tightened `evaluateContradictions(...)` to match the task brief's required text checks exactly:
   - `historicalA01ToA03Diagnoses` now keys on `"Historical A-01 through A-03 artifacts remain immutable"`.
   - `paidCallStillRequiresExplicitApproval` now keys on the full approved boundary/approval phrases from the brief rather than shortened fragments.
2. Fixed `softSignals.retainedStashes.status` so it reports `PRESENT` only when the filtered retained-stash matches are non-empty; unrelated stashes no longer satisfy the soft signal.
3. Fixed legacy soft-signal paths so `legacyEvidenceWorktree.path` and `legacyPreservedEvidenceTree.path` report the actual discovered worktree location when present.
4. Added direct `inspectMetadataBackedA04History(...)` regressions for the exact contradiction strings, unrelated-stash handling, and discovered legacy worktree paths.

### Focused verification
Command:
```bash
npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/a04-metadata-boundary test -- --run tests/validation/prepareA04.test.ts
```
Result: PASS (`44/44` tests)


## 2026-07-19 Final review edge-case fix
### Follow-up changes
1. Changed required metadata reads in `validation/v1/lib/a04.ts` to classify files that exist but cannot be read as `UNREADABLE` in the machine-checkable summary contract instead of throwing raw filesystem errors.
2. Split retained backup-branch inspection into separate signals for branch presence/distinctness vs. `merge-base` reachability, so a present branch with unavailable reachability data now stays `PRESENT` with `mergeBaseWithMain: undefined`.
3. Added focused regressions in `tests/validation/prepareA04.test.ts` for both edge cases:
   - unreadable required metadata document;
   - present backup branch with unreachable `merge-base`.

### Focused verification
Command:
```bash
npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/a04-metadata-boundary test -- --run tests/validation/prepareA04.test.ts
```
Result: PASS (`46/46` tests)
