# The execute answer may carry `flow`, opaquely, like `decisions` and `debug`

Orca session `b37f7ce9` (an implementer subagent of that Claude Code session), 2026-10-22.
Observation anchors: ccloop `main` at `2fd2dff` (`feat(runtime): every kind can report debug.located; codex's wire schema
gains it`); Orca branch `feat/flow-engine` at `c979b3c8`. Every line number below was measured with `grep -n` at those
commits. This extends `2026-10-20-reported-decisions-and-debug-design.md` (its §10 as-built takes precedence over its §4)
and follows `2026-10-22-debug-located-design.md`; nothing there is edited.

## 1. Problem

Orca's flow engine (Orca spec `2026-10-22-flow-engine-design.md` §4.3, §5.2) has an agent in a flow step report, beside
`decisions` and `debug`, a top-level `flow` key: a request for a person (`needs`), choices a later `ask` step offers again
(`candidates`), and the remote id of a side effect it enacted (`effect`). Orca reads it only through `reportedFlowOf`
(Orca `src/control/reportedDecisions.ts:82-89` at `c979b3c8`), from the collected run report, and its child port passes
`needs` and `candidates` on (`src/flow/childPort.ts:146-148`, whose comment says "the pinned ccloop carries only
`decisions` and `debug`: absent until it does"). Measured on ccloop `2fd2dff`, no kind can deliver it:

- codex/omp zod execution shape is strict and has no `flow` (`src/runtime/codex/protocol.ts:29-31`) ⇒ an answer with
  `flow` is refused (`execution-format-invalid`); codex's strict wire schema has no `flow` either (`:54-64`).
- claude's CLI schema is `additionalProperties: false` without `flow` (`scripts/claude-phase-runner.mjs:29-46`).
- collect copies only `decisions` and `debug` (`src/control/collect.ts:117-137`), and the command's strict response schema
  knows only those two (`src/control/command.ts:206-208`).

## 2. Orca's shape (read, not changed)

`flowResultSchema` (Orca `src/control/reportedDecisions.ts:66-76`), `.strict()` at every level:

```
flow = { needs?:      {kind:"confirmation", what, payloadSummary} | {kind:"input", question, candidates: string[]},
         candidates?: Record<name /^[a-zA-Z][a-zA-Z0-9_]*$/, {items: string[1..3], recommended: int < items.length}>,
         effect?:     {remoteId, url?} }          (every string non-empty)
```

ccloop does not validate it (opaque, 2026-10-20 §4.1); Orca does, and a refused value reads `malformed`.

## 3. The codex wire shape — the minimal closed shape (writer's call F1, reversible)

The provider's strict mode needs every object closed (`additionalProperties: false`) and every property required. Orca's
`candidates` is a record keyed by template-chosen names — open keys — which no closed schema can express. So codex's wire
`flow` covers `needs` and `effect` and **not `candidates`**:

```
flow: nullable(object({
  needs:  {anyOf: [ object({kind: {type:"string", enum:["confirmation"]}, what: string, payloadSummary: string}),
                    object({kind: {type:"string", enum:["input"]}, question: string, candidates: array}),
                    {type: "null"} ]},
  effect: nullable(object({remoteId: string, url: nullable(string)})),
}))
```

with the file's `nullable`, `object`, `string`, `array` (`protocol.ts:39`, `:54`). `needs` is one flat `anyOf` whose last
member is `{type:"null"}` (as every other nullable member). `flow` is required and nullable in each of the 2×2
alternatives, after `debug`; still four alternatives. `phaseJsonSchema("execute")` does not change.

Strongest rebuttal: Orca reads `candidates`, so codex cannot serve §4.3 rule 4. The alternatives: (a) wire `candidates`
as `[{name, items, recommended}]` and have ccloop rewrite it into Orca's record — ccloop would learn Orca's vocabulary,
against W3 of the debug.located spec, and a bad name/duplicate would make Orca's whole `flow` malformed, losing `needs`;
(b) wire the array and leave it — Orca's strict reader would then refuse every codex `flow` that carries it, `needs`
included. Both are worse than omitting it. **What Orca must not rely on:** a codex agent reporting `flow.candidates`
(Orca's ask step then takes candidates from the model, flow spec §4.4); a codex string being non-empty, or `recommended`
indexing anything (ccloop forwards; Orca's parser decides). Fallback if codex candidates are needed later: Orca's reader
accepts the array form beside the record (Orca's change), then this wire gains it — a new spec.

| kind | what the agent may send under `flow` | what reaches `execution.json` / collect |
|---|---|---|
| codex | the closed shape above; `null` for what it does not report | nulls removed (§4.3) ⇒ Orca's shape |
| claude | any JSON (CLI schema gains `flow: {}`) | as sent, minus the nulls §4.3 removes |
| omp | any JSON (zod `z.unknown().optional()`) | as sent, minus the nulls §4.3 removes |

## 4. Changes in ccloop (each the `decisions`/`debug` precedent, one key more)

1. **zod** (`protocol.ts:29`): `executionFields` gains `flow: z.unknown().optional()`, last. Not an answer-identifying key.
2. **codex wire** (`protocol.ts:57-64`): `reported` gains `flow` (§3), last.
3. **unreported step** (`src/runtime/reportedDecisions.ts`): `REPORTED_FIELDS` gains `"flow"`; the debug-located rule
   (inside each plain-object member, its `null` members removed and a member left empty removed; then `null` members
   removed; an empty value removed; arrays untouched) applies to an object `flow` exactly as to an object `debug`
   (writer's call F3: codex can say "no url" only as `effect.url: null`, which Orca's `url?: string` refuses — voiding the
   whole `flow`). A `null` `flow` and a `flow` over 65536 bytes of UTF-8 JSON are removed (the shared bound, F4).
4. **scanner** (`protocol.ts:192`): `OPAQUE_REPORT_KEYS` gains `"flow"`, so a key inside `flow` never makes a second
   candidate.
5. **claude** (`scripts/claude-phase-runner.mjs:39-40`): `EXECUTION_SCHEMA` gains `flow: {}` after `debug`; the adapter
   already applies the shared step (`claudeAgentAdapter.ts:441`).
6. **types** (`src/runtime/types.ts:79-80`): `flow?: unknown`.
7. **collect** (`collect.ts:35-36`, `:117-137`): top-level `flow` from the candidate's kept copy, present iff that copy has
   it, after `debug`; **command** (`command.ts:206-208`): `flow: z.unknown().optional()` for protocols 3 and 4.
8. **verifier** (`src/runtime/claude/prompts.ts:190-192`): `buildVerifierPrompt` deletes `flow` as it deletes `debug`.

### 4.1 Prompts — no change (writer's call F2, reversible)

Orca's flow spec §4.3 says code appends a fixed, code-owned fragment to every `work`/`review` prompt that asks for
`flow`; only flow steps ask, so the shared executor prompt stays byte-for-byte (as W1 of the debug.located spec). Codex's
null line (`prompts.ts:145`) is not extended: its schema forces `flow` and allows `null`, and `{needs:null,effect:null}`
normalizes to absent. Rebuttal: a codex agent never told about `flow` may fill it with something. Answer: the closed shape
only admits Orca's two `needs` kinds and `effect`; a fill nobody asked for is visible to Orca as a real `needs` — Orca's
fragment, not ccloop, owns telling it when. Fallback: name `flow` in `CODEX_NULL_LINE`, which needs the human to name
`lastFailurePrompts.test.ts:14`, `priorFailuresPrompts.test.ts:14` and the executor-prompt golden first.

## 5. Absent ⇒ bytes unchanged

- An answer without `flow`, or with `flow: null`, or with codex's `{needs: null, effect: null}`, normalizes to the bytes
  of the same answer without the key: saved-result hashes and the `saved-result-legacy*` fixtures are unchanged;
  `EXECUTION_NORMALIZER_VERSION` is not bumped (F7; no archive can hold a `flow`, nothing accepted one).
- A collect answer of a run that reported no `flow` has exactly today's keys.
- Executor, planner, verifier prompts are byte-identical; codex and omp argv are byte-identical (codex's schema is a file
  whose path the goldens normalize).
- **claude's execute argv changes** (its `--json-schema` gains `"flow":{}` after `"debug":{}`) — unavoidable, since the
  CLI enforces `additionalProperties: false` (F6). Two existing criteria pin it (§6).

## 6. Existing criteria that change (round grant 「这次批准改写所有必要的判据」, Orca session `b37f7ce9`)

- `tests/runtime/claude/claudeSkillPluginDir.test.ts:32` — the execute golden schema string gains `"flow":{}` after
  `"debug":{}` (whole-line rewrite; every other byte and argv assertion stays exact).
- `tests/runtime/claude/claudeToolRules.test.ts:41` — `expect(got.argv).toEqual(want.argv)` compares against the
  2a2ae53 golden with exactly that one insertion in the execute `--json-schema` value (asserted to occur exactly once);
  the golden file itself (`tests/fixtures/toolRules/golden-2a2ae53/claude-execute.json`) is a captured oracle and is not
  edited. Plan and verify still compare unchanged.

`strictWireSchema.test.ts` needs no change (`arrayContaining(["decisions","debug"])` and the strictness walker already
cover a further member).

## 7. New criteria (each with the mutation that must be seen red)

New file `tests/runtime/flowAnswerKey.test.ts` unless noted.

1. **codex wire**: in each of the 2×2 alternatives, `flow` is required and equals exactly the §3 shape (one `toEqual`).
   Mutations: drop `flow` from `reported` ⇒ red; add `candidates` to it ⇒ red.
2. **unreported step**: `flow: null` and codex's `{needs: null, effect: null}` ⇒ bytes of the answer without `flow`;
   `effect.url: null` ⇒ `url` gone, `remoteId` kept; claude's record `candidates` kept as given; a `flow` over 65536
   bytes ⇒ removed, answer available. Mutations: `REPORTED_FIELDS` without `"flow"` ⇒ red; the inner-null rule applied
   to `debug` only ⇒ red.
3. **C1 / scanner**: `flow` as a string, and a `flow` carrying `changedFiles`, keep the answer available and are kept as
   given (direct and `result`-wrapped). Mutation: `OPAQUE_REPORT_KEYS` without `"flow"` ⇒ red. Mutation: zod without
   `flow` ⇒ red.
4. **per kind, end to end through the fakes** (codex, claude, omp; fakes unchanged — all read `<marker>.reported.json`):
   a reported `flow` lands in `attempts/1/execution.json` as Orca's shape (codex: with its nulls, which are gone).
   Mutation: claude schema without `flow: {}` ⇒ the claude case red (the fake does not validate, so this criterion
   asserts the sent `--json-schema` contains `"flow":{}`).
5. **collect** (`tests/control/reportedDecisionsCollect.test.ts`, new `describe` only): a fake-codex run's `flow` is
   answered at the top level after `debug`, through `runControlCommand` for protocols 3 and 4; a run without it has no
   `flow` key. Mutations: collect drops `flow` ⇒ red; the command schema without `flow` ⇒ red.
6. **verifier blind**: an execution with `flow` gives a verifier prompt byte-identical to one without. Mutation: stop
   deleting `flow` ⇒ red.

Mutations only in a built `git clone --local` copy (ccloop CLAUDE.md Rule 17).

## 8. Orca side (Orca's rules stay in Orca; its own commits)

- Required: repin after the human merges and pushes; Orca's handoff list "Orca depends on ccloop" gains collect's
  top-level `flow` (the collect parse is strict, so the repin must accept it in the same commit).
- Orca must not rely on codex `flow.candidates` (§3); if its fragment asks every kind for candidates, codex steps lose
  them silently — Orca should prefer model candidates for codex or record it.

## 9. Writer's calls (all reversible)

- **F1** codex wire omits `candidates` (§3). **F2** prompts unchanged (§4.1). **F3** the inner-null rule covers `flow`
  (§4.3). **F4** no new bound. **F5** `flow` is placed last after `debug` everywhere (zod, wire, claude schema,
  collect). **F6** claude's argv changes (§5). **F7** no normalizer version bump.

## 10. Open (the human's)

- **Q1** One paid real codex run (`gpt-6-luna`) to see the provider accepts the flat three-member `needs` `anyOf` inside
  a nullable object (not measured; codex quota exhausted until 2026-10-27). Claude/omp likewise unmeasured.
