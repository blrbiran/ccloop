import { appendEvent, initializeRunFiles, writeAttemptArtifacts, writeRunState } from "../persistence/fileStore.js";
import { evaluatePathPolicy } from "../policy/pathPolicy.js";
import { evaluateStopDecision } from "../stop/stopController.js";
import { transitionRunState } from "../state/stateMachine.js";
import type { LoopContract } from "../contract/schema.js";
import type { AttemptContext, RuntimeAdapter } from "../runtime/types.js";
import type { FailureFingerprint, RunState } from "../state/types.js";
import { cleanupAttemptWorkspace, createAttemptWorkspace } from "../workspace/worktreeManager.js";

export type { AttemptContext } from "../runtime/types.js";

function initialState(contract: LoopContract): RunState {
  return {
    status: "queued",
    currentAttempt: 0,
    attemptsUsed: 0,
    lastTransitionAt: new Date().toISOString(),
    waitingOnHuman: false,
    stopReason: null,
    budgetSnapshot: {
      attemptsRemaining: contract.executionPolicy.maxAttempts,
      timeRemainingMs: contract.executionPolicy.totalRuntimeBudgetMs,
      tokenBudgetRemaining: contract.executionPolicy.tokenBudget,
    },
    recentFailures: [],
  };
}

export async function runLoop(contract: LoopContract, runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
  let state = transitionRunState(initialState(contract), "planning");
  await initializeRunFiles(runDir, contract, state);

  while (true) {
    await writeRunState(runDir, state);
    const attempt = state.attemptsUsed + 1;

    let worktreePath: string | null = null;
    let infraRetryUsed = false;

    while (!worktreePath) {
      try {
        worktreePath = (await createAttemptWorkspace(contract.context.repoPath, runDir, attempt)).worktreePath;
      } catch (error) {
        if (infraRetryUsed) {
          state = transitionRunState(state, "blocked_waiting_human", `workspace unavailable: ${String(error)}`);
          await appendEvent(runDir, { type: "workspace_create_failed", at: new Date().toISOString(), detail: String(error) });
          await writeRunState(runDir, state);
          return state;
        }

        infraRetryUsed = true;
        await appendEvent(runDir, { type: "workspace_retry", at: new Date().toISOString(), detail: String(error) });
      }
    }

    const context: AttemptContext = { contract, state, runDir, attempt, worktreePath };

    try {
      const plan = await adapter.plan(context);
      state = transitionRunState({ ...state, currentAttempt: attempt, attemptsUsed: attempt }, "executing");
      await appendEvent(runDir, { type: "attempt_started", at: new Date().toISOString(), detail: `attempt ${attempt}` });
      await writeRunState(runDir, state);

      const execution = await adapter.execute(context);
      const pathPolicy = evaluatePathPolicy({
        changedFiles: execution.changedFiles,
        allowlistPaths: contract.safetyPolicy.allowlistPaths,
        denylistPaths: contract.safetyPolicy.denylistPaths,
        maxFilesTouched: contract.safetyPolicy.maxFilesTouched,
      });

      state = transitionRunState(state, "verifying");
      await writeRunState(runDir, state);

      const verification = await adapter.verify(context);
      await writeAttemptArtifacts(runDir, attempt, {
        plan,
        execution,
        verify: verification,
        diffPatch: execution.diffPatch,
        stdoutStderrLog: execution.stdoutStderrLog,
      });

      const humanGateHit =
        pathPolicy.humanGateHit ||
        verification.pauseSignals.some((signal) => contract.escalationAndExit.pauseOn.includes(signal));
      const budgetExceeded = verification.stopSignals.some((signal) => contract.escalationAndExit.stopOn.includes(signal));

      const decision = evaluateStopDecision({
        humanCancelled: false,
        successSatisfied: verification.approved,
        humanGateHit,
        attemptNumber: attempt,
        maxAttempts: contract.executionPolicy.maxAttempts,
        budgetExceeded,
        recentFailures: state.recentFailures,
        verifier: verification,
      });

      if (decision.kind === "retryable") {
        const failure: FailureFingerprint = {
          rejectCategory: verification.rejectCategory,
          primaryTargetPaths: verification.primaryTargetPaths,
          failingCommand: verification.failingCommand,
        };
        state = {
          ...transitionRunState(
            {
              ...state,
              recentFailures: [...state.recentFailures, failure],
              budgetSnapshot: {
                ...state.budgetSnapshot,
                attemptsRemaining: contract.executionPolicy.maxAttempts - attempt,
              },
            },
            "planning",
            decision.reason,
          ),
        };
        await cleanupAttemptWorkspace(contract.context.repoPath, worktreePath);
        continue;
      }

      state = transitionRunState(state, decision.kind, decision.reason);
      await appendEvent(runDir, { type: `loop_${decision.kind}`, at: new Date().toISOString(), detail: decision.reason });
      await writeRunState(runDir, state);

      if (decision.kind !== "blocked_waiting_human") {
        await cleanupAttemptWorkspace(contract.context.repoPath, worktreePath);
      }

      return state;
    } catch (error) {
      await appendEvent(runDir, { type: "attempt_failed", at: new Date().toISOString(), detail: String(error) });
      state = transitionRunState(state, "failed", String(error));
      await writeRunState(runDir, state);
      return state;
    }
  }
}
