# SDD ledger — plan: docs/superpowers/plans/2026-07-28-run-registry.md

Branch: worktree-l2-run-registry
Worktree: .claude/worktrees/l2-run-registry
Baseline: 23 files / 373 tests green at 47e2b49

Pre-flight scan (before Task 1): two defects found in the plan itself, both fixed by the controller before dispatch —
- Task 1 test requirements 4/5 did not kill the implementation they named; rewritten around per-field vs per-file granularity.
- Global Constraint 4 contradicted Task 6 file list; amended to allow tests/cli/cli.test.ts.

Task 1: complete (commits a1e82c6..674d313, review clean — spec ✅, quality approved)
Task 1: minor (deferred): number/integer checks accept NaN/Infinity; unreachable via JSON.parse, not requested by brief.
Task 1: minor (deferred): implementer wrote implementation before tests, then reconstructed the red state by moving src/registry/ aside. Disclosed; shipped code unaffected.
Task 2: complete (commits 674d313..ef65e97, review clean — spec ✅, quality approved)
Task 2: minor (deferred): ObservedFileSpec.file is `string`, not a literal union of the three filenames, so pickReader's default branch is a runtime guard rather than provably unreachable. Owned by Task 1's type; do not fix inside Task 2's scope.
Task 2: controller resolved reviewer's 2 unverifiable items — (a) "does Task 3 only pass OBSERVED_FILES specs" is mandated by the plan and carried into Task 3's dispatch; (b) real-filesystem torn-read behavior is Task 5's job.
Task 3: complete (commits ef65e97..e688e90, review clean — spec ✅, quality approved, zero findings)
Task 3: implementer correctly flagged that `kind` appears in the brief but not spec §6; reviewer confirmed it is a structural discriminant, not a derived judgment. Kept.
Task 3: controller resolved 2 forward-looking items — schemaVersion is Task 6's ScanResult (its req 4 asserts it); `kind` does not collide with Task 6 req 1's forbidden key set (resumable/fresh/stale/expired, and eligible-* except eligibleForContinuation).
Task 4: complete (commits e688e90..84b7a83, review clean — spec ✅, quality approved, zero findings)
Task 4: controller resolved reviewer's unverifiable item — defaultScanDeps' real node:fs wiring (dirent -> isDirectory/isSymbolicLink mapping) is unexercised; all traversal proofs are against the injected fake. Routed into Task 5 as an added requirement (real-filesystem symlink assertion), since Task 5 is the only task that runs defaultScanDeps against real disk.
Task 5: complete (commits 84b7a83..534b3ad, review clean — spec ✅, quality approved)
Task 5: minor (deferred): zeroWrite fixture's run-nested is itself recognized at depth 1, so scanDir returns before reading worktrees/attempt-1/ — the inner file is untouched because unreached, not because a recursive read-then-no-write path was exercised. Real deeper recursion coverage comes from run-with-symlink instead. Cosmetic; fix the comment if the file is touched again.
Task 5: load-bearing assertion IS committed (zeroWrite.test.ts:187), not merely narrated — readOwnerRecord against the fixture is asserted to delete the 3 staging files and flip owner epoch 1->2.
Task 6: complete (commits 534b3ad..f5cbd97, review clean — spec ✅, quality approved)
Task 6: minor (deferred): scanRootFailureDetail lives in renderRuns.ts, which neither renders nor serializes it. Placement/naming mismatch only; scanRuns.ts was off-limits and inlining in cli.ts would violate spec §10. Cosmetic.
Task 6: controller correction — BOTH the implementer and the reviewer misexplained the "baseline 23 files/373 tests" line. It is not a stale doc and is not "pre-existing unrelated suites": 373 is the pre-Task-1 baseline, and 373+13+6+4+9+2 = 407 after Task 5, +17 in Task 6 = 424. Fully self-consistent.

ALL 6 TASKS COMPLETE. Full suite 29 files / 424 tests; typecheck clean; build clean.
Deferred minors for the final review to triage: Task 1 (x2), Task 2 (x1), Task 5 (x1), Task 6 (x1). No parked findings, no BLOCKED entries, no fix rounds were needed on any task.

FINAL WHOLE-BRANCH REVIEW (opus, 7 commits 47e2b49..f5cbd97): "Ready to merge: with one fix."
- IMPORTANT 1: renderRuns.test.ts:90-107 no-derivation guard walks hand-authored literals, not production output. An OPTIONAL derived field added to RunObservation would ship undetected. Spec §15 #3 claims this property is test-enforced; today it is fixture-enforced. -> FIX WAVE.
- MINOR 2: cli.ts:47-48 `ls --json <root>` misparsed; root read from argv[1], --json only searched in argv.slice(2). -> FIX WAVE.
- MINOR 3: scanRuns.ts:47-51 no fallback for dirent DT_UNKNOWN; both isDirectory() and isSymbolicLink() false -> every child skipped -> zero rows, NO issue row. Silent short list. Not reproducible on APFS/ext4. -> FIX WAVE.
- MINOR 5: output has no caveat that eligibleForContinuation is observed, not permission. -> FIX WAVE (one string).
- MINOR 4: scanRootFailureDetail placement. -> DEFERRED (cosmetic).
- MINOR 6: ledger artifacts committed inconsistently vs L1/L1b precedent. -> controller's own bookkeeping, handled at finish.
Reviewer triaged all 5 pre-existing deferred minors as safe to defer, and corrected the Task 5 ledger note: run-with-symlink does NOT provide deeper recursion coverage either (its only entry is skipped); real coverage comes from the four depth-1 runs.
Verified independently by the final reviewer: 424 tests pass, typecheck clean, build clean, and zero-write holds through the real main(["ls",...]) path, not only through scanRuns.
