import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runAgentsCommand } from "../../src/agents/command.js";
import { runControlCommand } from "../../src/control/command.js";
import { claudeInstallation, codexInstallation, FAKE_CLAUDE_CLI, writeAgentsTable } from "./agentsFixture.js";

// Every-agent requirement chain (Orca spec 2026-10-15 §3, part A): one installation's models, sorted by model in code-unit
// order; codex lists only `list` rows; claude has no catalog command and answers none.
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs"), FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
async function world() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-models-")));
  const ompMarker = join(dir, "omp-marker"), codexMarker = join(dir, "codex-marker");
  await writeFile(`${ompMarker}.catalog.json`, JSON.stringify([
    { provider: "openrouter", kind: "chat", id: "z", selector: "openrouter/z", contextWindow: 64000, maxTokens: 4096 },
    { provider: "gateway", kind: "chat", id: "model-a", selector: "gateway/model-a", contextWindow: 200000, maxTokens: 8192 },
    { provider: "gateway", kind: "chat", id: "B", selector: "gateway/B", contextWindow: 128000 },
  ]));
  const omp = join(dir, "omp");
  await writeFile(omp, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${ompMarker}' "$@"\n`, { mode: 0o700 });
  const script = join(dir, "script.json"); await writeFile(script, "{}\n", { mode: 0o600 });
  // Every spawn of the claude command, `--version` included, appends a line to `claudeSpawns`.
  const claude = join(dir, "claude"), claudeSpawns = join(dir, "claude-spawns");
  await writeFile(claude, `#!/bin/sh\necho spawn >> '${claudeSpawns}'\nexec '${process.execPath}' '${FAKE_CLAUDE_CLI}' script '${join(dir, "claude-marker")}' '${script}' "$@"\n`, { mode: 0o700 });
  // An empty configDir of its own: with none, codex's window would come from the person's ~/.codex/config.toml.
  const codexHome = join(dir, "codex-home"); await mkdir(codexHome, { mode: 0o700 });
  const t = await writeAgentsTable({
    omp: { kind: "omp", command: [omp], version: "18.10.1", configDir: null, timeoutMs: 60_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
    codex: { ...await codexInstallation({ command: [process.execPath, FAKE_CODEX, "integration", codexMarker], sandbox: "read-only", budgetMode: "soft", timeoutMs: 60_000, killGraceMs: 100 }), configDir: codexHome },
    claude: await claudeInstallation([claude]),
  }, dir);
  return { dir, ...t, ompMarker, codexMarker, claudeSpawns };
}
const models = (path: string, installation: string, refresh = false) => runControlCommand(["models", "--agents", path], JSON.stringify({ installation, refresh }));

describe("control models (spec §3)", { timeout: 30_000 }, () => {
  it("answers omp's rows sorted in code-unit order with window, cap and single-call answer", async () => {
    const w = await world();
    // Orca reads ccloop's code from the start of stderr, so the wire path prints nothing there on success -- neither in
    // its answer nor on the process's own stderr, although this first read is a cache miss.
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    let answer: Awaited<ReturnType<typeof models>>;
    try { answer = await models(w.path, "omp"); } finally { spy.mockRestore(); }
    expect(written).toEqual([]);
    expect(answer.code, answer.stderr).toBe(0);
    expect(answer.stderr).toBe("");
    expect(JSON.parse(answer.stdout)).toMatchObject({ schema: "ccloop-models-v1", installation: "omp", kind: "omp", source: "probe", models: [
      { model: "gateway/B", contextWindowTokens: 128000, maxOutputTokens: null, singleCallExecution: null },
      { model: "gateway/model-a", contextWindowTokens: 200000, maxOutputTokens: 8192, singleCallExecution: "v1" },
      { model: "openrouter/z", contextWindowTokens: 64000, maxOutputTokens: 4096, singleCallExecution: null },
    ] });
    const again = await models(w.path, "omp");
    expect(again.stderr).toBe("");
    expect(JSON.parse(again.stdout).source).toBe("cache");
  });

  it("answers codex's listed rows only, each v1-soft with no output cap", async () => {
    const w = await world();
    const answer = await models(w.path, "codex");
    expect(answer.stderr).toBe("");
    expect(JSON.parse(answer.stdout).models).toEqual([
      { model: "gpt-6-luna", contextWindowTokens: 272000, maxOutputTokens: null, singleCallExecution: "v1-soft" },
      { model: "gpt-6-sol", contextWindowTokens: 272000, maxOutputTokens: null, singleCallExecution: "v1-soft" },
    ]);
  });

  it("answers claude with no models and source none, spawning nothing", async () => {
    const w = await world();
    const before = readFileSync(w.claudeSpawns, "utf8");
    expect(JSON.parse((await models(w.path, "claude")).stdout)).toEqual({ schema: "ccloop-models-v1", installation: "claude", kind: "claude", source: "none", observedAt: null, models: [] });
    expect(readFileSync(w.claudeSpawns, "utf8")).toBe(before);
  });

  it("refresh probes again", async () => {
    const w = await world();
    await models(w.path, "omp"); await models(w.path, "omp", true);
    expect(readFileSync(`${w.ompMarker}.catalog-calls`, "utf8").trim().split("\n")).toEqual(["models", "models"]);
  });

  it("names a missing installation with exit 2 (RF5) and a catalog failure with exit 1 and the kind's code", async () => {
    const w = await world();
    expect(await models(w.path, "gone")).toEqual({ code: 2, stdout: "", stderr: "agent-installation-missing: gone\n" });
    await writeFile(join(w.dir, "codex-marker.catalog.json"), JSON.stringify({ exitCode: 5 }));
    const failed = await models(w.path, "codex");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/^agent-catalog-unavailable: exit 5 · stage exit · elapsedMs \d+\n$/);
  });

  it("refuses a request without a boolean refresh", async () => {
    const w = await world();
    expect(await runControlCommand(["models", "--agents", w.path], JSON.stringify({ installation: "omp" }))).toMatchObject({ code: 2, stderr: "control-request-invalid\n" });
  });

  it("prints the same answer from `ccloop agents models`, and logs a miss on stderr", async () => {
    const w = await world();
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    let cli: Awaited<ReturnType<typeof runAgentsCommand>>;
    try { cli = await runAgentsCommand(["models", "--agents", w.path, "--installation", "codex"]); } finally { spy.mockRestore(); }
    expect(cli.code, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout).models.map((row: { model: string }) => row.model)).toEqual(["gpt-6-luna", "gpt-6-sol"]);
    expect(existsSync(`${w.codexMarker}.catalog-calls`)).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^ccloop-agent-catalog: miss codex [0-9a-f]{12}\n$/);
  });

  it("`ccloop agents models --refresh` probes again over a warm cache", async () => {
    const w = await world();
    const probes = () => readFileSync(`${w.codexMarker}.catalog-calls`, "utf8").split("\n").filter((line) => line === "debug-models").length;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect((await runAgentsCommand(["models", "--agents", w.path, "--installation", "codex"])).code).toBe(0);
      expect(probes()).toBe(1);
      expect((await runAgentsCommand(["models", "--agents", w.path, "--installation", "codex"])).code).toBe(0);
      expect(probes()).toBe(1);
      const refreshed = await runAgentsCommand(["models", "--agents", w.path, "--installation", "codex", "--refresh"]);
      expect(refreshed.code).toBe(0);
      expect(JSON.parse(refreshed.stdout).source).toBe("probe");
      expect(probes()).toBe(2);
    } finally { spy.mockRestore(); }
  });

  // Fix round 1 (controller ruling, 2026-10-16): the vitest setup points CODEX_HOME at an empty temp dir, so a codex
  // installation with no configDir answers the fake catalog's window, never a config.toml under HOME/.codex.
  it("a codex installation with no configDir never reads a window from HOME/.codex", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-models-home-")));
    await mkdir(join(dir, "home", ".codex"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "home", ".codex", "config.toml"), "model_context_window = 999999\n", { mode: 0o600 });
    const t = await writeAgentsTable({
      codex: await codexInstallation({ command: [process.execPath, FAKE_CODEX, "integration", join(dir, "codex-marker")], sandbox: "read-only", budgetMode: "soft", timeoutMs: 60_000, killGraceMs: 100 }),
    }, dir);
    expect(t.table.installations.codex!.configDir).toBeNull();
    const home = process.env.HOME;
    process.env.HOME = join(dir, "home");
    let answer: Awaited<ReturnType<typeof models>>;
    try { answer = await models(t.path, "codex"); } finally { process.env.HOME = home; }
    expect(answer.code, answer.stderr).toBe(0);
    expect(JSON.parse(answer.stdout).models.map((row: { contextWindowTokens: number }) => row.contextWindowTokens)).toEqual([272000, 272000]);
  });

  it("refuses any other `ccloop agents models` shape", async () => {
    const w = await world();
    for (const argv of [["models", "--agents", w.path], ["models", "--installation", "codex", "--agents", w.path, "--refresh", "--refresh"], ["models", "--agents", w.path, "--installation", "codex", "--fresh"]]) {
      expect(await runAgentsCommand(argv)).toEqual({ code: 1, stdout: "", stderr: "agents-command-invalid\n" });
    }
  });
});
