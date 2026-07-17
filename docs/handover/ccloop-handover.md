# ccloop Handover

> Updated: 2026-07-16
> Scope: current V1 implementation state and the minimum context needed to continue development.
> Snapshot note: verify status facts against the repository before acting; this handover file was the only uncommitted project file when reviewed.

## 1. Current Status

- Branch: `main`
- Handover baseline commit: `1c6c76e` (`docs: align loop framework design with V1`)
- Before this handover file was created, the working tree was clean. At review time, `docs/handover/ccloop-handover.md` was the only uncommitted project file.
- Only the main git worktree remains. The implementation and temporary agent worktrees were audited and removed.
- `.wolf/anatomy.md` was refreshed with `openwolf scan` after worktree cleanup; stale deleted-worktree entries were removed.
- Full test suite: 10 files, 66 tests passing.
- Production dependency audit: 0 vulnerabilities from `npm audit --omit=dev --audit-level=high`.
- An old safety backup may still exist as `stash@{0}` with message `pre-merge local changes 2026-07-16`. Inspect it before deciding whether to drop it.

The V1 implementation is complete and merged into `main`. At review time, local `main` and `origin/main` were synchronized at `1c6c76e`.

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

V1 intentionally does not provide multi-loop coordination, automatic push/merge, resume of a blocked run, multi-runtime orchestration, or unattended L3 operation.

## 3. Compact Architecture

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

`src/contract/schema.ts` defines the strict V1 contract. The wire format uses camelCase. Important execution fields include:

- `maxAttempts`
- `perAttemptTimeoutMs`
- `totalRuntimeBudgetMs`
- `tokenBudget`
- `partialOutcomeRecoveryWindowMs`
- `worktreeRequired: true`

Unknown fields are rejected. `terminalStates` must contain the complete V1 terminal-state set.

### Controller

`src/controller/runLoop.ts` is authoritative for:

- state transitions and attempt accounting
- phase timeout and budget enforcement
- worktree lifecycle
- path-policy and human-gate precedence
- execution of `requiredChecks`
- verification evidence enforcement
- retry, success, blocking, exhaustion, cancellation, and failure decisions
- persistence of events and artifacts

The controller does not infer partial execution outcomes by scanning a workspace. That recovery belongs to the runtime adapter/wrapper boundary.

### Runtime adapters

`src/runtime/types.ts` defines the phase contracts and `AttemptContext`.

Phase context is threaded forward:

- execute receives the current plan
- verify receives the current plan and execution result

`execute()` may return:

- a complete execution result
- a structured partial result for timeout/error recovery
- no result after timeout/abort

`src/runtime/scriptedAdapter.ts` is deterministic and used by tests/examples. `src/runtime/claude/subprocessClaudeAdapter.ts` invokes the configured wrapper command.

### Claude wrapper

`scripts/claude-phase-runner.mjs` invokes Claude CLI with structured JSON output. For interrupted or failed execute phases it can recover a partial outcome containing changed files, logs, and a restorable patch.

Partial patches include:

- tracked staged changes
- tracked unstaged changes
- brand-new untracked files

### Verification

`requiredChecks` are executed inside the attempt worktree.

- `verifierType: "command"`: command results determine verification; the agent verifier is not called.
- `verifierType: "agent"`: required checks run first; the agent verifier runs only after they pass.

A successful result must satisfy `evidenceRequired`. `rejectOn` and evidence requirements are included in verifier prompts and checked against normalized verifier output.

### Persistence and worktrees

`src/persistence/fileStore.ts` writes:

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

A run directory must be fresh. V1 rejects reuse rather than overwriting prior state or implicitly resuming.

`src/workspace/worktreeManager.ts` creates detached attempt worktrees under `runDir/worktrees/attempt-<n>`.

- `blocked_waiting_human`: preserve worktree for handoff
- retry or non-human terminal state: remove worktree after persistence
- worktree creation: one infrastructure retry, then block for human input
- never fall back to editing the main checkout

## 4. Key Decisions and Safety Boundaries

- Autonomy levels are L1/L2/L3; V1 defaults to L2 assisted.
- `blocked_waiting_human` is terminal for the current automated run. Human continuation means manual handoff or a new run, not resume of the same run.
- Denylist always wins over allowlist.
- Execute-stage path-policy human gates outrank same-phase budget exhaustion.
- The executor cannot declare success. Controller policy plus verification evidence decides success.
- `retryable` is a controller decision, not a persisted run state.
- Execute timeout triggers abort and an execute-only recovery window bounded by `partialOutcomeRecoveryWindowMs`.
- Task 8/controller consumes final execute outcomes; Task 9/adapter-wrapper owns partial-outcome recovery.
- No automatic push, PR creation, merge, or external write in V1.

## 5. Key Entry Points

### Design and plan

- `docs/superpowers/specs/2026-07-14-loop-engineer-framework-design.md`
- `docs/superpowers/plans/2026-07-14-loop-engineer-framework-v1-implementation.md`

### Core implementation

- `src/cli.ts` — CLI parsing and dispatch
- `src/contract/schema.ts` — strict contract schema
- `src/controller/runLoop.ts` — orchestration kernel
- `src/stop/stopController.ts` — normalized stop decisions
- `src/state/stateMachine.ts` — legal state transitions
- `src/runtime/types.ts` — adapter and phase interfaces
- `src/runtime/claude/subprocessClaudeAdapter.ts` — Claude adapter
- `scripts/claude-phase-runner.mjs` — real Claude subprocess wrapper
- `src/policy/pathPolicy.ts` — path safety policy
- `src/persistence/fileStore.ts` — durable run records
- `src/workspace/worktreeManager.ts` — attempt worktrees

### Tests and examples

- `tests/controller/runLoop.integration.test.ts` — principal behavioral coverage
- `tests/runtime/claude/subprocessClaudeAdapter.test.ts` — wrapper and partial-recovery coverage
- `tests/contract/loadContract.test.ts` — contract validation
- `examples/v1/minimal-contract.json`
- `examples/v1/scripted-adapter-config.json`
- `examples/v1/claude-adapter-config.json`

## 6. Known Limitations

- No resume/reconciliation flow for blocked or interrupted runs.
- No scheduler, daemon, queue, or stale-run watchdog.
- No multi-task concurrency or locking outside per-attempt worktrees.
- No runtime adapter other than scripted and Claude subprocess.
- Path-pattern matching is intentionally small: exact match, `**`, and directory-prefix `/**` behavior.
- Claude adapter assumes the local `claude` CLI supports `-p`, `--output-format json`, and `--json-schema`.
- `rejectOn` enforcement is intentionally minimal string/evidence matching rather than a policy DSL.
- Token accounting depends on optional usage reported by adapters.
- V1 rejects existing run directories instead of resuming them.

## 7. Recommended Next Work

Recommended order:

1. **Run a real Claude-backed end-to-end task.** Validate the actual installed Claude CLI flags, structured-output envelope, abort behavior, and partial artifact recovery outside test fixtures.
2. **Add operator-facing documentation.** Document contract authoring, CLI usage, run-directory outputs, exit codes, and human-handoff workflow.
3. **Design V2 resume/reconciliation.** Define run ownership, stale-run detection, preserved-worktree adoption, resume commands, and crash recovery before adding a scheduler.
4. **Add scheduling only after reconciliation exists.** Scheduled unattended operation should not precede reliable stale-run and kill-switch handling.
5. **Add another runtime adapter** only after the adapter contract has been validated with the real Claude path.

Do not start L3 unattended operation until V1 has been exercised on real repositories and failure cases.

## 8. Takeover Checklist

A new agent should start with:

```bash
git status --short
git log -5 --oneline
git worktree list
npm ci
npm test
npm run typecheck
```

Expected baseline:

- branch: `main`
- no linked feature worktrees
- clean working tree
- 10 test files and 66 tests passing at the handover baseline

Then read, in order:

1. this handover
2. `docs/superpowers/specs/2026-07-14-loop-engineer-framework-design.md`
3. `src/contract/schema.ts`
4. `src/runtime/types.ts`
5. `src/controller/runLoop.ts`
6. the tests relevant to the next change

Before changing behavior, verify that the current repository state still matches this handover. Git history and current code override this snapshot if they differ.

## 9. Useful Commands

```bash
# Full verification
npm test
npm run typecheck
npm run build

# Scripted example
node dist/cli.js run \
  --contract examples/v1/minimal-contract.json \
  --run-dir .runs/example-scripted \
  --adapter scripted \
  --adapter-config examples/v1/scripted-adapter-config.json

# Production dependency audit
npm audit --omit=dev --audit-level=high

# Inspect the retained safety stash before deleting it
git stash list
git stash show --stat stash@{0}
```
