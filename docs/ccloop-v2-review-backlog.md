# ccloop V2 Review Backlog

> Status: review input, not an approved V2 design or scope commitment.
> Created: 2026-07-17
> Review trigger: after the evidence-first V1 real-run validation has completed; that condition is now true on `main`, but V2 remains deferred until explicitly prioritized.
> Current accepted V1 evidence on `main`: `A-04-08 PASS`, `B-02 PASS`, `C-05 PASS`, `D-01 INCONCLUSIVE / CONTRACT_GAP`, `E-01 PASS`.
> Current validation design: [`docs/superpowers/specs/2026-07-17-evidence-first-v1-validation-design.md`](superpowers/specs/2026-07-17-evidence-first-v1-validation-design.md)
> Immediate priority: truthful V1 docs/backlog alignment, not new paid runs or implicit V2 kickoff.

## Purpose

Preserve promising mechanisms found while reviewing DoWhiz, loop-engineering, ralph-orchestrator, and oh-my-openagent `/ralph-loop` without prematurely committing them to V2.

When V2 design begins, review every item against real V1 evidence and classify it as:

```text
ADOPT | MODIFY | REJECT | STILL_DEFER
```

A reference implementation is evidence that a mechanism can be useful, not proof that ccloop needs it.

## Review Principles

1. Start from observed V1 failures and operator needs.
2. Prefer the smallest mechanism that closes a confirmed gap.
3. Keep controller policy deterministic; use models for judgment, not routing, retries, state transitions, or persistence.
4. Preserve maker/checker separation and controller-owned completion.
5. Do not introduce scheduling before ownership, stale-run handling, and reconciliation are reliable.
6. Do not turn human-readable views into machine sources of truth.
7. Preserve failed and partial evidence; recovery must not overwrite primary attempts.

## Candidate Review Table

| Candidate | Why it may matter | Evidence that should trigger review | Key questions |
|---|---|---|---|
| Run identity and ownership | Prevent two processes from adopting or mutating one run. | Duplicate execution, ambiguous owner, or concurrent state writes. | Is a local owner record enough? What is the fencing mechanism? |
| State revision or compare-and-swap | Reject stale writers and duplicate transitions. | State/event mismatch or concurrent transition race. | Which writes require revision checks? How is a rejected stale write surfaced? |
| Atomic state persistence | Prevent partial JSON and ambiguous crash points. | Truncated state/artifact or state/event inconsistency. | Temp+rename only, or fsync and directory sync? Which files are critical? |
| Event/state recovery protocol | Reconstruct a consistent run after process death. | State snapshot and event history disagree after interruption. | Is state authoritative, event-derived, or checkpoint plus log? How are malformed events handled? |
| Append-only recovery history | Preserve crash, resume, discard, and retry lineage. | Existing events cannot reconstruct attempt causality. | Extend `events.jsonl` or introduce a separate recovery ledger? |
| Stale-run detection | Identify abandoned running states and orphaned worktrees. | Process dies while run remains non-terminal. | What proves staleness: PID, heartbeat, lease expiry, or operator decision? |
| Reconciliation | Compare persisted state, processes, worktrees, and artifacts after restart. | Crash or restart leaves uncertain ownership or terminal status. | Startup-only or periodic? Which repairs are automatic versus human-gated? |
| Adopt/resume | Continue a blocked or interrupted run safely. | Operators repeatedly need to continue preserved work. | Resume same attempt or start a linked attempt? Which evidence must be revalidated? |
| Watchdog and retry policy | Ensure stuck work reaches a terminal or human state. | Hung processes or stale executions recur. | Retryable failure taxonomy, backoff, max retries, and kill switch? |
| Scheduler and daemon | Provide durable unattended heartbeat. | Reconciliation is proven and recurring work has a concrete use case. | Local daemon, CI, or managed scheduler? Catch-up and jitter semantics? |
| Single-claim scheduling lease | Prevent duplicate scheduled runs. | Scheduler work begins. | Lease key, expiry, fencing, and idempotency rules? |
| Product-level artifact manifest | Make expected, missing, partial, and invalid artifacts machine-readable. | Experiment manifests reveal repeated ambiguity or missing evidence. | Per attempt or per run? Which artifacts are required for each terminal state? |
| Artifact provenance and hash chain | Prove which bytes a verifier reviewed and preserve retry lineage. | Saved evidence differs from verifier input or attempts become ambiguous. | SHA-256 scope, previous-manifest link, producer/schema versions? |
| Staging, validation, and seal | Prevent incomplete artifacts from appearing final. | Partial writes or cleanup-before-validation occurs. | Which terminal states seal? Can blocked runs snapshot while retaining live worktrees? |
| Immutable evidence bundle | Support offline audit and reproducible incident analysis. | Run directories are difficult to archive or compare. | Bundle contents, redaction, size limits, and retention? |
| Cleanup tombstones | Preserve auditability after worktree/artifact cleanup. | Operators cannot explain missing worktrees or last recoverable copies. | Tombstone location, retention, and relation to artifact manifests? |
| Cleanup outcome model | Separate task result from resource-cleanup result. | Successful/failed runs leave residual worktrees or cleanup warnings. | Warning field, operator-action state, or separate resource status? |
| Durable publication | Keep evidence after local workspace cleanup. | Local evidence retention becomes insufficient. | Object store or filesystem archive? Upload verification and local fallback semantics? |
| Minimal handoff packet | Make blocked runs actionable without resume. | Scenario B shows operators cannot locate or assess retained work. | Which pointers are missing from existing runDir? Keep it derived or persist it? |
| Environment allowlist | Reduce credential exposure to runtime and artifacts. | Real runs show unnecessary environment inheritance or leakage. | Which variables does Claude CLI actually require? How are values redacted? |
| Path canonicalization and symlink policy | Prevent lexical path checks from missing escapes. | Security testing or a real run exposes symlink/path ambiguity. | Reject all symlinks or validate realpaths within fixture/repository? |
| Structured command evidence | Make required checks reproducible and auditable. | Command, cwd, environment, or output cannot be reconstructed. | Shell string versus argv; safe environment digest; output limits? |
| Partial-output capture | Retain useful stdout/stderr before timeout. | Scenario C/D cannot distinguish no output from lost output. | Streaming capture, size cap, and redaction timing? |
| Orphan worktree GC | Discover and safely classify unmanaged/stale worktrees. | Reconciliation identifies recurring orphaned worktrees. | Report-only default? Never force-remove dirty work without approval. |
| Multi-runtime adapters | Validate runtime abstraction beyond Claude. | Claude path is stable and a concrete second runtime is required. | Which semantics are portable versus adapter-specific? |
| Multi-task coordination | Run several loops without collisions. | Single-loop recovery and ownership are already reliable. | Queue, repository locks, conflicting path detection, review bandwidth? |

## Reference Notes

### DoWhiz

Useful mechanisms:

- watchdog and stale-task handling;
- startup and periodic reconciliation;
- validated user-facing artifact separate from scheduler terminal status;
- recovery notes and terminal error envelope;
- durable archive status with explicit local fallback;
- before/after/diff manifests and sanitized runtime snapshots.

Review locations:

- `reference/DoWhiz/worker_agent_execution.md:276-345`
- `reference/DoWhiz/DoWhiz_service/run_task_module/src/run_task/types.rs:217-231`
- `reference/DoWhiz/DoWhiz_service/docs/task_debug_archives.md:100-123`
- `reference/DoWhiz/DoWhiz_service/docs/task_debug_archives.md:216-261`

Do not copy without a concrete need:

- Azure ACI recovery and warm-pool control;
- Codex-to-Claude fallback;
- email, Discord, Browserbase, or domain-specific attachment semantics;
- Azure Blob publication details.

### loop-engineering

Useful mechanisms:

- independent verifier defaults to reject until proven;
- explicit test command/result and scope evidence;
- dirty worktrees are reported rather than silently force-removed;
- orphan and dropped-worktree discovery;
- explicit human escalation and hard stop lines.

Review locations:

- `reference/loop-engineering/templates/SKILL.md.verifier:21-47`
- `reference/loop-engineering/tools/loop-worktree/src/worktree.ts:170-213`
- `reference/loop-engineering/tools/loop-worktree/src/worktree.ts:231-274`

Do not use as machine truth:

- `STATE.md`, human run logs, and separate worktree manifests without end-to-end relation keys;
- report-only status enumerations as a substitute for ccloop terminal states;
- retention policies that delete the only recovery evidence.

### ralph-orchestrator

Useful mechanisms:

- append-only, locked loop history for audit and crash recovery;
- rejection of completion when required events are absent;
- typed termination reasons;
- handoff containing branch, HEAD, open work, and key files;
- cleanup and orphan-worktree operations separated from task completion.

Review locations:

- `reference/ralph-orchestrator/crates/ralph-core/src/loop_history.rs:1-18`
- `reference/ralph-orchestrator/crates/ralph-core/src/loop_history.rs:66-105`
- `reference/ralph-orchestrator/crates/ralph-core/src/loop_history.rs:132-185`
- `reference/ralph-orchestrator/crates/ralph-core/src/event_loop/mod.rs:730-775`

Do not copy before multi-loop scope exists:

- hats/topics event routing;
- merge queue, automatic merge, publish-review, or rebase control;
- TUI session replay and multi-loop registry;
- QA feedback loops with framework-specific event semantics.

One behavior requires explicit reconsideration: Ralph history skips malformed JSONL lines during reads. ccloop evidence/recovery should surface corruption rather than silently omit it.

### oh-my-openagent `/ralph-loop`

Useful lessons:

- guard continuation against stale owner/iteration state;
- track verification attempt/session independently from implementation;
- distinguish completion request from verification result;
- detect no-progress and iteration limits.

Review locations:

- `reference/oh-my-openagent/packages/omo-opencode/src/hooks/ralph-loop/storage.ts:95-195`
- `reference/oh-my-openagent/packages/omo-opencode/src/features/builtin-commands/commands.ts:40-64`

Do not copy:

- free-text completion promises as the core contract;
- transcript scans as the final completion authority;
- one mutable Markdown state file as an audit ledger;
- direct state deletion on completion or cancellation;
- process-local concurrency guards as a substitute for cross-process ownership.

## V2 Review Checklist

Before designing V2:

1. Read the final evidence-first V1 report and all confirmed findings.
2. Verify the current repository and runtime behavior; this backlog may be stale.
3. For every candidate, record `ADOPT`, `MODIFY`, `REJECT`, or `STILL_DEFER`.
4. Tie every adopted candidate to observed evidence or an explicit new requirement.
5. Define the V2 success condition before choosing implementation mechanisms.
6. Resolve the source-of-truth model before designing resume or scheduling.
7. Define ownership, stale detection, reconciliation, and kill-switch behavior before scheduler work.
8. Keep external writes, push, PR, merge, and remote publication behind separate approval and safety design.
9. Produce a new V2 design spec; do not treat this backlog as that spec.
