import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import type { LoopContract } from "../../src/contract/schema.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import type { RunState } from "../../src/state/types.js";

const execFileAsync = promisify(execFile);

async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

function createContract(repoPath: string): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix test", successCondition: "required checks pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["tests fail"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

async function readEventTypes(runDir: string): Promise<string[]> {
  const contents = await readFile(join(runDir, "events.jsonl"), "utf8");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).type as string);
}

async function readRunState(runDir: string): Promise<RunState> {
  return JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as RunState;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return;
  }

  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("runLoop", () => {
  it("succeeds when verification approves", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
        verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["npm test passed"], pauseSignals: [], stopSignals: [] },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);

    expect(finalState.status).toBe("succeeded");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(await readEventTypes(runDir)).toEqual([
      "loop_planning",
      "attempt_started",
      "execution_finished",
      "loop_succeeded",
    ]);
  });

  it("rejects reusing a runDir that already contains preserved run state", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        allowlistPaths: ["src/allowed/**"],
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");

    const firstAdapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const firstState = await runLoop(contract, runDir, firstAdapter);
    const originalStateFile = await readFile(join(runDir, "loop-state.json"), "utf8");
    const originalEventsFile = await readFile(join(runDir, "events.jsonl"), "utf8");
    let planCalled = false;

    const secondAdapter: RuntimeAdapter = {
      async plan() {
        planCalled = true;
        throw new Error("plan should not run");
      },
      async execute() {
        throw new Error("execute should not run");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    expect(firstState.status).toBe("blocked_waiting_human");
    await expect(runLoop(contract, runDir, secondAdapter)).rejects.toThrow(
      "runDir already contains prior run data",
    );
    expect(planCalled).toBe(false);
    expect(await readFile(join(runDir, "loop-state.json"), "utf8")).toBe(originalStateFile);
    expect(await readFile(join(runDir, "events.jsonl"), "utf8")).toBe(originalEventsFile);

    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });
    expect(stdout).toContain(attemptWorktreePath);
  });

  it("succeeds from requiredChecks alone when verifierType is command", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      verification: {
        ...baseContract.verification,
        verifierType: "command",
        evidenceRequired: ["command output"],
      },
    };
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedVerify = JSON.parse(await readFile(join(runDir, "attempts", "1", "verify.json"), "utf8")) as {
      approved: boolean;
      evidence: string[];
      failingCommand: string | null;
    };

    expect(finalState.status).toBe("succeeded");
    expect(verifyCalled).toBe(false);
    expect(persistedVerify.approved).toBe(true);
    expect(persistedVerify.failingCommand).toBeNull();
    expect(persistedVerify.evidence[0]).toContain("required check passed: true");
  });

  it("does not succeed when verifierType is command and a required check fails", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      verification: {
        ...baseContract.verification,
        verifierType: "command",
        requiredChecks: ["false"],
      },
    };
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedVerify = JSON.parse(await readFile(join(runDir, "attempts", "1", "verify.json"), "utf8")) as {
      approved: boolean;
      rejectCategory: string;
      failingCommand: string | null;
    };

    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("verifier rejection with no safe retry path");
    expect(verifyCalled).toBe(false);
    expect(persistedVerify).toMatchObject({
      approved: false,
      rejectCategory: "required-check-failed",
      failingCommand: "false",
    });
  });

  it("skips adapter.verify when agent verification requiredChecks fail", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      verification: {
        ...baseContract.verification,
        verifierType: "agent",
        requiredChecks: ["false"],
      },
    };
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        verifyCalled = true;
        return {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["should not be used"],
          pauseSignals: [],
          stopSignals: [],
        };
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedVerify = JSON.parse(await readFile(join(runDir, "attempts", "1", "verify.json"), "utf8")) as {
      approved: boolean;
      rejectCategory: string;
      failingCommand: string | null;
    };

    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("verifier rejection with no safe retry path");
    expect(verifyCalled).toBe(false);
    expect(persistedVerify).toMatchObject({
      approved: false,
      rejectCategory: "required-check-failed",
      failingCommand: "false",
    });
  });

  it("does not succeed when approved verification is missing required evidence", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      verification: {
        ...baseContract.verification,
        evidenceRequired: ["proof token"],
      },
    };

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        return {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["looks good"],
          pauseSignals: [],
          stopSignals: [],
        };
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedVerify = JSON.parse(await readFile(join(runDir, "attempts", "1", "verify.json"), "utf8")) as {
      approved: boolean;
      rejectCategory: string;
      evidence: string[];
    };

    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("verifier rejection with no safe retry path");
    expect(persistedVerify.approved).toBe(false);
    expect(persistedVerify.rejectCategory).toBe("missing-required-evidence");
    expect(persistedVerify.evidence).toContain("missing required evidence: proof token");
  });

  it("blocks for human input when approval also hits a pauseOn gate", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      escalationAndExit: {
        ...baseContract.escalationAndExit,
        pauseOn: ["needs-human-review"],
      },
    };

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
        verification: {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["looks good"],
          pauseSignals: ["needs-human-review"],
          stopSignals: [],
        },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
  });

  it("blocks for human input before verify when path-policy gating hits", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        allowlistPaths: ["src/allowed/**"],
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.stopReason).toBe("allowlist miss: src/index.ts");
    expect(verifyCalled).toBe(false);
    expect(stdout).toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual([
      "loop_planning",
      "attempt_started",
      "loop_blocked_waiting_human",
    ]);
  });

  it("prioritizes the post-execute path-policy human gate over budget exhaustion", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        allowlistPaths: ["src/allowed/**"],
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => 1_000);

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
          tokenUsage: 1_000,
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    try {
      const finalState = await runLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);
      const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

      expect(finalState.status).toBe("blocked_waiting_human");
      expect(finalState.attemptsUsed).toBe(1);
      expect(finalState.stopReason).toBe("allowlist miss: src/index.ts");
      expect(finalState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        tokenBudgetRemaining: 0,
      });
      expect(persistedState.status).toBe("blocked_waiting_human");
      expect(persistedState.stopReason).toBe("allowlist miss: src/index.ts");
      expect(persistedState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        tokenBudgetRemaining: 0,
      });
      expect(verifyCalled).toBe(false);
      expect(stdout).toContain(attemptWorktreePath);
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "loop_blocked_waiting_human",
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("persists retry-ready planning state before retry cleanup runs", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const cleanupStates: RunState[] = [];

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        cleanupAttemptWorkspace: async (actualRepoPath: string, worktreePath: string) => {
          cleanupStates.push(await readRunState(runDir));
          await actual.cleanupAttemptWorkspace(actualRepoPath, worktreePath);
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter = new ScriptedAdapter([
        {
          plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
          execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "fail" },
          verification: { approved: false, rejectCategory: "tests-failed", primaryTargetPaths: ["src/index.ts"], failingCommand: "npm test", safeToRetry: true, evidence: ["FAIL"], pauseSignals: [], stopSignals: [] },
        },
        {
          plan: { summary: "change src/index.ts again", primaryTargetPaths: ["src/index.ts"] },
          execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited again"], stdoutStderrLog: "ok" },
          verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["pass"], pauseSignals: [], stopSignals: [] },
        },
      ]);

      const finalState = await observedRunLoop(contract, runDir, adapter);

      expect(finalState.status).toBe("succeeded");
      expect(cleanupStates).not.toHaveLength(0);
      expect(cleanupStates[0]).toMatchObject({
        status: "planning",
        currentAttempt: 1,
        attemptsUsed: 1,
        budgetSnapshot: { attemptsRemaining: 2 },
      });
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("passes phase state plus plan/execution context to each adapter step", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const seenContexts: Array<{
      phase: string;
      status: string;
      currentAttempt: number;
      attemptsUsed: number;
      attempt: number;
      planSummary?: string;
      executionChangedFiles?: string[];
    }> = [];

    const adapter: RuntimeAdapter = {
      async plan(context) {
        seenContexts.push({
          phase: "plan",
          status: context.state.status,
          currentAttempt: context.state.currentAttempt,
          attemptsUsed: context.state.attemptsUsed,
          attempt: context.attempt,
          planSummary: context.plan?.summary,
          executionChangedFiles: context.execution?.changedFiles,
        });
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        seenContexts.push({
          phase: "execute",
          status: context.state.status,
          currentAttempt: context.state.currentAttempt,
          attemptsUsed: context.state.attemptsUsed,
          attempt: context.attempt,
          planSummary: context.plan?.summary,
          executionChangedFiles: context.execution?.changedFiles,
        });
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify(context) {
        seenContexts.push({
          phase: "verify",
          status: context.state.status,
          currentAttempt: context.state.currentAttempt,
          attemptsUsed: context.state.attemptsUsed,
          attempt: context.attempt,
          planSummary: context.plan?.summary,
          executionChangedFiles: context.execution?.changedFiles,
        });
        return {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["npm test passed"],
          pauseSignals: [],
          stopSignals: [],
        };
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);

    expect(finalState.status).toBe("succeeded");
    expect(seenContexts).toEqual([
      {
        phase: "plan",
        status: "planning",
        currentAttempt: 1,
        attemptsUsed: 1,
        attempt: 1,
        planSummary: undefined,
        executionChangedFiles: undefined,
      },
      {
        phase: "execute",
        status: "executing",
        currentAttempt: 1,
        attemptsUsed: 1,
        attempt: 1,
        planSummary: "change src/index.ts",
        executionChangedFiles: undefined,
      },
      {
        phase: "verify",
        status: "verifying",
        currentAttempt: 1,
        attemptsUsed: 1,
        attempt: 1,
        planSummary: "change src/index.ts",
        executionChangedFiles: ["src/index.ts"],
      },
    ]);
  });

  it("stops immediately when a stopOn signal matches", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      escalationAndExit: {
        ...baseContract.escalationAndExit,
        stopOn: ["contract-stop"],
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
        verification: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: "npm test",
          safeToRetry: true,
          evidence: ["found stop signal"],
          pauseSignals: [],
          stopSignals: ["contract-stop"],
        },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("cancelled");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.stopReason).toBe("stopOn signal matched: contract-stop");
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual([
      "loop_planning",
      "attempt_started",
      "execution_finished",
      "loop_cancelled",
    ]);
  });

  it("exhausts the run when planning exceeds per-attempt timeout", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let executeCalled = false;
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        await delay(160);
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        executeCalled = true;
        throw new Error("execute should not run");
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe("plan phase exceeded per-attempt timeout of 20ms");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.budgetSnapshot.tokenBudgetRemaining).toBe(1000);
    expect(finalState.budgetSnapshot.timeRemainingMs).toBeLessThan(5000);
    expect(persistedState.status).toBe("exhausted");
    expect(persistedState.stopReason).toBe("plan phase exceeded per-attempt timeout of 20ms");
    expect(executeCalled).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "loop_exhausted"]);
  });

  it("persists completed plan artifacts when execute timeout yields no adapter result before verify", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe("execute phase exceeded per-attempt timeout of 20ms");
    expect(persistedState.status).toBe("exhausted");
    expect(persistedState.stopReason).toBe("execute phase exceeded per-attempt timeout of 20ms");
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(false);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "loop_exhausted"]);
  });


  it("treats execute timeout with no adapter result as exhausted even if files changed in the worktree", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        denylistPaths: ["secret.txt"],
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "touch denylisted file", primaryTargetPaths: ["secret.txt"] };
      },
      async execute(context) {
        await writeFile(join(context.worktreePath, "secret.txt"), "partial output\n");
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe("runtime or token budget exhausted");
    expect(finalState.budgetSnapshot).toMatchObject({
      attemptsRemaining: 2,
      timeRemainingMs: 0,
    });
    expect(persistedState.status).toBe("exhausted");
    expect(persistedState.stopReason).toBe("runtime or token budget exhausted");
    expect(persistedState.budgetSnapshot).toMatchObject({
      attemptsRemaining: 2,
      timeRemainingMs: 0,
    });
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(false);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "loop_exhausted"]);
  });

  it("blocks for human input on execute timeout when the adapter returns a partial outcome with gated files", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 50,
      },
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        denylistPaths: ["secret.txt"],
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "touch denylisted file", primaryTargetPaths: ["secret.txt"] };
      },
      async execute(context) {
        await writeFile(join(context.worktreePath, "secret.txt"), "partial output\n");
        await delay(60);
        return {
          completionStatus: "partial",
          failureType: "timeout",
          failureMessage: "adapter timed out",
          changedFiles: ["secret.txt"],
          diffPatch: "diff --git a/secret.txt b/secret.txt",
          commandOutputs: ["edited"],
          stdoutStderrLog: "timed out",
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.stopReason).toBe("denylist match: secret.txt");
    expect(finalState.budgetSnapshot).toMatchObject({
      attemptsRemaining: 2,
      timeRemainingMs: 0,
    });
    expect(persistedState.status).toBe("blocked_waiting_human");
    expect(persistedState.stopReason).toBe("denylist match: secret.txt");
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "diff.patch"))).toBe(true);
    expect(await pathExists(join(attemptDir, "stdout-stderr.log"))).toBe(true);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "loop_blocked_waiting_human"]);
  });


  it("continues normally when execute returns a complete result during the recovery window", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        partialOutcomeRecoveryWindowMs: 30,
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        await delay(40);
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        verifyCalled = true;
        return {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["npm test passed"],
          pauseSignals: [],
          stopSignals: [],
        };
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("succeeded");
    expect(finalState.stopReason).toBe("success condition satisfied");
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.budgetSnapshot.timeRemainingMs).toBeLessThan(baseContract.executionPolicy.totalRuntimeBudgetMs);
    expect(persistedState.status).toBe("succeeded");
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(true);
    expect(verifyCalled).toBe(true);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "execution_finished", "loop_succeeded"]);
  });

  it("blocks for human input on execute errors when the adapter returns a partial outcome with gated files", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        denylistPaths: ["secret.txt"],
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "touch denylisted file", primaryTargetPaths: ["secret.txt"] };
      },
      async execute() {
        return {
          completionStatus: "partial",
          failureType: "error",
          failureMessage: "adapter exploded",
          changedFiles: ["secret.txt"],
          diffPatch: "diff --git a/secret.txt b/secret.txt",
          commandOutputs: ["edited"],
          stdoutStderrLog: "error",
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.stopReason).toBe("denylist match: secret.txt");
    expect(persistedState.status).toBe("blocked_waiting_human");
    expect(persistedState.stopReason).toBe("denylist match: secret.txt");
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "loop_blocked_waiting_human"]);
  });

  it("treats execute errors without adapter partial outcome as failed even if files changed in the worktree", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        denylistPaths: ["secret.txt"],
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "touch denylisted file", primaryTargetPaths: ["secret.txt"] };
      },
      async execute(context) {
        await writeFile(join(context.worktreePath, "secret.txt"), "partial output\n");
        throw new Error("execute exploded");
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("Error: execute exploded");
    expect(persistedState.status).toBe("failed");
    expect(persistedState.stopReason).toBe("Error: execute exploded");
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(false);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(false);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "attempt_failed"]);
  });

  it("caps phase timeout by the remaining runtime budget", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 1_000,
        totalRuntimeBudgetMs: 20,
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let executeCalled = false;
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        await delay(60);
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        executeCalled = true;
        throw new Error("execute should not run");
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe("runtime or token budget exhausted");
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.budgetSnapshot.timeRemainingMs).toBe(0);
    expect(persistedState.status).toBe("exhausted");
    expect(persistedState.stopReason).toBe("runtime or token budget exhausted");
    expect(executeCalled).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "loop_exhausted"]);
  });

  it("stops after plan token usage exhausts the token budget", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let executeCalled = false;
    let verifyCalled = false;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => 1_000);

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"], tokenUsage: 1_000 };
      },
      async execute() {
        executeCalled = true;
        throw new Error("execute should not run");
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    try {
      const finalState = await runLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);
      const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

      expect(finalState.status).toBe("exhausted");
      expect(finalState.stopReason).toBe("runtime or token budget exhausted");
      expect(finalState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 5_000,
        tokenBudgetRemaining: 0,
      });
      expect(persistedState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 5_000,
        tokenBudgetRemaining: 0,
      });
      expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
      expect(await pathExists(join(attemptDir, "execution.json"))).toBe(false);
      expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
      expect(executeCalled).toBe(false);
      expect(verifyCalled).toBe(false);
      expect(stdout).not.toContain(attemptWorktreePath);
      expect(await readEventTypes(runDir)).toEqual(["loop_planning", "loop_exhausted"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("stops after execute token usage exhausts the token budget", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => 1_000);

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
          tokenUsage: 1_000,
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    try {
      const finalState = await runLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);
      const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

      expect(finalState.status).toBe("exhausted");
      expect(finalState.stopReason).toBe("runtime or token budget exhausted");
      expect(finalState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 5_000,
        tokenBudgetRemaining: 0,
      });
      expect(persistedState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 5_000,
        tokenBudgetRemaining: 0,
      });
      expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
      expect(await pathExists(join(attemptDir, "execution.json"))).toBe(true);
      expect(await pathExists(join(attemptDir, "diff.patch"))).toBe(true);
      expect(await pathExists(join(attemptDir, "stdout-stderr.log"))).toBe(true);
      expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
      expect(verifyCalled).toBe(false);
      expect(stdout).not.toContain(attemptWorktreePath);
      expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "loop_exhausted"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("exhausts the run when adapter-reported token usage exceeds the token budget", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    const timestamps = [1_000, 1_600];
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => timestamps.shift() ?? 1_600);

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"], tokenUsage: 400 },
        execution: {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "fail",
          tokenUsage: 350,
        },
        verification: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: "npm test",
          safeToRetry: true,
          evidence: ["token budget exhausted"],
          pauseSignals: [],
          stopSignals: [],
          tokenUsage: 500,
        },
      },
    ]);

    try {
      const finalState = await runLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);
      const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

      expect(finalState.status).toBe("exhausted");
      expect(finalState.stopReason).toBe("runtime or token budget exhausted");
      expect(finalState.attemptsUsed).toBe(1);
      expect(finalState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 4_400,
        tokenBudgetRemaining: 0,
      });
      expect(persistedState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 4_400,
        tokenBudgetRemaining: 0,
      });
      expect(stdout).not.toContain(attemptWorktreePath);
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "execution_finished",
        "loop_exhausted",
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("returns the terminal state when cleanup fails after a non-human terminal decision", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        cleanupAttemptWorkspace: async () => {
          throw new Error("cleanup exploded");
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter = new ScriptedAdapter([
        {
          plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
          execution: {
            changedFiles: ["src/index.ts"],
            diffPatch: "diff --git a/src/index.ts b/src/index.ts",
            commandOutputs: ["edited"],
            stdoutStderrLog: "ok",
          },
          verification: {
            approved: true,
            rejectCategory: "",
            primaryTargetPaths: ["src/index.ts"],
            failingCommand: null,
            safeToRetry: false,
            evidence: ["pass"],
            pauseSignals: [],
            stopSignals: [],
          },
        },
      ]);

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);
      const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

      expect(finalState.status).toBe("succeeded");
      expect(finalState.stopReason).toBe("success condition satisfied");
      expect(persistedState.status).toBe("succeeded");
      expect(persistedState.stopReason).toBe("success condition satisfied");
      expect(stdout).toContain(attemptWorktreePath);
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "execution_finished",
        "loop_succeeded",
        "workspace_cleanup_failed",
      ]);
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("returns a failed terminal state when retry cleanup fails", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        cleanupAttemptWorkspace: async () => {
          throw new Error("cleanup exploded");
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter = new ScriptedAdapter([
        {
          plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
          execution: {
            changedFiles: ["src/index.ts"],
            diffPatch: "diff --git a/src/index.ts b/src/index.ts",
            commandOutputs: ["edited"],
            stdoutStderrLog: "fail",
          },
          verification: {
            approved: false,
            rejectCategory: "tests-failed",
            primaryTargetPaths: ["src/index.ts"],
            failingCommand: "npm test",
            safeToRetry: true,
            evidence: ["FAIL"],
            pauseSignals: [],
            stopSignals: [],
          },
        },
      ]);

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);

      expect(finalState.status).toBe("failed");
      expect(finalState.stopReason).toBe("Error: cleanup exploded");
      expect(persistedState.status).toBe("failed");
      expect(persistedState.stopReason).toBe("Error: cleanup exploded");
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "execution_finished",
        "verification_rejected",
        "attempt_failed",
        "workspace_cleanup_failed",
      ]);
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("returns failed when planning throws and follow-up cleanup also fails", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        cleanupAttemptWorkspace: async () => {
          throw new Error("cleanup exploded");
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter: RuntimeAdapter = {
        async plan() {
          throw new Error("plan exploded");
        },
        async execute() {
          throw new Error("execute should not run");
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);

      expect(finalState.status).toBe("failed");
      expect(finalState.stopReason).toBe("Error: plan exploded");
      expect(persistedState.status).toBe("failed");
      expect(persistedState.stopReason).toBe("Error: plan exploded");
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_failed",
        "workspace_cleanup_failed",
      ]);
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("counts a thrown planning attempt as consumed", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");

    const adapter: RuntimeAdapter = {
      async plan() {
        throw new Error("plan exploded");
      },
      async execute() {
        throw new Error("execute should not run");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("failed");
    expect(finalState.currentAttempt).toBe(1);
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(persistedState.currentAttempt).toBe(1);
    expect(persistedState.attemptsUsed).toBe(1);
    expect(persistedState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(stdout).not.toContain(attemptWorktreePath);
  });

  it("records both diagnostic and canonical terminal events when worktree creation fails twice", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    let planCalled = false;

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        createAttemptWorkspace: async () => {
          throw new Error("workspace exploded");
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter: RuntimeAdapter = {
        async plan() {
          planCalled = true;
          throw new Error("plan should not run");
        },
        async execute() {
          throw new Error("execute should not run");
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);

      expect(finalState.status).toBe("blocked_waiting_human");
      expect(finalState.attemptsUsed).toBe(0);
      expect(finalState.stopReason).toBe("workspace unavailable: Error: workspace exploded");
      expect(persistedState.status).toBe("blocked_waiting_human");
      expect(persistedState.stopReason).toBe("workspace unavailable: Error: workspace exploded");
      expect(planCalled).toBe(false);
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "workspace_retry",
        "workspace_create_failed",
        "loop_blocked_waiting_human",
      ]);
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("preserves transition-event completeness when the run blocks for human input", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "fail" },
        verification: { approved: false, rejectCategory: "tests-failed", primaryTargetPaths: ["src/index.ts"], failingCommand: "npm test", safeToRetry: true, evidence: ["FAIL"], pauseSignals: [], stopSignals: [] },
      },
      {
        plan: { summary: "change src/index.ts again", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited again"], stdoutStderrLog: "fail" },
        verification: { approved: false, rejectCategory: "different-reason", primaryTargetPaths: ["src/index.ts"], failingCommand: "npm test", safeToRetry: true, evidence: ["FAIL"], pauseSignals: [], stopSignals: [] },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.attemptsUsed).toBe(2);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(1);
    expect(stdout).toContain(join(runDir, "worktrees", "attempt-2"));
    expect(await readEventTypes(runDir)).toEqual([
      "loop_planning",
      "attempt_started",
      "execution_finished",
      "verification_rejected",
      "attempt_started",
      "execution_finished",
      "loop_blocked_waiting_human",
    ]);
  });
});
