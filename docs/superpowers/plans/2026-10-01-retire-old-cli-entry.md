# Consolidation Step 4 (delete `--adapter` / `--adapter-config`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ccloop's CLI keeps only the agents-table entry: `run`, `resume`, `sweep` take `--agents`; `--adapter` and `--adapter-config` refuse with one message.

**Architecture:** Delete the old parse branches and `buildAdapter`/`loadAdapter`; migrate the CLI criteria that still matter to `--agents` with the fake codex (`frames` / `integration` modes); rewrite `scripts/validate-codex-adapter.mjs` to an agents table.

**Tech Stack:** TypeScript, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-retire-old-cli-entry-design.md`. Prerequisites landed: step 2 (`resume`/`sweep --agents`), step 3's ccloop part (fake codex `frames` mode).

## Global Constraints

- English; trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; no push; `/usr/bin/git`, `/bin/rm`, `cat a > b`.
- Removal message verbatim: `--adapter was removed; use --agents <table>` (for either `--adapter` or `--adapter-config`), checked first in `parseArgs` for `run`/`resume`/`sweep`.
- Criteria: migrate a criterion whose subject survives (CLI run reaches `succeeded`; CLI resume; CLI sweep; codex reachable from the CLI) to `--agents`, keeping its assertions; replace criteria whose subject is the deleted parsing with the removal criterion. List every changed/deleted criterion by name in the report. `ScriptedAdapter`'s direct criteria and `sweepRuns.test.ts` stay untouched.
- Published comments: ERRATUM `*** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling C-n) -- … ***` at the end of the block.
- `dist/` tests need a build: run them in a scratchpad `git clone --local` copy after `npm run build`, never build in the main tree.

## Review Focus

1. `--adapter` refused even when other required flags are missing (message must not become "missing required flags").
2. `control` still refuses the retired forms (its criterion unchanged).
3. The codex soft-budget notice still prints for a codex installation.
4. `validate-codex-adapter.mjs`'s criteria still pass with their assertions unchanged.
5. README / docs contain no `--adapter-config` example.

---

### Task 1: the CLI

**Files:** `src/cli.ts`; tests `tests/cli/cli.test.ts`, `tests/cli/codex.test.ts`, `tests/cli/agentsRun.test.ts`; delete `examples/v1/scripted-adapter-config.json`.

- [ ] **Step 1: removal criterion (red first)** in `tests/cli/cli.test.ts`: `it.each` over `["run","--contract","c","--run-dir","r","--adapter","codex","--adapter-config","a"]`, `["run","--adapter","scripted"]`, `["resume","--run-dir","r","--adapter-config","a"]`, `["sweep","--root","r","--adapter","codex","--adapter-config","a","--max-runs","1"]`, `["resume","--adapter","codex"]` → `parseArgs` throws `--adapter was removed; use --agents <table>`.
- [ ] **Step 2: inventory** the criteria in `cli.test.ts`, `codex.test.ts`, `agentsRun.test.ts` that pass `--adapter`/`--adapter-config` (re-count; the survey found about 12 + 5 + the two exclusivity rows). For each: migrate (subject survives) or replace (subject is the deleted parsing). Record the decision per name.
- [ ] **Step 3: migrate.** Runs use an agents table with one codex installation `[node, tests/fixtures/fake-codex.mjs, "frames"|"integration", marker, …]`, a selection file with the configHash from `resolveAgent(table, selection)`, and `run --agents … --agent-selection …` / `resume --agents …` / `sweep --agents …`. A scripted multi-frame run uses `frames` with `{ "*": frames }`. The exclusivity rows in `agentsRun.test.ts` now expect the removal message.
- [ ] **Step 4: implement**: remove the `adapter` `ParsedArgs` variants, the old parse branches, `buildAdapter`, `loadAdapter`, `ScriptedAdapterConfig`, the `ScriptedAdapter`/`CodexAdapter` imports if unused, the `parsed.adapter === "codex"` notice line; add the removal check at the top of `run`/`resume`/`sweep` parsing; `--agents` becomes required for all three. ERRATA on comments that describe the old entry as live (the block comment above `--agents` parsing, the sweep §8 comment that names the adapter config).
- [ ] **Step 5: green** `./node_modules/.bin/vitest run tests/cli tests/control/agentsControl.test.ts > s.txt 2>&1` in a built clone (the CLI tests spawn `dist/cli.js`); typecheck RC 0. Commit `refactor(cli): delete --adapter and --adapter-config; run, resume and sweep take --agents`.

### Task 2: validation script, docs

**Files:** `scripts/validate-codex-adapter.mjs`, its criteria files (`tests/validation/codexAdapter.test.ts`, `codexSoftBudget.test.ts`, `codexWatchdog.test.ts`) only where they build fixtures for the old entry, `README.md`, `docs/codex-adapter.md`, `docs/control-protocol-v1.md`.

- [ ] **Step 1:** `validate-codex-adapter.mjs` writes `agents.json` (one codex installation from its existing codex options) and `selection.json` with the configHash from `node dist/cli.js control capabilities` for that selection (or from the package's `resolveAgent` if the script already imports from `dist/src`), then spawns `run --agents … --agent-selection …`. Its options and output shape stay the same.
- [ ] **Step 2:** criteria in the three validation files keep their assertions; change only fixture construction that named the old entry. Run them in the built clone.
- [ ] **Step 3:** README / the two docs: replace every `--adapter`/`--adapter-config` example with the `--agents` form, add one dated line "consolidation step 4 removed --adapter/--adapter-config". Re-grep `src scripts tests README.md docs/*.md` (not `docs/superpowers`, not `.superpowers`) for `--adapter-config` → only ERRATA, the removal message and its criterion remain.
- [ ] **Step 4:** commit `docs(cli): --agents is the only entry; the codex validation script uses an agents table`.

### Task 3: mutations E1, E2 (spec §4) in a clone; ledger.
