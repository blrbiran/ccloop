# Consolidation step 4: delete the old CLI entry (`--adapter` / `--adapter-config`) — design

Status: decided by the controller under the human's standing instruction; for the human's review after the fact.
Author: Orca controller session `be653b22`, 2026-10-01.
Prerequisites: step 2 (`resume`/`sweep --agents`, spec `2026-10-01-agents-resume-sweep-design.md`) and step 3 (Orca no
longer spawns `ccloop … --adapter`, Orca spec `2026-10-01-retire-legacy-orca-run-design.md`).

## 1. Rulings

- The human, 2026-10-01 (session `ceca1c47`): "先将这些问题解决，再删老入口" — the old entry goes last.
- The human, 2026-10-01 (this session): proceed on the controller's recommendations, report at the end. **C-n** marks
  the controller's decisions.

## 2. Today (measured)

- `run`, `resume`, `sweep` accept `--adapter scripted|codex --adapter-config <file>` (`src/cli.ts`: `parseArgs`,
  `buildAdapter`, `loadAdapter`, `ScriptedAdapterConfig`). After step 2 each also accepts `--agents`.
- `control` already refuses the old forms (`tests/control/agentsControl.test.ts`, "refuses the retired --adapter forms
  for every control method").
- Users of the old entry: `tests/cli/cli.test.ts` (about 12 criteria: scripted run/resume/sweep parse and `main` runs),
  `tests/cli/codex.test.ts` (5: codex parse and one spawn), `scripts/validate-codex-adapter.mjs` (spawns
  `run … --adapter codex --adapter-config`; criteria in `tests/validation/codexAdapter.test.ts`,
  `codexSoftBudget.test.ts`, `codexWatchdog.test.ts` call its `runValidation`), `examples/v1/scripted-adapter-config.json`,
  README, `docs/codex-adapter.md`, `docs/control-protocol-v1.md`. Re-count before editing.
- `ScriptedAdapter` is constructed directly (no CLI) by about 40 `runLoop`/`resumeLoop` criteria.

## 3. Design

### 3.1 Deleted (C-1)

- From `parseArgs`: `--adapter` and `--adapter-config` for `run`, `resume`, `sweep`. Either flag now refuses with
  `--adapter was removed; use --agents <table>` (exit 1), checked before any other flag so the message is the same
  whatever else is on the line. `--agents` becomes required for `resume` and `sweep`, and for `run` together with
  `--agent-selection`.
- `buildAdapter`, `loadAdapter`, `ScriptedAdapterConfig`, the `ParsedArgs` variants with `adapter`, the codex
  soft-budget notice's `parsed.adapter === "codex"` trigger (the `--agents` path already prints it by kind).
- `examples/v1/scripted-adapter-config.json`.

Kept: `ScriptedAdapter` (a library class its direct criteria use), `sweepRuns`' `createAdapter` option form (its
criteria inject it; the CLI no longer uses it — registered, not removed, so `sweepRuns.test.ts` stays untouched).

### 3.2 Criteria (C-2)

- `cli.test.ts`, `codex.test.ts`: a criterion whose subject survives (a run reaches `succeeded` from the CLI; resume
  and sweep from the CLI; codex reachable from the CLI) is migrated to `--agents` with ccloop's fake codex (`frames`
  mode from step 3, or `integration` where a codex answer is all it needs). A criterion whose subject is the deleted
  parsing (`--adapter` value validation, `--adapter-config` required) is replaced by one criterion: each of
  `run`/`resume`/`sweep` with `--adapter` or `--adapter-config` exits 1 with the removal message.
- `tests/cli/agentsRun.test.ts`: the mutual-exclusion rows (`--agents` with `--adapter`/`--adapter-config`) now expect
  the removal message.
- `scripts/validate-codex-adapter.mjs`: writes an agents table (one codex installation from its existing options) and a
  selection file whose configHash it obtains from `ccloop control capabilities` (as Orca does), and spawns
  `run --agents … --agent-selection …`. Its criteria keep their assertions; only fixtures they build for the old entry
  change.

### 3.3 Docs

README, `docs/codex-adapter.md`, `docs/control-protocol-v1.md`: the old-entry examples are replaced by `--agents`
ones. These are living docs; a named note records the change.

## 4. Mutations

| # | Mutation | Expected red |
|---|---|---|
| E1 | accept `--adapter` again on `run` (fall through to the old parse) | the removal criterion |
| E2 | check `--adapter` after the other flags (message depends on what else is given) | the removal criterion's rows that omit other required flags |

## 5. Registered

- After this step Orca's pinned ccloop must be repinned (human pushes ccloop first) before Orca's `verify:ccloop-pin`
  can see the new entry; Orca no longer uses the old one after step 3.

## 6. Correction after the human review (2026-10-01, Orca session b5e8d368)

The human ruled against the removal message ("不需要提示，直接不支持就好": ccloop is unreleased, nobody uses the old
entry). §3.1's message `--adapter was removed; use --agents <table>` is gone. `run`, `resume` and `sweep` now refuse any
`--`-prefixed flag outside `--contract`, `--run-dir`, `--agents`, `--agent-selection`, `--root`, `--max-runs` with
`unknown flag <flag>`, the old two among them. The check runs on the flag positions of the flag/value pairing, before any
other flag check. A non-`--` token in a flag position (a positional root) is not caught by it and still reads as
`missing required flags`, as before. The removal criteria were rewritten whole to expect `unknown flag <flag>`, plus a
row for a misspelled flag (`--task-tokens`), which the pairing used to drop without a word.

Mutations, re-run against this check:

| # | Mutation | Expected red |
|---|---|---|
| U1 | drop the unknown-flag check | every row of `unknown flags on run, resume and sweep` and the three `unknown flag` rows of `agentsRun.test.ts` |
| U2 | run the check after the `--agent-selection`/required-flags checks | the rows that omit other required flags (`run --adapter scripted`, `resume --adapter codex`) |
