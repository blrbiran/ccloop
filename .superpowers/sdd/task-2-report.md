# Task 2 Report — A-04 mechanical preflight helper and CLI

## What you implemented
- Added `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` with:
  - `A04PrepareOptions`, `ApprovalPackage`, and injectable `PrepareDeps`
  - `buildA04RunCommand(...)` matching the current `run-scenario.ts` CLI shape
  - `buildApprovalPackage(...)` freezing contract identity, execution policy, file/diff scope, run command shape, usage-evidence expectations, and invariants
  - `prepareA04(...)` orchestration that asserts fixture cleanliness, runs deterministic preflight commands, checks freshness for contract/run/evidence paths, writes the frozen contract, and returns the approval package plus preflight command list
  - default contract writing via `renderScenario("A", { repoPath, executionPolicyOverrides })` parsed by `loopContractSchema`
- Added `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/scripts/prepare-a04.ts` CLI with the required flags for fixture/contract/run/evidence/adapter paths and the four approved execution-policy override fields.
- Added `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` to lock:
  - approval-package contents
  - deterministic preflight command order
  - current `run-scenario.ts` command shape
  - refusal behavior when run/evidence paths already exist
  - CLI stdout-only approval-package behavior without invoking any paid run path

## What you tested and results
- Focused RED test:
  - `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/prepareA04.test.ts`
  - Result: failed as expected before implementation because `../../validation/v1/lib/a04.js` did not exist.
- Focused GREEN validation:
  - `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts`
  - Result: passed, 21 tests green.
- Full verification before commit:
  - `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test`
  - `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck`
  - `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run build`
  - Result: all passed (`124` tests green, typecheck green, build green).

## TDD Evidence
### RED
- Command:
  - `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/prepareA04.test.ts`
- Relevant failing output:
  - `Error: Failed to load url ../../validation/v1/lib/a04.js ... Does the file exist?`
- Why failure was expected:
  - Task 2 started from tests first, and the helper/CLI module had not been created yet.

### GREEN
- Command:
  - `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts`
- Relevant passing output:
  - `Test Files  2 passed (2)`
  - `Tests  21 passed (21)`

## Files changed
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/scripts/prepare-a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/anatomy.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/buglog.json`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/cerebrum.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`

## Self-review findings
- The implementation preserves the resolved spec order by running deterministic verification before freshness checks.
- The helper does not create `runDir` or `evidenceDir`; only the contract parent directory is created for the frozen contract file.
- The CLI prints approval package JSON only and does not call `run-scenario.ts`.
- Only the four approved execution-policy override fields flow through this Task 2 path.
- The commit staged only the three task implementation files; pre-existing unstaged changes in `.wolf/cerebrum.md` and `package-lock.json` were left uncommitted.
- One follow-up note: OpenWolf metadata/report updates were intentionally left uncommitted because the user explicitly warned about pre-existing unstaged changes in `.wolf/cerebrum.md`; these files remain local worktree edits after the task commit.

## Any issues or concerns
- The worktree still has unrelated pre-existing unstaged changes in `.superpowers/sdd/progress.md`, `.wolf/cerebrum.md`, `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, and `package-lock.json`; they were not included in the Task 2 commit.
- A background self-review agent was started after implementation; its result was not yet available at the moment this report was written.


## Review Fix Follow-up — 2026-07-18
### What changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` to enforce the fixed A-04 execution-policy envelope (`550000 / 600000 / 1200000 / 5000`) through a shared runtime validator used by `prepareA04`, the CLI, and approval-package construction.
- Added tracked repo-root cleanliness checks around deterministic preflight in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`, so `mainCheckoutMustRemainUnchanged: true` is now backed by a real before/after git-status invariant on the main checkout.
- Expanded `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` with focused regression coverage for:
  - contract path refusal
  - evidence path refusal
  - non-A-04 execution-policy rejection
  - repo-root dirty-before-preflight rejection
  - repo-root dirty-after-preflight rejection
  - approval-package rejection if a non-A-04 contract somehow reaches the builder
- Updated OpenWolf follow-ups in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/anatomy.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/cerebrum.md`, and `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/buglog.json`.

### Exact test commands
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run build`

### Relevant output
- Focused tests:
  - `Test Files  2 passed (2)`
  - `Tests  28 passed (28)`
- Typecheck:
  - `tsc --noEmit -p tsconfig.json`
- Build:
  - `tsc -p tsconfig.json`
  - dist CLI wrapper regenerated successfully.

### Files changed for the review fix
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/scripts/prepare-a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/anatomy.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/cerebrum.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/buglog.json`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`

### Concerns
- The target worktree still contains unrelated pre-existing unstaged changes in `.superpowers/sdd/progress.md`, `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, and `package-lock.json`; they were intentionally excluded from the review-fix commit.
