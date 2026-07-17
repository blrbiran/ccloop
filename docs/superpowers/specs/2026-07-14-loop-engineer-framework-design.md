# Loop Engineer Framework Design

## Summary

This document defines a contract-first loop engineer framework for code-task execution. The framework is mixed-mode by design: the kernel is runtime-agnostic, while v1 uses a Claude adapter as the first execution backend. The primary goal is reliable stoppability under an L2 assisted autonomy model.

## Goals

- Build a runnable framework, not only a methodology document.
- Make stoppability a first-class property.
- Support a code-task loop as the first end-to-end scenario.
- Keep the kernel independent from any single agent runtime.
- Require durable state and evidence for every attempt.

## Non-Goals

- Multi-loop coordination.
- Auto-merge or unattended remote writes.
- Broad plugin ecosystems in the first release.
- Multi-runtime orchestration in the first release.
- Full L3 unattended autonomy in the first release.

## Core Design Decisions

1. The framework is contract-first. A loop contract is the source of truth for goal, scope, safety, verification, budget, and stop policy.
2. The framework uses a mixed-mode architecture. The kernel owns control logic; adapters invoke concrete runtimes.
3. The first supported operating model is L2 assisted autonomy.
4. Code-modifying attempts run in isolated worktrees.
5. Executors cannot declare success. Only verification evidence plus controller policy can end a run successfully.
6. Conversation history is not treated as durable system state.

## Architecture

### Loop Kernel

The kernel is the stable core of the framework. It owns:

- contract loading and validation
- run state transitions
- attempt lifecycle control
- stop decisions
- budget enforcement
- escalation decisions
- persistence of events and artifacts

### Runtime Adapter

The runtime adapter translates a contract-driven attempt into concrete planner, executor, and verifier runs. V1 includes one Claude adapter. Future adapters may target other agent runtimes without changing the kernel contract.

### Workspace Manager

The workspace manager creates and cleans up one isolated workspace per attempt. For code tasks, this is a git worktree by default.

### Stop Controller

The stop controller is separate from planning and execution. It evaluates terminal conditions after every meaningful transition.

## Autonomy Model

The framework uses three autonomy levels.

### Default autonomy for the first release: L2 assisted

L2 assisted means the system can:

- plan an attempt
- execute changes locally in an isolated workspace
- run verification
- propose retry or completion

L2 assisted does not mean the system can:

- push to remotes automatically
- merge changes automatically
- bypass human gates
- continue through repeated failure without review

### L1

Report-only or suggest-only operation. Useful when validating a new pattern or a new repository.

### L3

Unattended operation. This is explicitly out of scope for the first release.

## Loop Contract

The loop contract is the input to the kernel. V1 keeps it intentionally narrow and optimized for code-task loops.

### Objective

- `taskId`
- `goal`
- `successCondition`
- `nonGoals`

The success condition must be phrased so the verifier can judge it with evidence.

### Context

- `repoPath`
- `targetPaths`
- `relevantDocs`
- `buildTestCommands`
- `constraints`

### Execution Policy

- `autonomyLevel`
- `maxAttempts`
- `perAttemptTimeoutMs`
- `totalRuntimeBudgetMs`
- `tokenBudget`
- `worktreeRequired`

### Safety Policy

- `allowlistPaths`
- `denylistPaths`
- `maxFilesTouched`
- `humanGateConditions`

If a path matches both an allowlist and a denylist rule, the denylist always wins.

### Verification

- `verifierType`
- `requiredChecks`
- `rejectOn`
- `evidenceRequired`

### Escalation and Exit

- `escalationTargets`
- `pauseOn`
- `stopOn`
- `terminalStates`

`pauseOn` defines conditions that suspend autonomous progress and move the current automated run into `blocked_waiting_human` for human handoff. In V1, that ends the current automated run while preserving state, artifacts, and worktree for later human action. `stopOn` defines conditions that immediately end the run. `terminalStates` is the allowed set of persisted end states for a single automated run.

## State Machine

The controller manages explicit states:

- `queued`
- `planning`
- `executing`
- `verifying`
- `succeeded`
- `blocked_waiting_human`
- `exhausted`
- `cancelled`
- `failed`

A run must always end in an explainable terminal state.

## Attempt Flow

Each loop round is controller-driven and discrete.

1. **Plan**
   - Read contract, run state, and prior artifacts.
   - Produce a small attempt plan.
   - Refuse execution if the request falls outside contract scope.

2. **Execute**
   - Run inside an isolated workspace.
   - Produce changed files, command output, and structured execution notes.
   - Never declare task success.
   - After execution produces changed files, path-policy human gates are evaluated before any budget-based terminal decision. If execution already requires human handoff, the run ends as `blocked_waiting_human` and preserves the worktree even when the same phase also exhausted remaining budget.

3. **Verify**
   - Run the required checks.
   - Evaluate evidence against the success condition.
   - Prefer rejection-by-evidence over optimistic approval.

4. **Control**
   - Combine verifier output, budget status, and stop policy.
   - Decide one of: retryable, succeeded, blocked_waiting_human, exhausted, cancelled, failed.
   - `retryable` is a controller decision, not a persisted state. The controller records the retry reason, schedules the next attempt, updates attempt counters, and transitions the run back to `planning`.

The stop controller evaluates normalized control inputs derived from contract policy; it does not parse the loop contract directly.

## Human Gates

Under L2 assisted mode, human approval is required for:

- any retry after the first failed attempt on the same item
- touching denylisted or gated paths
- any push, merge, PR creation, or external write
- verifier rejection followed by a proposal to continue anyway
- any attempt that expands beyond the original contract scope

## Stop Policy

The stop controller evaluates rules in fixed priority order:

1. human cancel or kill switch
2. success condition satisfied
3. human gate or denylist hit
4. attempt limit reached
5. runtime, timeout, or token budget exhausted
6. repeated failure pattern detected

For V1, a repeated failure pattern means two consecutive failed attempts with the same verifier rejection category and the same primary target paths or failing command.
7. verifier rejection with no safe retry path

This order prevents the executor from drifting into endless self-extension.

## Durable State and Artifacts

V1 persists four classes of artifacts.

### 1. Contract

`loop-contract.json`

Static input describing the run.

### 2. Run State

`loop-state.json`

Fields include:

- `status`
- `currentAttempt`
- `attemptsUsed`
- `lastTransitionAt`
- `waitingOnHuman`
- `stopReason`
- `budgetSnapshot`

For V1, `budgetSnapshot` includes at least `attemptsRemaining`, `timeRemainingMs`, and `tokenBudgetRemaining`.

### 3. Attempt Artifacts

Per-attempt records under `attempts/<n>/`:

- `plan.json`
- `execution.json`
- `verify.json`
- `diff.patch`
- `stdout-stderr.log`

### 4. Event Ledger

`events.jsonl` or `runs.jsonl`

One appended event per transition, such as:

- `attempt_started`
- `execution_finished`
- `verification_rejected`
- `loop_paused`
- `loop_succeeded`

## Observability

The framework exposes two layers:

### Machine-readable

JSON and JSONL records for control logic, later automation, and future UI integration.

### Human-readable

A compact summary for operators showing:

- why the run started
- current phase
- attempts used
- last verifier rejection reason
- remaining time and token budget
- final stop reason

## Error Handling

Errors are classified into three buckets.

### Retryable

Examples:

- transient tool failure
- temporary timeout
- verifier rejection that still has a safe retry path

### Blocked

Examples:

- missing information
- human gate hit
- denylist hit

### Terminal

Examples:

- budget exhausted
- repeated equivalent failures
- human cancellation
- unsafe-to-continue verifier conclusion

The system must never disguise blocked or terminal states as progress.

## Testing Strategy

V1 requires four test layers.

### State machine tests

Validate legal and illegal transitions.

### Stop controller tests

Validate decision priority:

- cancel before success
- success before retry
- human gate before retry
- limits before another attempt

### Contract validation tests

Invalid contracts fail before execution begins.

### Golden-path integration tests

Run three end-to-end scenarios against a small example repository:

- success
- verifier rejection
- blocked waiting for human

The focus is framework controllability under uncertain agent output, not model intelligence.

## Milestones

### V1

Minimum runnable kernel:

- single task
- single repository
- Claude adapter
- L2 assisted autonomy
- isolated worktree per attempt
- verifier plus stop controller
- durable contract, state, and artifacts

### V2

Operationally stronger framework:

- resume and reconciliation
- richer event schema
- stronger debugging and run summaries
- scheduled triggers
- reusable presets and patternized configuration

### V3

Broader orchestration layer:

- multiple runtime adapters
- richer autonomy profiles
- more loop patterns
- more mature unattended operation

## Why This Design

This design keeps the first release small enough to implement while protecting the property that matters most: the loop stops for explicit reasons, leaves durable evidence, and yields to humans at the right moments. The kernel remains portable, but v1 stays concrete by centering on a single code-task loop with a Claude adapter.