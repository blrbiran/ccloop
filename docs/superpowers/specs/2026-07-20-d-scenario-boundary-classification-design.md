# D Scenario Boundary Classification Design

> Status: proposed on 2026-07-20
> Scope: close the D-scenario ambiguity between pre-execute exhaustion and execute-entered interruption, while preserving historical evidence and avoiding any new paid run during design.
> Parent initiative: [`2026-07-17-evidence-first-v1-validation-design.md`](2026-07-17-evidence-first-v1-validation-design.md)

## 1. Goal

Make D-scenario outcomes mechanically classifiable instead of collapsing distinct boundaries into one `INCONCLUSIVE / CONTRACT_GAP` bucket.

This design has two goals:

1. allow historical D evidence such as `D-01` to be re-evaluated from already-persisted artifacts when the existing evidence is sufficient; and
2. add the minimum future controller-owned evidence needed so later D runs can distinguish “never entered execute” from “entered execute but ended before a full execute artifact existed”.

The design does not authorize a new paid run. It defines classification rules, persistence boundaries, and validation requirements first.

## 2. Scope

This increment applies only to D-scenario interpretation and the controller/evidence boundaries needed to classify D-like exhaustion paths.

It includes:

- evidence-layer rules for historical reclassification;
- new D-specific boundary classifications;
- verdict/diagnosis mapping rules;
- a controller-owned `execute_started` event for future runs;
- a controller-owned `execution-recovery.json` artifact for future runs when execute is entered but no full execute result is returned;
- deterministic validation for those boundaries;
- preservation of original historical review artifacts alongside any later reclassification.

It does not:

- change A/B/C/E scenario acceptance rules;
- loosen token budgets, timeout budgets, retry policy, or stop precedence;
- reinterpret historical evidence from raw terminal output alone;
- treat observer/process evidence as a controller-of-record source of truth;
- require a new paid run before design approval;
- overwrite accepted historical artifacts in place.

## 3. Evidence Layers

D-scenario reclassification must distinguish controller-owned evidence from derived summaries and opportunistic observation.

### 3.1 Layer A — controller authority

These files are the mechanical basis for classification:

- `runs/<id>/events.jsonl`
- `runs/<id>/loop-state.json`
- `runs/<id>/attempts/<n>/plan.json`
- `runs/<id>/attempts/<n>/execution.json`
- `runs/<id>/attempts/<n>/diff.patch`
- `runs/<id>/attempts/<n>/stdout-stderr.log`
- future `runs/<id>/attempts/<n>/execution-recovery.json`

Layer A is authoritative because it is emitted and owned by the product boundary being validated.

### 3.2 Layer B — derived audit summaries

These files summarize or validate Layer A but do not independently redefine what happened:

- `evidence/<id>/artifacts.json`
- `evidence/<id>/git.json`
- `evidence/<id>/observations.json`
- `evidence/<id>/review.json`

Layer B may detect contradictions or summarize status, but it must not overrule a consistent Layer A event/artifact shape.

### 3.3 Layer C — observational evidence

These files are useful supporting evidence but not contract-grade proof of whether execute began:

- `evidence/<id>/processes.json`
- `evidence/<id>/stdout.log`
- `evidence/<id>/stderr.log`

Layer C may support analysis, but it cannot by itself prove `execute` began or did not begin. This prevents historical reclassification from depending on environment noise, hook chatter, or incidental subprocess visibility.

## 4. D Boundary Classification Model

This increment introduces four D-boundary classifications.

### 4.1 `PRE_EXECUTE_EXHAUSTION`

The run exhausted before the controller crossed into execute.

Required shape:

- `plan.json` exists;
- `events.jsonl` contains `loop_planning` and terminal exhaustion, but no `attempt_started`;
- `execution.json`, `diff.patch`, and `stdout-stderr.log` are absent;
- `loop-state.json` is terminal with `status: "exhausted"`;
- no other Layer A event implies execute or post-execute handling occurred.

### 4.2 `EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE`

The controller entered execute, but no complete execute result and no controller-owned recovery evidence prove whether recoverable work existed.

Required shape:

- `attempt_started` exists;
- execute does not produce a complete `execution.json`;
- no sufficient controller-owned recovery evidence exists to prove either recoverable-work presence or recoverable-work absence.

This remains the narrow future home of true D-style contract gaps.

### 4.3 `EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE`

The controller entered execute and controller-owned evidence proves what recoverable state existed at interruption time.

Required shape:

- `attempt_started` exists;
- future `execute_started` exists;
- either a complete `execution.json` exists, or `execution-recovery.json` exists and is sufficient to classify the interrupted execute boundary.

### 4.4 `BOUNDARY_UNRESOLVED`

The available controller-owned evidence is missing, malformed, or contradictory enough that no mechanical boundary classification is trustworthy.

Examples:

- `events.jsonl` is unreadable;
- `loop-state.json` and event history disagree on terminal shape;
- an execution artifact exists without any corresponding attempt/event lineage and the contradiction cannot be reconciled.

`BOUNDARY_UNRESOLVED` is the only state that should continue to map to `CONTRACT_GAP`.

## 5. Historical Reclassification Rule

Historical D runs may be reclassified from existing evidence without a new paid run, but only from Layer A and only under strict rules.

### 5.1 Rule

A historical run is mechanically classified as `PRE_EXECUTE_EXHAUSTION` when all of the following are true:

- `events.jsonl` parses successfully;
- the recorded event sequence reaches exhaustion without `attempt_started`;
- `plan.json` exists;
- `execution.json`, `diff.patch`, and `stdout-stderr.log` do not exist;
- `loop-state.json` is terminal with `status: "exhausted"`; and
- no other Layer A artifact or event proves execute or later attempt handling began.

### 5.2 Why `attempt_started` absence is sufficient

In the current controller semantics, `attempt_started` marks that the controller has committed to the attempt execution path, but it is not itself the future fine-grained `execute_started` boundary. Existing integration tests already encode the difference between:

- exhaustion during or immediately after planning with no `attempt_started`; and
- exhaustion after the controller has entered the attempt execution path with `attempt_started` present.

Therefore, under the strict Layer A consistency requirements above, absence of `attempt_started` together with the full `PRE_EXECUTE_EXHAUSTION` shape is contract-grade negative evidence that the controller never entered the execute-handling path for that attempt.

### 5.3 Role of Layer C

`processes.json`, `stdout.log`, and `stderr.log` may support a written analysis note, but they cannot overrule a consistent Layer A `PRE_EXECUTE_EXHAUSTION` classification.

## 6. Verdict and Diagnosis Mapping

Boundary classification and final review verdict are not the same thing.

### 6.1 `PRE_EXECUTE_EXHAUSTION`

Map to:

- `verdict: INCONCLUSIVE`
- `diagnosis: RUNTIME_VARIANCE`

Rationale: the run is mechanically understood, so it is no longer a contract gap, but it still did not reach the D boundary the scenario was meant to validate. It therefore cannot be `PASS`.

### 6.2 `EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE`

Map to:

- `verdict: INCONCLUSIVE`
- `diagnosis: CONTRACT_GAP`

Rationale: the scenario entered execute, but the current evidence contract still cannot answer whether recoverable work existed.

### 6.3 `EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE`

This classification may map in one of two directions:

- `PASS` only when controller-owned recovery evidence proves no recoverable work existed and the terminal state, cleanup behavior, and standard evidence shape all match the D-scenario contract; or
- `FAIL / PRODUCT_DEFECT` when controller-owned recovery evidence proves recoverable work existed but the persisted standard evidence contract lost or misrepresented it.

Absence of recoverable work alone is not sufficient for `PASS`. The run must still satisfy the scenario's expected controller-owned stop, cleanup, and evidence behavior.

### 6.4 `BOUNDARY_UNRESOLVED`

Map to:

- `verdict: INCONCLUSIVE`
- `diagnosis: CONTRACT_GAP`

Rationale: the controller-owned evidence boundary itself is not trustworthy enough to classify the run.

## 7. Future Product Boundary Additions

Historical reclassification alone does not close future D ambiguity. Future runs need one new event and one new recovery artifact.

### 7.1 `execute_started` event

Before the controller calls `adapter.execute(...)`, it must append a new Layer A event:

```json
{
  "type": "execute_started",
  "at": "ISO timestamp",
  "attempt": 1,
  "detail": "attempt 1 entered execute"
}
```

This event means only one thing: the controller has crossed the execute call boundary.

It does not claim execute finished, produced a complete result, or changed the worktree.

### 7.2 `execution-recovery.json`

When `execute_started` exists but the adapter does not return a complete execute result before exhaustion/timeout, the controller must persist a controller-owned recovery snapshot before cleanup.

Proposed shape:

```ts
type ExecutionRecovery = {
  executeEntered: true;
  worktreeDiffObserved: true | false | "unknown";
  diffPatchCaptured: boolean;
  stdoutStderrLogCaptured: boolean;
  changedPathsObserved: string[] | null;
  captureStatus: "complete" | "partial" | "failed";
  cleanupStatus: "retained" | "removed";
  failureBoundary: "timeout" | "token_exhausted" | "runtime_exhausted";
};
```

This file is not an adapter self-report. It is a controller-owned recovery observation whose sole purpose is to answer whether execute had entered and whether recoverable work was observed before cleanup.

### 7.3 Why this is the minimum future addition

`execute_started` closes the “did execute start?” ambiguity.

`execution-recovery.json` closes the “if execute started, did the controller observe recoverable state?” ambiguity.

No additional raw model output, prompts, or environment transcripts are required for this boundary.

## 8. Historical Artifact Preservation

Historical accepted artifacts must remain immutable.

Therefore:

- existing `review.json` files are not overwritten in place;
- a later reclassification must be emitted as a separate review artifact or ledger entry;
- the reclassification artifact must record the rule version and evidence basis used.

Recommended direction:

- keep original `review.json` unchanged; and
- add a distinct reclassification artifact such as `review-reclassified.json` or an equivalent central ledger.

The reclassification record must include:

- original verdict/diagnosis;
- reclassified verdict/diagnosis;
- boundary classification;
- rule version;
- exact Layer A evidence references used.

## 9. Deterministic Validation

No new paid run is required to validate the design.

Required deterministic validation:

1. tests proving the current historical-rule matcher classifies a `plan.json` + no `attempt_started` + exhausted shape as `PRE_EXECUTE_EXHAUSTION`;
2. tests proving malformed or contradictory Layer A evidence falls back to `BOUNDARY_UNRESOLVED`;
3. controller integration tests proving `execute_started` is persisted exactly at execute entry;
4. controller integration tests proving interrupted execute paths can persist `execution-recovery.json` before cleanup;
5. tests proving verdict/diagnosis mapping follows Section 6;
6. tests proving historical `review.json` is preserved and any reclassification is written to a separate artifact;
7. focused validation tests, full test suite, typecheck, and build.

No real Claude invocation is part of this validation increment.

## 10. Migration Strategy

### 10.1 Phase 1 — document and apply historical rule

First, land the classification rules and historical reclassification logic. Use them to evaluate existing D evidence such as `D-01`.

Expected outcome for `D-01` under this design:

- boundary classification: `PRE_EXECUTE_EXHAUSTION`
- final review mapping: `INCONCLUSIVE / RUNTIME_VARIANCE`

### 10.2 Phase 2 — add future boundary evidence

After the historical rule is validated, land `execute_started` and `execution-recovery.json` so future D-like runs can be mechanically classified without collapsing into a generic contract gap.

### 10.3 Phase 3 — optional future paid acceptance run

Only after deterministic validation passes should a future D paid run be considered. That run would serve as acceptance of the new evidence contract, not as exploratory debugging.

## 11. Completion Criteria

This increment is complete when:

- historical Layer A evidence can mechanically classify `PRE_EXECUTE_EXHAUSTION` under explicit rules;
- `PRE_EXECUTE_EXHAUSTION` maps to `INCONCLUSIVE / RUNTIME_VARIANCE`;
- true unresolved controller-boundary ambiguity remains the only path to `INCONCLUSIVE / CONTRACT_GAP`;
- future controller runs can persist `execute_started` and `execution-recovery.json` at the specified boundaries;
- deterministic tests cover both historical reclassification and future boundary persistence;
- historical accepted `review.json` artifacts remain unchanged in place;
- no new paid run has been performed as part of design validation.
