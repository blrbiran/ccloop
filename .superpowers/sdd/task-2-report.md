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


## Review Fix Follow-up — 2026-07-18 (one-shot invariant)
### What changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so the approval gate now mechanically enforces the frozen one-shot contract invariants in addition to the four numeric A-04 fields.
- The helper now rejects any drifted Scenario A contract where `autonomyLevel !== "L2"`, `maxAttempts !== 1`, or `worktreeRequired !== true` before approval-package generation.
- Added a focused regression test in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` proving a drifted contract with `maxAttempts: 2` is rejected.

### Exact test command(s)
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/prepareA04.test.ts`

### Relevant output
- `Test Files  1 passed (1)`
- `Tests  13 passed (13)`

### Files changed
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`

### Concerns
- Left the pre-existing unrelated unstaged changes in `.superpowers/sdd/progress.md`, `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, and `package-lock.json` untouched and out of the fix commit.
- `.wolf/memory.md` still contains one historical line with literal `\n` escapes; I left it unchanged to keep this fix scoped to the reviewer finding.


## Final whole-branch review follow-up — 2026-07-18
### What changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` to reject resolved `contractPath` values nested under `runDir` or `evidenceDir`, preventing `defaultWriteContract()` from materializing forbidden pre-approval directories through `mkdir(dirname(contractPath))`.
- Added a final fixture cleanliness gate in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` that records fixture HEAD/status before deterministic preflight and re-checks both immediately before contract creation.
- Switched main-checkout drift detection in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` from tracked-only status to full `git status --porcelain` comparison before and after preflight, so untracked-file drift now rejects approval.
- Expanded `ApprovalPackage` in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` with explicit `workingDirectory`, `paths`, `scenario`, `attempts`, `automaticRetries`, `claudePhases`, `expectedArtifacts`, and `expectedReviewOutputs` fields instead of relying on inference from `exactCommand`.
- Expanded `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` with focused regressions for contract-under-runDir, contract-under-evidenceDir, fixture drift during preflight, untracked main-checkout drift, and the explicit approval-package shape.

### Exact test commands
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/prepareA04.test.ts`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run build`

### Relevant output
- Focused tests:
  - `Test Files  1 passed (1)`
  - `Tests  17 passed (17)`
- Typecheck:
  - `tsc --noEmit -p tsconfig.json`
- Build:
  - `tsc -p tsconfig.json`
  - dist CLI wrapper regenerated successfully.

### Files changed for this follow-up
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/anatomy.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/cerebrum.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/buglog.json`

### Concerns
- Left the pre-existing unrelated unstaged changes in `.superpowers/sdd/progress.md`, `.superpowers/sdd/task-3-report.md`, `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, `package-lock.json`, and `.wolf/memory.md` out of the fix commit.


## Remaining whole-branch review follow-up — 2026-07-18 (main checkout, phase order, Scenario A-only overrides)
### What changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so `prepareA04(...)` now refuses to proceed unless the current checkout branch is `main`, making the approval-package invariant `mainCheckoutMustRemainUnchanged: true` truthful for the verified checkout.
- Refactored `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` to encode the binding-spec order directly: main deterministic verification -> A-04 freshness check -> contract render/validation -> focused evidence-chain regression set -> final pre-approval gate.
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts` so only Scenario A may accept `executionPolicyOverrides`; non-A scenarios now reject that surface at runtime and the TypeScript signature reflects the same constraint.
- Replaced the old Scenario C override-only regression in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts` with non-A rejection coverage, and expanded `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` to lock the new main-branch gate and explicit spec-phase ordering.
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md` so operator docs now state the `main`-checkout requirement and the exact A-04 phase ordering.

### Exact test commands
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run build`

### Relevant output
- Focused tests:
  - `Test Files  2 passed (2)`
  - `Tests  38 passed (38)`
- Typecheck:
  - `tsc --noEmit -p tsconfig.json`
- Build:
  - `tsc -p tsconfig.json`
  - dist CLI wrapper regenerated successfully.
- During implementation, an intermediate overload-only typing change briefly broke `typecheck`/`build`; this was fixed before the final verification by switching `renderScenario(...)` to a generic conditional signature that preserves union-typed callers while still blocking non-A overrides.

### Files changed for this follow-up
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/buglog.json`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/cerebrum.md`

### Concerns
- Left the pre-existing unrelated unstaged changes in `.superpowers/sdd/progress.md`, `.superpowers/sdd/task-3-report.md`, `.wolf/memory.md`, `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, and `package-lock.json` out of the fix commit.


## Whole-branch override chronology correction follow-up — 2026-07-18
### Correction
- This report now explicitly distinguishes the fixed A-04 execution-policy envelope from the later whole-branch Scenario A-only override restriction.
- The initial Task 2 implementation/reporting covered the approved A-04 override values used by `prepareA04(...)`, but it did not yet prove that non-A scenarios rejected `executionPolicyOverrides` globally.
- That branch-wide restriction was added later in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts` and `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts`, where non-A scenarios now reject `executionPolicyOverrides` at runtime and the old Scenario C override-only success case has been replaced by rejection coverage.

### Exact commands
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/contracts.test.ts`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck`

### Relevant output
- Focused contracts verification:
  - `Test Files  1 passed (1)`
  - `Tests  19 passed (19)`
- Supporting typecheck attempt:
  - failed with `tests/validation/prepareA04.test.ts(295,53): error TS2493: Tuple type '[]' of length '0' has no element at index '2'.`
  - This failure comes from separate pre-existing unstaged work in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`, not from the Scenario A override restriction in `validation/v1/lib/scenarios.ts` or `tests/validation/contracts.test.ts`.

### Files changed for this follow-up
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`

### Concerns
- Left the unrelated unstaged changes in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/progress.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, and `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/package-lock.json` untouched and out of this follow-up.


## Remaining whole-branch review follow-up — 2026-07-18 (verified checkout freeze + read-only inspection)
### What changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so `prepareA04(...)` now runs a spec-6.1 read-only inspection before deterministic verification and fails fast unless the retained `main` checkout, retained `evidence-first-v1` worktree, backup branch, retained stashes, and preserved `.validation-runs/` recovery evidence are all still present and readable.
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so successful A-04 preparation preserves the isolated verified checkout instead of deleting it, captures its verified `HEAD`, and emits approval-package `workingDirectory`, `verifiedCheckout`, and `exactCommand` values that point to the verified checkout's runnable `validation/v1/scripts/run-scenario.ts` target.
- Expanded `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` with focused regression coverage for read-only inspection failure before checkout creation, preserved verified-checkout behavior on success, cleanup-on-failure behavior, spec-locked phase ordering with the new inspection phase, and exact-command binding to the verified checkout path.
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md` so the operator procedure now documents the new read-only inspection phase and the verified-checkout-bound approval package semantics.

### Exact test commands
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/prepareA04.test.ts`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run build`

### Relevant output
- Focused tests:
  - `Test Files  1 passed (1)`
  - `Tests  21 passed (21)`
- Typecheck:
  - `tsc --noEmit -p tsconfig.json`
- Build:
  - `tsc -p tsconfig.json`
  - `dist/cli.js` and `dist/cli.d.ts` regenerated successfully.

### Files changed for this follow-up
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`

### Concerns
- Left the unrelated unstaged changes in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/progress.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, and `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/package-lock.json` untouched and out of this follow-up.


## Final critical follow-up — 2026-07-18 (self-contained verified checkout dependencies)
### What changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so the preserved verified checkout now copies `node_modules` into the verified checkout when dependencies exist instead of symlinking back to the operator checkout.
- Added cleanup-on-failure protection in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so a failed dependency materialization does not leave behind a half-prepared verification checkout.
- Expanded `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` with a focused regression that proves the verified checkout gets a real local `node_modules` tree rather than a symlink, and that later edits to the source checkout's dependency file do not mutate the preserved copy.
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/anatomy.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/cerebrum.md`, and `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/buglog.json` to record the self-contained verified-checkout rule.

### Exact test commands
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/prepareA04.test.ts`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run build`

### Relevant output
- Focused tests:
  - `Test Files  1 passed (1)`
  - `Tests  22 passed (22)`
- Typecheck:
  - `tsc --noEmit -p tsconfig.json`
- Build:
  - `tsc -p tsconfig.json`
  - `dist/cli.js` and `dist/cli.d.ts` regenerated successfully.

### Files changed for this follow-up
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/anatomy.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/cerebrum.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/buglog.json`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`

### Concerns
- Left the pre-existing unrelated unstaged changes in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/progress.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, and `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/package-lock.json` untouched and out of this follow-up.


## Final critical follow-up — 2026-07-18 (freeze adapter config inside verified checkout)
### What changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so A-04 preparation now rejects `adapterConfigPath` values outside `repoRoot`, requires the source adapter config to exist before approval, maps it into the preserved verified checkout, and requires that verified-checkout copy/path to exist before emitting the approval package.
- Expanded `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` with focused regressions that reject repo-external adapter configs, reject missing adapter configs, reject adapter configs missing from the preserved verified checkout, and verify the approval package plus `exactCommand` use the frozen verified-checkout adapter config path.
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md` so the operator contract now explicitly states that `--adapter-config` must stay under repo root and resolve inside the preserved verified checkout.

### Exact test commands
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/prepareA04.test.ts`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run build`

### Relevant output
- Focused tests:
  - `Test Files  1 passed (1)`
  - `Tests  25 passed (25)`
- Typecheck:
  - `tsc --noEmit -p tsconfig.json`
- Build:
  - `tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node
export * from "./src/cli.js";
import { main } from "./src/cli.js";
void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
');fs.writeFileSync('dist/cli.d.ts', 'export * from "./src/cli.js";
');"`

### Files changed for this follow-up
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`

### Concerns
- Left the pre-existing unrelated unstaged changes in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/progress.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, and `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/package-lock.json` untouched and out of this follow-up.


## Final remaining review follow-up — 2026-07-18 (adapter-config symlink escape + dangling-symlink freshness)
### What changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so A-04 freshness now uses `lstat()`-style existence semantics; any existing filesystem entry at `contractPath`, `runDir`, or `evidenceDir` — including a dangling symlink — is rejected as non-fresh.
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so `adapterConfigPath` is now frozen with `realpath()` containment checks: a repo-internal adapter-config symlink may not resolve outside repo root, and the mapped adapter-config path inside the preserved verified checkout may not resolve outside that checkout.
- Expanded `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` with focused regressions for repo-internal adapter-config symlink escape, verified-checkout adapter-config symlink escape, and dangling-symlink occupancy at `contractPath`, `runDir`, and `evidenceDir`.
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md` so the operator contract now says `--adapter-config` must realpath-resolve within both the source repo and the preserved verified checkout.

### Exact test commands
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/prepareA04.test.ts`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run build`

### Relevant output
- Focused tests:
  - `Test Files  1 passed (1)`
  - `Tests  33 passed (33)`
- Typecheck:
  - `tsc --noEmit -p tsconfig.json`
- Build:
  - `tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from "./src/cli.js";\nimport { main } from "./src/cli.js";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from "./src/cli.js";\n');"`

### Files changed for this follow-up
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/anatomy.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/cerebrum.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/buglog.json`

### Concerns
- Left the pre-existing unrelated unstaged changes in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/progress.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, and `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/package-lock.json` untouched and out of this follow-up.


## Final remaining review follow-up — 2026-07-18 (main-checkout porcelain truthfulness + usage-evidence expectations)
### What changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so A-04 preparation now captures the repo-root main checkout baseline (`git rev-parse HEAD` plus full `git status --porcelain`) before prepare begins, rejects immediately if the main checkout is already dirty, and re-checks the same baseline before emitting the approval package.
- Strengthened `usageEvidenceExpectations` in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` so the approval package now says budget may be consumed across up to three Claude-backed phases, each produced phase artifact is expected to carry standard `usageEvidence` plus explicit alias selection and `normalizedTotal`, `tokenUsage` appears exactly when `usageEvidence.normalizedTotal` is finite and positive and must equal it, and usage evidence improves auditability without defining success by itself.
- Expanded `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` with focused regressions for a dirty main checkout before prepare, main-checkout drift during prepare, and the full approval-package `usageEvidenceExpectations` shape.

### Exact test commands
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/prepareA04.test.ts`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck`
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run build`

### Relevant output
- Focused tests:
  - `Test Files  1 passed (1)`
  - `Tests  35 passed (35)`
- Typecheck:
  - `tsc --noEmit -p tsconfig.json`
- Build:
  - `tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node
export * from "./src/cli.js";
import { main } from "./src/cli.js";
void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
');fs.writeFileSync('dist/cli.d.ts', 'export * from "./src/cli.js";
');"`

### Files changed for this follow-up
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/cerebrum.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/buglog.json`

### Concerns
- Did not stage or include the excluded dirty files `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/progress.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`, `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, or `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/package-lock.json` in this follow-up commit.
