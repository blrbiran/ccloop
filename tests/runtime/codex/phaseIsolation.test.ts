import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CODEX_PHASE_CONFIG } from "../../../src/agents/codexIsolation.js";
import type { InstallationV1 } from "../../../src/agents/types.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { runCodexPhase, type PhaseOutcome } from "../../../src/runtime/codex/runCodexPhase.js";
import { codexFixture } from "./fixture.js";

// Codex phase isolation (ccloop spec 2026-10-18 §3.3, §3.5, §5): with an installation, a codex loop phase runs in the
// installation's private HOME/CODEX_HOME pair with the operator's skills, AGENTS.md, hooks, MCP servers, notify and
// plugin/app blocks off, keeps the repo's docs, environment context, permissions and tools, and when the isolation cannot
// be set up it is refused before anything is spawned or linked -- never run unisolated. Without an installation nothing
// changes.
type World = Awaited<ReturnType<typeof world>>;
async function world(mode = "integration", catalog: unknown = { mcp: [{ name: "figma", enabled: true }, { name: "ccmem_x", enabled: true }] }) {
  const f = await codexFixture(mode);
  const source = join(f.dir, "source-codex-home");
  await mkdir(source); await writeFile(join(source, "auth.json"), "{}"); await writeFile(join(source, "config.toml"), "");
  const cache = await realpath(await mkdtemp(join(tmpdir(), "ccloop-phase-iso-cache-")));
  vi.stubEnv("CCLOOP_CACHE_DIR", cache);
  await writeFile(`${f.marker}.catalog.json`, JSON.stringify(catalog));
  const installation: InstallationV1 = { kind: "codex", command: f.config.command as [string, ...string[]], version: "9.9.9-fake", configDir: source,
    timeoutMs: 10_000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft" };
  const config = parseCodexConfig(f.config);
  const base = join(cache, "codex-home", createHash("sha256").update(`${await realpath(process.execPath)}\0${source}`).digest("hex"));
  const run = (phase: "plan" | "execute" | "verify" = "plan", options: { skillsDir?: string; context?: typeof f.context } = {}) =>
    runCodexPhase(config, { phase, prompt: "p", context: options.context ?? f.context }, { CODEX_HOME: source }, options.skillsDir, installation);
  return { ...f, source, cache, installation, codexConfig: config, base, run };
}
const args = (w: World): string[] => (JSON.parse(readFileSync(w.marker, "utf8")) as { args: string[] }).args;
const cValues = (argv: string[]) => argv.flatMap((arg, i) => (arg === "-c" ? [argv[i + 1]!] : []));
const phaseEnv = (w: World) => JSON.parse(readFileSync(`${w.marker}.phase-env.json`, "utf8")) as { HOME: string | null; CODEX_HOME: string | null };
const outcomeJson = (outcome: PhaseOutcome) => JSON.parse(readFileSync(join(outcome.evidenceDir, "outcome.json"), "utf8")) as Record<string, unknown>;
async function skillsDir(w: World): Promise<string> {
  const dir = join(w.dir, "snapshot", "skills");
  await mkdir(join(dir, "selected"), { recursive: true });
  await writeFile(join(dir, "selected", "SKILL.md"), "orca skill marker");
  return dir;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("an isolated codex phase (spec 2026-10-18 §3.3)", { timeout: 30_000 }, () => {
  let w: World, outcome: PhaseOutcome;
  beforeAll(async () => {
    w = await world();
    outcome = await w.run("plan");
    vi.unstubAllEnvs();
  });

  it("an isolated phase runs with the installation's private HOME and CODEX_HOME", () => {
    expect(outcome.reason).toBe("completed");
    expect(phaseEnv(w)).toEqual({ HOME: join(w.base, "home"), CODEX_HOME: join(w.base, "codex-home") });
  });

  for (const v of [...CODEX_PHASE_CONFIG, "mcp_servers.figma.enabled=false", "mcp_servers.ccmem_x.enabled=false", `shell_environment_policy.set.HOME=${JSON.stringify(process.env.HOME)}`]) {
    it(`an isolated phase sends -c ${v}`, () => {
      expect(cValues(args(w))).toContain(v);
    });
  }

  it("an isolated phase keeps repo docs, environment context, permissions and tool flags", () => {
    const argv = args(w), values = cValues(argv);
    for (const dropped of ["project_doc_max_bytes=0", "include_environment_context=false", "include_permissions_instructions=false"]) expect(values).not.toContain(dropped);
    expect(values.filter((value) => /^features\.(?!plugins=|hooks=)/.test(value))).toEqual([]);
    expect(argv.at(-1)).toBe("-");
    expect(argv.slice(0, argv.indexOf("-c"))).toEqual(["--json", "--ephemeral", "--color", "never", "--model", "fixture", "--sandbox", "read-only",
      "-C", w.repo, "--output-schema", join(outcome.evidenceDir, "schema.json"), "-o", join(outcome.evidenceDir, "final.json")]);
  });

  it("outcome.json records the isolation paths", () => {
    expect(outcomeJson(outcome).isolation).toEqual({ home: join(w.base, "home"), codexHome: join(w.base, "codex-home"), catalogError: null });
  });
});

describe("codex phase isolation, one phase each (spec 2026-10-18 §3.3, §3.5)", { timeout: 30_000 }, () => {
  it("the execute phase keeps its sandbox under isolation", async () => {
    const w = await world();
    expect((await w.run("execute")).reason).toBe("completed");
    const argv = args(w);
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(phaseEnv(w).CODEX_HOME).toBe(join(w.base, "codex-home"));
  });

  it("a phase with no MCP list is refused before spawn and leaves its evidence", async () => {
    const w = await world("integration", { mcpExitCode: 1 });
    const outcome = await w.run("plan");
    expect(outcome.reason).toBe("codex-phase-isolation-no-mcp-list");
    expect(existsSync(`${w.marker}.argv`)).toBe(false);
    const recorded = outcomeJson(outcome);
    expect(recorded.reason).toBe("codex-phase-isolation-no-mcp-list");
    expect(recorded.isolation).toEqual({ home: join(w.base, "home"), codexHome: join(w.base, "codex-home"), catalogError: null });
    expect(existsSync(join(outcome.evidenceDir, "process.json"))).toBe(false);
  });

  it("a phase with an unaddressable MCP name is refused before spawn", async () => {
    const w = await world("integration", { mcp: [{ name: "bad.name", enabled: true }] });
    expect((await w.run("plan")).reason).toBe("codex-phase-isolation-mcp-unaddressable:\"bad.name\"");
    expect(existsSync(`${w.marker}.argv`)).toBe(false);
  });

  it("a phase whose private home is a symlink is refused before spawn", async () => {
    const w = await world();
    await mkdir(w.base, { recursive: true, mode: 0o700 });
    const elsewhere = join(w.dir, "elsewhere"); await mkdir(elsewhere);
    await symlink(elsewhere, join(w.base, "home"));
    const outcome = await w.run("plan");
    expect(outcome.reason).toBe(`codex-phase-isolation-home-invalid:${join(w.base, "home")}`);
    expect(existsSync(`${w.marker}.argv`)).toBe(false);
    expect(outcomeJson(outcome).isolation).toMatchObject({ home: null, codexHome: null });
  });

  // Plan Review Focus 3: isolation is decided before withCodexSkillLinks, so a refused phase never touches the worktree
  // (the repo dir's mtime would move if .agents were created and removed again).
  it("a refused phase links no skills", async () => {
    const w = await world("integration", { mcpExitCode: 1 });
    const skills = await skillsDir(w);
    await mkdir(w.runDir, { recursive: true });
    const before = { mtime: (await stat(w.repo)).mtimeMs, entries: await readdir(w.repo) };
    const outcome = await w.run("plan", { skillsDir: skills });
    expect(outcome.reason).toBe("codex-phase-isolation-no-mcp-list");
    expect(existsSync(join(w.repo, ".agents", "skills", "selected"))).toBe(false);
    expect(existsSync(`${w.repo}.codex-skills-pending`)).toBe(false);
    expect({ mtime: (await stat(w.repo)).mtimeMs, entries: await readdir(w.repo) }).toEqual(before);
  });

  it("an isolated phase still links and removes Orca's skills", async () => {
    const w = await world("skill-integration");
    const outcome = await w.run("plan", { skillsDir: await skillsDir(w) });
    expect(outcome.reason).toBe("completed");
    expect(readFileSync(`${w.marker}.skills`, "utf8")).toContain("orca skill marker");
    expect(existsSync(join(w.repo, ".agents", "skills", "selected"))).toBe(false);
    expect(phaseEnv(w).CODEX_HOME).toBe(join(w.base, "codex-home"));
  });

  it("an abort during the catalog read ends the phase as aborted", async () => {
    const w = await world("integration", { sleepMs: 2000, mcp: [] });
    const controller = new AbortController();
    const watcher = setInterval(() => { if (existsSync(`${w.marker}.catalog-calls`)) controller.abort(); }, 5);
    try {
      const outcome = await w.run("plan", { context: { ...w.context, abortSignal: controller.signal } });
      expect(outcome.reason).toBe("aborted");
    } finally { clearInterval(watcher); }
    expect(existsSync(`${w.marker}.argv`)).toBe(false);
  });

  it("a catalog read that outlasts the phase deadline ends it as timeout", async () => {
    const w = await world("integration", { sleepMs: 1000, mcp: [] });
    const context = { ...w.context, state: { ...w.context.state, budgetSnapshot: { ...w.context.state.budgetSnapshot, timeRemainingMs: 300 } } };
    expect((await w.run("plan", { context })).reason).toBe("timeout");
    expect(existsSync(`${w.marker}.argv`)).toBe(false);
  });

  // Plan Review Focus 2: the catalog cache key stamps the installation's config.toml, so a server added there is a miss and
  // the next phase turns it off.
  it("a server added to the installation's config.toml is off from the next phase on", async () => {
    const w = await world();
    expect((await w.run("plan")).reason).toBe("completed");
    expect(cValues(args(w))).not.toContain("mcp_servers.added.enabled=false");
    await writeFile(join(w.source, "config.toml"), "[mcp_servers.added]\ncommand = \"x\"\n");
    await writeFile(`${w.marker}.catalog.json`, JSON.stringify({ mcp: [{ name: "figma", enabled: true }, { name: "ccmem_x", enabled: true }, { name: "added", enabled: true }] }));
    expect((await w.run("plan")).reason).toBe("completed");
    expect(cValues(args(w))).toContain("mcp_servers.added.enabled=false");
  });

  // Plan Review Focus 4: two runs on one installation share the pair; the links stay intact and both spawn isolated.
  it("two concurrent phases share the pair and both run isolated", async () => {
    const a = await world(), b = await world();
    // One installation: b's pair is a's (same executable, same source CODEX_HOME, same cache dir).
    vi.stubEnv("CCLOOP_CACHE_DIR", a.cache);
    const bSame = { ...b, base: a.base, run: (phase: "plan") => runCodexPhase(b.codexConfig, { phase, prompt: "p", context: b.context }, { CODEX_HOME: a.source }, undefined, { ...b.installation, configDir: a.source }) };
    const [ra, rb] = await Promise.all([a.run("plan"), bSame.run("plan")]);
    expect([ra.reason, rb.reason]).toEqual(["completed", "completed"]);
    expect(phaseEnv(a)).toEqual({ HOME: join(a.base, "home"), CODEX_HOME: join(a.base, "codex-home") });
    expect(phaseEnv(b)).toEqual(phaseEnv(a));
    expect(await readlink(join(a.base, "codex-home", "auth.json"))).toBe(join(a.source, "auth.json"));
  });

  it("without an installation a phase spawns exactly as before", async () => {
    const w = await world();
    const outcome = await runCodexPhase(w.codexConfig, { phase: "plan", prompt: "p", context: w.context }, { CODEX_HOME: "/x" });
    expect(outcome.reason).toBe("completed");
    expect(phaseEnv(w)).toEqual({ HOME: process.env.HOME ?? null, CODEX_HOME: "/x" });
    expect(args(w)).not.toContain("-c");
    expect(Object.keys(outcomeJson(outcome))).not.toContain("isolation");
    expect(existsSync(`${w.marker}.catalog-calls`)).toBe(false);
  });
});
