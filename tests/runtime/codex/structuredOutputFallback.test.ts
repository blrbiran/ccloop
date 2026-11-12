import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexDescriptor } from "../../../src/agents/codex.js";
import type { InstallationV1, MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { PROMPT_SCHEMA_LINE } from "../../../src/runtime/codex/runCodexPhase.js";
import { codexFixture } from "./fixture.js";

// Orca #122: a third-party provider behind codex that cannot take `--output-schema` answers it with a 400 about the response
// format, and the run failed although prompt mode (`structuredOutput: "prompt"`) would have worked; ccloop never wrote the
// person's agents table and still must not. Now the call that got that 400, when it did no work, is sent once more in prompt
// mode and the second call records that it fell back (structured-output-fallback.json). Everything else stays: a refusal
// after work, a 400 that is not about the response format, or an installation already in prompt mode fails as before, and
// the answer is decoded by the same strict decoders. Fake codex only: no such provider is available to these criteria.
const FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);
const argvLines = (marker: string) => readFileSync(`${marker}.argv`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
const callDirs = async (root: string) => (await readdir(root)).filter((name) => name.startsWith("call-")).map((name) => join(root, name));
const fallbackOf = (dir: string) => JSON.parse(readFileSync(join(dir, "structured-output-fallback.json"), "utf8")) as Record<string, unknown>;

afterEach(() => { vi.unstubAllEnvs(); });

async function phaseWorld(mode: string, structuredOutput?: "schema" | "prompt") {
  const f = await codexFixture(mode);
  const source = join(f.dir, "source-codex-home");
  await mkdir(source); await writeFile(join(source, "auth.json"), "{}"); await writeFile(join(source, "config.toml"), "");
  vi.stubEnv("CCLOOP_CACHE_DIR", await realpath(await mkdtemp(join(tmpdir(), "ccloop-format-fallback-cache-"))));
  await writeFile(`${f.marker}.catalog.json`, JSON.stringify({ mcp: [] }));
  const installation: InstallationV1 = { kind: "codex", command: f.config.command as [string, ...string[]], version: "9.9.9-fake", configDir: source, timeoutMs: 10_000, killGraceMs: 50,
    sandbox: "workspace-write", budgetMode: "soft", ...(structuredOutput === undefined ? {} : { structuredOutput }) };
  const adapter = new CodexAdapter(parseCodexConfig(f.config), { CODEX_HOME: source }, undefined, { installation, rateLimitDelaysMs: [10, 10, 10] });
  return { ...f, adapter, phaseRoot: (phase: string) => join(f.runDir, "codex", "1", phase) };
}

describe("a codex phase whose --output-schema the provider refuses", { timeout: 30_000 }, () => {
  it.each(["plan", "execute", "verify"] as const)("%s: is sent once more in prompt mode, answers, and records the fallback", async (phase) => {
    const w = await phaseWorld("format-refused");
    const result = phase === "plan" ? await w.adapter.plan(w.context) : phase === "execute" ? await w.adapter.execute(w.context) : await w.adapter.verify(w.context);
    expect(result).toMatchObject(phase === "plan" ? { summary: "fixture" } : phase === "execute" ? { changedFiles: ["answer.txt"] } : { approved: true });
    const [first, second, ...rest] = argvLines(w.marker);
    expect(rest).toEqual([]);
    expect(first).toContain("--output-schema");
    expect(second).not.toContain("--output-schema");
    expect(JSON.parse(readFileSync(w.marker, "utf8")).prompt).toContain(PROMPT_SCHEMA_LINE);
    const dirs = await callDirs(w.phaseRoot(phase));
    const refused = dirs.find((dir) => !existsSync(join(dir, "structured-output-fallback.json")))!;
    const fallback = dirs.find((dir) => dir !== refused)!;
    expect(fallbackOf(fallback)).toMatchObject({ schema: "ccloop-structured-output-fallback-v1", refusedEvidenceDir: refused });
    expect(fallbackOf(fallback).detail).toMatch(/400 Bad Request.*text\.format/);
    // The refused call is classified and was retried at once, not after a transient delay.
    expect(JSON.parse(readFileSync(join(refused, "failure-cause.json"), "utf8"))).toMatchObject({ cause: "unknown", workObserved: false, call: 1, nextDelayMs: 0 });
  });

  it("does not fall back after work was observed: the execute fails on its first call", async () => {
    const w = await phaseWorld("format-refused-after-item");
    const error = await failure(w.adapter.execute(w.context));
    expect(error).toBeInstanceOf(Error);
    expect(argvLines(w.marker)).toHaveLength(1);
  });

  it.each([
    ["a 400 that is not about the response format", "unexpected status 400 Bad Request: {\"error\":{\"message\":\"Invalid value for 'model'.\"}}"],
    ["a response-format complaint that is not a 400", "unexpected status 500 Internal Server Error: text.format backend unavailable"],
  ])("does not fall back on %s", async (_name, message) => {
    vi.stubEnv("FAKE_CODEX_FORMAT_MESSAGE", message);
    const w = await phaseWorld("format-refused");
    await failure(w.adapter.plan(w.context));
    expect(argvLines(w.marker)).toHaveLength(1);
  });

  it("falls back once only: a prompt-mode call that fails too ends the phase with that failure", async () => {
    vi.stubEnv("FAKE_CODEX_FORMAT_ALWAYS", "1");
    const w = await phaseWorld("format-refused");
    const error = await failure(w.adapter.plan(w.context));
    const lines = argvLines(w.marker);
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain("--output-schema");
    expect(error).toMatchObject({ failureCause: { retries: 1 } });
  });

  it("never falls back for an installation already in prompt mode", async () => {
    vi.stubEnv("FAKE_CODEX_FORMAT_ALWAYS", "1");
    const w = await phaseWorld("format-refused", "prompt");
    await failure(w.adapter.plan(w.context));
    expect(argvLines(w.marker)).toHaveLength(1);
  });
});

describe("a codex single call whose --output-schema the provider refuses", { timeout: 30_000 }, () => {
  async function world(structuredOutput?: "schema" | "prompt", viaLauncher = false) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-codex-format-single-")));
    const marker = join(dir, "codex-marker"), codexHome = join(dir, "codex-home"), launcher = join(dir, "codex");
    await mkdir(codexHome); await writeFile(join(codexHome, "auth.json"), "{}"); await writeFile(join(codexHome, "config.toml"), "");
    await writeFile(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CODEX)} "$@"\n`, { mode: 0o700 });
    vi.stubEnv("CCLOOP_CACHE_DIR", await realpath(await mkdtemp(join(tmpdir(), "ccloop-format-single-cache-"))));
    const command: [string, ...string[]] = viaLauncher ? [launcher, "format-refused", marker] : [process.execPath, FAKE_CODEX, "format-refused", marker];
    const installation: InstallationV1 = { kind: "codex", command, version: "9.9.9-fake", configDir: codexHome,
      timeoutMs: 60_000, killGraceMs: 100, sandbox: "read-only", budgetMode: "soft", ...(structuredOutput === undefined ? {} : { structuredOutput }) };
    const materialized: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: "codex", installation, selection: { agent: "codex", model: "gpt-6-sol", contextWindow: "agent-default" } };
    const runDir = join(dir, "run"), cwd = join(runDir, "cwd"); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
    const request = { prompt: "Estimate.", responseSchema: schema, maxOutputTokens: 4096, cwd, runDir, timeoutMs: 30_000 };
    return { marker, runDir, launcher, adapter: codexDescriptor.createAdapter(materialized), request };
  }

  it("is sent once more in prompt mode, answers, and records the fallback", async () => {
    const w = await world();
    expect((await w.adapter.singleCall!(w.request)).output).toEqual({ answer: "42" });
    const [first, second, ...rest] = argvLines(w.marker);
    expect(rest).toEqual([]);
    expect(first).toContain("--output-schema");
    expect(second).not.toContain("--output-schema");
    expect(readFileSync(`${w.marker}.single-prompt.txt`, "utf8")).toContain(PROMPT_SCHEMA_LINE);
    const dirs = await callDirs(join(w.runDir, "codex", "1", "single-call"));
    const fallback = dirs.find((dir) => existsSync(join(dir, "structured-output-fallback.json")))!;
    expect(fallbackOf(fallback)).toMatchObject({ refusedEvidenceDir: dirs.find((dir) => dir !== fallback) });
  });

  it("falls back once only, and the failure of the pair is never booked as never started", async () => {
    vi.stubEnv("FAKE_CODEX_FORMAT_ALWAYS", "1");
    const w = await world();
    const error = await failure(w.adapter.singleCall!(w.request));
    expect(argvLines(w.marker)).toHaveLength(2);
    expect((error as { neverStarted?: unknown }).neverStarted).toBeUndefined();
  });

  // The refused call was sent, so a fallback that could not even spawn must not make the pair "never started" (booked 0).
  it("a fallback that cannot spawn leaves the pair started", async () => {
    const w = await world(undefined, true);
    vi.stubEnv("FAKE_CODEX_UNLINK_ON_REFUSAL", w.launcher);
    const error = await failure(w.adapter.singleCall!(w.request));
    expect((error as Error).message).toMatch(/^codex-spawn-error: /);
    expect((error as { neverStarted?: unknown }).neverStarted).toBeUndefined();
  });

  it("never falls back for an installation already in prompt mode", async () => {
    vi.stubEnv("FAKE_CODEX_FORMAT_ALWAYS", "1");
    const w = await world("prompt");
    await failure(w.adapter.singleCall!(w.request));
    expect(argvLines(w.marker)).toHaveLength(1);
  });
});
