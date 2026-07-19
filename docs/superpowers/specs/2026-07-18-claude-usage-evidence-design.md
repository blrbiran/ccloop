# Claude Usage Evidence Design

> Status: approved on 2026-07-18
> Scope: make Claude token-budget decisions independently auditable before another real Scenario A run.
> Parent initiative: [`2026-07-17-evidence-first-v1-validation-design.md`](2026-07-17-evidence-first-v1-validation-design.md)

## 1. Goal

Persist the minimum non-sensitive evidence needed to reconstruct how each Claude phase derived its normalized token usage. The same normalization result must drive both controller budget accounting and the phase artifact inspected after the run.

This closes the evidence gap exposed by A-03: the historical artifact contains a normalized total but not the source usage fields, so the reported value cannot be distinguished from the former alias-duplication defect.

## 2. Scope

This increment applies to Claude-backed `plan`, `execute`, and `verify` results. It adds optional usage evidence to the standard phase artifacts already persisted by ccloop.

It does not:

- save the complete Claude response envelope;
- save prompts, assistant text, credentials, unknown usage fields, or pricing estimates;
- change token-budget thresholds, retry rules, state transitions, stop precedence, or attempt accounting;
- add scheduling, reconciliation, resume, publication, or V2 orchestration;
- alter A-01, A-02, or A-03 evidence;
- require the scripted adapter to manufacture Claude-specific evidence.

## 3. Data Model

A Claude-backed phase result may contain:

```ts
type UsageFieldEvidence = {
  status: "absent" | "finite" | "non_finite" | "invalid_type";
  value?: number;
};

type UsageEvidence = {
  usageStatus: "present" | "absent" | "invalid";
  fields: {
    input_tokens: UsageFieldEvidence;
    inputTokens: UsageFieldEvidence;
    output_tokens: UsageFieldEvidence;
    outputTokens: UsageFieldEvidence;
  };
  selectedInputField: "input_tokens" | "inputTokens" | null;
  selectedOutputField: "output_tokens" | "outputTokens" | null;
  normalizedTotal: number | null;
};
```

`value` is present only when `status` is `finite`. Unknown properties from the Claude envelope or its `usage` object are never copied.

This increment preserves the existing normalization semantics: any finite numeric field is eligible for alias selection. Validation of whether Claude should emit only non-negative integers is outside this evidence-only change.

For each direction, snake_case has priority over camelCase:

1. select the snake_case value when it is finite;
2. otherwise select the camelCase value when it is finite;
3. otherwise select no field.

Aliases are alternatives, never additive duplicates. `normalizedTotal` is the sum of the selected input and output values when at least one selected value exists and the sum is finite and positive. Otherwise it is `null`. A finite-field sum can overflow to a non-finite JavaScript number; normalizing that case to `null` prevents `JSON.stringify` from silently converting the value to JSON `null` while preserving the controller's effective no-charge behavior.

The phase result's existing `tokenUsage` is present exactly when `usageEvidence.normalizedTotal` is a number, and the two values must be equal.

## 4. Data Flow and Ownership

```text
Claude JSON envelope
  -> wrapper parses the usage object once
  -> one normalization function creates UsageEvidence
  -> normalizedTotal becomes tokenUsage
  -> adapter returns the phase result
  -> controller persists the result as plan/execution/verify artifact
```

The wrapper owns extraction and normalization because it is the only boundary that sees the original Claude envelope. The adapter and controller transport and persist the result without independently interpreting aliases.

The normalization function must be deterministic and side-effect free. Budget accounting and audit evidence must never be calculated by separate algorithms.

The standard phase artifact is the evidence boundary. A validation-only sidecar is rejected because it could drift from the value used by the controller. Saving the complete raw envelope is rejected because it retains unnecessary and potentially sensitive data.

## 5. Failure and Compatibility Semantics

- Missing `usage` produces `usageStatus: "absent"`, four `absent` fields, null selections, and `normalizedTotal: null`.
- A non-object or null `usage` value produces `usageStatus: "invalid"`; no value is used for accounting.
- A present object produces `usageStatus: "present"`, even when none of its supported fields is usable.
- `Infinity` and `NaN` are `non_finite` and are not selected.
- Strings, booleans, objects, arrays, and null field values are `invalid_type` and are not selected.
- Finite negative, fractional, and zero values are recorded as `finite` and participate in alias selection under the existing semantics.
- A selected total that is zero, negative, or non-finite after addition yields `normalizedTotal: null` and no `tokenUsage`.
- Conflicting finite aliases use the fixed snake_case priority; both finite values remain visible for audit.
- If usage evidence cannot be incorporated into a phase result or persisted with its artifact, the phase fails. ccloop must not continue budget accounting from an unauditable value.
- Existing artifacts without `usageEvidence` remain readable. The field is optional at the persistence boundary; no migration or historical reconstruction is attempted.
- An interruption/error fallback currently derives a partial execute result from Git state after the Claude envelope is unavailable for normal parsing. That partial artifact omits `usageEvidence` and `tokenUsage`; it must not infer either value from incomplete stdout. Recovering usage from interrupted stdout is outside this evidence-only increment.

## 6. Artifact Consistency Rules

A validation pass must mechanically check:

1. `tokenUsage` is absent when `normalizedTotal` is null.
2. `tokenUsage` equals `normalizedTotal` when the latter is a number.
3. Each selected field has `status: "finite"`.
4. Snake_case wins when both aliases for a direction are finite.
5. At most one alias is selected per direction.
6. The total equals the sum of selected values without alias duplication.
7. No unknown envelope or usage property appears in the artifact.
8. The evidence is attached to the same phase and attempt whose token usage the controller counted.
9. For a completed fake-Claude controller run, the final remaining token budget equals the initial budget minus the sum of persisted phase `normalizedTotal` values, subject only to the controller's existing zero floor.

A disagreement is a product defect, not a report-only warning.

## 7. Deterministic Validation

Use a fake Claude executable so these tests incur no real Claude usage. Cover:

- snake_case fields only;
- camelCase fields only;
- both alias sets with equal values;
- both alias sets with conflicting values;
- non-finite snake_case with finite camelCase fallback;
- strings, objects, nulls, negative values, fractional values, zeros, finite-field sum overflow, and absent usage;
- equality between `tokenUsage` and `usageEvidence.normalizedTotal` at the wrapper/adapter boundary;
- a controller-level integration run using the subprocess adapter and a fake Claude executable, with distinct usage for plan, execute, and verify;
- agreement in that run among the initial token budget, final persisted `budgetSnapshot.tokenBudgetRemaining`, and the sum of persisted phase `tokenUsage` values;
- persistence and reload of `usageEvidence.normalizedTotal` and `tokenUsage` through `plan.json`, `execution.json`, and `verify.json` for the same attempt;
- interruption/error partial execute artifacts omit both `usageEvidence` and `tokenUsage` rather than inventing evidence from incomplete stdout;
- compatibility with historical artifacts that omit `usageEvidence`;
- removal of an unknown-field sentinel and a synthetic secret sentinel from persisted evidence.

Required verification:

```text
focused Claude wrapper and adapter tests
full test suite
typecheck
build
```

No real Claude call is part of this implementation validation.

## 8. A-04 Entry Gate

A-04 may be proposed only after all deterministic validation passes. It remains a separate paid call requiring explicit approval.

Before approval, present:

- fresh contract, run, and evidence paths;
- attempt, phase timeout, total runtime, recovery-window, and token budgets;
- the usage evidence expected in each produced phase artifact;
- confirmation that the invocation runs once with no automatic retry;
- confirmation that the disposable fixture is clean and the main checkout must remain unchanged.

A-04 success still requires the complete controller-owned chain:

```text
plan -> execute -> required checks -> independent verify -> succeeded
```

Usage evidence alone does not make A-04 successful. Executor-captured tests, process exit, or model completion text cannot replace controller-owned checks and independent verification.

If A-04 exhausts again, the persisted phase artifacts must make the token stop independently reconstructable. If they do not, the result is not accepted as an explainable validation run.

## 9. Completion Criteria

This increment is complete when:

- every Claude phase can persist whitelisted usage evidence;
- controller token accounting and artifact evidence use one normalization result;
- alias selection, invalid-value handling, and normalized totals are deterministic;
- no complete envelope, unknown field, or synthetic secret sentinel is persisted;
- Historical A-01 through A-03 artifacts remain immutable and are not retroactively reconstructed;
- historical artifacts remain readable without mutation;
- focused tests, the full suite, type checking, and build pass;
- no real Claude call has occurred;
- The invocation remains unapproved and unrun until separately presented to the user.
