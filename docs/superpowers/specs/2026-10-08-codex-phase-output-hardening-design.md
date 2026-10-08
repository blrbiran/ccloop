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

The executor keeps `Constraints:` unchanged (they are its own constraints).

### 3.2 Tolerant extraction of the final object (R2)

New pure function in `src/runtime/codex/protocol.ts`:

```ts
export type FinalExtraction = { text: string; method: "whole" | "fenced" | "last-object" | "none" };
export function extractFinalObject(final: string): FinalExtraction;
```

Rules, first match wins:

1. `whole` — `final.trim()` parses as a JSON **object** (not array, not null). Return the trimmed text.
2. `fenced` — the text contains **exactly one** fenced block (```` ```json ```` or bare ```` ``` ````) whose body
   parses as a JSON object. Return that body. Two or more fenced object blocks ⇒ ambiguous ⇒ fall through to rule 4
   (never pick one of several fences).
3. `last-object` — scan the text with a string-aware brace matcher (respects `"…"` and `\"` escapes) for top-level
   balanced `{…}` spans; take the **last** span that parses as a JSON object. The last span is chosen because models
   end with the answer after prose that may quote example objects.
4. `none` — return `final` unchanged, so the existing `JSON.parse` fails exactly as today with
   `codex-result-invalid`.

`extractFinalObject` only chooses **which text** to parse; the strict zod schema of the phase still decides
acceptance. An extracted object with an extra key, a missing key or a wrong type is refused as today.

Call sites (both in `CodexAdapter.phase`, `src/runtime/codex/codexAdapter.ts`):

- plan / verify: `decodeCodexResult(phase, events, extractFinalObject(outcome.final).text)`;
- execute: the `{result: …}` envelope is parsed from `extractFinalObject(outcome.final).text` before the existing
  `.strict()` unwrap.

**Fail loud, not silent:** when `method` is not `whole`, the adapter writes `final-extraction.json`
(`{"method": …, "originalBytes": <n>, "extractedBytes": <n>}`, mode 0600) into the phase evidence directory. A
tolerated answer is therefore always visible in evidence; an untouched answer leaves no new file (existing evidence
layouts stay byte-identical for compliant models).

### 3.3 What stays the same

- `decodeCodexResult`'s event, usage and schema checks; every existing refusal code.
- `phaseJsonSchema` and `--output-schema` (the provider may still enforce it).
- Claude adapter behaviour; claude only sees the new prompt lines.

## 4. Testing

Every new branch gets a mutation that deletes **it** and is seen red (CLAUDE.md Rule 9 of Orca; ccloop iron rule 2).

| Criterion | Must accept | Must reject (stays `codex-result-invalid` or schema error) |
|---|---|---|
| `extractFinalObject` | whole object; object with surrounding whitespace; one ```` ```json ```` fence after prose; prose + object at the end; prose quoting `{"a":1}` then the real object last; object whose string value contains `}` and `\"` | `oops`; `[]`; `null`; two fenced objects with no trailing object; unbalanced braces only; extracted object with an extra key (schema refuses) |
| adapter evidence | `final-extraction.json` written for `fenced` and `last-object` | not written for `whole` |
| prompts | planner contains the read-only line, the re-labelled constraints heading and the final-message line; verifier contains its no-edit line; executor still contains bare `Constraints:` | the first two lines of each prompt are unchanged (fake-anchor guard) |

Mutations to run (in a `git clone --local` copy under the session scratchpad, after `npm run build`):

- M1: rule 2 deleted ⇒ a fenced-only sample now fails.
- M2: rule 3 picks the first span instead of the last ⇒ the "quoted example then real object" sample fails.
- M3: string-awareness removed from the brace matcher ⇒ the `}`-in-string sample fails.
- M4: the evidence write removed ⇒ the evidence criterion fails.
- M5: the planner read-only line removed ⇒ the prompt criterion fails.
- M6: `extractFinalObject` bypassed in the execute path ⇒ an execute sample wrapped in prose fails.

Gate: `vitest run` through `scripts/check-known-reds.mjs` RC 0, `npm run typecheck` RC 0, `npm run build` RC 0.

## 5. Orca follow-up (not in this repo)

After the human pushes this change, Orca re-pins ccloop (`npm install github:blrbiran/ccloop#<sha>`,
`node scripts/pin-ccloop.mjs` checks). Orca's own handling of `codex-result-invalid` (a human-readable failure
explanation and the `retry-task` button) is in Orca's spec `2026-10-08-issue-fixes-design.md`.
