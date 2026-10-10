import { afterEach, describe, expect, it } from "vitest";
import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeCodexResult, extractFinalObject, phaseFinalAccepts, phaseJsonSchema } from "../../../src/runtime/codex/protocol.js";
import { buildVerifierPrompt } from "../../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { codexFixture } from "./fixture.js";

const core = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "log" };
const events = '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}\n';
const report = { schema: "task-result-v1", goal: "Set answer", completedWork: ["Changed answer"], conclusions: [], outputs: [{ path: "answer.txt", label: "Answer" }], limitations: [] };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

// Break: optional metadata in the strict execution schema must not reject otherwise valid work or alter charged usage.
describe("optional Codex execute explanation", () => {
  it("requests the logical report in the original executor call", async () => {
    const f = await codexFixture("ok"); dirs.push(f.dir);
    await new CodexAdapter(f.config).execute(f.context);
    const marker = JSON.parse(await readFile(f.marker, "utf8"));
    expect(marker.prompt).toContain("task-result-v1");
    expect(marker.prompt).toContain("completedWork");
    expect((await readFile(f.marker + ".calls", "utf8")).trim().split("\n")).toEqual(["execute"]);
  });
  it("does not let optional explanation alter the actual verifier's input", async () => {
    const f = await codexFixture("unused"); dirs.push(f.dir);
    const baseline = buildVerifierPrompt({ ...f.context, execution: core });
    expect(buildVerifierPrompt({ ...f.context, execution: { ...core, taskResult: { result: 0 } } })).toBe(baseline);
  });
  it.each([report, null, 0, { result: 0 }, "x".repeat(65535)].map((taskResult, index) => ({ taskResult, index })))("preserves complete core and usage with report case $index", ({ taskResult }) => {
    const answer = decodeCodexResult("execute", events, JSON.stringify({ ...core, taskResult }));
    expect(answer).toMatchObject({ ...core, tokenUsage: 15 });
    expect(answer.usageEvidence?.normalizedTotal).toBe(15);
  });
  it("preserves a real partial outcome with invalid report", () => {
    const partial = { ...core, completionStatus: "partial", failureType: "timeout", failureMessage: "stopped" };
    expect(decodeCodexResult("execute", events, JSON.stringify({ ...partial, taskResult: { result: 0 } }))).toMatchObject({ ...partial, tokenUsage: 15 });
  });
  it("keeps invalid execution cores refused regardless of optional report", () => {
    expect(() => decodeCodexResult("execute", events, JSON.stringify({ ...core, diffPatch: 2, taskResult: report }))).toThrow("codex-result-invalid");
    expect(() => decodeCodexResult("execute", events, JSON.stringify({ ...core, failureType: "timeout", taskResult: report }))).toThrow("codex-result-invalid");
    expect(() => decodeCodexResult("execute", events, '{')).toThrow("codex-result-invalid");
  });
  // Break: walking report result keys as real answers creates false ambiguity; walking report depth hides a valid answer.
  it.each([JSON.stringify({ result: 0 }), '{"a":'.repeat(2000) + '{}' + '}'.repeat(2000)])("extracts a fenced core without traversing report contents", raw => {
    const text = 'Done.\n```json\n{"result":' + JSON.stringify(core).slice(0,-1) + ',"taskResult":' + raw + '}}\n```';
    expect(extractFinalObject(text, phaseFinalAccepts("execute"))).toMatchObject({ method: "candidate", candidates: 1, valid: 1 });
  });
  it("does not collapse distinct oversized reports into one decorated answer after bounding", () => {
    const one = { result: { ...core, taskResult: "x".repeat(65535) + "A" } };
    const two = { result: { ...core, taskResult: "x".repeat(65535) + "B" } };
    expect(extractFinalObject("First: " + JSON.stringify(one) + " Second: " + JSON.stringify(two), phaseFinalAccepts("execute")).method).toBe("none");
  });
  it("refuses distinct deep reports even when their diagnostics share the same prefix", () => {
    const deep = (leaf: number) => '{"a":'.repeat(2000) + '{"leaf":' + leaf + '}' + '}'.repeat(2000);
    const envelope = (raw: string) => '{"result":' + JSON.stringify(core).slice(0,-1) + ',"taskResult":' + raw + '}}';
    expect(extractFinalObject("First: " + envelope(deep(1)) + " Second: " + envelope(deep(2)), phaseFinalAccepts("execute")).method).toBe("none");
  });
  it("keeps key-reordered oversized report objects a single candidate despite different diagnostic prefixes", () => {
    const left = "x".repeat(65535);
    const one = { result: { ...core, taskResult: { left, right: "tail" } } };
    const two = { result: { ...core, taskResult: { right: "tail", left } } };
    expect(extractFinalObject("First: " + JSON.stringify(one) + " Second: " + JSON.stringify(two), phaseFinalAccepts("execute"))).toMatchObject({ method: "candidate", candidates: 1, valid: 1 });
  });
  it("keeps key-reordered equivalent deep-report answers a single candidate", () => {
    const deep = (leaf: string) => '{"a":'.repeat(2000) + leaf + '}'.repeat(2000);
    const envelope = (body: unknown, raw: string) => '{"result":' + JSON.stringify(body).slice(0,-1) + ',"taskResult":' + raw + '}}';
    const reordered = { stdoutStderrLog: "log", commandOutputs: [], diffPatch: "patch", changedFiles: ["answer.txt"] };
    const text = "First: " + envelope(core, deep('{"left":1,"right":2}')) + " Second: " + envelope(reordered, deep('{"right":2,"left":1}'));
    expect(extractFinalObject(text, phaseFinalAccepts("execute")).method).toBe("candidate");
  });
  it("does not let an orphan artifact object hide an independent execute envelope", () => {
    const wrapper = { orphan: { ...core, taskResult: { result: { ...core, diffPatch: "different" } } } };
    const text = "Actual: " + JSON.stringify({ result: core }) + " Other: " + JSON.stringify(wrapper);
    expect(extractFinalObject(text, phaseFinalAccepts("execute")).method).toBe("none");
  });
  it("still refuses two independent core answers", () => {
    const one = { result: { ...core, taskResult: { result: 0 } } };
    const two = { result: { ...core, diffPatch: "different", taskResult: report } };
    expect(extractFinalObject('First: ' + JSON.stringify(one) + ' Second: ' + JSON.stringify(two), phaseFinalAccepts("execute"))).toMatchObject({ method: "none" });
  });
  it("offers arbitrary optional JSON metadata in both execute schema alternatives", () => {
    const schema = phaseJsonSchema("execute") as { anyOf: Array<{ properties: Record<string, unknown>; required: string[] }> };
    for (const alternative of schema.anyOf) {
      expect(alternative.properties.taskResult).toEqual({});
      expect(alternative.required).not.toContain("taskResult");
    }
  });
  it.each(["whole", "fenced"])("bounds very deep report before %s adapter serialization", async kind => {
    const f = await codexFixture("final-text"); dirs.push(f.dir);
    const raw = '{"result":' + JSON.stringify(core).slice(0,-1) + ',"taskResult":' + '{"a":'.repeat(20000) + '{}' + '}'.repeat(20000) + '}}';
    const finals = join(f.dir, "finals.json");
    await writeFile(finals, JSON.stringify({ execute: kind === "whole" ? raw : 'Done.\n```json\n' + raw + '\n```' }));
    const adapter = new CodexAdapter({ ...f.config, command: [...f.config.command, finals] });
    const answer = await adapter.execute(f.context);
    expect(answer).toMatchObject({ ...core, tokenUsage: 15 });
    expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeLessThan(70000);
    expect((await readFile(f.marker + '.calls', 'utf8')).trim().split('\n')).toEqual(['execute']);
  });
});
