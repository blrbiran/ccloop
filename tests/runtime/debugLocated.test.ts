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

// debug.located (ccloop spec 2026-10-22-debug-located-design.md §4, §7). Orca's coarse correction asks the debug agent where
// the person's sentence applies -- debug.located = {groupId?, runId?, decisionId?, paths[], because} -- and cites a located
// decision in the closing row. Why each case matters: codex's strict schema refused any `located` (so codex could never
// answer it), and codex can say "no group id" only as null, which Orca's strict parser rejects -- voiding the whole debug
// report, choseInstead included. So the wire must carry it, and the shared unreported step must remove those nulls.
const complete = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: ["ran"], stdoutStderrLog: "ok" };
const located = { decisionId: "decision-7", paths: ["src/parser.ts"], because: "the sentence names the parser's retry" };
const orcaDebug = { choseInstead: "fix the parser", located };
const codexNulls = { reproTests: null, reproCommand: null, reproduction: null, reproductionReason: null };
const codexDebug = { choseInstead: "fix the parser", ...codexNulls, located: { groupId: null, runId: null, ...located } };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("criterion 1: codex's wire schema carries debug.located, strict and nullable", () => {
  it("in each of the 2x2 alternatives, located is anyOf[strict object of the five members, null], ids nullable through anyOf", async () => {
    const f = await codexFixture("ok"); dirs.push(f.dir);
    await new CodexAdapter(f.config).execute(f.context);
    const [call] = await readdir(join(f.runDir, "codex", "1", "execute"));
    const schema = JSON.parse(await readFile(join(f.runDir, "codex", "1", "execute", call!, "schema.json"), "utf8"));
    const alternatives = (schema.properties.result.anyOf as Array<{ anyOf: Array<{ properties: Record<string, any> }> }>).flatMap((phase) => phase.anyOf);
    expect(alternatives).toHaveLength(4);
    const id = { anyOf: [{ type: "string" }, { type: "null" }] };
    for (const part of alternatives) {
      const debug = part.properties.debug.anyOf[0];
      expect(debug.required).toContain("located");
      expect(debug.properties.located).toEqual({ anyOf: [{
        type: "object",
        properties: { groupId: id, runId: id, decisionId: id, paths: { type: "array", items: { type: "string" } }, because: { type: "string" } },
        required: ["groupId", "runId", "decisionId", "paths", "because"],
        additionalProperties: false,
      }, { type: "null" }] });
      expect(Object.keys(debug.properties.located.anyOf[0].properties)).toEqual(["groupId", "runId", "decisionId", "paths", "because"]);
    }
  });
});

describe("criterion 2: the shared unreported step removes nulls inside an object member of debug", () => {
  it("removes null ids of located and keeps paths and because", () => {
    expect(dropUnreported({ ...complete, debug: { located: { groupId: null, runId: null, decisionId: null, paths: [], because: "not here" } } }))
      .toEqual({ ...complete, debug: { located: { paths: [], because: "not here" } } });
  });

  it("debug.located: null normalizes to the bytes of the answer without it", () => {
    expect(JSON.stringify(dropUnreported({ ...complete, debug: { choseInstead: "x", located: null } })))
      .toBe(JSON.stringify({ ...complete, debug: { choseInstead: "x" } }));
  });

  it("an object member left empty is removed, and a debug left empty with it", () => {
    expect(dropUnreported({ ...complete, debug: { choseInstead: "x", located: { groupId: null } } })).toEqual({ ...complete, debug: { choseInstead: "x" } });
    expect(JSON.stringify(dropUnreported({ ...complete, debug: { located: { groupId: null } } }))).toBe(JSON.stringify(complete));
  });

  it("arrays are untouched: reproTests [null] and located.paths [null] stay as given", () => {
    expect(dropUnreported({ ...complete, debug: { reproTests: [null] } })).toEqual({ ...complete, debug: { reproTests: [null] } });
    expect(dropUnreported({ ...complete, debug: { located: { paths: [null], because: "b" } } })).toEqual({ ...complete, debug: { located: { paths: [null], because: "b" } } });
  });

  it("codex's whole located answer passes the execute normalization and lands as Orca's shape", () => {
    const result = normalizeExecutionFinal(JSON.stringify({ result: { ...complete, decisions: null, debug: codexDebug } }));
    if (result.status !== "available") throw new Error(`unavailable: ${result.reason}`);
    expect((result.execution as Record<string, unknown>).debug).toEqual(orcaDebug);
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

describe("criterion 3: every kind persists debug.located in attempts/1/execution.json as Orca's shape", { timeout: 60_000 }, () => {
  it.each([
    ["codex", { decisions: null, debug: codexDebug }],
    ["claude", { debug: orcaDebug }],
    ["omp", { debug: orcaDebug }],
  ] as const)("%s", async (kind, reported) => {
    const { f, adapter } = await adapterFor(kind, reported);
    f.contract.executionPolicy.perAttemptTimeoutMs = 15_000;
    const state = await runLoop(f.contract, f.runDir, adapter);
    expect(state.status).toBe("succeeded");
    const text = await readFile(join(f.runDir, "attempts", "1", "execution.json"), "utf8");
    expect((JSON.parse(text) as Record<string, unknown>).debug).toEqual(orcaDebug);
  });
});

describe("criterion 6: the verifier never sees debug.located", () => {
  it("an execution whose debug has located gives a verifier prompt byte-identical to the one without debug", async () => {
    const f = await codexFixture("ok"); dirs.push(f.dir);
    const execution = { ...complete, tokenUsage: 1 } as ExecutionResult;
    const without = buildVerifierPrompt({ ...f.context, execution });
    const withLocated = buildVerifierPrompt({ ...f.context, execution: { ...execution, debug: orcaDebug } as ExecutionResult });
    expect(withLocated).toBe(without);
    expect(without).toContain("answer.txt");
  });
});
