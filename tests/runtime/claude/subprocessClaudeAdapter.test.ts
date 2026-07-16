import { describe, expect, it } from "vitest";
import { SubprocessClaudeAdapter } from "../../../src/runtime/claude/subprocessClaudeAdapter.js";

const contract = {
  objective: { taskId: "task-1", goal: "Fix test", successCondition: "tests pass", nonGoals: [] },
  context: {
    repoPath: "/repo",
    targetPaths: ["src"],
    relevantDocs: [],
    buildTestCommands: ["npm test"],
    constraints: [],
  },
  executionPolicy: {
    autonomyLevel: "L2",
    maxAttempts: 3,
    perAttemptTimeoutMs: 60_000,
    totalRuntimeBudgetMs: 300_000,
    tokenBudget: 10_000,
    worktreeRequired: true,
  },
  safetyPolicy: {
    allowlistPaths: ["src/**"],
    denylistPaths: [],
    maxFilesTouched: 5,
    humanGateConditions: [],
  },
  verification: {
    verifierType: "command",
    requiredChecks: ["npm test"],
    rejectOn: ["tests fail"],
    evidenceRequired: [],
  },
  escalationAndExit: {
    escalationTargets: ["human"],
    pauseOn: [],
    stopOn: [],
    terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
  },
} as const;

const adapter = new SubprocessClaudeAdapter({
  command: ["node", "tests/fixtures/fake-claude.mjs"],
});

describe("SubprocessClaudeAdapter", () => {
  it("passes phase context through the wrapper and parses structured JSON", async () => {
    const context = {
      attempt: 1,
      runDir: ".runs/demo",
      worktreePath: "/tmp/worktree",
      contract,
      state: { status: "planning" },
    } as any;

    expect((await adapter.plan(context)).summary).toBe("change src/index.ts");

    const execution = await adapter.execute(context);
    expect(execution.changedFiles).toEqual(["src/index.ts"]);
    expect(execution.commandOutputs).toEqual(["/tmp/worktree"]);

    expect((await adapter.verify(context)).approved).toBe(true);
  });

  it("preserves partial execute outcomes returned by the wrapper", async () => {
    const context = {
      attempt: 2,
      runDir: ".runs/partial",
      worktreePath: "/tmp/worktree",
      contract,
      state: { status: "executing" },
    } as any;

    await expect(adapter.execute(context)).resolves.toMatchObject({
      completionStatus: "partial",
      failureType: "timeout",
      failureMessage: "subprocess timed out",
      changedFiles: ["secret.txt"],
    });
  });
});
