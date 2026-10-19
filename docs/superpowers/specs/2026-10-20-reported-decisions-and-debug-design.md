# The execute phase may report the agent's decisions and a debug run's evidence; ccloop carries them to `control collect`

Orca session `3831d12f` (Claude Code interactive session, not an orca run), 2026-10-20. Observation anchors: ccloop
`main` at `70ea0a45`, Orca `main` at `3357d7be`. Written in this repository because the producer owns the wire
(Orca goal G1); §6 is the consumer's half, built in the Orca repository from this same document.

## 1. Problem

Orca's control path writes a run's ledger from "the decisions the agent reported" and a debug run's closing from "what
the debug agent reported": both are read from the top level of the collected run report — `reportedDecisionsOf` /
`reportedDebugOf` (Orca `src/control/reportedDecisions.ts:12-17, 35-41`), with `ExecutionReport.decisions?` and
`debug?` already declared (Orca `src/control/executionPort.ts:17-25`). Nothing produces them today. Measured on the
anchors:

- The executor prompt is one shared source for all three kinds (`src/runtime/claude/prompts.ts:34-64`; claude
  `claudeAgentAdapter.ts:300`, codex `codexAdapter.ts:132`, omp `ompAdapter.ts:49`) and says nothing about decisions.
- Every kind **rejects** an extra top-level key in the execute answer: codex and omp through the strict zod union
  (`src/runtime/codex/protocol.ts:25-28`, envelope `:155`, gate `src/runtime/executionNormalizer.ts:10-23`); codex
  additionally through its provider-strict `--output-schema` (`protocol.ts:45-53`: every property required,
  `additionalProperties:false`, optional fields as `anyOf` alternatives — 2×2 today); claude through the CLI-enforced
  `EXECUTION_SCHEMA` (`scripts/claude-phase-runner.mjs:29-43`, `additionalProperties:false`).
- `control collect` (`src/control/collect.ts:90-105`) answers exactly `{events, candidate, terminal, progress}`;
  nothing from `attempts/N/execution.json` reaches it. Orca's parser of that answer is `.strict()` (Orca
  `src/control/ccloopPort.ts:33-37`) and its mapper (`:242`) copies only those four.
- Orca's ledger has no notion of importance; its kinds (`src/ledger/types.ts`) have no home for naming or local
  implementation choices.

## 2. Rulings (verbatim, the human, 2026-10-20)

- What counts as a decision: 「平常用 agent 开发时 agent提供选项让人选的那些就算选择。agent做的重大方向、架构选择以及改变也算。orca项目因为是启动agent的 headless 模式并且在prompt中鼓励agent自行做review以及判断，所以这些选择不会上报到人这里卡住等人选择。但是人需要知道做过了哪些选择，在必要时要可以纠正。」
- Few but important: 「都怕。但是我更倾向于尽量少提供决定给人审，因为人的精力有限，但是这些决定都要很重要，orca这个系统就是要把人从AI coding 的必要流程里摘出来，但是人必须要能时候追认关键改动，做关键决策。」 (recorded in Orca `docs/handoff/goal.md` §1.3)
- Grading: 「命名、局部实现取舍 => 这些也可以算决定。其实决定可以分级。可以默认只显示高优先级或者说重要的决定。其他次要的决定如果人愿意看可以有机会看、有机会改就行。」
- `undo.how`: 「期望是这样，但是 undo.how 能执行不是必须的，或者说要慎用，因为 git revert 能用的前提是这个commit 刚刚合入，如果合入后又加入了大量其他改动相同文件的 commit，那仅仅靠 git revert 就很难做了，所以我才说要靠 debug task 去解决。」
- This round: do not wait for the human's review; self-review + independent review; problems — follow the
  controller's suggestion and report at the end. Existing criteria may change where necessary (session `3831d12f`).

## 3. Goals, non-goals, anti-goals

Goals:

- **G1** The execute phase of every kind may end with `decisions` (the agent's own choices, graded) and `debug` (only
  when the task asks for it) beside its existing fields, and is told what counts as a decision.
- **G2** ccloop carries both, unchanged in meaning, into the `control collect` answer of the run whose candidate it
  collects.
- **G3** Orca accepts them, writes the importance into the ledger, and its panel shows only important decisions by
  default, with minor ones one click away and correctable.

Non-goals: the reconcile path (`ccloop run`, read from `loop-state.json` — Orca `driverLanding.ts:508`; registered
gap); plan- and verify-phase decisions; changing how Orca validates or refuses an entry (`runLedger.ts`); a
`requestBoundProof` or any capability change; changing what a debug task's goal text says (Orca already writes it,
`debugPlan.ts:124-126`).

Anti-goals: a decision report that blocks or waits on the human; a run that fails because the agent reported a decision
badly (a bad entry is Orca's to refuse into "needs confirmation", never a run failure); any change to the bytes an
existing saved result normalizes to (saved-result recovery pins that hash).

## 4. Design — ccloop

### 4.1 The answer shape (one vocabulary, carried as strings)

Two optional top-level fields of the execute object, beside `changedFiles` etc. (in codex's envelope, inside
`result`):

```
decisions: [{ question, chose, alternatives: [{ option, why_not }], because,
              undo: { how, cost, blast_radius }, scope, kind, importance }]
debug: { choseInstead?, reproTests?: string[], reproCommand?, reproduction?: "not-expressible", reproductionReason? }
```

Field names and meanings are Orca's ledger's (`src/ledger/schema.ts` there) plus `importance`. **ccloop carries both
values opaquely, like `taskResult`** (review C1): a run never fails because of what is inside them. ccloop does not
check items, enum values or member types — the consumer validates and refuses a bad entry into its own "needs
confirmation" list, where the human can see it. ccloop does not learn Orca's vocabulary; the prompt names the values
(§4.2) as text. The one exception is codex's wire schema, where the provider demands a full strict shape.

Per kind:

- **codex wire schema** (provider-strict; added inside `executeWireJsonSchema`'s alternatives map,
  `protocol.ts:49-52`, never in `phaseJsonSchema("execute")`): both fields **required and nullable** —
  `decisions: anyOf[array of strict items, null]`, `debug: anyOf[strict object whose members are each required and
  nullable, null]` — expressed with `anyOf` (not `type: [..,"null"]`, which the strictness checker
  `strictWireSchema.test.ts:10` would skip), so the 2×2 alternatives stay 2×2. Precedent for nullable members:
  verify's `failingCommand` (`protocol.ts:38`). Decision items are strict objects, every member required (strings;
  `alternatives` an array of strict `{option, why_not}`; `undo` strict `{how, cost, blast_radius}`).
- **codex / omp zod**: `executionFields` gains `decisions` and `debug` as `unknown().optional()` (opaque).
  They are **not** added to the normalizer's answer-identifying key list (`executionNormalizer.ts:11`).
- **claude `EXECUTION_SCHEMA`**: two optional properties with an empty schema `{}` (any JSON), not in `required` — so
  the CLI's structured-output check cannot fail a run on them.
- **one shared "unreported" step for all kinds** (applied to the codex/omp normalized execution and to the claude
  adapter's parsed object): a `null` `decisions` or `debug` is removed; inside an object `debug`, `null` members are
  removed, and a `debug` left empty (`{}`) is removed. Keys are deleted, never set to `undefined`. So an answer that
  reports nothing (codex's `decisions: null`/`[]`-less, `debug` all-null) normalizes to the same bytes as today, and
  the saved-result hash of every existing archive is unchanged. `decisions: []` is kept.
- **size bound** like `taskResult`: each of the two values at most 65536 bytes of UTF-8 JSON; an over-limit value is
  removed (the run continues; registered — the consumer then sees no report).
- `phaseJsonSchema("execute")` (the legacy business schema that saved-result recovery compares archives against,
  `src/control/savedResultRecovery.ts:261-266`) **does not change**.
- A final that today fails *only* because it carried one of these keys would now normalize: its format-failure capsule
  answers `saved-result-normalizer-provenance-unavailable` on recovery (`savedResultRecovery.ts:221-224`). Registered,
  no special case (no such capsule can exist: no prompt ever asked for these keys).

### 4.2 The executor prompt (G1)

New lines go where the prompt's own rule allows (after the second line, or last before `FINAL_MESSAGE_LINE` —
`prompts.ts:12-13`; every existing line byte-for-byte). Content, in substance (the builder writes the final English):

1. "Also report the decisions you made in this attempt as `decisions`. A decision is (a) a question you would have
   stopped to ask the human in an interactive session, with options, or (b) a direction, architecture or interface
   choice or change. Do not stop to ask: choose, continue, and report it."
2. "Grade each: `importance: "major"` for (a) and (b); `"minor"` for naming and local implementation trade-offs worth
   recording. Report few, important decisions; omit what anyone would have done the same way. No decisions: omit the
   field or give `[]`." (Codex's own suffix, `codexAdapter.ts:132`, adds that its schema needs `null` for an absent
   value — the shared prompt does not mention `null`.)
3. "`scope` is one of file, task, repo, cross-repo; `kind` is one of dependency, interface, scheduling, abandon,
   criteria, boundary, implementation (`implementation`: naming and local implementation choices)." (`reconcile` is
   left out on purpose: only Orca's own code writes it.)
4. "`undo.how` names what to change back — the files or fields (for example `restore the retry loop in src/x.ts`), or a
   command when one applies; `git revert` only fits right after the change lands, so do not rely on it."
5. "Report `debug` only when the task's goal asks for it." (The debug goal text is Orca's.)

The planner and verifier prompts do not change. `buildVerifierPrompt` excludes `decisions` and `debug` from the
execution it shows, as it excludes `taskResult` (`prompts.ts:69-71`) — supplemental reporting, not execution
evidence — so the verifier prompt of an answer is unchanged by them.

### 4.3 Carrying them to `control collect` (G2)

- The adapters already persist the whole normalized execution to `attempts/N/execution.json`
  (`src/persistence/fileStore.ts:1995-2004`); nothing changes there.
- `collectExecution` adds `decisions` and `debug` as top-level keys **when a candidate is collected and the
  candidate's kept copy of its attempt's `execution.json` has them**; otherwise the keys are absent, so every existing
  answer is byte-identical. `CandidateV1` does not record its attempt; it is built from `runState.currentAttempt`
  and keeps a content-addressed copy of `attempts/N/execution.json` in `candidate.artifacts` (`handoff.ts:317-331`)
  — collect reads that kept copy, not the live attempt directory. A candidate whose attempt never entered execute keeps
  no execution file (`handoff.ts:268-290`) and answers without them.
- Continuations (review A3): a token-allowance continuation passes the predecessor's execution through unchanged
  (`materialize.ts:186` → `runLoop.ts:1520-1523`), so the successor run reports the predecessor's decisions — which is
  what lands, since Orca writes the ledger from the landing run's report (`driverLanding.ts:146-148`). The settled,
  unlanded predecessor may still list them in Orca's "unlanded" view (a duplicate there; registered). After a plain
  handoff continuation the predecessor's decisions do not land (registered gap, next round).
- Protocols 3 and 4 both carry them (they are additive to the answer, not to the frozen `terminal` projection).
- Every other place keeps what it does today (task-result manifest, handoff artifacts, allowance continuation's
  passthrough read).

## 5. Design — what ccloop's change requires of tests

The change is additive: the existing shape criteria (`tests/runtime/executionNormalizer.test.ts:13` — `extra: 1`
must still be refused; `tests/runtime/codex/strictWireSchema.test.ts:22-38`; `tests/runtime/claude/taskResultSchema.test.ts:28-34`;
`tests/control/savedResultEvidence.test.ts:104-105`; `tests/runtime/claude/phasePrompts.test.ts`) are expected to stay
green untouched, with new tests beside them. If one does need a change, it falls under the session grant (human,
session `3831d12f`: 「这次批准改写所有必要的判据」, which the human gave for every repository this round) and is
logged `file:line old→new why`. The strictness checker is extended if needed so an `anyOf` member is checked too. The
fake CLIs (`tests/fixtures/fake-codex.mjs`, `fake-claude-cli.mjs`, `fake-omp.mjs`) gain modes that report decisions;
their defaults and argument conventions stay (Orca's gate depends on them, ccloop handoff).

## 6. Design — Orca (the consumer)

Must land in Orca before the repin to a ccloop with §4: Orca's collect parser and ledger schema are strict today, so
a new ccloop answer, or an entry with `importance`, would be refused.

- **Collect parser**: `collectionSchema` / `collectionV4Schema` (`src/control/ccloopPort.ts:36-37`) accept optional
  top-level `decisions` and `debug` (unknown); the mapper (`:242`) copies them into `ExecutionReport`. Validation stays
  where it is (`reportedDecisions.ts`, `runLedger.ts`).
- **Ledger**: `decisionEventSchema` gains optional `importance: "major" | "minor"`; `DECISION_KINDS` gains
  `implementation`. Every table keyed by kind classifies it: `KIND_TIER.implementation = "low"`
  (`src/metrics/highTier.ts`), `KIND_RANK.implementation = { order: 7, level: 3 }` (`web/src/kindRank.ts`; its
  "every decision kind is high-tier" comment gets a dated correction), en/zh enum copy, and the web's hand-written
  `DecisionKind` copy (`web/src/types.ts:19-26`) — plus a new parity test between the server's `DECISION_KINDS` and
  the web's list so the next kind cannot drift. A row without `importance` (every existing row) reads as major;
  Orca's code-authored rows (`reconcileDecision`) write `importance: "major"`. The ledger is append-only; old lines stay
  valid. Known red criteria to update under the grant: `tests/ledger/validateLine.test.ts:95-103` (seven kinds),
  `tests/fixtures/metrics/golden.json` (gains an `implementation` row, tier low; byte-compared by
  `tests/metrics/cli.test.ts:37`), `web/tests/i18nPseudo.test.tsx:361` (enum value count), and any by-kind metric
  fixture (`KIND_ORDER` is `DECISION_KINDS`).
  - This supersedes, for agent-reported decisions, A′'s "file-scoped naming decisions are never reported" (quoted in
    `src/metrics/highTier.ts`'s comment): the human ruled they may be reported as minor. The high-tier metric itself
    is unchanged (`implementation` is low).
- **Carrying importance to the panel**: Decisions page rows go `DecisionObservation` (`src/metrics/types.ts:42-49`) →
  `LIST_FIELDS` (`src/panel/listProjection.ts:24-31`, parity with `WEB_LIST_FIELDS`, `webParity.test.ts:115`) — both
  gain `importance` (resolved: absent ⇒ `major`). The group view's three lists (`src/panel/groupDecisions.ts:79,
  83-86, 89-93`; strict `groupDecisionsViewSchema`, `src/control/webProtocol.ts:1843+`) carry it the same way.
- **Panel behaviour**: every decision list — the Decisions page and all three group-view lists (written, pending,
  unlanded) — shows major entries by default and a "show N minor" control that reveals the rest; minor rows open and
  are correctable exactly like major ones. A pending entry's importance is read from its raw entry; absent or not
  exactly `"minor"` ⇒ major (a refused entry with a bad grade is never hidden). The group's needs-human badge
  (`pendingCount`, `groupDecisions.ts:101`, `ControlGroupView.tsx:343`) counts only major pending entries; minor
  pending entries stay confirmable inside the revealed list (goal.md §1.3: minor ones must not demand attention).
  en + zh copy.
- **Contract test** (control-run-decisions plan Task 12): needs a ccloop pin with §4 — next round, after the human
  pushes ccloop.

## 7. Criteria (each a command with an exit code; every new branch gets a named mutation seen red)

ccloop (`./node_modules/.bin/vitest run <files>`, then `npm run typecheck`, `npm run build`):

1. Per kind (claude, codex, omp), a fake answer with `decisions` (one major, one minor) and `debug` is persisted in
   `attempts/N/execution.json` with the same values. For claude the test also asserts the `--json-schema` that was
   sent carries the two optional `{}` properties (the fake CLI does not validate answers). Mutation per kind: drop the
   field from that kind's schema ⇒ red.
2. A malformed value (`decisions: "x"`, an item missing members) does **not** fail an omp or claude run and reaches
   `execution.json` as given (C1); mutation: make the zod field strict ⇒ red.
3. "Reported nothing": codex's `decisions: null, debug: {all members null}` and claude's `decisions: null` normalize to
   bytes equal to the same answer without the keys; `decisions: []` is kept. Mutations: stop dropping nulls; stop
   dropping an empty `debug` ⇒ red.
4. Over-limit (> 65536 bytes) `decisions` is removed and the run succeeds.
5. Codex wire schema: every object node strict, including `anyOf` members; still 2×2 alternatives; `decisions` and
   `debug` required in each.
6. `extra: 1` is still refused by the normalizer.
7. `control collect` of a run whose candidate reported decisions answers them at the top level; of a run that reported
   none answers exactly the four keys; with two attempts reporting different decisions, the candidate's attempt wins
   (mutation: read the other attempt ⇒ red).
8. A token-allowance continuation's collect reports the predecessor's decisions.
9. The verifier prompt of an execution with decisions is byte-identical to the one without (mutation: stop excluding ⇒
   red); the executor prompt contains the new lines (positive assertion on their content) and every existing line is
   unchanged.
10. Saved-result legacy fixtures (`tests/fixtures/saved-result-legacy*`) still load, hash-equal.
11. Real CLI through a fake: `ccloop control collect` on a fake-codex run in a decisions mode returns them.

Orca (`npx vitest run <files>`, `npm run typecheck`, web tsc, the web tests touched):

12. The collect parser accepts and passes both fields; a report without them parses as before; mutation: mapper drops
    `decisions` ⇒ red.
13. A ledger line with `importance` validates; an unknown importance is rejected; `implementation` is a valid kind and
    classified in every kind-keyed table; server/web `DecisionKind` parity holds (mutation: drop it from the web list ⇒
    red).
14. `writeRunLedger` with a reported minor entry writes a line carrying `importance: "minor"`; an entry without it
    writes no `importance` and reads as major.
15. Panel API: Decisions page rows and all three group-view lists carry `importance`; `pendingCount` counts only major
    (mutation: count all ⇒ red).
16. Web: with one major and two minor decisions, each list shows one and "show 2 minor"; revealing shows three; a
    pending entry with an invalid grade shows by default; en and zh have no raw keys.

No full gate (Orca and ccloop rulings: targeted runs only).

## 8. Left to the builder

Exact prompt wording within §4.2's substance; file layout of new tests; the panel control's look within
`web/DESIGN.md`; how the shared "unreported" step is placed in each adapter.

## 9. Review record

Builder check + independent review (subagent of session `3831d12f`, 2026-10-20) found: C1 strict items would fail omp
and claude runs on a malformed decision (⇒ opaque carriage, §4.1); codex-only `null` wording in the shared prompt and
an always-present empty `debug` (⇒ codex suffix, empty `debug` dropped); continuations (⇒ §4.3); `CandidateV1` has no
attempt (⇒ kept artifact copy); claude's fake never validates answers (⇒ criterion 1 asserts the sent schema); `type:
[..,"null"]` would dodge the strictness checker (⇒ `anyOf`); Orca breakages not named (⇒ §6 list); the importance path
to the panel and the third group list (⇒ §6); no criterion that the ledger line carries `importance` (⇒ 14). All
folded in by the controller under the human's "follow the controller's suggestion" for this round.

## 10. Correction (as built, Orca session `3831d12f`, 2026-10-20)

Sections above are kept verbatim. As built:

- **Codex's null line** is not a codex suffix after the envelope line (that would break
  `tests/runtime/codex/finalExtraction.test.ts:185-188`, which pins the last two lines); it is inserted last before
  `FINAL_MESSAGE_LINE` through `buildExecutorPrompt(ctx, { schemaNeedsNull: true })`, used only by codex.
- **Opacity in the answer scanner** (review I1): under an established execute node, `decisions` and `debug` are opaque
  subtrees like `taskResult` (`OPAQUE_REPORT_KEYS`, `src/runtime/codex/protocol.ts`) — an agent's decision or debug
  object carrying a key that names an answer field (`result`, `changedFiles`, …) no longer makes a second candidate and
  fails an omp run. Criterion: `tests/runtime/reportedDecisions.test.ts` "is opaque to the answer scanner" (red before
  the change).
- **Collect** finds the candidate's kept copy by the content hash of the live `attempts/<currentAttempt>/execution.json`
  among `candidate.artifacts` (artifacts carry no labels); no match ⇒ the keys are absent. Each poll after a candidate
  exists re-reads and hashes that file and reads the kept copy (up to twice the file size per poll), and a read error
  other than ENOENT/non-JSON (non-regular file, evidence hash mismatch) fails the collect. Registered, accepted.
- **Task-result manifest**: its `executionRef` core now includes `decisions`/`debug` when an answer reports them
  (answers that report nothing are byte-identical). §4.3's "keeps what it does today" is corrected to this.
