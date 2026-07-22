# Ownership and Reconciliation Boundaries Design

> Status: proposed on 2026-07-22
> Scope: define controller-owned ownership truth, strict owner-loss rules, and read-first reconciliation boundaries required before any future resume, adopt, or scheduled continuation.
> Parent backlog: [`docs/ccloop-v2-review-backlog.md`](../../ccloop-v2-review-backlog.md)
> Related prior design: [`2026-07-21-stop-no-progress-stale-boundaries-design.md`](2026-07-21-stop-no-progress-stale-boundaries-design.md)
> Related truth sources: [`docs/handover/ccloop-handover.md`](../../handover/ccloop-handover.md), [`validation/v1/README.md`](../../../validation/v1/README.md)
> Reference inputs: `reference/loop-engineering/`, `reference/DoWhiz/DoWhiz_service/`

## 1. Goal

Define the minimum ownership and reconciliation contract that ccloop must have before any future resume, adopt, or scheduler-driven continuation can be considered safe.

This design assumes the run-level `stop / no-progress / stale-run` boundary layer already exists. Its purpose is to answer three follow-on questions without guessing:

1. who currently owns a run's execution rights;
2. when that owner can be declared lost, superseded, or undecidable; and
3. under what conditions reconciliation may atomically establish a new owner epoch that is eligible for later continuation.

This design does not authorize actual continuation. It defines the ownership and reconciliation contract that later resume/adopt/scheduler work must obey.

## 2. Non-Goals

This design does not:

- implement scheduler or daemon behavior;
- implement actual continuation or resume execution;
- implement cleanup or orphan GC behavior;
- redefine the previously approved `stop / no-progress / stale-run` state model;
- authorize any paid Claude run;
- rewrite accepted historical evidence.

In particular, it does not change the accepted `D-01` historical truth. Any historical reinterpretation still requires a separate `review-reclassified.json` flow.

## 3. Core Principles

### 3.1 Controller-owned persisted state is the ownership source of truth

Ownership truth is anchored in controller-owned persisted state, not in the mere existence of a live process.

Process/liveness/workspace observations are supporting evidence only.

### 3.2 Exactly one current owner epoch per run session

A run may have historical owners, but it may have only one current owner epoch at any point in time.

This is the ccloop analogue of the `loop-engineering` “one owner per branch” principle, narrowed to a single run/logical session rather than a whole repository branch.

### 3.3 Reconciliation is read-first and deny-by-default

Reconciliation begins as an audit step. It reads persisted truth and supporting evidence, produces an ownership verdict, and only then may attempt a constrained owner transfer.

It is not a background repair daemon and not a hidden executor.

### 3.4 Epoch rotation means supersede, not just version bump

When a new owner epoch is established, the previous owner epoch is superseded and loses execution authority.

This is a hard control boundary, not just metadata.

### 3.5 Timeout and watchdog signals are suspicion triggers, not ownership truth

As in the stale-boundary design, timeout/watchdog overrun may trigger suspicion and reconciliation, but they are not sufficient by themselves to prove owner loss.

## 4. Truth Layers

Ownership and reconciliation operate across three layers.

### 4.1 Layer A — controller-owned ownership truth

This is the only authoritative ownership layer.

It includes persisted controller-owned records such as:

- run state;
- controller-owned events;
- controller-owned boundary artifacts;
- controller-owned owner records introduced by this design.

Any final ownership verdict must be explainable in terms of this layer.

### 4.2 Layer B — supporting liveness and continuity observations

These observations may strengthen or weaken an ownership interpretation, but cannot by themselves overrule Layer A.

Examples include:

- process or runtime liveness observations;
- worktree presence or absence;
- artifact growth or lack of growth;
- observed workspace remnants.

### 4.3 Layer C — reconciliation output

Reconciliation output is a derived judgment over Layers A and B.

It is not a new primitive truth layer and must not silently replace the underlying controller-owned record.

## 5. Ownership Data Model

This design introduces a dual-level ownership model.

### 5.1 Run identity

The run identity does not change across owner transfer.

### 5.2 Logical session

A logical session represents the conceptual continuity of the run's execution lineage.

Multiple process instances may belong to the same logical session if continuity is mechanically proven.

### 5.3 Process instance

A process instance is the specific execution carrier currently attempting to act for the logical session.

Process instances may change without implying owner transfer.

### 5.4 Owner epoch

Owner epoch is the execution-authority generation for the run's current logical session.

Its meaning is:

- which owner generation currently holds execution rights;
- whether a formal owner transfer has occurred;
- whether older writers are still valid or have been superseded.

### 5.5 Required persisted owner record

This design requires an explicit controller-owned owner record, not an implicit interpretation.

Recommended minimum fields:

- run identity;
- logical session identifier;
- current owner epoch;
- current process instance identifier;
- owner freshness anchor or last affirmed-at timestamp;
- owner status.

The exact file path and schema details may be finalized in implementation planning, but the explicit owner record itself is required by this design.

## 6. Epoch Rotation and Supersede Semantics

### 6.1 When epoch does not rotate

Ordinary process-instance changes do not necessarily rotate owner epoch.

If logical session continuity remains mechanically proven, the system may update the current process-instance record while keeping the same owner epoch.

### 6.2 When epoch must rotate

Epoch must rotate when reconciliation performs a formal owner transfer.

This is the only transfer path this design authorizes.

### 6.3 What superseded means

Once a new owner epoch is established:

- the old owner epoch loses execution authority;
- later writes or continuation attempts from the old epoch must be treated as stale, superseded, or invalid candidates;
- the controller-owned record must make the supersede boundary explicit.

This mirrors the useful `thread_epoch` / supersede idea in DoWhiz, but relocates the authority into controller-owned persisted truth rather than transient worker-only behavior.

## 7. Strict Owner-Loss Conditions

Owner loss is a stronger claim than stale suspicion.

### 7.1 What must be true

To conclude `OWNER_LOST`, all of the following must hold:

1. Layer A no longer supports the original owner's continued authority.
   - The persisted owner record is no longer fresh enough or coherent enough to keep the old owner valid.
2. Layer B does not supply a credible counter-claim for the old owner.
   - There is no trustworthy liveness or continuity evidence that keeps the original owner mechanically valid.
3. The run is not already explained by a newer valid owner epoch.
   - If a newer valid owner epoch already exists, the correct verdict is `OWNER_SUPERSEDED`, not `OWNER_LOST`.

### 7.2 What is explicitly insufficient

The following are not sufficient on their own to prove owner loss:

- process disappearance;
- watchdog or timeout overrun;
- worktree presence or absence;
- artifact or log stagnation;
- stale-candidate status alone.

These may trigger reconciliation or suspicion, but not final owner-loss truth by themselves.

### 7.3 Why this is strict

A mistaken owner-loss judgment is more dangerous than an overly conservative human handoff, because it can authorize a false owner transfer.

This design therefore prefers `OWNER_UNDECIDABLE` over speculative automation.

## 8. Reconciliation Owner Verdicts

Reconciliation must be able to produce at least the following ownership verdicts.

### 8.1 `OWNER_VALID`

The current owner epoch remains valid.

No owner transfer is permitted.

### 8.2 `OWNER_LOST`

The old owner no longer has authority, but no newer owner epoch has yet been established.

This verdict is a prerequisite for a possible owner transfer, but it is not itself a transfer.

### 8.3 `OWNER_SUPERSEDED`

A newer owner epoch already exists and has superseded the older owner.

This verdict means ownership transfer has already happened; reconciliation must not behave as though it still needs to create one.

### 8.4 `OWNER_UNDECIDABLE`

The available evidence is insufficient or contradictory.

This must route to human-only handling.

## 9. Reconciliation Flow

Reconciliation follows a three-phase model.

### 9.1 Read phase

Read, but do not modify:

- controller-owned owner records;
- run state and events;
- boundary-analysis and related controller-owned artifacts;
- supporting liveness/workspace/process observations.

### 9.2 Verdict phase

Compute:

- ownership verdict (`OWNER_VALID` / `OWNER_LOST` / `OWNER_SUPERSEDED` / `OWNER_UNDECIDABLE`);
- whether takeover is allowed;
- the last trusted boundary of the run.

Still do not modify ownership truth during this phase.

### 9.3 Transfer phase

Only if:

- verdict is `OWNER_LOST`; and
- takeover is explicitly allowed

may reconciliation enter a constrained write phase.

## 10. Read-Only Reconciliation Contract

Before transfer begins, reconciliation is audit-only.

It may not:

- repair or rewrite arbitrary controller-owned state;
- rewrite historical evidence;
- silently delete workspaces or artifacts;
- continue task execution;
- broaden into resume or scheduler policy.

Its function is to produce a trustworthy decision boundary, not to impersonate later execution systems.

## 11. Takeover Permission Conditions

Takeover permission must be stricter than stale confirmation.

`takeoverAllowed = true` requires all of the following:

1. ownership verdict is exactly `OWNER_LOST`;
2. the last trusted run boundary is known;
3. persisted truth and supporting evidence are not contradictory in a way that requires human interpretation;
4. the new owner epoch can be established atomically;
5. the transfer does not itself imply continuation.

If any condition fails, takeover remains denied.

## 12. Atomic Owner Transfer

When transfer is allowed, the write phase must be a minimal, explicit owner-transfer action.

Recommended minimum effects:

- create a new current owner epoch;
- mark the older epoch superseded;
- record the new current process-instance identity;
- record the owner-transfer audit event.

This transfer gives execution eligibility only. It does not resume the run.

## 13. Eligible for Continuation Is Not Continuation

A successful owner transfer produces an `eligible-for-continuation` state.

That means:

- ownership has been resolved;
- a new valid owner epoch now exists;
- a later resume/adopt/scheduler layer may decide whether to continue.

It does **not** mean that reconciliation itself continues work.

## 14. Human-Only Boundary

Any of the following must force `OWNER_UNDECIDABLE` and human-only handling:

- Layer A is incomplete or contradictory;
- Layer B supports multiple plausible owner interpretations;
- the last trusted run boundary cannot be identified;
- owner loss cannot be distinguished from owner supersede;
- the owner transfer cannot be guaranteed atomically.

The rule is simple: if reconciliation would need to guess, it must not take over.

## 15. Relationship to the Existing Stop/Stale Layer

This design builds on the earlier stale-boundary spec but does not replace it.

- stale suspicion may trigger reconciliation;
- reconciliation may conclude `OWNER_VALID`, `OWNER_LOST`, `OWNER_SUPERSEDED`, or `OWNER_UNDECIDABLE`;
- only `OWNER_LOST` may lead to a possible owner transfer;
- even then, transfer only yields continuation eligibility, not immediate execution.

Thus:

- `stale-candidate` does not equal owner lost;
- owner lost does not equal continuation;
- continuation remains a later design concern.

## 16. Validation Requirements for Future Implementation

A future implementation must prove at least the following.

### 16.1 Ownership truth

- only one current owner epoch exists at a time;
- old epochs become invalid once superseded;
- process-instance churn without continuity break does not force epoch rotation.

### 16.2 Owner-loss strictness

- watchdog/timeout alone cannot prove owner loss;
- process disappearance alone cannot prove owner loss;
- stale suspicion alone cannot prove owner loss.

### 16.3 Reconciliation verdicts

- `OWNER_VALID` blocks transfer;
- `OWNER_LOST` may allow transfer only if the stricter conditions are met;
- `OWNER_SUPERSEDED` blocks duplicate transfer;
- `OWNER_UNDECIDABLE` routes to human-only.

### 16.4 Atomic transfer

- a successful transfer cannot leave the old and new owner epochs simultaneously current;
- a failed transfer cannot leave the run in a half-transferred state.

### 16.5 Separation of concerns

- reconciliation does not itself continue execution;
- cleanup is not triggered merely because ownership changed;
- historical accepted evidence remains untouched.

## 17. Follow-On Specs Required

This design intentionally leaves the following next specs:

1. **Resume / adopt design**
   - how an eligible run actually resumes under a valid new owner epoch.
2. **Scheduler / unattended execution design**
   - when and how an eligible run is re-queued or continued.
3. **Cleanup / orphan handling design**
   - how superseded or lost-owner workspaces and evidence are retained or cleaned up safely.

## 18. Success Criteria

This design is successful only if a later implementer can answer all of the following without inventing new policy:

- what controller-owned record defines ownership truth;
- how logical session, process instance, and owner epoch relate;
- when owner loss is proven vs merely suspected;
- how supersede is recorded and enforced;
- what reconciliation may read, decide, and write;
- why an owner transfer grants eligibility rather than automatic continuation.
