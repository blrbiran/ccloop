import { appendEvent, initializeRunFiles, writeAttemptArtifacts, writeRunState } from "../persistence/fileStore.js";
import { evaluatePathPolicy } from "../policy/pathPolicy.js";
import { evaluateStopDecision } from "../stop/stopController.js";
import { transitionRunState } from "../state/stateMachine.js";
import type { LoopContract } from "../contract/schema.js";
import type { AttemptContext, RuntimeAdapter } from "../runtime/types.js";
import type { FailureFingerprint, RunState, StopDecision } from "../state/types.js";
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

function buildAttemptContext(
  contract: LoopContract,
  state: RunState,
  runDir: string,
  attempt: number,
  worktreePath: string,
): AttemptContext {
  return { contract, state, runDir, attempt, worktreePath };
}

async function appendTransitionEvent(runDir: string, state: RunState, type: string, detail: string): Promise<void> {
  await appendEvent(runDir, { type, at: state.lastTransitionAt, detail });
}

function getMatchedStopSignal(contract: LoopContract, stopSignals: string[]): string | null {
  return stopSignals.find((signal) => contract.escalationAndExit.stopOn.includes(signal)) ?? null;
}

export async function runLoop(contract: LoopContract, runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
  let state = transitionRunState(initialState(contract), "planning");
  await initializeRunFiles(runDir, contract, state);
  await appendTransitionEvent(runDir, state, "loop_planning", "run initialized and ready to plan");

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
          await appendTransitionEvent(runDir, state, "workspace_create_failed", String(error));
          await writeRunState(runDir, state);
          return state;
        }

        infraRetryUsed = true;
        await appendEvent(runDir, { type: "workspace_retry", at: new Date().toISOString(), detail: String(error) });
      }
    }

    try {
      const planningContext = buildAttemptContext(contract, state, runDir, attempt, worktreePath);
      const plan = await adapter.plan(planningContext);
      state = transitionRunState({ ...state, currentAttempt: attempt, attemptsUsed: attempt }, "executing");
      await appendTransitionEvent(runDir, state, "attempt_started", `attempt ${attempt}`);
      await writeRunState(runDir, state);

      const executionContext = buildAttemptContext(contract, state, runDir, attempt, worktreePath);
      const execution = await adapter.execute(executionContext);
      const pathPolicy = evaluatePathPolicy({
        changedFiles: execution.changedFiles,
        allowlistPaths: contract.safetyPolicy.allowlistPaths,
        denylistPaths: contract.safetyPolicy.denylistPaths,
        maxFilesTouched: contract.safetyPolicy.maxFilesTouched,
      });

      state = transitionRunState(state, "verifying");
      await appendTransitionEvent(runDir, state, "execution_finished", `attempt ${attempt}`);
      await writeRunState(runDir, state);

      const verificationContext = buildAttemptContext(contract, state, runDir, attempt, worktreePath);
      const verification = await adapter.verify(verificationContext);
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
      const matchedStopSignal = getMatchedStopSignal(contract, verification.stopSignals);

      const decision: StopDecision = humanGateHit
        ? { kind: "blocked_waiting_human", reason: pathPolicy.reason ?? "human gate or denylist hit" }
        : matchedStopSignal !== null
          ? { kind: "cancelled", reason: `stopOn signal matched: ${matchedStopSignal}` }
          : evaluateStopDecision({
              humanCancelled: false,
              successSatisfied: verification.approved,
              humanGateHit: false,
              attemptNumber: attempt,
              maxAttempts: contract.executionPolicy.maxAttempts,
              budgetExceeded: false,
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
        await appendTransitionEvent(runDir, state, "verification_rejected", decision.reason);
        await cleanupAttemptWorkspace(contract.context.repoPath, worktreePath);
        continue;
      }

      state = transitionRunState(state, decision.kind, decision.reason);
      await appendTransitionEvent(runDir, state, `loop_${decision.kind}`, decision.reason);
      await writeRunState(runDir, state);

      if (decision.kind !== "blocked_waiting_human") {
        await cleanupAttemptWorkspace(contract.context.repoPath, worktreePath);
      }

      return state;
    } catch (error) {
      state = transitionRunState(state, "failed", String(error));
      await appendTransitionEvent(runDir, state, "attempt_failed", String(error));
      await writeRunState(runDir, state);

      if (worktreePath !== null) {
        await cleanupAttemptWorkspace(contract.context.repoPath, worktreePath);
      }

      return state;
    }
  }
}
