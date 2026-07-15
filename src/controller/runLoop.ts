import { appendEvent, initializeRunFiles, writeAttemptArtifacts, writeRunState } from "../persistence/fileStore.js";
import { evaluatePathPolicy } from "../policy/pathPolicy.js";
import { evaluateStopDecision } from "../stop/stopController.js";
import { transitionRunState } from "../state/stateMachine.js";
import type { LoopContract } from "../contract/schema.js";
import type {
  AttemptContext,
  AttemptPlan,
  ExecutionResult,
  RuntimeAdapter,
  VerificationResult,
} from "../runtime/types.js";
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

async function cleanupAttemptWorkspaceBestEffort(
  repoPath: string,
  worktreePath: string,
  runDir: string,
  detail: string,
): Promise<void> {
  try {
    await cleanupAttemptWorkspace(repoPath, worktreePath);
  } catch (error) {
    await appendEvent(runDir, {
      type: "workspace_cleanup_failed",
      at: new Date().toISOString(),
      detail: `${detail}: ${String(error)}`,
    });
  }
}

function getMatchedStopSignal(contract: LoopContract, stopSignals: string[]): string | null {
  return stopSignals.find((signal) => contract.escalationAndExit.stopOn.includes(signal)) ?? null;
}

function consumeAttemptBudget(state: RunState, contract: LoopContract, attempt: number): RunState {
  return {
    ...state,
    currentAttempt: attempt,
    attemptsUsed: attempt,
    budgetSnapshot: {
      ...state.budgetSnapshot,
      attemptsRemaining: Math.max(contract.executionPolicy.maxAttempts - attempt, 0),
    },
  };
}

function getTokenUsage(tokenUsage: number | undefined): number {
  return tokenUsage ?? 0;
}

function getAttemptTokenUsage(
  plan: AttemptPlan | null,
  execution: ExecutionResult | null,
  verification: VerificationResult | null,
): number {
  return getTokenUsage(plan?.tokenUsage) + getTokenUsage(execution?.tokenUsage) + getTokenUsage(verification?.tokenUsage);
}

function applyAttemptUsage(
  state: RunState,
  attemptStartedAtMs: number,
  plan: AttemptPlan | null,
  execution: ExecutionResult | null,
  verification: VerificationResult | null,
): RunState {
  const elapsedMs = Math.max(Date.now() - attemptStartedAtMs, 0);
  const tokenUsage = getAttemptTokenUsage(plan, execution, verification);

  return {
    ...state,
    budgetSnapshot: {
      ...state.budgetSnapshot,
      timeRemainingMs: Math.max(state.budgetSnapshot.timeRemainingMs - elapsedMs, 0),
      tokenBudgetRemaining: Math.max(state.budgetSnapshot.tokenBudgetRemaining - tokenUsage, 0),
    },
  };
}

function hasBudgetExceeded(state: RunState): boolean {
  return state.budgetSnapshot.timeRemainingMs === 0 || state.budgetSnapshot.tokenBudgetRemaining === 0;
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

    let plan: AttemptPlan | null = null;
    let execution: ExecutionResult | null = null;
    let verification: VerificationResult | null = null;
    let attemptUsageApplied = false;
    const attemptStartedAtMs = Date.now();

    try {
      state = consumeAttemptBudget(state, contract, attempt);
      await writeRunState(runDir, state);

      const planningContext = buildAttemptContext(contract, state, runDir, attempt, worktreePath);
      plan = await adapter.plan(planningContext);
      state = transitionRunState(state, "executing");
      await appendTransitionEvent(runDir, state, "attempt_started", `attempt ${attempt}`);
      await writeRunState(runDir, state);

      const executionContext = buildAttemptContext(contract, state, runDir, attempt, worktreePath);
      execution = await adapter.execute(executionContext);
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
      verification = await adapter.verify(verificationContext);
      state = applyAttemptUsage(state, attemptStartedAtMs, plan, execution, verification);
      attemptUsageApplied = true;
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
              budgetExceeded: hasBudgetExceeded(state),
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
            },
            "planning",
            decision.reason,
          ),
        };
        await appendTransitionEvent(runDir, state, "verification_rejected", decision.reason);
        await writeRunState(runDir, state);

        try {
          await cleanupAttemptWorkspace(contract.context.repoPath, worktreePath);
        } catch (error) {
          state = transitionRunState(state, "failed", String(error));
          await appendTransitionEvent(runDir, state, "attempt_failed", String(error));
          await writeRunState(runDir, state);
          await cleanupAttemptWorkspaceBestEffort(
            contract.context.repoPath,
            worktreePath,
            runDir,
            "cleanup after retry cleanup failure",
          );
          return state;
        }

        continue;
      }

      state = transitionRunState(state, decision.kind, decision.reason);
      await appendTransitionEvent(runDir, state, `loop_${decision.kind}`, decision.reason);
      await writeRunState(runDir, state);

      if (decision.kind !== "blocked_waiting_human") {
        await cleanupAttemptWorkspaceBestEffort(
          contract.context.repoPath,
          worktreePath,
          runDir,
          `cleanup after terminal decision ${decision.kind}`,
        );
      }

      return state;
    } catch (error) {
      if (!attemptUsageApplied) {
        state = applyAttemptUsage(state, attemptStartedAtMs, plan, execution, verification);
      }

      if (state.status !== "failed") {
        state = transitionRunState(state, "failed", String(error));
        await appendTransitionEvent(runDir, state, "attempt_failed", String(error));
        await writeRunState(runDir, state);
      }

      if (worktreePath !== null) {
        await cleanupAttemptWorkspaceBestEffort(
          contract.context.repoPath,
          worktreePath,
          runDir,
          "cleanup after controller failure",
        );
      }

      return state;
    }
  }
}
