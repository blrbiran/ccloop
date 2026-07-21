# ccloop V2 Review Backlog

> Status: current-truth review backlog, not an approved V2 design or implementation commitment.
> Current accepted V1 evidence on `main`: `A-04-08 PASS`, `B-02 PASS`, `C-05 PASS`, `D-01 INCONCLUSIVE / CONTRACT_GAP`, `E-01 PASS`.
> Immediate priority: truthful V1 docs/backlog alignment before any new paid run or implicit V2 kickoff.

## Purpose

Keep only the backlog items that still matter after the accepted V1 evidence set and the D-boundary merge.

## Review Principles

1. Start from observed V1 truth and current operator needs.
2. Prefer the smallest mechanism that closes a confirmed gap.
3. Keep controller policy deterministic.
4. Treat reference projects as inputs, not roadmap commitments.
5. Do not put scheduler or unattended orchestration ahead of stop / ownership / reconciliation boundaries.

## V1 truthful-docs follow-ups

### P0

#### Keep V1 truth surfaces aligned after the D-boundary merge
- Priority: P0
- Decision: ADOPT
- Why: `validation/v1/README.md`, the handover, and the backlog must agree on the accepted A/B/C/D/E outcomes before any V2 work resumes.
- Evidence: `validation/v1/README.md`; `docs/handover/ccloop-handover.md`; `.validation-runs/evidence/D-01/review.json`
- Next step: finish this docs pass, then re-run the drift check before opening any new design cycle.

## V2 candidates

### P1

#### Define stop / no-progress / stale-run boundaries before scheduler work
- Priority: P1
- Decision: ADOPT
- Why: the reviewed references agree that unattended orchestration is unsafe without explicit stop, ownership, and stale-run handling.
- Evidence: `docs/ref/LoopEngineering.md`; `docs/ref/loop-how-to-stop.md`; `docs/ref/claude-scheduled.md`
- Next step: carry this forward as a future design input, not an implementation approval.

#### Specify ownership and reconciliation before any resume / adopt flow
- Priority: P1
- Decision: ADOPT
- Why: resume and adopt semantics only become safe once ccloop can prove which process owns a run, how stale state is detected, and which recovery actions are deterministic versus human-gated.
- Evidence: `reference/ralph-orchestrator/crates/ralph-core/src/event_loop/mod.rs`; `reference/oh-my-openagent/packages/omo-opencode/src/hooks/ralph-loop/storage.ts`; `docs/handover/ccloop-handover.md`
- Next step: keep this as design input for a future source-of-truth and reconciliation spec, not as implementation approval.

#### Evaluate workflow / scheduled execution only after ownership and reconciliation are specified
- Priority: P1
- Decision: MODIFY
- Why: workflow fan-out and scheduled execution may be useful later, but only after ccloop defines source-of-truth, stale-run handling, and kill-switch behavior.
- Evidence: `docs/ref/claude-workflow.md`; `docs/ref/claude-scheduled.md`; `reference/ralph-orchestrator/crates/ralph-core/src/event_loop/mod.rs`
- Next step: keep the idea in backlog form and defer detailed design until the stop/ownership layer is explicit.

### P2

#### Keep handoff support scoped to inspectable retained evidence, not implicit resume
- Priority: P2
- Decision: MODIFY
- Why: current V1 already proves an inspectable human handoff path for blocked work, so future handoff improvements should stay subordinate to evidence visibility instead of implying automatic continuation.
- Evidence: `.validation-runs/evidence/B-02/review.json`; `docs/handover/ccloop-handover.md`; `reference/loop-engineering/templates/SKILL.md.verifier`
- Next step: revisit only if operators identify a concrete missing handoff fact after the current truthful-docs pass.

#### Evaluate a memory mechanism only as a scoped support system
- Priority: P2
- Decision: STILL_DEFER
- Why: memory may improve operator context and handoff, but V1 truth surfaces still need to stay primary and the reviewed references do not justify making memory a controller source of truth.
- Evidence: `reference/ccmem/`; `docs/ref/LoopEngineering.md`
- Next step: revisit only after the V1/V2 source-of-truth model is settled.

## Explicitly not now

- Directly copying DoWhiz, Ralph, or oh-my-openagent control loops into ccloop.
- Treating workflow, scheduler, or memory ideas as already-approved V2 scope.
- Rewriting accepted D-01 history away from `INCONCLUSIVE / CONTRACT_GAP` during backlog cleanup.
- Introducing new paid validation runs as part of backlog cleanup.
