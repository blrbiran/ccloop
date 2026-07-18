# ccloop Handover

> Updated: 2026-07-17
> Scope: V1 baseline, the in-progress evidence-first validation branch, preserved real-run evidence, and the exact recovery point for the next agent.
> Snapshot note: verify all status facts against Git and the filesystem before acting. Current code and evidence override this document if they differ.

## 1. Current Repository State

### Main checkout

- Path: `/Users/biran/code/skills/loop/ccloop`
- Branch: `main`
- HEAD: `4460fca` (`docs: add ccloop V1 handover`)
- V1 remains complete on `main`; the evidence-first validation work has not been merged or pushed.
- Current main-checkout changes are intentional and must not be overwritten, cleaned, or broadly staged:

```text
 M .gitignore
 M .wolf/cerebrum.md
?? docs/ccloop-v2-review-backlog.md
?? docs/superpowers/plans/2026-07-17-evidence-first-v1-validation.md
?? docs/superpowers/specs/2026-07-17-evidence-first-v1-validation-design.md
```

The `.gitignore` change adds `reference/oh-my-openagent`. The three untracked documents are approved design/plan inputs and are also copied into the validation worktree.

### Evidence-first validation worktree

- Path: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1`
- Branch: `evidence-first-v1`
- HEAD: `cb5ce5b201e8ef0c99dbf39cd32ffe0927115f83` (`fix: ignore non-finite Claude usage`)
- The branch contains committed validation-kit work and two confirmed fixes. It is not merged or pushed.
- The user authorized task-scoped commits on this isolated branch, but did not authorize pushing.
- Generated fixtures, contracts, runs, and evidence are under `.validation-runs/` and are intentionally ignored.
- Preserve the worktree and all `.validation-runs/` evidence. Do not clean, reset, reinitialize, or reuse a run directory.
- The worktree also contains expected scratch/untracked material, including SDD briefs/reports, copied design docs, `dist/`, and OpenWolf metadata. Consult `git status` before staging anything.

### Other linked worktree

`git worktree list` also showed:

```text
/Users/biran/code/skills/loop/ccloop/.claude/worktrees/agent-a7587a5bdc14743ba  4460fca [worktree-agent-a7587a5bdc14743ba]
```

It was created by a Task 4 subagent. Do not remove it without auditing its state and obtaining approval if removal could affect user data.

### Verification baseline

- Original V1 baseline on `main`: 10 test files, 66 tests passing.
- Validation branch after the latest fixes: 13 test files, 104 tests passing.
- Latest focused runtime regression check at `cb5ce5b`: 20/20 tests passing in `tests/runtime/claude/subprocessClaudeAdapter.test.ts`.
- Typecheck and build passed after the latest token-accounting fixes.
- `npm ci` reported 5 vulnerabilities across all dependencies: 3 moderate, 1 high, and 1 critical. No dependency remediation was authorized. Treat this output as observational; do not run `npm audit fix` or modify dependencies without separate approval.
- An older safety stash may still exist as `stash@{0}` with message `pre-merge local changes 2026-07-16`. Inspect it before any decision to drop it.

## 2. V1 Positioning

ccloop V1 is a contract-first TypeScript CLI for one code-task loop in one repository. It uses L2 assisted autonomy and prioritizes controllability and explicit stopping over maximum autonomy.

V1 supports:

- strict JSON loop-contract validation
- explicit run states and legal transitions
- bounded attempts, phase timeouts, runtime budget, and token budget
- isolated git worktrees per attempt
- planner, executor, and verifier phase separation
- deterministic scripted adapter for tests and examples
- subprocess-based Claude adapter and wrapper
- complete and partial execute outcomes
- bounded execute-only partial-outcome recovery
- path allowlist/denylist and max-files human gates
- real execution of required verification commands
- durable contract, state, events, logs, diffs, and per-attempt artifacts
- preserving the attempt worktree for `blocked_waiting_human`

V1 intentionally does not provide multi-loop coordination, automatic push/merge, resume of a blocked run, multi-runtime orchestration, scheduling, or unattended L3 operation.

## 3. Evidence-First Validation Initiative

### Approved design and plan

Read these before continuing:

1. `docs/superpowers/specs/2026-07-17-evidence-first-v1-validation-design.md`
2. `docs/superpowers/plans/2026-07-17-evidence-first-v1-validation.md`
3. `docs/ccloop-v2-review-backlog.md`

The governing decision is evidence-first:

- exercise real Claude behavior before automating it;
- keep experiment-derived evidence separate from product behavior;
- change product code only for a confirmed `FAIL / PRODUCT_DEFECT`;
- defer V2 ownership, reconciliation, resume, scheduler, and durable publication;
- require explicit approval before every real Claude call, including its budgets;
- use a fresh contract, run directory, and evidence directory for every invocation;
- never retry a real scenario automatically.

The V2 backlog is review input, not an approved V2 design or scope commitment.

### Durable SDD recovery ledger

The authoritative task-progress record is:

```text
.worktrees/evidence-first-v1/.superpowers/sdd/progress.md
```

Recorded status:

```text
Task 1: complete — disposable fixture and safety boundary
Task 2: complete — strict A-E contract renderer
Task 3: complete — single-scenario evidence harness
Task 4: complete — operator procedure and deterministic preflight
Task 3 supplement: complete — nested evidence-parent defect fixed
Task 5 A-01: inconclusive — harness failed before controller launch
Task 5 A-02: inconclusive — planning exhausted the 50k token budget
Task 5 A-03: inconclusive — execution completed but 100k exhausted before verify
Token-accounting defect: complete — alias dedupe and finite-value guards
```

Do not redispatch Tasks 1–4. Resume at the Task 5 / A-04 decision point only after reading the ledger and preserved evidence.

### Validation kit

Committed validation files live under:

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

Important behavior:

- `create-fixture.ts` creates a disposable one-commit Git repository and refuses overwrite.
- `render-contract.ts` renders strict A-E contracts and refuses overwrite.
- `run-scenario.ts` runs one explicit scenario, never retries, captures process/run evidence, and refuses stale run/evidence paths.
- `finalize-review.ts` writes a human-selected verdict exactly once.
- Scenario verdict and diagnosis are separate:

```text
scenarioVerdict: PASS | FAIL | INCONCLUSIVE
diagnosis: PRODUCT_DEFECT | RUNTIME_VARIANCE | ENVIRONMENT_FAILURE | CONTRACT_GAP | null
```

- Artifact status values are:

```text
PRESENT | NOT_PRODUCED | NOT_RUN | MISSING | INVALID
```

## 4. Preserved Real-Run Evidence

All evidence paths below are relative to `.worktrees/evidence-first-v1`.

### A-01

- Contract: `.validation-runs/contracts/A-01.json`
- Review: `.validation-runs/evidence/A-01/review.json`
- Historical verdict: `INCONCLUSIVE / ENVIRONMENT_FAILURE`
- The approved invocation failed before controller or Claude launch because `run-scenario.ts` tried to create the nested evidence leaf while its parent did not exist.
- No run directory was produced.
- The historical review is immutable and was not overwritten after root-cause analysis.
- Subsequent debugging reclassified the cause as a harness defect, not an environment, Claude, or ccloop-controller failure.

### A-02

- Contract: `.validation-runs/contracts/A-02.json`
- Run: `.validation-runs/runs/A-02/`
- Evidence: `.validation-runs/evidence/A-02/`
- Review: `.validation-runs/evidence/A-02/review.json`
- Verdict: `INCONCLUSIVE / RUNTIME_VARIANCE`
- Contract token budget: 50,000.
- Planning reported `tokenUsage: 60158`; the controller safely exhausted before execute/verify.
- The main fixture checkout stayed unchanged, the attempt worktree was removed, and no survivor process remained.

### A-03

- Contract: `.validation-runs/contracts/A-03.json`
- Run: `.validation-runs/runs/A-03/`
- Evidence: `.validation-runs/evidence/A-03/`
- Review: `.validation-runs/evidence/A-03/review.json`
- Historical verdict: `INCONCLUSIVE / RUNTIME_VARIANCE`
- The generated contract was explicitly changed from a 50,000 to 100,000 token budget after separate approval and was revalidated through the product schema.
- Planning reported `19882` tokens.
- Execution reported `440874` tokens under the pre-fix wrapper.
- Execution produced only the intended changes to `src/counter.js` and `test/counter.test.js`, and its captured `npm test` output passed.
- The controller exhausted before controller-owned required checks and verifier evidence completed, so the run cannot be PASS.
- Fixture checkout, worktree cleanup, and process-survivor evidence were safe.
- Independent review observed that `CONTRACT_GAP` may describe the unclosed evidence chain more precisely, but the immutable historical review was not overwritten.
- Do not assume the `440874` value proves real usage. The raw Claude usage envelope was not persisted, and the old wrapper had a confirmed alias-duplication defect. Historical A-03 cannot prove that both aliases were present in that specific run.

### Unrun scenarios

- No successful Scenario A evidence exists yet.
- Scenarios B, C, D, and E have not been run with real Claude.
- Task 5 remains incomplete.
- The user chose to pause and start a new session rather than approve A-04 in the previous session. There is no standing approval for A-04 or any later call.

## 5. Confirmed Defects and Fixes on `evidence-first-v1`

### Nested evidence-parent creation

- Symptom: A-01 failed with `ENOENT` before controller launch.
- Root cause: `run-scenario.ts` created a fresh nested evidence leaf with `recursive: false` but did not create its parent.
- Fix commit: `10dbac2` (`fix: create nested evidence parent`).
- Fix: create only `dirname(evidenceDir)` recursively after freshness checks, then create the leaf non-recursively.
- Safety properties preserved:
  - existing evidence directory is still rejected without overwrite;
  - existing run directory is still rejected without harvesting stale data;
  - the harness does not precreate `runDir`.
- Verification after fix: 19 focused evidence tests and 98 full tests passed; review clean.

### Claude token-usage alias duplication

- Root cause: `scripts/claude-phase-runner.mjs:getTokenUsage()` summed both snake_case and camelCase aliases from the same usage object.
- Confirmed synthetic failure: a dual-alias envelope with 100 input and 25 output returned 250 instead of 125.
- Fix commit: `8b69ef0` (`fix: dedupe Claude usage aliases`).
- Final semantics:
  - choose finite `input_tokens`, otherwise finite `inputTokens`;
  - choose finite `output_tokens`, otherwise finite `outputTokens`;
  - sum only the chosen input and output values;
  - return undefined when no finite values are available or total is nonpositive.

### Non-finite usage values

- Valid JSON such as `1e400` parses as `Infinity`.
- The initial alias fix used `typeof value === "number"`, which incorrectly accepted non-finite values.
- Fix commit: `cb5ce5b` (`fix: ignore non-finite Claude usage`).
- The wrapper now uses `Number.isFinite` and falls back to a finite alias when available.
- Final verification: 20 focused runtime tests and 104 full tests passed; typecheck/build passed; review clean.

These token fixes are product/runtime changes on the feature branch. They have not been merged into `main`.

## 6. Compact V1 Architecture

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

### Contract

`src/contract/schema.ts` defines the strict V1 contract. Important execution fields include:

- `maxAttempts`
- `perAttemptTimeoutMs`
- `totalRuntimeBudgetMs`
- `tokenBudget`
- `partialOutcomeRecoveryWindowMs`
- `worktreeRequired: true`

Unknown fields are rejected. `terminalStates` must contain the complete V1 terminal-state set.

### Controller

`src/controller/runLoop.ts` owns:

- state transitions and attempt accounting
- phase timeout and budget enforcement
- worktree lifecycle
- path-policy and human-gate precedence
- execution of `requiredChecks`
- verification evidence enforcement
- retry, success, blocking, exhaustion, cancellation, and failure decisions
- persistence of events and artifacts

The executor cannot declare success. Controller policy plus controller-owned verification evidence determines success.

### Runtime adapters and wrapper

- `src/runtime/types.ts` defines phase contracts and `AttemptContext`.
- Execute receives the current plan.
- Verify receives the plan and execution result.
- `src/runtime/scriptedAdapter.ts` is deterministic.
- `src/runtime/claude/subprocessClaudeAdapter.ts` invokes the configured wrapper.
- `scripts/claude-phase-runner.mjs` invokes Claude CLI with structured JSON and owns interrupted execute recovery.

### Verification

- `verifierType: "command"`: required commands decide verification; agent verifier is not called.
- `verifierType: "agent"`: required commands run first; agent verifier runs only after they pass.
- `evidenceRequired` and `rejectOn` are enforced against normalized verifier output.

### Persistence and worktrees

```text
runDir/
  loop-contract.json
  loop-state.json
  events.jsonl
  attempts/<n>/
    plan.json
    execution.json
    verify.json
    diff.patch
    stdout-stderr.log
```

- A run directory must be fresh.
- `blocked_waiting_human` retains its attempt worktree.
- Retry and non-human terminal paths clean the attempt worktree after persistence.
- V1 never falls back to editing the main checkout.

## 7. Safety Boundaries

- `blocked_waiting_human` is terminal for the automated V1 run; there is no resume.
- Denylist wins over allowlist.
- Execute-stage path gates outrank same-phase budget exhaustion.
- `retryable` is a controller decision, not a persisted state.
- Execute timeout triggers abort and a bounded execute-only recovery window.
- No automatic push, PR creation, merge, or external write.
- Real Claude calls require explicit per-call approval with visible attempt, timeout, runtime, and token budgets.
- `tokenBudget` is a controller stopping threshold based on reported usage; it is not a guaranteed API-cost cap.
- Never reuse, delete, or overwrite `.validation-runs/` evidence.
- Never infer a product defect solely from model wording, exact timing, or a historical token value whose raw usage envelope was not preserved.

## 8. Key Entry Points

### Current design and planning

- `docs/superpowers/specs/2026-07-17-evidence-first-v1-validation-design.md`
- `docs/superpowers/plans/2026-07-17-evidence-first-v1-validation.md`
- `docs/ccloop-v2-review-backlog.md`
- `.worktrees/evidence-first-v1/.superpowers/sdd/progress.md`

### Validation operation and reports

- `.worktrees/evidence-first-v1/validation/v1/README.md`
- `.worktrees/evidence-first-v1/.superpowers/sdd/task-5-report.md`
- `.worktrees/evidence-first-v1/.superpowers/sdd/task-5-debug.md`
- `.worktrees/evidence-first-v1/.superpowers/sdd/task-5-token-debug.md`
- `.worktrees/evidence-first-v1/.validation-runs/evidence/A-01/`
- `.worktrees/evidence-first-v1/.validation-runs/evidence/A-02/`
- `.worktrees/evidence-first-v1/.validation-runs/evidence/A-03/`

### V1 implementation

- `src/cli.ts`
- `src/contract/schema.ts`
- `src/controller/runLoop.ts`
- `src/stop/stopController.ts`
- `src/state/stateMachine.ts`
- `src/runtime/types.ts`
- `src/runtime/claude/subprocessClaudeAdapter.ts`
- `scripts/claude-phase-runner.mjs`
- `src/policy/pathPolicy.ts`
- `src/persistence/fileStore.ts`
- `src/workspace/worktreeManager.ts`

### Principal tests

- `tests/controller/runLoop.integration.test.ts`
- `tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- `tests/validation/fixture.test.ts`
- `tests/validation/contracts.test.ts`
- `tests/validation/evidence.test.ts`

## 9. Known Limitations and Open Decisions

- No successful real-Claude A scenario has completed the full plan/execute/required-check/verifier chain.
- Raw Claude usage envelopes are not persisted, so historical token normalization cannot be reconstructed after a run.
- A-03 cannot prove whether its execution token value was a legitimate total or alias duplication.
- `claudeChildExited` remains `NOT_OBSERVABLE` unless a tracked descendant PID can be confirmed; `survivorPids: []` still provides useful cleanup evidence.
- No resume/reconciliation flow exists.
- No scheduler, daemon, queue, lease, heartbeat, or stale-run watchdog exists.
- No multi-task coordination or repository-level locking exists outside attempt worktrees.
- Path matching remains intentionally small: exact, `**`, and directory-prefix `/**`.
- Token accounting depends on optional adapter-reported usage and currently excludes an explicit raw-usage audit record.
- V1 rejects existing run directories instead of resuming them.

Open A-04 decision:

- No A-04 call is approved.
- A fresh session must decide whether to:
  1. run A-04 after the token fixes with a separately approved budget; or
  2. first design a minimal, non-sensitive raw-usage evidence mechanism.
- Do not silently choose a 350k or 550k budget. Present the exact proposed call and obtain explicit approval.
- Any A-04 uses fresh paths; never reuse A-01/A-02/A-03.

## 10. Exact Takeover Procedure

Start in the repository root and inspect, without cleaning:

```bash
git status --short
git log -5 --oneline
git worktree list

git -C .worktrees/evidence-first-v1 status --short
git -C .worktrees/evidence-first-v1 log -12 --oneline
git -C .worktrees/evidence-first-v1 show -s --format='%H %s' HEAD
```

Read, in order:

1. `docs/handover/ccloop-handover.md`
2. `.worktrees/evidence-first-v1/.superpowers/sdd/progress.md`
3. `docs/superpowers/specs/2026-07-17-evidence-first-v1-validation-design.md`
4. `docs/superpowers/plans/2026-07-17-evidence-first-v1-validation.md`
5. `.worktrees/evidence-first-v1/validation/v1/README.md`
6. `.worktrees/evidence-first-v1/.superpowers/sdd/task-5-report.md`
7. `.worktrees/evidence-first-v1/.superpowers/sdd/task-5-token-debug.md`
8. the A-02/A-03 review and run artifacts relevant to the next decision

Verify the branch before proceeding:

```bash
npm --prefix .worktrees/evidence-first-v1 test
npm --prefix .worktrees/evidence-first-v1 run typecheck
npm --prefix .worktrees/evidence-first-v1 run build
```

Expected latest verified branch state:

- HEAD `cb5ce5b`
- 13 test files, 104 tests passing
- 20 runtime Claude tests passing
- typecheck/build passing

Then:

1. Do not redispatch Tasks 1–4; trust the SDD ledger and Git history.
2. Do not remove any linked worktree or generated evidence.
3. Do not rewrite A-01/A-02/A-03 `review.json` files.
4. If continuing A, propose A-04 with exact budgets and obtain explicit approval.
5. Run exactly once with fresh `A-04` contract/run/evidence paths.
6. Review and finalize its evidence before considering B.
7. If a new `FAIL / PRODUCT_DEFECT` is confirmed, stop scenario progression, invoke systematic debugging, write a focused regression, implement the minimum approved fix, and re-review before any paid retry.
8. After A succeeds, continue B, then timeout-calibrated C/D, then E, each with separate approval.
9. Complete the evidence report and broad branch review before proposing merge.

## 11. Useful Commands

```bash
# Feature-branch verification
npm --prefix .worktrees/evidence-first-v1 test
npm --prefix .worktrees/evidence-first-v1 run typecheck
npm --prefix .worktrees/evidence-first-v1 run build

# Focused Claude-wrapper regressions
npm --prefix .worktrees/evidence-first-v1 test -- \
  --run tests/runtime/claude/subprocessClaudeAdapter.test.ts

# Read durable progress
grep -n '^Task\|^Token accounting' \
  .worktrees/evidence-first-v1/.superpowers/sdd/progress.md

# Inspect preserved review classifications
for id in A-01 A-02 A-03; do
  node -e "const fs=require('fs'); const p='.worktrees/evidence-first-v1/.validation-runs/evidence/'+'$id'+'/review.json'; const x=JSON.parse(fs.readFileSync(p)); console.log('$id', x.scenarioVerdict, x.diagnosis)"
done

# Inspect linked worktrees without removing them
git worktree list

# Inspect old safety stash before any possible deletion
git stash list
git stash show --stat stash@{0}
```

## 12. Do Not Do These on Takeover

- Do not run `git clean`, `git reset --hard`, broad `git restore`, or broad `git checkout`.
- Do not delete `.validation-runs/`, the validation worktree, the agent worktree, or the old stash without explicit approval.
- Do not stage with `git add .` or `git add -A`; stage only reviewed files by explicit path.
- Do not push, open a PR, merge, or amend without explicit instruction.
- Do not assume the copied design/plan/backlog documents are committed; verify status first.
- Do not call Claude using an old approval or old run ID.
- Do not classify an inconclusive run as PASS because executor-captured tests passed; controller-owned required checks and verifier evidence still govern success.
