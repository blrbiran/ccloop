import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { resolveAgent } from "../../src/agents/materialize.js";
import { acceptStart } from "../../src/control/accept.js";
import { collectExecution } from "../../src/control/collect.js";
import { runControlCommand } from "../../src/control/command.js";
import { requestHandoff } from "../../src/control/handoff.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson } from "../../src/control/protocol.js";
import { proveStopped, type StopProofRecord } from "../../src/control/stopProof.js";
import { readAcceptedOptional, writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import {
  FAKE_CLAUDE_CLI,
  FAKE_CODEX,
  claudeInstallation,
  codexInstallation,
  controlContract,
  sealCodex,
  startEnvelope,
  writeAgentsTable,
} from "./agentsFixture.js";

// Agent selection (2026-09-26), spec §4.2, §4.5, §4.6, §9 criteria 5c, 5d and 6: control runs over an installation
// table. Additive criteria; the rewritten v1 criteria live in their own files.
const workerCommand = [resolve("node_modules/.bin/tsx"), resolve("tests/fixtures/control-worker.mjs")];
const execFileAsync = promisify(execFile);

async function sourceRoot(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await mkdir(join(dir, "input"));
  return dir;
}

async function launches(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function twoAgentTable(dir: string) {
  const script = join(dir, "script.json");
  await writeFile(script, "{}\n", { mode: 0o600 });
  return await writeAgentsTable({
    claude: await claudeInstallation([process.execPath, FAKE_CLAUDE_CLI, "script", join(dir, "claude-marker"), script]),
    codex: await codexInstallation({
      command: [process.execPath, FAKE_CODEX, "integration", join(dir, "codex-marker")],
      sandbox: "workspace-write",
      budgetMode: "soft",
      timeoutMs: 1_000,
      killGraceMs: 100,
    }),
  }, dir);
}

async function acceptFixture() {
  const dir = await sourceRoot("ccloop-agents-accept-");
  const { path, table } = await twoAgentTable(dir);
  const { config, resolution } = await resolveAgent(table, { agent: "codex", model: "fixture" });
  const envelope = startEnvelope({
    sourceDir: dir,
    targetRepo: dir,
    contract: controlContract(dir),
    agent: resolution.selection,
    configHash: resolution.configHash,
  });
  return { dir, path, table, config, envelope, launchFile: join(dir, "agent-launches") };
}

function binding(path: string, launchFile: string) {
  return { agentsTablePath: path, workerCommand, workerEnv: { CCLOOP_CONTROL_LAUNCH_FILE: launchFile }, receiptTimeoutMs: 2_000 };
}

/** A named rejection (D-W3-2): exit 2, nothing on stdout, stderr one line whose first token is the code. */
function expectNamed(result: { code: number; stdout: string; stderr: string }, code: string): void {
  expect(result.code, result.stderr).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(new RegExp(`^${code}(: [^\\n]*)?\\n$`));
}

describe("control over the installation table (agent selection)", { timeout: 30_000 }, () => {
  it("answers capabilities for a selection with descriptor defaults filled, given fields echoed, and the materialized config's hash", async () => {
    const dir = await sourceRoot("ccloop-agents-capabilities-");
    const { path, table } = await twoAgentTable(dir);

    const claude = await runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: { agent: "claude", model: "opus" } }));
    expect(claude.code, claude.stderr).toBe(0);
    const claudeAnswer = JSON.parse(claude.stdout);
    const claudeSelection = { agent: "claude", model: "opus", contextWindow: "agent-default" };
    expect(claudeAnswer.selection).toEqual(claudeSelection);
    expect(claudeAnswer).toMatchObject({
      protocol: 3,
      configHash: canonicalHash({ schema: "ccloop-agent-config-v1", kind: "claude", installation: table.installations.claude, selection: claudeSelection }),
      timeoutMs: table.installations.claude!.timeoutMs,
      killGraceMs: table.installations.claude!.killGraceMs,
      capabilities: { contextWindowTokens: null },
    });

    const codex = await runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: { agent: "codex" } }));
    expect(codex.code, codex.stderr).toBe(0);
    const codexAnswer = JSON.parse(codex.stdout);
    const codexSelection = { agent: "codex", model: "gpt-6-sol", contextWindow: "agent-default" };
    expect(codexAnswer.selection).toEqual(codexSelection);
    expect(codexAnswer).toMatchObject({
      protocol: 3,
      configHash: canonicalHash({ schema: "ccloop-agent-config-v1", kind: "codex", installation: table.installations.codex, selection: codexSelection }),
      timeoutMs: 1_000,
      killGraceMs: 100,
    });
  });

  it("names a missing installation, a drifted CLI version, and an unsafe table with exit 2 and the code first", async () => {
    const dir = await sourceRoot("ccloop-agents-errors-");
    const { path, table } = await twoAgentTable(dir);
    expectNamed(await runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: { agent: "missing" } })), "agent-installation-missing");

    expect(table.installations.claude!.version).not.toBe("0.0.0-stale");
    const drifted = await writeAgentsTable({ claude: { ...table.installations.claude!, version: "0.0.0-stale" } });
    expectNamed(await runControlCommand(["capabilities", "--agents", drifted.path], JSON.stringify({ agent: { agent: "claude" } })), "agent-version-drift");

    await chmod(path, 0o660);
    expectNamed(await runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: null })), "agents-table-invalid");
  });

  it("refuses the retired --adapter forms for every control method", async () => {
    const dir = await sourceRoot("ccloop-agents-retired-");
    const { path } = await twoAgentTable(dir);
    for (const method of ["capabilities", "accept", "inspect", "handoff", "collect", "read-evidence"]) {
      for (const argv of [[method, "--adapter", "codex", "--adapter-config", path], [method, "--adapter-config", path]]) {
        expect(await runControlCommand(argv, JSON.stringify({ agent: null }))).toEqual({
          code: 1, stdout: "", stderr: "control-command-invalid\n",
        });
      }
    }
  });

  it("reads the table only for capabilities and accept: a table broken after accept blocks neither inspect nor collect", async () => {
    const f = await acceptFixture();
    expect((await acceptStart(f.envelope, binding(f.path, f.launchFile))).kind).toBe("accepted");
    await expect.poll(() => launches(f.launchFile)).toEqual(["launch"]);
    await writeFile(f.path, "not json\n");
    expectNamed(await runControlCommand(["capabilities", "--agents", f.path], JSON.stringify({ agent: null })), "agents-table-invalid");
    const inspected = await runControlCommand(["inspect", "--agents", f.path], JSON.stringify(f.envelope));
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({ kind: "accepted" });
    const collected = await runControlCommand(["collect", "--agents", f.path], JSON.stringify({ input: f.envelope, afterSeq: 0 }));
    expect(collected.code, collected.stderr).toBe(0);
    expect(JSON.parse(collected.stdout)).toEqual({ events: [], candidate: null, terminal: null });
  });
});

describe("accept under the installation table (agent selection)", { timeout: 30_000 }, () => {
  it("seals the materialized agent config whose canonical hash the claim carries", async () => {
    const f = await acceptFixture();
    await acceptStart(f.envelope, binding(f.path, f.launchFile));
    const sealed = await readFile(join(f.dir, "control", "config.json"), "utf8");
    expect(sealed).toBe(`${canonicalJson(f.config)}\n`);
    expect(JSON.parse(sealed)).toEqual({
      schema: "ccloop-agent-config-v1",
      kind: "codex",
      installation: f.table.installations.codex,
      selection: f.envelope.claim.agent,
    });
    expect(canonicalHash(JSON.parse(sealed))).toBe(f.envelope.claim.configHash);
  });

  it("refuses a claim whose selection changed after its configHash was taken, before any worker", async () => {
    const f = await acceptFixture();
    const changed = { ...f.envelope, claim: { ...f.envelope.claim, agent: { ...f.envelope.claim.agent, model: "fixture-2" } } };
    await expect(acceptStart(changed, binding(f.path, f.launchFile))).rejects.toMatchObject({ code: "control-config-hash-mismatch" });
    expect(await readAcceptedOptional(f.dir)).toBeNull();
    expect(await launches(f.launchFile)).toEqual([]);
  });

  it("refuses a CLI whose --version drifted from the table, before anything is persisted", async () => {
    const f = await acceptFixture();
    expect(f.table.installations.codex!.version).not.toBe("0.0.0-stale");
    const drifted = await writeAgentsTable({ ...f.table.installations, codex: { ...f.table.installations.codex!, version: "0.0.0-stale" } });
    await expect(acceptStart(f.envelope, binding(drifted.path, f.launchFile))).rejects.toMatchObject({ code: "agent-version-drift" });
    expect(await readAcceptedOptional(f.dir)).toBeNull();
    expect(await launches(f.launchFile)).toEqual([]);
  });
});

describe("worker adapter from the sealed config (agent selection)", { timeout: 30_000 }, () => {
  it("refuses a sealed config whose schema or kind does not hold, before any phase", async () => {
    for (const corrupt of [
      (config: Record<string, unknown>) => ({ ...config, schema: "ccloop-agent-config-v0" }),
      (config: Record<string, unknown>) => ({ ...config, kind: "claude" }),
    ]) {
      const dir = await sourceRoot("ccloop-agents-worker-");
      const sealed = await sealCodex({
        command: [process.execPath, FAKE_CODEX, "integration", join(dir, "codex-marker")],
        model: "fixture",
        budgetMode: "soft",
        sandbox: "workspace-write",
        timeoutMs: 1_000,
        killGraceMs: 100,
      });
      const envelope = startEnvelope({ sourceDir: dir, targetRepo: dir, contract: controlContract(dir), agent: sealed.selection, configHash: sealed.configHash });
      const controlDir = join(dir, "control");
      await ensurePrivateDirectory(dir, controlDir);
      await atomicReplacePrivateFile(dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(corrupt(sealed.config as unknown as Record<string, unknown>))));
      await atomicReplacePrivateFile(dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
      await writeAccepted(dir, {
        protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: sealed.configHash,
        generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
      });
      await expect(runControlWorker(["--source-dir", dir, "--execution-id", "execution-1", "--nonce", "nonce-1"])).rejects.toMatchObject({ code: "agent-config-invalid" });
      expect(JSON.parse(await readFile(join(controlDir, "worker-error.json"), "utf8")).message).toMatch(/^agent-config-invalid(: |$)/);
      await expect(readFile(join(dir, "codex-marker"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

// Controller ruling (2026-09-26, from W2): the ClaudeAgentAdapter's own registration criterion does not reach the
// worker, so prove it here: a control worker running a claude installation registers the phase's process group, and
// that registration decides the stop proof. A live worker's proof is already null for other reasons (unsealed worker,
// affirmed lease), so the registrations are judged in a probe directory where everything else would allow a proof.
describe("claude process registration through the control worker (agent selection)", { timeout: 60_000 }, () => {
  it("registers the claude phase's process group in processes.json, and that record proves nothing while the group lives", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-agents-claude-worker-")));
    const repo = join(dir, "target"), sourceDir = join(dir, "source"), marker = join(dir, "claude-marker"), script = join(dir, "script.json");
    await mkdir(repo);
    await mkdir(join(sourceDir, "input"), { recursive: true });
    for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await execFileAsync("git", args, { cwd: repo });
    await writeFile(join(repo, "answer.txt"), "0\n");
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repo });
    await writeFile(script, JSON.stringify({ "task-1": { files: { "answer.txt": "42\n" }, delayMs: { plan: 30_000 } } }), { mode: 0o600 });
    const { table } = await writeAgentsTable({
      claude: await claudeInstallation([process.execPath, FAKE_CLAUDE_CLI, "script", marker, script], { timeoutMs: 60_000, killGraceMs: 50 }),
    }, dir);
    const { config, resolution } = await resolveAgent(table, { agent: "claude" });
    const contract: LoopContract = {
      objective: { taskId: "task-1", goal: "Set answer.txt to 42", successCondition: "answer is 42", nonGoals: [] },
      context: { repoPath: repo, targetPaths: ["answer.txt"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
      executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 60_000, totalRuntimeBudgetMs: 120_000, tokenBudget: 1_000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
      safetyPolicy: { allowlistPaths: ["answer.txt"], denylistPaths: [], maxFilesTouched: 2, humanGateConditions: [] },
      verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["failure"], evidenceRequired: [] },
      escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
    };
    const envelope = startEnvelope({ sourceDir, targetRepo: repo, contract, agent: resolution.selection, configHash: resolution.configHash });
    const controlDir = join(sourceDir, "control");
    await ensurePrivateDirectory(sourceDir, controlDir);
    await atomicReplacePrivateFile(sourceDir, join(controlDir, "config.json"), Buffer.from(canonicalJson(config)));
    await atomicReplacePrivateFile(sourceDir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
    await writeAccepted(sourceDir, {
      protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: resolution.configHash,
      generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
    });

    const worker = runControlWorker(["--source-dir", sourceDir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
    let registered: Array<{ pid: number; pgid: number }> = [];
    await expect.poll(async () => {
      try { registered = JSON.parse(await readFile(join(controlDir, "processes.json"), "utf8")); } catch { registered = []; }
      return registered.length;
    }, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(registered[0]).toMatchObject({ phase: "plan" });
    expect(() => process.kill(-registered[0]!.pgid, 0)).not.toThrow();

    const probe = await realpath(await mkdtemp(join(tmpdir(), "ccloop-agents-claude-probe-")));
    await mkdir(join(probe, "control"));
    await mkdir(join(probe, "run"));
    await writeFile(join(probe, "run", "owner-record.json"), JSON.stringify({
      runId: "task-1", logicalSessionId: "session-1", currentOwnerEpoch: 1, currentProcessInstanceId: "process-1",
      lastAffirmedAt: new Date().toISOString(), ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: null,
    }));
    await writeFile(join(probe, "control", "processes.json"), JSON.stringify(registered));
    const record: StopProofRecord = {
      sourceDir: probe,
      accepted: {
        protocol: 1, envelopeHash: "a".repeat(64), executionId: "execution-1", configHash: "b".repeat(64), generation: 1,
        acceptedAt: new Date().toISOString(), launch: "sealed", worker: { pid: process.pid, startedAt: new Date().toISOString(), nonce: "nonce-1" },
      },
    };
    expect(await proveStopped(record, { graceMs: 20 })).toBeNull();

    expect(await requestHandoff(envelope, {
      protocol: 1, requestId: "request-1", runId: "run-1", generation: 1, reason: "shutdown", deadlineAt: new Date(Date.now() + 150).toISOString(),
    })).toEqual({ kind: "latched", requestId: "request-1" });
    await worker;
    expect(await proveStopped(record, { graceMs: 20 })).toMatchObject({ executionId: "execution-1", isolated: true });
    expect((await collectExecution(envelope, 0)).candidate?.stopProof).toMatchObject({ isolated: true });
  });
});
