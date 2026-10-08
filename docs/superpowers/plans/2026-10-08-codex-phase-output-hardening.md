# Codex Phase Output Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop codex phases from failing `codex-result-invalid` when a provider lets the model decorate its answer, without ever letting decoration change which answer is accepted, and tell every phase what it must not do.

**Architecture:** A pure, schema-driven `extractFinalObject` in `src/runtime/codex/protocol.ts` (whole JSON first; else fenced blocks plus top-level brace spans, deduplicated, filtered by the phase's strict acceptance test, accepted only when exactly one distinct object remains). `CodexAdapter.phase` runs it before today's decode, writes `final-extraction.json` evidence for `candidate` and for `none` with candidates, and otherwise passes the original text to today's path. The three prompt builders in `src/runtime/claude/prompts.ts` gain lines after line 2 and at the end only.

**Tech Stack:** TypeScript (NodeNext, strict), zod 3, vitest 2, Node fake CLI fixtures (`tests/fixtures/fake-codex.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-08-codex-phase-output-hardening-design.md` (ccloop worktree `/Users/biran/code/skills/loop/ccloop-planner`, branch `fix/codex-planner-output`).

Plan written by Orca session `e34dc963` (Claude) on 2026-10-08 against the branch commit whose subject is `docs(spec): make codex final-object extraction schema-aware and unambiguous after review`. Line ranges below were measured on that commit; re-measure before editing (ccloop Rule 14).

Dry run at plan-writing time (2026-10-08, same session, on that same commit): every code block of K1–K3 was applied to a `git clone --local` copy under the session scratchpad (never the worktree), then `npm run typecheck` RC 0; `vitest run tests/runtime tests/control/materialize.test.ts tests/controller/runLoop.integration.test.ts` 422 tests / 422 passed / 0 skipped, `check-known-reds` RC 0; K4's `run-mutations.mjs` RC 0 (M0 53 green; M1–M15b each seen red with every named criterion; every file restored). The copy was then deleted. This does not replace the executor's own runs. Tests use `for … of` loops, not `it.each` with `$name`: vitest quotes and truncates `$name` in titles, which broke by-name matching in the first dry run.

## Global Constraints

- Worktree: `W=/Users/biran/code/skills/loop/ccloop-planner`; `SCRATCH` = the executor's session scratchpad directory (export it once; every verification output goes to a file under it and is read back whole — never piped through grep/tail/head, ccloop Rule 14).
- Planner line inserted after line 2, verbatim: `This is the planning phase only. The workspace is read-only: do not create, edit or delete files, do not run apply_patch, and do not carry out the task. A later execute phase does the work this plan describes.`
- Planner heading change, verbatim: `Constraints:` → `Constraints (they bind the execute phase; plan for them, do not act on them now):`
- Verifier line inserted after line 2, verbatim: `This is the verify phase. Do not create, edit or delete files; run commands only to check the attempt.`
- Last line of all three builders, verbatim: `Your final message must be exactly one JSON object: no Markdown code fence, no text before or after it.`
- Every existing prompt line stays byte-for-byte and in the same order; the executor keeps bare `Constraints:`; codex execute still appends its `Wrap the complete or partial result…` line after the builder output (so it, not the final-message line, is last).
- `final` is capped at 16 MiB by `runCodexPhase` (`LIMIT=16*1024*1024`, `src/runtime/codex/runCodexPhase.ts:18`); unchanged.
- Evidence file name `final-extraction.json`, content `{"method","candidates","valid","originalBytes"}`, `originalBytes` = UTF-8 byte length of the original `final`, mode `0600`, written before decoding, only for `candidate` and for `none` with `candidates > 0`; never for `whole`, never for `none` with zero candidates.
- `whole` = `JSON.parse(final)` succeeds (no extra trimming), whatever the value; `none` passes the original `final` to today's path, so error text is unchanged.
- No change to `decodeCodexResult`, `phaseJsonSchema`, the zod schemas, usage accounting, claude output parsing. No existing criterion is edited (ccloop Rule 15): new tests only.
- Performance: 4 MiB of `{"` noise followed by a valid (fenced) plan completes under 2 s.
- Mutations only in a `git clone --local` copy under `$SCRATCH`, after `npm run build` in the copy (ccloop Rule 17); worktree `git diff` / `git diff --cached` byte counts equal before and after.
- `git add` explicit paths only (never `-A` or `.`; `node_modules` is an untracked symlink). Commit messages are English, conventional, and end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No push, no merge (ccloop Rule 13).

## Review Focus

Five input classes the spec implies but its table would not catch on its own; each has a test in the owning task:

1. **Fenced-only answers (fence collection actually load-bearing).** Every fence sample in spec §4 is also found by the brace pass, so deleting fence collection (M2) would stay green on them. Test (K1): `accepts the one plan in a fence after prose with an unclosed brace` and `accepts the one plan in a fence inside a brace-wrapped note`, plus the fenced performance case.
2. **The same object found twice (fence body and its own span).** Must count once, or every fenced answer becomes "two candidates". Test (K1): `counts the same object in a fence and as a bare span once` (asserts `candidates: 1, valid: 1`).
3. **Whole-JSON non-objects, including a bare array that holds a valid plan.** Step 1 makes them `whole`, so they fail exactly as today and are never unwrapped. Tests: K1 `returns a whole JSON answer as is, whatever it is` (`[]`, `null`, bare `[{plan}]`); K2 `decodes a bare array holding the plan as a whole answer, failing as today`.
4. **`none` with candidates: evidence before decode, error text unchanged.** Tests (K2): `keeps today's error text and records the refused candidates before decoding` (both `final-extraction.json` and `decode-error.txt`, exact message), `keeps today's execute error for two different envelopes` / `… for an envelope with an extra key` (message equals `String(JSON.parse error)` of the original text).
5. **A schema-valid object of the wrong phase / without the envelope.** A verify object inside a plan answer, or a bare execution body without `{result}`, must not be accepted. Tests (K1): `refuses a valid answer of another phase`, `execute envelope > refuses a bare execution body without the envelope`.

---

### Task K1: `extractFinalObject` and `phaseFinalAccepts` (pure, protocol.ts)

**Files:**
- Modify: `src/runtime/codex/protocol.ts` (append after the last line, currently line 125, the closing `}` of `codexModelUsage`)
- Create: `tests/runtime/codex/extractFinalObject.test.ts`

**Interfaces:**
- Consumes: module-private `execution` (line 26), `schemas` (line 28), `record` (line 39), `CodexPhase` (line 6), `z` (line 2).
- Produces:
  - `export function phaseFinalAccepts(phase: CodexPhase): (value: unknown) => boolean`
  - `export type FinalExtraction = { method: "whole"; value: unknown } | { method: "candidate"; value: unknown; candidates: number; valid: number } | { method: "none"; candidates: number; valid: number };`
  - `export function extractFinalObject(final: string, accepts: (value: unknown) => boolean): FinalExtraction`
  - `candidates` = number of distinct (by `JSON.stringify`) candidate texts that parsed to a plain object; `valid` = how many of those `accepts` takes.

- [ ] **Step 0: Baseline (once, before any change)**

```bash
export SCRATCH=<the executor's session scratchpad>; W=/Users/biran/code/skills/loop/ccloop-planner
mkdir -p "$SCRATCH/baseline" && cd "$W" && export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy git -C "$W" status --porcelain > "$SCRATCH/baseline/status.txt" 2>&1; echo rc=$?
rtk proxy ./node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile.json="$SCRATCH/baseline/vitest.json" > "$SCRATCH/baseline/vitest.out" 2>&1; echo rc=$?
node scripts/check-known-reds.mjs "$SCRATCH/baseline/vitest.json" > "$SCRATCH/baseline/known-reds.txt" 2>&1; echo rc=$?
node -e 'const r=require(process.argv[1]);console.log(JSON.stringify({total:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests,pending:r.numPendingTests,todo:r.numTodoTests}))' "$SCRATCH/baseline/vitest.json" > "$SCRATCH/baseline/counts.txt"
```

Read every file whole. Expected: `status.txt` lists only `?? node_modules`; the `RUN` line in `vitest.out` names `$W`; `check-known-reds` rc 0. Record `counts.txt` (K4 expects `total` = baseline + 53 new tests).

- [ ] **Step 1: Write the failing test** — create `tests/runtime/codex/extractFinalObject.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractFinalObject, phaseFinalAccepts } from "../../../src/runtime/codex/protocol.js";

// Codex phase output hardening (2026-10-08), spec §3.2 and §4. A provider that does not enforce --output-schema lets the
// model wrap its answer in prose or a fence. The answer is taken only when exactly one schema-valid object is in the
// message: decoration must never change which answer is accepted (above all, never turn a verify rejection into
// approval), and every message that is whole JSON is decided exactly as before.
const FENCE = "`".repeat(3);
const fence = (info: string, body: string) => `${FENCE}${info}\n${body}\n${FENCE}`;
const plan = { summary: "inspect target", primaryTargetPaths: ["answer.txt"] };
const other = { summary: "another plan", primaryTargetPaths: [] as string[] };
const P = JSON.stringify(plan), O = JSON.stringify(other);
const rejection = { approved: false, rejectCategory: "check", primaryTargetPaths: ["answer.txt"], failingCommand: "node check.cjs", safeToRetry: true, evidence: ["answer.txt is 0"], pauseSignals: [] as string[], stopSignals: [] as string[] };
const approval = { approved: true, rejectCategory: "", primaryTargetPaths: [] as string[], failingCommand: null, safeToRetry: false, evidence: [] as string[], pauseSignals: [] as string[], stopSignals: [] as string[] };
const complete = { changedFiles: ["answer.txt"], diffPatch: "fixture patch", commandOutputs: ["ran"], stdoutStderrLog: "log" };
const partial = { ...complete, completionStatus: "partial", failureType: "error", failureMessage: "stopped early" };
const acceptsPlan = phaseFinalAccepts("plan");
const extractPlan = (text: string) => extractFinalObject(text, acceptsPlan);

describe("extractFinalObject (codex phase output hardening)", () => {
  it("returns a whole JSON answer as is, whatever it is", () => {
    expect(extractPlan(P)).toEqual({ method: "whole", value: plan });
    expect(extractPlan(`\n  ${P}\n`)).toEqual({ method: "whole", value: plan });
    expect(extractPlan("[]")).toEqual({ method: "whole", value: [] });
    expect(extractPlan("null")).toEqual({ method: "whole", value: null });
    // A bare array holding a valid plan is whole JSON: it fails exactly as today, it is not unwrapped.
    expect(extractPlan(`[${P}]`)).toEqual({ method: "whole", value: [plan] });
  });

  for (const { name, text, value } of [
    { name: "a json fence after prose", text: `Here is the plan:\n${fence("json", JSON.stringify(plan, null, 2))}\n`, value: plan },
    { name: "a JSON fence", text: `Plan:\n${fence("JSON", P)}`, value: plan },
    { name: "a fence without an info string", text: `Plan:\n${fence("", P)}\nThat is all.`, value: plan },
    { name: "a bash fence", text: `Run this:\n${fence("bash", P)}`, value: plan },
    { name: "prose ending with the object", text: `The plan is ${P}`, value: plan },
    { name: "prose quoting an example object before the real one", text: `An answer looks like {"a":1}; the real plan: ${P}`, value: plan },
    { name: "an object with a closing brace inside a string", text: 'Result: {"summary":"close } brace","primaryTargetPaths":[]}', value: { summary: "close } brace", primaryTargetPaths: [] } },
    { name: "an object with escaped quotes around a brace", text: 'Result: {"summary":"say \\"}\\" now","primaryTargetPaths":[]}', value: { summary: 'say "}" now', primaryTargetPaths: [] } },
    { name: "prose with a stray quote before the object", text: `A 5" screen shows ${P}`, value: plan },
    { name: "an array inside prose", text: `Answer: [${P}]`, value: plan },
    // Fenced-only: the brace pass cannot see these (an unclosed `{` before, or a span that wraps the fence), so only
    // fence collection finds the answer (Review Focus 1, mutation M2).
    { name: "a fence after prose with an unclosed brace", text: `Use { for maps.\n${fence("json", P)}\nDone`, value: plan },
    { name: "a fence inside a brace-wrapped note", text: `{ note:\n${fence("", P)}\n}`, value: plan },
  ]) it(`accepts the one plan in ${name}`, () => {
    const result = extractPlan(text);
    expect(result.method).toBe("candidate");
    expect(result.method === "candidate" ? result.value : undefined).toEqual(value);
  });

  it("counts the same object in a fence and as a bare span once", () => {
    expect(extractPlan(`${fence("json", P)}\nAgain: ${P}`)).toEqual({ method: "candidate", value: plan, candidates: 1, valid: 1 });
  });

  for (const { name, text, candidates, valid } of [
    { name: "plain prose", text: "oops", candidates: 0, valid: 0 },
    { name: "two different bare plans", text: `First ${P}, or maybe ${O}`, candidates: 2, valid: 2 },
    { name: "two different bare plans in the other order", text: `First ${O}, or maybe ${P}`, candidates: 2, valid: 2 },
    { name: "two different fenced plans", text: `${fence("json", O)}\n${fence("json", P)}`, candidates: 2, valid: 2 },
    { name: "a fenced plan and a different bare plan", text: `${fence("json", P)}\nActually: ${O}`, candidates: 2, valid: 2 },
    { name: "an unclosed brace followed by text", text: 'Plan: {"summary":"s","primaryTargetPaths":[] and then I stopped', candidates: 0, valid: 0 },
    { name: "a plan with an extra key", text: `Plan: ${JSON.stringify({ ...plan, extra: 1 })}`, candidates: 1, valid: 0 },
    { name: "a valid answer of another phase", text: `Verdict: ${JSON.stringify(rejection)}`, candidates: 1, valid: 0 },
  ]) it(`refuses ${name}`, () => {
    expect(extractPlan(text)).toEqual({ method: "none", candidates, valid });
  });

  describe("verify safety", () => {
    const acceptsVerify = phaseFinalAccepts("verify");
    it("accepts the rejection after a fenced example that is not a verification", () => {
      const text = `Example:\n${fence("json", '{"approved": "yes"}')}\nResult: ${JSON.stringify(rejection)}`;
      expect(extractFinalObject(text, acceptsVerify)).toEqual({ method: "candidate", value: rejection, candidates: 2, valid: 1 });
    });
    it("never turns a rejection into approval because a schema-valid approval template is also present", () => {
      const template = `Template:\n${fence("json", JSON.stringify(approval, null, 2))}`, actual = `Actual: ${JSON.stringify(rejection)}`;
      expect(extractFinalObject(`${template}\n${actual}`, acceptsVerify)).toEqual({ method: "none", candidates: 2, valid: 2 });
      expect(extractFinalObject(`${actual}\n${template}`, acceptsVerify)).toEqual({ method: "none", candidates: 2, valid: 2 });
    });
  });

  describe("execute envelope", () => {
    const acceptsExecute = phaseFinalAccepts("execute");
    for (const { name, body } of [{ name: "complete", body: complete }, { name: "partial", body: partial }]) it(`accepts prose followed by a ${name} envelope`, () => {
      expect(extractFinalObject(`Done.\n${JSON.stringify({ result: body })}`, acceptsExecute)).toEqual({ method: "candidate", value: { result: body }, candidates: 1, valid: 1 });
    });
    for (const { name, text, candidates, valid } of [
      { name: "two different envelopes", text: `${JSON.stringify({ result: complete })} or ${JSON.stringify({ result: partial })}`, candidates: 2, valid: 2 },
      { name: "an envelope with an extra key", text: `Done: ${JSON.stringify({ result: complete, tokenUsage: 0 })}`, candidates: 1, valid: 0 },
      { name: "a bare execution body without the envelope", text: `Done: ${JSON.stringify(complete)}`, candidates: 1, valid: 0 },
    ]) it(`refuses ${name}`, () => {
      expect(extractFinalObject(text, acceptsExecute)).toEqual({ method: "none", candidates, valid });
    });
  });

  describe("performance", () => {
    // 4 MiB of unbalanced braces and quotes: the brace pass never returns to depth 0 after the first `{`.
    const noise = '{"'.repeat(2 * 1024 * 1024);
    it("finds a fenced plan after 4 MiB of unbalanced brace-quote noise in under 2 s", () => {
      const started = performance.now();
      const result = extractPlan(`${noise}\n${fence("json", P)}\n`);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result).toEqual({ method: "candidate", value: plan, candidates: 1, valid: 1 });
    });
    it("answers none for a bare plan after the same noise in under 2 s", () => {
      const started = performance.now();
      const result = extractPlan(`${noise}${P}`);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result).toEqual({ method: "none", candidates: 0, valid: 0 });
    });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
cd "$W" && rtk proxy ./node_modules/.bin/vitest run tests/runtime/codex/extractFinalObject.test.ts > "$SCRATCH/k1-red.txt" 2>&1; echo rc=$?
```

Expected: rc 1; the file fails at collection with `TypeError: phaseFinalAccepts is not a function` (the module-level `phaseFinalAccepts("plan")` call), no test passes.

- [ ] **Step 3: Implement** — append to `src/runtime/codex/protocol.ts` after the current last line (`}` closing `codexModelUsage`, line 125):

````ts

/**
 * Codex phase output hardening (2026-10-08), spec §3.2: the phase's strict acceptance test for extractFinalObject. Plan
 * and verify use their phase schema; execute uses the strict {result} envelope whose result must pass the execution union.
 */
const executeEnvelope = z.object({result:execution}).strict();
export function phaseFinalAccepts(phase: CodexPhase): (value: unknown) => boolean {
  const schema: z.ZodTypeAny = phase === "execute" ? executeEnvelope : schemas[phase];
  return (value) => schema.safeParse(value).success;
}

export type FinalExtraction =
  | { method: "whole"; value: unknown }
  | { method: "candidate"; value: unknown; candidates: number; valid: number }
  | { method: "none"; candidates: number; valid: number };
/**
 * Codex phase output hardening (2026-10-08), spec §3.2: find the phase answer in a final message a provider let the model
 * decorate. A final message that is whole JSON is returned as is (acceptance is then decided exactly as before).
 * Otherwise every fenced block and every top-level balanced {…} span is a candidate; candidates that parse to objects are
 * deduplicated by JSON.stringify, and the answer is the one distinct object `accepts` takes. Zero, or two or more
 * different accepted objects, is `none`: decoration may never change which answer is accepted (a fenced approval
 * template next to the real rejection is refused, not guessed). One linear pass for fences, one for spans.
 */
export function extractFinalObject(final: string, accepts: (value: unknown) => boolean): FinalExtraction {
  try { return { method: "whole", value: JSON.parse(final) }; } catch { /* not whole JSON: look for candidates */ }
  const texts: string[] = [];
  // A line starting with ``` opens a block and the next line starting with ``` closes it; an unclosed fence is no block.
  let body = -1;
  for (let start = 0; ;) {
    const newline = final.indexOf("\n", start);
    if (final.startsWith("```", start)) {
      if (body === -1) body = newline === -1 ? final.length : newline + 1;
      else { texts.push(final.slice(body, start)); body = -1; }
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  // Brace spans: string state only inside an object (depth >= 1), so a stray quote in prose cannot hide one; a `}` at
  // depth 0 is ignored; an unclosed `{` never closes, so no span starts after it.
  let depth = 0, spanStart = 0, inString = false, escaped = false;
  for (let i = 0; i < final.length; i++) {
    const c = final[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === "{") {
      if (depth === 0) spanStart = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0 && --depth === 0) texts.push(final.slice(spanStart, i + 1));
    } else if (c === '"' && depth > 0) inString = true;
  }
  const objects = new Map<string, unknown>();
  for (const text of texts) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { continue; }
    if (record(value)) objects.set(JSON.stringify(value), value);
  }
  const valid = [...objects.values()].filter((value) => accepts(value));
  const counts = { candidates: objects.size, valid: valid.length };
  return valid.length === 1 ? { method: "candidate", value: valid[0], ...counts } : { method: "none", ...counts };
}
````

- [ ] **Step 4: Run, expect PASS**

```bash
cd "$W" && rtk proxy ./node_modules/.bin/vitest run tests/runtime/codex/extractFinalObject.test.ts tests/runtime/codex/protocol.test.ts > "$SCRATCH/k1-green.txt" 2>&1; echo rc=$?
rtk proxy npm run typecheck > "$SCRATCH/k1-typecheck.txt" 2>&1; echo rc=$?
```

Expected: rc 0 for both; `k1-green.txt` shows 31 tests in `extractFinalObject.test.ts` passed and every existing `protocol.test.ts` test passed (unchanged criteria, spec §4).

- [ ] **Step 5: Mutation** (run in K4's copy; listed here so each is owned). Each deletes one branch of this task; the named test must be seen red:
  - **M1** delete line `  try { return { method: "whole", value: JSON.parse(final) }; } catch { /* not whole JSON: look for candidates */ }` ⇒ red `returns a whole JSON answer as is, whatever it is` (and K2's no-file-for-whole row).
  - **M2** `else { texts.push(final.slice(body, start)); body = -1; }` → `else { body = -1; }` ⇒ red `accepts the one plan in a fence after prose with an unclosed brace`, `… in a fence inside a brace-wrapped note`, `performance > finds a fenced plan …`.
  - **M3** `return valid.length === 1 ? { method: "candidate", value: valid[0], ...counts }` → `return valid.length >= 1 ? { method: "candidate", value: valid[valid.length - 1], ...counts }` ⇒ red `refuses two different bare plans` (and the other three two-plan rows), `verify safety > never turns a rejection into approval …`, `execute envelope > refuses two different envelopes`.
  - **M4** `    } else if (c === '"' && depth > 0) inString = true;` → `    }` ⇒ red `accepts the one plan in an object with a closing brace inside a string`.
  - **M5** delete line `      else if (c === "\\") escaped = true;` ⇒ red `accepts the one plan in an object with escaped quotes around a brace`.
  - **M6** `} else if (c === '"' && depth > 0) inString = true;` → `} else if (c === '"') inString = true;` ⇒ red `accepts the one plan in prose with a stray quote before the object`.
  - **M7** `.filter((value) => accepts(value))` → `.filter(() => true)` ⇒ red `accepts the one plan in prose quoting an example object before the real one`, `refuses a plan with an extra key`, `verify safety > accepts the rejection after a fenced example that is not a verification`.

- [ ] **Step 6: Commit**

```bash
git -C "$W" add src/runtime/codex/protocol.ts tests/runtime/codex/extractFinalObject.test.ts
git -C "$W" commit -m "feat(codex): extract the one schema-valid object from a decorated final message

extractFinalObject keeps whole-JSON answers as they are and otherwise takes the single distinct object, among fenced
blocks and top-level brace spans, that the phase's strict acceptance test (phaseFinalAccepts) takes; zero or several
is none. Spec 2026-10-08-codex-phase-output-hardening-design.md section 3.2.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task K2: Adapter wiring, `final-extraction.json`, fake-codex `final-text` mode

**Files:**
- Modify: `tests/fixtures/fake-codex.mjs` (insert after line 73, `if(mode!=="missing-final") writeFileSync(value("-o"),…);`, inside `respond`)
- Modify: `src/runtime/codex/codexAdapter.ts` (line 6 import; lines 32–33, the start of the `try` block in `phase`)
- Create: `tests/runtime/codex/finalExtraction.test.ts`

**Interfaces:**
- Consumes: `extractFinalObject`, `phaseFinalAccepts` (K1); `codexFixture(mode)` from `tests/runtime/codex/fixture.ts` (returns `{dir, runDir, context, config, marker, …}`; `config.command = [node, fake-codex.mjs, mode, marker]`); evidence dir layout `<runDir>/codex/<attempt>/<phase>/call-*` (`runCodexPhase.ts:22–24`).
- Produces: fake-codex mode `final-text`, argv `final-text <marker> <finalsFile>`; `finalsFile` is JSON `{"plan"?: string, "execute"?: string, "verify"?: string}`; the phase's string is written to `-o` verbatim, after (and so in place of) the JSON answer; a phase without an entry answers as mode `ok`. Evidence file `final-extraction.json` as in Global Constraints.

- [ ] **Step 1: Write the failing test** — first add the fake mode (test infrastructure, additive; every existing mode is untouched because the new line only runs for `mode==="final-text"`). In `tests/fixtures/fake-codex.mjs`, after line 73:

```js
  if(mode!=="missing-final") writeFileSync(value("-o"),JSON.stringify(wireSchema.properties?.result?{result:body,...(mode==="envelope-extra"?{tokenUsage:0}:{})}:body));
  // Codex phase output hardening (2026-10-08): mode `final-text`, argv `final-text <marker> <finalsFile>`, writes the
  // finalsFile's string for this phase (`{"plan"?, "execute"?, "verify"?}`) as the final message verbatim, replacing the
  // JSON answer above; a phase without an entry answers as mode `ok` does.
  if(mode==="final-text"){const text=JSON.parse(readFileSync(process.argv[4],"utf8"))[phase];if(typeof text==="string")writeFileSync(value("-o"),text);}
```

(The first line above is the existing line 73, shown as the anchor; only the three comment lines and the `if(mode==="final-text")` line are new.)

Then create `tests/runtime/codex/finalExtraction.test.ts`:

```ts
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { codexFixture } from "./fixture.js";

// Codex phase output hardening (2026-10-08), spec §3.2 and §4, through the real adapter and the fake codex's `final-text`
// mode, which writes a given final message verbatim. A decorated answer is decoded from its one schema-valid object;
// anything else fails with exactly today's error text; final-extraction.json says which happened, and a compliant
// answer's evidence stays as it was.
type Phase = "plan" | "execute" | "verify";
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const FENCE = "`".repeat(3);
const fenced = (value: unknown) => `${FENCE}json\n${JSON.stringify(value, null, 2)}\n${FENCE}`;
const plan = { summary: "inspect target", primaryTargetPaths: ["answer.txt"] };
const complete = { changedFiles: ["answer.txt"], diffPatch: "fixture patch", commandOutputs: ["ran"], stdoutStderrLog: "log" };
const partial = { ...complete, completionStatus: "partial", failureType: "error", failureMessage: "stopped early" };
const rejection = { approved: false, rejectCategory: "check", primaryTargetPaths: ["answer.txt"], failingCommand: "node check.cjs", safeToRetry: true, evidence: ["answer.txt is 0"], pauseSignals: [] as string[], stopSignals: [] as string[] };
const approvalTemplate = { approved: true, rejectCategory: "", primaryTargetPaths: [] as string[], failingCommand: null, safeToRetry: false, evidence: [] as string[], pauseSignals: [] as string[], stopSignals: [] as string[] };

async function withFinal(phase: Phase, text: string) {
  const f = await codexFixture("final-text");
  dirs.push(f.dir);
  const finals = join(f.dir, "finals.json");
  await writeFile(finals, JSON.stringify({ [phase]: text }));
  const adapter = new CodexAdapter({ ...f.config, command: [...f.config.command, finals] });
  const call = async () => {
    const root = join(f.runDir, "codex", "1", phase);
    const calls = await readdir(root);
    expect(calls).toHaveLength(1);
    return join(root, calls[0]);
  };
  return { ...f, adapter, call };
}
const exists = (path: string) => stat(path).then(() => true, () => false);
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => (error as Error).message);
/** The error today's decode gives for a final message that is not whole JSON: JSON.parse of the whole text. */
const todaysParseError = (text: string) => { try { JSON.parse(text); } catch (error) { return String(error); } throw new Error("sample must not be whole JSON"); };

describe("Codex adapter final-message extraction (codex phase output hardening)", () => {
  it("extracts the one plan from decorated prose and records how", async () => {
    const text = `计划如下：\n${fenced(plan)}\n以上。`;
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(text.length); // the sample must tell bytes from characters
    const f = await withFinal("plan", text);
    expect(await f.adapter.plan(f.context)).toMatchObject({ ...plan, tokenUsage: 15 });
    const call = await f.call();
    expect(await readFile(join(call, "final.json"), "utf8")).toBe(text); // the fake wrote the message verbatim
    expect(await readJson(join(call, "final-extraction.json"))).toEqual({ method: "candidate", candidates: 1, valid: 1, originalBytes: Buffer.byteLength(text, "utf8") });
    expect((await stat(join(call, "final-extraction.json"))).mode & 0o777).toBe(0o600);
    expect(await exists(join(call, "decode-error.txt"))).toBe(false);
  });

  it("writes no extraction evidence for a compliant whole answer", async () => {
    const f = await withFinal("plan", JSON.stringify(plan));
    expect(await f.adapter.plan(f.context)).toMatchObject({ ...plan, tokenUsage: 15 });
    expect(await exists(join(await f.call(), "final-extraction.json"))).toBe(false);
  });

  it("keeps today's error text and records the refused candidates before decoding", async () => {
    const text = `Plan: ${JSON.stringify({ ...plan, extra: 1 })}`;
    const f = await withFinal("plan", text);
    const message = await failure(f.adapter.plan(f.context));
    const call = await f.call();
    expect(message).toBe(`Error: codex-result-invalid: ${call}`);
    expect(await readFile(join(call, "decode-error.txt"), "utf8")).toBe("Error: codex-result-invalid");
    expect(await readJson(join(call, "final-extraction.json"))).toEqual({ method: "none", candidates: 1, valid: 0, originalBytes: Buffer.byteLength(text, "utf8") });
  });

  it("writes no extraction evidence when no candidate parses", async () => {
    const f = await withFinal("plan", "oops");
    const message = await failure(f.adapter.plan(f.context));
    const call = await f.call();
    expect(message).toBe(`Error: codex-result-invalid: ${call}`);
    expect(await exists(join(call, "final-extraction.json"))).toBe(false);
  });

  it("decodes a bare array holding the plan as a whole answer, failing as today", async () => {
    const f = await withFinal("plan", JSON.stringify([plan]));
    const message = await failure(f.adapter.plan(f.context));
    const call = await f.call();
    expect(message.startsWith("Error: codex-result-invalid: ")).toBe(true);
    expect(message.endsWith(`: ${call}`)).toBe(true);
    expect(await exists(join(call, "final-extraction.json"))).toBe(false);
  });

  it("refuses a verify answer that carries an approval template next to the rejection", async () => {
    const text = `Template:\n${fenced(approvalTemplate)}\nActual result: ${JSON.stringify(rejection)}`;
    const f = await withFinal("verify", text);
    const message = await failure(f.adapter.verify(f.context));
    const call = await f.call();
    expect(message).toBe(`Error: codex-result-invalid: ${call}`);
    expect(await readJson(join(call, "final-extraction.json"))).toEqual({ method: "none", candidates: 2, valid: 2, originalBytes: Buffer.byteLength(text, "utf8") });
  });

  it("accepts a verify rejection after a fenced example that is not a verification", async () => {
    const text = `Example:\n${fenced({ approved: "yes" })}\nResult: ${JSON.stringify(rejection)}`;
    const f = await withFinal("verify", text);
    expect(await f.adapter.verify(f.context)).toMatchObject({ ...rejection, tokenUsage: 15 });
  });

  for (const { name, body } of [{ name: "complete", body: complete }, { name: "partial", body: partial }]) it(`extracts a ${name} execution envelope from prose`, async () => {
    const text = `Done. Result:\n${JSON.stringify({ result: body })}`;
    const f = await withFinal("execute", text);
    expect(await f.adapter.execute(f.context)).toMatchObject({ ...body, tokenUsage: 15 });
    expect(await readJson(join(await f.call(), "final-extraction.json"))).toEqual({ method: "candidate", candidates: 1, valid: 1, originalBytes: Buffer.byteLength(text, "utf8") });
  });

  for (const { name, text } of [
    { name: "two different envelopes", text: `First ${JSON.stringify({ result: complete })} then ${JSON.stringify({ result: partial })}` },
    { name: "an envelope with an extra key", text: `Result: ${JSON.stringify({ result: complete, tokenUsage: 0 })}` },
  ]) it(`keeps today's execute error for ${name}`, async () => {
    const f = await withFinal("execute", text);
    const message = await failure(f.adapter.execute(f.context));
    expect(message).toBe(`${todaysParseError(text)}: ${await f.call()}`);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
cd "$W" && rtk proxy ./node_modules/.bin/vitest run tests/runtime/codex/finalExtraction.test.ts > "$SCRATCH/k2-red.txt" 2>&1; echo rc=$?
```

Expected: rc 1. Red: `extracts the one plan from decorated prose and records how` (rejects `Error: codex-result-invalid: …`), `keeps today's error text and records the refused candidates before decoding` (ENOENT on `final-extraction.json`), `refuses a verify answer that carries an approval template next to the rejection` (ENOENT), `accepts a verify rejection after a fenced example that is not a verification` (rejects), `extracts a complete execution envelope from prose` and `… partial …` (reject with `SyntaxError`). Already green (absence / compatibility guards; their red is shown by M1 and M9 in K4): `writes no extraction evidence for a compliant whole answer`, `writes no extraction evidence when no candidate parses`, `decodes a bare array holding the plan as a whole answer, failing as today`, both `keeps today's execute error for …` rows.

- [ ] **Step 3: Implement** — `src/runtime/codex/codexAdapter.ts`.

Line 6, replace:

```ts
import { codexModelUsage, decodeCodexResult, parseCodexConfig, type CodexConfig, type CodexPhase, type PhaseResults } from "./protocol.js";
```

with:

```ts
import { codexModelUsage, decodeCodexResult, extractFinalObject, parseCodexConfig, phaseFinalAccepts, type CodexConfig, type CodexPhase, type PhaseResults } from "./protocol.js";
```

Lines 32–33, replace:

```ts
    try {
      const result = decodeCodexResult(phase, outcome.events, phase === "execute" ? JSON.stringify(z.object({result:z.unknown()}).strict().parse(JSON.parse(outcome.final)).result) : outcome.final);
```

with:

```ts
    try {
      // Codex phase output hardening (2026-10-08), spec §3.2: a decorated final message yields its one schema-valid object;
      // a whole-JSON answer, and one without exactly one valid object, take today's path with the original text unchanged.
      const extraction = extractFinalObject(outcome.final, phaseFinalAccepts(phase));
      if (extraction.method === "candidate" || (extraction.method === "none" && extraction.candidates > 0)) {
        await writeFile(join(outcome.evidenceDir, "final-extraction.json"), JSON.stringify({ method: extraction.method, candidates: extraction.candidates, valid: extraction.valid, originalBytes: Buffer.byteLength(outcome.final, "utf8") }), { mode: 0o600 });
      }
      const final = extraction.method === "candidate" ? JSON.stringify(extraction.value) : outcome.final;
      const result = decodeCodexResult(phase, outcome.events, phase === "execute" ? JSON.stringify(z.object({result:z.unknown()}).strict().parse(JSON.parse(final)).result) : final);
```

Lines 34–41 (usage.json write, modelUsage, the `catch` that writes `decode-error.txt` and rethrows) stay as they are. The evidence write is inside the existing `try`, so a write failure becomes `decode-error.txt` plus a rethrow (spec §3.2). For execute, a `candidate` is the accepted `{result}` envelope; re-serialising it and passing it through today's envelope parse hands its `result` to `decodeCodexResult`, which still applies the strict schema and the usage checks.

- [ ] **Step 4: Run, expect PASS**

```bash
cd "$W" && rtk proxy ./node_modules/.bin/vitest run tests/runtime/codex > "$SCRATCH/k2-green.txt" 2>&1; echo rc=$?
rtk proxy npm run typecheck > "$SCRATCH/k2-typecheck.txt" 2>&1; echo rc=$?
```

Expected: typecheck rc 0. `finalExtraction.test.ts` 11 tests passed; every other file in `tests/runtime/codex` passes except, at most, the known load flake `Codex phase process > kills a TERM-ignoring process before returning abort` (on the known-reds roster). If vitest rc is not 0, rerun with `--reporter=default --reporter=json --outputFile.json="$SCRATCH/k2.json"` and require `node scripts/check-known-reds.mjs "$SCRATCH/k2.json"` rc 0.

- [ ] **Step 5: Mutation** (run in K4's copy):
  - **M8** delete the line `        await writeFile(join(outcome.evidenceDir, "final-extraction.json"), …);` ⇒ red `extracts the one plan from decorated prose and records how`, `keeps today's error text and records the refused candidates before decoding`, `refuses a verify answer that carries an approval template next to the rejection`, `extracts a complete execution envelope from prose`, `extracts a partial execution envelope from prose`.
  - **M9** `if (extraction.method === "candidate" || (extraction.method === "none" && extraction.candidates > 0)) {` → `{` (evidence written unconditionally) ⇒ red `writes no extraction evidence for a compliant whole answer`, `writes no extraction evidence when no candidate parses`, `decodes a bare array holding the plan as a whole answer, failing as today`.
  - **M10** `const final = extraction.method === "candidate" ? …` → `const final = extraction.method === "candidate" && phase !== "execute" ? JSON.stringify(extraction.value) : outcome.final;` (extraction bypassed in execute) ⇒ red `extracts a complete execution envelope from prose`, `extracts a partial execution envelope from prose`.

- [ ] **Step 6: Commit**

```bash
git -C "$W" add src/runtime/codex/codexAdapter.ts tests/fixtures/fake-codex.mjs tests/runtime/codex/finalExtraction.test.ts
git -C "$W" commit -m "feat(codex): decode a decorated final message through its one schema-valid object

The adapter runs extractFinalObject before today's decode, records final-extraction.json (method, candidates, valid,
originalBytes; mode 0600) for a candidate and for none with candidates, and otherwise passes the original text so the
error text is unchanged. The fake codex gains a final-text mode that writes a given final message verbatim.
Spec 2026-10-08-codex-phase-output-hardening-design.md section 3.2.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task K3: Phase prompts (prompts.ts)

**Files:**
- Modify: `src/runtime/claude/prompts.ts` (lines 10–11 anchor; planner 12–26; executor 49–52; verifier 58–75)
- Create: `tests/runtime/claude/phasePrompts.test.ts`
- Modify: `tests/runtime/codex/finalExtraction.test.ts` (append one `describe` block at the end of the file; K2 created this file, so no existing criterion changes)

**Interfaces:**
- Consumes: `buildPlannerPrompt(contract: LoopContract)`, `buildExecutorPrompt(context: AttemptContext)`, `buildVerifierPrompt(context: AttemptContext)`; `loopContractSchema` (`src/contract/schema.ts`); `codexFixture("ok")` and the fake's marker file `{args, cwd, prompt, pid}`.
- Produces: module-private `const FINAL_MESSAGE_LINE` in `prompts.ts`; builder signatures unchanged.

- [ ] **Step 0: Re-verify the fakes do not match the changed heading** (spec §3.1 asks the plan to re-verify)

```bash
git -C "$W" grep -n -e "Constraints" -- tests/fixtures scripts > "$SCRATCH/k3-anchors.txt" 2>&1; echo rc=$?
```

Expected: rc 1 and an empty file (no fake or script matches `Constraints`). The only `Constraints:` occurrences under `tests/` are in `tests/runtime/codex/fakeCodexDelay.test.ts`, which builds its own prompts and does not call the builders. If rc is 0, stop and report: the heading change would hit a fake.

- [ ] **Step 1: Write the failing test** — create `tests/runtime/claude/phasePrompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loopContractSchema } from "../../../src/contract/schema.js";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../../../src/runtime/claude/prompts.js";
import type { AttemptContext } from "../../../src/runtime/types.js";

// Codex phase output hardening (2026-10-08), spec §3.1. A third-party model ran an investigate task's plan phase as if it
// were the execute phase (apply_patch in a read-only sandbox) and wrapped its answer in prose. The prompts now say what
// each phase must not do and how the final message must look. Every existing line stays byte-for-byte and in order: the
// fake CLIs find the phase and task on the second line, so new text goes after it or at the end.
const READ_ONLY = "This is the planning phase only. The workspace is read-only: do not create, edit or delete files, do not run apply_patch, and do not carry out the task. A later execute phase does the work this plan describes.";
const PLAN_CONSTRAINTS = "Constraints (they bind the execute phase; plan for them, do not act on them now):";
const VERIFY_NO_EDIT = "This is the verify phase. Do not create, edit or delete files; run commands only to check the attempt.";
const FINAL_MESSAGE = "Your final message must be exactly one JSON object: no Markdown code fence, no text before or after it.";
// The Orca investigate constraint that, read at plan time, told the planner to write the report now (spec §1, R1).
const INVESTIGATE = "Investigate only; write the findings to the report file and change nothing else.";

const contract = loopContractSchema.parse({
  objective: { taskId: "t", goal: "g", successCondition: "s" },
  context: { repoPath: "/repo", targetPaths: ["report.md"], buildTestCommands: ["true"], constraints: [INVESTIGATE] },
  executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 5000, totalRuntimeBudgetMs: 20000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
  safetyPolicy: { allowlistPaths: ["report.md"], maxFilesTouched: 1 },
  verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["report missing"] },
  escalationAndExit: {},
});
const context = { contract } as unknown as AttemptContext;
const lines = (prompt: string) => prompt.split("\n");

describe("phase prompts (codex phase output hardening)", () => {
  it("keeps the first two lines of every prompt", () => {
    expect(lines(buildPlannerPrompt(contract)).slice(0, 2)).toEqual(["Return JSON only.", "Plan one isolated L2 attempt for task t."]);
    expect(lines(buildExecutorPrompt(context)).slice(0, 2)).toEqual(["Return JSON only.", "Execute one isolated attempt for task t."]);
    expect(lines(buildVerifierPrompt(context)).slice(0, 2)).toEqual(["Return JSON only.", "Verify task t."]);
  });

  it("keeps every existing planner line in order around the new ones", () => {
    const old = lines(buildPlannerPrompt(contract)).filter((line) => line !== READ_ONLY && line !== FINAL_MESSAGE).map((line) => (line === PLAN_CONSTRAINTS ? "Constraints:" : line));
    expect(old).toEqual(["Return JSON only.", "Plan one isolated L2 attempt for task t.", "Goal: g", "Success condition: s", "Non-goals:", "(none)", "Target paths:", "- report.md", "Constraints:", `- ${INVESTIGATE}`, 'Return an object with {"summary": string, "primaryTargetPaths": string[]}.']);
  });

  it("tells the planner the phase is read-only, right after the task line", () => {
    expect(lines(buildPlannerPrompt(contract))[2]).toBe(READ_ONLY);
  });

  it("labels the planner's constraints as binding the execute phase", () => {
    const planner = lines(buildPlannerPrompt(contract));
    expect(planner[planner.indexOf(PLAN_CONSTRAINTS) + 1]).toBe(`- ${INVESTIGATE}`);
    expect(planner).not.toContain("Constraints:");
  });

  it("keeps the executor's own bare Constraints heading", () => {
    const executor = lines(buildExecutorPrompt(context));
    expect(executor[executor.indexOf("Constraints:") + 1]).toBe(`- ${INVESTIGATE}`);
    expect(executor).not.toContain(PLAN_CONSTRAINTS);
  });

  it("keeps every existing verifier line in order around the new ones", () => {
    const old = lines(buildVerifierPrompt(context)).filter((line) => line !== VERIFY_NO_EDIT && line !== FINAL_MESSAGE);
    expect(old).toEqual([
      "Return JSON only.", "Verify task t.", "Goal: g", "Success condition: s", "Required checks:", "- true",
      "Reject-on conditions (if any of these holds for this attempt, approved must be false):", "- report missing",
      "Required evidence labels (approved must be false if any are missing from evidence):", "(none)",
      "Current attempt plan:", "null", "Current execution outcome:", "null", "Prefer rejection backed by concrete evidence.",
      'Return an object with {"approved": boolean, "rejectCategory": string, "primaryTargetPaths": string[], "failingCommand": string | null, "safeToRetry": boolean, "evidence": string[], "pauseSignals": string[], "stopSignals": string[]}.',
    ]);
  });

  it("tells the verifier not to edit files, right after the task line", () => {
    expect(lines(buildVerifierPrompt(context))[2]).toBe(VERIFY_NO_EDIT);
  });

  for (const { name, build } of [
    { name: "planner", build: () => buildPlannerPrompt(contract) },
    { name: "executor", build: () => buildExecutorPrompt(context) },
    { name: "verifier", build: () => buildVerifierPrompt(context) },
  ]) it(`ends the ${name} prompt with the final-message line`, () => {
    expect(lines(build()).at(-1)).toBe(FINAL_MESSAGE);
  });
});
```

Append to the end of `tests/runtime/codex/finalExtraction.test.ts` (after the closing `});` of the K2 `describe`):

```ts

// Spec §3.1: codex execute appends its envelope line after the builder's output, so the envelope line, not the
// final-message line, is last; the two agree (the envelope is the one JSON object).
describe("codex execute prompt order (codex phase output hardening)", () => {
  it("puts codex's envelope line after the executor's final-message line", async () => {
    const f = await codexFixture("ok");
    dirs.push(f.dir);
    await new CodexAdapter(f.config).execute(f.context);
    const prompt = (JSON.parse(await readFile(f.marker, "utf8")) as { prompt: string }).prompt;
    expect(prompt.split("\n").slice(-2)).toEqual([
      "Your final message must be exactly one JSON object: no Markdown code fence, no text before or after it.",
      "Wrap the complete or partial result in a single object with the sole key result, as required by the output schema.",
    ]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
cd "$W" && rtk proxy ./node_modules/.bin/vitest run tests/runtime/claude/phasePrompts.test.ts tests/runtime/codex/finalExtraction.test.ts > "$SCRATCH/k3-red.txt" 2>&1; echo rc=$?
```

Expected: rc 1. Red: `tells the planner the phase is read-only, right after the task line`, `labels the planner's constraints as binding the execute phase`, `tells the verifier not to edit files, right after the task line`, `ends the planner prompt …`, `ends the executor prompt …`, `ends the verifier prompt …`, `codex execute prompt order … > puts codex's envelope line after the executor's final-message line`. Green already (they pin today's layout; their red is shown by M15 and by any edit that disturbs an old line): `keeps the first two lines of every prompt`, both `keeps every existing … line in order around the new ones`, `keeps the executor's own bare Constraints heading`, and all 11 K2 tests.

- [ ] **Step 3: Implement** — `src/runtime/claude/prompts.ts`.

After lines 8–10 (`function formatJson … }`), insert:

```ts

// Codex phase output hardening (2026-10-08), spec §3.1: every existing line stays byte-for-byte and in order (the fake
// CLIs anchor on the second line); new text is inserted after the second line or appended as the last line.
const FINAL_MESSAGE_LINE = "Your final message must be exactly one JSON object: no Markdown code fence, no text before or after it.";
```

Replace the planner body (lines 13–25) so the function reads:

```ts
export function buildPlannerPrompt(contract: LoopContract): string {
  return [
    "Return JSON only.",
    `Plan one isolated L2 attempt for task ${contract.objective.taskId}.`,
    "This is the planning phase only. The workspace is read-only: do not create, edit or delete files, do not run apply_patch, and do not carry out the task. A later execute phase does the work this plan describes.",
    `Goal: ${contract.objective.goal}`,
    `Success condition: ${contract.objective.successCondition}`,
    "Non-goals:",
    formatList(contract.objective.nonGoals),
    "Target paths:",
    formatList(contract.context.targetPaths),
    "Constraints (they bind the execute phase; plan for them, do not act on them now):",
    formatList(contract.context.constraints),
    'Return an object with {"summary": string, "primaryTargetPaths": string[]}.',
    FINAL_MESSAGE_LINE,
  ].join("\n");
}
```

In the executor, after line 51 (`` `If execute is aborted, you may have up to ${contract.executionPolicy.partialOutcomeRecoveryWindowMs}ms to flush one final execute-phase result.`, ``) insert `    FINAL_MESSAGE_LINE,` so the end of the array reads:

```ts
    "If the attempt is interrupted, preserve any recognizable partial artifacts in those fields.",
    `If execute is aborted, you may have up to ${contract.executionPolicy.partialOutcomeRecoveryWindowMs}ms to flush one final execute-phase result.`,
    FINAL_MESSAGE_LINE,
  ].join("\n");
```

The executor's `"Constraints:",` (line 44) stays unchanged.

In the verifier, after line 60 (`` `Verify task ${contract.objective.taskId}.`, ``) insert the no-edit line, and after line 74 (the `'Return an object with {"approved": …}.'` line) append `FINAL_MESSAGE_LINE`, so the array reads:

```ts
  return [
    "Return JSON only.",
    `Verify task ${contract.objective.taskId}.`,
    "This is the verify phase. Do not create, edit or delete files; run commands only to check the attempt.",
    `Goal: ${contract.objective.goal}`,
    `Success condition: ${contract.objective.successCondition}`,
    "Required checks:",
    formatList(contract.verification.requiredChecks),
    "Reject-on conditions (if any of these holds for this attempt, approved must be false):",
    formatList(contract.verification.rejectOn),
    "Required evidence labels (approved must be false if any are missing from evidence):",
    formatList(contract.verification.evidenceRequired),
    "Current attempt plan:",
    formatJson(context.plan),
    "Current execution outcome:",
    formatJson(context.execution),
    "Prefer rejection backed by concrete evidence.",
    'Return an object with {"approved": boolean, "rejectCategory": string, "primaryTargetPaths": string[], "failingCommand": string | null, "safeToRetry": boolean, "evidence": string[], "pauseSignals": string[], "stopSignals": string[]}.',
    FINAL_MESSAGE_LINE,
  ].join("\n");
```

- [ ] **Step 4: Run, expect PASS** (the new lines reach claude too, so run every consumer of the builders)

```bash
cd "$W" && rtk proxy ./node_modules/.bin/vitest run tests/runtime tests/control/materialize.test.ts tests/controller/runLoop.integration.test.ts --reporter=default --reporter=json --outputFile.json="$SCRATCH/k3.json" > "$SCRATCH/k3-green.txt" 2>&1; echo rc=$?
node scripts/check-known-reds.mjs "$SCRATCH/k3.json" > "$SCRATCH/k3-known-reds.txt" 2>&1; echo rc=$?
rtk proxy npm run typecheck > "$SCRATCH/k3-typecheck.txt" 2>&1; echo rc=$?
```

Expected: `check-known-reds` rc 0 (any failure is a roster name), typecheck rc 0; `phasePrompts.test.ts` 10 passed, `finalExtraction.test.ts` 12 passed.

- [ ] **Step 5: Mutation** (run in K4's copy):
  - **M11** delete the planner read-only line ⇒ red `tells the planner the phase is read-only, right after the task line`.
  - **M12** `"Constraints (they bind the execute phase; plan for them, do not act on them now):",` → `"Constraints:",` ⇒ red `labels the planner's constraints as binding the execute phase`.
  - **M13** delete the verifier no-edit line ⇒ red `tells the verifier not to edit files, right after the task line`.
  - **M14a/b/c** remove `FINAL_MESSAGE_LINE,` from the planner / executor / verifier in turn ⇒ red `ends the planner|executor|verifier prompt with the final-message line` respectively (M14b also reds `puts codex's envelope line after the executor's final-message line`).
  - **M15a/b** insert `"Inserted before line 2.",` between `"Return JSON only.",` and the planner's / verifier's task line ⇒ red `keeps the first two lines of every prompt`.

- [ ] **Step 6: Commit**

```bash
git -C "$W" add src/runtime/claude/prompts.ts tests/runtime/claude/phasePrompts.test.ts tests/runtime/codex/finalExtraction.test.ts
git -C "$W" commit -m "feat(prompts): tell each phase what it must not do and how its final message must look

The planner is told the phase is read-only and its constraints bind the execute phase; the verifier is told not to
edit files; all three end with the one-JSON-object line. Existing lines are unchanged and in order.
Spec 2026-10-08-codex-phase-output-hardening-design.md section 3.1.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task K4: Full gate, mutations M1–M15, restore proof

**Files:** none in the worktree (all output under `$SCRATCH`). No commit.

**Interfaces:** Consumes the three commits above.

- [ ] **Step 1: Full gate** (commands from `docs/handoff/handoff.md` top section: `ECC_GATEGUARD=off DISABLE_OMC=1`, `rtk proxy`, JSON report through `scripts/check-known-reds.mjs`, typecheck, build)

```bash
mkdir -p "$SCRATCH/gate" && cd "$W" && export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy git -C "$W" status --porcelain > "$SCRATCH/gate/status.txt" 2>&1; echo rc=$?
rtk proxy ./node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile.json="$SCRATCH/gate/vitest.json" > "$SCRATCH/gate/vitest.out" 2>&1; echo "vitest rc=$?" > "$SCRATCH/gate/rc.txt"
node scripts/check-known-reds.mjs "$SCRATCH/gate/vitest.json" > "$SCRATCH/gate/known-reds.txt" 2>&1; echo "known-reds rc=$?" >> "$SCRATCH/gate/rc.txt"
rtk proxy npm run typecheck > "$SCRATCH/gate/typecheck.txt" 2>&1; echo "typecheck rc=$?" >> "$SCRATCH/gate/rc.txt"
rtk proxy npm run build > "$SCRATCH/gate/build.txt" 2>&1; echo "build rc=$?" >> "$SCRATCH/gate/rc.txt"
node -e 'const r=require(process.argv[1]);console.log(JSON.stringify({total:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests,pending:r.numPendingTests,todo:r.numTodoTests}))' "$SCRATCH/gate/vitest.json" > "$SCRATCH/gate/counts.txt"
```

Read every file whole. Pass: `status.txt` only `?? node_modules`; `RUN` line in `vitest.out` names `$W`; `known-reds rc=0`, `typecheck rc=0`, `build rc=0`; `counts.txt` `total` = baseline `total` (K1 Step 0) + 53 (K1 31, K2 11, K3 10 + 1), `pending` and `todo` 0. Any skipped test or count mismatch is reported, not waived (ccloop Rule 12).

- [ ] **Step 2: Restore-proof "before"**

```bash
mkdir -p "$SCRATCH/restore"
rtk proxy git -C "$W" diff > "$SCRATCH/restore/before.diff" 2>&1; rtk proxy git -C "$W" diff --cached > "$SCRATCH/restore/before.cached" 2>&1
wc -c "$SCRATCH/restore/before.diff" "$SCRATCH/restore/before.cached" > "$SCRATCH/restore/before-bytes.txt"
```

- [ ] **Step 3: Copy and build** (ccloop Rule 17; the copy is of committed state, which now holds K1–K3)

```bash
git clone --local --branch fix/codex-planner-output "$W" "$SCRATCH/mut" > "$SCRATCH/mut-clone.txt" 2>&1; echo rc=$?
ln -s /Users/biran/code/skills/loop/ccloop/node_modules "$SCRATCH/mut/node_modules"
cd "$SCRATCH/mut" && rtk proxy npm run build > "$SCRATCH/mut-build.txt" 2>&1; echo rc=$?
rtk proxy git -C "$SCRATCH/mut" log -1 --format='%H %s' > "$SCRATCH/mut-head.txt"; rtk proxy git -C "$W" log -1 --format='%H %s' > "$SCRATCH/worktree-head.txt"
```

Expected: clone and build rc 0; the two head files are identical.

- [ ] **Step 4: Mutation runner** — write `$SCRATCH/run-mutations.mjs` (a scratch file, not in any repository):

```js
// Applies each mutation to the clone, runs its criteria, restores the file byte-for-byte, and records whether every
// named criterion was seen red. Usage: node run-mutations.mjs <clone> <outDir>. Exit 0 only if every mutation was seen red
// and the unmutated baseline (M0) is green.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [copy, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const P = "src/runtime/codex/protocol.ts", A = "src/runtime/codex/codexAdapter.ts", R = "src/runtime/claude/prompts.ts";
const K1 = "tests/runtime/codex/extractFinalObject.test.ts", K2 = "tests/runtime/codex/finalExtraction.test.ts", K3 = "tests/runtime/claude/phasePrompts.test.ts";
const D1 = "extractFinalObject (codex phase output hardening)", D2 = "Codex adapter final-message extraction (codex phase output hardening)";
const D3 = "phase prompts (codex phase output hardening)", D4 = "codex execute prompt order (codex phase output hardening)";
const mutations = [
  { id: "M1", file: P, search: `  try { return { method: "whole", value: JSON.parse(final) }; } catch { /* not whole JSON: look for candidates */ }\n`, replace: "", tests: [K1, K2],
    red: [`${D1} > returns a whole JSON answer as is, whatever it is`, `${D2} > writes no extraction evidence for a compliant whole answer`, `${D2} > decodes a bare array holding the plan as a whole answer, failing as today`] },
  { id: "M2", file: P, search: `else { texts.push(final.slice(body, start)); body = -1; }`, replace: `else { body = -1; }`, tests: [K1],
    red: [`${D1} > accepts the one plan in a fence after prose with an unclosed brace`, `${D1} > accepts the one plan in a fence inside a brace-wrapped note`, `${D1} > performance > finds a fenced plan after 4 MiB of unbalanced brace-quote noise in under 2 s`] },
  { id: "M3", file: P, search: `return valid.length === 1 ? { method: "candidate", value: valid[0], ...counts }`, replace: `return valid.length >= 1 ? { method: "candidate", value: valid[valid.length - 1], ...counts }`, tests: [K1, K2],
    red: [`${D1} > refuses two different bare plans`, `${D1} > refuses two different bare plans in the other order`, `${D1} > refuses two different fenced plans`, `${D1} > refuses a fenced plan and a different bare plan`,
      `${D1} > verify safety > never turns a rejection into approval because a schema-valid approval template is also present`, `${D1} > execute envelope > refuses two different envelopes`,
      `${D2} > refuses a verify answer that carries an approval template next to the rejection`] },
  { id: "M4", file: P, search: `    } else if (c === '"' && depth > 0) inString = true;\n`, replace: `    }\n`, tests: [K1],
    red: [`${D1} > accepts the one plan in an object with a closing brace inside a string`] },
  { id: "M5", file: P, search: String.raw`      else if (c === "\\") escaped = true;` + "\n", replace: "", tests: [K1],
    red: [`${D1} > accepts the one plan in an object with escaped quotes around a brace`] },
  { id: "M6", file: P, search: `} else if (c === '"' && depth > 0) inString = true;`, replace: `} else if (c === '"') inString = true;`, tests: [K1],
    red: [`${D1} > accepts the one plan in prose with a stray quote before the object`] },
  { id: "M7", file: P, search: `.filter((value) => accepts(value))`, replace: `.filter(() => true)`, tests: [K1],
    red: [`${D1} > accepts the one plan in prose quoting an example object before the real one`, `${D1} > refuses a plan with an extra key`, `${D1} > verify safety > accepts the rejection after a fenced example that is not a verification`] },
  { id: "M8", file: A, search: `        await writeFile(join(outcome.evidenceDir, "final-extraction.json"), JSON.stringify({ method: extraction.method, candidates: extraction.candidates, valid: extraction.valid, originalBytes: Buffer.byteLength(outcome.final, "utf8") }), { mode: 0o600 });\n`, replace: "", tests: [K2],
    red: [`${D2} > extracts the one plan from decorated prose and records how`, `${D2} > keeps today's error text and records the refused candidates before decoding`, `${D2} > refuses a verify answer that carries an approval template next to the rejection`, `${D2} > extracts a complete execution envelope from prose`, `${D2} > extracts a partial execution envelope from prose`] },
  { id: "M9", file: A, search: `if (extraction.method === "candidate" || (extraction.method === "none" && extraction.candidates > 0)) {`, replace: `{`, tests: [K2],
    red: [`${D2} > writes no extraction evidence for a compliant whole answer`, `${D2} > writes no extraction evidence when no candidate parses`, `${D2} > decodes a bare array holding the plan as a whole answer, failing as today`] },
  { id: "M10", file: A, search: `const final = extraction.method === "candidate" ? JSON.stringify(extraction.value) : outcome.final;`, replace: `const final = extraction.method === "candidate" && phase !== "execute" ? JSON.stringify(extraction.value) : outcome.final;`, tests: [K2],
    red: [`${D2} > extracts a complete execution envelope from prose`, `${D2} > extracts a partial execution envelope from prose`] },
  { id: "M11", file: R, search: `    "This is the planning phase only. The workspace is read-only: do not create, edit or delete files, do not run apply_patch, and do not carry out the task. A later execute phase does the work this plan describes.",\n`, replace: "", tests: [K3],
    red: [`${D3} > tells the planner the phase is read-only, right after the task line`] },
  { id: "M12", file: R, search: `    "Constraints (they bind the execute phase; plan for them, do not act on them now):",`, replace: `    "Constraints:",`, tests: [K3],
    red: [`${D3} > labels the planner's constraints as binding the execute phase`] },
  { id: "M13", file: R, search: `    "This is the verify phase. Do not create, edit or delete files; run commands only to check the attempt.",\n`, replace: "", tests: [K3],
    red: [`${D3} > tells the verifier not to edit files, right after the task line`] },
  { id: "M14a", file: R, search: `    'Return an object with {"summary": string, "primaryTargetPaths": string[]}.',\n    FINAL_MESSAGE_LINE,\n`, replace: `    'Return an object with {"summary": string, "primaryTargetPaths": string[]}.',\n`, tests: [K3],
    red: [`${D3} > ends the planner prompt with the final-message line`] },
  { id: "M14b", file: R, search: "    `If execute is aborted, you may have up to ${contract.executionPolicy.partialOutcomeRecoveryWindowMs}ms to flush one final execute-phase result.`,\n    FINAL_MESSAGE_LINE,\n",
    replace: "    `If execute is aborted, you may have up to ${contract.executionPolicy.partialOutcomeRecoveryWindowMs}ms to flush one final execute-phase result.`,\n", tests: [K3, K2],
    red: [`${D3} > ends the executor prompt with the final-message line`, `${D4} > puts codex's envelope line after the executor's final-message line`] },
  { id: "M14c", file: R, search: `"stopSignals": string[]}.',\n    FINAL_MESSAGE_LINE,\n`, replace: `"stopSignals": string[]}.',\n`, tests: [K3],
    red: [`${D3} > ends the verifier prompt with the final-message line`] },
  { id: "M15a", file: R, search: "    \"Return JSON only.\",\n    `Plan one isolated", replace: "    \"Return JSON only.\",\n    \"Inserted before line 2.\",\n    `Plan one isolated", tests: [K3],
    red: [`${D3} > keeps the first two lines of every prompt`] },
  { id: "M15b", file: R, search: "    \"Return JSON only.\",\n    `Verify task", replace: "    \"Return JSON only.\",\n    \"Inserted before line 2.\",\n    `Verify task", tests: [K3],
    red: [`${D3} > keeps the first two lines of every prompt`] },
];
const env = { ...process.env, ECC_GATEGUARD: "off", DISABLE_OMC: "1" };
function run(id, tests) {
  const report = join(out, `${id}.json`);
  spawnSync(join(copy, "node_modules/.bin/vitest"), ["run", ...tests, "--reporter=json", `--outputFile=${report}`], { cwd: copy, env, stdio: "ignore" });
  try {
    const r = JSON.parse(readFileSync(report, "utf8"));
    return { total: r.numTotalTests, failed: r.testResults.flatMap((f) => [...(f.assertionResults.length === 0 && f.status === "failed" ? [`file failed: ${f.name}: ${f.message}`] : []), ...f.assertionResults.filter((t) => t.status === "failed").map((t) => [...t.ancestorTitles, t.title].join(" > "))]) };
  } catch (error) { return { total: 0, failed: [`report unreadable: ${error}`] }; }
}
const results = [];
const baseline = run("M0", [K1, K2, K3]);
results.push({ id: "M0", total: baseline.total, failed: baseline.failed, ok: baseline.failed.length === 0 && baseline.total === 53 });
for (const m of mutations) {
  const path = join(copy, m.file), original = readFileSync(path, "utf8");
  const count = original.split(m.search).length - 1;
  if (count !== 1) { results.push({ id: m.id, ok: false, error: `search matched ${count} times` }); continue; }
  writeFileSync(path, original.replace(m.search, () => m.replace));
  const outcome = run(m.id, m.tests);
  writeFileSync(path, original);
  const restored = readFileSync(path, "utf8") === original;
  const missing = m.red.filter((name) => !outcome.failed.includes(name));
  results.push({ id: m.id, failed: outcome.failed, missing, restored, ok: restored && missing.length === 0 });
}
writeFileSync(join(out, "summary.json"), JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
```

Run it:

```bash
node "$SCRATCH/run-mutations.mjs" "$SCRATCH/mut" "$SCRATCH/mutations" > "$SCRATCH/mutations-run.txt" 2>&1; echo rc=$?
rtk proxy git -C "$SCRATCH/mut" status --porcelain > "$SCRATCH/mut-status.txt" 2>&1
```

Read `$SCRATCH/mutations/summary.json` whole. Pass: rc 0; `M0` ok (53 tests, none failed); every `M1`…`M15b` has `missing: []` and `restored: true`; `mut-status.txt` shows only `?? node_modules`. A mutation whose expected red is missing is a criterion that cannot fail: stop and report it (do not edit the expected list to fit). Note: M9 and M10 leave the adapter source non-typechecking or semantically odd on purpose; vitest does not typecheck, so they run.

- [ ] **Step 5: Discard the copy and prove the worktree untouched**

```bash
rm -rf "$SCRATCH/mut"
rtk proxy git -C "$W" diff > "$SCRATCH/restore/after.diff" 2>&1; rtk proxy git -C "$W" diff --cached > "$SCRATCH/restore/after.cached" 2>&1
wc -c "$SCRATCH/restore/after.diff" "$SCRATCH/restore/after.cached" > "$SCRATCH/restore/after-bytes.txt"
cmp "$SCRATCH/restore/before.diff" "$SCRATCH/restore/after.diff"; echo diff-cmp rc=$?
cmp "$SCRATCH/restore/before.cached" "$SCRATCH/restore/after.cached"; echo cached-cmp rc=$?
```

Pass: both `cmp` rc 0 and the byte counts in `before-bytes.txt` and `after-bytes.txt` are equal (both 0 when K1–K3 are committed). `$SCRATCH/mut` lives only under the session scratchpad and holds no user data.

- [ ] **Step 6: Report** (no commit). Report: gate rc values and `counts.txt` against the baseline; the `summary.json` verdict per mutation; the restore byte counts with the measuring commands; the commit subjects of K1–K3 (not hashes). Push and merge are the human's (ccloop Rule 13); Orca re-pins after the human pushes (spec §5).
