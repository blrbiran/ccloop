# A-04 Branch Assessment and Merge Readiness Design

> Status: approved on 2026-07-19
> Scope: assess whether the existing `a04-preflight-approval` branch should be retained and tightened toward merge readiness, with committed branch state reviewed before local drift.
> Parent artifacts: [`docs/handover/ccloop-handover.md`](../../handover/ccloop-handover.md), [`2026-07-18-a04-preflight-and-stop-boundaries-design.md`](2026-07-18-a04-preflight-and-stop-boundaries-design.md), [`../plans/2026-07-18-a04-preflight-and-approval.md`](../plans/2026-07-18-a04-preflight-and-approval.md)

## 1. Goal

Decide whether the existing `a04-preflight-approval` branch is strong enough to keep, tighten, and prepare for merge back to `main`, instead of defaulting to a clean re-prepare.

This design governs branch assessment and branch-local tightening only. It does not authorize a paid Scenario A invocation.

## 2. Scope

This increment defines:

- the review order for takeover of the existing `a04-preflight-approval` branch;
- the preferred decision rule for preserving existing branch work;
- the merge-readiness standard for product code, `validation/v1/README.md`, and related plan/report documents;
- the classification rule for current uncommitted drift inside the worktree;
- the exact outputs expected from the assessment.

It does not:

- trigger a real Claude paid call;
- clean, rewrite, or reuse preserved evidence under `.worktrees/evidence-first-v1/.validation-runs/`;
- delete backup branches, stashes, or linked worktrees;
- authorize destructive Git cleanup;
- declare focused test success alone sufficient for a paid Scenario A run.

## 3. Approach Selection

Three approaches were considered:

1. **Keep the original branch and assess committed surface first** — preserve existing A-04 work where possible, judge the committed product/docs surface first, then classify local drift.
2. **Align to current `main` first, then review** — pull upstream state into the branch before assessing whether the branch itself is worth keeping.
3. **Clean local drift first, then review product state** — tidy the worktree before deciding whether the committed branch content deserves retention.

Approach 1 is chosen.

Approach 2 is rejected for now because it mixes upstream movement into the assessment before proving that the branch’s own committed A-04 line is worth preserving. Approach 3 is rejected because it spends effort on local cleanup before establishing whether the committed branch state should remain the source of truth at all.

## 4. Operating Facts and Invariants

At design approval time, the intended live baseline is:

- `main` currently observed at `3108c5c`;
- `a04-preflight-approval` committed HEAD currently observed at `c3036dc`;
- the active A-04 worktree still contains local uncommitted drift that must be classified separately from committed branch value.

Current Git and filesystem reality override stale handover snapshots if they differ.

The following invariants remain fixed:

- preserved real-run evidence lives only under `.worktrees/evidence-first-v1/.validation-runs/` and must not be cleaned or rewritten;
- no real Claude paid call is allowed during this assessment/tightening increment;
- backup branch `backup/evidence-first-v1-before-memory-history-cleanup` and retained stashes must not be deleted or published;
- the existing A-04 branch must not be treated as ready for paid Scenario A merely because focused tests once passed;
- product behavior, `validation/v1/README.md`, and related plan/report truthfulness all matter for merge readiness.

## 5. Assessment and Tightening Order

### 5.1 Lock the real baseline first

Start from current Git truth, not handover memory:

- confirm current `main` head;
- confirm current `a04-preflight-approval` committed head;
- confirm current uncommitted files in the A-04 worktree.

### 5.2 Review committed product surface before local drift

Judge whether the committed A-04 line is worth preserving by reviewing the product-facing branch delta first, especially:

- `validation/v1/lib/a04.ts`;
- `validation/v1/lib/scenarios.ts`;
- `tests/validation/prepareA04.test.ts`;
- `tests/validation/contracts.test.ts`;
- `validation/v1/README.md`;
- `docs/handover/ccloop-handover.md`;
- `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`.

If additional branch-local reports affect whether the branch is truthful and merge-ready, review them after this minimum set. If they only capture local process history and do not change branch truthfulness, they may remain outside the merge surface.

The question at this stage is not whether the worktree is tidy. The question is whether the committed A-04 preparation line remains coherent, useful, and aligned with the approved A-04 boundaries.

### 5.3 Judge merge semantics against current `main`

Before rebasing or broad cleanup, classify the committed branch delta relative to current `main` into:

- product/doc changes that should be preserved and eventually merged;
- branch-internal evolution that was useful during review but should not be carried into `main`.

### 5.4 Classify current local drift separately

Only after the committed branch surface has been judged, classify the current uncommitted files into:

- changes that must be tightened into the merge surface because they affect current truthfulness;
- changes that may remain local because they are process traces rather than merge-worthy state;
- changes that require additional verification before either choice is safe.

### 5.5 Tighten only what the chosen merge surface requires

If the committed branch is worth preserving, continue tightening on the original branch and keep changes surgical:

- preserve the accepted A-04 product path;
- update `validation/v1/README.md` where branch truth changed;
- update only the related plan/report files needed to make the branch state truthful and reviewable;
- avoid dragging purely local OpenWolf/process traces into the merge surface unless they are required for correctness of the written record.

## 6. Merge-Ready Completion Standard

### 6.1 Product surface

The branch is not merge-ready unless the committed A-04 preparation path still proves all of the following:

- A-04 fixed-envelope constraints remain mechanically enforced;
- preparation remains non-paid and deterministic;
- the approval package remains bound to the verified checkout / frozen contract path rather than a mutable operator path;
- Scenario A-only override boundaries remain explicit and tested;
- critical tests validate behavior, not just the current implementation shape.

### 6.2 Documentation surface

The branch is not merge-ready unless `validation/v1/README.md` and related plan/report artifacts are truthful about:

- current observed `main` / branch reality rather than stale handover snapshots;
- the difference between preserved real-run evidence and local non-paid prepare artifacts;
- the fact that passing focused checks does not automatically authorize paid Scenario A.

### 6.3 Worktree surface

The branch is not merge-ready while uncommitted drift remains unclassified. Every current local file in the A-04 worktree must end in one explicit bucket:

- merge surface;
- local-only residue;
- unresolved and requiring further verification.

### 6.4 Verification surface

The branch is not merge-ready without non-paid confirmation through the relevant deterministic checks, including focused validation tests plus typecheck/build, and any additional baseline confirmation needed by the final classification.

## 7. Expected Outputs

This assessment/tightening increment must end with:

1. a direct branch verdict:
   - continue original branch tightening toward merge,
   - preserve branch but add one more tightening pass, or
   - abandon branch and prefer clean prepare;
2. a classified list of:
   - committed changes worth preserving,
   - uncommitted changes that must enter the merge surface,
   - uncommitted changes that should remain local,
   - uncommitted changes that remain unresolved and require further verification;
3. an explicit next-step recommendation describing what still needs tightening before the branch can be prepared for merge to `main`.

Under the approved preference for this increment, the default target is to continue tightening the original branch unless a clear blocker disproves that path.

## 8. Execution Boundaries

During this increment, it is allowed to:

- keep working inside `.worktrees/a04-preflight-approval`;
- edit product files, `validation/v1/README.md`, and related plan/report files needed for truthfulness;
- run non-paid deterministic verification.

During this increment, it is not allowed to:

- run a paid Scenario A call;
- rewrite preserved evidence;
- delete backup/stash safety state;
- use destructive Git cleanup as a shortcut;
- present the branch as paid-run-ready before the branch review and tightening standard is met.

## 9. Completion Criteria

This design increment is complete when:

- the takeover review order is fixed as committed-surface-first on the original branch;
- merge readiness is defined across product code, `validation/v1/README.md`, and related plan/report truthfulness;
- local drift is classified explicitly instead of being hand-waved as acceptable noise;
- the final result is a concrete retain/tighten-or-not branch decision rather than a vague status impression;
- no paid call or evidence rewrite is performed while making that decision.
