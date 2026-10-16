import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codexDescriptor } from "../../../src/agents/codex.js";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { codexSingleCallHome } from "../../../src/runtime/codex/codexSingleCall.js";
import { observedTokensOf, SingleCallOutputInvalid } from "../../../src/runtime/types.js";

// Every-agent requirement chain (Orca spec 2026-10-15 §6.1, R2, R9): one structured codex call with tools off, in a
// private HOME and CODEX_HOME whose auth.json and config.toml are symlinks; decoding fails closed and books what it saw.
const FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
async function world(single?: unknown) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-codex-single-")));
  const marker = join(dir, "codex-marker"), codexHome = join(dir, "codex-home");
  await mkdir(codexHome); await writeFile(join(codexHome, "auth.json"), "{}"); await writeFile(join(codexHome, "config.toml"), "");
  if (single !== undefined) await writeFile(`${marker}.single.json`, JSON.stringify(single));
  const config: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: "codex",
    installation: { kind: "codex", command: [process.execPath, FAKE_CODEX, "integration", marker], version: "9.9.9-fake", configDir: codexHome, timeoutMs: 60_000, killGraceMs: 100, sandbox: "read-only", budgetMode: "soft" },
    selection: { agent: "codex", model: "gpt-6-sol", contextWindow: "agent-default" } };
  const runDir = join(dir, "run"), cwd = join(runDir, "cwd"); await mkdir(cwd, { recursive: true, mode: 0o700 });
  const adapter = codexDescriptor.createAdapter(config);
  const request = { prompt: "Estimate.", responseSchema: SCHEMA, maxOutputTokens: 4096, cwd, runDir, timeoutMs: 30_000 };
  return { dir, marker, codexHome, config, adapter, request };
}
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);
const lastArgv = (marker: string): string[] => JSON.parse(readFileSync(`${marker}.argv`, "utf8").trim().split("\n").at(-1)!);
const configValues = (argv: string[]) => argv.flatMap((arg, i) => (arg === "-c" ? [argv[i + 1]!] : []));
type SingleEnv = { HOME: string; CODEX_HOME: string; authIsLink: boolean };
const singleEnv = (marker: string): SingleEnv => JSON.parse(readFileSync(`${marker}.single-env.json`, "utf8")) as SingleEnv;
const mode = async (path: string) => (await lstat(path)).mode & 0o777;
const ISOLATION = [
  "include_permissions_instructions=false", "include_apps_instructions=false", "include_collaboration_mode_instructions=false",
  "include_environment_context=false", "project_doc_max_bytes=0", "features.plugins=false",
];

describe("codex single call (spec §6.1)", { timeout: 30_000 }, () => {
  it("C8.1: answers the object with the observed usage per model", async () => {
    const w = await world();
    expect(await w.adapter.singleCall!(w.request)).toEqual({ output: { answer: "42" }, tokenUsage: 24, usageEvidence: expect.objectContaining({ normalizedTotal: 24 }),
      modelUsage: [{ model: "gpt-6-sol", input: 15, output: 4, cacheRead: 5, cacheWrite: 0 }] });
    expect(readFileSync(`${w.marker}.calls`, "utf8")).toBe("single-call\n");
  });

  // Task 0 (codex-cli 0.160.0) ruling: `features.plugins=false` belongs to the isolation keys -- it removes the
  // <recommended_plugins> block a linked config.toml injects -- and is sent once, never again as a tool flag.
  it("C8.2: runs read-only in the empty cwd with every isolation key and the installed tool flags off", async () => {
    const w = await world();
    await w.adapter.singleCall!(w.request);
    const argv = lastArgv(w.marker);
    expect(argv.slice(0, 7)).toEqual(["exec", "--json", "--ephemeral", "--color", "never", "--skip-git-repo-check", "--model"]);
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(argv[argv.indexOf("-C") + 1]).toBe(w.request.cwd);
    expect(configValues(argv)).toEqual([...ISOLATION,
      "features.apps=false", "features.image_generation=false", "features.multi_agent=false",
      "features.shell_tool=false", "features.skip_host_skill_discovery=true", "features.unified_exec=false", "features.view_image=false",
    ]);
    expect(argv.at(-1)).toBe("-");
  });

  // Ruling (Task 8, Orca session a852f96a, 2026-10-16, answering the human's "can the dir be reused?"): ONE private HOME and
  // CODEX_HOME per installation under the ccloop cache dir, links re-checked every call; the run dir only without a cache dir.
  it("C8.3: runs in a private HOME and CODEX_HOME, reused per installation under the cache dir, whose auth.json and config.toml are symlinks, never copies (R9)", async () => {
    const w = await world();
    await w.adapter.singleCall!(w.request);
    const id = createHash("sha256").update(`${await realpath(process.execPath)}\0${w.codexHome}`).digest("hex");
    const base = join(process.env.CCLOOP_CACHE_DIR!, "codex-home", id);
    const env = singleEnv(w.marker);
    expect(env).toEqual({ HOME: join(base, "home"), CODEX_HOME: join(base, "codex-home"), authIsLink: true });
    expect(await readlink(join(env.CODEX_HOME, "auth.json"))).toBe(join(w.codexHome, "auth.json"));
    expect(await readlink(join(env.CODEX_HOME, "config.toml"))).toBe(join(w.codexHome, "config.toml"));
    expect([await mode(base), await mode(env.HOME), await mode(env.CODEX_HOME)]).toEqual([0o700, 0o700, 0o700]);

    // A second call reuses the same dirs with the links intact; an existing dir's mode is left alone.
    await chmod(env.HOME, 0o750);
    await w.adapter.singleCall!(w.request);
    expect(singleEnv(w.marker)).toEqual(env);
    expect(await readlink(join(env.CODEX_HOME, "auth.json"))).toBe(join(w.codexHome, "auth.json"));
    expect(await mode(env.HOME)).toBe(0o750);
  });

  it("C8.3b: repairs a link that points elsewhere, a regular file where a link belongs, and a link whose source is gone", async () => {
    const w = await world();
    await w.adapter.singleCall!(w.request);
    const { CODEX_HOME } = singleEnv(w.marker);
    await unlink(join(CODEX_HOME, "auth.json")); await writeFile(join(CODEX_HOME, "auth.json"), "{\"copied\":true}");
    await unlink(join(CODEX_HOME, "config.toml")); await symlink(join(w.dir, "elsewhere.toml"), join(CODEX_HOME, "config.toml"));
    await w.adapter.singleCall!(w.request);
    expect(singleEnv(w.marker).authIsLink).toBe(true);
    expect(await readlink(join(CODEX_HOME, "auth.json"))).toBe(join(w.codexHome, "auth.json"));
    expect(await readlink(join(CODEX_HOME, "config.toml"))).toBe(join(w.codexHome, "config.toml"));
    await rm(join(w.codexHome, "config.toml"));
    await w.adapter.singleCall!(w.request);
    expect(await lstat(join(CODEX_HOME, "config.toml")).then(() => "present", () => "absent")).toBe("absent");
  });

  // The installation is named by its real executable: a symlinked command (a shim, an nvm alias) shares the real one's dirs.
  it("C8.3c: two first calls at once both get the same private dirs, named by the real executable", async () => {
    const w = await world();
    const env = { CCLOOP_CACHE_DIR: join(w.dir, "fresh-cache") };
    const executable = join(w.dir, "codex-shim");
    await symlink(process.execPath, executable);
    const input = { runDir: w.request.runDir, sourceCodexHome: w.codexHome, executable, env };
    const [a, b] = await Promise.all([codexSingleCallHome(input), codexSingleCallHome(input)]);
    expect(a).toEqual(b);
    const id = createHash("sha256").update(`${await realpath(process.execPath)}\0${w.codexHome}`).digest("hex");
    expect(a.home).toBe(join(w.dir, "fresh-cache", "codex-home", id, "home"));
    expect(await readlink(join(a.codexHome, "auth.json"))).toBe(join(w.codexHome, "auth.json"));
  });

  it("C8.3d: with no cache dir, each call gets its own private dirs under the run directory", async () => {
    const w = await world();
    const input = { runDir: w.request.runDir, sourceCodexHome: w.codexHome, executable: process.execPath, env: {} };
    const first = await codexSingleCallHome(input), second = await codexSingleCallHome(input);
    const root = join(w.request.runDir, "codex", "1", "single-call");
    expect([first.home.startsWith(root), first.codexHome.startsWith(root)]).toEqual([true, true]);
    expect(second.home).not.toBe(first.home);
    expect([await mode(first.home), await mode(first.codexHome)]).toEqual([0o700, 0o700]);
    expect((await lstat(join(first.codexHome, "auth.json"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(first.codexHome, "config.toml"))).toBe(join(w.codexHome, "config.toml"));
  });

  // Ruling (Task 8): the links' source is the installation's effective CODEX_HOME -- its configDir, else an inherited
  // absolute CODEX_HOME, else <HOME>/.codex (an empty or relative CODEX_HOME is unset, never joined cwd-relative).
  it("C8.3e: with no configDir, links the inherited CODEX_HOME's files, else <HOME>/.codex's", async () => {
    const saved = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME };
    try {
      const w = await world();
      const inherited = join(w.dir, "inherited"), home = join(w.dir, "person");
      for (const dir of [inherited, join(home, ".codex")]) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, "auth.json"), "{}"); }
      const adapter = codexDescriptor.createAdapter({ ...w.config, installation: { ...w.config.installation, configDir: null } });
      const linkedAuth = async (codexHome: string) => {
        process.env.CODEX_HOME = codexHome; process.env.HOME = home;
        await adapter.singleCall!(w.request);
        return readlink(join(singleEnv(w.marker).CODEX_HOME, "auth.json"));
      };
      expect(await linkedAuth(inherited)).toBe(join(inherited, "auth.json"));
      expect(await linkedAuth("")).toBe(join(home, ".codex", "auth.json"));
      expect(await linkedAuth("relative-codex-home")).toBe(join(home, ".codex", "auth.json"));
    } finally {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });

  it("C8.4: refuses before spawning, booking 0, when the feature list cannot be read", async () => {
    const w = await world();
    await writeFile(`${w.marker}.catalog.json`, JSON.stringify({ exitCode: 9 }));
    const error = await failure(w.adapter.singleCall!(w.request));
    expect(error).toMatchObject({ code: "codex-single-call-unavailable", neverStarted: true });
    expect(observedTokensOf(error)).toBe(0);
    expect(existsSync(`${w.marker}.calls`)).toBe(false);
  });

  // Codex refuses an unknown flag ("Unknown feature flag"), so only the flags the installed version lists are sent.
  it("C8.4b: turns off only the tool flags the installed codex lists", async () => {
    const w = await world();
    await writeFile(`${w.marker}.catalog.json`, JSON.stringify({ features: ["apps", "browser_use", "shell_tool"] }));
    await w.adapter.singleCall!(w.request);
    expect(configValues(lastArgv(w.marker))).toEqual([...ISOLATION, "features.apps=false", "features.shell_tool=false"]);
  });

  it.each([
    ["tool", [{ type: "item.started", item: { id: "i", type: "command_execution", command: "ls" } }, { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 6 } }], 36],
    ["messages", [{ type: "item.completed", item: { type: "agent_message", text: "{}" } }, { type: "item.completed", item: { type: "agent_message", text: "{\"answer\":\"42\"}" } }, { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 6 } }], 36],
    ["turns", [{ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } }, { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 6 } }], 36],
  ] as const)("C8.5: refuses a call that was not single (%s) and books the usage it saw", async (what, rows, booked) => {
    const w = await world({ rows });
    const error = await failure(w.adapter.singleCall!(w.request));
    expect(error).toMatchObject({ code: `codex-single-call-not-single:${what}` });
    expect(observedTokensOf(error)).toBe(booked);
  });

  it.each([
    ["codex-event-error", [{ type: "item.completed", item: { type: "agent_message", text: "{\"answer\":\"42\"}" } }, { type: "error", message: "boom" }, { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 6 } }]],
    ["codex-events-invalid", [{ type: "item.completed", item: { type: "agent_message", text: "{\"answer\":\"42\"}" } }, "not an event", { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 6 } }]],
  ] as const)("C8.5b: refuses unreadable events (%s) and books the usage it saw, never 0", async (code, rows) => {
    const w = await world({ rows });
    const error = await failure(w.adapter.singleCall!(w.request));
    expect((error as Error).message).toBe(code);
    expect(observedTokensOf(error)).toBe(36);
  });

  it("C8.6: an answer that is not one object is single-call-output-invalid with its usage", async () => {
    const w = await world({ final: "not json" });
    const error = await failure(w.adapter.singleCall!(w.request));
    expect(error).toBeInstanceOf(SingleCallOutputInvalid);
    expect((error as SingleCallOutputInvalid).tokenUsage).toBe(24);
  });

  it("C8.7: an answer over the request's maxOutputTokens is still the answer (R2: the bound is checked after the fact by Orca)", async () => {
    const w = await world({ rows: [{ type: "item.completed", item: { type: "agent_message", text: "{\"answer\":\"42\"}" } }, { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 9000 } }] });
    expect(await w.adapter.singleCall!(w.request)).toMatchObject({ output: { answer: "42" }, tokenUsage: 9020, modelUsage: [{ output: 9000 }] });
  });
});
