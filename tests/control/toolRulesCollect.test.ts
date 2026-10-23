// Per-contract tool rules: the report (ccloop spec 2026-10-22 §5, §8 T6; plan Task 5). Orca shows each declared rule's
// status as ccloop reports it and flags `detected`, `recorded-only` network and `refused` red, so the report must exist for
// every run whose contract has rules -- `commands-closed` included even with `commands: []`, because that row is what says
// whether the agent can run something else -- and must reach Orca through collect at the top level (the protocol-4
// terminal is a strict RunState). A secret is declared by name only: its value must never be written anywhere ccloop writes.
import { readdir, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { savedRecoveryFixture } from "./savedRecoveryFixture.js";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { parseAgentsTable } from "../../src/agents/table.js";
import { collectExecution } from "../../src/control/collect.js";
import { runControlCommand } from "../../src/control/command.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { buildToolRulesReport } from "../../src/control/toolRulesReport.js";
import type { ToolRulesV1 } from "../../src/runtime/toolRules.js";
import { codexFixture } from "../runtime/codex/fixture.js";
import { FAKE_CLAUDE_CLI, claudeInstallation, sealClaude } from "./agentsFixture.js";
import { dispose, ompInstallation, type World } from "../fixtures/toolRules/argvCapture.js";

const SECRET_VALUE = "s3cr3t-value-7f1c9a-never-written";
const worlds: World[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const w of worlds.splice(0)) await dispose(w); });

/** A real control worker, in process, running an omp loop on fake-omp (the pattern of ompSkillsDir.test.ts). */
async function workerRun(toolRules: ToolRulesV1 | undefined, protocol: 3 | 4 = 3) {
  const runtime = await codexFixture();
  const w = { dir: runtime.dir, repo: runtime.repo, runDir: runtime.runDir, marker: join(runtime.dir, "omp-marker"), contract: runtime.contract, context: runtime.context };
  worlds.push(w);
  const table = parseAgentsTable({ schema: "ccloop-agents-table-v1", installations: { omp: (await ompInstallation(w) as { installation: never }).installation } });
  const { config, resolution } = await resolveAgent(table, { agent: "omp" });
  await mkdir(join(runtime.dir, "input"));
  const contract = toolRules === undefined ? runtime.contract : { ...runtime.contract, executionPolicy: { ...runtime.contract.executionPolicy, toolRules } };
  const amount = { tokens: 100, activeMs: 60_000, attempts: 1, sessions: 1 };
  const envelope = {
    protocol,
    claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: resolution.configHash, agent: resolution.selection, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: "c".repeat(64), inputCheckpoint: null,
    work: { kind: "loop", contract, targetRepo: runtime.repo, base: "main", sourceDir: runtime.dir },
  } as unknown as LoopStartEnvelope;
  const controlDir = join(runtime.dir, "control");
  await ensurePrivateDirectory(runtime.dir, controlDir);
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(config)));
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(runtime.dir, { protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
  await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  return { sourceDir: runtime.dir, envelope };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

describe("run/tool-rules.json and collect (T6)", { timeout: 60_000 }, () => {
  const rules: ToolRulesV1 = { commands: [], network: false, secretEnv: ["CCLOOP_TR_SECRET_SET", "CCLOOP_TR_SECRET_UNSET"] };

  it("is written once per run, mode 0600, with commands-closed for commands: [] and the secrets' presence -- never their values", async () => {
    vi.stubEnv("CCLOOP_TR_SECRET_SET", SECRET_VALUE);
    vi.stubEnv("CCLOOP_TR_SECRET_UNSET", "");
    const { sourceDir } = await workerRun(rules);
    const path = join(sourceDir, "run", "tool-rules.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const report = JSON.parse(await readFile(path, "utf8")) as { schema: string; agentKind: string; baseline: string; rules: Array<Record<string, unknown>> };
    expect(report.schema).toBe("ccloop-tool-rules-report-v1");
    expect(report.agentKind).toBe("omp");
    expect(report.rules.map((row) => row.rule)).toEqual([{ kind: "commands-closed" }, { kind: "network", value: false }, { kind: "secretEnv", name: "CCLOOP_TR_SECRET_SET" }, { kind: "secretEnv", name: "CCLOOP_TR_SECRET_UNSET" }]);
    expect(report.rules[0]).toMatchObject({ status: "detected", phases: ["execute"] });
    expect(report.rules.slice(2).map((row) => [row.status, row.present])).toEqual([["recorded-only", true], ["recorded-only", false]]);
    expect(report.rules.slice(0, 2).every((row) => !("present" in row))).toBe(true);
    // Positive observation first: the scan reads the files ccloop wrote (the report among them), then finds no value bytes.
    const files = await filesUnder(sourceDir);
    expect(files).toContain(path);
    const hits: string[] = [];
    for (const file of files) if ((await readFile(file)).includes(Buffer.from(SECRET_VALUE))) hits.push(file);
    expect(hits).toEqual([]);
  });

  for (const protocol of [3, 4] as const) {
    it(`protocol ${protocol}: collect answers the report at the top level, not inside the terminal, through the command's strict schema`, async () => {
      const { sourceDir, envelope } = await workerRun(rules, protocol);
      const report = JSON.parse(await readFile(join(sourceDir, "run", "tool-rules.json"), "utf8")) as unknown;
      const direct = await collectExecution(envelope, 0) as unknown as Record<string, unknown>;
      expect(direct.toolRules).toEqual(report);
      expect(direct.terminal).not.toBeNull();
      expect(Object.keys(direct.terminal as object)).not.toContain("toolRules");
      const collected = await runControlCommand(["collect", "--agents", join(sourceDir, "agents.json")], JSON.stringify({ input: envelope, afterSeq: 0 }));
      expect(collected.code, collected.stderr).toBe(0);
      expect((JSON.parse(collected.stdout) as { toolRules?: unknown }).toolRules).toEqual(report);
    });
  }

  it("a contract without toolRules: no report file and no toolRules key in collect (T1, collect part)", async () => {
    const { sourceDir, envelope } = await workerRun(undefined);
    await expect(stat(join(sourceDir, "run", "tool-rules.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const direct = await collectExecution(envelope, 0) as unknown as Record<string, unknown>;
    expect(direct.terminal).not.toBeNull();
    expect(Object.keys(direct)).toEqual(["events", "candidate", "terminal", "progress", "transcripts"]);
  });
});

describe("buildToolRulesReport (spec §5)", () => {
  const installation = { kind: "claude", command: ["claude", "--permission-mode", "acceptEdits"], version: "x", configDir: null, timeoutMs: 1, killGraceMs: 1 } as never;
  it("rows in order: commands-closed, commands as given, network, secretEnv as given; present only on secretEnv", () => {
    const report = buildToolRulesReport({ rules: { commands: [{ kind: "exact", value: "b" }, { kind: "exact", value: "a" }], network: true, secretEnv: ["Z", "A"] }, kind: "claude", installation, codexNetwork: null, env: { Z: "1" } });
    expect(report.rules.map((row) => row.rule)).toEqual([{ kind: "commands-closed" }, { kind: "exact", value: "b" }, { kind: "exact", value: "a" }, { kind: "network", value: true }, { kind: "secretEnv", name: "Z" }, { kind: "secretEnv", name: "A" }]);
    expect(report.rules.map((row) => row.present)).toEqual([undefined, undefined, undefined, undefined, true, false]);
    expect(Buffer.byteLength(report.baseline)).toBeLessThanOrEqual(1024);
  });
});

describe("the verify-saved-result path (spec §6 Saved-result recovery)", { timeout: 60_000 }, () => {
  // A recovery runs verify only, so its report names a mechanism only where verify gets one. The legacy recovery fixture's
  // archived source contract has no toolRules, so ccloop's own identity check refuses this recovery inside runLoop
  // (saved-result-source-stale) -- after the worker wrote the report, which is what this criterion observes.
  it("writes run/tool-rules.json before verify, phases restricted to verify, and collect returns it", async () => {
    const f = await savedRecoveryFixture();
    try {
      const marker = join(f.root, "omp-marker");
      const table = parseAgentsTable({ schema: "ccloop-agents-table-v1", installations: { omp: (await ompInstallation({ dir: f.root, marker } as World) as { installation: never }).installation } });
      const { config, resolution } = await resolveAgent(table, { agent: "omp" });
      const rules: ToolRulesV1 = { commands: [{ kind: "exact", value: "npm test" }], network: false, secretEnv: [] };
      const input = structuredClone(f.input);
      input.claim.configHash = resolution.configHash; input.claim.agent = resolution.selection;
      input.work.contract = { ...input.work.contract, executionPolicy: { ...input.work.contract.executionPolicy, toolRules: rules } };
      const controlDir = join(f.sourceDir, "control");
      await ensurePrivateDirectory(f.sourceDir, controlDir);
      await atomicReplacePrivateFile(f.sourceDir, join(controlDir, "config.json"), Buffer.from(canonicalJson(config)));
      await atomicReplacePrivateFile(f.sourceDir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(input)));
      await rm(join(controlDir, "accepted.json"), { force: true });
      await writeAccepted(f.sourceDir, { protocol: 1, envelopeHash: canonicalHash(input), executionId: "execution-r", configHash: input.claim.configHash,
        generation: input.claim.generation, acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
      await runControlWorker(["--source-dir", f.sourceDir, "--execution-id", "execution-r", "--nonce", "nonce-r"]).catch(() => undefined);
      const report = JSON.parse(await readFile(join(f.sourceDir, "run", "tool-rules.json"), "utf8")) as { agentKind: string; rules: Array<{ rule: unknown; status: string; phases: string[] }> };
      expect(report.agentKind).toBe("omp");
      expect(report.rules.map((row) => [row.rule, row.status, row.phases])).toEqual([
        [{ kind: "commands-closed" }, "detected", []],
        [{ kind: "exact", value: "npm test" }, "recorded-only", []],
        [{ kind: "network", value: false }, "recorded-only", []],
      ]);
      expect(report.rules.every((row) => row.phases.every((phase) => phase === "verify"))).toBe(true);
      expect(((await collectExecution(input, 0)) as unknown as { toolRules?: unknown }).toolRules).toEqual(report);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  // Review round 1 (Orca session b37f7ce9, M1): a recovery passes no grant at all (it runs verify only), so a grant row --
  // a command rule or network:true -- is recorded-only with that reason, never `enforced` with no phase. Restrictions keep
  // their verify mechanism. (This replaces this branch's own earlier test, which locked `enforced` with phases [].)
  it("buildToolRulesReport for a recovery: restrictions keep verify; a grant (command rule, network:true) is recorded-only, not passed", () => {
    const installation = { kind: "claude", command: ["claude", "--disable-slash-commands", "--permission-mode", "acceptEdits"], version: "x", configDir: null, timeoutMs: 1, killGraceMs: 1 } as never;
    const report = buildToolRulesReport({ rules: { commands: [{ kind: "exact", value: "npm test" }], network: false, secretEnv: [] }, kind: "claude", installation, codexNetwork: null, env: {}, savedResult: true });
    expect(report.rules.map((row) => [row.rule.kind, row.status, row.phases, row.reason])).toEqual([
      ["commands-closed", "enforced", ["verify"], null], ["exact", "recorded-only", [], "not passed: a recovery runs verify only"], ["network", "recorded-only", ["verify"], expect.any(String)],
    ]);
    const open = buildToolRulesReport({ rules: { commands: [], network: true, secretEnv: [] }, kind: "claude", installation, codexNetwork: null, env: {}, savedResult: true });
    expect(open.rules[1]).toEqual({ rule: { kind: "network", value: true }, status: "recorded-only", reason: "not passed: a recovery runs verify only", phases: [] });
    const codex = { kind: "codex", command: ["codex"], version: "x", configDir: null, timeoutMs: 1, killGraceMs: 1, sandbox: "workspace-write", budgetMode: "soft" } as never;
    const codexReport = buildToolRulesReport({ rules: { commands: [], network: true, secretEnv: [] }, kind: "codex", installation: codex, codexNetwork: { kind: "absent" }, env: {}, savedResult: true });
    expect(codexReport.rules[1]).toEqual({ rule: { kind: "network", value: true }, status: "recorded-only", reason: "not passed: a recovery runs verify only", phases: [] });
    // Positive control: outside a recovery the same grants are enforced on execute.
    expect(buildToolRulesReport({ rules: { commands: [], network: true, secretEnv: [] }, kind: "codex", installation: codex, codexNetwork: { kind: "absent" }, env: {} }).rules[1])
      .toMatchObject({ status: "enforced", phases: ["execute"] });
  });
});

// Review round 1 (Orca session b37f7ce9, I1): with an envelope skillPluginDir the claude adapter drops
// --disable-slash-commands and adds --plugin-dir, and a plugin's skills can declare allowed-tools (settings, hooks too).
// The report must describe that argv, not the installation's command, or it says `enforced` for a set that is open.
describe("the claude report reads the argv the adapter runs (review round 1, I1)", { timeout: 60_000 }, () => {
  const installation = { kind: "claude", command: ["claude", "--disable-slash-commands", "--permission-mode", "acceptEdits"], version: "x", configDir: null, timeoutMs: 1, killGraceMs: 1 } as never;
  const rules: ToolRulesV1 = { commands: [], network: true, secretEnv: [] };
  it("buildToolRulesReport: skillPluginDir ⇒ commands-closed recorded-only naming the plugin; without it enforced", () => {
    const report = buildToolRulesReport({ rules, kind: "claude", installation, codexNetwork: null, env: {}, skillPluginDir: "/plugins/p" });
    expect(report.rules[0]).toEqual({ rule: { kind: "commands-closed" }, status: "recorded-only", reason: expect.stringContaining("--plugin-dir"), phases: [] });
    expect(report.baseline).toContain("skills and plugins");
    expect(buildToolRulesReport({ rules, kind: "claude", installation, codexNetwork: null, env: {} }).rules[0]!.status).toBe("enforced");
  });

  async function claudeWorker(withPlugin: boolean): Promise<{ report: { rules: Array<{ rule: unknown; status: string; reason: string | null }> }; argvs: string[][] }> {
    const runtime = await codexFixture("script");
    worlds.push({ dir: runtime.dir } as World);
    const scriptPath = join(runtime.dir, "script.json");
    await writeFile(scriptPath, JSON.stringify({ "codex-test": { files: { "answer.txt": "42\n" } } }));
    await mkdir(join(runtime.dir, "input"));
    const skillPluginDir = join(runtime.dir, "skill-plugin");
    await mkdir(skillPluginDir);
    const claude = await claudeInstallation([process.execPath, FAKE_CLAUDE_CLI, "script", runtime.marker, scriptPath], { timeoutMs: 60_000, killGraceMs: 300 });
    const bare = await sealClaude(claude);
    // As skillPluginDirWorker.test.ts: the flags go on the config the worker reads; the claim keeps the bare config's hash.
    const sealed = { ...bare, config: { ...bare.config, installation: { ...bare.config.installation, command: [...claude.command, "--permission-mode", "acceptEdits", "--disable-slash-commands"] } } as typeof bare.config };
    const amount = { tokens: 100, activeMs: 60_000, attempts: 1, sessions: 1 };
    const contract = { ...runtime.contract, executionPolicy: { ...runtime.contract.executionPolicy, toolRules: rules } };
    const envelope = {
      protocol: 3,
      claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
      contractHash: "c".repeat(64), inputCheckpoint: null,
      work: { kind: "loop", contract, targetRepo: runtime.repo, base: "main", sourceDir: runtime.dir, ...(withPlugin ? { skillPluginDir } : {}) },
    } as unknown as LoopStartEnvelope;
    const controlDir = join(runtime.dir, "control");
    await ensurePrivateDirectory(runtime.dir, controlDir);
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
    await writeAccepted(runtime.dir, { protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
      generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
    await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
    const argvs = (await readFile(`${runtime.marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    return { report: JSON.parse(await readFile(join(runtime.dir, "run", "tool-rules.json"), "utf8")) as never, argvs };
  }

  it("worker: with skillPluginDir the written report says recorded-only (the calls ran with --plugin-dir); without it enforced", async () => {
    const plugin = await claudeWorker(true);
    expect(plugin.argvs.length).toBeGreaterThan(0);
    for (const argv of plugin.argvs) expect(argv).toContain("--plugin-dir");
    expect(plugin.report.rules[0]).toMatchObject({ rule: { kind: "commands-closed" }, status: "recorded-only", reason: expect.stringContaining("--plugin-dir") });
    const bare = await claudeWorker(false);
    for (const argv of bare.argvs) expect(argv).toContain("--disable-slash-commands");
    expect(bare.report.rules[0]).toMatchObject({ rule: { kind: "commands-closed" }, status: "enforced" });
  });
});
