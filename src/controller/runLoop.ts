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

type PhaseName = "plan" | "execute" | "verify";
type TerminalDecision = Exclude<StopDecision["kind"], "retryable">;

type PhaseOutcome<T> =
  | {
      timedOut: false;
      elapsedMs: number;
      result: T;
    }
  | {
      timedOut: true;
      elapsedMs: number;
    };

const BUDGET_EXHAUSTED_REASON = "runtime or token budget exhausted";

class PhaseExecutionError extends Error {
  readonly elapsedMs: number;

  constructor(elapsedMs: number, error: unknown) {
    super(String(error));
    this.name = "PhaseExecutionError";
    this.elapsedMs = elapsedMs;
  }
}

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
  abortSignal?: AbortSignal,
): AttemptContext {
  return { contract, state, runDir, attempt, worktreePath, abortSignal };
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

function applyPhaseUsage(state: RunState, elapsedMs: number, tokenUsage: number | undefined): RunState {
  return {
    ...state,
    budgetSnapshot: {
      ...state.budgetSnapshot,
      timeRemainingMs: Math.max(state.budgetSnapshot.timeRemainingMs - elapsedMs, 0),
      tokenBudgetRemaining: Math.max(state.budgetSnapshot.tokenBudgetRemaining - getTokenUsage(tokenUsage), 0),
    },
  };
}

function hasBudgetExceeded(state: RunState): boolean {
  return state.budgetSnapshot.timeRemainingMs === 0 || state.budgetSnapshot.tokenBudgetRemaining === 0;
}

function getPhaseTimeoutReason(phase: PhaseName, timeoutMs: number): string {
  return `${phase} phase exceeded per-attempt timeout of ${timeoutMs}ms`;
}

function getPhaseTimeoutMs(contract: LoopContract, state: RunState): number {
  return Math.min(contract.executionPolicy.perAttemptTimeoutMs, state.budgetSnapshot.timeRemainingMs);
}

async function runPhaseWithTimeout<T>(
  timeoutMs: number,
  operation: (abortSignal: AbortSignal) => Promise<T>,
): Promise<PhaseOutcome<T>> {
  const startedAtMs = Date.now();

  if (timeoutMs <= 0) {
    return { timedOut: true, elapsedMs: 0 };
  }

  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const outcome = await Promise.race([
      operation(abortController.signal)
        .then((result) => ({ kind: "result" as const, result }))
        .catch((error: unknown) => {
          throw new PhaseExecutionError(Math.max(Date.now() - startedAtMs, 0), error);
        }),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => {
          resolve({ kind: "timeout" });
          abortController.abort();
        }, timeoutMs);
      }),
    ]);
    const elapsedMs = Math.max(Date.now() - startedAtMs, 0);

    if (outcome.kind === "timeout") {
      return { timedOut: true, elapsedMs };
    }

    return { timedOut: false, elapsedMs, result: outcome.result };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function writeCompletedAttemptArtifacts(
  runDir: string,
  attempt: number,
  plan: AttemptPlan | null,
  execution: ExecutionResult | null,
  verification?: VerificationResult,
): Promise<void> {
  if (plan === null) {
    return;
  }

  await writeAttemptArtifacts(runDir, attempt, {
    plan,
    execution: execution ?? undefined,
    verify: verification,
    diffPatch: execution?.diffPatch,
    stdoutStderrLog: execution?.stdoutStderrLog,
  });
}

async function persistTerminalState(
  runDir: string,
  state: RunState,
  decision: TerminalDecision,
  reason: string,
): Promise<RunState> {
  const terminalState = transitionRunState(state, decision, reason);
  await appendTransitionEvent(runDir, terminalState, `loop_${decision}`, reason);
  await writeRunState(runDir, terminalState);
  return terminalState;
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
          await appendEvent(runDir, {
            type: "workspace_create_failed",
            at: new Date().toISOString(),
            detail: String(error),
          });
          state = await persistTerminalState(
            runDir,
            state,
            "blocked_waiting_human",
            `workspace unavailable: ${String(error)}`,
          );
          return state;
        }

        infraRetryUsed = true;
        await appendEvent(runDir, { type: "workspace_retry", at: new Date().toISOString(), detail: String(error) });
      }
    }

    let plan: AttemptPlan | null = null;
    let execution: ExecutionResult | null = null;
    let verification: VerificationResult | null = null;

    try {
      state = consumeAttemptBudget(state, contract, attempt);
      await writeRunState(runDir, state);

      const planTimeoutMs = getPhaseTimeoutMs(contract, state);
      const planOutcome = await runPhaseWithTimeout(planTimeoutMs, (abortSignal) =>
        adapter.plan(buildAttemptContext(contract, state, runDir, attempt, worktreePath, abortSignal)),
      );

      if (planOutcome.timedOut) {
        state = applyPhaseUsage(state, planOutcome.elapsedMs, undefined);
        state = await persistTerminalState(
          runDir,
          state,
          "exhausted",
          hasBudgetExceeded(state) ? BUDGET_EXHAUSTED_REASON : getPhaseTimeoutReason("plan", planTimeoutMs),
        );
        await cleanupAttemptWorkspaceBestEffort(
          contract.context.repoPath,
          worktreePath,
          runDir,
          "cleanup after terminal decision exhausted",
        );
        return state;
      }

      plan = planOutcome.result;
      state = applyPhaseUsage(state, planOutcome.elapsedMs, plan.tokenUsage);

      if (hasBudgetExceeded(state)) {
        await writeCompletedAttemptArtifacts(runDir, attempt, plan, execution);
        state = await persistTerminalState(runDir, state, "exhausted", BUDGET_EXHAUSTED_REASON);
        await cleanupAttemptWorkspaceBestEffort(
          contract.context.repoPath,
          worktreePath,
          runDir,
          "cleanup after terminal decision exhausted",
        );
        return state;
      }

      state = transitionRunState(state, "executing");
      await appendTransitionEvent(runDir, state, "attempt_started", `attempt ${attempt}`);
      await writeRunState(runDir, state);

      const executeTimeoutMs = getPhaseTimeoutMs(contract, state);
      const executeOutcome = await runPhaseWithTimeout(executeTimeoutMs, (abortSignal) =>
        adapter.execute(buildAttemptContext(contract, state, runDir, attempt, worktreePath, abortSignal)),
      );

      if (executeOutcome.timedOut) {
        state = applyPhaseUsage(state, executeOutcome.elapsedMs, undefined);
        await writeCompletedAttemptArtifacts(runDir, attempt, plan, execution);
        state = await persistTerminalState(
          runDir,
          state,
          "exhausted",
          hasBudgetExceeded(state) ? BUDGET_EXHAUSTED_REASON : getPhaseTimeoutReason("execute", executeTimeoutMs),
        );
        await cleanupAttemptWorkspaceBestEffort(
          contract.context.repoPath,
          worktreePath,
          runDir,
          "cleanup after terminal decision exhausted",
        );
        return state;
      }

      execution = executeOutcome.result;
      state = applyPhaseUsage(state, executeOutcome.elapsedMs, execution.tokenUsage);

      if (hasBudgetExceeded(state)) {
        await writeCompletedAttemptArtifacts(runDir, attempt, plan, execution);
        state = await persistTerminalState(runDir, state, "exhausted", BUDGET_EXHAUSTED_REASON);
        await cleanupAttemptWorkspaceBestEffort(
          contract.context.repoPath,
          worktreePath,
          runDir,
          "cleanup after terminal decision exhausted",
        );
        return state;
      }

      const pathPolicy = evaluatePathPolicy({
        changedFiles: execution.changedFiles,
        allowlistPaths: contract.safetyPolicy.allowlistPaths,
        denylistPaths: contract.safetyPolicy.denylistPaths,
        maxFilesTouched: contract.safetyPolicy.maxFilesTouched,
      });

      if (pathPolicy.humanGateHit) {
        await writeCompletedAttemptArtifacts(runDir, attempt, plan, execution);
        state = await persistTerminalState(
          runDir,
          state,
          "blocked_waiting_human",
          pathPolicy.reason ?? "human gate or denylist hit",
        );
        return state;
      }

      state = transitionRunState(state, "verifying");
      await appendTransitionEvent(runDir, state, "execution_finished", `attempt ${attempt}`);
      await writeRunState(runDir, state);

      const verifyTimeoutMs = getPhaseTimeoutMs(contract, state);
      const verifyOutcome = await runPhaseWithTimeout(verifyTimeoutMs, (abortSignal) =>
        adapter.verify(buildAttemptContext(contract, state, runDir, attempt, worktreePath, abortSignal)),
      );

      if (verifyOutcome.timedOut) {
        state = applyPhaseUsage(state, verifyOutcome.elapsedMs, undefined);
        await writeCompletedAttemptArtifacts(runDir, attempt, plan, execution);
        state = await persistTerminalState(
          runDir,
          state,
          "exhausted",
          hasBudgetExceeded(state) ? BUDGET_EXHAUSTED_REASON : getPhaseTimeoutReason("verify", verifyTimeoutMs),
        );
        await cleanupAttemptWorkspaceBestEffort(
          contract.context.repoPath,
          worktreePath,
          runDir,
          "cleanup after terminal decision exhausted",
        );
        return state;
      }

      verification = verifyOutcome.result;
      state = applyPhaseUsage(state, verifyOutcome.elapsedMs, verification.tokenUsage);
      await writeCompletedAttemptArtifacts(runDir, attempt, plan, execution, verification);

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

      state = await persistTerminalState(runDir, state, decision.kind, decision.reason);

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
      const failureReason = error instanceof PhaseExecutionError ? error.message : String(error);

      if (error instanceof PhaseExecutionError) {
        state = applyPhaseUsage(state, error.elapsedMs, undefined);
      }

      if (state.status !== "failed") {
        state = transitionRunState(state, "failed", failureReason);
        await appendTransitionEvent(runDir, state, "attempt_failed", failureReason);
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
