import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexDescriptor } from "../../../src/agents/codex.js";
import { CodexConfigFileMissing, codexConfigFileArgs } from "../../../src/agents/codexIsolation.js";
import type { InstallationV1, MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { codexPhaseConfigArgs, codexPhaseIsolation } from "../../../src/runtime/codex/codexPhaseIsolation.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { observedTokensOf } from "../../../src/runtime/types.js";
import { codexFixture } from "./fixture.js";

// Orca tester issue 121 (session 3cfc2e73): codex resolves a relative top-level `model_catalog_json` against CODEX_HOME
// (zero-cost probe on codex-cli 0.163.0, recorded in codexIsolation.ts), and the private CODEX_HOME links only auth.json and
// config.toml, so every isolated spawn failed to load the person's config ("No such file or directory"). Each isolated spawn
// -- the MCP probe, the single call, every phase -- now passes the file's absolute path, resolved against the real
// CODEX_HOME, with `-c`; nothing is linked or copied into the private dir (R9). A referenced file that is missing is named.
const FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);
const configValues = (argv: readonly string[]) => argv.flatMap((arg, i) => (arg === "-c" ? [argv[i + 1]!] : []));
async function source(toml: string, files: string[] = []) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-codex-cfgfile-")));
  const home = join(dir, "source-codex-home");
  await mkdir(home); await writeFile(join(home, "auth.json"), "{}"); await writeFile(join(home, "config.toml"), toml);
  for (const name of files) await writeFile(join(home, name), "{\"models\":[]}");
  return { dir, home };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("codexConfigFileArgs (issue 121)", () => {
  it("a relative model_catalog_json becomes one -c pair with its path under the real CODEX_HOME", async () => {
    const s = await source("model_provider = \"x\"\nmodel_catalog_json = \"cat alog.json\" # cc-switch\n[model_providers.x]\nname = \"x\"\n", ["cat alog.json"]);
    expect(await codexConfigFileArgs(s.home)).toEqual(["-c", `model_catalog_json=${JSON.stringify(join(s.home, "cat alog.json"))}`]);
  });

  it("reads a literal string and a nested relative path too", async () => {
    const s = await source("model_catalog_json = 'sub/c.json'\n");
    await mkdir(join(s.home, "sub")); await writeFile(join(s.home, "sub", "c.json"), "{}");
    expect(await codexConfigFileArgs(s.home)).toEqual(["-c", `model_catalog_json=${JSON.stringify(join(s.home, "sub", "c.json"))}`]);
  });

  it("sends nothing for no key, an absolute value, a key inside a table, or no config at all", async () => {
    for (const toml of ["", "model = \"m\"\n", "model_catalog_json = \"/abs/c.json\"\n", "[profiles.p]\nmodel_catalog_json = \"c.json\"\n"]) {
      expect(await codexConfigFileArgs((await source(toml)).home)).toEqual([]);
    }
    expect(await codexConfigFileArgs(null)).toEqual([]);
    expect(await codexConfigFileArgs(join((await source("")).dir, "no-such-home"))).toEqual([]);
  });

  it("a relative value whose file is missing is refused by its absolute path", async () => {
    const s = await source("model_catalog_json = \"cc-switch-model-catalog.json\"\n");
    const error = await failure(codexConfigFileArgs(s.home));
    expect(error).toBeInstanceOf(CodexConfigFileMissing);
    expect(error).toMatchObject({ message: `codex-config-file-missing:${join(s.home, "cc-switch-model-catalog.json")}`, neverStarted: true });
  });
});

describe("codex phase isolation passes the catalog path (issue 121)", () => {
  const installationOf = (home: string): InstallationV1 => ({ kind: "codex", command: [process.execPath, "unused"], version: "9.9.9-fake", configDir: home,
    timeoutMs: 10_000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft" });
  const envOf = (dir: string): NodeJS.ProcessEnv => ({ HOME: join(dir, "real-home"), CCLOOP_CACHE_DIR: join(dir, "cache") });

  it("appends the pair after the phase's own -c list", async () => {
    const s = await source("model_catalog_json = \"c.json\"\n", ["c.json"]);
    const env = envOf(s.dir), runDir = join(s.dir, "run"); await mkdir(runDir);
    const isolated = await codexPhaseIsolation({ installation: installationOf(s.home), mcpServers: [], runDir, attempt: 1, env });
    expect(isolated.args).toEqual([...codexPhaseConfigArgs([], env.HOME!), "-c", `model_catalog_json=${JSON.stringify(join(s.home, "c.json"))}`]);
    expect(await readdir(isolated.codexHome)).toEqual(expect.not.arrayContaining(["c.json"]));
  });

  it("a missing file refuses the phase by name, before the missing MCP list it also caused", async () => {
    const s = await source("model_catalog_json = \"c.json\"\n");
    const env = envOf(s.dir), runDir = join(s.dir, "run"); await mkdir(runDir);
    for (const mcpServers of [[], null]) {
      const error = await failure(codexPhaseIsolation({ installation: installationOf(s.home), mcpServers, runDir, attempt: 1, env }));
      expect(error).toMatchObject({ reason: `codex-phase-isolation-config-file-missing:${join(s.home, "c.json")}`, neverStarted: true });
    }
  });

  it("a codex loop phase runs with the pair and its MCP probe lists under it", async () => {
    const f = await codexFixture("integration");
    const s = await source("model_catalog_json = \"c.json\"\n", ["c.json"]);
    vi.stubEnv("CCLOOP_CACHE_DIR", await realpath(await mkdtemp(join(tmpdir(), "ccloop-cfgfile-cache-"))));
    await writeFile(`${f.marker}.catalog.json`, JSON.stringify({ mcp: [] }));
    const installation: InstallationV1 = { ...installationOf(s.home), command: f.config.command as [string, ...string[]] };
    const adapter = new CodexAdapter(parseCodexConfig(f.config), { CODEX_HOME: s.home }, undefined, { installation });
    await adapter.plan(f.context);
    const pair = `model_catalog_json=${JSON.stringify(join(s.home, "c.json"))}`;
    expect(configValues((JSON.parse(readFileSync(f.marker, "utf8")) as { args: string[] }).args)).toContain(pair);
    expect((JSON.parse(readFileSync(`${f.marker}.mcp-env.json`, "utf8")) as { c: string[] }).c).toContain(pair);
  }, 30_000);
});

describe("codex single call passes the catalog path (issue 121)", { timeout: 30_000 }, () => {
  async function world(toml: string, files: string[]) {
    const s = await source(toml, files);
    const marker = join(s.dir, "codex-marker");
    const config: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: "codex",
      installation: { kind: "codex", command: [process.execPath, FAKE_CODEX, "integration", marker], version: "9.9.9-fake", configDir: s.home, timeoutMs: 60_000, killGraceMs: 100, sandbox: "read-only", budgetMode: "soft" },
      selection: { agent: "codex", model: "gpt-6-sol", contextWindow: "agent-default" } };
    const runDir = join(s.dir, "run"), cwd = join(runDir, "cwd"); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const request = { prompt: "Estimate.", responseSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }, maxOutputTokens: 4096, cwd, runDir, timeoutMs: 30_000 };
    return { ...s, marker, adapter: codexDescriptor.createAdapter(config), request };
  }

  it("the call and its MCP probe carry the pair, last before the prompt's `-`", async () => {
    const w = await world("model_catalog_json = \"c.json\"\n", ["c.json"]);
    expect((await w.adapter.singleCall!(w.request)).output).toEqual({ answer: "42" });
    const pair = `model_catalog_json=${JSON.stringify(join(w.home, "c.json"))}`;
    const argv = JSON.parse(readFileSync(`${w.marker}.argv`, "utf8").trim().split("\n").at(-1)!) as string[];
    expect(argv.slice(-3)).toEqual(["-c", pair, "-"]);
    expect((JSON.parse(readFileSync(`${w.marker}.mcp-env.json`, "utf8")) as { c: string[] }).c).toContain(pair);
  });

  it("a missing file refuses the call by name before spawning, booking 0", async () => {
    const w = await world("model_catalog_json = \"c.json\"\n", []);
    const error = await failure(w.adapter.singleCall!(w.request));
    expect(error).toMatchObject({ message: `codex-single-call-unavailable: codex-config-file-missing:${join(w.home, "c.json")}`, code: "codex-single-call-unavailable", neverStarted: true });
    expect(observedTokensOf(error)).toBe(0);
    expect(() => readFileSync(`${w.marker}.calls`, "utf8")).toThrow();
  });
});
