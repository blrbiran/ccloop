import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexDescriptor } from "../../../src/agents/codex.js";
import { agentConfigHash } from "../../../src/agents/materialize.js";
import { parseInstallation } from "../../../src/agents/table.js";
import type { InstallationV1, MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { executionFormatCaptureFor } from "../../../src/control/worker.js";
import { ExecutionFormatFailure } from "../../../src/controller/executionFormatFailure.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { PROMPT_SCHEMA_LINE } from "../../../src/runtime/codex/runCodexPhase.js";
import { SingleCallOutputInvalid } from "../../../src/runtime/types.js";
import { codexFixture } from "./fixture.js";

// Orca tester issue 122 (session 3cfc2e73): a third-party provider without Responses `text.format` answers every
// `--output-schema` call with 400, so codex was unusable there. An installation may opt in to `structuredOutput: "prompt"`:
// no `--output-schema`, the same schema written into the prompt, the answer decoded by the same strict decoders. Absent or
// "schema" is today's argv. Fake codex only: no such provider is available to these criteria.
const FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);
const codexRecord = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: "codex", command: [process.execPath, "x"], version: "1", configDir: null,
  timeoutMs: 10_000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft", ...extra });
const materialized = (installation: InstallationV1): MaterializedAgentConfigV1 => ({ schema: "ccloop-agent-config-v1", kind: installation.kind, installation,
  selection: { agent: "codex", model: "gpt-6-sol", contextWindow: "agent-default" } });
type PhaseMarker = { args: string[]; prompt: string };

afterEach(() => { vi.unstubAllEnvs(); });

describe("the structuredOutput installation field", () => {
  it("a codex installation accepts schema or prompt, and nothing else", () => {
    expect(parseInstallation(codexRecord({ structuredOutput: "prompt" })).structuredOutput).toBe("prompt");
    expect(parseInstallation(codexRecord({ structuredOutput: "schema" })).structuredOutput).toBe("schema");
    expect(parseInstallation(codexRecord()).structuredOutput).toBeUndefined();
    expect(() => parseInstallation(codexRecord({ structuredOutput: "provider" }))).toThrow(/agents-table-invalid/);
  });

  it("is a codex field only", () => {
    expect(() => parseInstallation({ kind: "omp", command: [process.execPath, "x"], version: "1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, structuredOutput: "prompt" }))
      .toThrow(/agents-table-invalid/);
  });

  // Setting it is how a person makes a broken installation work; it must not strand the groups frozen on that installation.
  it("does not change the agent config hash", () => {
    const plain = agentConfigHash(materialized(parseInstallation(codexRecord())));
    for (const structuredOutput of ["schema", "prompt"]) expect(agentConfigHash(materialized(parseInstallation(codexRecord({ structuredOutput }))))).toBe(plain);
  });

  // Capture and recovery assume the --output-schema wire; prompt mode captures nothing, as omp.
  it("a prompt-mode installation gets no saved-result capture", () => {
    for (const extra of [{}, { structuredOutput: "schema" }]) {
      const config = materialized(parseInstallation(codexRecord(extra)));
      expect(executionFormatCaptureFor(config)).toEqual({ config });
    }
    expect(executionFormatCaptureFor(materialized(parseInstallation(codexRecord({ structuredOutput: "prompt" }))))).toBeUndefined();
  });
});

async function phaseWorld(mode: string, structuredOutput?: "schema" | "prompt", extraArgs: string[] = []) {
  const f = await codexFixture(mode);
  const source = join(f.dir, "source-codex-home");
  await mkdir(source); await writeFile(join(source, "auth.json"), "{}"); await writeFile(join(source, "config.toml"), "");
  vi.stubEnv("CCLOOP_CACHE_DIR", await realpath(await mkdtemp(join(tmpdir(), "ccloop-prompt-schema-cache-"))));
  await writeFile(`${f.marker}.catalog.json`, JSON.stringify({ mcp: [] }));
  const command = [...f.config.command, ...extraArgs] as [string, ...string[]];
  const installation: InstallationV1 = { kind: "codex", command, version: "9.9.9-fake", configDir: source, timeoutMs: 10_000, killGraceMs: 50,
    sandbox: "workspace-write", budgetMode: "soft", ...(structuredOutput === undefined ? {} : { structuredOutput }) };
  const adapter = new CodexAdapter(parseCodexConfig({ ...f.config, command }), { CODEX_HOME: source }, undefined, { installation, rateLimitDelaysMs: [10, 10, 10] });
  const call = (): PhaseMarker => JSON.parse(readFileSync(f.marker, "utf8")) as PhaseMarker;
  return { ...f, adapter, call };
}
const schemaOf = (args: string[]) => args[args.indexOf("-o") + 1]!.replace(/final\.json$/, "schema.json");

describe("codex phases in prompt mode", { timeout: 30_000 }, () => {
  it("plan, execute and verify send no --output-schema; the schema follows the prompt; the answers decode", async () => {
    const w = await phaseWorld("integration", "prompt");
    for (const phase of ["plan", "execute", "verify"] as const) {
      const result = phase === "plan" ? await w.adapter.plan(w.context) : phase === "execute" ? await w.adapter.execute(w.context) : await w.adapter.verify(w.context);
      const { args, prompt } = w.call();
      expect(args).not.toContain("--output-schema");
      const schema = await readFile(schemaOf(args), "utf8");
      expect(prompt.endsWith(`\n\n${PROMPT_SCHEMA_LINE}\n${schema}`)).toBe(true);
      expect(result).toMatchObject(phase === "plan" ? { summary: "fixture" } : phase === "execute" ? { changedFiles: ["answer.txt"] } : { approved: true });
    }
    expect(readFileSync(`${w.marker}.prompt-schema`, "utf8")).toBe("prompt\nprompt\nprompt\n");
  });

  it("absent and \"schema\" keep --output-schema and the prompt unchanged, with the same argv", async () => {
    const argvs: string[][] = [];
    for (const structuredOutput of [undefined, "schema"] as const) {
      const w = await phaseWorld("integration", structuredOutput);
      await w.adapter.plan(w.context);
      const { args, prompt } = w.call();
      expect(args[args.indexOf("--output-schema") + 1]).toBe(schemaOf(args));
      expect(prompt).not.toContain(PROMPT_SCHEMA_LINE);
      expect(existsSync(`${w.marker}.prompt-schema`)).toBe(false);
      argvs.push(args.map((arg) => arg.replace(w.dir, "<dir>").replace(/call-[^/]+/, "call-X")));
    }
    expect(argvs[1]).toEqual(argvs[0]);
  });

  it("a wrong-shaped execute answer is the existing execution format failure", async () => {
    const f = await codexFixture("final-text");
    const finals = join(f.dir, "finals.json");
    await writeFile(finals, JSON.stringify({ execute: "{\"result\":{\"changedFiles\":[\"answer.txt\"]}}" }));
    const w = await phaseWorld("final-text", "prompt", [finals]);
    const error = await failure(w.adapter.execute(w.context));
    expect(w.call().args).not.toContain("--output-schema");
    expect(error).toBeInstanceOf(ExecutionFormatFailure);
    expect(error).toMatchObject({ normalization: { status: "unavailable" } });
  });

  it("a wrong-shaped plan answer fails the phase as before", async () => {
    const f = await codexFixture("final-text");
    const finals = join(f.dir, "finals.json");
    await writeFile(finals, JSON.stringify({ plan: "{\"summary\":1}" }));
    const w = await phaseWorld("final-text", "prompt", [finals]);
    const error = await failure(w.adapter.plan(w.context));
    expect(w.call().args).not.toContain("--output-schema");
    expect((error as Error).message).toMatch(/^Error: codex-result-invalid: /);
    expect((error as Error).message).toContain("\"summary\"");
  });
});

describe("codex single call in prompt mode", { timeout: 30_000 }, () => {
  async function world(structuredOutput: "schema" | "prompt" | undefined, single?: unknown) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-codex-prompt-single-")));
    const marker = join(dir, "codex-marker"), codexHome = join(dir, "codex-home");
    await mkdir(codexHome); await writeFile(join(codexHome, "auth.json"), "{}"); await writeFile(join(codexHome, "config.toml"), "");
    if (single !== undefined) await writeFile(`${marker}.single.json`, JSON.stringify(single));
    const installation: InstallationV1 = { kind: "codex", command: [process.execPath, FAKE_CODEX, "integration", marker], version: "9.9.9-fake", configDir: codexHome,
      timeoutMs: 60_000, killGraceMs: 100, sandbox: "read-only", budgetMode: "soft", ...(structuredOutput === undefined ? {} : { structuredOutput }) };
    const runDir = join(dir, "run"), cwd = join(runDir, "cwd"); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const schema = { type: "object", properties: { answer: { type: "string" }, note: { type: "string" } }, required: ["answer"], additionalProperties: false };
    const request = { prompt: "Estimate.", responseSchema: schema, maxOutputTokens: 4096, cwd, runDir, timeoutMs: 30_000 };
    const argv = () => JSON.parse(readFileSync(`${marker}.argv`, "utf8").trim().split("\n").at(-1)!) as string[];
    return { marker, adapter: codexDescriptor.createAdapter(materialized(installation)), request, argv };
  }

  it("sends no --output-schema, puts the projected wire schema after the prompt, and decodes the answer", async () => {
    const w = await world("prompt");
    expect((await w.adapter.singleCall!(w.request)).output).toEqual({ answer: "42" });
    const argv = w.argv();
    expect(argv).not.toContain("--output-schema");
    const prompt = readFileSync(`${w.marker}.single-prompt.txt`, "utf8");
    const schema = await readFile(argv[argv.indexOf("-o") + 1]!.replace(/final\.json$/, "schema.json"), "utf8");
    expect(JSON.parse(schema)).toMatchObject({ required: ["answer", "note"] });
    expect(prompt).toBe(`Estimate.\n\n${PROMPT_SCHEMA_LINE}\n${schema}`);
  });

  it("absent and \"schema\" keep --output-schema and the caller's prompt", async () => {
    for (const structuredOutput of [undefined, "schema"] as const) {
      const w = await world(structuredOutput);
      await w.adapter.singleCall!(w.request);
      const argv = w.argv();
      expect(argv[argv.indexOf("--output-schema") + 1]).toBe(argv[argv.indexOf("-o") + 1]!.replace(/final\.json$/, "schema.json"));
      expect(readFileSync(`${w.marker}.single-prompt.txt`, "utf8")).toBe("Estimate.");
    }
  });

  it("an answer that is not one object is single-call-output-invalid, as before", async () => {
    const w = await world("prompt", { final: "Sure! The answer is 42." });
    expect(await failure(w.adapter.singleCall!(w.request))).toBeInstanceOf(SingleCallOutputInvalid);
    expect(w.argv()).not.toContain("--output-schema");
  });
});
