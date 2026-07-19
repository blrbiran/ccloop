# ccloop Handover

> Updated: 2026-07-18
> Scope: merged V1 validation work, Claude usage-evidence hardening, preserved A-01 through A-03 evidence, and the exact A-04 decision point.
> Snapshot rule: verify every status claim against Git and the filesystem before acting. Current code and immutable evidence override this document if they differ.

## 1. Current Repository State

### Main checkout

- Path: `/Users/biran/code/skills/loop/ccloop`
- Branch: `main`
- HEAD: `3c7cb267129c7337f510d1e59cbe9d00662a121a` (`add backlog / spec and handover docs`)
- Local Git currently reports `main == origin/main`.
- The evidence-first validation implementation, Claude usage-evidence changes, validation documents, and backlog are merged into `main`.
- Current intentional main-checkout change: `M docs/handover/ccloop-handover.md` from this handover refresh.
- Do not overwrite, discard, or broadly stage it. Inspect status again before acting; if this refresh has since been committed, the checkout may be clean.

### Evidence-first validation worktree

- Path: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1`
- Branch: `evidence-first-v1`
- HEAD: `d513e01ab5e2c7689e4170e98c0eb2b8236ced5e` (`docs: record final usage evidence verification`)
- `main` is two commits ahead of this branch and the branch has no commits absent from `main`.
- The worktree remains the home of ignored real-run evidence under `.validation-runs/`.
- It intentionally contains dirty/untracked SDD reports, copied documents, OpenWolf metadata, and `dist/`. Do not clean, reset, reinitialize, or broadly stage it.
- Product/runtime work from this branch is already on `main`; preserving the linked worktree is still required because its ignored A-01 through A-03 evidence is not in Git.

### Backup branch and sensitive history

- Local backup branch: `backup/evidence-first-v1-before-memory-history-cleanup`.
- It preserves the pre-rewrite branch state, including commits `73fa00e` and `e0d3fb1`, which temporarily contained `.wolf/memory.md`.
- `main` and `evidence-first-v1` do not contain `.wolf/memory.md` in their reachable history.
- Both sensitive commits are reachable only from the local backup branch.
- Never push or publish the backup branch. Do not delete it without explicit approval.

### Other linked worktree

```text
/Users/biran/code/skills/loop/ccloop/.claude/worktrees/agent-a7587a5bdc14743ba  4460fca [worktree-agent-a7587a5bdc14743ba]
```

It was created by an earlier subagent. Do not remove it without auditing its state and obtaining approval if removal could affect user data.

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

Fresh verification on `main` at `3c7cb26`:

- 13 test files, 114 tests passing;
- `npm run typecheck` passing;
- `npm run build` passing;
- final whole-increment review: `APPROVE`, with no Critical, Important, or Minor findings;
- target branch history verified free of `.wolf/memory.md`;
- no real Claude call occurred during usage-evidence implementation or validation;
- A-04 has not been run.

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
5. `docs/ccloop-v2-review-backlog.md`
6. `.worktrees/evidence-first-v1/.superpowers/sdd/progress.md`

The governing decisions are:

- exercise real Claude behavior before adding automation;
- keep experiment-derived evidence separate from product behavior unless real evidence proves a product gap;
- change product code only for a confirmed `FAIL / PRODUCT_DEFECT`;
- require explicit approval before every real Claude invocation, including exact budgets and paths;
- use fresh contract, run, and evidence paths for every invocation;
- never retry a real scenario automatically;
- defer V2 ownership, reconciliation, resume, scheduling, concurrency, and durable publication until evidence-first V1 validation is complete;
- use models for judgment, not deterministic routing, retries, state transitions, or persistence.

The V2 backlog is review input, not an approved V2 design or scope commitment.

## 4. Durable Progress

The authoritative task ledger is:

```text
.worktrees/evidence-first-v1/.superpowers/sdd/progress.md
```

Recorded outcome:

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

Do not redispatch completed tasks. Resume at the Task 5 / A-04 preparation and approval point.

## 5. Validation Kit

Committed validation files:

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

Key behavior:

- `create-fixture.ts` creates a disposable one-commit Git repository and refuses overwrite.
- `render-contract.ts` renders strict A-E contracts and refuses overwrite.
- `run-scenario.ts` runs exactly one explicit scenario, never retries, captures process/run evidence, and rejects stale run/evidence paths.
- `finalize-review.ts` writes a human-selected verdict exactly once.
- Validation CLI tests create their own temporary Git repositories; they no longer depend on ignored `.validation-runs/fixture-smoke` state.

Verdict and diagnosis remain separate:

```text
scenarioVerdict: PASS | FAIL | INCONCLUSIVE
diagnosis: PRODUCT_DEFECT | RUNTIME_VARIANCE | ENVIRONMENT_FAILURE | CONTRACT_GAP | null
```

Artifact statuses:

```text
PRESENT | NOT_PRODUCED | NOT_RUN | MISSING | INVALID
```

## 6. Claude Usage Evidence

The completed usage-evidence increment closes the audit gap that made A-03's historical token total impossible to reconstruct.

For each successful Claude-backed plan, execute, or verify result, the standard phase artifact may now include:

- the four supported aliases only: `input_tokens`, `inputTokens`, `output_tokens`, `outputTokens`;
- per-field status: `absent`, `finite`, `non_finite`, or `invalid_type`;
- the selected input and output alias;
- `normalizedTotal`;
- `tokenUsage`, present only when it equals a finite positive `normalizedTotal`.

Semantics:

- finite snake_case wins over the matching camelCase alias;
- aliases are alternatives and are never double-counted;
- unknown usage fields, prompts, assistant text, credentials, and complete envelopes are not persisted;
- zero, negative, or non-finite totals do not produce `tokenUsage`;
- interrupted/error fallback partial execution does not invent usage evidence from incomplete stdout;
- the controller consumes the wrapper-provided `tokenUsage` and does not run a second alias-normalization algorithm.

Deterministic coverage proves:

- alias selection, invalid values, non-finite values, negative/zero totals, and finite-sum overflow;
- unknown/synthetic secret fields are not persisted;
- plan, execution, and verify artifacts retain the same totals the controller deducts from the token budget;
- old artifacts without `usageEvidence` remain readable by the real evidence collector.

Principal commits on `main` include:

```text
65aaf8b feat: persist Claude usage evidence
550065f test: cover Claude usage evidence boundaries
a5fdac7 test: cover negative-total usage evidence case
675fee3 test: verify Claude usage accounting end to end
38055b3 test: characterize legacy usage-evidence artifacts
280ec58 test: isolate validation contract fixtures
```

Historical A-01 through A-03 artifacts remain immutable and are not retroactively reconstructed.

## 7. Preserved Real-Run Evidence

All paths below are relative to `.worktrees/evidence-first-v1`. The `.validation-runs/` tree currently contains 98 files. Preserve all of them.

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

## 8. A-04 Decision Point

A-04 has not been approved, rendered, or run. Verified fresh paths are currently absent:

```text
.validation-runs/contracts/A-04.json
.validation-runs/runs/A-04
.validation-runs/evidence/A-04
```

The preserved fixture is:

```text
.validation-runs/fixture-01
HEAD 93a26e6ec721ebe7c675d78819b381b9102da832
one commit
clean working tree at the latest check
```

### Recommended next action

Prepare A-04 without making a paid call:

1. Recheck the fixture is clean and all A-04 paths are absent.
2. Render a fresh Scenario A contract to `contracts/A-04.json`.
3. If using a non-default token budget, change only `executionPolicy.tokenBudget` and revalidate through the product schema.
4. Run all deterministic preflight checks.
5. Present the exact call and budgets to the user.
6. Wait for explicit approval before invoking `run-scenario.ts`.

A conservative proposed A-04 envelope is:

```text
scenario: A
attempts: 1
per-attempt timeout: 300000ms
total runtime budget: 600000ms
partial outcome recovery window: 3000ms
token budget: 550000 (proposal only)
automatic retries: none
fresh paths: A-04 only
```

The 550,000 token threshold is a proposal, not authorization. It uses A-03's pre-fix reported values as a conservative upper bound while reserving room for verify. `tokenBudget` is a controller stopping threshold based on adapter-reported usage, not a guaranteed API-cost cap.

Before any real call, tell the user that one scenario invocation may launch up to three Claude phases: plan, execute, and verify. Obtain explicit approval for that exact invocation and budget.

### A-04 success condition

A-04 is successful only if the complete evidence chain agrees:

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

### 2026-07-19 merge-readiness baseline

- Reviewed against current Git/filesystem truth instead of stale handover snapshots.
- `main` reviewed at `3108c5c`.
- `a04-preflight-approval` committed head reviewed at `c3036dc`.
- Current local uncommitted files are being classified separately from committed branch value:
  - `.superpowers/sdd/progress.md`
  - `.superpowers/sdd/task-3-report.md`
  - `.wolf/memory.md`
  - `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
  - `package-lock.json`
- Preserved evidence remains under `.worktrees/evidence-first-v1/.validation-runs/` and has not been rewritten.

### 2026-07-19 committed-surface verdict

- Minimum committed-surface review set completed for:
  - `validation/v1/lib/a04.ts`
  - `validation/v1/lib/scenarios.ts`
  - `tests/validation/prepareA04.test.ts`
  - `tests/validation/contracts.test.ts`
  - `validation/v1/README.md`
  - `docs/handover/ccloop-handover.md`
  - `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
- Focused verification rerun:
  - `tests/validation/contracts.test.ts` — pass
  - `tests/validation/prepareA04.test.ts` — pass
  - `npm run typecheck` — pass
  - `npm run build` — pass
- Committed product surface verdict: `continue original branch tightening toward merge`
- This verdict does not authorize a paid Scenario A invocation.

### 2026-07-19 merge-surface classification

#### Committed changes worth preserving
- `validation/v1/lib/a04.ts`
- `validation/v1/lib/scenarios.ts`
- `validation/v1/scripts/prepare-a04.ts`
- `tests/validation/prepareA04.test.ts`
- `tests/validation/contracts.test.ts`
- `validation/v1/README.md`
- `docs/handover/ccloop-handover.md`
- `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`

#### Committed branch-internal changes not intended for `main`
- `.superpowers/sdd/task-2-report.md`
- `.superpowers/sdd/task-3-report.md`
- `.wolf/anatomy.md`
- `.wolf/buglog.json`
- `.wolf/cerebrum.md`
- `.wolf/memory.md`

#### Current uncommitted merge-surface
- `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`

#### Current uncommitted local-only
- `.superpowers/sdd/progress.md`
- `.superpowers/sdd/task-3-report.md`
- `.wolf/memory.md`

#### Current uncommitted unresolved
- `package-lock.json`

- Final branch verdict: `preserve branch but add one more tightening pass`

#### Next-step recommendation
- Keep using `.worktrees/a04-preflight-approval` as the assessment source of truth.
- Carry only the files listed under committed changes worth preserving toward `main`.
- Leave branch-internal OpenWolf and `.superpowers/sdd/` files out of the merge surface unless a later review proves one is required.
- Resolve `package-lock.json` explicitly before any merge/backport decision.
- Do not run a paid Scenario A call from this branch until a separate approval package is reviewed again.

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

Important boundaries:

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
```

Read in order:

1. `docs/handover/ccloop-handover.md`
2. `.worktrees/evidence-first-v1/.superpowers/sdd/progress.md`
3. `docs/superpowers/specs/2026-07-17-evidence-first-v1-validation-design.md`
4. `docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md`
5. `.worktrees/evidence-first-v1/validation/v1/README.md`
6. `.worktrees/evidence-first-v1/.superpowers/sdd/task-5-report.md`
7. `.worktrees/evidence-first-v1/.superpowers/sdd/task-5-token-debug.md`
8. A-02/A-03 review and run artifacts relevant to the A-04 budget decision

Verify `main` before proceeding:

```bash
npm test
npm run typecheck
npm run build
```

Expected latest verified state:

```text
main/origin HEAD: 3c7cb26
13 test files / 114 tests passing
typecheck passing
build passing
working tree: only this handover refresh may be modified unless it was committed after the snapshot
```

Then verify A-04 preconditions without running it:

```bash
git -C .worktrees/evidence-first-v1/.validation-runs/fixture-01 status --short

for path in \
  .worktrees/evidence-first-v1/.validation-runs/contracts/A-04.json \
  .worktrees/evidence-first-v1/.validation-runs/runs/A-04 \
  .worktrees/evidence-first-v1/.validation-runs/evidence/A-04; do
  test ! -e "$path" || { echo "unexpected existing path: $path"; exit 1; }
done
```

Do not create or execute A-04 until the exact contract and budget have been presented and explicitly approved.

## 12. Useful Commands

```bash
# Main verification
npm test
npm run typecheck
npm run build

# Focused usage-evidence regressions
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
- Do not delete `.validation-runs/`, the validation worktree, the agent worktree, the backup branch, or either stash without explicit approval.
- Do not push the backup branch; it intentionally preserves sensitive pre-rewrite history.
- Do not stage with `git add .` or `git add -A`; stage only reviewed files by explicit path.
- Do not push, open a PR, merge, amend, or rewrite history without explicit instruction.
- Do not rewrite A-01/A-02/A-03 `review.json` files.
- Do not call Claude using an old approval or old run ID.
- Do not render or run A-04 with reused paths.
- Do not silently choose the proposed 550,000 token budget; obtain exact approval.
- Do not classify a run as PASS because executor-captured tests passed; controller-owned required checks and verifier evidence govern success.
- Do not begin V2 design until evidence-first A-E validation is complete or the user explicitly changes that priority.
