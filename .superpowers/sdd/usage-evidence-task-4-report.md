# Usage Evidence Task 4 Report

## Status
- Status: DONE
- Progress commit: `fcb91d47e3dcf11a427dd78cbf2b5efaba21f53b`
- Report commit status: not committed intentionally; kept out of the validation commit so only `.superpowers/sdd/progress.md` was staged.

## Commands And Actual Output Summary
- Command: `npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1 test`
- Result: PASS. Vitest reported `Test Files  13 passed (13)` and `Tests  113 passed (113)`. No real Claude call occurred; the added Claude-path tests use fake executables on PATH.
- Command: `npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1 run typecheck`
- Result: PASS. `tsc --noEmit -p tsconfig.json` completed successfully.
- Command: `npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1 run build`
- Result: PASS. `tsc -p tsconfig.json` and the CLI wrapper generation completed successfully.
- Command: `rg -n "DO_NOT_PERSIST|secretSentinel|unknown_usage|cache_creation_input_tokens" /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/src /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/scripts`
- Result: PASS. No output.
- Command: `git -C /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1 diff --check`
- Result: PASS. No output.
- Command: `git -C /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1 status --short`
- Result: Observed pre-existing unrelated modified/untracked files such as `.superpowers/sdd/task-2-report.md`, `.superpowers/sdd/task-4-report.md`, `.wolf/cerebrum.md`, multiple untracked brief/report/docs files, and `dist/`. They were preserved and not broadly staged or cleaned.
- Command: `node -e "JSON.parse(require('fs').readFileSync('/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/.wolf/buglog.json','utf8')); console.log('buglog valid')"`
- Result: PASS. Output was `buglog valid`.
- Command: `git -C /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1 commit -m "docs: record Claude usage evidence validation"`
- Result: PASS. Created commit `fcb91d47e3dcf11a427dd78cbf2b5efaba21f53b`.

## Privacy And Scope Status
- Privacy grep status: clean in `src/` and `scripts/`; no forbidden sentinel strings were found.
- Scope status: validation commit staged only `.superpowers/sdd/progress.md`.
- Real Claude status: no real Claude model call was run.
- A-04 status: unapproved and unrun.

## Durable Progress Update
- Appended to `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/.superpowers/sdd/progress.md`:
  - `Claude usage evidence: complete (commits 65aaf8b..675fee3; whitelisted phase evidence + fake-Claude controller accounting; 58 focused/113 full tests; typecheck/build pass; no real Claude call; A-04 unapproved and unrun)`

## Concerns
- The worktree still contains unrelated dirty tracked/untracked material outside this task; it was intentionally left untouched.
- A-04 remains blocked. Any future run needs fresh contract/run/evidence paths, explicit budgets, and explicit approval before any paid call.

## Follow-up Docs Checkpoint
- Follow-up docs commit title: `docs: append Task 4 checkpoint`.
- Follow-up docs commit SHA: `73fa00ed95c53337224be592bf203a892d713fdf`.
- 2026-07-18 follow-up docs commit appends the required `.wolf/memory.md` checkpoint for the deterministic gate result: 13 files / 113 tests, typecheck/build pass, privacy clean, no real Claude, and A-04 still unapproved/unrun.
- Scope note: this follow-up is limited to the checkpoint append plus this report note; other dirty metadata remains excluded.

## Historical backup integration (Codex controller, 2026-10-10)
The preceding six appended lines are copied byte-for-byte from the historical backup branch. They describe July evidence, not a new test run. The backup contains no product delta from its merge base; main already keeps OpenWolf memory untracked. The two historical commits remain recoverable through archive/evidence-first-v1-20261010. This append preserves all unique report text without bringing obsolete memory files back.
