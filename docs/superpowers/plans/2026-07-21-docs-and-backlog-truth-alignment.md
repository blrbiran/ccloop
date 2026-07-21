# Docs and Backlog Truth Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Perform a current-truth documentation pass, rewrite the handover and backlog surfaces, and preserve every accepted V1 evidence boundary without changing product code or running any paid Claude scenario.

**Architecture:** Verify truth directly from the current repository state, accepted review artifacts, and `validation/v1/README.md`, then rewrite `docs/handover/ccloop-handover.md` as a concise takeover document and `docs/ccloop-v2-review-backlog.md` as a decision backlog split into `V1 truthful-docs follow-ups` and `V2 candidates`. Finish with a doc-only verification pass and the OpenWolf bookkeeping required for modified files.

**Tech Stack:** Markdown, git CLI, Python 3, ripgrep, existing accepted review JSON files, OpenWolf metadata files

## Global Constraints

- Current repository state, current committed files, and accepted immutable evidence outrank README, handover, historical plans, and reference materials.
- `validation/v1/README.md` and accepted review files are read-only truth sources for this pass.
- Do not change product code.
- Do not create a new V2 design during this pass.
- Do not run any real or paid Claude scenario.
- Do not delete or mutate `.validation-runs/`, backup branches, or stashes.
- Do not overwrite any accepted `review.json`.
- Keep `D-01` as `INCONCLUSIVE / CONTRACT_GAP` in accepted history unless a separate `review-reclassified.json` is explicitly requested later.
- Reference materials may inform backlog candidates, but they must not be written as committed ccloop roadmap decisions.
- The rewritten backlog is planning input, not V2 implementation approval.
- The rewritten handover must remain a safe takeover entrypoint with explicit do-not-do guidance.
- After editing files, update `.wolf/anatomy.md` and append one row to `.wolf/memory.md`.

---

## File Structure

- Modify: `docs/handover/ccloop-handover.md` — rewrite as the current-truth takeover document with one copy of each major section.
- Modify: `docs/ccloop-v2-review-backlog.md` — rewrite as the current-truth decision backlog with explicit `Priority / Decision / Why / Evidence / Next step` items.
- Reference only: `validation/v1/README.md` — operator-facing truth source for accepted evidence wording and guardrails.
- Reference only: `.validation-runs/evidence/A-04-08/review.json` — accepted Scenario A verdict source.
- Reference only: `.validation-runs/evidence/B-02/review.json` — accepted Scenario B verdict source.
- Reference only: `.validation-runs/evidence/C-05/review.json` — accepted Scenario C verdict source.
- Reference only: `.validation-runs/evidence/D-01/review.json` — accepted Scenario D verdict source.
- Reference only: `.validation-runs/evidence/E-01/review.json` — accepted Scenario E verdict source.
- Reference only: `docs/ref/LoopEngineering.md`, `docs/ref/loop-how-to-stop.md`, `docs/ref/claude-workflow.md`, `docs/ref/claude-scheduled.md` — primary backlog-input documents.
- Reference only: `reference/loop-engineering/`, `reference/DoWhiz/`, `reference/ralph-orchestrator/`, `reference/oh-my-openagent/`, `reference/ccmem/` — secondary backlog-input directories; expand only where the reviewed docs or current backlog point to a concrete file.
- Modify: `.wolf/anatomy.md` — refresh the handover summary and add an entry for `docs/ccloop-v2-review-backlog.md` if it is still missing.
- Modify: `.wolf/memory.md` — append one row recording the docs/backlog truth-alignment pass.
- Modify only if this pass reveals a new reusable rule not already recorded: `.wolf/cerebrum.md`.

### Task 1: Rewrite the handover from verified current truth

**Files:**
- Modify: `docs/handover/ccloop-handover.md`
- Reference: `validation/v1/README.md`
- Reference: `.validation-runs/evidence/A-04-08/review.json`
- Reference: `.validation-runs/evidence/B-02/review.json`
- Reference: `.validation-runs/evidence/C-05/review.json`
- Reference: `.validation-runs/evidence/D-01/review.json`
- Reference: `.validation-runs/evidence/E-01/review.json`
- Reference: `docs/superpowers/specs/2026-07-21-docs-and-backlog-truth-alignment-design.md`

**Interfaces:**
- Consumes:
  - current `HEAD` from `git rev-parse --short HEAD`
  - accepted `scenarioVerdict` / `diagnosis` values from the five accepted `review.json` files
  - operator-facing truth from `validation/v1/README.md:1-120`
- Produces:
  - one-copy headings in `docs/handover/ccloop-handover.md`:
    - `## Executive Summary for Next Agent`
    - `## Current Repository State`
    - `## Accepted Evidence Set`
    - `## Important Fixes and Current Learnings`
    - `## Governing Boundaries That Still Matter`
    - `## Known Limitations`
    - `## Recommended Next-Step Focus`
    - `## Exact Takeover Procedure`
    - `## Useful Commands`
    - `## Do Not Do These on Takeover`

- [ ] **Step 1: Capture the current-truth baseline and duplicate headings**

```bash
git status --short --branch
git rev-parse --short HEAD
python3 - <<'PY'
import json
from pathlib import Path
for run_id in ('A-04-08','B-02','C-05','D-01','E-01'):
    data = json.loads(Path(f'.validation-runs/evidence/{run_id}/review.json').read_text())
    print(run_id, data['scenarioVerdict'], data.get('diagnosis'))
PY
python3 - <<'PY'
from pathlib import Path
text = Path('docs/handover/ccloop-handover.md').read_text()
for heading in (
    '## 6. Governing Boundaries That Still Matter',
    '## 7. Known Limitations',
    '## 8. Recommended Next-Step Focus',
    '## 9. Exact Takeover Procedure',
):
    print(heading, text.count(heading))
PY
```

Expected:
- `git rev-parse --short HEAD` prints the exact short SHA to use in the rewritten handover.
- The Python review check prints exactly:
  - `A-04-08 PASS None`
  - `B-02 PASS None`
  - `C-05 PASS None`
  - `D-01 INCONCLUSIVE CONTRACT_GAP`
  - `E-01 PASS None`
- The heading-count check shows that the duplicated takeover sections are still duplicated before the rewrite.

- [ ] **Step 2: Rewrite `docs/handover/ccloop-handover.md` to remove duplication and stale repo facts**

Replace the repeated/overlong structure with a single concise takeover document that follows this exact section order and uses the exact short SHA printed in Step 1:

```md
# ccloop Handover

> Updated: 2026-07-21
> Scope: post-validation handover for the accepted evidence-first V1 A/B/C/D/E outcomes on `main`, plus the current repo and artifact state needed for safe takeover.
> Snapshot rule: verify every status claim against Git, the filesystem, and accepted immutable evidence before acting.

## Executive Summary for Next Agent

1. `main` HEAD: `<use the exact short SHA from Step 1>`.
2. Accepted results remain `A-04-08 PASS`, `B-02 PASS`, `C-05 PASS`, `D-01 INCONCLUSIVE / CONTRACT_GAP`, `E-01 PASS`.
3. `D-01 review.json` remains immutable; any reinterpretation belongs in a separate `review-reclassified.json`.
4. The D-boundary implementation is already merged on `main`; no new paid run is implied by this docs pass.
5. Backup branch, stashes, preserved fixture checkout, and historical `.validation-runs/` evidence remain off-limits unless a human explicitly approves otherwise.

## Current Repository State

- Path: `/Users/biran/code/skills/loop/ccloop`
- Branch: `main`
- HEAD: `<use the exact short SHA from Step 1>`
- State: note whether the tree is still clean or whether this docs-only pass is the only intentional drift.
- Preserve the current backup branch, stashes, and `.validation-runs/fixture-01` checkout facts.

## Accepted Evidence Set

- `A-04-08` → `PASS`
- `B-02` → `PASS`
- `C-05` → `PASS`
- `D-01` → `INCONCLUSIVE / CONTRACT_GAP`
- `E-01` → `PASS`

## Important Fixes and Current Learnings

- Keep the D-boundary merge summary.
- Keep the canonical-path fix note.
- Keep the accepted OMC / ECC validation-run defaults.

## Governing Boundaries That Still Matter

- require explicit approval before every real Claude invocation;
- never overwrite accepted `review.json`;
- never treat superseded runs as accepted truth;
- never reinterpret `D-01` as `PASS` or `FAIL` in place.

## Known Limitations

- `D-01` accepted history is still `INCONCLUSIVE / CONTRACT_GAP`.
- No resume, reconciliation, scheduler, daemon, queue, lease, heartbeat, or multi-task coordination exists in V1.
- `claudeChildExited` remains `NOT_OBSERVABLE` unless a tracked descendant PID proves it.

## Recommended Next-Step Focus

1. Finish truthful docs / backlog alignment.
2. Only emit `review-reclassified.json` for `D-01` if a human explicitly asks.
3. Do not schedule or run a new paid scenario without fresh approval.

## Exact Takeover Procedure

Use the existing command list, but keep it once.

## Useful Commands

Keep the accepted review-summary command and the focused verification commands.

## Do Not Do These on Takeover

Keep the explicit prohibitions on `git clean`, `git reset --hard`, broad restore/checkout, deleting preserved evidence, pushing the backup branch, or rewriting accepted review artifacts.
```

- [ ] **Step 3: Verify the rewritten handover is single-copy and truth-aligned**

```bash
python3 - <<'PY'
from pathlib import Path
text = Path('docs/handover/ccloop-handover.md').read_text()
for heading in (
    '## Governing Boundaries That Still Matter',
    '## Known Limitations',
    '## Recommended Next-Step Focus',
    '## Exact Takeover Procedure',
):
    count = text.count(heading)
    assert count == 1, (heading, count)
for needle in (
    'A-04-08 PASS',
    'B-02 PASS',
    'C-05 PASS',
    'D-01 INCONCLUSIVE / CONTRACT_GAP',
    'E-01 PASS',
    'review-reclassified.json',
    'Do Not Do These on Takeover',
):
    assert needle in text, needle
print('handover structure ok')
PY
rg -n "HEAD:|A-04-08 PASS|D-01 INCONCLUSIVE / CONTRACT_GAP|review-reclassified.json|Do Not Do These on Takeover" docs/handover/ccloop-handover.md
```

Expected:
- The Python script prints `handover structure ok`.
- `rg` returns one set of matches for the key truth markers rather than repeated section blocks.

- [ ] **Step 4: Commit the handover rewrite**

```bash
git add docs/handover/ccloop-handover.md

git commit -m "docs: align handover with current truth"
```

### Task 2: Rewrite the backlog as a current-truth decision backlog

**Files:**
- Modify: `docs/ccloop-v2-review-backlog.md`
- Reference: `docs/ref/LoopEngineering.md`
- Reference: `docs/ref/loop-how-to-stop.md`
- Reference: `docs/ref/claude-workflow.md`
- Reference: `docs/ref/claude-scheduled.md`
- Reference: `reference/DoWhiz/worker_agent_execution.md`
- Reference: `reference/DoWhiz/DoWhiz_service/run_task_module/src/run_task/types.rs`
- Reference: `reference/DoWhiz/DoWhiz_service/docs/task_debug_archives.md`
- Reference: `reference/loop-engineering/templates/SKILL.md.verifier`
- Reference: `reference/loop-engineering/tools/loop-worktree/src/worktree.ts`
- Reference: `reference/ralph-orchestrator/crates/ralph-core/src/loop_history.rs`
- Reference: `reference/ralph-orchestrator/crates/ralph-core/src/event_loop/mod.rs`
- Reference: `reference/oh-my-openagent/packages/omo-opencode/src/hooks/ralph-loop/storage.ts`
- Reference: `reference/oh-my-openagent/packages/omo-opencode/src/features/builtin-commands/commands.ts`
- Reference: `reference/ccmem/`
- Reference: `docs/handover/ccloop-handover.md`
- Reference: `validation/v1/README.md`

**Interfaces:**
- Consumes:
  - truth-precedence order from `docs/superpowers/specs/2026-07-21-docs-and-backlog-truth-alignment-design.md`
  - accepted V1 truth from `validation/v1/README.md` and the accepted review files
  - backlog candidate inputs from the reference docs listed above
- Produces:
  - `docs/ccloop-v2-review-backlog.md` with these exact top-level sections:
    - `## Purpose`
    - `## Review Principles`
    - `## V1 truthful-docs follow-ups`
    - `## V2 candidates`
    - `## Explicitly not now`
  - retained items with this exact field structure:
    - `- Priority:`
    - `- Decision:`
    - `- Why:`
    - `- Evidence:`
    - `- Next step:`

- [ ] **Step 1: Review the current backlog and pull candidate signals from the reference set**

```bash
rg -n "^## |^### |^\| " docs/ccloop-v2-review-backlog.md
rg -n "stop|stale|resume|reconcil|ownership|workflow|schedule|memory|handoff|no-progress" \
  docs/ref/LoopEngineering.md \
  docs/ref/loop-how-to-stop.md \
  docs/ref/claude-workflow.md \
  docs/ref/claude-scheduled.md \
  reference/DoWhiz/worker_agent_execution.md \
  reference/DoWhiz/DoWhiz_service/docs/task_debug_archives.md \
  reference/DoWhiz/DoWhiz_service/run_task_module/src/run_task/types.rs \
  reference/loop-engineering/templates/SKILL.md.verifier \
  reference/loop-engineering/tools/loop-worktree/src/worktree.ts \
  reference/ralph-orchestrator/crates/ralph-core/src/loop_history.rs \
  reference/ralph-orchestrator/crates/ralph-core/src/event_loop/mod.rs \
  reference/oh-my-openagent/packages/omo-opencode/src/hooks/ralph-loop/storage.ts \
  reference/oh-my-openagent/packages/omo-opencode/src/features/builtin-commands/commands.ts \
  reference/ccmem
```

Expected:
- The first `rg` shows the current backlog still uses the older candidate-table / reference-notes shape.
- The second `rg` returns concrete hits for stop boundaries, ownership, reconciliation, workflow/scheduling, handoff, or memory ideas that can be classified into `V1 truthful-docs follow-ups`, `V2 candidates`, or `Explicitly not now`.

- [ ] **Step 2: Replace the current backlog with the new decision-backlog structure**

Rewrite `docs/ccloop-v2-review-backlog.md` so it keeps the short header and purpose but uses this exact structure and field format:

```md
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

#### Evaluate workflow / scheduled execution only after ownership and reconciliation are specified
- Priority: P1
- Decision: MODIFY
- Why: workflow fan-out and scheduled execution may be useful later, but only after ccloop defines source-of-truth, stale-run handling, and kill-switch behavior.
- Evidence: `docs/ref/claude-workflow.md`; `docs/ref/claude-scheduled.md`; `reference/ralph-orchestrator/crates/ralph-core/src/event_loop/mod.rs`
- Next step: keep the idea in backlog form and defer detailed design until the stop/ownership layer is explicit.

#### Evaluate a memory mechanism only as a scoped support system
- Priority: P2
- Decision: STILL_DEFER
- Why: memory may improve operator context and handoff, but V1 truth surfaces still need to stay primary and the reviewed references do not justify making memory a controller source of truth.
- Evidence: `reference/ccmem/`; `docs/ref/LoopEngineering.md`
- Next step: revisit only after the V1/V2 source-of-truth model is settled.

## Explicitly not now

- Directly copying DoWhiz, Ralph, or oh-my-openagent control loops into ccloop.
- Treating workflow, scheduler, or memory ideas as already-approved V2 scope.
- Introducing new paid validation runs as part of backlog cleanup.
```

Then keep only the additional items that survive review. Remove the old `## Candidate Review Table`, `## Reference Notes`, and `## V2 Review Checklist` sections entirely.

- [ ] **Step 3: Verify the backlog structure and decision labels**

```bash
python3 - <<'PY'
from pathlib import Path
text = Path('docs/ccloop-v2-review-backlog.md').read_text()
for heading in (
    '## V1 truthful-docs follow-ups',
    '## V2 candidates',
    '## Explicitly not now',
):
    assert heading in text, heading
for field in (
    '- Priority:',
    '- Decision:',
    '- Why:',
    '- Evidence:',
    '- Next step:',
):
    assert field in text, field
for removed in (
    '## Candidate Review Table',
    '## Reference Notes',
    '## V2 Review Checklist',
):
    assert removed not in text, removed
print('backlog structure ok')
PY
rg -n "ADOPT|MODIFY|REJECT|STILL_DEFER|## V1 truthful-docs follow-ups|## V2 candidates|## Explicitly not now" docs/ccloop-v2-review-backlog.md
```

Expected:
- The Python script prints `backlog structure ok`.
- `rg` shows the new top-level sections and explicit decision labels.

- [ ] **Step 4: Commit the backlog rewrite**

```bash
git add docs/ccloop-v2-review-backlog.md

git commit -m "docs: rewrite truth-aligned review backlog"
```

### Task 3: Run the final doc-only verification pass and update OpenWolf metadata

**Files:**
- Modify: `.wolf/anatomy.md`
- Modify: `.wolf/memory.md`
- Modify only if this pass reveals a new reusable rule not already captured: `.wolf/cerebrum.md`
- Verify: `docs/handover/ccloop-handover.md`
- Verify: `docs/ccloop-v2-review-backlog.md`

**Interfaces:**
- Consumes:
  - rewritten `docs/handover/ccloop-handover.md`
  - rewritten `docs/ccloop-v2-review-backlog.md`
  - current `.wolf/anatomy.md` section layout
- Produces:
  - refreshed `.wolf/anatomy.md` summary for `docs/handover/ccloop-handover.md`
  - new `.wolf/anatomy.md` entry for `docs/ccloop-v2-review-backlog.md` if it is still missing
  - one appended `.wolf/memory.md` row describing the docs/backlog alignment pass
  - optional one-line `.wolf/cerebrum.md` learning only if the pass uncovered a new durable rule

- [ ] **Step 1: Update `.wolf/anatomy.md` for the rewritten docs**

Insert or refresh the anatomy summaries so they read like this:

```md
## docs/

- `ccloop-v2-review-backlog.md` — Current-truth V1/V2 review backlog with explicit priorities, decisions, evidence, and not-now items (~2200 tok)

## docs/handover/

- `ccloop-handover.md` — Current-truth takeover guide covering accepted evidence, repository state, operating boundaries, and next-step focus (~4300 tok)
```

If `## docs/` already exists by execution time, append the backlog line there instead of creating a duplicate section.

- [ ] **Step 2: Append one `.wolf/memory.md` row for the docs/backlog pass**

Append one row in this exact format, using the actual execution time and actual file list:

```md
| HH:MM | Rewrote handover and review backlog from verified current truth and checked that only doc/OpenWolf files changed | docs/handover/ccloop-handover.md, docs/ccloop-v2-review-backlog.md, .wolf/anatomy.md, .wolf/memory.md | done | ~1800 |
```

- [ ] **Step 3: Update `.wolf/cerebrum.md` only if a new durable rule was learned**

If the rewrite uncovered a reusable rule that is not already present in `.wolf/cerebrum.md`, append exactly one bullet. If no new rule was learned, leave `.wolf/cerebrum.md` unchanged.

```md
- [2026-07-21] Keep docs/backlog cleanup subordinate to accepted evidence: when a reference idea conflicts with current `review.json` truth or current operator docs, preserve the current truth and move the idea to backlog discussion instead of rewriting history.
```

- [ ] **Step 4: Run the final doc-only verification pass**

```bash
git diff --check -- docs/handover/ccloop-handover.md docs/ccloop-v2-review-backlog.md .wolf/anatomy.md .wolf/memory.md .wolf/cerebrum.md
python3 - <<'PY'
import subprocess
allowed = {
    'docs/handover/ccloop-handover.md',
    'docs/ccloop-v2-review-backlog.md',
    '.wolf/anatomy.md',
    '.wolf/memory.md',
    '.wolf/cerebrum.md',
}
changed = set(filter(None, subprocess.check_output(['git', 'diff', '--name-only']).decode().splitlines()))
assert changed <= allowed, changed
print('doc-only diff ok')
PY
```

Expected:
- `git diff --check` prints nothing.
- The Python script prints `doc-only diff ok`.
- No product files, accepted evidence artifacts, backup branches, or stashes were touched.

- [ ] **Step 5: Commit the doc-only alignment pass**

```bash
git add docs/handover/ccloop-handover.md docs/ccloop-v2-review-backlog.md .wolf/anatomy.md .wolf/memory.md .wolf/cerebrum.md

git commit -m "docs: align handover and backlog with current truth"
```
