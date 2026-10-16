import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readAgentCatalog } from "../../../src/agents/agentCatalog.js";
import { catalogKey, entryFileName } from "../../../src/agents/catalogCache.js";
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

  // Fix round 1 (credential safety): a private dir that is a symlink -- here to the installation's own CODEX_HOME -- would
  // let the link repair rename a link over the real auth.json. It is refused before anything is linked or spawned.
  it.each(["home", "codex-home"])("C8.3f: refuses, unspawned and booking 0, a private %s that is a symlink, and leaves the source auth.json alone", async (name) => {
    const w = await world();
    const id = createHash("sha256").update(`${await realpath(process.execPath)}\0${w.codexHome}`).digest("hex");
    const base = join(process.env.CCLOOP_CACHE_DIR!, "codex-home", id);
    await mkdir(base, { recursive: true });
    const elsewhere = join(w.dir, "elsewhere-home"); await mkdir(elsewhere);
    await symlink(name === "codex-home" ? w.codexHome : elsewhere, join(base, name));
    const error = await failure(w.adapter.singleCall!(w.request));
    expect(error).toMatchObject({ code: "codex-single-call-home-invalid", neverStarted: true, message: `codex-single-call-home-invalid:${join(base, name)}` });
    expect(observedTokensOf(error)).toBe(0);
    expect(existsSync(`${w.marker}.calls`)).toBe(false);
    expect((await lstat(join(w.codexHome, "auth.json"))).isFile()).toBe(true);
    expect(await readFile(join(w.codexHome, "auth.json"), "utf8")).toBe("{}");
  });

  // Controller ruling (fix round 1): a regular auth.json in the private CODEX_HOME may hold a token codex rotated into it;
  // it is moved aside, never deleted, and the link to the installation's file is restored.
  it("C8.3g: moves a regular private auth.json aside with its bytes, then links the source again", async () => {
    const w = await world();
    await w.adapter.singleCall!(w.request);
    const { CODEX_HOME } = singleEnv(w.marker);
    await unlink(join(CODEX_HOME, "auth.json")); await writeFile(join(CODEX_HOME, "auth.json"), "{\"rotated\":true}");
    await w.adapter.singleCall!(w.request);
    expect(await readlink(join(CODEX_HOME, "auth.json"))).toBe(join(w.codexHome, "auth.json"));
    const displaced = (await readdir(CODEX_HOME)).filter((entry) => /^auth\.json\.displaced-\d+$/.test(entry));
    expect(displaced).toHaveLength(1);
    expect(await readFile(join(CODEX_HOME, displaced[0]!), "utf8")).toBe("{\"rotated\":true}");
  });

  // 0o000 would widen a mode left to the umask; 0o277 would narrow one below the owner's write bit (so the explicit chmod
  // after mkdir is what keeps 0700). Precedent: tests/agents/catalogCache.test.ts.
  it.each([["0o000", 0o000], ["0o277", 0o277]] as const)("C8.3h: creates the private dirs 0700 whatever the umask (umask %s), cached and per run", async (_label, umask) => {
    const w = await world();
    const input = { runDir: w.request.runDir, sourceCodexHome: w.codexHome, executable: process.execPath };
    const old = process.umask(umask);
    let homes: Array<{ home: string; codexHome: string }>;
    try {
      homes = [await codexSingleCallHome({ ...input, env: { CCLOOP_CACHE_DIR: join(w.dir, "umask-cache") } }), await codexSingleCallHome({ ...input, env: {} })];
    } finally { process.umask(old); }
    for (const { home, codexHome } of homes) {
      expect([await mode(dirname(home)), await mode(home), await mode(codexHome)]).toEqual([0o700, 0o700, 0o700]);
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

  // Spec R6 (as omp's Task 4 fix round 1): the re-check and the call share ONE deadline. A cold re-check of ~2 s (the fake
  // sleeps 1 s in `debug models` and 1 s in `features list`) of a 6 s limit leaves the hanging call the rest, so the whole
  // call ends near 6 s -- not 2 s + another full 6 s.
  it("C8.8: stops a call after a slow cold re-check at the original deadline, not a fresh full limit", async () => {
    const w = await world({ hang: true });
    await writeFile(`${w.marker}.catalog.json`, JSON.stringify({ sleepMs: 1_000 }));
    const started = Date.now();
    const error = await failure(w.adapter.singleCall!({ ...w.request, timeoutMs: 6_000 }));
    const elapsed = Date.now() - started;
    expect((error as Error).message).toMatch(/^codex-timeout: /);
    expect(observedTokensOf(error)).toBeNull();
    expect(readFileSync(`${w.marker}.calls`, "utf8")).toBe("single-call\n");
    expect(elapsed).toBeGreaterThanOrEqual(5_900);
    expect(elapsed).toBeLessThan(7_500);
  }, 20_000);

  // Fix round 1 (repo convention, omp "Ruling m4"): the prompt is written only after the process is registered, so a call
  // that never got that far sent nothing and books 0, not null.
  it("C8.9: an abort before spawning books 0 as neverStarted", async () => {
    const w = await world();
    await w.adapter.singleCall!(w.request);
    const controller = new AbortController(); controller.abort();
    const error = await failure(w.adapter.singleCall!({ ...w.request, signal: controller.signal }));
    expect(error).toMatchObject({ neverStarted: true });
    expect((error as Error).message).toMatch(/^codex-aborted: /);
    expect(observedTokensOf(error)).toBe(0);
    expect(readFileSync(`${w.marker}.calls`, "utf8")).toBe("single-call\n");
  });

  it("C8.9b: a process that could not be spawned (its working directory is gone) books 0 as neverStarted", async () => {
    const w = await world();
    const error = await failure(w.adapter.singleCall!({ ...w.request, cwd: join(w.request.runDir, "gone") }));
    expect(error).toMatchObject({ neverStarted: true });
    expect((error as Error).message).toMatch(/^codex-spawn-error: /);
    expect(observedTokensOf(error)).toBe(0);
    expect(existsSync(`${w.marker}.calls`)).toBe(false);
  });

  // Task 8 fix round 2 (paid check P1, codex-cli 0.160.0): codex printed three `error` items -- config warnings -- and one
  // answer in one turn; they are diagnostics, logged and kept in events.jsonl, never a reason to refuse. The fake's
  // default stream carries those three items verbatim.
  it("C8.11: decodes a single call whose stream carries codex's error items, logging each on stderr", async () => {
    const w = await world();
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    let result: unknown;
    try { result = await w.adapter.singleCall!(w.request); } finally { spy.mockRestore(); }
    expect(result).toMatchObject({ output: { answer: "42" }, tokenUsage: 24 });
    const items = written.filter((line) => line.startsWith("ccloop-codex-single-call: codex error item "));
    expect(items).toHaveLength(3);
    expect(items[2]).toMatch(/Under-development features enabled: skip_host_skill_discovery/);
  });

  it("C8.11b: still refuses an item type it does not know, as a tool", async () => {
    const w = await world({ rows: [{ type: "item.completed", item: { id: "i", type: "some_future_tool_call", status: "completed" } }, { type: "item.completed", item: { type: "agent_message", text: "{\"answer\":\"42\"}" } }, { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 6 } }] });
    const error = await failure(w.adapter.singleCall!(w.request));
    expect(error).toMatchObject({ code: "codex-single-call-not-single:tool" });
    expect(observedTokensOf(error)).toBe(36);
  });

  // Task 8 fix round 2, spec §6.1 ("the matching -c override"): the MCP servers the linked config.toml defines would start
  // inside the call (P1: figma's auth error on stderr). Each listed server is turned off by name; measured on codex-cli
  // 0.160.0 that `-c mcp_servers={}` leaves them on and an unknown name breaks the config, so the names come from the
  // installation's own `codex mcp list --json`, read with the catalog and cached with it.
  it("C8.10: turns off every MCP server the installation lists, by name", async () => {
    const w = await world();
    await writeFile(`${w.marker}.catalog.json`, JSON.stringify({ mcp: [{ name: "figma", enabled: true }, { name: "node_repl", enabled: true }, { name: "computer-use", enabled: false }] }));
    await w.adapter.singleCall!(w.request);
    expect(configValues(lastArgv(w.marker)).slice(-4)).toEqual([
      "features.view_image=false", "mcp_servers.figma.enabled=false", "mcp_servers.node_repl.enabled=false", "mcp_servers.computer-use.enabled=false",
    ]);
  });

  it.each([
    ["the list fails", { mcpExitCode: 4 }],
    ["a server has no name", { mcp: [{ enabled: true }] }],
    // Measured on codex-cli 0.160.0: `-c mcp_servers."figma".enabled=false` breaks the config, so a dotted name cannot be turned off.
    ["a server name -c cannot address", { mcp: [{ name: "figma", enabled: true }, { name: "a.b", enabled: true }] }],
  ])("C8.10b: refuses before spawning, booking 0, when the MCP server list cannot be read (%s)", async (_label, catalog) => {
    const w = await world();
    await writeFile(`${w.marker}.catalog.json`, JSON.stringify(catalog));
    const error = await failure(w.adapter.singleCall!(w.request));
    expect(error).toMatchObject({ code: "codex-single-call-unavailable", neverStarted: true });
    expect(observedTokensOf(error)).toBe(0);
    expect(existsSync(`${w.marker}.calls`)).toBe(false);
  });

  // A codex cache entry written before the names were cached cannot answer them, so it is a miss, not a hit with none.
  it("C8.10c: a cached codex entry without MCP server names is a miss", async () => {
    const w = await world();
    expect((await readAgentCatalog(w.config.installation)).codexMcpServers).toEqual([]);
    const file = join(process.env.CCLOOP_CACHE_DIR!, entryFileName(await catalogKey(w.config.installation, process.env)));
    const entry = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(entry.codexMcpServers).toEqual([]);
    delete entry.codexMcpServers;
    await writeFile(file, JSON.stringify(entry));
    expect((await readAgentCatalog(w.config.installation)).source).toBe("probe");
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
