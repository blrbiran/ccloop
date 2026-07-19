# A-04 Preflight and Stop Boundaries Design

> Status: approved on 2026-07-18
> Scope: define the exact preflight, approval, and interpretation boundaries for the next separately approved real Scenario A invocation.
> Parent initiatives: [`2026-07-17-evidence-first-v1-validation-design.md`](2026-07-17-evidence-first-v1-validation-design.md), [`2026-07-18-claude-usage-evidence-design.md`](2026-07-18-claude-usage-evidence-design.md)

## 1. Goal

Prepare one fresh A-04 Scenario A invocation that maximizes the chance of producing a complete, explainable, controller-owned evidence chain without widening ccloop V1 scope.

The immediate target remains:

```text
plan -> execute -> controller required checks -> independent verify -> succeeded
```

This design changes the preparation, approval, and interpretation envelope, not the meaning of success.

## 2. Scope

This increment defines:

- the preferred A-04 invocation envelope;
- the deterministic preflight checklist that must pass before any paid call is proposed;
- the exact contents of the approval package shown to the user;
- the PASS gate and non-success interpretation rules for the finished run;
- the single-run stop policy applied after the invocation ends.

It does not:

- change Scenario A semantics;
- add retries, resume, reconciliation, scheduling, daemon behavior, memory mechanisms, or V2 orchestration;
- authorize a real Claude call by itself;
- modify historical A-01 through A-03 evidence;
- treat a near-success as permission to extend scope or silently queue A-05.

## 3. Approach Selection

Three approaches were considered:

1. **High-success conservative envelope** — widen budget and timing enough to improve one-shot completion probability while keeping Scenario A semantics and evidence-first boundaries unchanged.
2. **Ultra-wide budget envelope** — push token budget materially higher again and bias further toward completion probability.
3. **Contract-shrinking envelope** — reduce Scenario A scope or verification requirements to make success easier.

Approach 1 is chosen.

Approach 2 is rejected for now because no current evidence shows that `550000` is insufficient once the time envelope is widened and the usage-evidence gap is closed. Approach 3 is rejected because it would blur the boundary between validating the current V1 behavior and redefining the scenario to make it easier to pass.

## 4. Authority and Invariants

### 4.1 Handover-derived invariants

From [`docs/handover/ccloop-handover.md`](../../handover/ccloop-handover.md):

- A-04 remains a separate paid real-Claude call that must not run until explicitly approved.
- A-04 must use fresh A-04-only paths.
- One scenario invocation may launch up to three Claude phases: `plan`, `execute`, and `verify`.
- Success still requires the complete controller-owned chain:

```text
plan -> execute -> controller required checks -> independent verify -> succeeded
```

- Executor claims, process exit, or executor-captured tests alone are insufficient.
- If A-04 yields `FAIL / PRODUCT_DEFECT`, scenario progression stops until evidence is preserved, the defect is debugged, and a minimal approved fix exists.
- If A-04 is inconclusive, it must not silently retry.

### 4.2 Usage-evidence-derived invariants

From [`2026-07-18-claude-usage-evidence-design.md`](2026-07-18-claude-usage-evidence-design.md):

- A-04 may be proposed only after deterministic validation passes.
- The approval package must present the usage evidence expected in each produced phase artifact.
- Usage evidence does not replace controller-owned completion.
- If A-04 exhausts again, the persisted phase artifacts must make the token stop independently reconstructable.
- The invocation remains unapproved and unrun until separately presented to the user.

### 4.3 Deliberate deviation from the conservative handover envelope

The handover records this conservative proposed A-04 envelope:

```text
per-attempt timeout: 300000ms
total runtime budget: 600000ms
partial outcome recovery window: 3000ms
token budget: 550000
```

This spec intentionally preserves the `550000` token proposal but widens the timing envelope to:

```text
per-attempt timeout: 600000ms
total runtime budget: 1200000ms
partial outcome recovery window: 5000ms
```

This is a deliberate, user-approved deviation for one-shot completion probability. It is not a new default for V1.

## 5. Preferred A-04 Invocation Envelope

Unless a deterministic preflight produces new contrary evidence, the preferred A-04 invocation package is:

```text
scenario: A
attempts: 1
per-attempt timeout: 600000ms
total runtime budget: 1200000ms
partial outcome recovery window: 5000ms
token budget: 550000
automatic retries: none
maximum Claude-backed phases: 3 (plan / execute / verify)
fresh paths: A-04 only
```

The goal of this run is not minimum spend. The goal is maximum probability of one complete, auditable evidence chain.

## 6. Deterministic Preflight Checklist

No real Claude call may be proposed until the following checklist completes successfully in order.

### 6.1 Metadata-backed read-only inspection

Inspect without cleaning or resetting:

- the current `main` checkout;
- `docs/handover/ccloop-handover.md`;
- `docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md`;
- `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`;
- `docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md`;
- local branch `backup/evidence-first-v1-before-memory-history-cleanup`.

Retained stashes, the legacy `evidence-first-v1` linked worktree, and the legacy preserved `.validation-runs/` tree are now soft signals surfaced in the inspection summary rather than hard blockers by themselves.

### 6.2 Main deterministic verification

Re-run on `main`:

```text
npm test
npm run typecheck
npm run build
```

Any failure stops A-04 preparation immediately.

### 6.3 A-04 freshness check

Confirm all of the following:

- the disposable fixture repository is clean;
- `.validation-runs/contracts/A-04.json` does not exist yet;
- `.validation-runs/runs/A-04/` does not exist yet;
- `.validation-runs/evidence/A-04/` does not exist yet.

### 6.4 Contract render and validation

Render a fresh Scenario A contract for A-04.

The only allowed differences from the Scenario A baseline are the explicitly approved execution-policy fields for this invocation: `executionPolicy.tokenBudget`, `executionPolicy.perAttemptTimeoutMs`, `executionPolicy.totalRuntimeBudgetMs`, and `executionPolicy.partialOutcomeRecoveryWindowMs`. The rendered contract must pass product-schema validation.

The approval package must include enough immutable identity to prove that the reviewed contract is the one that would run. At minimum this means the rendered contract path, the schema-validation result, and a frozen contract identity token such as a content hash or equivalent immutable digest.

### 6.5 Focused evidence-chain regression set

Re-run the deterministic checks most directly tied to A-04 interpretability:

```text
npm test -- --run tests/validation/contracts.test.ts
npm test -- --run \
  tests/runtime/claude/subprocessClaudeAdapter.test.ts \
  tests/controller/runLoop.integration.test.ts \
  tests/validation/evidence.test.ts
```

This focused set exists to catch contract-rendering, usage-evidence, token-accounting, and artifact-consistency regressions before any paid call is proposed.

### 6.6 Final pre-approval gate

Before approval is requested, all of the following must still be true:

- main deterministic verification passed;
- the fixture is still clean;
- `.validation-runs/contracts/A-04.json` is freshly rendered and valid;
- `.validation-runs/runs/A-04/` still does not exist;
- `.validation-runs/evidence/A-04/` still does not exist;
- the focused evidence-chain regression set passed.

## 7. Approval Package

### 7.1 Required contents

The approval request must present, in one place:

- the exact command that would be executed;
- the working directory;
- the three A-04 paths;
- Scenario A, `attempts: 1`, and `automatic retries: none`;
- `tokenBudget: 550000`;
- `per-attempt timeout: 600000ms`;
- `total runtime budget: 1200000ms`;
- `partial outcome recovery window: 5000ms`;
- the explicit statement that this one invocation may launch up to three Claude-backed phases: `plan`, `execute`, and `verify`;
- confirmation that the fixture is clean;
- confirmation that the main checkout must remain unchanged;
- the frozen rendered-contract identity used for approval;
- the intended file scope / expected diff scope for Scenario A success;
- the expected controller-owned artifacts and review outputs.

### 7.2 Cost and budget semantics

The approval package must also state:

- `tokenBudget` is a controller stopping threshold derived from adapter-reported usage, not a guaranteed API-cost cap;
- the invocation may consume budget across up to three Claude-backed phases;
- each produced phase artifact is expected to carry standard usage-evidence fields, alias selection, `normalizedTotal`, and `tokenUsage` whenever the normalized total is finite and positive;
- usage evidence improves auditability, but does not make the run successful by itself.

### 7.3 Approval mismatch rule

If the real command, paths, or budgets differ from the approval package, the invocation must not run.

## 8. Run Interpretation and PASS Gate

### 8.1 PASS gate

A-04 may be counted as successful only when all of the following agree:

- the full controller-owned chain reaches `succeeded`;
- the Git diff stays within intended Scenario A scope;
- the fixture checkout remains safe and the main checkout remains unchanged;
- attempt worktree cleanup or retention matches the expected terminal behavior;
- no uncontrolled subprocess remains;
- required plan, execution, and verify artifacts are present and readable;
- each persisted phase `usageEvidence.normalizedTotal` agrees with the corresponding persisted `tokenUsage`;
- the final token stop can be independently reconstructed from the phase artifacts.

Executor claims, process exit, or executor-captured tests alone are never sufficient.

### 8.2 PASS disqualifiers

The following conditions do not define a new runtime kill mechanism. They define conditions under which the finished invocation cannot be accepted as PASS and must be interpreted through the non-success rules below:

- the main checkout changed;
- path scope escaped the allowed Scenario A boundary;
- A-04 paths were reused or polluted;
- the evidence chain is irreconcilably corrupt or non-explainable;
- an uncontrolled subprocess remains;
- a controller-owned required artifact that should exist cannot be produced or interpreted.

## 9. Non-Success Classification

### 9.1 FAIL / PRODUCT_DEFECT

Use this when controller-owned evidence, artifact integrity, or token-accounting evidence contradicts the terminal outcome in a way attributable to ccloop product behavior.

### 9.2 INCONCLUSIVE / ENVIRONMENT_FAILURE

Use this when the environment prevents a meaningful conclusion without showing a product defect.

### 9.3 INCONCLUSIVE / RUNTIME_VARIANCE

Use this when the Claude-backed run stops safely inside the product boundary, but does not produce a full successful evidence chain, and the stop remains explainable from preserved evidence.

### 9.4 INCONCLUSIVE / CONTRACT_GAP

Use this only when the preserved evidence shows that the current contract or evidence model could not cleanly express what happened, without first proving a product defect.

## 10. Single-Run Stop Policy

This invocation is intentionally single-run and non-ratcheting.

After A-04 finishes:

- do not automatically retry;
- do not reuse the run directory;
- do not silently widen budgets or scope;
- do not automatically propose A-05 in the same turn;
- do not treat a near-success as authorization for another paid call.

If the result is `FAIL / PRODUCT_DEFECT`, preserve evidence, debug the confirmed defect, write the focused regression, and make only the minimum separately approved fix before any future paid retry is considered.

For every other non-success outcome, preserve evidence and stop. Any future real-scenario invocation requires a new explicit approval.

## 11. Required Conclusion Package

The finished invocation must yield a concise, auditable conclusion package containing:

- verdict and diagnosis;
- key evidence paths;
- stop reason;
- token-budget reconstructability summary;
- fixture, main-checkout, worktree, and subprocess safety conclusions;
- whether another scenario may proceed.

The default answer to further real-scenario progression remains: not without a new explicit approval.

## 12. Completion Criteria

This design increment is complete when:

- the A-04 invocation envelope is documented and frozen as a proposal rather than an authorization;
- the deterministic preflight and approval package are defined mechanically enough to execute without improvisation;
- PASS remains controller-owned and evidence-based;
- non-success outcomes stop cleanly without self-extending into another paid call;
- no new V2 mechanism is introduced under the guise of A-04 preparation.
