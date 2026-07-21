# Docs and Backlog Truth Alignment Design

> Status: proposed on 2026-07-21
> Scope: perform a current-truth documentation pass before rewriting the handover and backlog surfaces for the next ccloop iteration.
> Parent context: [`docs/handover/ccloop-handover.md`](../../handover/ccloop-handover.md), [`validation/v1/README.md`](../../../validation/v1/README.md), [`docs/ccloop-v2-review-backlog.md`](../../ccloop-v2-review-backlog.md)

## 1. Goal

Produce a truthful, shorter, and easier-to-use documentation surface for the current ccloop state without changing product behavior.

This design has two deliverables:

1. rewrite `docs/handover/ccloop-handover.md` so it reflects current repository truth, removes duplication, and remains a safe takeover entrypoint; and
2. rewrite `docs/ccloop-v2-review-backlog.md` so it becomes a current-truth backlog organized by `V1 truthful-docs follow-ups` and `V2 candidates`, with explicit decisions and priority inside each section.

The design does not authorize any new paid Claude run, any product-code change, or any rewrite of historical evidence artifacts.

## 2. Truth Sources and Precedence

When documentation sources disagree, use this precedence order:

1. current repository state, current committed files, and accepted immutable evidence;
2. current operator docs such as `validation/v1/README.md` and the handover itself once corrected;
3. historical design and plan documents;
4. external or reference materials supplied for backlog discussion.

This means reference materials may shape backlog candidates, but they must not override what V1 already truthfully is on `main`.

## 3. Scope

This pass includes:

- current-state verification for `git` status and current `HEAD`;
- accepted review verification for `A-04-08`, `B-02`, `C-05`, `D-01`, and `E-01`;
- current-operator-doc verification through `validation/v1/README.md`;
- duplication, drift, and takeover-usability review for `docs/handover/ccloop-handover.md`;
- current backlog review for `docs/ccloop-v2-review-backlog.md`;
- backlog input review from the user-provided references:
  - `docs/ref/LoopEngineering.md`
  - `docs/ref/loop-how-to-stop.md`
  - `docs/ref/claude-workflow.md`
  - `docs/ref/claude-scheduled.md`
  - `reference/loop-engineering/`
  - `reference/DoWhiz/`, especially `reference/DoWhiz/worker_agent_execution.md` and `reference/DoWhiz/DoWhiz_service/`
  - `reference/ralph-orchestrator/`
  - `reference/oh-my-openagent/`
  - `reference/ccmem/`

This pass does not include:

- product-code edits;
- a new V2 design;
- any real or paid Claude run;
- deletion or mutation of `.validation-runs/`, backup branches, or stashes;
- overwriting any accepted `review.json`.

## 4. Execution Flow

### 4.1 Establish the current-truth baseline

First verify the current repository truth directly:

- current `git status` and `HEAD`;
- accepted review verdicts and diagnoses for `A-04-08`, `B-02`, `C-05`, `D-01`, and `E-01`;
- the current statements in `validation/v1/README.md` that define operator-facing truth.

This step produces a short drift list: what is still true, what is outdated, and what is duplicated.

### 4.2 Review rewrite inputs

Read the existing backlog and the user-provided references to identify candidate follow-ups and future directions.

The purpose here is not to import another framework wholesale. The purpose is to determine:

- which gaps are still real for ccloop now;
- which ideas belong to V1 truthful-docs cleanup versus V2 exploration;
- which reference ideas should be adopted, narrowed, deferred, or rejected.

### 4.3 Rewrite the handover

Rewrite `docs/handover/ccloop-handover.md` as a current-truth takeover document.

It should retain:

- current accepted evidence and scenario outcomes;
- current repository, artifact, and sensitive-state facts another agent must verify before acting;
- still-binding operating boundaries;
- recommended next-step focus;
- explicit do-not-do guidance.

It should remove or compress:

- repeated sections;
- outdated `HEAD` and branch-status statements;
- historical narration that no longer helps takeover decisions.

### 4.4 Rewrite the backlog

Rewrite `docs/ccloop-v2-review-backlog.md` as a current-truth decision backlog rather than a historical archive.

The new backlog structure should be:

1. short scope header;
2. `V1 truthful-docs follow-ups` section;
3. `V2 candidates` section;
4. `Explicitly not now` section.

Inside `V1 truthful-docs follow-ups` and `V2 candidates`, order items by priority.

## 5. Backlog Item Format and Decision Rules

Each retained backlog item must use a fixed structure:

- `Priority:`
- `Decision:` one of `ADOPT`, `MODIFY`, `REJECT`, or `STILL_DEFER`
- `Why:`
- `Evidence:`
- `Next step:`

Decision meanings:

- `ADOPT`: keep this item active because current evidence supports it and it matches current priorities;
- `MODIFY`: keep the direction but narrow or reshape it before future design work;
- `REJECT`: remove it from the active backlog because it conflicts with current truth or is no longer useful;
- `STILL_DEFER`: keep it visible as a future possibility, but not as near-term work.

This structure keeps the backlog from becoming an unbounded idea list.

## 6. Handover Success Criteria

The handover rewrite is successful only if all of the following are true:

- no known duplicate major sections remain;
- current `HEAD` and branch-state descriptions match the verified repository truth;
- accepted A/B/C/D/E outcome statements match immutable accepted reviews;
- takeover instructions are clear about what to verify first;
- the document still clearly marks forbidden actions such as paid reruns without approval and mutation of historical evidence.

## 7. Backlog Success Criteria

The backlog rewrite is successful only if all of the following are true:

- it is shorter and cleaner than the current version;
- it clearly separates `V1 truthful-docs follow-ups` from `V2 candidates`;
- items are prioritized within each section;
- each retained item has an explicit decision and supporting evidence;
- it includes a small number of new inferred candidates only when they are grounded in the reviewed references;
- it does not present any reference implementation as a committed ccloop roadmap.

## 8. Risk Boundaries

This pass must preserve four boundaries.

### 8.1 Reference inspiration is not project commitment

Reference docs and example implementations may inform backlog candidates, but the rewritten backlog must not imply that ccloop has already chosen those designs.

### 8.2 Historical plans are not current truth

Historical spec and plan files may explain why things happened, but they must not overrule current repository truth or accepted evidence.

### 8.3 V2 backlog is not a V2 spec

The rewritten backlog is an input surface for later design work. It is not itself the design approval for any V2 implementation.

### 8.4 Existing hard boundaries remain explicit

The rewrite must continue to state that:

- no new paid run happens without explicit approval;
- accepted `review.json` files remain immutable;
- `D-01` must not be silently reinterpreted as `PASS` or `FAIL`;
- superseded runs are preserved historical evidence, not accepted final truth.

## 9. Verification

This work is verified by documentation consistency rather than product tests.

Verification steps:

1. verify repository truth against current `git` state and accepted review files;
2. check the rewritten handover for drift, duplication, and takeover clarity;
3. check the rewritten backlog for structure, explicit decisions, and truthful separation between V1 follow-ups and V2 candidates;
4. confirm that no product files or historical evidence artifacts were modified.

## 10. Out of Scope Follow-up

If the rewritten backlog identifies promising V2 directions, the next step is a separate planning or design cycle. This document does not approve implementation of those items.
