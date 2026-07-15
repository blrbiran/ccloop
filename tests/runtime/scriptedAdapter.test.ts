import { describe, expect, it } from "vitest";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import type { AttemptContext } from "../../src/runtime/types.js";

describe("ScriptedAdapter", () => {
  it("returns the next scripted plan, execution result, and verification result", async () => {
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
          evidence: ["npm test passed"],
          pauseSignals: [],
          stopSignals: [],
        },
      },
    ]);

    const context: AttemptContext = {
      contract: {
        objective: {
          taskId: "task-6",
          goal: "Update the runtime adapter surface",
          successCondition: "The scripted adapter returns attempt-scoped results",
          nonGoals: [],
        },
        context: {
          repoPath: "/repo",
          targetPaths: ["src/runtime/types.ts"],
          relevantDocs: [],
          buildTestCommands: ["npm test -- tests/runtime/scriptedAdapter.test.ts"],
          constraints: [],
        },
        executionPolicy: {
          autonomyLevel: "L2",
          maxAttempts: 3,
          perAttemptTimeoutMs: 60000,
          totalRuntimeBudgetMs: 300000,
          tokenBudget: 10000,
          worktreeRequired: true,
        },
        safetyPolicy: {
          allowlistPaths: ["src/runtime"],
          denylistPaths: [],
          maxFilesTouched: 5,
          humanGateConditions: [],
        },
        verification: {
          verifierType: "command",
          requiredChecks: ["npm test -- tests/runtime/scriptedAdapter.test.ts"],
          rejectOn: ["typecheck_failed"],
          evidenceRequired: [],
        },
        escalationAndExit: {
          escalationTargets: [],
          pauseOn: ["human_input_required"],
          stopOn: ["objective_met"],
          terminalStates: [
            "succeeded",
            "blocked_waiting_human",
            "exhausted",
            "cancelled",
            "failed",
          ],
        },
      },
      state: {
        status: "planning",
        currentAttempt: 1,
        attemptsUsed: 0,
        lastTransitionAt: "2026-07-15T00:00:00.000Z",
        waitingOnHuman: false,
        stopReason: null,
        budgetSnapshot: {
          attemptsRemaining: 2,
          timeRemainingMs: 240000,
          tokenBudgetRemaining: 8000,
        },
        recentFailures: [],
      },
      runDir: "/tmp/task-6-run",
      attempt: 1,
      worktreePath: "/tmp/task-6-run/worktrees/attempt-1",
    };

    const plan = await adapter.plan(context);
    const execution = await adapter.execute(context);
    const verification = await adapter.verify(context);

    expect(plan.summary).toBe("change src/index.ts");
    expect(execution.changedFiles).toEqual(["src/index.ts"]);
    expect(verification.approved).toBe(true);
    expect(verification.pauseSignals).toEqual([]);
    expect(verification.stopSignals).toEqual([]);
  });
});
