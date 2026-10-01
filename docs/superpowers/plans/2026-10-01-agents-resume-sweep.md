# Consolidation Step 2 (#4: resume/sweep for `--agents` runs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `run --agents` freezes its selection into `<runDir>/agent-selection.json`; `resume --agents <table>` and `sweep --agents <table>` rebuild each run's adapter from that frozen selection.

**Architecture:** One shared helper resolves a frozen selection file against a table into an adapter (the code `runWithAgents` already has, extracted); `run` writes the file, `resume` reads it before `resumeLoop`, `sweepRuns` gets a per-run adapter factory option.

**Tech Stack:** TypeScript (NodeNext), zod, vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-agents-resume-sweep-design.md`.

## Global Constraints

- English code/comments/commits; trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Existing criteria: only the two `tests/cli/agentsRun.test.ts` `it.each` rows that expect `--agents is only supported by run` for `resume` and `sweep` may change (spec §4, C-5). Every other existing criterion untouched; if one goes red, stop and report.
- Published comments keep their words; append `*** ERRATUM (consolidation step 2, 2026-10-01, Orca session be653b22, controller ruling C-n) -- … ***` at the end of the block.
- Error codes verbatim: `agent-selection-missing`, `agent-selection-file-invalid`, `agent-selection-exists`, `control-config-hash-mismatch`; messages `--agent-selection is only supported by run`, `--agents and --adapter are mutually exclusive`.
- File: `<runDir>/agent-selection.json`, content `JSON.stringify({ selection, configHash }) + "\n"`, mode `0o600`, flag `"wx"`.
- No push. Mutations only in a `git clone --local` copy. Verification output to a file, read whole. `/bin/rm`, `cat a > b`, `/usr/bin/git`.

## Review Focus

1. A refused `resume --agents` must leave the run directory byte-for-byte unchanged (no `resume_requested` event appended).
2. `run --agents` into a non-fresh directory must not leave an `agent-selection.json` behind.
3. A sweep candidate without a frozen file must not stop the sweep or consume `--max-runs`.
4. `--adapter` and `--agents` together on `resume`/`sweep` keep refusing with the exclusivity message.
5. An `--adapter` run (no frozen file) resumed with `--agents` is refused, not run with some default.

---

### Task 1: freeze, the shared resolver, and `resume --agents`

**Files:**
- Modify: `src/cli.ts` (parseArgs `resume`/`sweep` `--agents` forms; extract `adapterFromSelectionFile(tablePath | table, selectionPath)`; freeze in `runWithAgents`; `resume --agents` branch in `main`)
- Modify: `src/persistence/fileStore.ts` (export `ensureFreshRunDir`, no behaviour change)
- Test: `tests/cli/agentsRun.test.ts` (rewrite the two rows; new criteria), new `tests/cli/agentsResume.test.ts`

**Interfaces — Produces:**
- `ParsedArgs` gains `{ command: "resume"; runDir: string; agentsTablePath: string }` and `{ command: "sweep"; root: string; agentsTablePath: string; maxRuns: number }`.
- `export const FROZEN_SELECTION_FILE = "agent-selection.json"` in `src/cli.ts`.
- `async function adapterForFrozenSelection(table: AgentsTableV1, runDir: string): Promise<RuntimeAdapter>` — reads `<runDir>/agent-selection.json` (ENOENT → `AgentError("agent-selection-missing", runDir)`; unreadable/invalid JSON/schema → `agent-selection-file-invalid`), resolves, compares hash, returns `getDescriptor(config.kind).createAdapter(config)`.

- [ ] **Step 1: parseArgs.** In the `--agents` block: if `--agent-selection` is given and command is not `run` → throw `--agent-selection is only supported by run`. `run` keeps its current requirements. `resume` requires `--run-dir` and `--agents`; `sweep` requires `--root`, `--agents`, `--max-runs` (same literal positive-integer rule as the adapter form — reuse that check, do not copy it). Exclusivity check stays first. Append an ERRATUM to the comment block above it ("…a run started this way cannot be resumed or swept (spec §11)" no longer holds: step 2 freezes the selection and resume/sweep take `--agents`).
- [ ] **Step 2: rewrite the two rows** in `agentsRun.test.ts`: `["resume","--run-dir","r","--agents","t","--agent-selection","s"]` and `["sweep","--root","r","--agents","t","--agent-selection","s"]` now expect `--agent-selection is only supported by run`; add `it` "parses the agents form of resume and sweep" asserting `parseArgs(["resume","--run-dir","r","--agents","t"])` → `{ command:"resume", runDir:"r", agentsTablePath:"t" }` and the sweep equivalent with `"--max-runs","2"` → `maxRuns: 2`; add rows refusing `resume --agents t --adapter codex` (exclusivity) and `sweep --root r --agents t` without `--max-runs` (missing required flags). Comment on the rewritten rows: `Rewritten (consolidation step 2, controller ruling C-5 under the human's standing instruction, 2026-10-01).`
- [ ] **Step 3: freeze criteria (red first)** in `agentsRun.test.ts`, using the existing `world()`/`runCli()`:
  - "freezes the selection into the run directory before the run starts": after a successful `runCli(w)`, `<runDir>/agent-selection.json` parses to exactly the selection file's `{selection, configHash}` and `stat().mode & 0o777` is `0o600`.
  - "refuses a run directory that already holds a frozen selection, leaving it unchanged": pre-write `<runDir>/agent-selection.json` with `"{}\n"`; exit 1; stderr contains `agent-selection-exists`; the file still reads `"{}\n"`; no `loop-state.json`.
  - "refuses a non-fresh run directory before freezing anything": pre-create `<runDir>/events.jsonl` (empty); exit 1; no `agent-selection.json` exists.
- [ ] **Step 4: implement freeze.** In `runWithAgents`, after the hash check and before `loadContract`: `await ensureFreshRunDir(parsed.runDir)` (exported from fileStore; keep its name), `await mkdir(parsed.runDir, { recursive: true })`, write the file with `flag: "wx"`; map `EEXIST` to `AgentError("agent-selection-exists", path)`.
- [ ] **Step 5: resume criteria (red first)** in new `tests/cli/agentsResume.test.ts` (reuse `world()` by exporting it from `agentsRun.test.ts` is NOT allowed — copy the minimal fixture instead, a codex installation `fake-codex.mjs` in `integration` mode via `codexFixture`, with the configHash from `resolveAgent(table, selection)`):
  - "resumes a run started by run --agents with the frozen selection": produce an interrupted `--agents` run: run `runLoop` directly with a stop request set after plan (follow `tests/controller/resumeLoop.integration.test.ts` for how an interrupted run is produced with a dead owner — use the same helper shape, e.g. a stop signal that leaves status `executing`/`planning`), write the frozen file the way `run --agents` would, then spawn `cli resume --run-dir <dir> --agents <table>`; expect exit 0 and `loop-state.json` status `succeeded`. If no interrupted-run fixture can be reached without editing shared helpers, state that in the report and use the closest existing pattern; do not edit existing helpers.
  - "refuses a run with no frozen selection, leaving it unchanged": same interrupted run without the file; exit 1; stderr `agent-selection-missing`; a recursive byte snapshot of the run directory (path → sha256 of content, plus file list) is identical before and after.
  - "refuses a frozen selection whose configHash no longer matches": write the file with a different 64-hex hash; exit 1; `control-config-hash-mismatch`; snapshot identical.
  - "refuses an invalid frozen selection file": `"not json"`; exit 1; `agent-selection-file-invalid`; snapshot identical.
- [ ] **Step 6: implement** `adapterForFrozenSelection` and the `resume` branch in `main` (before the `sweep` branch and before `loadAdapter`): `readAgentsTable`, `adapterForFrozenSelection`, codex notice by kind (as `runWithAgents`), then `resumeLoop(parsed.runDir, adapter)`, exit `succeeded ? 0 : 2`. Refactor `runWithAgents` to share the resolve-and-compare code with it (one place compares the hash).
- [ ] **Step 7: green** `./node_modules/.bin/vitest run tests/cli tests/persistence > s.txt 2>&1`; typecheck RC 0. Commit `feat(cli): run --agents freezes its selection; resume --agents continues the run with it`.

### Task 2: `sweep --agents`

**Files:**
- Modify: `src/sweep/sweepRuns.ts` (options union with `adapterForRun`), `src/cli.ts` (sweep `--agents` branch)
- Test: `tests/sweep/sweepRuns.test.ts` (new criteria only, appended), `tests/cli/agentsResume.test.ts` (one CLI criterion)

**Interfaces — Consumes:** Task 1's `adapterForFrozenSelection`, `ParsedArgs` sweep-agents variant. **Produces:** `SweepOptions` = common fields & (`{ adapterName: "scripted" | "claude" | "codex"; createAdapter: () => RuntimeAdapter }` | `{ adapterName: "agents"; adapterForRun: (runDir: string) => Promise<RuntimeAdapter> }`).

- [ ] **Step 1: criteria (red first)**, appended to `sweepRuns.test.ts` with the file's own `harness`:
  - "with adapterForRun, the banner and lock notes come before the first adapter is built": record order like the existing banner-order criterion; `adapterForRun` pushes `adapterForRun:<path>`; assert the banner line and every note precede it.
  - "a candidate whose adapter cannot be built is refused and does not consume --max-runs": two eligible candidates, `maxRuns: 1`, `adapterForRun` rejects with `new AgentError("agent-selection-missing", path)` for the first and returns an inert adapter for the second; the first's report line has outcome `refused` and contains `agent-selection-missing`; the second is resumed (the injected `resume` was called with the second path); exit 0.
- [ ] **Step 2: implement** in `sweepRuns`: if `"adapterForRun" in options`, inside the loop before `resume`: `let adapter; try { adapter = await options.adapterForRun(candidate.path); } catch (error) { report = { outcome: "refused", detail: one-line message }; print the report line as the existing refusal path does; continue; }` — reuse the existing report-printing code path, not a copy. The `createAdapter` form stays exactly as it is.
- [ ] **Step 3: CLI.** `main`'s sweep branch: for the agents variant read the table before the scan (`readAgentsTable`; an unreadable table exits 1 having swept nothing) and pass `adapterName: "agents"`, `adapterForRun: (runDir) => adapterForFrozenSelection(table, runDir)`.
- [ ] **Step 4: CLI criterion** in `agentsResume.test.ts`: "sweep --agents resumes the run with a frozen selection and refuses the one without": two interrupted runs under one root (one with the file, one without), `--max-runs 1`; exit 0; the frozen one ends `succeeded`; the other's directory snapshot is unchanged; stdout has a `refused` line naming `agent-selection-missing`. (Order runs so the refused one sorts first.)
- [ ] **Step 5: green** `./node_modules/.bin/vitest run tests/sweep tests/cli tests/registry > s.txt 2>&1`; typecheck RC 0. Commit `feat(sweep): sweep --agents builds each run's adapter from its frozen selection`.

### Task 3: docs, mutations

- [ ] **Step 1: README.** Remove the two "在 #4 做完之前…" lines step 1 added under §3.2/§3.4; add `resume --run-dir <dir> --agents <table>` and `sweep --root <root> --agents <table> --max-runs <n>` examples and one line on the frozen `agent-selection.json` (and that `--adapter` runs keep resuming with `--adapter` until step 4).
- [ ] **Step 2: mutations A1–A6** (spec §5) in a clone; record each red criterion; restore with `cat`; prove `git diff`/`--cached` 0 bytes.
- [ ] **Step 3: commit** docs; append the ledger.
