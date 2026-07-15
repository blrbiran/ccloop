import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import type { LoopContract } from "../../src/contract/schema.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";

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
    expect(finalState.stopReason).toBe("allowlist miss: src/index.ts");
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
      { phase: "plan", status: "planning", currentAttempt: 0, attemptsUsed: 0, attempt: 1 },
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
    expect(finalState.stopReason).toBe("stopOn signal matched: contract-stop");
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual([
      "loop_planning",
      "attempt_started",
      "execution_finished",
      "loop_cancelled",
    ]);
  });

  it("cleans up the worktree when an exception happens after worktree creation", async () => {
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
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("failed");
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
