import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { runLoop, type RunControlHooks } from "../../src/controller/runLoop.js";
import { runCodexPhase } from "../../src/runtime/codex/runCodexPhase.js";
import { parseCodexConfig } from "../../src/runtime/codex/protocol.js";
import type { AttemptContext, RuntimeAdapter, UsageEvidence } from "../../src/runtime/types.js";
import { codexFixture } from "../runtime/codex/fixture.js";

const execFileAsync = promisify(execFile);

async function runFixture() {
  const root = await mkdtemp(join(tmpdir(), "ccloop-control-hooks-"));
  const repo = join(root, "repo");
  const runDir = join(root, "run");
  await mkdir(repo);
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "value.txt"), "0\n");
  await execFileAsync("git", ["add", "value.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repo });
  const contract: LoopContract = {
    objective: { taskId: "hook-test", goal: "observe phases", successCondition: "done", nonGoals: [] },
    context: { repoPath: repo, targetPaths: ["value.txt"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 100, totalRuntimeBudgetMs: 2_000, tokenBudget: 1_000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
    safetyPolicy: { allowlistPaths: ["value.txt"], denylistPaths: [], maxFilesTouched: 2, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["failure"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
  return { root, repo, runDir, contract };
}

const usageEvidence: UsageEvidence = {
  usageStatus: "present",
  fields: {
    input_tokens: { status: "finite", value: 1 },
    inputTokens: { status: "absent" },
    output_tokens: { status: "finite", value: 1 },
    outputTokens: { status: "absent" },
  },
  selectedInputField: "input_tokens",
  selectedOutputField: "output_tokens",
  normalizedTotal: 2,
};

function adapter(tokens: Array<number | undefined>): RuntimeAdapter {
  return {
    plan: async () => ({ summary: "plan", primaryTargetPaths: ["value.txt"], tokenUsage: tokens[0], usageEvidence }),
    execute: async () => ({ changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "", tokenUsage: tokens[1], usageEvidence }),
    verify: async () => ({ approved: true, rejectCategory: "", primaryTargetPaths: ["value.txt"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [], tokenUsage: tokens[2], usageEvidence }),
  };
}

describe("run control hooks", () => {
  it("observes each successful phase exactly once with raw usage", async () => {
    const f = await runFixture();
    const observed: Parameters<NonNullable<RunControlHooks["onPhaseSettled"]>>[0][] = [];
    const result = await runLoop(f.contract, f.runDir, adapter([15, 35, 60]), {
      onPhaseSettled: async (value) => {
        observed.push(value);
      },
    });
    expect(result.status).toBe("succeeded");
    expect(observed.map(({ phase, tokenUsage, attempt }) => ({ phase, tokenUsage, attempt }))).toEqual([
      { phase: "plan", tokenUsage: 15, attempt: 1 },
      { phase: "execute", tokenUsage: 35, attempt: 1 },
      { phase: "verify", tokenUsage: 60, attempt: 1 },
    ]);
    expect(observed.every((entry) => entry.usageEvidence === usageEvidence)).toBe(true);
  });

  it("reports missing usage as null rather than the controller's synthetic zero", async () => {
    const f = await runFixture();
    const observed: Array<number | null> = [];
    await runLoop(f.contract, f.runDir, adapter([undefined, undefined, undefined]), {
      onPhaseSettled: async ({ tokenUsage }) => {
        observed.push(tokenUsage);
      },
    });
    expect(observed).toEqual([null, null, null]);
  });

  it("observes a timed-out entered phase exactly once", async () => {
    const f = await runFixture();
    f.contract.executionPolicy.perAttemptTimeoutMs = 20;
    const observed = vi.fn();
    const slow: RuntimeAdapter = {
      ...adapter([]),
      plan: async ({ abortSignal }) => {
        await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
        return { summary: "late", primaryTargetPaths: [] };
      },
    };
    const result = await runLoop(f.contract, f.runDir, slow, { onPhaseSettled: observed });
    expect(result.status).toBe("exhausted");
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0]?.[0]).toMatchObject({ phase: "plan", attempt: 1, tokenUsage: null });
  });

  it("observes adapter throw and external abort once for the entered phase", async () => {
    for (const mode of ["throw", "abort"] as const) {
      const f = await runFixture();
      const observed = vi.fn();
      const controller = new AbortController();
      if (mode === "abort") controller.abort();
      const failing: RuntimeAdapter = {
        ...adapter([]),
        plan: async ({ abortSignal }) => {
          if (mode === "abort") expect(abortSignal?.aborted).toBe(true);
          throw new Error(mode);
        },
      };
      await runLoop(f.contract, f.runDir, failing, {
        phaseSignal: controller.signal,
        onPhaseSettled: observed,
      });
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed.mock.calls[0]?.[0]).toMatchObject({ phase: "plan", tokenUsage: null });
    }
  });

  it("aborts the run before execute when observation persistence fails", async () => {
    const f = await runFixture();
    const execute = vi.fn();
    const failingObserver = adapter([1, 2, 3]);
    failingObserver.execute = execute;
    const result = await runLoop(f.contract, f.runDir, failingObserver, {
      onPhaseSettled: async () => {
        throw new Error("usage-write-failed");
      },
    });
    expect(result.status).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("Codex process registration", () => {
  it("registers the detached group before writing the prompt", async () => {
    const f = await codexFixture("integration");
    const registered: unknown[] = [];
    const context: AttemptContext = {
      ...f.context,
      onProcessRegistered: async (process) => {
        await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
        registered.push(process);
      },
    };
    const outcome = await runCodexPhase(parseCodexConfig(f.config), { phase: "plan", prompt: "p", context });
    expect(outcome.reason).toBe("completed");
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ phase: "plan" });
  });

  it("does not write the prompt when process registration fails", async () => {
    const f = await codexFixture("integration");
    const context: AttemptContext = {
      ...f.context,
      onProcessRegistered: async () => {
        throw new Error("registration-failed");
      },
    };
    const outcome = await runCodexPhase(parseCodexConfig(f.config), { phase: "plan", prompt: "p", context });
    expect(outcome.reason).toBe("io-error");
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
