# Every kind can report `debug.located`; codex's wire schema gains it

Orca session `b37f7ce9` (a subagent of that Claude Code session; design only, not implemented), 2026-10-22.
Observation anchors: ccloop `main` at `d02b9d2`; Orca branch `feat/flow-engine` at `92bc370b` (`feat(corrections):
repository-only and bare-run targets`, the commit that reads `debug.located`; branch tip `014ce4fb` only repins ccloop to
`d02b9d2`). Every line number below was measured with `grep -n` at those commits. This extends
`2026-10-20-reported-decisions-and-debug-design.md` (its §10 as-built takes precedence over its §4); nothing there is
edited.

## 1. Problem

Orca's coarse corrections (flow engine spec `2026-10-22-flow-engine-design.md` §13.2–§13.4, W-COR) ask the debug agent
to report, before any change, where the person's one sentence applies:
`debug.located = {groupId?, runId?, decisionId?, paths[], because}`. Orca reads it from the collected run report's
top-level `debug` and cites a located decision in the closing row (`src/control/debugClosing.ts:87-89`,
`src/corrections/derive.ts:172-189` at `92bc370b`). Measured on ccloop `d02b9d2`:

- **codex cannot report it.** The wire schema's `debug` is a strict object with exactly five members
  (`src/runtime/codex/protocol.ts:59-60`: `choseInstead`, `reproTests`, `reproCommand`, `reproduction`,
  `reproductionReason`; `object()` at `:39` sets `additionalProperties:false`). The provider refuses any `located`.
- **claude and omp can already carry it**, opaquely: claude's `EXECUTION_SCHEMA` gives `debug: {}`
  (`scripts/claude-phase-runner.mjs:40`); codex/omp zod has `debug: z.unknown().optional()` (`protocol.ts:29`); the
  answer scanner treats `debug` as opaque (`OPAQUE_REPORT_KEYS`, `protocol.ts:189`); collect copies `debug` as is
  (`src/control/collect.ts:117-137`). What they lack is a prompt that names it: the shared executor line lists only the
  five members (`src/runtime/claude/prompts.ts:142`). Orca's own goal text already names the full shape
  (`src/control/debugPlan.ts:147-152` at `92bc370b`), and only on a coarse correction.
- **a codex null would break Orca.** The shared unreported step (`src/runtime/reportedDecisions.ts:18-29`) removes
  `null` members of `debug` one level deep only. Codex's strict schema can express an absent `groupId` only as `null`;
  Orca's `located` is `.strict()` with `z.string().min(1).optional()` ids (`src/control/reportedDecisions.ts:31-34` at
  `92bc370b`), so `located.groupId: null` makes the **whole** `debug` malformed — and then `readDebugResult` answers `{}`
  (`debugClosing.ts:27-30`), losing `choseInstead`, `reproTests`, `reproCommand` too (closing ⇒ `chose-instead-missing`,
  `debugClosing.ts:70-72`).

## 2. The wire shape (Orca's, unchanged)

```
debug.located = { groupId?: string, runId?: string, decisionId?: string, paths: string[], because: string }
```

Exactly what Orca at `92bc370b` accepts: object, no other keys; each id a non-empty string when present; `paths` an
array (may be empty) of non-empty strings; `because` a non-empty string. "Cannot locate" is `paths: []`, no ids, and the
reason in `because` (Orca's goal text says so). **The shape is suitable; no change on either side is required for the
shape itself.** ccloop does not validate it (opaque, as for every `decisions`/`debug` content — 2026-10-20 §4.1); Orca
does.

How each kind expresses it:

| kind | what the agent may send | what reaches `execution.json` / collect |
|---|---|---|
| codex | `located` required and nullable; inside it every member required, ids nullable (§5) | nulls removed by the unreported step (§4.3) ⇒ Orca's shape |
| claude | any JSON under `debug` (CLI schema unchanged) | as sent, minus nulls inside `located` (§4.3) |
| omp | any JSON under `debug` (zod unchanged) | as sent, minus nulls inside `located` (§4.3) |

## 3. Bounds

No new bound (writer's call W2, reversible). `located` lives inside `debug`, whose whole value is already capped at
65536 bytes of UTF-8 JSON (`MAX_REPORTED_BYTES`, `reportedDecisions.ts:10`); an over-limit `debug` is removed and the
run continues (2026-10-20 §4.1, registered there). Orca's goal text restricts `located` to what its frozen window lists,
so ids are short; a path list long enough to matter is far under 64 KiB. Orca adds no bound either.

## 4. Changes in ccloop

### 4.1 codex wire schema (`src/runtime/codex/protocol.ts:59-60`) — the one required change

`debug`'s strict object gains a sixth member, last:

```
located: nullable(object({ groupId: nullable(string), runId: nullable(string), decisionId: nullable(string),
                           paths: array, because: string }))
```

with the file's existing `nullable` (`:54`, `anyOf[schema, {type:"null"}]`), `object` (`:39`), `string`/`array`
(`:37-38`). `phaseJsonSchema("execute")` (legacy business schema saved-result recovery compares against) does not change.

### 4.2 zod, claude CLI schema, scanner, persistence, collect, verifier — no change

`debug` stays `z.unknown().optional()` and `{}`; `OPAQUE_REPORT_KEYS` already covers it; `execution.json`, the
candidate's kept copy and collect carry `debug` whole; `buildVerifierPrompt` already deletes `debug`
(`prompts.ts:190-192`).

### 4.3 The shared unreported step (`src/runtime/reportedDecisions.ts:20-23`)

Generalized one level, without naming `located` (ccloop does not learn Orca's vocabulary): inside an object `debug`,
**for each member that is itself a plain object, its `null` members are removed, and a member left empty (`{}`) is
removed**; then, as today, `null` members of `debug` are removed and an empty `debug` is removed. Arrays are untouched.
Keys are deleted, never set to `undefined`.

### 4.4 Prompts — no change (writer's call W1, reversible)

The shared debug line (`prompts.ts:142`) and `CODEX_NULL_LINE` (`:145`) stay byte-for-byte. Reason: `located` is asked
for only by a coarse correction, and that goal text already names its exact shape and says "first"; the shared line
already defers to the goal ("Report debug only when the task's goal asks for it"). Adding `located` to the shared line
would put ~110 bytes in every executor prompt of every task and turn red three existing criteria (§6.2).
Strongest rebuttal: the shared line spells `debug` as an object listing five keys, which an agent may read as
exhaustive and drop `located`; for codex the null line says "null for each debug member", not for `located`'s ids.
Answer: the codex schema itself forces every `located` member, so a codex agent cannot drop `paths`/`because` or omit
an id (it must give a string or `null`, and §4.3 removes the `null`); for claude/omp the risk is real but only a real
run can measure it (Q2). **Fallback if Q2 shows agents dropping it:** append
`,"located"?:{"groupId"?:string,"runId"?:string,"decisionId"?:string,"paths":string[],"because":string}` to the shared
debug line and "and null for each located id you leave out" to `CODEX_NULL_LINE` — which needs the human to name the
§6.2 criteria first (ccloop CLAUDE.md Rule 15).

## 5. Codex strict schema stays 2×2-compatible

`located` is a member inside each alternative's `debug` object, not a new optional top-level field, so the four
alternatives (complete/partial × with/without `taskResult`, `executeWireJsonSchema`, `protocol.ts:63-71`) stay four;
`debug` stays required and nullable in each. `located` and its ids use `anyOf` nullability (never `type:[..,"null"]`),
so the strictness walker (`tests/runtime/codex/strictWireSchema.test.ts:7-19`, which descends `anyOf`, `properties`,
`items`) checks the new object node. Size, measured at `d02b9d2` with a throwaway tsx script that walks
`executeWireJsonSchema()` (object nodes: sum of property counts and deepest object level; envelope `result` not
included): 120 properties, object depth 3, 8259 bytes. After §4.1 (computed, not measured): +6 properties per
alternative ⇒ 144; depth unchanged (the new object sits at the depth of `undo`). Whether the real provider accepts it is
not measured (Q2).

## 6. Absent ⇒ bytes unchanged

- An answer whose `debug` has no plain-object member — every answer any ccloop ever asked for — normalizes to the same
  bytes as today, so saved-result hashes and the `saved-result-legacy*` fixtures are unchanged; codex's
  `debug: {…, located: null}` normalizes to the same bytes as the answer without `located`.
- Executor, planner and verifier prompts are byte-identical (§4.4): the `golden-2a2ae53/executor-prompt.txt` golden
  (`tests/runtime/claude/phasePrompts.test.ts:93`) stays green untouched. Argv goldens are untouched (the schema is a
  file, `schema.json`, whose path is normalized in `codex-execute.json`).
- `EXECUTION_NORMALIZER_VERSION` is not bumped (as in the 2026-10-20 round). Registered: a claude/omp archive whose
  `debug` had an object member holding `null` would normalize differently; none can exist (nothing asked for one).

### 6.2 Existing criteria

One existing criterion must change, and only with the human naming it (Rule 15; Q1):
`tests/runtime/codex/strictWireSchema.test.ts:64` — `expect(Object.keys(debug.properties)).toEqual([...five])` becomes
the same assertion with `"located"` appended (whole-line rewrite, stricter, not looser). `:65` (every member's last
`anyOf` is `{type:"null"}`) already holds for `located`. Under W1, `phasePrompts.test.ts:93`,
`reportedDecisionsPrompts.test.ts:58` (`BEFORE.length + 5`) and the `CODEX_NULL` constants in
`lastFailurePrompts.test.ts:14` / `priorFailuresPrompts.test.ts:14` are not touched.

## 7. New tests (each with the mutation that must be seen red)

New file `tests/runtime/debugLocated.test.ts` unless noted; fakes need no change — all three read
`<marker>.reported.json` (`fake-codex.mjs:187`, `fake-claude-cli.mjs:174`, `fake-omp.mjs:74`).

1. **codex wire**: in each of the 2×2 alternatives, `debug.anyOf[0].properties.located.anyOf` is `[strict object, null]`;
   its keys are exactly `groupId, runId, decisionId, paths, because`, all required; the three ids are `anyOf[string,
   null]`, `paths` `{type:"array",items:{type:"string"}}`, `because` `{type:"string"}`; the walker of
   `strictWireSchema.test.ts` passes. Mutations: drop `located` ⇒ red; make an id plain `string` ⇒ red; give `located`
   `type:["object","null"]` ⇒ red.
2. **unreported step** (unit, `dropUnreported`): `debug.located` with all three ids `null` ⇒ the ids are gone, `paths`
   and `because` kept; `debug.located: null` ⇒ bytes equal to the answer without it; `debug.located: {groupId: null}` ⇒
   `located` gone; `reproTests: [null]` (an array) ⇒ unchanged. Mutations: stop removing null members of object
   members ⇒ red; stop removing an emptied member ⇒ red; descend into arrays ⇒ red.
3. **per kind, end to end through the fakes** (claude, codex, omp): a `reported.json` whose `debug` is
   `{choseInstead, located: {decisionId, paths, because}}` (codex: plus `groupId: null, runId: null` and the four other
   members `null`) lands in `attempts/1/execution.json` as Orca's shape (no `null` anywhere under `debug`). For codex the
   answer also passes `normalizeExecutionFinal`. Mutation: revert §4.3 ⇒ the codex case red.
4. **collect** (`tests/control/reportedDecisionsCollect.test.ts`, new `it` only): a fake-codex run in `reported` mode
   with `located` answers `debug.located` at the top level exactly as in criterion 3; a run without it answers `debug`
   with no `located` key. Mutation: collect drops `debug` ⇒ red.
5. **prompts unchanged**: covered by the existing golden (`phasePrompts.test.ts:93`); no new test (W1).
6. **verifier blind**: an execution whose `debug` has `located` gives a verifier prompt byte-identical to the one
   without `debug`. Mutation: stop deleting `debug` in `buildVerifierPrompt` ⇒ red.

Run: `./node_modules/.bin/vitest run <these files> tests/runtime/codex/strictWireSchema.test.ts
tests/runtime/reportedDecisions.test.ts tests/runtime/claude/phasePrompts.test.ts`, then `npm run typecheck`,
`npm run build`; mutations in a `git clone --local` copy only (Rule 17).

## 8. Orca side (Orca CLAUDE.md Rule 16: Orca's rules stay in Orca; these land in Orca's own commits)

- **Required: none for the shape.** After ccloop lands this and the human pushes, Orca repins (its handoff's list of
  "Orca depends on ccloop" gains `debug.located`'s codex nullability, cleared by ccloop).
- **Recommended (Orca's writer's call, reversible, independent of ccloop):** parse `located` on its own in
  `reportedDebugOf` (`src/control/reportedDecisions.ts:41-47` at `92bc370b`) — a malformed `located` (an empty-string
  id, an extra key) reads as absent while the rest of `debug` is kept. Today it voids `choseInstead` and the
  reproduction fields with it (§1). Criterion: a debug report with a bad `located` and a good `choseInstead` closes with
  that `choseInstead`; mutation: parse the whole object again ⇒ red.
- **Contract test** (Orca): with the repinned ccloop, a fake-codex run whose `reported.json` carries
  `located: {groupId: null, runId: null, decisionId: "<id>", paths: [...], because}` collects, and
  `reportedDebugOf` answers `kind: "object"` with `located.decisionId` and no `groupId`.
- Registered, Orca's: flow engine spec §13.2 says an unlocatable correction fails `not-located`; at `92bc370b` nothing
  produces that failure (`git grep not-located` in `src` is empty) — the goal text only asks the agent to stop. ccloop
  has no part in it.

## 9. Writer's calls (all reversible)

- **W1** no prompt change (§4.4); fallback spelled out there.
- **W2** no new byte bound for `located` (§3).
- **W3** the unreported step generalizes "nulls inside an object member of `debug`" rather than naming `located`
  (§4.3), keeping ccloop vocabulary-free.
- **W4** `located` is appended last in codex's `debug` object (key order is visible only in `schema.json`).

## 10. Open questions (the human's)

- **Q1** Name `tests/runtime/codex/strictWireSchema.test.ts:64` for rewrite (append `"located"` to the expected key
  list). Without it §4.1 cannot land green (ccloop Rule 15: an implementer may not change an existing criterion).
- **Q2** One paid real run per kind on a coarse-correction goal (codex `gpt-6-luna`; claude; omp via the human's
  LiteLLM endpoint) to see that the provider accepts the nested nullable object and that agents report `located` without
  the shared prompt naming it (W1). Paid ⇒ the human decides whether and when.
