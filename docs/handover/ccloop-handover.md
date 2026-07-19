# ccloop Handover

> Updated: 2026-07-18
> Scope: merged V1 validation work, Claude usage-evidence hardening, preserved A-01 through A-03 evidence, and the current local A-04 preparation / approval branch state.
> Snapshot rule: verify every status claim against Git and the filesystem before acting. Current code, committed branch state, and immutable evidence override this document if they differ.

## Executive Summary for Next Agent

1. `main` is at `5b11232` (`add spec and plan`) and currently has one local modification: `.superpowers/sdd/task-1-report.md`.
2. Preserved real-run evidence still lives only in `.worktrees/evidence-first-v1/.validation-runs/`; do not clean or rewrite it.
3. The active local follow-up worktree is `.worktrees/a04-preflight-approval` on branch `a04-preflight-approval`; the latest committed head verified in this session is `c3036dc`, but always re-check `git log` and `git status` there before acting.
4. In that worktree, local non-paid dry-run artifacts already exist: `.validation-runs/fixture-01` and `.validation-runs/contracts/A-04.json`; `.validation-runs/runs/A-04` and `.validation-runs/evidence/A-04` still do not exist.
5. The intended A-04 envelope remains `550000 / 600000 / 1200000 / 5000`, one attempt, no automatic retries.
6. No real Claude paid call has been run from the A-04 preparation branch.
7. Latest known focused verification there passed: `tests/validation/contracts.test.ts` + `tests/validation/prepareA04.test.ts` (55 tests), `npm run typecheck`, `npm run build`.
8. Backup branch `backup/evidence-first-v1-before-memory-history-cleanup` and both stashes still exist; never delete or publish them.
9. Before further work, read this handover, then inspect `.worktrees/a04-preflight-approval` git status/log plus `validation/v1/lib/a04.ts`, `tests/validation/prepareA04.test.ts`, `validation/v1/README.md`, and `.superpowers/sdd/task-2-report.md`.
10. Do not assume the local A-04 preparation branch is final merely because focused tests pass; review its latest committed and uncommitted state before using it for any real paid Scenario A run.

## 1. Current Repository State

### Main checkout

- Path: `/Users/biran/code/skills/loop/ccloop`
- Branch: `main`
- HEAD: `5b11232f3d9ff9e9db19bf5d5104e54ea12064ab` (`add spec and plan`)
- Local Git currently reports `main == origin/main`.
- Evidence-first validation implementation, Claude usage-evidence changes, and the A-04 spec/plan are present on `main`.
- Current observed local change in `main`: `M .superpowers/sdd/task-1-report.md`.
- Do not overwrite, discard, or broadly stage that local report file without review.

### A-04 preparation worktree

- Path: `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval`
- Branch: `a04-preflight-approval`
- Merge base with `main`: `5b11232f3d9ff9e9db19bf5d5104e54ea12064ab`
- Latest committed branch head verified in this session: `c3036dc8892c16648a6c1c021e186ea96595f638` (`fix: freeze A-04 contract and fingerprint checkout`)
- Recent committed branch history observed in this session:
  - `c3036dc` `fix: freeze A-04 contract and fingerprint checkout`
  - `f11735b` `fix: tighten A-04 pre-approval truthfulness`
  - `afffa6d` `fix: harden A-04 symlink path checks`
  - `5d1f606` `fix: freeze A-04 adapter config path`
  - `9e7efa1` `fix: self-contain verified A-04 checkout`
  - `a28da79` `fix: freeze verified A-04 approval target`
  - `f7b8908` `fix: finalize A-04 approval truthfulness`
  - `1973438` `docs: correct Task 2 override chronology`
  - `5f26268` `fix: align A-04 preflight approval flow`
  - `9b6fee3` `fix: close final A-04 preflight review gaps`
  - `5bfd1f8` `fix: make Task 3 memory update surgical`
  - `6ff39b1` `docs: record A-04 preparation workflow`
- Local unstaged files currently present in this worktree:
  - `.superpowers/sdd/progress.md`
  - `.superpowers/sdd/task-3-report.md`
  - `.wolf/memory.md`
  - `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
  - `package-lock.json`
- Local non-paid dry-run artifacts in this worktree currently are:
  - present: `.validation-runs/fixture-01`
  - present: `.validation-runs/contracts/A-04.json`
  - absent: `.validation-runs/runs/A-04`
  - absent: `.validation-runs/evidence/A-04`
- No real Claude call has been run from this worktree.
- This branch has **not** been declared final/clean in this handover. Before merging or using it to support a real paid A-04 invocation, re-review its latest committed state and any remaining local modifications.

### Evidence-first validation worktree

- Path: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1`
- Branch: `evidence-first-v1`
- HEAD: `d513e01ab5e2c7689e4170e98c0eb2b8236ced5e` (`docs: record final usage evidence verification`)
- `main` is ahead of this branch; this worktree remains the home of ignored preserved real-run evidence under `.validation-runs/`.
- It intentionally contains dirty/untracked SDD reports, copied documents, OpenWolf metadata, and `dist/`. Do not clean, reset, reinitialize, or broadly stage it.
- Product/runtime work from this branch is already on `main`; preserving the linked worktree is still required because its ignored A-01 through A-03 evidence is not in Git.

### Backup branch and sensitive history

- Local backup branch: `backup/evidence-first-v1-before-memory-history-cleanup`.
- It preserves the pre-rewrite branch state, including commits `73fa00e` and `e0d3fb1`, which temporarily contained `.wolf/memory.md`.
- `main` and `evidence-first-v1` do not contain `.wolf/memory.md` in their reachable history.
- Both sensitive commits are reachable only from the local backup branch.
- Never push or publish the backup branch. Do not delete it without explicit approval.

### Other linked worktrees

```text
/Users/biran/code/skills/loop/ccloop/.claude/worktrees/agent-a15e1b1541b3b5082  5b11232 [worktree-agent-a15e1b1541b3b5082] locked
/Users/biran/code/skills/loop/ccloop/.claude/worktrees/agent-a7587a5bdc14743ba  4460fca [worktree-agent-a7587a5bdc14743ba]
```

Do not remove either without auditing its state and obtaining approval if removal could affect user data.

### Stashes

Current observed stashes:

```text
stash@{0}: On main: pre-local-merge-evidence-first-v1-2026-07-18
stash@{1}: On main: pre-merge local changes 2026-07-16
```

- `stash@{0}` is a retained safety copy from the local merge. Its files were restored before the final documentation commit, but the user chose to keep the stash.
- `stash@{1}` is an older safety stash.
- Inspect before any possible deletion. No stash deletion is authorized.

### Verification baseline

Fresh verification re-run in the A-04 preparation worktree during this handover refresh:

- `npm test -- --run tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts` passing (`55` tests);
- `npm run typecheck` passing;
- `npm run build` passing;
- no real Claude call occurred.

Fresh verification on `main` was **not** rerun in this handover refresh. If `main` will be used again as the execution base, re-run `npm test`, `npm run typecheck`, and `npm run build` there before acting.

`npm ci` previously reported 5 dependency vulnerabilities: 3 moderate, 1 high, and 1 critical. This remains observational only. No dependency remediation was authorized; do not run `npm audit fix` or modify dependencies without separate approval.

## 2. V1 Positioning

ccloop V1 is a contract-first TypeScript CLI for one code-task loop in one repository. It uses L2 assisted autonomy and prioritizes controllability, independent verification, and explicit stopping over maximum autonomy.

V1 supports:

- strict JSON loop-contract validation;
- explicit run states and legal transitions;
- bounded attempts, phase timeouts, runtime budget, and token budget;
- isolated Git worktrees per attempt;
- planner, executor, and verifier phase separation;
- deterministic scripted adapter for tests and examples;
- subprocess-based Claude adapter and wrapper;
- complete and partial execute outcomes;
- bounded execute-only partial-outcome recovery;
- path allowlist/denylist and max-files human gates;
- real execution of required verification commands;
- durable contract, state, events, logs, diffs, and per-attempt artifacts;
- preservation of the attempt worktree for `blocked_waiting_human`;
- whitelisted Claude usage evidence tied to each completed phase artifact.

V1 intentionally does not provide multi-loop coordination, automatic push/merge, resume of a blocked run, multi-runtime orchestration, scheduling, or unattended L3 operation.

## 3. Governing Designs and Decisions

Read these before continuing:

1. `docs/superpowers/specs/2026-07-17-evidence-first-v1-validation-design.md`
2. `docs/superpowers/plans/2026-07-17-evidence-first-v1-validation.md`
3. `docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md`
4. `docs/superpowers/plans/2026-07-18-claude-usage-evidence.md`
5. `docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md`
6. `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
7. `docs/ccloop-v2-review-backlog.md`
8. `.worktrees/evidence-first-v1/.superpowers/sdd/progress.md`

The governing decisions are:

- exercise real Claude behavior before adding automation;
- keep experiment-derived evidence separate from product behavior unless real evidence proves a product gap;
- change product code only for a confirmed `FAIL / PRODUCT_DEFECT`;
- require explicit approval before every real Claude invocation, including exact budgets and paths;
- use fresh contract, run, and evidence paths for every invocation;
- never retry a real scenario automatically;
- defer V2 ownership, reconciliation, resume, scheduling, concurrency, and durable publication until evidence-first V1 validation is complete;
- use models for judgment, not deterministic routing, retries, state transitions, or persistence.

The current intended A-04 approval envelope is:

```text
tokenBudget: 550000
perAttemptTimeoutMs: 600000
totalRuntimeBudgetMs: 1200000
partialOutcomeRecoveryWindowMs: 5000
maxAttempts: 1
automatic retries: none
```

The V2 backlog remains review input, not an approved V2 design or scope commitment.

## 4. Durable Progress

The authoritative historical task ledger for evidence-first V1 validation remains:

```text
.worktrees/evidence-first-v1/.superpowers/sdd/progress.md
```

Recorded outcome there remains:

```text
Validation Tasks 1-4: complete
Task 3 supplement: complete — nested evidence-parent defect fixed
Task 5 A-01: INCONCLUSIVE — harness failed before controller launch
Task 5 A-02: INCONCLUSIVE — planning exhausted the 50k token budget
Task 5 A-03: INCONCLUSIVE — execution completed but 100k exhausted before verify
Token alias/non-finite fixes: complete
Claude usage evidence: complete
Legacy artifact compatibility: complete
History privacy cleanup: complete
Final deterministic verification: 13 files / 114 tests, typecheck/build pass
```

Additional current-progress facts for the A-04 preparation branch:

- Branch/worktree: `.worktrees/a04-preflight-approval`
- Merge base with `main`: `5b11232`
- This branch is a local non-paid A-04 preparation branch and is **not yet declared final in this handover**.
- Before treating it as authoritative, re-review its latest committed state and any remaining local modifications.

## 5. Validation Kit

Committed validation files on `main` include:

```text
validation/v1/
  README.md
  fixture/
  lib/
    scenarios.ts
    evidence.ts
  scripts/
    create-fixture.ts
    render-contract.ts
    run-scenario.ts
    finalize-review.ts
```

The A-04 preparation branch additionally contains local committed work (not yet merged to `main`) around:

```text
validation/v1/lib/a04.ts
validation/v1/scripts/prepare-a04.ts
tests/validation/prepareA04.test.ts
```

Key behavior on `main` remains:

- `create-fixture.ts` creates a disposable one-commit Git repository and refuses overwrite.
- `render-contract.ts` renders strict A-E contracts and refuses overwrite.
- `run-scenario.ts` runs exactly one explicit scenario, never retries, captures process/run evidence, and rejects stale run/evidence paths.
- `finalize-review.ts` writes a human-selected verdict exactly once.
- Validation CLI tests create their own temporary Git repositories; they no longer depend on ignored `.validation-runs/fixture-smoke` state.

Key intended behavior in the A-04 preparation branch is now:

- `prepare-a04.ts` is a non-paid helper that:
  - verifies it is being run from branch `main`;
  - performs a read-only inspection of retained safety context;
  - freezes the approved `main` revision into a preserved verified checkout;
  - runs deterministic verification against that verified checkout;
  - requires `--adapter-config` to resolve under repo root and under the preserved verified checkout;
  - freezes the rendered A-04 contract into the preserved verified checkout and binds the approval package to that frozen contract copy plus the preserved verified checkout's `run-scenario.ts`;
  - rejects path overlaps, symlink escape, contract drift, and final-gate mismatches;
  - must not create `.validation-runs/runs/A-04` or `.validation-runs/evidence/A-04`.

## 6. Claude Usage Evidence

The completed usage-evidence increment closes the audit gap that made A-03's historical token total impossible to reconstruct.

For each successful Claude-backed plan, execute, or verify result, the standard phase artifact may now include:

- the four supported aliases only: `input_tokens`, `inputTokens`, `output_tokens`, `outputTokens`;
- per-field status: `absent`, `finite`, `non_finite`, or `invalid_type`;
- the selected input and output alias;
- `normalizedTotal`;
- `tokenUsage`, present only when it equals a finite positive `normalizedTotal`.

Semantics remain:

- finite snake_case wins over the matching camelCase alias;
- aliases are alternatives and are never double-counted;
- unknown usage fields, prompts, assistant text, credentials, and complete envelopes are not persisted;
- zero, negative, or non-finite totals do not produce `tokenUsage`;
- interrupted/error fallback partial execution does not invent usage evidence from incomplete stdout;
- the controller consumes the wrapper-provided `tokenUsage` and does not run a second alias-normalization algorithm.

Historical A-01 through A-03 artifacts remain immutable and are not retroactively reconstructed.

## 7. Preserved Real-Run Evidence

All preserved real-run evidence below is still relative to `.worktrees/evidence-first-v1`. That `.validation-runs/` tree remains the only authoritative preserved real-run evidence set. The A-04 preparation branch's local dry-run artifacts are separate and must not be confused with these preserved records.

### A-01

- Contract: `.validation-runs/contracts/A-01.json`
- Review: `.validation-runs/evidence/A-01/review.json`
- Historical verdict: `INCONCLUSIVE / ENVIRONMENT_FAILURE`
- The invocation failed before controller or Claude launch because the harness did not create the nested evidence parent.
- No run directory was produced.
- The immutable historical review was not rewritten after the harness defect was diagnosed and fixed.

### A-02

- Contract: `.validation-runs/contracts/A-02.json`
- Run: `.validation-runs/runs/A-02/`
- Evidence: `.validation-runs/evidence/A-02/`
- Review: `.validation-runs/evidence/A-02/review.json`
- Verdict: `INCONCLUSIVE / RUNTIME_VARIANCE`
- Contract token budget: 50,000.
- Planning reported `60,158`; the controller safely exhausted before execute/verify.
- Main fixture checkout stayed unchanged, the attempt worktree was removed, and no survivor process remained.

### A-03

- Contract: `.validation-runs/contracts/A-03.json`
- Run: `.validation-runs/runs/A-03/`
- Evidence: `.validation-runs/evidence/A-03/`
- Review: `.validation-runs/evidence/A-03/review.json`
- Historical verdict: `INCONCLUSIVE / RUNTIME_VARIANCE`
- Contract token budget: 100,000, separately approved and revalidated through the product schema.
- Planning reported `19,882`.
- Execution reported `440,874` under the pre-fix wrapper.
- Execution produced only the intended changes to `src/counter.js` and `test/counter.test.js`; executor-captured `npm test` output passed.
- The controller exhausted before controller-owned required checks and verifier evidence completed, so A-03 cannot be PASS.
- Fixture checkout, worktree cleanup, and process-survivor evidence were safe.
- Do not treat `440,874` as proven real usage. The historical raw envelope was not persisted, and the old wrapper had alias-duplication risk.

### Unrun scenarios

- No successful real-Claude Scenario A exists yet.
- B, C, D, and E have not been run with real Claude.
- Task 5 remains incomplete.

## 8. Current A-04 State and Decision Point

There are now **two distinct A-04 states** to keep straight:

### 8.1 Preserved real-run evidence state

In `.worktrees/evidence-first-v1/.validation-runs/`, A-04 is still **unapproved and unrun**:

```text
.validation-runs/contracts/A-04.json      absent
.validation-runs/runs/A-04                absent
.validation-runs/evidence/A-04            absent
```

This remains the only state that matters for the eventual real Scenario A invocation.

### 8.2 Local non-paid preparation state in `.worktrees/a04-preflight-approval`

In the separate preparation worktree, local dry-run artifacts now exist:

```text
.validation-runs/fixture-01               present
.validation-runs/contracts/A-04.json      present
.validation-runs/runs/A-04                absent
.validation-runs/evidence/A-04            absent
```

These are **not** preserved real-run evidence. They are local preparation artifacts from the non-paid `prepare-a04.ts` path.

### Recommended next action

A new agent taking over should choose **one** of these paths before proceeding:

1. **Finish / verify the A-04 preparation branch**
   - Re-review the committed branch state in `.worktrees/a04-preflight-approval`.
   - Confirm which later local commits after `c3036dc` are intended to remain.
   - Decide whether that branch is now clean enough to merge or cherry-pick back to `main`.

2. **Discard the branch and prepare directly from `main`**
   - Only if a human explicitly decides not to preserve the branch work.
   - In that case, re-implement or re-cherry-pick the accepted A-04 preparation flow onto `main` before running any paid Scenario A.

3. **Run a fresh local non-paid prepare after branch cleanup**
   - Only after deciding which checkout is authoritative.
   - If the A-04 preparation worktree will be reused, do **not** assume its current `fixture-01` / `contracts/A-04.json` are fresh enough for the next session; verify or rotate them.

### Current intended A-04 approval envelope

The current user-approved intended envelope remains:

```text
scenario: A
attempts: 1
per-attempt timeout: 600000ms
total runtime budget: 1200000ms
partial outcome recovery window: 5000ms
token budget: 550000
automatic retries: none
maximum Claude-backed phases: 3 (plan / execute / verify)
```

This is still a proposal only, not authorization. `tokenBudget` remains a controller stopping threshold, not an API-cost cap.

### A-04 success condition

For the eventual real Scenario A invocation, success still requires the complete evidence chain:

```text
plan -> execute -> controller required checks -> independent verify -> succeeded
```

Also require:

- intended Git diff only;
- fixture checkout unchanged;
- expected attempt worktree cleanup;
- no uncontrolled subprocess;
- complete plan/execution/verify artifacts;
- phase `usageEvidence.normalizedTotal` equal to each persisted `tokenUsage`;
- final token budget reconstructable from the phase artifacts.

Executor claims, process exit, or executor-captured tests alone are insufficient.

If A-04 yields `FAIL / PRODUCT_DEFECT`, stop scenario progression, preserve evidence, invoke systematic debugging, write a focused regression, and make only the minimum approved fix before any paid retry. If A-04 is explainably inconclusive, do not silently retry.

After a successful A-04, continue to B, then use A/B event timestamps to calibrate C and D, then run E. Every real call requires separate approval.

## 9. Compact Architecture and Safety Boundaries

```text
loop-contract.json
        |
        v
  Contract Schema
        |
        v
   Loop Controller
   /      |       \
plan   execute   verify
 |        |         |
 +---- Runtime Adapter ----+
             |
     scripted / Claude subprocess
             |
  Stop + safety decisions
             |
 state, events, artifacts, worktree
```

Important boundaries remain:

- The executor cannot declare final success.
- Controller policy, required checks, and independent verifier evidence determine success.
- `blocked_waiting_human` is terminal in V1; there is no resume.
- Denylist wins over allowlist.
- Execute-stage path gates outrank same-phase budget exhaustion.
- Execute timeout triggers abort and a bounded execute-only recovery window.
- A run directory must be fresh.
- V1 never falls back to editing the main checkout.
- No automatic push, PR creation, merge, or external write.
- Never reuse, delete, or overwrite historical `.validation-runs/` evidence.

## 10. Known Limitations

- No successful real-Claude Scenario A has completed the full evidence chain.
- Historical A-01 through A-03 usage cannot be reconstructed with the new evidence type.
- `claudeChildExited` remains `NOT_OBSERVABLE` unless a tracked descendant PID proves it; `survivorPids: []` still provides useful evidence.
- No resume, reconciliation, scheduler, daemon, queue, lease, heartbeat, watchdog, or multi-task coordination exists.
- Path matching remains intentionally small: exact, `**`, and directory-prefix `/**`.
- V1 rejects existing run directories instead of resuming them.
- The A-04 preparation branch is still local and not yet declared final in this handover; verify its latest committed state before treating it as authoritative.

## 11. Exact Takeover Procedure

Start in the repository root and inspect without cleaning:

```bash
git status --branch --short
git log -8 --oneline --decorate
git worktree list
git branch --list 'backup/evidence-first-v1-before-memory-history-cleanup'
git stash list

git -C .worktrees/evidence-first-v1 status --short
git -C .worktrees/evidence-first-v1 log -12 --oneline
git -C .worktrees/evidence-first-v1 show -s --format='%H %s' HEAD

git -C .worktrees/a04-preflight-approval status --short
git -C .worktrees/a04-preflight-approval log -12 --oneline
```

Read in order:

1. `docs/handover/ccloop-handover.md`
2. `.worktrees/evidence-first-v1/.superpowers/sdd/progress.md`
3. `docs/superpowers/specs/2026-07-17-evidence-first-v1-validation-design.md`
4. `docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md`
5. `docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md`
6. `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
7. `.worktrees/evidence-first-v1/validation/v1/README.md`
8. `.worktrees/evidence-first-v1/.superpowers/sdd/task-5-report.md`
9. `.worktrees/evidence-first-v1/.superpowers/sdd/task-5-token-debug.md`
10. A-02/A-03 review and run artifacts relevant to the A-04 budget decision
11. `.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
12. `.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
13. `.worktrees/a04-preflight-approval/validation/v1/README.md`
14. `.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`

Before doing anything further, decide whether the A-04 preparation branch itself is the next source of truth. If yes, review its latest committed state before touching `main`.

## 12. Useful Commands

```bash
# Main verification (if main is used again as execution base)
git -C /Users/biran/code/skills/loop/ccloop status --short
npm test
npm run typecheck
npm run build

# A-04 preparation worktree focused verification
npm --prefix .worktrees/a04-preflight-approval test -- --run \
  tests/validation/contracts.test.ts \
  tests/validation/prepareA04.test.ts
npm --prefix .worktrees/a04-preflight-approval run typecheck
npm --prefix .worktrees/a04-preflight-approval run build

# Check local dry-run artifacts in the A-04 preparation worktree
for path in \
  .worktrees/a04-preflight-approval/.validation-runs/fixture-01 \
  .worktrees/a04-preflight-approval/.validation-runs/contracts/A-04.json \
  .worktrees/a04-preflight-approval/.validation-runs/runs/A-04 \
  .worktrees/a04-preflight-approval/.validation-runs/evidence/A-04; do
  test -e "$path" && echo "exists $path" || echo "missing $path"
done

# Focused usage-evidence regressions on main
npm test -- --run \
  tests/runtime/claude/subprocessClaudeAdapter.test.ts \
  tests/controller/runLoop.integration.test.ts \
  tests/validation/evidence.test.ts

# Read durable progress
grep -n '^Task\|^Token\|^Claude usage\|^Legacy\|^History\|^Final' \
  .worktrees/evidence-first-v1/.superpowers/sdd/progress.md

# Inspect preserved review classifications
for id in A-01 A-02 A-03; do
  node -e "const fs=require('fs'); const p='.worktrees/evidence-first-v1/.validation-runs/evidence/'+'$id'+'/review.json'; const x=JSON.parse(fs.readFileSync(p)); console.log('$id', x.scenarioVerdict, x.diagnosis)"
done

# Confirm target histories exclude local memory
if git log main --format='%H' -- .wolf/memory.md | grep -q .; then
  echo 'unexpected .wolf/memory.md in main history'
  exit 1
fi

# Inspect linked worktrees, backup, and stashes without deleting
git worktree list
git branch --list 'backup/evidence-first-v1-before-memory-history-cleanup'
git stash list
```

## 13. Do Not Do These on Takeover

- Do not run `git clean`, `git reset --hard`, broad `git restore`, or broad `git checkout`.
- Do not delete `.validation-runs/`, either validation worktree, either agent worktree, the backup branch, or either stash without explicit approval.
- Do not push the backup branch; it intentionally preserves sensitive pre-rewrite history.
- Do not stage with `git add .` or `git add -A`; stage only reviewed files by explicit path.
- Do not push, open a PR, merge, amend, or rewrite history without explicit instruction.
- Do not rewrite A-01/A-02/A-03 `review.json` files.
- Do not call Claude using an old approval or old run ID.
- Do not treat the A-04 preparation branch's local `fixture-01` / `contracts/A-04.json` as preserved real-run evidence.
- Do not render or run real A-04 with reused preserved-evidence paths.
- Do not silently choose the proposed `550000` token budget; obtain exact approval.
- Do not classify a run as PASS because executor-captured tests passed; controller-owned required checks and verifier evidence govern success.
- Do not begin V2 design until evidence-first A-E validation is complete or the user explicitly changes that priority.
- Do not assume the local A-04 preparation branch is final merely because its focused tests pass; review its latest committed state before using it as the basis for any real paid Scenario A invocation.
