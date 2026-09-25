import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { collectExecution } from "../../src/control/collect.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type StartEnvelopeV2 } from "../../src/control/protocol.js";
import { parseCodexConfig } from "../../src/runtime/codex/protocol.js";
import { sealCodex } from "./agentsFixture.js";
import { proveStopped, recordCompletedPhase, type StopProofRecord } from "../../src/control/stopProof.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { runLoop, type RunControlHooks } from "../../src/controller/runLoop.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { codexFixture } from "../runtime/codex/fixture.js";

const execFileAsync = promisify(execFile);
type Observation = Parameters<NonNullable<RunControlHooks["onPhaseSettled"]>>[0];

async function loopFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-phases-completed-")));
  const repo = join(root, "repo");
  await mkdir(repo);
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) await execFileAsync("git", args, { cwd: repo });
  await writeFile(join(repo, "value.txt"), "0\n");
  await execFileAsync("git", ["add", "value.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repo });
  const contract: LoopContract = {
    objective: { taskId: "phases-completed", goal: "observe phases", successCondition: "done", nonGoals: [] },
    context: { repoPath: repo, targetPaths: ["value.txt"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 100, totalRuntimeBudgetMs: 2_000, tokenBudget: 1_000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
    safetyPolicy: { allowlistPaths: ["value.txt"], denylistPaths: [], maxFilesTouched: 2, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["failure"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
  return { root, runDir: join(root, "run"), contract };
}

// An adapter that answers every phase without ever starting a process or calling onProcessRegistered.
const silent: RuntimeAdapter = {
  plan: async () => ({ summary: "plan", primaryTargetPaths: ["value.txt"], tokenUsage: 1 }),
  execute: async () => ({ changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "", tokenUsage: 1 }),
  verify: async () => ({ approved: true, rejectCategory: "", primaryTargetPaths: ["value.txt"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [], tokenUsage: 1 }),
};

async function stoppedSource(): Promise<{ sourceDir: string; record: StopProofRecord }> {
  const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-phases-proof-")));
  await mkdir(join(sourceDir, "control"));
  await mkdir(join(sourceDir, "run"));
  await writeFile(join(sourceDir, "run", "owner-record.json"), JSON.stringify({
    runId: "task-1", logicalSessionId: "session-1", currentOwnerEpoch: 1, currentProcessInstanceId: "process-1",
    lastAffirmedAt: new Date().toISOString(), ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: null,
  }));
  await writeFile(join(sourceDir, "control", "processes.json"), "[]\n");
  return {
    sourceDir,
    record: {
      sourceDir,
      accepted: {
        protocol: 1, envelopeHash: "a".repeat(64), executionId: "execution-1", configHash: "b".repeat(64), generation: 1,
        acceptedAt: new Date().toISOString(), launch: "sealed", worker: { pid: process.pid, startedAt: new Date().toISOString(), nonce: "nonce-1" },
      },
    },
  };
}

describe("phase settlement reports whether the phase completed with a result", () => {
  it("is true for each phase that returned its result", async () => {
    const f = await loopFixture();
    const observed: Observation[] = [];
    await runLoop(f.contract, f.runDir, silent, { onPhaseSettled: async (value) => { observed.push(value); } });
    expect(observed.map(({ phase, completedWithResult }) => ({ phase, completedWithResult }))).toEqual([
      { phase: "plan", completedWithResult: true },
      { phase: "execute", completedWithResult: true },
      { phase: "verify", completedWithResult: true },
    ]);
  });

  it("is false for a phase that timed out without a result", async () => {
    const f = await loopFixture();
    f.contract.executionPolicy.perAttemptTimeoutMs = 20;
    const observed: Observation[] = [];
    await runLoop(f.contract, f.runDir, {
      ...silent,
      plan: async ({ abortSignal }) => {
        await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
        return undefined as never;
      },
    }, { onPhaseSettled: async (value) => { observed.push(value); } });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ phase: "plan", completedWithResult: false });
  });

  // Usage observed before an abort (Orca handoff delivery C-3) is settled like a result but is not one.
  it("is false for a phase that threw, even when it carried observed usage", async () => {
    for (const error of [new Error("plain"), Object.assign(new Error("aborted with usage"), { observedTokens: 7 })]) {
      const f = await loopFixture();
      const observed: Observation[] = [];
      await runLoop(f.contract, f.runDir, { ...silent, plan: async () => { throw error; } }, { onPhaseSettled: async (value) => { observed.push(value); } });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ phase: "plan", completedWithResult: false, tokenUsage: "observedTokens" in error ? 7 : null });
    }
  });
});

describe("stop proof against zero registrations (spec §4.7b, §9 criterion 5b)", () => {
  it("still proves isolation when nothing registered and no phase completed", async () => {
    const f = await stoppedSource();
    expect(await proveStopped(f.record, { graceMs: 0 })).toMatchObject({ executionId: "execution-1", isolated: true });
  });

  it("gives no proof when an adapter completed a phase without registering its process", async () => {
    const f = await stoppedSource();
    const loop = await loopFixture();
    // Mirrors src/control/worker.ts's onPhaseSettled: a phase that completed with a result is counted.
    await runLoop(loop.contract, loop.runDir, silent, {
      onPhaseSettled: async (observation) => {
        if (observation.completedWithResult) await recordCompletedPhase(f.sourceDir);
      },
    });
    expect(JSON.parse(await readFile(join(f.sourceDir, "control", "phases-completed.json"), "utf8"))).toEqual({ count: 3 });
    expect(await proveStopped(f.record, { graceMs: 0 })).toBeNull();
  });

  it("proves isolation for completed phases whose registered groups are quiet", async () => {
    const f = await stoppedSource();
    await writeFile(join(f.sourceDir, "control", "processes.json"), JSON.stringify([{ pid: 123, pgid: 123, startedAt: "start", phase: "plan", registeredAt: new Date().toISOString() }]));
    await recordCompletedPhase(f.sourceDir);
    expect(await proveStopped(f.record, { graceMs: 0, probeGroup: async () => "quiet" })).toMatchObject({ isolated: true });
  });

  it("counts privately and fails closed on a count it cannot read", async () => {
    const f = await stoppedSource();
    await recordCompletedPhase(f.sourceDir);
    await recordCompletedPhase(f.sourceDir);
    const path = join(f.sourceDir, "control", "phases-completed.json");
    expect(await readFile(path, "utf8")).toBe('{"count":2}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, '{"count":-1}\n');
    await expect(recordCompletedPhase(f.sourceDir)).rejects.toThrow("control-phases-completed-invalid");
    await writeFile(join(f.sourceDir, "control", "processes.json"), JSON.stringify([{ pid: 123, pgid: 123, startedAt: "start", phase: "plan", registeredAt: new Date().toISOString() }]));
    expect(await proveStopped(f.record, { graceMs: 0, probeGroup: async () => "quiet" })).toBeNull();
  });
});

describe("the control worker counts completed phases", () => {
  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"; controller ruling W1-19): the
  // worker reads the sealed materialized agent config for the same integration-mode fake codex and a protocol-2
  // envelope carrying its hash and selection; it still counts exactly the three phases completed with a result, the
  // codex adapter still registers three groups, and the run still proves isolation.
  it("writes one count per phase a registering adapter completed, and the run still proves isolation", async () => {
    const runtime = await codexFixture("integration");
    await mkdir(join(runtime.dir, "input"));
    const sealed = await sealCodex(parseCodexConfig(runtime.config));
    const amount = { tokens: 100, activeMs: 10_000, attempts: 1, sessions: 1 };
    const envelope: StartEnvelopeV2 = {
      protocol: 2,
      claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
      contractHash: "c".repeat(64),
      inputCheckpoint: null,
      work: { contract: runtime.contract, targetRepo: runtime.repo, base: "main", sourceDir: runtime.dir },
    };
    const controlDir = join(runtime.dir, "control");
    await ensurePrivateDirectory(runtime.dir, controlDir);
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
    await writeAccepted(runtime.dir, {
      protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
      generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
    });

    await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);

    expect(JSON.parse(await readFile(join(controlDir, "phases-completed.json"), "utf8"))).toEqual({ count: 3 });
    expect(JSON.parse(await readFile(join(controlDir, "processes.json"), "utf8"))).toHaveLength(3);
    expect((await collectExecution(envelope, 0)).candidate?.stopProof).toMatchObject({ isolated: true });
  });
});
