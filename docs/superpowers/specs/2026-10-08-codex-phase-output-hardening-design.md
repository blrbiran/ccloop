# Codex phase output hardening — design

- Date: 2026-10-08
- Author: Orca development session `e34dc963` (Claude), working in ccloop at the human's explicit permission ("允许", 2026-10-08)
- Branch: `fix/codex-planner-output` (worktree `/Users/biran/code/skills/loop/ccloop-planner`), based on ccloop `main`
- Consumer: Orca re-pins ccloop after the human pushes this branch's merge

## 1. Problem

A human ran an Orca `investigate` task on codex backed by a third-party OpenAI-compatible model. The plan phase failed
with `codex-result-invalid`. The codex evidence showed the model:

1. tried to carry out the whole task during the plan phase, calling `apply_patch`, which the `read-only` sandbox
   rejected (`patch rejected: writing is blocked by read-only sandbox`);
2. ended with Markdown prose that contained the plan JSON, instead of the JSON object alone.

`decodeCodexResult` (`src/runtime/codex/protocol.ts`) does `JSON.parse(final)` on the whole final message. Any
surrounding text fails it, the error escapes the plan call, and `runLoop` transitions the run to the terminal state
`failed` on the first attempt (no retry budget for invalid output).

Two root causes, both in ccloop:

- **R1 — the prompts never say what a phase must not do.** `buildPlannerPrompt` (`src/runtime/claude/prompts.ts`)
  says only `Return JSON only.` and `Plan one isolated L2 attempt…`. It never says the phase is read-only, never says
  the work happens later, and passes `contract.context.constraints` under a bare `Constraints:` heading. Orca's
  `investigate` plan contributes the constraint "Investigate only; write the findings to the report file and change
  nothing else.", which, read at plan time, is an instruction to write the report now. The verifier prompt has the
  same gap (it must not edit files either).
- **R2 — the decoder treats "JSON plus decoration" exactly like garbage.** `--output-schema` is passed to codex, but a
  provider that does not enforce JSON-schema output lets the model wrap its object in a fence or prose. The object is
  there and would pass the strict schema; ccloop throws it away.

Claude is not affected by R2: `scripts/claude-phase-runner.mjs` gets structured output from claude itself. R1's prompt
text is shared by both adapters (`codexAdapter.ts` imports the claude prompt builders).

## 2. Non-goals

- No automatic retry of a phase on invalid output. (Orca's human ruling, 2026-10-08: prompt + tolerant extraction
  first; retry only if failures continue.)
- No change to the phase JSON schemas, the zod schemas, usage accounting, or the event decoding in
  `decodeCodexResult` (completion, usage, conflicting completions keep every current refusal).
- No change to how claude output is parsed.

## 3. Design

### 3.1 Prompts (R1)

The three builders keep every existing line **byte-for-byte and in the same order**. Test fakes
(`tests/fixtures/fake-codex.mjs`, `tests/fixtures/fake-claude-cli.mjs`) find the phase and task with multiline
anchors on `Plan one isolated L2 attempt for task …`, `Execute one isolated attempt for task …` and
`Verify task …`, and several tests build prompts that begin with `Return JSON only.\n<that line>`. New text is only
**inserted after the second line** or **appended at the end**, and the one heading that changes (`Constraints:`) is
not matched by any fake (verified by grep at design time; the plan re-verifies).

Planner, inserted after the `Plan one isolated…` line:

```
This is the planning phase only. The workspace is read-only: do not create, edit or delete files, do not run apply_patch, and do not carry out the task. A later execute phase does the work this plan describes.
```

Planner, heading change: `Constraints:` → `Constraints (they bind the execute phase; plan for them, do not act on them now):`

Verifier, inserted after the `Verify task …` line:

```
This is the verify phase. Do not create, edit or delete files; run commands only to check the attempt.
```

All three builders, appended as the last line:

```
Your final message must be exactly one JSON object: no Markdown code fence, no text before or after it.
```

The executor keeps `Constraints:` unchanged (they are its own constraints). For codex, `CodexAdapter.execute` appends
its existing "Wrap the complete or partial result in a single object with the sole key result…" line after the
builder's output, so that line, not the final-message line, is last; the two do not conflict (the envelope is the one
JSON object).

### 3.2 Schema-aware extraction of the final object (R2)

Extraction must never let decoration change **which** answer is accepted. In particular a verify answer must never
flip from rejection to approval because the model also printed a template or example. So extraction is driven by the
phase schema and accepts only an **unambiguous** schema-valid object.

New pure function in `src/runtime/codex/protocol.ts`:

```ts
export type FinalExtraction =
  | { method: "whole"; value: unknown }
  | { method: "candidate"; value: unknown; candidates: number; valid: number }
  | { method: "none"; candidates: number; valid: number };
export function extractFinalObject(final: string, accepts: (value: unknown) => boolean): FinalExtraction;
```

`accepts` is the phase's strict acceptance test: for plan and verify, `schemas[phase].safeParse(v).success`; for
execute, the strict `{result: …}` envelope **and** the execution union on its `result`.

Algorithm:

1. **whole** — if `JSON.parse(final)` succeeds (no trimming beyond what `JSON.parse` already tolerates), return
   `{method:"whole", value}` whatever the value is. Acceptance is then decided exactly as today (a non-object or
   schema-invalid whole answer still fails with today's error), so every answer accepted today is accepted identically.
2. **candidates** — otherwise collect candidate texts in one left-to-right pass:
   - every fenced block: a line starting with three backticks, optional info string, up to the next line starting with
     three backticks; the body is a candidate whatever the info string (`json`, `JSON`, `jsonc`, none, `bash`…). An
     unclosed fence is not a block (its text is still scanned for spans);
   - every top-level balanced object span, found by a brace matcher over the whole text: depth counts `{` and `}`;
     string state (`"…"` with `\` escapes) is tracked **only while depth ≥ 1**, so a stray quote in prose cannot hide
     an object; a `}` at depth 0 is ignored; a span opens at a `{` at depth 0 and closes when depth returns to 0. An
     unclosed `{` ends the scan of spans (no span from it). An object nested in an array (`[{…}]`) has brace depth 0 at
     its `{` and is a candidate; the array itself is not.
   Each candidate text is `JSON.parse`d once; parse failures and non-objects are dropped. Distinct values are compared by
   canonical `JSON.stringify` of the parsed value, so the same object repeated (a fence and its own span) counts once.
3. Keep the candidates that `accepts`. If **exactly one distinct** value remains, return
   `{method:"candidate", value, …}`; otherwise (zero, or two or more different schema-valid objects) return
   `{method:"none", …}`.
4. The adapter decodes `none` exactly as today: plan and verify pass the original `final` to `decodeCodexResult`
   (`codex-result-invalid`); execute passes the original `final` to today's envelope parse (today's error). So `none`
   changes no error text.

Two schema-valid answers in one message are refused rather than guessed. A prose example that is not schema-valid
(`{"a":1}`, a partial template) is ignored, so "prose with an example, then the real answer" is accepted.

**Complexity:** one linear pass for fences and spans (no restart from every `{`); each candidate parsed once; total
parse work is bounded by the text length times nesting of fences (a fence's span is also scanned once by the brace
pass). `final` is capped at 16 MiB by `runCodexPhase`. A criterion runs a several-megabyte adversarial input
(many unbalanced `{` and quotes) under a time bound.

**Call sites** (both in `CodexAdapter.phase`, `src/runtime/codex/codexAdapter.ts`): extraction runs first; for
`whole` and `none` the original text goes to today's code path unchanged; for `candidate` the adapter passes
`JSON.stringify(value)` (plan/verify) or the envelope's `result` (execute) into the same decode as today, which still
applies the strict schema and the usage checks.

**Evidence (fail loud):** for `candidate` and for `none` with at least one candidate, the adapter writes
`final-extraction.json` into the phase evidence directory **before** decoding:
`{"method", "candidates", "valid", "originalBytes"}`, where `originalBytes` is the UTF-8 byte length of `final`
(mode 0600). For `whole`, and for `none` with zero candidates, no file is written, so evidence for a compliant model
is byte-identical to today. A write failure is treated like any other decode failure (it is inside the existing
`try`, so it produces `decode-error.txt` and rethrows). A tolerated answer that the decode then refuses leaves both
files.

### 3.3 What stays the same

- `decodeCodexResult`'s event, usage and schema checks; every existing refusal code.
- `phaseJsonSchema` and `--output-schema` (the provider may still enforce it).
- Claude adapter behaviour; claude only sees the new prompt lines.

## 4. Testing

No existing criterion changes (ccloop Rule 15): the existing refusals in `tests/runtime/codex/protocol.test.ts` stay
as written and must stay green. New criteria only.

| Criterion | Must accept (the single schema-valid object) | Must reject (`none`, today's error) |
|---|---|---|
| plan extraction | whole object; one ```` ```json ```` fence after prose; one ```` ```JSON ```` fence; prose + object at end; prose quoting `{"a":1}` then the real object; object with `}` and `\"` inside a string; prose with a stray `"` before the object; `[{…valid…}]` | `oops`; `[]`; `null` (whole, not an object); two **different** valid plans (fenced or bare, either order); only an unclosed `{` then text; a valid plan with an extra key |
| verify safety | rejection answer after a fenced non-schema example | a fenced **schema-valid approval template** plus the real rejection ⇒ `none` (never approval) |
| execute | prose + `{"result": complete}`; prose + `{"result": partial}` | two different envelopes; envelope with an extra key |
| evidence | `final-extraction.json` for `candidate` and for `none` with candidates; `originalBytes` counts UTF-8 bytes of a non-ASCII answer | no file for `whole`; no file for `none` with zero candidates |
| performance | 4 MiB of `{"` noise followed by a valid plan completes under 2 s | — |
| prompts | planner has the read-only line, the relabelled heading, the final-message line; verifier has its no-edit line and the final-message line; executor keeps bare `Constraints:` and has the final-message line | first two lines of each prompt unchanged |

Mutations (each deletes one new branch and must be seen red; run in a `git clone --local` copy under the session
scratchpad after `npm run build`):

- M1 whole branch removed (every answer goes through candidates) ⇒ the "no file for `whole`" row red.
- M2 fence collection removed ⇒ the fenced-only samples red.
- M3 ambiguity check removed (take the last valid) ⇒ the two-valid-plans and approval-template rows red.
- M4 string state removed from the brace matcher ⇒ the `}`-in-string row red.
- M5 `\"` escape handling removed ⇒ the escaped-quote row red.
- M6 string state tracked at depth 0 ⇒ the stray-quote row red.
- M7 schema filter removed (accept any parsed object) ⇒ the `{"a":1}`-then-real row red (two candidates).
- M8 evidence write removed ⇒ evidence-present rows red; M9 evidence written unconditionally ⇒ evidence-absent rows red.
- M10 extraction bypassed in execute ⇒ the execute rows red.
- M11–M14 each new prompt line / heading removed in turn ⇒ the matching prompt row red; M15 a new line inserted
  before line 2 ⇒ the first-two-lines guard red.

Gate: `vitest run` through `scripts/check-known-reds.mjs` RC 0, `npm run typecheck` RC 0, `npm run build` RC 0.

## 5. Orca follow-up (not in this repo)

After the human pushes this change, Orca re-pins ccloop (`npm install github:blrbiran/ccloop#<sha>`,
`node scripts/pin-ccloop.mjs` checks). Orca's own handling of `codex-result-invalid` (a human-readable failure
explanation and the `retry-task` button) is in Orca's spec `2026-10-08-issue-fixes-design.md`.

## 6. Review record

Independent review (subagent, 2026-10-08, same session) of the first version of this spec. Changes made in place
(the spec was unpublished):
- C1 (accepted): rule order "one fence, else last bare object" could pick a schema-valid template over the real answer,
  turning a verify rejection into approval ⇒ §3.2 replaced by schema-aware unique-candidate extraction.
- I1 (accepted): fence ambiguity and fence definition were unspecified ⇒ defined; ambiguity is now decided by schema
  validity, not by fence count.
- I2 (accepted): brace matcher details (string state only at depth ≥ 1, stray `}`, unclosed `{`, objects inside arrays)
  ⇒ specified and tested.
- I3 (accepted): linear-pass requirement and a large-input criterion added.
- I4 (accepted): evidence rule made consistent; write-before-decode, write failure, UTF-8 byte count specified.
- I5 (accepted): mutation list completed (M1–M15).
- M1 (accepted): `none` now passes the original text to today's path in every phase, so error text is unchanged.
- M2 (accepted): noted the codex execute envelope line after the final-message line.
- M6 (accepted): rule citation corrected to ccloop's own Rule 9 / Rule 15 / Rule 17.
