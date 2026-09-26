import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import type { AgentSelectionV1, AgentsTableV1 } from "../../src/agents/types.js";
import { parseArgs } from "../../src/cli.js";
import { codexFixture, exec } from "../runtime/codex/fixture.js";

// Orca agent selection (2026-09-26), spec §4.9, §9 criteria 5c and 6: `ccloop run --agents <table>
// --agent-selection <file>` is how Orca's reconcile run starts. The file carries the selection Orca froze and
// its configHash; ccloop re-materializes against the table as it is now and refuses a drifted version or a
// different hash before reading the contract or starting anything.
const fakeCli = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function world(tableVersion = "9.9.9-fake") {
  const f = await codexFixture("integration");
  dirs.push(f.dir);
  const marker = join(f.dir, "claude-marker.json"), scriptPath = join(f.dir, "script.json");
  await writeFile(scriptPath, JSON.stringify({ "codex-test": { files: { "answer.txt": "42\n" } } }));
  const table: AgentsTableV1 = {
    schema: "ccloop-agents-table-v1",
    installations: {
      "claude-fake": { kind: "claude", command: [process.execPath, fakeCli, "script", marker, scriptPath], version: tableVersion, configDir: null, timeoutMs: 10_000, killGraceMs: 50 },
    },
  };
  const tablePath = join(f.dir, "agents.json"), selectionPath = join(f.dir, "selection.json"), contractPath = join(f.dir, "contract.json");
  await writeFile(tablePath, JSON.stringify(table), { mode: 0o600 });
  await writeFile(contractPath, JSON.stringify(f.contract));
  const selection: AgentSelectionV1 = { agent: "claude-fake", model: "claude-opus-5-5", contextWindow: 1_000_000 };
  return { ...f, marker, table, tablePath, selectionPath, contractPath, selection };
}

async function runCli(w: Awaited<ReturnType<typeof world>>): Promise<{ code: number; stdout: string; stderr: string }> {
  return exec(process.execPath, ["--import", loader, cli, "run", "--contract", w.contractPath, "--run-dir", w.runDir, "--agents", w.tablePath, "--agent-selection", w.selectionPath], { cwd: w.dir, timeout: 20_000 })
    .then((r) => ({ ...r, code: 0 }), (e: { stdout: string; stderr: string; code: number }) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
}

describe("ccloop run --agents --agent-selection (Orca agent selection, spec §4.9)", () => {
  it("parses the agents form of run", () => {
    expect(parseArgs(["run", "--contract", "c", "--run-dir", "r", "--agents", "t", "--agent-selection", "s"]))
      .toEqual({ command: "run", contractPath: "c", runDir: "r", agentsTablePath: "t", agentSelectionPath: "s" });
  });

  it.each([
    [["run", "--contract", "c", "--run-dir", "r", "--agents", "t", "--agent-selection", "s", "--adapter", "codex"], "--agents and --adapter are mutually exclusive"],
    [["run", "--contract", "c", "--run-dir", "r", "--agents", "t", "--agent-selection", "s", "--adapter-config", "a"], "--agents and --adapter are mutually exclusive"],
    [["run", "--contract", "c", "--run-dir", "r", "--agents", "t"], "missing required flags"],
    [["run", "--contract", "c", "--run-dir", "r", "--agent-selection", "s"], "missing required flags"],
    [["resume", "--run-dir", "r", "--agents", "t", "--agent-selection", "s"], "--agents is only supported by run"],
    // P23 m6: `--agents` must be refused by `sweep` too, not only `resume` — sweep has its own early-return
    // branch in parseArgs, so this exercises a path resume's case does not.
    [["sweep", "--root", "r", "--agents", "t", "--agent-selection", "s"], "--agents is only supported by run"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it("runs the selected installation, whose model reaches the claude CLI", async () => {
    const w = await world();
    const { resolution } = await resolveAgent(w.table, w.selection);
    await writeFile(w.selectionPath, JSON.stringify({ selection: w.selection, configHash: resolution.configHash }), { mode: 0o600 });
    const result = await runCli(w);
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(join(w.runDir, "loop-state.json"), "utf8")).status).toBe("succeeded");
    expect((await readFile(`${w.marker}.calls`, "utf8")).trim().split("\n")).toEqual(["plan", "execute", "verify"]);
    const argv = (await readFile(`${w.marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(argv.map((args) => args[args.indexOf("--model") + 1])).toEqual(["claude-opus-5-5[1m]", "claude-opus-5-5[1m]", "claude-opus-5-5[1m]"]);
  }, 30_000);

  it("runs a codex installation the same way, with codex's soft-budget notice", async () => {
    const w = await world();
    const table: AgentsTableV1 = {
      schema: "ccloop-agents-table-v1",
      installations: {
        "codex-fake": { kind: "codex", command: [...w.config.command] as [string, ...string[]], version: "9.9.9-fake", configDir: null, timeoutMs: 10_000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft" },
      },
    };
    await writeFile(w.tablePath, JSON.stringify(table), { mode: 0o600 });
    const selection: AgentSelectionV1 = { agent: "codex-fake", model: "gpt-6-sol", contextWindow: "agent-default" };
    const { resolution } = await resolveAgent(table, selection);
    await writeFile(w.selectionPath, JSON.stringify({ selection, configHash: resolution.configHash }), { mode: 0o600 });
    const result = await runCli(w);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Codex budgetMode=soft");
    const argv = (await readFile(`${w.config.command[3]}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(argv.map((args) => args[args.indexOf("--model") + 1])).toEqual(["gpt-6-sol", "gpt-6-sol", "gpt-6-sol"]);
  }, 30_000);

  it("refuses a selection file whose configHash differs, before anything runs", async () => {
    const w = await world();
    await writeFile(w.selectionPath, JSON.stringify({ selection: w.selection, configHash: "0".repeat(64) }), { mode: 0o600 });
    const result = await runCli(w);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("control-config-hash-mismatch");
    expect(existsSync(`${w.marker}.argv`)).toBe(false);
    expect(existsSync(join(w.runDir, "loop-state.json"))).toBe(false);
  }, 30_000);

  // Orca final review I-2 (human ruling 2026-09-26: agent CLIs stay free to upgrade in place). A reconcile selection
  // frozen while the CLI answered an older version runs once the table records the version the CLI answers now.
  it("runs a selection frozen before the CLI was upgraded, once the table records the new version", async () => {
    const w = await world();
    const beforeUpgrade: AgentsTableV1 = { ...w.table, installations: { "claude-fake": { ...w.table.installations["claude-fake"]!, version: "9.9.8-fake" } } };
    const { resolution } = await resolveAgent(beforeUpgrade, w.selection, { probeVersion: async () => "9.9.8-fake" });
    await writeFile(w.selectionPath, JSON.stringify({ selection: w.selection, configHash: resolution.configHash }), { mode: 0o600 });
    const result = await runCli(w);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(w.runDir, "loop-state.json"), "utf8")).status).toBe("succeeded");
  }, 30_000);

  it("refuses an installation whose --version no longer matches the table, before anything runs", async () => {
    const w = await world("0.0.1");
    // The hash Orca would have frozen for this table: computed with the table's own version answered.
    const { resolution } = await resolveAgent(w.table, w.selection, { probeVersion: async () => "0.0.1" });
    await writeFile(w.selectionPath, JSON.stringify({ selection: w.selection, configHash: resolution.configHash }), { mode: 0o600 });
    const result = await runCli(w);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("agent-version-drift");
    expect(existsSync(`${w.marker}.argv`)).toBe(false);
    expect(existsSync(join(w.runDir, "loop-state.json"))).toBe(false);
  }, 30_000);

  // Orca wave-2 review I-3 ruling (2026-09-26): a CLI whose version cannot be observed is not a refusal. `run --agents`
  // still exits 1 before anything runs, but stderr must not start with a code: Orca reads a leading hyphenated code on
  // exit 1 as a named refusal (reconcile-refused, blocks for good) and anything else as reconcile-spawn (retryable).
  it("fails an unobservable --version with a non-code message, before anything runs", async () => {
    const w = await world();
    const silent = join(w.dir, "silent.mjs");
    await writeFile(silent, 'console.log("no version here");\n', { mode: 0o600 });
    for (const command of [["/usr/bin/false"], [process.execPath, silent]] as [string, ...string[]][]) {
      const table: AgentsTableV1 = { schema: "ccloop-agents-table-v1", installations: { "claude-fake": { ...w.table.installations["claude-fake"]!, command } } };
      await writeFile(w.tablePath, JSON.stringify(table), { mode: 0o600 });
      // The hash Orca would have frozen: computed with the table's own version answered.
      const { resolution } = await resolveAgent(table, w.selection, { probeVersion: async () => "9.9.9-fake" });
      await writeFile(w.selectionPath, JSON.stringify({ selection: w.selection, configHash: resolution.configHash }), { mode: 0o600 });
      const result = await runCli(w);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+/);
      expect(result.stderr).not.toContain("agent-version-drift");
      expect(result.stderr).toContain("Could not observe the version");
      expect(existsSync(`${w.marker}.argv`)).toBe(false);
      expect(existsSync(join(w.runDir, "loop-state.json"))).toBe(false);
    }
  }, 30_000);

  it("refuses a malformed selection file by name", async () => {
    const w = await world();
    await writeFile(w.selectionPath, JSON.stringify({ selection: { ...w.selection, extra: true }, configHash: "0".repeat(64) }), { mode: 0o600 });
    const result = await runCli(w);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("agent-selection-file-invalid");
  }, 30_000);

  // Fix round 1 (Important finding): the JSON.parse try/catch in runWithAgents (src/cli.ts, the
  // selection-file read) had no criterion — every other test in this file writes syntactically
  // valid JSON, so a JSON.parse failure never actually executed. This writes genuinely malformed
  // JSON (truncated, not even parseable) and pins the same agent-selection-file-invalid refusal.
  it("refuses a selection file that isn't valid JSON", async () => {
    const w = await world();
    await writeFile(w.selectionPath, '{"selection":', { mode: 0o600 });
    const result = await runCli(w);
    expect(result.code).toBe(1);
    expect(result.stderr.startsWith("agent-selection-file-invalid")).toBe(true);
  }, 30_000);
});
