// Per-contract tool rules: the report (ccloop spec 2026-10-22 §5, §8 T6; plan Task 5). Orca shows each declared rule's
// status as ccloop reports it and flags `detected`, `recorded-only` network and `refused` red, so the report must exist for
// every run whose contract has rules -- `commands-closed` included even with `commands: []`, because that row is what says
// whether the agent can run something else -- and must reach Orca through collect at the top level (the protocol-4
// terminal is a strict RunState). A secret is declared by name only: its value must never be written anywhere ccloop writes.
import { readdir, readFile, stat, mkdir } from "node:fs/promises";
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
    expect(Object.keys(direct)).toEqual(["events", "candidate", "terminal", "progress"]);
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
