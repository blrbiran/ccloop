# A per-installation declared context window for models the catalog does not list (#70, narrow)

- **Author:** Orca session `9ec98639` (2026-10-21), background track D. **Code references are ccloop main `71d650c`.**
- **Status:** design; not planned; revised after independent review round 1 (last section). **Human ruling** (Orca
  ledger `.superpowers/sdd/2026-10-20-session-308b874c/progress.md`): "#70 per-installation declared context window
  (narrow) 同意". Orca handoff §4.2 item 4: "每安装 `declaredContextWindow`，只在模型不在目录时生效、标「声明值」，改
  ccloop 先写 spec".
- **Source:** external issue 70 (`orca_archived_files/issue-20261008.md:1774-1835`): Orca's estimator refused a codex
  selection with `context-unavailable` because `capabilities.contextWindowTokens` was null
  (Orca `src/control/estimatorCompatibility.ts:23`).

## 1. Today

- Resolution reads the catalog row of the selected model (`src/agents/materialize.ts:93-109`) and the descriptor
  derives the window from it (`AgentDescriptor.capabilities(config, row?)`, `src/agents/registry.ts:36`): codex
  `row?.contextWindow ?? null` (`src/agents/codex.ts:50`), omp the same (`src/agents/omp.ts:39`), claude a fixed
  200 000 / 1 000 000 (`src/agents/claude.ts:73`).
- A codex model that the catalog does not list (any visibility) leaves `row` undefined ⇒ window `null`. A codex catalog
  that could not be read **also** leaves `row` undefined (`materialize.ts:109`) — the descriptor cannot tell the two
  apart. An omp model must be an exact catalog selector or resolution refuses (`:105`); its row's window can still be
  `null` (`src/agents/ompModels.ts:32`).

## 2. Design

### 2.1 Table field

- New optional field `declaredContextWindow` in the **codex** and **omp** `installationExtras` (`src/agents/codex.ts:35`,
  `src/agents/omp.ts:15`): a positive safe integer. Absent ⇒ today's behaviour. **claude** does not get it: its window is
  fixed by the selection, so the strict claude installation (`src/agents/claude.ts:31`, empty extras) refuses the key
  (`agents-table-invalid`).
- **Not part of `configHash`:** `agentConfigHash` (`materialize.ts:36-45`) drops it, the way it drops `version`,
  `command` and the run limits. `configHash` names which agent configuration a run used; the declared window does not
  change what the agent is or how it is invoked — it only fills in a number the catalog did not report — so editing it
  must not invalidate Orca's frozen selections. The value in effect at resolution is frozen by Orca with the slot (§3).

### 2.2 When it applies (only when the catalog does not give a window)

`materialize.ts` decides, because only it knows whether the catalog was read: it passes a third argument
`declaredWindow: number | null` to `descriptor.capabilities(config, row, declaredWindow)` — the installation's value when
the table row below says "declared", else `null`. Descriptors use `row?.contextWindow ?? declaredWindow ?? null` (codex,
omp); claude ignores it.

| situation | `contextWindowTokens` | `contextWindowSource` |
|---|---|---|
| catalog row with a window | the row's window | absent (as today) |
| codex: catalog read, **no row** for the model; or omp/codex row with `contextWindow: null` | `declaredContextWindow` | `"installation-declared"` |
| same, no `declaredContextWindow` | `null` | absent (as today) |
| codex catalog not readable (`catalog === null` or `rows === null`) | `null` | absent — absence of the model is not proven |
| claude | fixed, as today | absent |

A declared value never overrides a catalog value (narrow ruling).

### 2.3 Marked "declared" wherever it is reported

- The resolution answer (`AgentResolutionV1`, `src/agents/types.ts:48-58`) gains optional `contextWindowSource:
  "installation-declared"`, present only in the declared row of §2.2. The capability view itself is unchanged (strict on
  both sides and frozen into Orca's records: ccloop `src/control/command.ts:50-70`, Orca
  `src/control/webProtocol.ts:105-115`).
- ccloop's capabilities response schema (`command.ts:90-101`) accepts the optional field.
- `ccloop control models` / `agents models` list catalog rows only and are unchanged (a declared window belongs to no row).

## 3. Orca impact (add to ccloop handoff "Orca 依赖本仓")

- Orca's `agentResolutionSchema` is strict (`Orca/src/control/ccloopPort.ts:51`): it must accept optional
  `contextWindowSource: "installation-declared"` **in the same repin commit**; a ccloop that sends it to an older Orca
  breaks `capabilities`. Only installations that set `declaredContextWindow` ever send it.
- Orca must **freeze** `contextWindowSource` with the slot: `frozenSlotOf` (`Orca/src/control/agentSelection.ts:45-50`)
  copies `capabilities` but not other resolution fields — it gains the marker, so a later table edit cannot relabel a
  frozen window. (Because the value is excluded from `configHash`, the frozen slot is the only record of it.) Orca's
  frozen-slot schema gains the same optional field.
- **Version skew:** ccloop's table parse is strict (`src/agents/table.ts:39`); a ccloop that does not know
  `declaredContextWindow` refuses the whole table. Set it in `~/.orca/agents.json` only after Orca has repinned a ccloop
  that knows the field.
- Orca shows the window with a "declared / 声明值" mark where it shows `contextWindowTokens` (profiles, estimator
  compatibility, agents page) — Orca's own change.
- Out of the narrow ruling, recorded: a codex model not in the catalog still has `singleCallExecution: null`
  (`codex.ts:58-60`), so Orca's estimator still refuses it with `single-call-unavailable`; #70's estimator case is only
  half solved by this. Extending soft single calls to unlisted models is a separate decision for the human.

## 4. Tests (each red first with its named mutation, in a `git clone --local` copy)

1. Table: codex/omp accept a positive integer; `0`, negative, non-integer, string ⇒ `agents-table-invalid`; claude with
   the key ⇒ `agents-table-invalid`. Mutation: add the key to claude's extras ⇒ red.
2. Resolution (catalog injected through a new `deps.codexCatalog` for codex, alongside the existing `deps.probeCatalog`
   used for omp, `materialize.ts:96-103`; today any injected dep makes the codex `catalog` null, `:80-81`, which would
   read as "unreadable"): codex listed row ⇒ row window, no source; codex unlisted + declared ⇒ declared value
   and `contextWindowSource: "installation-declared"`; codex unlisted, no declared ⇒ null; codex catalog unreadable +
   declared ⇒ null, no source; omp row with null window + declared ⇒ declared; omp row with window + declared ⇒ row
   window. Mutations: use declared even when a row window exists (override case red); pass `declaredWindow` regardless of
   catalog readability (unreadable case red); omit the source marker (declared case red).
3. `configHash` is equal for an installation with and without `declaredContextWindow`. Mutation: stop excluding it (red).
4. ccloop `control capabilities` answer with the source validates against its own schema; without it, byte-identical
   to today. Mutation: leave the field out of `capabilitiesSchema` ⇒ the declared answer is refused (red).

## 5. Decisions (controller's calls, reversible)

1. Codex and omp only; claude refuses the key.
2. An unreadable catalog does not trigger the declared value; `materialize` decides via the `declaredWindow` argument.
3. The marker (`"installation-declared"`) lives on the resolution, not on the capability view.
4. Excluded from `configHash`.
5. No change to single-call availability for unlisted models (narrow ruling; surfaced in §3).

## Review round 1 (Orca session 9ec98639, 2026-10-21)

Independent review verdict: READY WITH FIXES. Applied: re-anchored to `71d650c`. **I11** `declaredContextWindow` excluded
from `agentConfigHash` + test 3. Minors: marker renamed `"installation-declared"`; Orca's `frozenSlotOf` must freeze it
(§3); `capabilities()` gets a `declaredWindow` argument so the descriptor no longer has to tell row-absent from
catalog-unreadable (§2.2).

## Review round 2 (Orca session 9ec98639, 2026-10-21)

Independent review verdict: READY. Minors applied: **M-12** Orca's frozen-slot schema gains the optional field.
**M-13** catalog injection named (`deps.codexCatalog`). **M-14** version-skew note. **M-15** `configHash` rationale
reworded. **M-10** test 4 mutation named.

## As-built (Orca session 9ec98639, 2026-10-21, track D-impl)

- Implemented as designed (`src/agents/{codex,omp,registry,types,materialize}.ts`, `src/control/command.ts`); criteria in
  `tests/agents/declaredContextWindow.test.ts` (tests 1-4; mutations M1-M6 each seen red in a built clone, restore diff 0/0).
- `deps.codexCatalog(installation) => Promise<CatalogRowV1[] | null>` (null = unreadable); like the other injections it
  marks the resolution as injected (no cached catalog/version read).
- omp's selector-only `probeModels` injection yields rows with `contextWindow: null`, so a declared window applies there too
  (test-only path; production omp always reads the full catalog).
- No existing criterion changed.
