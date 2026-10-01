# Consolidation step 2 (#4): `resume` and `sweep` continue a run started by `run --agents` — design

Status: decided by the controller under the human's standing instruction; for the human's review after the fact.
Author: Orca controller session `be653b22`, 2026-10-01.
Base: ccloop main after consolidation step 1 (spec `2026-10-01-claude-adapter-consolidation-step1-design.md`).

## 1. Rulings

- The human, 2026-10-01 (Orca session `ceca1c47`): the consolidation order ① → ② (#4) → ③ → ④. Earlier ruling on #4's
  design: "冻结选择进 `<runDir>/agent-selection.json`".
- The human, 2026-10-01 (this session): "这一轮执行过程中如果有问题，先按你的建议执行（不要再找我）。执行完在最后阶段报给我审核。"
  Every decision below marked **C-n** is the controller's under that instruction, and is listed for the human's review.

## 2. Today (measured)

- `run --agents <table> --agent-selection <file>` (`src/cli.ts`, `runWithAgents`) reads the table, validates the
  selection file `{selection, configHash}` (strict), resolves it (`resolveAgent`: version probe, `agent-version-drift`),
  refuses `control-config-hash-mismatch`, builds the adapter from the descriptor and calls `runLoop`. It writes nothing
  of the selection into the run directory.
- `resume` and `sweep` take only `--adapter <scripted|codex> --adapter-config <file>`; `parseArgs` refuses `--agents`
  with `--agents is only supported by run`. That refusal is the scope cut of Orca's agent-selection spec §4.9/§11, not
  a technical limit.
- `resumeLoop(runDir, adapter)` takes a built adapter and reads only run-directory files. `sweepRuns` builds ONE
  adapter (`createAdapter()`) after the banner and the lock notes, and resumes every candidate with it.
- Orca never calls `ccloop resume` or `ccloop sweep` (`src/scheduler/ccloopRunner.ts` says so explicitly).
- `ensureFreshRunDir` does not look at an `agent-selection.json`; `scanRuns` (and so `ls`) reads only the four
  known files.

## 3. Design

### 3.1 `run --agents` freezes the selection (C-1)

After the selection is validated and its hash matches (the existing order), and before `runLoop`:

1. `ensureFreshRunDir(runDir)` — the same refusal `runLoop` would give, run first, so a non-fresh directory is never
   written into.
2. `mkdir(runDir, { recursive: true })`, then write `<runDir>/agent-selection.json` with `{ selection, configHash }`
   (the validated object, `JSON.stringify` + `\n`), `mode: 0o600`, `flag: "wx"`. An existing file refuses the run
   (`agent-selection-exists`, exit 1) — it can only be a leftover, and overwriting it would rebind someone's run.

What is frozen is the selection and its hash — the human's ruling — not the materialized config: `resume` resolves the
selection against the table it is given. The hash still refuses a table whose hashed fields changed; `command`,
`timeoutMs` and `killGraceMs` are not hashed and follow the table (registered, §6).

### 3.2 `resume --run-dir <dir> --agents <table>` (C-2)

- `parseArgs`: `resume` accepts `--agents <table>` instead of `--adapter`/`--adapter-config`; the two forms stay
  mutually exclusive (existing message). `--agent-selection` with `resume` is refused
  (`--agent-selection is only supported by run`: the selection is the run's own, not the caller's).
- Before `resumeLoop` and before any write: read `<runDir>/agent-selection.json` (missing →
  `agent-selection-missing`, exit 1; unparseable or not matching the strict schema → `agent-selection-file-invalid`,
  exit 1), resolve against the table, compare the hash (`control-config-hash-mismatch`, exit 1), build the adapter.
  Any of these refusals leaves the run directory byte-for-byte unchanged.
- A run started before this step (no frozen file) or started with `--adapter` is refused with
  `agent-selection-missing`; it is resumable only the way it always was.

### 3.3 `sweep --root <root> --agents <table> --max-runs <n>` (C-3)

- `parseArgs`: `sweep` accepts `--agents <table>` instead of `--adapter`/`--adapter-config`; same exclusivity.
- `SweepOptions` gains a second form: instead of `createAdapter`, an `adapterForRun(runDir): Promise<RuntimeAdapter>`.
  `adapterName` becomes `"agents"` for the banner. Exactly one of the two is given (a discriminated union in the type).
- Order kept: the table is read and parsed before the scan (an unreadable table exits 1 having swept nothing, as an
  unreadable adapter config does); the banner and lock notes come first; `adapterForRun` is called per candidate, in
  the loop, right before that candidate's `resume`.
- A candidate whose adapter cannot be built (missing/invalid file, drift, hash mismatch) is reported as `refused` with
  the error's message as detail, and the sweep goes on. It is never adopted, so it does not count against
  `--max-runs` — the same accounting as a resume-gate refusal.
- The existing `createAdapter` form is unchanged in behaviour, and its criteria are untouched.

### 3.4 Not in this step (C-4)

- Orca does not start calling `ccloop resume`/`sweep`. Resuming interrupted conflict-resolution runs from Orca is a
  separate Orca change (it was named as #4's companion; nothing in ccloop's #4 depends on it).
- No migration of existing `--agents` run directories.

## 4. Criteria

Existing criteria rewritten (C-5; the human named none of these — listed for review):

- `tests/cli/agentsRun.test.ts`: the two `it.each` rows that expect `--agents is only supported by run` for `resume`
  and for `sweep`. They become rows that parse `resume --run-dir r --agents t` and `sweep --root r --agents t
  --max-runs 1` successfully, plus new refusal rows for `--agent-selection` on `resume`/`sweep`.

New criteria:

1. `run --agents` writes `<runDir>/agent-selection.json` (0600, the validated selection + hash) before the run starts;
   a pre-existing `agent-selection.json` refuses the run and the directory is unchanged; a non-fresh run directory is
   refused before the file is written.
2. `resume --agents`: a run started with `run --agents` and interrupted (e.g. a scripted stop mid-run, or a crafted
   `loop-state.json` in `executing` with a dead owner, following the existing resume integration fixtures) is resumed
   with an adapter of the frozen selection and reaches `succeeded` through the fake codex.
3. `resume --agents` refusals: missing file, invalid file, hash mismatch — each exit 1, run directory unchanged
   (byte comparison of the directory tree, the way `zeroWrite.test.ts` does it).
4. `sweep --agents`: two candidates, one with a valid frozen selection and one without; the first is resumed, the second
   reported `refused` with `agent-selection-missing`; `--max-runs 1` still lets the valid one run when the refused one
   comes first (refusals do not consume the quota).
5. `sweepRuns` unit: with `adapterForRun`, the banner and lock notes precede the first `adapterForRun` call.

## 5. Mutations (seen red before done)

| # | Mutation | Expected red |
|---|---|---|
| A1 | `run --agents` skips the freeze write | criterion 1, criterion 2 |
| A2 | write without `wx` (overwrite) | criterion 1's pre-existing-file case |
| A3 | freeze before `ensureFreshRunDir` | criterion 1's non-fresh case |
| A4 | `resume --agents` skips the hash comparison | criterion 3's mismatch case |
| A5 | sweep counts a refused candidate against `--max-runs` | criterion 4 |
| A6 | sweep calls `adapterForRun` before the banner | criterion 5 |

## 6. Registered, not done

- `command`, `timeoutMs`, `killGraceMs` are not in `configHash`; a table edited in those fields between `run` and
  `resume` takes effect silently (this is how `run --agents` already treats them).
- Old `--agents` runs without a frozen file cannot be resumed by `--agents`.
