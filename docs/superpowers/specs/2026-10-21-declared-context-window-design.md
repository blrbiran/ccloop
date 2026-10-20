# A per-installation declared context window for models the catalog does not list (#70, narrow)

- **Author:** Orca session `9ec98639` (2026-10-21), background track D. Code references are ccloop main `75343fd`.
- **Status:** design; not planned. **Human ruling** (Orca ledger `.superpowers/sdd/2026-10-20-session-308b874c/progress.md`):
  "#70 per-installation declared context window (narrow) 同意". Orca handoff §4.2 item 4: "每安装 `declaredContextWindow`，
  只在模型不在目录时生效、标「声明值」，改 ccloop 先写 spec".
- **Source:** external issue 70 (`orca_archived_files/issue-20261008.md:1774-1835`): Orca's estimator refused a codex
  selection with `context-unavailable` because `capabilities.contextWindowTokens` was null
  (Orca `src/control/estimatorCompatibility.ts:23`).

## 1. Today

- Resolution reads the catalog row of the selected model (`src/agents/materialize.ts:93-109`) and the descriptor
  derives the window from it: codex `row?.contextWindow ?? null` (`src/agents/codex.ts:50`), omp the same
  (`src/agents/omp.ts:39`), claude a fixed 200 000 / 1 000 000 (`src/agents/claude.ts:73`).
- A codex model that the catalog does not list (any visibility) leaves `row` undefined ⇒ window `null`. A codex catalog
  that could not be read also leaves `row` undefined (`materialize.ts:109`). An omp model must be an exact catalog
  selector or resolution refuses (`:105`); its row's window can still be `null` (`src/agents/ompModels.ts:32`).

## 2. Design

### 2.1 Table field

- New optional field `declaredContextWindow` in the **codex** and **omp** `installationExtras` (`src/agents/codex.ts:35`,
  `src/agents/omp.ts:15`): a positive safe integer. Absent ⇒ today's behaviour. **claude** does not get it: its window is
  fixed by the selection, so the strict claude installation (`src/agents/claude.ts:31`, empty extras) refuses the key (`agents-table-invalid`).
- Part of the installation ⇒ part of `configHash` only for tables that set it.

### 2.2 When it applies (only when the catalog does not give a window)

`materialize.ts` computes `contextWindowSource` and passes the declared value to `descriptor.capabilities`:

| situation | `contextWindowTokens` | `contextWindowSource` |
|---|---|---|
| catalog row with a window | the row's window | absent (as today) |
| codex: catalog read, **no row** for the model; or omp/codex row with `contextWindow: null` | `declaredContextWindow` | `"declared"` |
| same, no `declaredContextWindow` | `null` | absent (as today) |
| codex catalog not readable (`catalog === null` or `rows === null`) | `null` | absent — absence of the model is not proven |
| claude | fixed, as today | absent |

A declared value never overrides a catalog value (narrow ruling).

### 2.3 Marked "declared" wherever it is reported

- The resolution answer (`AgentResolutionV1`, `src/agents/types.ts:48-58`) gains optional `contextWindowSource:
  "declared"`, present only in the declared row of §2.2. The capability view itself is unchanged (it is strict on both
  sides and frozen into Orca's stored records: ccloop `src/control/command.ts:50-70`, Orca
  `src/control/webProtocol.ts:105-115`).
- ccloop's capabilities response schema (`command.ts:90-101`) accepts the optional field.
- `ccloop control models` / `agents models` list catalog rows only and are unchanged (a declared window belongs to no row).
- `outcome.json`/run evidence: none — the window is a resolution fact, already recorded in the frozen selection.

## 3. Orca impact (add to ccloop handoff "Orca 依赖本仓")

- Orca's `agentResolutionSchema` is strict (`Orca/src/control/ccloopPort.ts:51`): it must accept optional
  `contextWindowSource: "declared"` **in the same repin commit**; a ccloop that sends it to an older Orca breaks
  `capabilities`. Only installations that set `declaredContextWindow` ever send it.
- Orca shows the window with a "declared / 声明值" mark where it shows `contextWindowTokens` (profiles, estimator
  compatibility, agents page) — Orca's own change.
- Out of the narrow ruling, recorded: a codex model not in the catalog still has `singleCallExecution: null`
  (`codex.ts:58-60`), so Orca's estimator still refuses it with `single-call-unavailable`; #70's estimator case is only
  half solved by this. Extending soft single calls to unlisted models is a separate decision for the human.

## 4. Tests (each red first with its named mutation, in a `git clone --local` copy)

1. Table: codex/omp accept a positive integer; `0`, negative, non-integer, string ⇒ `agents-table-invalid`; claude with
   the key ⇒ `agents-table-invalid`. Mutation: add the key to claude's extras ⇒ red.
2. Resolution (catalog injected): codex listed row ⇒ row window, no source; codex unlisted + declared ⇒ declared value
   and `contextWindowSource: "declared"`; codex unlisted, no declared ⇒ null; codex catalog unreadable + declared ⇒
   null, no source; omp row with null window + declared ⇒ declared; omp row with window + declared ⇒ row window.
   Mutations: use declared even when a row window exists (red on the override case); drop the "catalog readable" guard
   (red on the unreadable case); omit the source marker (red on the declared case).
3. `configHash` changes when `declaredContextWindow` is added (it is in the installation); unchanged for tables without it.
4. ccloop `control capabilities` answer with the source validates against its own schema; without it, byte-identical
   to today.

## 5. Decisions (controller's calls, reversible)

1. Codex and omp only; claude refuses the key.
2. An unreadable catalog does not trigger the declared value.
3. The marker lives on the resolution, not on the capability view.
4. No change to single-call availability for unlisted models (narrow ruling; surfaced in §3).
