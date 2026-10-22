import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { runLoop } from "../../src/controller/runLoop.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { buildVerifierPrompt } from "../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { normalizeExecutionFinal } from "../../src/runtime/executionNormalizer.js";
import { OmpAdapter } from "../../src/runtime/omp/ompAdapter.js";
import { dropUnreported } from "../../src/runtime/reportedDecisions.js";
import type { ExecutionResult } from "../../src/runtime/types.js";
import { codexFixture } from "./codex/fixture.js";

// The `flow` answer key (ccloop spec 2026-10-22-flow-answer-key-design.md §3, §4, §7). Orca's flow engine reads a top-level
// `flow` = {needs?, candidates?, effect?} from the collected run report: `needs` parks a step for a person, `candidates` feed
// a later ask step, `effect.remoteId` lands on the effect record. Why each case matters: before this, every kind refused or
// could not send it, so a flow step's request for a person was silently lost; codex can say "no url" only as null, which
// Orca's strict parser refuses (voiding the whole flow, needs included); and an answer that reports no flow must keep
// today's bytes, because saved-result recovery pins the hash of the normalized execution.
const complete = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: ["ran"], stdoutStderrLog: "ok" };
const needs = { kind: "confirmation", what: "publish the draft", payloadSummary: "title + 3 images" };
const effect = { remoteId: "media-42" };
const orcaFlow = { needs, effect };
const codexFlow = { needs, effect: { ...effect, url: null } };
const claudeFlow = { needs: { kind: "input", question: "Which audience?", candidates: ["devs", "managers"] }, candidates: { title: { items: ["A", "B"], recommended: 1 } }, effect: { remoteId: "m", url: "https://x.example/m" } };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const normalized = (body: unknown) => {
  const result = normalizeExecutionFinal(JSON.stringify(body));
  if (result.status !== "available") throw new Error(`unavailable: ${result.reason}`);
  return result.execution as Record<string, unknown>;
};

describe("criterion 1: codex's wire schema carries flow, closed and nullable", () => {
  it("in each of the 2x2 alternatives, flow is required and is exactly anyOf[strict {needs, effect}, null] -- no candidates", async () => {
    const f = await codexFixture("ok"); dirs.push(f.dir);
    await new CodexAdapter(f.config).execute(f.context);
    const [call] = await readdir(join(f.runDir, "codex", "1", "execute"));
    const schema = JSON.parse(await readFile(join(f.runDir, "codex", "1", "execute", call!, "schema.json"), "utf8"));
    const alternatives = (schema.properties.result.anyOf as Array<{ anyOf: Array<{ properties: Record<string, unknown>; required: string[] }> }>).flatMap((phase) => phase.anyOf);
    expect(alternatives).toHaveLength(4);
    const string = { type: "string" }, nullString = { anyOf: [string, { type: "null" }] };
    const strict = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
    for (const part of alternatives) {
      expect(part.required).toContain("flow");
      expect(Object.keys(part.properties).at(-1)).toBe("flow");
      expect(part.properties.flow).toEqual({ anyOf: [strict({
        needs: { anyOf: [
          strict({ kind: { type: "string", enum: ["confirmation"] }, what: string, payloadSummary: string }),
          strict({ kind: { type: "string", enum: ["input"] }, question: string, candidates: { type: "array", items: string } }),
          { type: "null" },
        ] },
        effect: { anyOf: [strict({ remoteId: string, url: nullString }), { type: "null" }] },
      }), { type: "null" }] });
    }
  });
});

describe("criterion 2: the shared unreported step treats flow as it treats debug", () => {
  it("flow null, and codex's all-null flow, normalize to the bytes of the answer without flow (direct and wrapped)", () => {
    for (const wrapped of [false, true]) {
      const plain = JSON.stringify(normalized(wrapped ? { result: complete } : complete));
      for (const flow of [null, { needs: null, effect: null }]) {
        const answer = { ...complete, flow };
        expect(JSON.stringify(normalized(wrapped ? { result: answer } : answer))).toBe(plain);
      }
    }
    expect(JSON.stringify(dropUnreported({ ...complete, flow: null }))).toBe(JSON.stringify(complete));
  });

  it("effect.url null is removed and remoteId kept: codex's answer lands as Orca's shape", () => {
    expect(normalized({ result: { ...complete, decisions: null, debug: null, flow: codexFlow } }).flow).toEqual(orcaFlow);
    expect(dropUnreported({ ...complete, flow: { needs: null, effect: { remoteId: "m", url: null } } })).toEqual({ ...complete, flow: { effect: { remoteId: "m" } } });
  });

  it("claude's record candidates and every non-null member are kept as given", () => {
    expect(dropUnreported({ ...complete, flow: structuredClone(claudeFlow) })).toEqual({ ...complete, flow: claudeFlow });
  });

  it("a flow over 65536 bytes of UTF-8 JSON is removed and the answer is still available", () => {
    const over = normalized({ ...complete, flow: { needs: { kind: "input", question: "q".repeat(70000), candidates: [] } }, debug: { choseInstead: "x" } });
    expect(Object.hasOwn(over, "flow")).toBe(false);
    expect(over.debug).toEqual({ choseInstead: "x" });
  });
});

describe("criterion 3 (C1): flow's contents never fail a run and are opaque to the answer scanner", () => {
  it.each([
    ["a string", "not an object"],
    ["an object carrying an answer key", { effect, changedFiles: ["other.txt"] }],
    ["a needs carrying `result`", { needs: { ...needs, result: "kept" } }],
  ])("%s keeps the answer available and is kept as given", (_name, flow) => {
    for (const wrapped of [false, true]) {
      const answer = { ...complete, flow };
      const execution = normalized(wrapped ? { result: answer } : answer);
      expect(execution.flow).toEqual(flow);
      expect(execution).toMatchObject(complete);
    }
  });

  it("an unknown top-level key beside flow is still refused", () => {
    expect(normalizeExecutionFinal(JSON.stringify({ ...complete, flow: orcaFlow, extra: 1 })).status).toBe("unavailable");
  });
});

const fakeClaude = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));
const fakeOmp = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));

async function adapterFor(kind: "codex" | "claude" | "omp", reported: unknown) {
  const f = await codexFixture("reported"); dirs.push(f.dir);
  await writeFile(`${f.marker}.reported.json`, JSON.stringify(reported));
  if (kind === "codex") return { f, adapter: new CodexAdapter(f.config) };
  if (kind === "claude") {
    const config: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: "claude",
      installation: { kind: "claude", command: [process.execPath, fakeClaude, "reported", f.marker], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
      selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } };
    return { f, adapter: new ClaudeAgentAdapter(config) };
  }
  const binary = join(f.dir, "omp");
  await writeFile(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeOmp)} ${JSON.stringify(f.marker)} "$@"\n`, { mode: 0o700 });
  const config: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: "omp",
    installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
    selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" } };
  return { f, adapter: new OmpAdapter(config) };
}

describe("criterion 4: every kind persists flow in attempts/1/execution.json as Orca's shape", { timeout: 60_000 }, () => {
  it.each([
    ["codex", { decisions: null, debug: null, flow: codexFlow }, orcaFlow],
    ["claude", { flow: claudeFlow }, claudeFlow],
    ["omp", { flow: orcaFlow }, orcaFlow],
  ] as const)("%s", async (kind, reported, expected) => {
    const { f, adapter } = await adapterFor(kind, reported);
    f.contract.executionPolicy.perAttemptTimeoutMs = 15_000;
    const state = await runLoop(f.contract, f.runDir, adapter);
    expect(state.status).toBe("succeeded");
    const text = await readFile(join(f.runDir, "attempts", "1", "execution.json"), "utf8");
    expect((JSON.parse(text) as Record<string, unknown>).flow).toEqual(expected);
    if (kind === "claude") {
      // The fake never validates against --json-schema; the real CLI refuses an undeclared property, so pin the sent schema.
      const argv = (await readFile(`${f.marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      const schemas = argv.map((args) => JSON.parse(args[args.indexOf("--json-schema") + 1]!) as { properties: Record<string, unknown>; required: string[] });
      const execute = schemas.find((schema) => "changedFiles" in schema.properties)!;
      expect(execute.properties.flow).toEqual({});
      expect(execute.required).not.toContain("flow");
    }
  });
});

describe("criterion 6: the verifier never sees flow", () => {
  it("an execution with flow gives a verifier prompt byte-identical to the one without", async () => {
    const f = await codexFixture("ok"); dirs.push(f.dir);
    const execution = { ...complete, tokenUsage: 1 } as ExecutionResult;
    const without = buildVerifierPrompt({ ...f.context, execution });
    const withFlow = buildVerifierPrompt({ ...f.context, execution: { ...execution, flow: orcaFlow } as ExecutionResult });
    expect(withFlow).toBe(without);
    expect(without).toContain("answer.txt");
  });
});
