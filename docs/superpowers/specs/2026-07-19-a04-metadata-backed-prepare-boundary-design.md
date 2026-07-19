# A-04 Metadata-Backed Prepare Boundary Design

> Status: approved on 2026-07-19
> Scope: redesign the non-paid A-04 prepare / approval-package boundary so it no longer hard-depends on the deleted `evidence-first-v1` linked worktree or its preserved `.validation-runs/` tree, while preserving the evidence-first intent through mechanically checked metadata.
> Parent artifacts: [`2026-07-18-a04-preflight-and-stop-boundaries-design.md`](2026-07-18-a04-preflight-and-stop-boundaries-design.md), [`2026-07-18-claude-usage-evidence-design.md`](2026-07-18-claude-usage-evidence-design.md), [`2026-07-19-a04-branch-assessment-and-merge-readiness-design.md`](2026-07-19-a04-branch-assessment-and-merge-readiness-design.md), [`../plans/2026-07-18-a04-preflight-and-approval.md`](../plans/2026-07-18-a04-preflight-and-approval.md)

## 1. Goal

Allow a fresh non-paid A-04 prepare / approval-package run to proceed from `main` even after the old `evidence-first-v1` linked worktree and its preserved `.validation-runs/` tree have been deleted, without weakening the non-paid, approval-first, evidence-first intent of the A-04 boundary.

The redesign changes what the A-04 read-only inspection must prove. It does not authorize a paid call, change Scenario A semantics, or change the A-04 envelope.

## 2. Scope

This increment defines:

- the new source of truth for A-04 historical context when the old linked worktree is gone;
- the required metadata set that must remain mechanically readable before non-paid A-04 prepare may continue;
- which missing historical artifacts become soft signals versus hard blockers;
- the minimum code and documentation surfaces that must change.

It does not:

- recover or recreate deleted preserved evidence trees;
- treat newly created local `.validation-runs/**` artifacts as historical preserved evidence;
- change the A-04 envelope (`550000 / 600000 / 1200000 / 5000`);
- change Scenario A success criteria, stop rules, or paid-call approval semantics;
- allow destructive cleanup or silent evidence substitution.

## 3. Approach Selection

Three approaches were considered:

1. **Metadata-backed inspection** — keep the A-04 read-only inspection, but retarget it from historical worktree artifacts to currently available repository metadata and history anchors.
2. **Human-only historical review** — remove the mechanical historical inspection entirely and rely on a human to read the handover and specs before prepare.
3. **Historical artifact hard-gate** — continue requiring the old linked worktree and its `.validation-runs/` evidence as mandatory prerequisites.

Approach 1 is chosen.

Approach 2 is rejected because it weakens a previously mechanical safety boundary into a purely manual one. Approach 3 is rejected because the required linked worktree and preserved evidence tree are already gone, so keeping them as hard requirements would permanently block non-paid A-04 prepare even though the relevant code and approved boundaries now live on `main`.

## 4. New Boundary Principle

The A-04 prepare path must continue to prove that the operator is acting within the approved evidence-first historical context. It no longer needs the deleted `evidence-first-v1` linked worktree to do that.

The new principle is:

> Historical context for A-04 must be reconstructable from currently accessible repository metadata, not from a previously retained linked worktree artifact tree.

This means the prepare path must still fail when the historical context cannot be reconstructed, but it must stop treating the deleted linked worktree itself as the only acceptable source.

### 4.1 Superseded governing sections

This redesign supersedes any currently active A-04 prepare guidance that still makes the deleted legacy worktree or its preserved `.validation-runs/` tree a hard prerequisite.

At minimum, implementation of this redesign must supersede or update:

- `docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md` §6.1 `Read-only repository and evidence check`, which currently lists the evidence-first validation worktree, retained stashes, and preserved `.validation-runs/` evidence tree as inspection targets;
- any mirrored implementation guidance in `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md` that still treats those legacy artifacts as hard preconditions rather than metadata-backed inputs.

Until those older sections are updated or explicitly annotated as superseded, this spec is the authoritative boundary for the A-04 read-only inspection.

## 5. Required Metadata Set

A non-paid A-04 prepare may proceed only if the following metadata sources are readable and mutually consistent enough to reconstruct the A-04 boundary:

1. `docs/handover/ccloop-handover.md`
2. `docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md`
3. `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
4. `docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md`
5. local branch `backup/evidence-first-v1-before-memory-history-cleanup`

From this set, the prepare path must still be able to reconstruct at least these facts:

- A-04 remains the first real paid Scenario A target;
- A-01 through A-03 were historical evidence-first runs with the recorded diagnoses described in current handover/specs;
- current local `.validation-runs/**` dry-run artifacts are not historical preserved evidence;
- A-04 remains non-paid during prepare and approval-package generation;
- the paid-call gate still requires separate explicit approval after prepare succeeds.

### 5.1 Machine-checkable inspection summary contract

The metadata-backed inspection must produce a structured summary rather than ad hoc string checks. The minimum contract is:

```ts
type RequiredSourceStatus = "PRESENT" | "MISSING" | "UNREADABLE";
type SoftSignalStatus = "PRESENT" | "MISSING" | "UNREADABLE";
type ContradictionStatus = "CONFIRMED" | "CONTRADICTORY" | "INSUFFICIENT";

type MetadataInspectionSummary = {
  mainCheckout: {
    status: "PRESENT";
    path: string;
    head: string;
    branch: "main";
  };
  requiredSources: {
    handoverDoc: { status: RequiredSourceStatus; path: string };
    a04BoundarySpec: { status: RequiredSourceStatus; path: string };
    a04BoundaryPlan: { status: RequiredSourceStatus; path: string };
    usageEvidenceSpec: { status: RequiredSourceStatus; path: string };
    backupBranch: {
      status: RequiredSourceStatus;
      name: string;
      head?: string;
      mergeBaseWithMain?: string;
      distinctFromMain?: boolean;
    };
  };
  softSignals: {
    retainedStashes: { status: SoftSignalStatus; matches: string[] };
    legacyEvidenceWorktree: { status: SoftSignalStatus; path: string };
    legacyPreservedEvidenceTree: { status: SoftSignalStatus; path: string };
  };
  contradictionChecks: {
    firstRealPaidScenarioA: { status: ContradictionStatus; sources: string[] };
    historicalA01ToA03Diagnoses: { status: ContradictionStatus; sources: string[] };
    localDryRunArtifactsNotHistoricalEvidence: { status: ContradictionStatus; sources: string[] };
    paidCallStillRequiresExplicitApproval: { status: ContradictionStatus; sources: string[] };
  };
};
```

This summary becomes the approval-package inspection payload and the test surface for distinguishing hard failures from soft warnings.

## 6. Soft Signals vs Hard Blockers

### 6.1 Hard blockers

Non-paid A-04 prepare must fail if any of the following is true:

- `main` checkout is unreadable or cannot be established as the current execution base;
- `requiredSources.handoverDoc.status !== "PRESENT"`;
- `requiredSources.a04BoundarySpec.status !== "PRESENT"`;
- `requiredSources.a04BoundaryPlan.status !== "PRESENT"`;
- `requiredSources.usageEvidenceSpec.status !== "PRESENT"`;
- `requiredSources.backupBranch.status !== "PRESENT"`;
- `requiredSources.backupBranch.distinctFromMain !== true`;
- `requiredSources.backupBranch.mergeBaseWithMain` is absent;
- any contradiction check returns `"CONTRADICTORY"` or `"INSUFFICIENT"`.

This list is intentionally a one-to-one mechanical mapping of the required metadata set plus its required contradiction checks.

### 6.2 Soft signals

The following are no longer blocking by themselves, but must be surfaced in the inspection summary returned by prepare:

- retained stashes present or missing;
- legacy `evidence-first-v1` linked worktree present or missing;
- legacy preserved `.validation-runs/` evidence tree present or missing.

These signals may influence human review of the approval package, but they do not automatically stop non-paid prepare.

### 6.3 Minimum contradiction checks

The metadata-backed inspection must at minimum compare enough source text / branch facts to classify these four checks:

1. **`firstRealPaidScenarioA`** — current metadata still agrees that A-04 remains the first real paid Scenario A target.
2. **`historicalA01ToA03Diagnoses`** — current metadata still agrees on the recorded A-01 through A-03 historical diagnoses and their evidence-first role.
3. **`localDryRunArtifactsNotHistoricalEvidence`** — current metadata still states that fresh local `.validation-runs/**` outputs are not historical preserved evidence.
4. **`paidCallStillRequiresExplicitApproval`** — current metadata still states that non-paid prepare does not authorize a paid call.

If any of these cannot be confirmed from the required metadata set, prepare must fail rather than silently downgrade to a human-only interpretation.

## 7. Explicit Non-Substitution Rule

The redesign must explicitly forbid replacing missing historical preserved evidence with newly created local dry-run artifacts.

In particular:

- `main/.validation-runs/fixture-01` is a fresh local fixture, not historical preserved evidence;
- `main/.validation-runs/contracts/A-04.json` is a fresh local non-paid prepare artifact, not historical preserved evidence;
- no current `.validation-runs/**` path may be relabeled as A-01 through A-03 preserved evidence simply because the old linked worktree is gone.

The historical A-01 through A-03 narrative remains grounded in handover/spec/plan metadata, not in replacement artifact generation.

## 8. Minimal Code Changes

### 8.1 `validation/v1/lib/a04.ts`

The `defaultInspectReadOnlyInspection(...)` path must be changed from a hard dependency on:

- a registered `refs/heads/evidence-first-v1` worktree, and
- that worktree's `.validation-runs/**` preserved evidence tree,

into a metadata-backed inspection that:

- verifies current `main` checkout readability;
- verifies every required metadata source in §5;
- verifies the backup branch both exists and resolves to a distinct locally reachable history anchor relative to `main`;
- produces the structured `MetadataInspectionSummary` contract defined in §5.1;
- records soft-status fields for retained stashes, legacy evidence worktree availability, and preserved evidence availability.

### 8.2 `tests/validation/prepareA04.test.ts`

Focused tests must be updated so that:

- missing legacy `evidence-first-v1` worktree is no longer an automatic prepare failure when the required metadata set is present;
- missing retained stashes is surfaced as a non-blocking inspection result;
- missing handover, preflight boundary spec, preflight boundary plan, usage-evidence spec, or backup branch still fails prepare;
- backup branch existence without a distinct reachable history anchor still fails prepare;
- current local `.validation-runs/contracts/A-04.json` is not treated as historical preserved evidence;
- the inspection summary distinguishes hard metadata failures from soft legacy-availability warnings;
- contradiction checks fail when the metadata set cannot confirm the four required historical assertions from §6.3.

### 8.3 `validation/v1/README.md`

Operator documentation must explain that A-04 prepare now checks metadata-backed historical context from current `main`, not the continued existence of the old linked worktree. It must also preserve the distinction between fresh local dry-run artifacts and historical evidence.

### 8.4 `docs/handover/ccloop-handover.md`

The handover must document the new reality explicitly:

- the old linked `evidence-first-v1` worktree and its preserved evidence tree are no longer available;
- A-04 historical context is now reconstructed from current repository metadata and branch history anchors;
- historical A-01 through A-03 semantics remain binding even though the old preserved artifact tree is gone.

### 8.5 Legacy governing-doc alignment

Implementation of this redesign must also update or annotate the older A-04 governing documents so they no longer present the deleted legacy worktree and preserved evidence tree as active hard gates. Leaving those sections unchanged would keep two contradictory A-04 prepare boundaries alive at once.

### 8.6 Backup branch meaning

In this redesign, the backup branch proves more than simple name existence. It is the remaining local history anchor showing that a distinct pre-cleanup evidence-first lineage is still reachable for metadata-level reconstruction. The minimum mechanical proof is:

- the branch resolves to a commit (`head` present),
- the branch has a merge base with current `main`, and
- the branch head is distinct from current `main` head.

That proof is sufficient for this redesign without requiring restoration of the deleted legacy worktree itself.
## 9. Unchanged Boundaries

This redesign does not change any of the following:

- A-04 envelope: `tokenBudget 550000`, `perAttemptTimeoutMs 600000`, `totalRuntimeBudgetMs 1200000`, `partialOutcomeRecoveryWindowMs 5000`, `maxAttempts 1`, `automatic retries none`;
- Scenario A success criteria;
- approval package semantics and paid-call approval requirements;
- fresh fixture / fresh contract / fresh run/evidence path requirements;
- the rule that focused tests passing does not authorize a paid call.

## 10. Completion Criteria

This redesign is complete when:

- non-paid A-04 prepare can proceed without the deleted `evidence-first-v1` linked worktree;
- prepare still fails when the repository no longer carries enough metadata to reconstruct the A-04 historical boundary;
- soft legacy signals are surfaced but no longer over-constrain the prepare path;
- newly created local `.validation-runs/**` artifacts are explicitly prevented from masquerading as historical preserved evidence;
- no paid-call, stop-rule, or Scenario A semantic boundaries are weakened in the process.
