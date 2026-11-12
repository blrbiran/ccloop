// Orca tester issue #274 (Orca session 7e164691, tester follow-up H). A 32M-token codex run failed with only
// `codex-result-invalid`: the agent wrote `commandOutputs` as a string, and nothing said which field. Now every adapter's
// execute decode failure names the first field the strict shape refused, with what it expected and what it received:
// after the evidence directory in the error (the error code and its prefix are unchanged; Orca matches on them), in
// decode-error.txt, in the failure cause's detail (the text Orca already reads through collect), and, for codex and
// claude, in execution-format-issues.json. execution-normalization.json keeps its exact shape: Orca parses it strictly.
// The schema is not loosened: a string commandOutputs still fails.
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { runLoop } from "../../src/controller/runLoop.js";
import { ExecutionFormatFailure } from "../../src/controller/executionFormatFailure.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { executionFormatFieldDetail, executionFormatFields } from "../../src/runtime/executionNormalizer.js";
import { decodeOmpPhase } from "../../src/runtime/omp/ompProtocol.js";
import { codexFixture } from "./codex/fixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const fields = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: ["ran"], stdoutStderrLog: "log" };
const { commandOutputs: _dropped, ...missing } = fields;
const SHAPES = [
  { name: "a string", body: { ...fields, commandOutputs: "Pre-fix targeted run ... FAIL, 4 failing tests" }, received: "string" },
  { name: "an object", body: { ...fields, commandOutputs: { cmd: "npm test", out: "ok" } }, received: "object" },
  { name: "missing", body: missing, received: "undefined" },
] as const;

async function codexWith(final: string) {
  const f = await codexFixture("final-text");
  dirs.push(f.dir);
  const finals = join(f.dir, "finals.json");
  await writeFile(finals, JSON.stringify({ execute: final }));
  const config = { ...f.config, command: [...f.config.command, finals] };
  const call = async () => { const root = join(f.runDir, "codex", "1", "execute"); const [only] = await readdir(root); return join(root, only!); };
  return { ...f, config, call };
}
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error as Error & Record<string, unknown>);

describe("codex execute: the decode failure names the refused field (#274)", () => {
  for (const shape of SHAPES) it(`commandOutputs ${shape.name}`, async () => {
    const f = await codexWith(JSON.stringify({ result: shape.body }));
    const error = await rejection(new CodexAdapter(f.config).execute(f.context));
    const call = await f.call(), detail = `commandOutputs: expected array, received ${shape.received}`;
    expect(error).toBeInstanceOf(ExecutionFormatFailure); // still the execution format failure, not a loosened success
    expect(error.message).toBe(`Error: codex-result-invalid: ${call}: ${detail}`);
    expect(error.formatDetail).toBe(`execution-format-invalid: ${detail}`);
    expect(await readFile(join(call, "decode-error.txt"), "utf8")).toBe(`Error: codex-result-invalid: ${detail}`);
    expect(JSON.parse(await readFile(join(call, "execution-format-issues.json"), "utf8"))).toEqual({ schema: "ccloop-execution-format-issues-v1",
      issues: [{ path: "commandOutputs", expected: "array", received: shape.received, message: shape.received === "undefined" ? "Required" : `Expected array, received ${shape.received}` }] });
    // Orca's runDiagnosis parses this file with a strict schema: no new key may appear in it.
    const normalization = JSON.parse(await readFile(join(call, "execution-normalization.json"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(Object.keys(normalization).sort()).toEqual(["diagnostic", "reason", "status"]);
    expect(Object.keys(normalization.diagnostic!).sort()).toEqual(["candidates", "hidden", "method", "originalBytes", "valid"]);
  }, 30_000);

  it("a final that is not one JSON object keeps today's text and writes no issues file", async () => {
    const final = `Done: ${JSON.stringify({ result: { ...fields, commandOutputs: "x" } })}`;
    const f = await codexWith(final);
    const error = await rejection(new CodexAdapter(f.config).execute(f.context));
    const call = await f.call();
    let parse = ""; try { JSON.parse(final); } catch (e) { parse = String(e); }
    expect(error.message).toBe(`${parse}: ${call}`);
    expect(error.formatDetail).toBeUndefined();
    expect(existsSync(join(call, "execution-format-issues.json"))).toBe(false);
  }, 30_000);

  it("the detail is bounded to 512 bytes on one line", async () => {
    const f = await codexWith(JSON.stringify({ result: { ...fields, [`键\n${"键".repeat(400)}`]: 1 } }));
    const error = await rejection(new CodexAdapter(f.config).execute(f.context));
    const call = await f.call();
    const detail = error.message.slice(`Error: codex-result-invalid: ${call}: `.length);
    expect(detail.startsWith("(top level): Unrecognized key(s) in object: '键 键")).toBe(true);
    expect(Buffer.byteLength(detail, "utf8")).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(detail, "utf8")).toBeGreaterThan(500);
    expect(detail).not.toMatch(/[\r\n�]/);
  }, 30_000);

  it("reaches Orca through the run's stopReason and failure cause detail (runLoop over the codex adapter)", async () => {
    const f = await codexWith(JSON.stringify({ result: SHAPES[0].body }));
    const state = await runLoop(f.contract, f.runDir, new CodexAdapter(f.config));
    expect(state.status).toBe("failed");
    expect(state.stopReason).toMatch(/codex-result-invalid: .*: commandOutputs: expected array, received string$/);
    expect(state.failureCause).toMatchObject({ cause: "unknown", phase: "execute", detail: "execution-format-invalid: commandOutputs: expected array, received string" });
  }, 60_000);
});

const fakeClaude = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));
async function claudeWith(reported: Record<string, unknown>) {
  const f = await codexFixture("unused");
  dirs.push(f.dir);
  const marker = join(f.dir, "claude-marker.json");
  await writeFile(`${marker}.reported.json`, JSON.stringify(reported));
  const config: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, fakeClaude, "reported", marker], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } };
  return { ...f, config };
}

describe("claude execute: the decode failure names the refused field (#274)", () => {
  // The fake merges <marker>.reported.json into its valid answer, so it can replace commandOutputs but not remove it.
  for (const shape of SHAPES.slice(0, 2)) it(`commandOutputs ${shape.name}`, async () => {
    const f = await claudeWith({ commandOutputs: (shape.body as { commandOutputs?: unknown }).commandOutputs });
    const error = await rejection(new ClaudeAgentAdapter(f.config).execute(f.context));
    const detail = `commandOutputs: expected array, received ${shape.received}`;
    const evidenceDir = error.message.match(/^claude-result-invalid: (.*): commandOutputs: /)?.[1];
    expect(evidenceDir).toBeDefined();
    expect(error.message).toBe(`claude-result-invalid: ${evidenceDir}: ${detail}`);
    expect(error.formatDetail).toBe(`execution-format-invalid: ${detail}`);
    expect(await readFile(join(evidenceDir!, "decode-error.txt"), "utf8")).toBe(`execution-format-invalid: ${detail}`);
    expect(JSON.parse(await readFile(join(evidenceDir!, "execution-format-issues.json"), "utf8"))).toMatchObject({ schema: "ccloop-execution-format-issues-v1",
      issues: [{ path: "commandOutputs", expected: "array", received: shape.received }] });
  }, 30_000);

  it("reaches Orca through the run's failure cause detail (runLoop over the claude adapter)", async () => {
    const f = await claudeWith({ commandOutputs: "one string" });
    const state = await runLoop(f.contract, f.runDir, new ClaudeAgentAdapter(f.config));
    expect(state.status).toBe("failed");
    expect(state.stopReason).toMatch(/claude-result-invalid: .*: commandOutputs: expected array, received string$/);
    expect(state.failureCause).toMatchObject({ phase: "execute", detail: "execution-format-invalid: commandOutputs: expected array, received string" });
  }, 60_000);
});

const ompFailureOf = (body: unknown) => {
  const answer = { role: "assistant", content: [{ type: "text", text: JSON.stringify(body) }], provider: "gateway", model: "model-a", stopReason: "stop",
    usage: { input: 8, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 14 } };
  const events = [{ type: "agent_start" }, { type: "message_end", message: answer }, { type: "agent_end", isTerminal: true, yielded: true }].map((row) => JSON.stringify(row)).join("\n");
  try { decodeOmpPhase("execute", events, "gateway/model-a"); } catch (error) { return error as Error & Record<string, unknown>; }
  throw new Error("expected a failure");
};

describe("omp execute: the decode failure names the refused field (#274; the omp detail is issue 125's)", () => {
  for (const shape of SHAPES) it(`commandOutputs ${shape.name}`, () => {
    const error = ompFailureOf(shape.body);
    expect(error.message).toBe("omp-result-invalid"); // omp's error stays bare: saved-result recovery compares it
    expect(error.formatDetail).toBe(`execution-format-invalid: commandOutputs: ${shape.received === "undefined" ? "Required" : `Expected array, received ${shape.received}`}`);
  });
});

describe("executionFormatFields (#274)", () => {
  it("judges a partial answer against the partial shape and names a wrong literal's expected and received", () => {
    const got = executionFormatFields(JSON.stringify({ ...fields, completionStatus: "partial", failureType: "nope", failureMessage: "m" }));
    expect(got[0]).toMatchObject({ path: "failureType" });
    const literal = executionFormatFields(JSON.stringify({ ...fields, completionStatus: "done", failureType: "error", failureMessage: "m" }));
    expect(literal[0]).toMatchObject({ path: "completionStatus", expected: '"partial"', received: '"done"' });
    expect(executionFormatFieldDetail(literal)).toBe('completionStatus: expected "partial", received "done"');
  });
  it("an accepted answer and a non-JSON final have no fields", () => {
    expect(executionFormatFields(JSON.stringify({ result: fields }))).toEqual([]);
    expect(executionFormatFields("not json")).toEqual([]);
    expect(executionFormatFieldDetail([])).toBeNull();
  });
});
