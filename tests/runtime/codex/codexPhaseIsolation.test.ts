import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexSingleCallHome } from "../../../src/agents/codexIsolation.js";
import type { InstallationV1 } from "../../../src/agents/types.js";
import { codexPhaseConfigArgs, codexPhaseIsolation } from "../../../src/runtime/codex/codexPhaseIsolation.js";

// Codex phase isolation (ccloop spec 2026-10-18 §3.3, §3.4, §3.5): a dispatched codex phase must not carry the operator's
// personal setup (skills, AGENTS.md, hooks, MCP servers, notify, plugin/app blocks), the commands it runs keep the real
// HOME, and when the isolation cannot be set up the phase is refused (never started, booked 0) rather than run unisolated.
async function world(envOverrides: NodeJS.ProcessEnv = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-phase-iso-")));
  const source = join(dir, "source-codex-home");
  await mkdir(source); await writeFile(join(source, "auth.json"), "{}"); await writeFile(join(source, "config.toml"), "");
  const installation: InstallationV1 = { kind: "codex", command: [process.execPath, "unused"], version: "9.9.9-fake", configDir: source,
    timeoutMs: 10_000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft" };
  const env: NodeJS.ProcessEnv = { HOME: join(dir, "real-home"), CCLOOP_CACHE_DIR: join(dir, "cache"), ...envOverrides };
  const runDir = join(dir, "run"); await mkdir(runDir);
  return { dir, source, installation, env, runDir };
}
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);

describe("codex phase isolation module (spec 2026-10-18 §3.3-§3.5)", () => {
  it("phase -c list holds exactly the five phase values, the MCP offs and the real HOME for commands", () => {
    expect(codexPhaseConfigArgs(["figma", "ccmem_x"], "/h")).toEqual([
      "-c", "notify=[]", "-c", "features.plugins=false", "-c", "include_apps_instructions=false",
      "-c", "include_collaboration_mode_instructions=false", "-c", "features.hooks=false",
      "-c", "mcp_servers.figma.enabled=false", "-c", "mcp_servers.ccmem_x.enabled=false",
      "-c", "shell_environment_policy.set.HOME=\"/h\"",
    ]);
  });

  it("quotes a real HOME with quotes and backslashes as a TOML string", () => {
    expect(codexPhaseConfigArgs([], "/t/a \"b\"\\c").at(-1)).toBe("shell_environment_policy.set.HOME=\"/t/a \\\"b\\\"\\\\c\"");
  });

  it("uses the single call's pair for the same installation", async () => {
    const w = await world();
    const isolated = await codexPhaseIsolation({ installation: w.installation, mcpServers: [], runDir: w.runDir, attempt: 1, env: w.env });
    const single = await codexSingleCallHome({ runDir: "", sourceCodexHome: w.source, executable: process.execPath, env: w.env });
    expect({ home: isolated.home, codexHome: isolated.codexHome }).toEqual(single);
    expect(await readlink(join(isolated.codexHome, "auth.json"))).toBe(join(w.source, "auth.json"));
    expect(isolated.args).toEqual(codexPhaseConfigArgs([], w.env.HOME!));
  });

  it("without a cache dir the pair lives under the attempt's phase-isolation dir", async () => {
    const w = await world({ CCLOOP_CACHE_DIR: "relative" });
    const isolated = await codexPhaseIsolation({ installation: w.installation, mcpServers: [], runDir: w.runDir, attempt: 3, env: w.env });
    expect(isolated.home.startsWith(join(w.runDir, "codex", "3", "phase-isolation", "home-"))).toBe(true);
    expect(isolated.codexHome.startsWith(join(w.runDir, "codex", "3", "phase-isolation", "home-"))).toBe(true);
  });

  it("refuses with no MCP list", async () => {
    const w = await world();
    const error = await failure(codexPhaseIsolation({ installation: w.installation, mcpServers: null, runDir: w.runDir, attempt: 1, env: w.env }));
    expect(error).toMatchObject({ reason: "codex-phase-isolation-no-mcp-list", neverStarted: true, message: "codex-phase-isolation-no-mcp-list" });
  });

  it("refuses an MCP name -c cannot address", async () => {
    const w = await world();
    const error = await failure(codexPhaseIsolation({ installation: w.installation, mcpServers: ["ok", "bad.name"], runDir: w.runDir, attempt: 1, env: w.env }));
    expect(error).toMatchObject({ reason: "codex-phase-isolation-mcp-unaddressable:\"bad.name\"", neverStarted: true });
  });

  it("refuses a symlinked private dir, named as such", async () => {
    const w = await world();
    const id = createHash("sha256").update(`${await realpath(process.execPath)}\0${w.source}`).digest("hex");
    const base = join(w.env.CCLOOP_CACHE_DIR!, "codex-home", id);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const elsewhere = join(w.dir, "elsewhere"); await mkdir(elsewhere);
    await symlink(elsewhere, join(base, "home"));
    for (const mcpServers of [[], null]) {
      const error = await failure(codexPhaseIsolation({ installation: w.installation, mcpServers, runDir: w.runDir, attempt: 1, env: w.env }));
      expect(error).toMatchObject({ reason: `codex-phase-isolation-home-invalid:${join(base, "home")}`, neverStarted: true });
    }
  });

  it("refuses when the real HOME is unknown", async () => {
    for (const HOME of ["", "rel"]) {
      const w = await world({ HOME });
      const error = await failure(codexPhaseIsolation({ installation: w.installation, mcpServers: [], runDir: w.runDir, attempt: 1, env: w.env }));
      expect(error).toMatchObject({ reason: "codex-phase-isolation-real-home-unknown", neverStarted: true });
    }
  });
});
