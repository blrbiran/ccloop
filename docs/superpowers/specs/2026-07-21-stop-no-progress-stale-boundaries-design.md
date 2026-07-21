# Stop, No-Progress, and Stale-Run Boundaries Design

> Status: proposed on 2026-07-21
> Scope: define the run-level stop, no-progress, and stale-run safety boundary layer required before future unattended or scheduled execution.
> Parent backlog: [`docs/ccloop-v2-review-backlog.md`](../../ccloop-v2-review-backlog.md)
> Related truth sources: [`docs/handover/ccloop-handover.md`](../../handover/ccloop-handover.md), [`validation/v1/README.md`](../../../validation/v1/README.md)
> Reference inputs: `docs/ref/LoopEngineering.md`, `docs/ref/loop-how-to-stop.md`, `docs/ref/claude-workflow.md`, `docs/ref/claude-scheduled.md`, `reference/loop-engineering/`, `reference/DoWhiz/DoWhiz_service/`

## 1. Goal

Define the minimum run-level boundary model that ccloop must have before unattended or scheduled execution can be considered safe.

This design does not implement scheduling, ownership, resume, or auto-recovery. It defines the boundary layer that those later designs must obey.

The design has four goals:

1. distinguish healthy progress from weak progress, no progress, and stale execution;
2. keep `no-progress` and `stale-run` as different classes of failure rather than one blended timeout bucket;
3. require a reconciliation step before any stale run can be auto-taken over; and
4. make auto-takeover deny-by-default, allowed only when stronger mechanical conditions prove it is safe.

## 2. Non-Goals

This design does not:

- implement scheduler or daemon behavior;
- implement full ownership, fencing, lease, or heartbeat mechanisms;
- implement full resume or adopt semantics;
- modify current V1 product code;
- authorize any real or paid Claude run;
- rewrite accepted historical evidence;
- define cleanup, orphan GC, or workspace-retention policy as part of stale detection.

Those remain later design topics.

## 3. Safety and Truth Principles

This design is constrained by the current ccloop evidence-first V1 truth.

1. Accepted historical evidence remains immutable.
   - In particular, `D-01` stays `INCONCLUSIVE / CONTRACT_GAP` unless a separate `review-reclassified.json` is explicitly requested later.
2. The stop/stale boundary layer may not invent new business truth.
   - It may classify run liveness and continuity, but it may not rewrite accepted historical outcome records.
3. Scheduler readiness is downstream of stop/stale correctness.
   - Unattended execution must not be designed first and then hope stop behavior can be added later.
4. Auto-takeover is deny-by-default.
   - Inspired by the `loop-engineering` verifier stance, stale confirmation is not itself permission to continue.
5. Cleanup is a separate concern.
   - Inspired by `loop-engineering` worktree cleanup separation, stale detection and reconciliation must not silently delete evidence or workspaces.
6. User-facing task result, stale/reconciliation result, and takeover permission must remain separate.
   - Inspired by `DoWhiz_service` result separation, these conclusions must not collapse into one ambiguous terminal label.

## 4. Placement in the Roadmap

This design is intentionally a smaller slice than a full unattended-execution architecture.

It comes before:

- ownership / reconciliation design;
- resume / adopt design;
- scheduler / workflow execution design;
- cleanup / orphan handling design.

Those later specs must consume this design as a boundary contract rather than redefining it ad hoc.

## 5. Run-Level State Model

The boundary layer evaluates runs using the following analysis states.

### 5.1 `healthy`

The run has recent strong progress and shows no current signal of stalled or broken execution continuity.

### 5.2 `weakly-progressing`

The run has no recent strong progress, but it still shows weak progress within a bounded grace window.

This state exists to avoid misclassifying long-running or noisy steps as failed too early.

### 5.3 `suspect`

The run has exceeded a healthy progress window or has consumed too much weak-progress grace, but the available evidence is not yet sufficient to classify it as `no-progress` or `stale-candidate`.

This is a suspicion state, not a final routing state.

### 5.4 `no-progress`

The run still appears to be owned and alive enough that stale classification is not the right explanation, but it is no longer making credible forward progress.

This is an execution-quality problem.

Default outcome: stop automatic continuation and require human takeover.

### 5.5 `stale-candidate`

The run shows signals that continuity, liveness, or ownership can no longer be trusted.

This is not yet confirmation. It is the input state for reconciliation.

### 5.6 `stale-confirmed`

Reconciliation has confirmed that the original execution continuity is broken and that the stale judgment is mechanically justified.

`stale-confirmed` still does not imply auto-takeover permission.

## 6. Evidence Classes

This design evaluates progress at the run level, but its evidence may come from lower-level phases, attempts, artifacts, and logs.

### 6.1 Strong progress

Strong progress is evidence that the run moved toward a new meaningful control boundary.

Examples include:

- a run-level state transition;
- a phase transition;
- an attempt boundary transition;
- entering or exiting a human gate;
- entering reconciliation;
- reaching a terminal state.

Strong progress refreshes the run's healthy window.

### 6.2 Weak progress

Weak progress is evidence that the system still has activity traces, but not enough to prove meaningful forward movement.

Examples include:

- artifact growth;
- log growth;
- metadata growth;
- observation-file updates that do not themselves change control meaning.

Weak progress may extend observation briefly, but it cannot indefinitely substitute for strong progress.

## 7. Time Windows and Limited Life Support

Time alone is not a kill signal. It is a suspicion signal.

This design requires at least two windows.

### 7.1 Healthy window

If no strong progress occurs inside this window, the run can no longer remain `healthy`.

### 7.2 Weak-progress grace window

If strong progress stops but weak progress continues, the run may remain `weakly-progressing` for a bounded grace period.

### 7.3 Limited life support rule

Weak progress can temporarily delay escalation, but it cannot do so forever.

When the run repeatedly consumes weak-progress grace without any new strong progress, it must escalate to `suspect`.

### 7.4 Time-only overrun rule

If the only evidence is “time window exceeded,” the run does not go directly to `no-progress`.

It first enters `suspect`, and only later routes to `no-progress` or `stale-candidate` depending on stronger evidence.

## 8. Run-Level Flow

The intended high-level routing is:

- `healthy` → `weakly-progressing` when strong progress stops but bounded weak progress continues;
- `weakly-progressing` → `suspect` when weak-progress grace is consumed without new strong progress;
- `suspect` → `healthy` if strong progress resumes;
- `suspect` → `no-progress` if the evidence points to a live-but-not-advancing run;
- `suspect` → `stale-candidate` if the evidence points to continuity or ownership breakage;
- `stale-candidate` → reconciliation;
- reconciliation → `stale-confirmed` or back to a non-stale state if the suspicion was wrong.

## 9. `no-progress` vs `stale-candidate`

These are different diagnoses and must stay different.

### 9.1 Route to `no-progress`

A run should route to `no-progress` when:

- strong progress is absent;
- weak progress is absent or has exhausted its allowed grace;
- the evidence still does not justify continuity/ownership failure as the primary explanation; and
- continuing automatically would more likely amplify noise than create trustworthy progress.

Interpretation: the run is not credibly advancing, but it is also not yet best explained as a stale continuity break.

Default outcome: human takeover.

### 9.2 Route to `stale-candidate`

A run should route to `stale-candidate` when:

- progress windows are exceeded; and
- the stronger explanation is that continuity, liveness, or ownership can no longer be trusted.

Examples of stale-leaning evidence may include:

- expected control-plane activity stopped in a way that suggests execution continuity broke rather than merely slowed;
- state freshness and activity traces are inconsistent with a still-owned live run;
- the run now looks more like an abandoned scene than a slow but coherent execution.

### 9.3 Priority rule

If stale-leaning continuity evidence is present, it takes routing priority over generic `no-progress`.

That is why `stale-candidate` exists as a distinct path instead of a subtype of `no-progress`.

## 10. Reconciliation Contract

Reconciliation is a bounded diagnostic step. It is not autonomous task continuation.

### 10.1 Responsibilities

Reconciliation may only:

1. determine whether stale suspicion is mechanically justified;
2. identify the last trustworthy boundary of the run;
3. detect whether the current evidence is coherent enough to allow constrained auto-takeover later; and
4. emit an explicit audit record of what it concluded.

### 10.2 Non-responsibilities

Reconciliation must not:

- invent missing truth;
- rewrite accepted historical evidence;
- silently clean up retained evidence or workspaces;
- continue the task as though stale had already been resolved;
- broaden into scheduler policy or multi-run orchestration.

### 10.3 Required output

Reconciliation must emit an explicit controller-owned record.

Recommended minimum fields:

- stale suspicion basis;
- stale confirmation verdict;
- last trusted run boundary;
- conflicting evidence summary, if any;
- takeover-allowed verdict;
- why takeover is allowed or denied.

The exact file path may be decided in the later ownership/reconciliation spec, but the existence of a durable explicit record is required by this design.

## 11. Auto-Takeover: Deny by Default

This design permits stale-path auto-takeover only as a constrained later action.

### 11.1 Default

`stale-confirmed` does not mean “continue automatically.”

The default is still deny.

### 11.2 Allow only when proven safe

Auto-takeover may be allowed only when stronger mechanical conditions are all satisfied.

At minimum, later design must prove:

1. stale is genuinely confirmed, not merely suspected;
2. the last trusted boundary is mechanically identifiable;
3. state, events, and artifacts are coherent enough that continuation does not require guessing;
4. there is no unresolved ownership ambiguity at takeover time;
5. the continuation action is explicit, constrained, and auditable;
6. the takeover does not require deleting or rewriting protected evidence first.

If any condition fails, the system must deny auto-takeover and route to human takeover instead.

## 12. Split Conclusions

The system must not collapse all outcomes into one flat status.

Future design must keep at least these three conclusions separate:

1. **Run outcome**
   - the business or verification meaning of the run itself;
2. **Boundary-layer outcome**
   - healthy, suspect, no-progress, stale-confirmed, and related reconciliation conclusions;
3. **Takeover permission**
   - allowed or denied, with reason.

This prevents stale handling from distorting business truth or vice versa.

## 13. Cleanup Is Not Part of This Layer

Cleanup, orphan detection, retained-workspace GC, and similar operational maintenance are intentionally out of scope here.

This design requires only one boundary:

- stale detection and reconciliation may identify retained or orphaned execution surfaces,
- but they may not treat “stale” as permission to delete them.

Later cleanup design must consume stale/reconciliation output explicitly rather than being fused into it.

## 14. Validation Requirements for Future Implementation

Although this spec does not implement code, it defines future validation expectations.

### 14.1 State-flow validation

Future tests must cover at least:

- `healthy → weakly-progressing → suspect`;
- `suspect → no-progress`;
- `suspect → stale-candidate`;
- `stale-candidate → stale-confirmed`;
- `stale-confirmed → takeover denied`;
- `stale-confirmed → takeover allowed`.

### 14.2 Boundary validation

Future tests must prove:

- time-window overrun alone does not directly become `no-progress`;
- weak progress does not provide infinite life support;
- `no-progress` cannot auto-continue;
- `stale-confirmed` without stronger conditions still cannot auto-continue;
- accepted historical evidence is not rewritten by this layer.

### 14.3 Audit validation

Future tests must prove reconciliation emits its explicit record, including stale basis, last trusted boundary, and takeover-allowed/denied reasoning.

### 14.4 Safety validation

Future tests must prove cleanup is not silently triggered by stale classification alone.

## 15. Follow-on Specs Required

This design intentionally leaves three immediate follow-on specs:

1. **Ownership / reconciliation spec**
   - define ownership truth, stale confirmation mechanics, and the exact reconciliation record surface;
2. **Resume / adopt / scheduled execution spec**
   - define how a permitted auto-takeover continues execution without violating this boundary layer;
3. **Cleanup / orphan handling spec**
   - define how retained stale surfaces are inspected, preserved, or eventually cleaned up without violating evidence safety.

## 16. Success Criteria

This design is successful only if a later implementer can answer all of the following without inventing new policy:

- what counts as strong progress vs weak progress;
- why time alone is not enough to declare failure;
- how `no-progress` differs from `stale-run`;
- why `stale-confirmed` still does not automatically authorize continuation;
- what reconciliation is allowed to decide;
- why cleanup is separate from stale detection.
