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
    { name: "an answer wrapped in a valid object", text: `Result: ${JSON.stringify({ note: plan })}`, value: plan },
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
    // Fail closed on hidden text (spec 3.2, amended after the K1 review): text the brace matcher cannot read could hold another answer.
    { name: "a fence after prose with an unclosed brace", text: `Use { for maps.\n${fence("json", P)}\nDone`, candidates: 0, valid: 0 },
    { name: "a fence inside a brace-wrapped note that is not JSON", text: `{ note:\n${fence("", P)}\n}`, candidates: 0, valid: 0 },
    { name: "a valid answer of another phase", text: `Verdict: ${JSON.stringify(rejection)}`, candidates: 1, valid: 0 },
  ]) it(`refuses ${name}`, () => {
    expect(extractPlan(text)).toEqual({ method: "none", candidates, valid });
  });

  // Spec §7 rule 3 (final-review fix, 2026-10-08; replaces K4's stack-size-dependent "too deep to serialise" test): the walk
  // is bounded by an explicit depth (1 000) and node count (100 000). Past either limit the unread rest could hold another
  // answer, so the plan found before it is refused; at the limit it is still read.
  const nested = (n: number) => `${'{"a":'.repeat(n - 1)}{}${"}".repeat(n - 1)}`;
  const wide = (n: number) => `{"k":[${Array(n).fill("{}").join(",")}]}`;
  it("reads a plan next to an object nested exactly 1 000 deep", () => {
    expect(extractPlan(`Plan: ${P}\nTrace: ${nested(1_000)}`)).toEqual({ method: "candidate", value: plan, candidates: 2, valid: 1 });
  });
  it("refuses a plan next to an object nested 1 001 deep (depth limit)", () => {
    expect(extractPlan(`Plan: ${P}\nTrace: ${nested(1_001)}`)).toEqual({ method: "none", candidates: 1, valid: 1 });
  });
  it("reads a plan next to objects that bring the message to exactly 100 000 object nodes", () => {
    // 1 plan + 1 wrapper + 99 998 empty objects.
    expect(extractPlan(`Plan: ${P}\nTrace: ${wide(99_998)}`)).toEqual({ method: "candidate", value: plan, candidates: 2, valid: 1 });
  });
  it("refuses a plan next to objects that bring the message past 100 000 object nodes (node limit)", () => {
    expect(extractPlan(`Plan: ${P}\nTrace: ${wide(99_999)}`)).toEqual({ method: "none", candidates: 1, valid: 1 });
  });

  // Spec §7 rule 1: an answer-shaped node (one carrying the phase's discriminating key) counts whether or not it is valid, so
  // a schema-valid example can never stand in for an off-schema real answer.
  it("refuses a schema-invalid real plan next to a valid example plan", () => {
    const text = `Example:\n${fence("json", O)}\nMy plan: ${JSON.stringify({ ...plan, risk: "low" })}`;
    expect(extractPlan(text)).toEqual({ method: "none", candidates: 2, valid: 1 });
  });
  // Spec §7 rule 3: the acceptance test (zod) runs only on answer-shaped nodes, so a message of many other objects costs no
  // schema work. Measured directly: the number of acceptance calls.
  it("runs the acceptance test only on answer-shaped nodes", () => {
    let calls = 0;
    const counting = Object.assign((value: unknown) => { calls++; return acceptsPlan(value); }, { keys: acceptsPlan.keys });
    const text = `${Array.from({ length: 1_000 }, (_, i) => `{"a":${i},"b":{"c":[{}]}}`).join("\n")}\n${P}`;
    expect(extractFinalObject(text, counting)).toEqual({ method: "candidate", value: plan, candidates: 1_001, valid: 1 });
    expect(calls).toBe(1);
  });

  describe("verify safety", () => {
    const acceptsVerify = phaseFinalAccepts("verify");
    const hiddenTemplate = `Template:\n${fence("json", JSON.stringify(approval))}\n`;
    // Each hides the real rejection from the brace pass while a fenced approval template stays visible: it must not be accepted.
    for (const { name, text } of [
      { name: "an unclosed brace before the rejection", text: `${hiddenTemplate}Placeholders look like {name. Actual: ${JSON.stringify(rejection)}` },
      { name: "a non-JSON wrapper around the rejection", text: `${hiddenTemplate}Actual: {verdict: ${JSON.stringify(rejection)}}` },
      { name: "a stray quote inside a brace span before the rejection", text: `${hiddenTemplate}A {5" screen} then ${JSON.stringify(rejection)}` },
    ]) it(`refuses the fenced approval template next to ${name}`, () => {
      const result = extractFinalObject(text, acceptsVerify);
      expect(result.method).toBe("none");
      expect(result.method === "none" ? result.candidates : -1).toBeGreaterThan(0);
    });
    it("sees a rejection nested inside another object, so a fenced approval template cannot win", () => {
      const text = `${hiddenTemplate}Actual: ${JSON.stringify({ note: rejection })}`;
      expect(extractFinalObject(text, acceptsVerify)).toEqual({ method: "none", candidates: 2, valid: 1 });
    });
    it("accepts a rejection nested inside another object when nothing else is valid", () => {
      expect(extractFinalObject(`Actual: ${JSON.stringify({ note: rejection })}`, acceptsVerify)).toEqual({ method: "candidate", value: rejection, candidates: 1, valid: 1 });
    });
    it("counts the same rejection with another key order once", () => {
      const reordered = Object.fromEntries(Object.entries(rejection).reverse());
      expect(extractFinalObject(`${JSON.stringify(rejection)} again ${JSON.stringify(reordered)}`, acceptsVerify)).toEqual({ method: "candidate", value: rejection, candidates: 1, valid: 1 });
    });
    // Spec §7 rule 1 reverses K1's "accepts the rejection after a fenced example that is not a verification": the example
    // carries `approved`, so it is answer-shaped and counts although it is invalid; two answer-shaped nodes are refused.
    it("refuses the rejection after a fenced answer-shaped example that is not a valid verification", () => {
      const text = `Example:\n${fence("json", '{"approved": "yes"}')}\nResult: ${JSON.stringify(rejection)}`;
      expect(extractFinalObject(text, acceptsVerify)).toEqual({ method: "none", candidates: 2, valid: 1 });
    });
    it("accepts a decorated rejection", () => {
      const result = extractFinalObject(`Verdict:\n${fence("json", JSON.stringify(rejection, null, 2))}\nDone.`, acceptsVerify);
      expect(result).toEqual({ method: "candidate", value: rejection, candidates: 1, valid: 1 });
      expect(result.method === "candidate" ? (result.value as { approved: unknown }).approved : undefined).toBe(false);
    });
    // Spec §7 rule 2: extraction only ever makes verify stricter. A decorated approval is not extracted; it fails as today.
    it("refuses a decorated approval", () => {
      expect(extractFinalObject(`Verdict: ${JSON.stringify(approval)}`, acceptsVerify)).toEqual({ method: "none", candidates: 1, valid: 0 });
      expect(extractFinalObject(`Verdict:\n${fence("json", JSON.stringify(approval))}`, acceptsVerify)).toEqual({ method: "none", candidates: 1, valid: 0 });
    });
    it("refuses a rejection with an extra key on its own (answer-shaped but invalid)", () => {
      expect(extractFinalObject(`Verdict: ${JSON.stringify({ ...rejection, reason: "tests fail" })}`, acceptsVerify)).toEqual({ method: "none", candidates: 1, valid: 0 });
    });
    // The final review's flip probes (scratchpad ccloop-final/flip.mjs): an off-schema real rejection next to a fenced,
    // schema-valid approval template was accepted as approval. Each must now be refused.
    const flipTemplate = (pretty: boolean) => `Expected format:\n${fence("json", pretty ? JSON.stringify(approval, null, 2) : JSON.stringify(approval))}\n`;
    for (const { name, text } of [
      { name: "a rejection with an extra key", text: `${flipTemplate(true)}My verdict: ${JSON.stringify({ ...rejection, reason: "tests fail" })}` },
      { name: "a rejection whose approved is the string \"false\"", text: `${flipTemplate(false)}My verdict: ${JSON.stringify({ ...rejection, approved: "false" })}` },
      { name: "a rejection missing keys", text: `${flipTemplate(false)}Verdict: ${JSON.stringify({ approved: false, evidence: ["test fails"] })}` },
    ]) it(`never accepts the approval template next to ${name}`, () => {
      expect(extractFinalObject(text, acceptsVerify)).toEqual({ method: "none", candidates: 2, valid: 0 });
    });
    it("never turns a rejection into approval because a schema-valid approval template is also present", () => {
      const template = `Template:\n${fence("json", JSON.stringify(approval, null, 2))}`, actual = `Actual: ${JSON.stringify(rejection)}`;
      expect(extractFinalObject(`${template}\n${actual}`, acceptsVerify)).toEqual({ method: "none", candidates: 2, valid: 1 });
      expect(extractFinalObject(`${actual}\n${template}`, acceptsVerify)).toEqual({ method: "none", candidates: 2, valid: 1 });
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
    // 4 MiB of unbalanced braces and quotes: the brace pass never returns to depth 0 after the first `{`, so the text hides
    // everything after it and the answer is refused (fail closed), quickly.
    const noise = '{"'.repeat(2 * 1024 * 1024);
    it("refuses a fenced plan after 4 MiB of unbalanced brace-quote noise in under 2 s", () => {
      const started = performance.now();
      const result = extractPlan(`${noise}\n${fence("json", P)}\n`);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result).toEqual({ method: "none", candidates: 0, valid: 0 });
    });
    it("answers none for a bare plan after the same noise in under 2 s", () => {
      const started = performance.now();
      const result = extractPlan(`${noise}${P}`);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result).toEqual({ method: "none", candidates: 0, valid: 0 });
    });
    it("finds a fenced plan after about 1 MiB of valid objects in under 2 s", () => {
      const started = performance.now();
      const result = extractPlan(`${'{"a":1}\n'.repeat(130_000)}${fence("json", P)}\n`);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result).toEqual({ method: "candidate", value: plan, candidates: 2, valid: 1 });
    });
    it("finds a plan after many distinct objects in under 2 s", () => {
      const started = performance.now();
      const result = extractPlan(`${Array.from({ length: 50_000 }, (_, i) => `{"a":${i}}`).join("\n")}\n${P}`);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result).toEqual({ method: "candidate", value: plan, candidates: 50_001, valid: 1 });
    });
    // The final review's perf2 probe (scratchpad ccloop-final/perf2.mjs): one 16 MiB span holding millions of empty objects
    // took 76 s (execute) and 9.6 s (plan) when every node was serialised and schema-checked. The node limit refuses it fast.
    const wideText = `x{"k":[${Array(Math.floor((16 * 1024 * 1024) / 3)).fill("{}").join(",")}]}`;
    for (const phase of ["plan", "execute"] as const) it(`refuses a 16 MiB span of millions of empty objects in under 3 s (${phase})`, () => {
      const started = performance.now();
      const result = extractFinalObject(wideText, phaseFinalAccepts(phase));
      expect(performance.now() - started).toBeLessThan(3000);
      expect(result).toEqual({ method: "none", candidates: 0, valid: 0 });
    });
  });
});
