import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendEvent, initializeRunFiles, writeAttemptArtifacts, writeBoundaryArtifacts, writeRunState } from "../persistence/fileStore.js";
import { evaluatePathPolicy } from "../policy/pathPolicy.js";
import { evaluateRunBoundary, evaluateStopDecision } from "../stop/stopController.js";
import { transitionRunState } from "../state/stateMachine.js";
import type { LoopContract } from "../contract/schema.js";
import type {
  AttemptContext,
  AttemptPlan,
  ExecutionRecovery,
  ExecutionResult,
  RuntimeAdapter,
  VerificationResult,
} from "../runtime/types.js";
import { isPartialExecutionResult } from "../runtime/types.js";
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
      result?: T;
      abortedError?: unknown;
    };

const execFileAsync = promisify(execFile);

type RequiredChecksOutcome =
  | {
      passed: true;
      evidence: string[];
    }
  | {
      passed: false;
      verification: VerificationResult;
    };

type ExecFileError = Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string | null;
  signal?: string | null;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function buildRequiredCheckEvidence(
  command: string,
  status: "passed" | "failed",
  stdout: string,
  stderr: string,
  error?: ExecFileError,
): string {
  const details = ["command output", `required check ${status}: ${command}`];
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (trimmedStdout) {
    details.push(`stdout=${trimmedStdout}`);
  }

  if (trimmedStderr) {
    details.push(`stderr=${trimmedStderr}`);
  }

  if (status === "failed") {
    if (error?.code !== undefined && error.code !== null) {
      details.push(`exit=${String(error.code)}`);
    } else if (error?.signal) {
      details.push(`signal=${error.signal}`);
    } else if (error?.message) {
      details.push(`error=${error.message}`);
    }
  }

  return details.join(" | ");
}

function getVerificationPrimaryTargetPaths(
  contract: LoopContract,
  plan: AttemptPlan | null,
  execution: ExecutionResult,
): string[] {
  if (execution.changedFiles.length > 0) {
    return execution.changedFiles;
  }

  if (plan !== null && plan.primaryTargetPaths.length > 0) {
    return plan.primaryTargetPaths;
  }

  return contract.context.targetPaths;
}

async function runRequiredChecks(
  requiredChecks: string[],
  worktreePath: string,
  primaryTargetPaths: string[],
  abortSignal?: AbortSignal,
): Promise<RequiredChecksOutcome> {
  const evidence: string[] = [];

  for (const command of requiredChecks) {
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
        cwd: worktreePath,
        signal: abortSignal,
        maxBuffer: 10 * 1024 * 1024,
      });
      evidence.push(buildRequiredCheckEvidence(command, "passed", stdout, stderr));
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      const execError = error as ExecFileError;
      return {
        passed: false,
        verification: {
          approved: false,
          rejectCategory: "required-check-failed",
          primaryTargetPaths,
          failingCommand: command,
          safeToRetry: false,
          evidence: [
            ...evidence,
            buildRequiredCheckEvidence(command, "failed", execError.stdout ?? "", execError.stderr ?? "", execError),
          ],
          pauseSignals: [],
          stopSignals: [],
        },
      };
    }
  }

  return { passed: true, evidence };
}

function evidenceIncludes(evidence: string[], requirement: string): boolean {
  return evidence.some((entry) => entry.includes(requirement));
}

function enforceVerificationContract(contract: LoopContract, verification: VerificationResult): VerificationResult {
  if (!verification.approved) {
    return verification;
  }

  const matchedRejectOn =
    contract.verification.rejectOn.find((rejectCondition) => evidenceIncludes(verification.evidence, rejectCondition)) ?? null;
  const missingEvidence = contract.verification.evidenceRequired.filter(
    (requiredEvidence) => !evidenceIncludes(verification.evidence, requiredEvidence),
  );

  if (matchedRejectOn === null && missingEvidence.length === 0) {
    return verification;
  }

  const enforcementNotes: string[] = [];

  if (matchedRejectOn !== null) {
    enforcementNotes.push(`contract rejectOn matched: ${matchedRejectOn}`);
  }

  if (missingEvidence.length > 0) {
    enforcementNotes.push(`missing required evidence: ${missingEvidence.join(", ")}`);
  }

  return {
    ...verification,
    approved: false,
    rejectCategory: matchedRejectOn !== null ? "reject-on-matched" : "missing-required-evidence",
    safeToRetry: false,
    evidence: [...verification.evidence, ...enforcementNotes],
  };
}

async function runVerification(
  contract: LoopContract,
  adapter: RuntimeAdapter,
  context: AttemptContext,
  plan: AttemptPlan | null,
  execution: ExecutionResult,
): Promise<VerificationResult> {
  const primaryTargetPaths = getVerificationPrimaryTargetPaths(contract, plan, execution);
  const requiredChecks = await runRequiredChecks(
    contract.verification.requiredChecks,
    context.worktreePath,
    primaryTargetPaths,
    context.abortSignal,
  );

  if (!requiredChecks.passed) {
    return requiredChecks.verification;
  }

  if (contract.verification.verifierType === "command") {
    return enforceVerificationContract(contract, {
      approved: true,
      rejectCategory: "",
      primaryTargetPaths,
      failingCommand: null,
      safeToRetry: false,
      evidence: requiredChecks.evidence,
      pauseSignals: [],
      stopSignals: [],
    });
  }

  const verification = await adapter.verify(context);
  return enforceVerificationContract(contract, {
    ...verification,
    evidence: [...requiredChecks.evidence, ...verification.evidence],
  });
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
  plan?: AttemptPlan | null,
  execution?: ExecutionResult | null,
): AttemptContext {
  return {
    contract,
    state,
    runDir,
    attempt,
    worktreePath,
    abortSignal,
    ...(plan === undefined || plan === null ? {} : { plan }),
    ...(execution === undefined || execution === null ? {} : { execution }),
  };
}

async function appendTransitionEvent(runDir: string, state: RunState, type: string, detail: string): Promise<void> {
  await appendEvent(runDir, { type, at: state.lastTransitionAt, detail });
}

async function cleanupAttemptWorkspaceWithStatus(
  repoPath: string,
  worktreePath: string,
  runDir: string,
  detail: string,
): Promise<ExecutionRecovery["cleanupStatus"]> {
  try {
    await cleanupAttemptWorkspace(repoPath, worktreePath);
    return "removed";
  } catch (error) {
    await appendEvent(runDir, {
      type: "workspace_cleanup_failed",
      at: new Date().toISOString(),
      detail: `${detail}: ${String(error)}`,
    });
    return "retained";
  }
}

async function cleanupAttemptWorkspaceBestEffort(
  repoPath: string,
  worktreePath: string,
  runDir: string,
  detail: string,
): Promise<void> {
  await cleanupAttemptWorkspaceWithStatus(repoPath, worktreePath, runDir, detail);
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
  options?: { awaitAbortedResult?: boolean },
): Promise<PhaseOutcome<T>> {
  const startedAtMs = Date.now();

  if (timeoutMs <= 0) {
    return { timedOut: true, elapsedMs: 0 };
  }

  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = operation(abortController.signal).catch((error: unknown) => {
    throw new PhaseExecutionError(Math.max(Date.now() - startedAtMs, 0), error);
  });

  try {
    const outcome = await Promise.race([
      operationPromise.then((result) => ({ kind: "result" as const, result })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => {
          abortController.abort();
          resolve({ kind: "timeout" });
        }, timeoutMs);
      }),
    ]);
    const elapsedMs = Math.max(Date.now() - startedAtMs, 0);

    if (outcome.kind === "timeout") {
      if (!options?.awaitAbortedResult) {
        void operationPromise.catch(() => undefined);
        return { timedOut: true, elapsedMs };
      }

      try {
        const result = await operationPromise;
        const timedOutElapsedMs = Math.max(Date.now() - startedAtMs, 0);
        return { timedOut: true, elapsedMs: timedOutElapsedMs, result };
      } catch (error) {
        const timedOutElapsedMs = Math.max(Date.now() - startedAtMs, 0);
        return { timedOut: true, elapsedMs: timedOutElapsedMs, abortedError: error };
      }
    }

    return { timedOut: false, elapsedMs, result: outcome.result };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function parseChangedPathsFromGitStatus(statusOutput: string): string[] {
  const entries = statusOutput.split("\0");
  const paths = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === "") {
      continue;
    }

    const status = entry.slice(0, 2);
    const path = entry.slice(3);

    if (path !== "") {
      paths.add(path);
    }

    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }

  return [...paths];
}

async function observeChangedPathsBestEffort(worktreePath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseChangedPathsFromGitStatus(stdout);
  } catch {
    return null;
  }
}

function getExecutionFailureBoundary(state: RunState): ExecutionRecovery["failureBoundary"] {
  if (state.budgetSnapshot.tokenBudgetRemaining === 0) {
    return "token_exhausted";
  }

  if (state.budgetSnapshot.timeRemainingMs === 0) {
    return "runtime_exhausted";
  }

  return "timeout";
}

function buildExecutionRecovery(
  execution: ExecutionResult | null,
  changedPathsObserved: string[] | null,
  failureBoundary: ExecutionRecovery["failureBoundary"],
  cleanupStatus: ExecutionRecovery["cleanupStatus"],
): ExecutionRecovery {
  return {
    executeEntered: true,
    worktreeDiffObserved:
      execution === null ? (changedPathsObserved === null ? "unknown" : changedPathsObserved.length > 0) : execution.changedFiles.length > 0,
    diffPatchCaptured: execution?.diffPatch !== undefined,
    stdoutStderrLogCaptured: execution?.stdoutStderrLog !== undefined,
    changedPathsObserved,
    captureStatus: execution === null ? (changedPathsObserved === null ? "failed" : "partial") : "complete",
    cleanupStatus,
    failureBoundary,
  };
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

async function persistBoundaryAnalysis(runDir: string, state: RunState): Promise<void> {
  const boundaryAnalysis = evaluateRunBoundary({
    now: new Date().toISOString(),
    previous: null,
    runState: state,
    observedStrongProgress: false,
    observedWeakProgress: false,
    continuitySuspicion: ["execution continuity not trustworthy"],
  });

  if (boundaryAnalysis.status === "healthy") {
    return;
  }

  await writeBoundaryArtifacts(runDir, {
    boundaryAnalysis,
    reconciliationRecord:
      boundaryAnalysis.status === "stale_candidate"
        ? {
            staleSuspicionBasis: [boundaryAnalysis.staleCandidateReason ?? "unknown stale suspicion"],
            staleConfirmed: true,
            lastTrustedBoundary: "execute",
            conflictingEvidence: [],
            takeoverPermission: {
              allowed: false,
              reason: "deny-by-default until stronger mechanical takeover conditions exist",
            },
          }
        : undefined,
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
      await appendTransitionEvent(runDir, state, "execute_started", `attempt ${attempt}`);

      const executeTimeoutMs = getPhaseTimeoutMs(contract, state);
      const executeOutcome = await runPhaseWithTimeout(
        executeTimeoutMs,
        (abortSignal) => adapter.execute(buildAttemptContext(contract, state, runDir, attempt, worktreePath, abortSignal, plan)),
        { awaitAbortedResult: true },
      );

      let executeUsageAlreadyApplied = false;

      if (executeOutcome.timedOut) {
        state = applyPhaseUsage(state, executeOutcome.elapsedMs, executeOutcome.result?.tokenUsage);
        executeUsageAlreadyApplied = true;
        execution = executeOutcome.result ?? null;

        if (execution === null) {
          const changedPathsObserved = await observeChangedPathsBestEffort(worktreePath);
          const executionRecovery = buildExecutionRecovery(
            null,
            changedPathsObserved,
            getExecutionFailureBoundary(state),
            "retained",
          );
          await writeAttemptArtifacts(runDir, attempt, {
            plan,
            executionRecovery,
          });
          await persistBoundaryAnalysis(runDir, state);
          state = await persistTerminalState(
            runDir,
            state,
            "exhausted",
            hasBudgetExceeded(state) ? BUDGET_EXHAUSTED_REASON : getPhaseTimeoutReason("execute", executeTimeoutMs),
          );
          const cleanupStatus = await cleanupAttemptWorkspaceWithStatus(
            contract.context.repoPath,
            worktreePath,
            runDir,
            "cleanup after terminal decision exhausted",
          );

          if (cleanupStatus !== executionRecovery.cleanupStatus) {
            await writeAttemptArtifacts(runDir, attempt, {
              plan,
              executionRecovery: {
                ...executionRecovery,
                cleanupStatus,
              },
            });
          }

          return state;
        }
      } else {
        execution = executeOutcome.result;
      }

      if (execution === null) {
        await persistBoundaryAnalysis(runDir, state);
        throw new Error("execute phase completed without a result");
      }

      const completedExecution = execution;

      if (!executeUsageAlreadyApplied) {
        state = applyPhaseUsage(state, executeOutcome.elapsedMs, completedExecution.tokenUsage);
      }

      if (isPartialExecutionResult(completedExecution)) {
        await writeCompletedAttemptArtifacts(runDir, attempt, plan, completedExecution);

        const partialPathPolicy = evaluatePathPolicy({
          changedFiles: completedExecution.changedFiles,
          allowlistPaths: contract.safetyPolicy.allowlistPaths,
          denylistPaths: contract.safetyPolicy.denylistPaths,
          maxFilesTouched: contract.safetyPolicy.maxFilesTouched,
        });

        if (partialPathPolicy.humanGateHit) {
          state = await persistTerminalState(
            runDir,
            state,
            "blocked_waiting_human",
            partialPathPolicy.reason ?? completedExecution.failureMessage,
          );
          return state;
        }

        state = await persistTerminalState(
          runDir,
          state,
          completedExecution.failureType === "timeout" ? "exhausted" : "failed",
          completedExecution.failureMessage,
        );

        await cleanupAttemptWorkspaceBestEffort(
          contract.context.repoPath,
          worktreePath,
          runDir,
          `cleanup after partial execute ${completedExecution.failureType}`,
        );
        return state;
      }

      const pathPolicy = evaluatePathPolicy({
        changedFiles: completedExecution.changedFiles,
        allowlistPaths: contract.safetyPolicy.allowlistPaths,
        denylistPaths: contract.safetyPolicy.denylistPaths,
        maxFilesTouched: contract.safetyPolicy.maxFilesTouched,
      });

      if (pathPolicy.humanGateHit) {
        await writeCompletedAttemptArtifacts(runDir, attempt, plan, completedExecution);
        state = await persistTerminalState(
          runDir,
          state,
          "blocked_waiting_human",
          pathPolicy.reason ?? "human gate or denylist hit",
        );
        return state;
      }

      if (hasBudgetExceeded(state)) {
        await writeCompletedAttemptArtifacts(runDir, attempt, plan, completedExecution);
        state = await persistTerminalState(runDir, state, "exhausted", BUDGET_EXHAUSTED_REASON);
        await cleanupAttemptWorkspaceBestEffort(
          contract.context.repoPath,
          worktreePath,
          runDir,
          "cleanup after terminal decision exhausted",
        );
        return state;
      }

      state = transitionRunState(state, "verifying");
      await appendTransitionEvent(runDir, state, "execution_finished", `attempt ${attempt}`);
      await writeRunState(runDir, state);

      const verifyTimeoutMs = getPhaseTimeoutMs(contract, state);
      const verifyOutcome = await runPhaseWithTimeout(verifyTimeoutMs, (abortSignal) =>
        runVerification(
          contract,
          adapter,
          buildAttemptContext(contract, state, runDir, attempt, worktreePath, abortSignal, plan, completedExecution),
          plan,
          completedExecution,
        ),
      );

      if (verifyOutcome.timedOut) {
        state = applyPhaseUsage(state, verifyOutcome.elapsedMs, undefined);
        await writeCompletedAttemptArtifacts(runDir, attempt, plan, completedExecution);
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

        if (execution !== null && isPartialExecutionResult(execution)) {
          await writeCompletedAttemptArtifacts(runDir, attempt, plan, execution);
          const partialPathPolicy = evaluatePathPolicy({
            changedFiles: execution.changedFiles,
            allowlistPaths: contract.safetyPolicy.allowlistPaths,
            denylistPaths: contract.safetyPolicy.denylistPaths,
            maxFilesTouched: contract.safetyPolicy.maxFilesTouched,
          });

          if (partialPathPolicy.humanGateHit) {
            state = await persistTerminalState(
              runDir,
              state,
              "blocked_waiting_human",
              partialPathPolicy.reason ?? execution.failureMessage,
            );
            return state;
          }
        }
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
