# Evidence-First V1 Validation Design

> Status: approved for specification on 2026-07-17
> Scope: validate the existing ccloop V1 with real Claude runs before adding automation or new runtime behavior.
> Related future review: [`docs/ccloop-v2-review-backlog.md`](../../ccloop-v2-review-backlog.md)

## 1. Goal

Exercise ccloop V1 through real Claude-backed runs and collect enough evidence to determine:

- what input was used;
- what the runtime did;
- what changed;
- what the controller and independent checks accepted or rejected;
- why the run stopped;
- what an operator can do next.

The work is evidence-first: existing V1 behavior is observed before product changes are proposed. Automation begins only after the real scenarios have produced complete, explainable evidence.

## 2. Governing Decisions

1. Use a disposable local Git fixture repository. Do not push, create a PR, or touch a shared environment.
2. Run real scenarios before building an automated E2E framework.
3. Keep the product and experiment harness separate:
   - ccloop V1 is the system under test;
   - evidence records, manifests, terminal summaries, hashes, and snapshots are initially derived by the experiment harness from the existing run directory;
   - a mechanism becomes ccloop product behavior only after real evidence confirms a product gap.
4. Fix only confirmed product defects, then rerun the affected scenario and the existing test suite.
5. Defer resume, reconciliation, scheduling, daemon operation, concurrency, and durable remote publication to later design work.

## 3. Existing V1 Facts

The existing run directory is sufficient to begin validation:

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
  worktrees/attempt-<n>/
```

The facts have this authority order:

1. actual Git/worktree state;
2. controller-persisted machine evidence;
3. structured runtime and verifier output;
4. executor claims;
5. human-readable summaries derived by the experiment.

`loop-state.json` is the current control-state source of truth. `events.jsonl` is the append-only audit trail of how that state evolved. Attempt artifacts explain phase behavior. Reports and evidence summaries are derived views and may not rewrite those facts.

A conflict is evidence, not something to average away. For example, `succeeded` plus a failed required check is a product defect; an executor success claim plus an `exhausted` controller state remains exhausted; an irreconcilable state/event mismatch is inconclusive until explained.

## 4. Scenario Matrix

Each scenario starts from the same fixture baseline commit and uses a fresh run directory.

| ID | Scenario | Expected result | Primary assertions |
|---|---|---|---|
| A | Small code change with deterministic unit tests | `succeeded` | Required checks pass; only target or allowlisted files change; no unrelated edit appears; attempt worktree is cleaned; main checkout is unchanged. |
| B | Deliberate allowlist or denylist violation | `blocked_waiting_human` | Controller rejects success, denylist wins, worktree is retained, and pre-verification artifacts support operator inspection. Verification and required checks are explicitly `NOT_RUN`. |
| C | Execute produces changes and is then interrupted by timeout | Non-success terminal state | Original interruption is retained, partial patch applies to the baseline, untracked additions are represented, no forbidden path appears. |
| D | Execute is interrupted before the adapter reports a recoverable result | Non-success terminal state | No execution success or patch is invented. Plan-only evidence and a `NOT_PRODUCED` execution artifact are expected. The experiment does not infer that the worktree was unchanged. |
| E | Implementation completes but a deterministic check fails | Retry, exhaustion, or failure according to the contract | Executor claims cannot override required-check failure; attempts remain distinguishable. |

Run A and B first to validate the installed Claude CLI envelope and basic controller/worktree behavior. Calibrate C only after observing real execute timing. If timeout placement cannot be reproduced safely, report `INCONCLUSIVE / ENVIRONMENT_FAILURE`; do not modify product behavior merely to make the experiment pass. Run D and E after C establishes the interruption path.

One complete and explainable run per scenario is sufficient for this stage. Statistical stability belongs to the later automation stage.

## 5. Evidence Record

Each scenario produces a derived evidence record with four parts.

### 5.1 Identity and input

- scenario ID and purpose;
- run ID and attempt number;
- fixture baseline commit and observed worktree HEAD;
- contract and adapter configuration references;
- ccloop, Node.js, Git, and Claude CLI versions;
- command, working directory, start/end timestamps, and process exit code.

### 5.2 Process and result

- final `loop-state.json` status and stop reason;
- ordered event sequence or an explicit parse/sequence failure;
- plan, execution, verification, diff, and log entries, each marked `PRESENT`, `NOT_PRODUCED`, `NOT_RUN`, `MISSING`, or `INVALID` before any optional reference;
- required-check status and, when run, its command, exit code, and output excerpt;
- actual changed files and final worktree state;
- wrapper and Claude child-process exit observations;
- expected and actual worktree retention/cleanup.

### 5.3 Verdict and diagnosis

These are separate dimensions:

```text
scenarioVerdict: PASS | FAIL | INCONCLUSIVE
diagnosis: PRODUCT_DEFECT | RUNTIME_VARIANCE | ENVIRONMENT_FAILURE | CONTRACT_GAP | null
```

Examples:

- Claude varies, but ccloop safely blocks: `PASS / RUNTIME_VARIANCE`.
- A required check cannot run because the machine lacks a dependency: `INCONCLUSIVE / ENVIRONMENT_FAILURE`.
- State says success while controller-owned verification failed: `FAIL / PRODUCT_DEFECT`.

### 5.4 Follow-up

A finding records its reproduction conditions, impact, evidence paths, and recommended next action. Unreproduced or under-evidenced concerns are not reported as confirmed defects.

## 6. Evidence Sufficiency

A completion signal, process exit code, executor statement, or single state field is never sufficient on its own. A successful scenario requires agreement among:

- terminal state and stop reason;
- required event progression;
- required checks;
- independent verifier evidence when configured;
- actual Git diff and changed-file scope;
- required attempt artifacts;
- absence of an unresolved human gate.

The verifier must not trust executor claims. It records the command it ran, exit code, pass/fail result, output excerpt, and scope check. It also checks that tests or assertions were not disabled, skipped, or rewritten to manufacture success. If verification cannot run, the result is inconclusive or escalated, not approved.

## 7. Artifact Review Model

The following levels describe evidence maturity; they are not a new V1 runtime state machine:

```text
L0  Runtime-transient information
L1  Existing V1 phase artifacts persisted in runDir
L2  Artifacts validated by the experiment harness
L3  A read-only experiment evidence snapshot
```

The experiment harness may derive an artifact manifest containing:

- artifact ID, run, attempt, phase, and producer;
- relative path, type, size, and SHA-256;
- expected/present/missing/partial/invalid status;
- schema or parser result;
- base commit and worktree HEAD;
- source and superseded-artifact references.

The harness checks cross-artifact consistency:

- execution changed files match the Git diff;
- patch content matches the recorded changed files;
- verifier input refers to the same attempt and worktree;
- required-check output matches its verdict;
- terminal state agrees with the attempt outcome;
- a successful run has no missing required artifact;
- a blocked run has enough information for handoff;
- a partial patch replays against the recorded baseline;
- every manifest path remains inside the evidence root.

Missing and invalid artifacts are recorded explicitly. `NOT_PRODUCED` means the phase returned no artifact; `NOT_RUN` means controller policy prevented the phase or check from starting. Neither is equivalent to `MISSING`, which means an artifact was required but absent. A retry never overwrites an earlier attempt. `no-op`, partial, and rejected outcomes retain the evidence explaining that result.

In scenario D, current V1 may preserve only the plan and terminal state before cleaning the worktree. Without independent runtime evidence, the experiment cannot prove whether no change existed or recoverable evidence was lost. It records that limit as `INCONCLUSIVE / CONTRACT_GAP`; it reports a product defect only when separate evidence proves that a recoverable result should have been persisted.

An L3 snapshot is an experiment deliverable, not a prerequisite for the existing controller. It may contain a manifest, contract, terminal summary, event log, attempt artifacts, sanitized tool/environment information, before/after Git metadata, and a handoff summary. It must not be treated as proof that a retained worktree is safe to delete.

## 8. Artifact and Cleanup Observations

For every scenario, record separately:

```text
terminalOutcome
cleanupOutcome
worktreeExpectedToRemain
worktreeActuallyRemains
cleanupEventObserved
mainCheckoutUnchanged
```

This avoids changing a valid business terminal result merely because cleanup failed. Cleanup failure must not be silent: the residual worktree and event must be discoverable.

The experiment may write a derived cleanup observation with the original path, cleanup result, reason, snapshot reference, and hash. This is not yet a ccloop product tombstone.

The blocked scenario retains its worktree regardless of whether an evidence snapshot exists. Other worktrees follow existing V1 behavior. Unknown worktrees, stashes, and historical evidence are never removed by the experiment.

## 9. Human Handoff Test

Scenario B tests whether the existing run directory is enough for an operator to identify:

- run directory and attempt;
- terminal state and stop reason;
- retained worktree;
- baseline and current HEAD;
- changed files and diff;
- last plan and execution result, plus verification and required-check status; for a pre-verification gate, both latter entries must explicitly say `NOT_RUN`;
- allowed next actions;
- the V1 limitation that the original run cannot be resumed.

If an operator cannot determine these facts from existing evidence, that confirms a candidate product defect. Only then should ccloop gain the smallest handoff packet that closes the observed gap.

## 10. Safety Boundaries

- Use a disposable fixture with no secrets, symlinks, submodules, or nested worktrees.
- Use repository-relative contract paths.
- Launch the experiment from a controlled environment containing only variables needed by the tools. Record variable names or safe metadata, never secret values.
- Scan logs, patches, and reports before including them in a human-facing evidence snapshot.
- Do not unpack untrusted archives.
- Do not push, create PRs, alter shared infrastructure, or automatically merge.
- Induce timeout by contract budget, not by killing unrelated processes.
- Stop immediately if the main checkout changes, a subprocess remains uncontrolled, evidence is irreconcilably corrupt, or a path escapes the fixture.
- Show expected scenario and budget before any real Claude call that may incur material cost.

Symlink/path traversal, cross-process locking, remote publication, and hostile archive handling are separate future security work unless the real scenarios expose them directly.

## 11. Product-Change Gate

Modify ccloop only when real evidence confirms at least one of these:

- terminal state contradicts controller-owned evidence;
- required checks or path policy do not control the final decision;
- required artifacts are absent, overwritten, corrupt, or inconsistent with Git;
- timeout leaves an uncontrolled process, changes the main checkout, or loses a recoverable change;
- independent evidence proves that interrupted execution produced a recoverable result that ccloop failed to persist;
- human-gated evidence is insufficient for safe manual inspection;
- cleanup failure is silent or leaves an undiscoverable worktree;
- identical persisted inputs cannot explain why the run stopped.

Model wording, implementation choice, exact token count, or timing variance is not a product defect when the controller responds safely.

For each confirmed defect:

1. preserve the failing evidence;
2. design the minimum change;
3. implement only that change;
4. rerun the affected real scenario;
5. run existing tests and type checking;
6. preserve before/after evidence for comparison.

## 12. Deliverables and Completion Criteria

Deliverables:

1. disposable fixture and scenario contracts;
2. evidence-run procedure and review template;
3. A-E run directories and derived evidence records;
4. finding report with verdict, diagnosis, reproduction, and evidence paths;
5. minimal confirmed fixes, if any;
6. recommendations for the automation stage.

This stage is complete when:

- A-E each has PASS, FAIL, or INCONCLUSIVE with an explicit reason;
- A, B, and C have complete, explainable evidence chains;
- state, events, artifacts, Git state, and resource cleanup have been checked;
- main checkout safety and path policy remain intact;
- no uncontrolled subprocess remains;
- every confirmed product fix has been rerun and regression-tested;
- unresolved evidence gaps are surfaced rather than counted as passes.

## 13. Automation Entry Criteria

Only after the evidence stage completes should automation be designed.

Deterministic candidates:

- state transitions and stop precedence;
- evidence parser and manifest checks;
- patch replay and scope checks;
- cross-artifact consistency;
- worktree retention and cleanup observations;
- handoff sufficiency.

Explicitly enabled environment integration candidates:

- installed Claude CLI envelope;
- wrapper abort and subprocess lifecycle;
- partial-outcome capture.

Do not automate exact model text, exact steps, exact token use, or exact timing.

## 14. Deferred Work

The following remain outside this stage and must be reconsidered against the evidence before V2 scope is approved:

- run ownership, revision, lease, and heartbeat;
- stale-run detection and reconciliation;
- adopt/resume and crash recovery;
- atomic persistence and event/state recovery protocol;
- product-level artifact lifecycle and immutable bundles;
- durable remote publication and retention;
- scheduler, daemon, and multi-task concurrency;
- merge queue, automatic PR, push, or merge.

These candidates are preserved in [`docs/ccloop-v2-review-backlog.md`](../../ccloop-v2-review-backlog.md).
