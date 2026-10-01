import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    // Rewritten (consolidation step 2, controller ruling C-5 under the human's standing instruction, 2026-10-01).
    // resume and sweep now take `--agents <table>`, but never `--agent-selection`: the selection is the run's own
    // (frozen into its run directory by `run --agents`), not the caller's.
    [["resume", "--run-dir", "r", "--agents", "t", "--agent-selection", "s"], "--agent-selection is only supported by run"],
    // P23 m6: `--agents` must be refused by `sweep` too, not only `resume` — sweep has its own early-return
    // branch in parseArgs, so this exercises a path resume's case does not.
    // Rewritten (consolidation step 2, controller ruling C-5 under the human's standing instruction, 2026-10-01).
    [["sweep", "--root", "r", "--agents", "t", "--agent-selection", "s"], "--agent-selection is only supported by run"],
    [["resume", "--run-dir", "r", "--agents", "t", "--adapter", "codex"], "--agents and --adapter are mutually exclusive"],
    [["sweep", "--root", "r", "--agents", "t"], "missing required flags"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  // Consolidation step 2 (spec 2026-10-01-agents-resume-sweep-design.md §3.2/§3.3): resume and sweep continue a run
  // started by `run --agents` with the table alone; sweep keeps its literal positive-integer --max-runs.
  it("parses the agents form of resume and sweep", () => {
    expect(parseArgs(["resume", "--run-dir", "r", "--agents", "t"])).toEqual({ command: "resume", runDir: "r", agentsTablePath: "t" });
    expect(parseArgs(["sweep", "--root", "r", "--agents", "t", "--max-runs", "2"])).toEqual({ command: "sweep", root: "r", agentsTablePath: "t", maxRuns: 2 });
    expect(() => parseArgs(["sweep", "--root", "r", "--agents", "t", "--max-runs", "1e3"])).toThrow("--max-runs must be a positive integer");
  });

  // Consolidation step 2, spec §3.1 (C-1): the selection is frozen into the run directory before the run starts, so
  // `resume --agents` can rebuild the same agent later. Owner-only (0600), like every selection file Orca writes.
  it("freezes the selection into the run directory before the run starts", async () => {
    const w = await world();
    const { resolution } = await resolveAgent(w.table, w.selection);
    const frozen = { selection: w.selection, configHash: resolution.configHash };
    await writeFile(w.selectionPath, JSON.stringify(frozen), { mode: 0o600 });
    const result = await runCli(w);
    expect(result.code, result.stderr).toBe(0);
    const path = join(w.runDir, "agent-selection.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(frozen);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }, 30_000);

  // An existing frozen file can only be a leftover; overwriting it would rebind someone else's run.
  it("refuses a run directory that already holds a frozen selection, leaving it unchanged", async () => {
    const w = await world();
    const { resolution } = await resolveAgent(w.table, w.selection);
    await writeFile(w.selectionPath, JSON.stringify({ selection: w.selection, configHash: resolution.configHash }), { mode: 0o600 });
    await mkdir(w.runDir, { recursive: true });
    await writeFile(join(w.runDir, "agent-selection.json"), "{}\n");
    const result = await runCli(w);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("agent-selection-exists");
    expect(await readFile(join(w.runDir, "agent-selection.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(w.runDir, "loop-state.json"))).toBe(false);
  }, 30_000);

  // The freshness refusal runLoop would give is run first, so a non-fresh directory is never written into.
  it("refuses a non-fresh run directory before freezing anything", async () => {
    const w = await world();
    const { resolution } = await resolveAgent(w.table, w.selection);
    await writeFile(w.selectionPath, JSON.stringify({ selection: w.selection, configHash: resolution.configHash }), { mode: 0o600 });
    await mkdir(w.runDir, { recursive: true });
    await writeFile(join(w.runDir, "events.jsonl"), "");
    const result = await runCli(w);
    expect(result.code).toBe(1);
    expect(existsSync(join(w.runDir, "agent-selection.json"))).toBe(false);
  }, 30_000);

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

  // Orca ruling review R1 (human ruling 2026-09-27): a reconcile selection frozen while the table named another
  // install path and other run limits runs under the table as it is now.
  it("runs a selection frozen before the CLI moved or its run limits changed", async () => {
    const w = await world();
    const current = w.table.installations["claude-fake"]!;
    const beforeMove: AgentsTableV1 = { ...w.table, installations: { "claude-fake": { ...current, command: ["/old/place/claude"], timeoutMs: current.timeoutMs + 1, killGraceMs: current.killGraceMs + 1 } } };
    const { resolution } = await resolveAgent(beforeMove, w.selection, { probeVersion: async () => current.version });
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
