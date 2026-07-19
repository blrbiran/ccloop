# A-04 Branch Assessment and Merge Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assess the existing `a04-preflight-approval` worktree, preserve its A-04 work where justified, tighten only truth-affecting files, and end with an explicit merge-readiness verdict plus drift classification without any paid call or destructive cleanup.

**Architecture:** Work directly against `.worktrees/a04-preflight-approval` as the assessment target. First lock the live Git baseline and record it in the branch-local handover, then review the committed A-04 surface and rerun non-paid deterministic verification, and finally classify committed and uncommitted drift into merge-surface, local-only, or unresolved so the branch ends with a concrete next-step recommendation.

**Tech Stack:** Git, TypeScript/Vitest, Node.js/npm, Markdown docs, OpenWolf bookkeeping files.

## Global Constraints

- Preserve existing A-04 work when possible; do not default to a clean re-prepare.
- Assess committed branch surface before local uncommitted drift.
- Preserve existing real-run evidence under `.worktrees/evidence-first-v1/.validation-runs/`; do not clean, rewrite, or reuse it.
- No real Claude paid call is allowed during this increment.
- Do not delete backup branch `backup/evidence-first-v1-before-memory-history-cleanup`, retained stashes, or linked worktrees.
- Do not use destructive Git cleanup (`git clean`, `git reset --hard`, broad `git restore`, broad `git checkout`).
- Do not treat focused validation success as authorization for a paid Scenario A call.
- Current Git/filesystem reality overrides stale handover snapshots if they differ.
- Minimum committed-surface review set: `.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`, `.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts`, `.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`, `.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts`, `.worktrees/a04-preflight-approval/validation/v1/README.md`, `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md`, `.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`.
- Every uncommitted file must end in exactly one bucket: merge-surface, local-only, or unresolved.
- Deterministic verification for merge readiness must include focused validation tests plus `typecheck` and `build` in the A-04 worktree.
- Run npm commands for the worktree with `npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval ...` so commands execute against the correct checkout.
- Update `.worktrees/a04-preflight-approval/.wolf/memory.md` after each significant task; if a verification command fails, append a bug entry to `.worktrees/a04-preflight-approval/.wolf/buglog.json` before attempting any fix.

---

## File Map

- Review / Modify: `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md` — durable branch verdict, baseline facts, drift classification, and next-step recommendation.
- Review / Modify: `.worktrees/a04-preflight-approval/validation/v1/README.md` — operator-facing truth for the non-paid A-04 preparation path.
- Review / Modify: `.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md` — prior A-04 plan; keep it truthful if branch review changes how it should be interpreted.
- Review only unless a confirmed defect is found: `.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts` — A-04 preflight/approval orchestrator and invariants.
- Review only unless a confirmed defect is found: `.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts` — Scenario A-only override boundary.
- Review only unless a confirmed defect is found: `.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts` — focused regression coverage for A-04 preparation.
- Review only unless a confirmed defect is found: `.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts` — contract rendering / override coverage.
- Review and usually classify as local-only: `.worktrees/a04-preflight-approval/.superpowers/sdd/progress.md`, `.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`, `.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`, `.worktrees/a04-preflight-approval/.wolf/anatomy.md`, `.worktrees/a04-preflight-approval/.wolf/buglog.json`, `.worktrees/a04-preflight-approval/.wolf/cerebrum.md`, `.worktrees/a04-preflight-approval/.wolf/memory.md`.
- Review and classify explicitly: `.worktrees/a04-preflight-approval/package-lock.json` — unresolved unless a concrete merge-surface reason is proven.

## Task 1: Lock the live baseline in the branch-local handover

**Files:**
- Modify: `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md`
- Modify: `.worktrees/a04-preflight-approval/.wolf/memory.md`
- Review: `.worktrees/a04-preflight-approval/.superpowers/sdd/progress.md`, `.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`, `.worktrees/a04-preflight-approval/.wolf/memory.md`, `.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, `.worktrees/a04-preflight-approval/package-lock.json`

**Interfaces:**
- Produces: `### 2026-07-19 merge-readiness baseline` subsection in `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md`
- Produces: exact current baseline facts (`main` head, A-04 committed head, current local-drift file list) that later tasks reuse

- [ ] **Step 1: Capture the live Git baseline without mutating anything**

Run:

```bash
git -C "/Users/biran/code/skills/loop/ccloop" rev-parse --short HEAD
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" rev-parse --short HEAD
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" status --short
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" diff --name-status main...HEAD
```

Expected:
- first command prints `3108c5c`
- second command prints `c3036dc`
- `status --short` prints the current five local files:
  - `.superpowers/sdd/progress.md`
  - `.superpowers/sdd/task-3-report.md`
  - `.wolf/memory.md`
  - `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
  - `package-lock.json`
- committed diff lists the existing A-04 branch delta against `main`

- [ ] **Step 2: Verify that safety context is still present and untouched**

Run:

```bash
git -C "/Users/biran/code/skills/loop/ccloop" branch --list 'backup/evidence-first-v1-before-memory-history-cleanup'
git -C "/Users/biran/code/skills/loop/ccloop" stash list
test -d "/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/.validation-runs" && echo "preserved-evidence-present"
```

Expected:
- backup branch is listed
- the retained stashes are still present
- final command prints `preserved-evidence-present`

- [ ] **Step 3: Add a 2026-07-19 baseline subsection to the branch-local handover**

Insert this block under the current A-04 decision section in `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md`:

```md
### 2026-07-19 merge-readiness baseline

- Reviewed against current Git/filesystem truth instead of stale handover snapshots.
- `main` reviewed at `3108c5c`.
- `a04-preflight-approval` committed head reviewed at `c3036dc`.
- Current local uncommitted files are being classified separately from committed branch value:
  - `.superpowers/sdd/progress.md`
  - `.superpowers/sdd/task-3-report.md`
  - `.wolf/memory.md`
  - `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
  - `package-lock.json`
- Preserved evidence remains under `.worktrees/evidence-first-v1/.validation-runs/` and has not been rewritten.
```

Do not remove older handover history; append this as the new current baseline.

- [ ] **Step 4: Verify that the new baseline block is present and exact**

Run:

```bash
rg -n "2026-07-19 merge-readiness baseline|3108c5c|c3036dc|package-lock.json|Preserved evidence remains" "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md"
```

Expected: five matches covering the new subsection.

- [ ] **Step 5: Append the Task 1 checkpoint to the worktree OpenWolf memory log**

Add this line to `.worktrees/a04-preflight-approval/.wolf/memory.md`:

```md
| HH:MM | Locked 2026-07-19 A-04 merge-readiness baseline in branch-local handover | docs/handover/ccloop-handover.md, .wolf/memory.md | done | ~800 |
```

Use the real local `HH:MM` at execution time.

- [ ] **Step 6: Commit Task 1**

```bash
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" add docs/handover/ccloop-handover.md .wolf/memory.md
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" commit -m "docs: lock A-04 branch assessment baseline"
```

Expected: commit contains only the handover baseline update and the matching OpenWolf memory entry.

## Task 2: Review the committed A-04 surface and rerun non-paid deterministic verification

**Files:**
- Review: `.worktrees/a04-preflight-approval/validation/v1/lib/a04.ts`
- Review: `.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts`
- Review: `.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`
- Review: `.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts`
- Modify only if truthfulness is missing: `.worktrees/a04-preflight-approval/validation/v1/README.md`
- Modify only if truthfulness is missing: `.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
- Modify: `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md`
- Modify on failure only: `.worktrees/a04-preflight-approval/.wolf/buglog.json`
- Modify: `.worktrees/a04-preflight-approval/.wolf/memory.md`
- Test: `.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts`
- Test: `.worktrees/a04-preflight-approval/tests/validation/prepareA04.test.ts`

**Interfaces:**
- Consumes: `### 2026-07-19 merge-readiness baseline` from Task 1
- Produces: `### 2026-07-19 committed-surface verdict` subsection in `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md`
- Produces: focused verification outcome (`pass` or a logged unresolved failure)

- [ ] **Step 1: Review the minimum committed-surface file set against current `main`**

Run:

```bash
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" diff main...HEAD -- \
  validation/v1/lib/a04.ts \
  validation/v1/lib/scenarios.ts \
  tests/validation/prepareA04.test.ts \
  tests/validation/contracts.test.ts \
  validation/v1/README.md \
  docs/handover/ccloop-handover.md \
  docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md
```

Expected: diff is limited to the existing A-04 preparation surface and its truthfulness docs.

- [ ] **Step 2: Rerun the non-paid deterministic verification set in the A-04 worktree**

Run:

```bash
npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts
npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run typecheck
npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" run build
```

Expected:
- focused validation tests PASS
- `typecheck` PASS
- `build` PASS
- no real Claude call occurs

- [ ] **Step 3: If any verification command fails, log the failure before making any branch judgment**

Append one JSON object like this to `.worktrees/a04-preflight-approval/.wolf/buglog.json` before attempting any fix:

```json
{
  "id": "bug-NNN",
  "timestamp": "2026-07-19T09:30:00+08:00",
  "error_message": "npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval run build failed during A-04 branch assessment",
  "file": "validation/v1/lib/a04.ts",
  "root_cause": "replace with the concrete failing cause from stderr",
  "fix": "record the concrete next fix or note that the file is unresolved pending deeper review",
  "tags": ["assessment", "verification", "a04", "non-paid"],
  "related_bugs": [],
  "occurrences": 1,
  "last_seen": "2026-07-19T09:30:00+08:00"
}
```

Then stop Task 2 and set the final branch verdict to `preserve branch but add one more tightening pass`. Do **not** make speculative product changes just to force green.

- [ ] **Step 4: Tighten README / prior plan only if one of the required truth clauses is missing**

Check the branch-local README and prior plan for these exact claims:

```text
Passing focused checks on this branch does not by itself authorize a paid Scenario A call.
.validation-runs/contracts/A-04.json in this worktree is a local non-paid prepare artifact, not preserved real-run evidence.
This branch assessment remains non-paid and non-destructive.
```

If any clause is absent, add only the missing sentence(s) in the nearest relevant section of:
- `.worktrees/a04-preflight-approval/validation/v1/README.md`
- `.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`

Do not reword unrelated sections.

- [ ] **Step 5: Write the committed-surface verdict into the handover**

Add this subsection to `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md` on the expected green path:

```md
### 2026-07-19 committed-surface verdict

- Minimum committed-surface review set completed for:
  - `validation/v1/lib/a04.ts`
  - `validation/v1/lib/scenarios.ts`
  - `tests/validation/prepareA04.test.ts`
  - `tests/validation/contracts.test.ts`
  - `validation/v1/README.md`
  - `docs/handover/ccloop-handover.md`
  - `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
- Focused verification rerun:
  - `tests/validation/contracts.test.ts` — pass
  - `tests/validation/prepareA04.test.ts` — pass
  - `npm run typecheck` — pass
  - `npm run build` — pass
- Committed product surface verdict: `continue original branch tightening toward merge`
- This verdict does not authorize a paid Scenario A invocation.
```

If Step 3 was triggered, write the same subsection but replace the verdict line with `preserve branch but add one more tightening pass` and summarize the failing command instead of the four pass lines.

- [ ] **Step 6: Verify the verdict block and truth clauses**

Run:

```bash
rg -n "2026-07-19 committed-surface verdict|continue original branch tightening toward merge|preserve branch but add one more tightening pass|does not authorize a paid Scenario A invocation|local non-paid prepare artifact" \
  "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md" \
  "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/README.md" \
  "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md"
```

Expected: matches exist for the handover verdict, paid-call warning, and non-paid artifact distinction.

- [ ] **Step 7: Append the Task 2 checkpoint to the worktree OpenWolf memory log**

Add this line to `.worktrees/a04-preflight-approval/.wolf/memory.md`:

```md
| HH:MM | Reviewed committed A-04 surface, reran focused verification, and recorded the committed-surface verdict | docs/handover/ccloop-handover.md, validation/v1/README.md, docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md, .wolf/memory.md | done | ~1400 |
```

- [ ] **Step 8: Commit Task 2**

```bash
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" add \
  docs/handover/ccloop-handover.md \
  validation/v1/README.md \
  docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md \
  .wolf/memory.md \
  .wolf/buglog.json
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" commit -m "docs: record A-04 committed-surface verdict"
```

Expected: commit contains only the truthfulness updates actually needed plus the corresponding OpenWolf entries.

## Task 3: Classify committed and uncommitted drift, then issue the final branch recommendation

**Files:**
- Modify: `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md`
- Modify only if their truthfulness affects the final recommendation: `.worktrees/a04-preflight-approval/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`, `.worktrees/a04-preflight-approval/.superpowers/sdd/task-2-report.md`, `.worktrees/a04-preflight-approval/.superpowers/sdd/task-3-report.md`
- Review / classify: `.worktrees/a04-preflight-approval/.superpowers/sdd/progress.md`
- Review / classify: `.worktrees/a04-preflight-approval/.wolf/anatomy.md`
- Review / classify: `.worktrees/a04-preflight-approval/.wolf/buglog.json`
- Review / classify: `.worktrees/a04-preflight-approval/.wolf/cerebrum.md`
- Review / classify: `.worktrees/a04-preflight-approval/.wolf/memory.md`
- Review / classify: `.worktrees/a04-preflight-approval/package-lock.json`
- Modify: `.worktrees/a04-preflight-approval/.wolf/memory.md`

**Interfaces:**
- Consumes: `### 2026-07-19 merge-readiness baseline` and `### 2026-07-19 committed-surface verdict`
- Produces: `### 2026-07-19 merge-surface classification` subsection in `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md`
- Produces: final branch verdict and next-step recommendation chosen from the spec’s three allowed outcomes

- [ ] **Step 1: Capture both the committed branch delta and current local drift for classification**

Run:

```bash
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" diff --name-status main...HEAD
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" status --short
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" diff --name-only
```

Expected:
- committed delta still includes the existing A-04 branch files
- local drift list still matches the files being classified

- [ ] **Step 2: Write the classification block into the branch-local handover**

Add this section to `.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md` and update the bullets only if the live commands prove a different bucket:

```md
### 2026-07-19 merge-surface classification

#### Committed changes worth preserving
- `validation/v1/lib/a04.ts`
- `validation/v1/lib/scenarios.ts`
- `tests/validation/prepareA04.test.ts`
- `tests/validation/contracts.test.ts`
- `validation/v1/README.md`
- `docs/handover/ccloop-handover.md`
- `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`

#### Committed branch-internal changes not intended for `main`
- `.superpowers/sdd/progress.md`
- `.superpowers/sdd/task-2-report.md`
- `.superpowers/sdd/task-3-report.md`
- `.wolf/anatomy.md`
- `.wolf/buglog.json`
- `.wolf/cerebrum.md`
- `.wolf/memory.md`

#### Current uncommitted merge-surface
- `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`

#### Current uncommitted local-only
- `.superpowers/sdd/progress.md`
- `.superpowers/sdd/task-3-report.md`
- `.wolf/memory.md`

#### Current uncommitted unresolved
- `package-lock.json`
```

If live evidence proves a different bucket, update only that specific bullet rather than rewriting the whole section.

- [ ] **Step 3: Resolve the final branch verdict from the classification, not from preference alone**

Use exactly one of these verdicts in the handover:

```md
- Final branch verdict: `continue original branch tightening toward merge`
- Final branch verdict: `preserve branch but add one more tightening pass`
- Final branch verdict: `abandon branch and prefer clean prepare`
```

Apply this rule set:
- choose `continue original branch tightening toward merge` only if focused verification passed and the unresolved bucket is empty;
- choose `preserve branch but add one more tightening pass` if focused verification passed but any file remains unresolved (expected default because `package-lock.json` starts unresolved);
- choose `abandon branch and prefer clean prepare` only if the committed surface itself is disproved by a concrete blocker recorded in the handover and buglog.

- [ ] **Step 4: Write the exact next-step recommendation under the final verdict**

Append this exact structure to the same handover section:

```md
#### Next-step recommendation
- Keep using `.worktrees/a04-preflight-approval` as the assessment source of truth.
- Carry only the files listed under committed changes worth preserving toward `main`.
- Leave branch-internal OpenWolf and `.superpowers/sdd/` files out of the merge surface unless a later review proves one is required.
- Resolve `package-lock.json` explicitly before any merge/backport decision.
- Do not run a paid Scenario A call from this branch until a separate approval package is reviewed again.
```

If the final verdict is `abandon branch and prefer clean prepare`, replace the second bullet with:

```md
- Do not carry this branch forward as the merge source; preserve it only as review evidence while preparing a clean replacement path.
```

- [ ] **Step 5: Verify that the handover now contains all required buckets and one allowed verdict**

Run:

```bash
rg -n "Committed changes worth preserving|Committed branch-internal changes not intended for `main`|Current uncommitted merge-surface|Current uncommitted local-only|Current uncommitted unresolved|Final branch verdict|Next-step recommendation" \
  "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/docs/handover/ccloop-handover.md"
```

Expected: all seven headings are present exactly once.

- [ ] **Step 6: Append the Task 3 checkpoint to the worktree OpenWolf memory log**

Add this line to `.worktrees/a04-preflight-approval/.wolf/memory.md`:

```md
| HH:MM | Classified committed/local A-04 drift and recorded the final branch verdict | docs/handover/ccloop-handover.md, .superpowers/sdd/*, .wolf/*, package-lock.json, .wolf/memory.md | done | ~1500 |
```

- [ ] **Step 7: Commit Task 3**

```bash
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" add \
  docs/handover/ccloop-handover.md \
  docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md \
  .superpowers/sdd/task-2-report.md \
  .superpowers/sdd/task-3-report.md \
  .wolf/memory.md
git -C "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" commit -m "docs: classify A-04 branch merge surface"
```

Expected: commit contains only the branch-verdict docs that actually changed; do not stage `.superpowers/sdd/progress.md`, `.wolf/*`, or `package-lock.json` unless Task 3 proved they belong in the merge surface.

## Self-Review

- **Spec coverage:**
  - `Assessment and Tightening Order` → Task 1 locks the live baseline; Task 2 reviews the committed surface before local drift; Task 3 classifies drift and resolves the final branch verdict.
  - `Merge-Ready Completion Standard` → Task 2 reruns focused verification and tightens truthfulness docs; Task 3 records explicit committed/local/unresolved buckets and one allowed verdict.
  - `Expected Outputs` → Task 3 writes committed changes worth preserving, uncommitted merge-surface, uncommitted local-only, uncommitted unresolved, and the next-step recommendation into the handover.
  - `Execution Boundaries` → every task is read-only or surgical, strictly non-paid, and avoids destructive cleanup or evidence rewrite.
- **Placeholder scan:** no `TODO`, `TBD`, or unnamed tasks; each task has exact file paths, commands, expected outputs, and Markdown snippets.
- **Type consistency:** the plan uses the same three final verdict strings and the same three uncommitted-drift buckets (`merge-surface`, `local-only`, `unresolved`) all the way through.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-a04-branch-assessment-and-merge-readiness.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
