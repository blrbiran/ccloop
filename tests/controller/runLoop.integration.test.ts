import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["npm test"], rejectOn: ["tests fail"], evidenceRequired: [] },
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

  it("blocks for human input when approval also hits path-policy gating", async () => {
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
          pauseSignals: [],
          stopSignals: [],
        },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.stopReason).toBe("allowlist miss: src/index.ts");
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

  it("passes the current phase state to each adapter step", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const seenContexts: Array<{
      phase: string;
      status: string;
      currentAttempt: number;
      attemptsUsed: number;
      attempt: number;
    }> = [];

    const adapter: RuntimeAdapter = {
      async plan(context) {
        seenContexts.push({
          phase: "plan",
          status: context.state.status,
          currentAttempt: context.state.currentAttempt,
          attemptsUsed: context.state.attemptsUsed,
          attempt: context.attempt,
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
      { phase: "plan", status: "planning", currentAttempt: 1, attemptsUsed: 1, attempt: 1 },
      { phase: "execute", status: "executing", currentAttempt: 1, attemptsUsed: 1, attempt: 1 },
      { phase: "verify", status: "verifying", currentAttempt: 1, attemptsUsed: 1, attempt: 1 },
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
