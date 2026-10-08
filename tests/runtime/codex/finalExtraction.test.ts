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
