# Task 3 Report — Single-Scenario Evidence Harness

## Outcome
- Status: DONE
- Original implementation commit: `88c9cf3d988e3faa74ec1589b169e1f16a292127`
- Prior report commit: `0df1386963d08ec80db6e4c4cc48aff4772213f3`
- Scope respected: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/src` remained unchanged.
- Real Claude was not launched; verification used synthetic run directories plus fake local adapter scripts only.

## Files Changed
- `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/tests/validation/evidence.test.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/validation/v1/lib/evidence.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/validation/v1/scripts/run-scenario.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/validation/v1/scripts/finalize-review.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/.superpowers/sdd/task-3-report.md`

## TDD Record
1. Wrote `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/tests/validation/evidence.test.ts` first.
2. Verified RED with `npm test -- --run tests/validation/evidence.test.ts`.
3. Result: FAIL as expected because `../../validation/v1/lib/evidence.js` did not exist yet.
4. Implemented the initial deterministic evidence collector, wrapper, and review finalizer.
5. Verified GREEN with the focused evidence suite.
6. Ran full validation (`npm test`, `npm run typecheck`, `npm run build`) and fixed a TypeScript failure caused by a dead Promise-based cleanup helper.
7. Ran mandatory code review, converted reviewer findings into new failing regression tests, then fixed the harness until the focused suite, full suite, typecheck, and build all passed again.

## Command Log and Results
### Coordinator follow-up review fix
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Summary: FAIL — new regression tests proved three bugs: existing `evidenceDir` was overwritten, existing `runDir` still triggered evidence packaging, and `--scenario` was not bound to `objective.taskId`.
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Summary: PASS — `1` test file passed; `18` tests passed; `0` failed after reordering preflight safety checks, making evidence-dir creation conditional on freshness, and binding `--scenario` to `objective.taskId`.
- Command: `npm test`
- Summary: PASS — `13` test files passed; `97` tests passed; `0` failed.
- Command: `npm run typecheck`
- Summary: PASS — `tsc --noEmit -p tsconfig.json` completed without errors.
- Command: `npm run build`
- Summary: PASS — TypeScript compiled and regenerated `dist/cli.js` without errors.

### Task 5 A-01 parent-path fix
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Summary: FAIL — new nested-evidence regression reproduced the A-01-style parent-missing bug with `ENOENT` on a fresh `evidence/A-01` leaf path whose parent directory did not exist.
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Summary: PASS — `1` test file passed; `19` tests passed; `0` failed after creating only `dirname(parsed.evidenceDir)` before the leaf evidence directory.
- Command: `npm test`
- Summary: PASS — `13` test files passed; `98` tests passed; `0` failed.
- Command: `npm run typecheck`
- Summary: PASS — `tsc --noEmit -p tsconfig.json` completed without errors.
- Command: `npm run build`
- Summary: PASS — TypeScript compiled and regenerated `dist/cli.js` without errors.

### Task 5 A-03 token-alias fix
- Command: `npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Summary: FAIL — new duplicate-alias token regression showed `scripts/claude-phase-runner.mjs` returned `tokenUsage: 250` instead of `125` when both snake_case and camelCase usage aliases were present.
- Command: `npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Summary: PASS — `1` test file passed; `18` tests passed; `0` failed after selecting snake_case first and falling back to camelCase per side.
- Command: `npm test`
- Summary: PASS — `13` test files passed; `102` tests passed; `0` failed.
- Command: `npm run typecheck`
- Summary: PASS — `tsc --noEmit -p tsconfig.json` completed without errors.
- Command: `npm run build`
- Summary: PASS — TypeScript compiled and regenerated `dist/cli.js` without errors.
- Command: `git diff --check`
- Summary: PASS — no whitespace or patch-format errors.

### Task 5 A-03 non-finite token follow-up
- Command: `npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Summary: FAIL — new raw-JSON exponent regressions showed parsed `Infinity` still passed the `typeof === "number"` check, leading to `tokenUsage: null` instead of finite fallback accounting.
- Command: `npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Summary: PASS — `1` test file passed; `20` tests passed; `0` failed after switching token alias selection/filtering to `Number.isFinite` while preserving snake-first/camel-fallback semantics.
- Command: `npm test`
- Summary: PASS — `13` test files passed; `104` tests passed; `0` failed.
- Command: `npm run typecheck`
- Summary: PASS — `tsc --noEmit -p tsconfig.json` completed without errors.
- Command: `npm run build`
- Summary: PASS — TypeScript compiled and regenerated `dist/cli.js` without errors.
- Command: `git diff --check`
- Summary: PASS — no whitespace or patch-format errors.

### Red phase
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Summary: FAIL — Vitest could not load `../../validation/v1/lib/evidence.js` because the module did not exist.

### Initial green phase
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Summary: PASS — `1` test file passed; `10` tests passed; `0` failed.
- Command: `npm test`
- Summary: PASS — `13` test files passed; `89` tests passed; `0` failed.
- Command: `npm run typecheck`
- Summary: FAIL — `validation/v1/lib/evidence.ts` used a `Promise<boolean>` in a synchronous conditional (`TS2801`).
- Command: `npm run build`
- Summary: FAIL — same `TS2801` error blocked the build.

### Review-follow-up red/green cycle
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Summary: FAIL — `5` new regression tests failed, surfacing required-check validation, repo-root dependence, missing early-failure evidence, fixture/contract mismatch, and overconfident `claudeChildExited` reporting.
- Command: `npm run typecheck`
- Summary: PASS — after rewriting `validation/v1/lib/evidence.ts` with escaped newline sequences intact.
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Summary: FAIL — `1` remaining regression test showed `claudeChildExited` was still reported too strongly.
- Command: `npm run build`
- Summary: PASS — TypeScript compiled and regenerated `dist/cli.js`.
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Summary: PASS — `1` test file passed; `15` tests passed; `0` failed.
- Command: `npm run typecheck`
- Summary: PASS — `tsc --noEmit -p tsconfig.json` completed without errors.
- Command: `npm test`
- Summary: PASS — `13` test files passed; `94` tests passed; `0` failed.
- Command: `npm run build`
- Summary: PASS — TypeScript compiled and regenerated `dist/cli.js` without errors.
- Command: `git diff -- src`
- Summary: PASS — empty diff; Task 3 did not change `/src` product code.

## Self-Review
- Confirmed `validation/v1/lib/evidence.ts` exports the exact Task 3 surface: `ArtifactStatus`, `Review`, `sha256File()`, `collectArtifacts()`, `collectGitObservation()`, `collectEvidence()`, and `validateReview()`.
- Confirmed artifact hashing is limited to fixed known files under `runDir`, with `realpath` + `relative` containment rejecting escape paths such as symlinked artifacts outside the run directory.
- Confirmed every JSON file is parsed explicitly and malformed `loop-state.json` / `verify.json` surfaces as `INVALID` rather than being skipped.
- Confirmed every non-empty `events.jsonl` line is parsed, and a single malformed line marks the event log `INVALID` with the line number recorded.
- Confirmed artifact statuses distinguish `PRESENT`, `NOT_PRODUCED`, `NOT_RUN`, `MISSING`, and `INVALID` according to scenario expectations plus observed files.
- Confirmed required-check evidence is validated against the required command list declared in `loop-contract.json`, not just generic evidence strings.
- Confirmed `run-scenario.ts` refuses pre-existing run/evidence directories, never writes into an existing `evidenceDir`, never packages stale `runDir` data after freshness-check failures, creates only the missing parent of a fresh nested `evidenceDir` before the leaf directory, requires a clean fixture, and rejects `--fixture` when it does not match `contract.context.repoPath`.
- Confirmed `run-scenario.ts` launches the CLI from the repository root using an absolute `dist/cli.js` path, so it still works when invoked outside the repo root.
- Confirmed `run-scenario.ts` binds `--scenario` to the existing Task 2 contract identity via `objective.taskId`, so a rendered A contract is rejected before child launch when invoked as scenario D.
- Confirmed the wrapper records only environment variable names, captures stdout/stderr into evidence logs, and still writes JSON evidence files when ccloop fails before creating `runDir`.
- Confirmed `scripts/claude-phase-runner.mjs` now prefers finite snake_case usage fields and falls back to finite camelCase per side, preventing duplicate alias double counting and ignoring parsed non-finite JSON exponent values while leaving historical A-03 evidence unchanged/unreclassified.
- Confirmed terminal outcome and cleanup outcome stay separate in `observations.json`.
- Confirmed `finalize-review.ts` enforces exact verdict/diagnosis enums, non-empty summaries, no overwrite of `review.json`, and stores diagnosis `null` as JSON `null`.

## Concerns
- `claudeChildExited` is intentionally conservative and currently always records `"NOT_OBSERVABLE"`. This matches the brief's requirement to avoid claiming adapter-exit certainty without a tracked descendant PID, but it means the harness does not yet emit `YES` or `NO` in practice.
- OpenWolf metadata files (`.wolf/anatomy.md`, `.wolf/buglog.json`, `.wolf/cerebrum.md`, `.wolf/memory.md`) were updated during the work but remain gitignored in this worktree, so they are not included in normal task commits.

## Final Reviewed Head
- Final reviewed head: `a4b177d426e26e4d7efbe423f370c888632fcb46`

## Task 3 — A-04 Preparation Workflow and Deterministic Verification (2026-07-18)

### What I implemented/completed
- Confirmed `validation/v1/README.md` now documents the non-paid `prepare-a04.ts` operator workflow under `## A-04 mechanical prepare (no paid call)`.
- Kept `.wolf/anatomy.md` aligned with the final one-line inventory entries for `validation/v1/lib/a04.ts`, `validation/v1/scripts/prepare-a04.ts`, and `tests/validation/prepareA04.test.ts`.
- Appended the required OpenWolf bookkeeping entry to `.wolf/memory.md` for the A-04 preparation workflow.
- Completed the required deterministic verification and a single stdout-only A-04 dry-run without launching any paid Claude call.

### What I tested and results
- `npm test -- --run tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts tests/runtime/claude/subprocessClaudeAdapter.test.ts tests/controller/runLoop.integration.test.ts tests/validation/evidence.test.ts`
  - PASS: 5 files, 107 tests passed, 0 failed.
- `npm run typecheck`
  - PASS.
- `npm run build`
  - PASS.
- `npx --no-install tsx validation/v1/scripts/create-fixture.ts --output .validation-runs/fixture-01`
  - PASS: created a fresh local fixture repo for the dry-run.
- `git -C .validation-runs/fixture-01 status --short`
  - PASS: empty output.
- `git -C .validation-runs/fixture-01 rev-list --count HEAD`
  - PASS: `1`.
- `find .validation-runs/fixture-01 -type l -print`
  - PASS: empty output.
- `npx --no-install tsx validation/v1/scripts/prepare-a04.ts --fixture .validation-runs/fixture-01 --contract .validation-runs/contracts/A-04.json --run-dir .validation-runs/runs/A-04 --evidence-dir .validation-runs/evidence/A-04 --adapter-config examples/v1/claude-adapter-config.json --token-budget 550000 --per-attempt-timeout-ms 600000 --total-runtime-budget-ms 1200000 --partial-recovery-window-ms 5000`
  - PASS: exit 0; stdout was approval-package JSON only.
- `jq '.contractIdentity, .executionPolicy, .exactCommand, .expectedFileScope, .expectedDiffScope' <approval-json>`
  - PASS: showed the frozen contract identity, approved execution policy, exact `run-scenario.ts` command, expected file scope, and expected diff scope.
- Path assertions after dry-run
  - PASS: `.validation-runs/contracts/A-04.json` exists; `.validation-runs/runs/A-04` does not exist; `.validation-runs/evidence/A-04` does not exist.

### Command evidence for deterministic verification and dry-run
- Focused deterministic verification completed successfully before the dry-run:
  - `npm test -- --run tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts tests/runtime/claude/subprocessClaudeAdapter.test.ts tests/controller/runLoop.integration.test.ts tests/validation/evidence.test.ts`
  - `npm run typecheck`
  - `npm run build`
- Dry-run approval package evidence:
  - `contractIdentity.path`: `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.validation-runs/contracts/A-04.json`
  - `contractIdentity.sha256`: `5a7f247257e9ddf451026685ee64be5465bf8ddfc4e070d9bf404ffdf3929f96`
  - `executionPolicy`: `550000 / 600000 / 1200000 / 5000`
  - `expectedFileScope`: `src/counter.js`, `test/counter.test.js`
  - `expectedDiffScope`: `src/**`, `test/**`
  - `exactCommand`: `npx --no-install tsx validation/v1/scripts/run-scenario.ts --scenario A --contract /Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.validation-runs/contracts/A-04.json --fixture /Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.validation-runs/fixture-01 --run-dir /Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.validation-runs/runs/A-04 --evidence-dir /Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.validation-runs/evidence/A-04 --adapter-config /Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/examples/v1/claude-adapter-config.json`

### Files changed
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/anatomy.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`

### Self-review findings
- The README section matches the briefed command shape and explicitly states that `prepare-a04.ts` must not invoke Claude or create `review.json`.
- The dry-run required a temporarily clean tracked checkout because `prepareA04()` correctly refuses to run with tracked repo-root changes; I satisfied this by temporarily stashing tracked edits and restoring them immediately after verification.
- The dry-run created only the contract file plus a fresh local fixture; it did not create the run or evidence directories.
- No real Claude invocation or paid validation run occurred.

### Issues or concerns
- `.superpowers/sdd/task-3-report.md` contained older unrelated Task 3 history from another worktree, so this update appends a clearly labeled new Task 3 section instead of rewriting prior content.
- The temporary fixture and contract under `.validation-runs/fixture-01` and `.validation-runs/contracts/A-04.json` remain as local verification artifacts from the allowed dry-run; they were not staged for commit.


## Task 3 reviewer follow-up — surgical `.wolf/memory.md` fix (2026-07-18)

### What I changed
- Removed the unrelated embedded Task 2 closure entry from `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md` while preserving the required Task 3 append line.
- Appended this reviewer-follow-up note to the existing Task 3 report.

### Exact verification step(s)
- `python3` check comparing current `.wolf/memory.md` against `git show 0b1abbd:.wolf/memory.md`, asserting the current file equals the Task 2 baseline plus exactly one appended Task 3 line:
  - PASS: `memory matches parent plus only the expected Task 3 append line`

### Files changed
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.wolf/memory.md`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`

### Concerns
- None.
