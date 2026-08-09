import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendEvent,
  initializeRunFiles,
  OwnerTransferLockBusyError,
  OwnerTransferPreconditionError,
  readOwnerRecord,
  readOwnerRecordWithoutRecovery,
  writeAttemptArtifacts,
  writeBoundaryArtifacts,
  writeOwnerRecord,
  writeOwnerTransferArtifacts,
  writeRunState,
} from "../persistence/fileStore.js";
import { evaluatePathPolicy } from "../policy/pathPolicy.js";
import { evaluateRunBoundary, evaluateStopDecision } from "../stop/stopController.js";
import { isTerminalRunStatus, transitionRunState } from "../state/stateMachine.js";
import type { LoopContract } from "../contract/schema.js";
import { applyOwnerEpochTransfer, evaluateOwnership } from "../ownership/ownerController.js";
import { checkRunLease } from "./leaseGate.js";
import { startLeaseHeartbeat } from "./leaseHeartbeat.js";
import type { LeaseHeartbeat } from "./leaseHeartbeat.js";
import {
  parseOwnerRecordForLease,
  RunHeartbeatStoppedError,
  RunLeaseLostError,
  RunLeaseUnverifiableError,
} from "../ownership/lease.js";
import type {
  AttemptContext,
  AttemptPlan,
  ExecutionRecovery,
  ExecutionResult,
  OwnerRecord,
  ReconciliationDraft,
  ReconciliationRecord,
  RuntimeAdapter,
  VerificationResult,
} from "../runtime/types.js";
import { isPartialExecutionResult } from "../runtime/types.js";
import { buildProcessInstanceId } from "../runtime/processIdentity.js";
import type { FailureFingerprint, LastTrustedBoundary, RunState, StopDecision } from "../state/types.js";
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

// §5.2 of the contention design: a busy owner-transfer lock is a transient condition (a
// contender's critical section is a handful of file writes), so it gets a short bounded retry.
// 3 attempts with the backoff preceding attempts 2 and 3 only, so 2 * 50ms = 100ms of waiting at
// worst — far below LEASE_TTL_MS (90_000ms, lease.ts, ~0.11% of it). This window
// runs inside the exclusive span added in a later task, holding off this process's own
// heartbeat affirms for its duration, so it must stay small. A CAS mismatch (a stale read, not a
// busy lock) is never retried here: see the instanceof check in the loop below.
export const OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS = 3;
export const OWNER_TRANSFER_LOCK_RETRY_DELAY_MS = 50;

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

// §8.1: the two ways heartbeat.assertHeld() can refuse a side effect. Both abandon the
// attempt in place; they differ only in the stop reason they carry, because "someone else
// owns this run" and "this run's ownership could not be read" are not the same claim.
function isLeaseStopError(error: unknown): error is RunLeaseLostError | RunLeaseUnverifiableError {
  return error instanceof RunLeaseLostError || error instanceof RunLeaseUnverifiableError;
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

export async function cleanupAttemptWorkspaceBestEffort(
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
      // A phase that reached its timeout consumed at least the window it was granted, so that
      // window — not the measured elapsed — is the floor on what it is charged. getPhaseTimeoutMs
      // derives timeoutMs from min(perAttemptTimeoutMs, timeRemainingMs), so when the budget is
      // the smaller operand this keeps hasBudgetExceeded's `timeRemainingMs === 0` a consequence
      // of the timeout firing rather than of two clock reads happening to span the full window.
      // When perAttemptTimeoutMs is STRICTLY the smaller operand the floor sits below the
      // remaining budget and nothing is forced to exhaust. When the two are EQUAL the floor
      // equals the remaining budget and exhaustion is forced — which is the right answer (a
      // phase granted exactly the rest of the budget, that then timed out, has spent it), but
      // it is forced, so do not read the previous sentence as covering that case. A minority of
      // this file's integration suite is configured that way — ten of its 49 tests set
      // perAttemptTimeoutMs equal to totalRuntimeBudgetMs, measured 2026-08-01. That ratio rots
      // whenever a test is added; re-derive it rather than quoting it:
      //   grep -c "perAttemptTimeoutMs: 20,$" tests/controller/runLoop.integration.test.ts
      // counts 13, of which the three that leave totalRuntimeBudgetMs at its 5000ms default are
      // NOT the equal case.
      //
      // One contract-visible consequence, on the execute phase only: getExecutionFailureBoundary
      // branches on timeRemainingMs === 0, so a budget-capped execute timeout that recovers no
      // result now persists failureBoundary "runtime_exhausted" where a clock read that fell
      // short would have persisted "timeout". The new value is the accurate one.
      //
      // timeoutMs > 0 here (the <= 0 case returned above), so this floor also subsumes the
      // non-negative clamp it replaces.
      if (!options?.awaitAbortedResult) {
        void operationPromise.catch(() => undefined);
        return { timedOut: true, elapsedMs: Math.max(elapsedMs, timeoutMs) };
      }

      try {
        const result = await operationPromise;
        const timedOutElapsedMs = Math.max(Date.now() - startedAtMs, timeoutMs);
        return { timedOut: true, elapsedMs: timedOutElapsedMs, result };
      } catch (error) {
        const timedOutElapsedMs = Math.max(Date.now() - startedAtMs, timeoutMs);
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

type BoundaryEvidence = {
  continuitySuspicion: string[];
  conflictingEvidence: string[];
  currentProcessStillTrusted: boolean;
  supportingContinuityEvidence: string[];
  lastTrustedBoundary: LastTrustedBoundary;
  continuityObservationComplete: boolean;
};

function buildBoundaryEvidence(executionRecovery: ExecutionRecovery | null): BoundaryEvidence {
  if (executionRecovery === null) {
    return {
      // GATE-A fix wave 2: this empty list — not any literal at the evaluateRunBoundary call site —
      // is what keeps runLoopFromState's non-timeout `execution === null` branch off
      // `stale_candidate`, and that is the whole proof behind the "provably dead" note on the
      // `onReconciliationWriteAbandoned` argument forwarded from there. Making it non-empty
      // re-activates that argument without touching the warned line — read that comment first.
      continuitySuspicion: [],
      conflictingEvidence: [],
      currentProcessStillTrusted: false,
      supportingContinuityEvidence: [],
      lastTrustedBoundary: "execute",
      continuityObservationComplete: false,
    };
  }

  if (executionRecovery.changedPathsObserved !== null && executionRecovery.changedPathsObserved.length > 0) {
    const changedPathsSummary = executionRecovery.changedPathsObserved.join(", ");
    const changedPathsEvidence = `changed paths observed after interrupted execute: ${changedPathsSummary}`;
    return {
      continuitySuspicion: [`interrupted execute left changed paths in the attempt worktree: ${changedPathsSummary}`],
      conflictingEvidence: [
        changedPathsEvidence,
        `execution recovery captured ${executionRecovery.failureBoundary}`,
      ],
      currentProcessStillTrusted: false,
      supportingContinuityEvidence: [changedPathsEvidence],
      lastTrustedBoundary: "execute",
      continuityObservationComplete: true,
    };
  }

  if (executionRecovery.worktreeDiffObserved === true) {
    const worktreeDiffEvidence = "worktree differences observed after interrupted execute";
    return {
      continuitySuspicion: ["interrupted execute left worktree differences in the attempt worktree"],
      conflictingEvidence: [
        worktreeDiffEvidence,
        `execution recovery captured ${executionRecovery.failureBoundary}`,
      ],
      currentProcessStillTrusted: false,
      supportingContinuityEvidence: [worktreeDiffEvidence],
      lastTrustedBoundary: "execute",
      continuityObservationComplete: true,
    };
  }

  if (executionRecovery.changedPathsObserved === null) {
    return {
      continuitySuspicion: ["interrupted execute could not be mechanically reconciled because changed-path observation failed"],
      conflictingEvidence: ["changed-path observation failed after interrupted execute"],
      currentProcessStillTrusted: false,
      supportingContinuityEvidence: [],
      lastTrustedBoundary: "unknown",
      continuityObservationComplete: false,
    };
  }

  return {
    continuitySuspicion: ["interrupted execute exhausted without changed paths or continuity evidence"],
    conflictingEvidence: [],
    currentProcessStillTrusted: false,
    supportingContinuityEvidence: [],
    lastTrustedBoundary: "execute",
    continuityObservationComplete: true,
  };
}

function derivePersistedOwnerStillSupported(ownerRecord: OwnerRecord): boolean {
  return ownerRecord.ownerStatus === "current" && ownerRecord.supersededByEpoch === null;
}

function buildInitialOwnerRecord(contract: LoopContract, state: RunState): OwnerRecord {
  return {
    runId: contract.objective.taskId,
    logicalSessionId: `${contract.objective.taskId}:${state.lastTransitionAt}`,
    currentOwnerEpoch: 1,
    currentProcessInstanceId: buildProcessInstanceId(),
    lastAffirmedAt: state.lastTransitionAt,
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
  };
}

function buildTakeoverReason(allowed: boolean): string {
  return allowed
    ? "strict owner-loss conditions satisfied; continuation still requires a later transfer step"
    : "deny-by-default until strict owner-loss and transfer conditions are fully met";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function persistOwnerTransfer(
  runDir: string,
  expectedOwnerRecord: OwnerRecord,
  nextProcessInstanceId: string,
  at: string,
  reason: string,
  reconciliationDraft: ReconciliationDraft,
): Promise<{ ownerRecord: OwnerRecord; eligibleForContinuation: true }> {
  const transfer = applyOwnerEpochTransfer(expectedOwnerRecord, nextProcessInstanceId, at, reason);
  // §4.3: the ONLY place the draft's missing field gets filled in, and only from
  // applyOwnerEpochTransfer's own output above — never a second, independently-computed `+ 1`.
  const reconciliationRecord: ReconciliationRecord = {
    ...reconciliationDraft,
    newOwnerEpoch: transfer.transferRecord.newOwnerEpoch,
  };

  // Bounded retry, lock-busy only. A CAS mismatch (OwnerTransferPreconditionError) is rethrown
  // immediately on the first attempt: retrying it would re-run the CAS against evidence this
  // transfer never evaluated, which is a new ownership decision wearing an old one's
  // justification (§5.2). Only OwnerTransferLockBusyError is retried, and only up to the bound.
  for (let attempt = 0; attempt < OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await delay(OWNER_TRANSFER_LOCK_RETRY_DELAY_MS);
    }

    try {
      await writeOwnerTransferArtifacts(
        runDir,
        expectedOwnerRecord,
        transfer.nextOwnerRecord,
        transfer.transferRecord,
        reconciliationRecord,
      );
      break;
    } catch (error) {
      const isLastAttempt = attempt === OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS - 1;
      if (!(error instanceof OwnerTransferLockBusyError) || isLastAttempt) {
        throw error;
      }
    }
  }

  // appendEvent runs exactly once, reached only after writeOwnerTransferArtifacts above
  // succeeded — never inside the retry loop, so a retry that eventually succeeds cannot emit
  // this event more than once.
  await appendEvent(runDir, {
    type: "owner_epoch_transferred",
    at,
    detail: `owner epoch ${transfer.transferRecord.priorOwnerEpoch} superseded by ${transfer.transferRecord.newOwnerEpoch}`,
  });
  return {
    ownerRecord: transfer.nextOwnerRecord,
    eligibleForContinuation: true,
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

async function persistBoundaryAnalysis(
  runDir: string,
  state: RunState,
  // §6.1: guards the two side effects below — readOwnerRecord's recovery-on-read (via the
  // entry guard immediately below) and the boundary/reconciliation artifact write (via the
  // guard just before it) — in addition to letting a transfer this function performs ITSELF
  // be adopted; see the adopt call further down.
  heartbeat: LeaseHeartbeat,
  executionRecovery?: ExecutionRecovery,
  // A8: pure pass-through to writeBoundaryArtifacts, with no catch of its own — a throw from
  // the callback is a programming error and belongs to whoever supplied it.
  onReconciliationWriteAbandoned?: (detail: string) => void,
): Promise<void> {
  // Task 5 / §5.4 / §12 requirement 6: precedes EVERYTHING, including readOwnerRecord just
  // below (inside the exclusive span), because readOwnerRecord runs
  // recoverInterruptedOwnerTransfer (fileStore.ts) — a write that finalizes any interrupted
  // owner transfer it finds staged. A superseded process must not perform that recovery on a
  // run it no longer owns. Placed before the healthy early return just below on purpose:
  // moving it after would look like a free optimization but would let a superseded process
  // evaluate a boundary and return normally, as though it still held the lease.
  await heartbeat.assertHeld();
  const boundaryEvidence = buildBoundaryEvidence(executionRecovery ?? null);
  const boundaryAnalysis = evaluateRunBoundary({
    now: new Date().toISOString(),
    previous: null,
    runState: state,
    observedStrongProgress: false,
    observedWeakProgress: boundaryEvidence.conflictingEvidence.length > 0,
    continuitySuspicion: boundaryEvidence.continuitySuspicion,
  });

  if (boundaryAnalysis.status === "healthy") {
    return;
  }

  const evaluateOwnershipFor = (persistedOwnerRecord: OwnerRecord) => {
    const persistedOwnerStillSupported = derivePersistedOwnerStillSupported(persistedOwnerRecord);
    const supportingContinuityEvidence =
      persistedOwnerStillSupported && boundaryEvidence.continuityObservationComplete
        ? []
        : boundaryEvidence.supportingContinuityEvidence;

    return evaluateOwnership({
      ownerRecord: persistedOwnerRecord,
      persistedOwnerStillSupported,
      boundaryAnalysis,
      currentProcessStillTrusted: boundaryEvidence.currentProcessStillTrusted,
      supportingContinuityEvidence,
      knownSupersedingEpoch: null,
      lastTrustedBoundary: boundaryEvidence.lastTrustedBoundary,
      // §9.1: no production supplier in L1 — deliberately. L3 is where the first real
      // measured value appears.
      leaseFresh: "unknown",
    });
  };

  // Task 4 / owner-transfer-contention design §4: the whole read → evaluate → CAS transfer →
  // adopt span runs inside the heartbeat's own serialization queue, so no affirm (whether the
  // interval timer's or a directly-invoked one) can land between the read and the CAS — the
  // race defect 2 exploited — or between the CAS and `adopt()` — the residual L1's review
  // parked. `writeBoundaryArtifacts` below stays OUTSIDE: there is no reason to make the
  // heartbeat wait behind artifact writes.
  const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(
    async () => {
      let ownerRecord = await readOwnerRecord(runDir);
      let ownership = evaluateOwnershipFor(ownerRecord);
      let nextOwnerRecord: OwnerRecord | null = null;
      let nextOwnerEpoch: number | null = null;
      let eligibleForContinuation = false;

      if (boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST" && ownership.takeoverAllowed) {
        try {
          // §4.3: the eight fields the draft CAN supply, assembled before the CAS so
          // persistOwnerTransfer can publish reconciliation-record.json inside the same
          // transaction as the transfer itself — see its own `+ newOwnerEpoch` fill-in.
          // `eligibleForContinuation: true` is not a placeholder: persistOwnerTransfer only
          // ever returns normally (never partially) and always with `eligibleForContinuation:
          // true` baked into its own return type, so a draft reaching persistOwnerTransfer is
          // published if and only if this value would already have been true.
          const reconciliationDraft: ReconciliationDraft = {
            staleSuspicionBasis:
              boundaryEvidence.continuitySuspicion.length > 0
                ? boundaryEvidence.continuitySuspicion
                : [boundaryAnalysis.staleCandidateReason ?? "unknown stale suspicion"],
            staleConfirmed: true,
            ownershipVerdict: ownership.verdict,
            lastTrustedBoundary: ownership.lastTrustedBoundary,
            conflictingEvidence: boundaryEvidence.conflictingEvidence,
            takeoverPermission: {
              allowed: ownership.takeoverAllowed,
              reason: buildTakeoverReason(ownership.takeoverAllowed),
            },
            priorOwnerEpoch: ownerRecord.currentOwnerEpoch,
            eligibleForContinuation: true,
          };
          const transfer = await persistOwnerTransfer(
            runDir,
            ownerRecord,
            buildProcessInstanceId(),
            new Date().toISOString(),
            "owner lost after reconciliation",
            reconciliationDraft,
          );
          // §6.1: this process just rotated the epoch TO ITSELF, so the record the heartbeat is
          // comparing against is stale exactly as it is after an affirm — and a stale expectation
          // here reads as a takeover by this same process (identical expected and observed
          // instance IDs) and refuses every side effect that follows, including the post-terminal
          // worktree cleanup. Adopting removes only that spurious refusal: this process
          // demonstrably still holds the record, because the CAS above only succeeded against the
          // record it expected. A genuine foreign transfer fails that CAS instead, and never
          // reaches this line.
          heartbeat.adopt(transfer.ownerRecord);
          nextOwnerRecord = transfer.ownerRecord;
          nextOwnerEpoch = transfer.ownerRecord.currentOwnerEpoch;
          eligibleForContinuation = transfer.eligibleForContinuation;
        } catch (error) {
          if (error instanceof OwnerTransferLockBusyError) {
            // persistOwnerTransfer already retried the lock a bounded number of times (Task 2)
            // before giving up and reaching here. A busy lock this persistent abandons the transfer
            // exactly like a CAS mismatch does below, plus the evidence: the event stream — not the
            // reconciliation record (§5.3) — records why newOwnerEpoch stays null.
            await appendEvent(runDir, {
              type: "owner_transfer_contended",
              at: new Date().toISOString(),
              detail: "owner transfer abandoned: owner-transfer lock busy",
            });
          } else if (!(error instanceof OwnerTransferPreconditionError)) {
            throw error;
          }

          // Final review / §5.4, per human ruling: the entry guard's own justification applies
          // to THIS read more strongly than to the first one. `readOwnerRecord` runs
          // recoverInterruptedOwnerTransfer, which WRITES — and reaching this line means the
          // transfer just failed its CAS or found the lock busy for the whole retry window,
          // i.e. the strongest available evidence that a rival now owns the run, up to
          // OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS * OWNER_TRANSFER_LOCK_RETRY_DELAY_MS of backoff
          // after the entry guard passed. A superseded process must not perform crash recovery
          // on a run it no longer owns; that is the same rule, at a later instant.
          //
          // This does NOT guard the transfer CAS itself — that keeps relying on its CAS alone,
          // which is what §5.4's "no third guard" was about.
          await heartbeat.assertHeld();
          ownerRecord = await readOwnerRecord(runDir);
          ownership = evaluateOwnershipFor(ownerRecord);
        }
      }

      return { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation };
    },
  );

  // Task 5 / §5.4 / §12 requirement 7: closes the drift window between the entry guard above
  // and this write — a window that contains a potentially complete epoch transfer. Inlined
  // rather than routed through runLoopFromState's `guardedWriteArtifacts` closure: that
  // wrapper is defined inside runLoopFromState and is not reachable from this module-level
  // function, which receives only `heartbeat` as a parameter. Matches how L1's other
  // `assertHeld` call sites are written.
  //
  // Unconditional, per human ruling: this layer's thesis is "only ever refuse, never grant."
  // A process that no longer holds the run must not write into it, including the case where
  // its own transfer attempt failed and it would otherwise fall back to writing a view of
  // someone else's already-completed reconciliation — that synthesis, if still wanted, is a
  // later layer's problem, not this one's. Accepted cost: a process whose own transfer failed
  // because another controller had already completed an equivalent one used to still write a
  // preserved/synthesized view of the winner (runLoop.integration.test.ts's two "preserves ...
  // winner reconciliation view" tests, re-expressed for this task to assert the refusal
  // instead).
  await heartbeat.assertHeld();

  // nextOwnerEpoch is non-null if and only if the transfer branch above ran persistOwnerTransfer
  // to completion (the try block's success path, never the catch): that call already published
  // reconciliation-record.json transactionally, with `newOwnerEpoch` filled in from
  // applyOwnerEpochTransfer's own output — a second write of the same record here would be
  // exactly the "winner writes it twice" this task removes. The loser / no-transfer-attempted
  // cases (nextOwnerEpoch still null) are unchanged: this call site remains their only writer.
  if (nextOwnerEpoch !== null) {
    // Forwarded even though this branch passes no reconciliationRecord and therefore cannot
    // reach the abandon branch today: the alternative is a call site that silently stops
    // routing the moment someone gives this branch a record.
    await writeBoundaryArtifacts(runDir, { boundaryAnalysis }, { onReconciliationWriteAbandoned });
  } else {
    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis,
      reconciliationRecord:
        boundaryAnalysis.status === "stale_candidate"
          ? {
              staleSuspicionBasis:
                boundaryEvidence.continuitySuspicion.length > 0
                  ? boundaryEvidence.continuitySuspicion
                  : [boundaryAnalysis.staleCandidateReason ?? "unknown stale suspicion"],
              staleConfirmed: true,
              ownershipVerdict: ownership.verdict,
              lastTrustedBoundary: ownership.lastTrustedBoundary,
              conflictingEvidence: boundaryEvidence.conflictingEvidence,
              takeoverPermission: {
                allowed: ownership.takeoverAllowed,
                reason: buildTakeoverReason(ownership.takeoverAllowed),
              },
              priorOwnerEpoch: ownerRecord.currentOwnerEpoch,
              newOwnerEpoch: nextOwnerEpoch,
              eligibleForContinuation,
            }
          : undefined,
    }, { onReconciliationWriteAbandoned });
  }
}

// Package 2 / debt 2. Answers ONE question: does owner-record.json on disk name a process other
// than this one? That is deliberately NOT checkRunLease's question and this must not be rewritten
// to call it. The gate asks "is a LIVE lease held by someone else", because taking over a run
// whose lease has lapsed is legitimate; this asks "am I the owner", and a lapsed lease does not
// promote a non-owner into one. Ownership changes hands only through the epoch transfer, so a
// record naming someone else refuses here whether their lease is fresh, stale, or absent.
//
// Reads RAW, for leaseGate's §7.1 reason: readOwnerRecord runs recoverInterruptedOwnerTransfer
// first, and a refusal to write must not trigger crash recovery as its side effect.
//
// The four answers are kept DISTINCT rather than collapsed to a boolean, because "no record" and
// "a record I could not read" are not the same fact and must not be handled the same way. An
// earlier version of this guard collapsed them and thereby failed open in silence (review finding
// F-3); the caller below now reports the unreadable case.
type OwnershipObservation =
  | { kind: "unowned" }
  | { kind: "self" }
  | { kind: "unverified"; detail: string }
  | { kind: "foreign"; ownerProcessInstanceId: string };

async function observeOwnership(runDir: string): Promise<OwnershipObservation> {
  let raw: unknown;

  try {
    raw = await readOwnerRecordWithoutRecovery(runDir);
  } catch (error) {
    // ONLY ENOENT means "no record at all", i.e. nobody to protect. leaseGate draws the same line
    // for the same reason, and it is the ordinary observation for a run driven through
    // runLoopFromState directly.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "unowned" };
    }

    return { kind: "unverified", detail: String(error) };
  }

  try {
    const ownerProcessInstanceId = parseOwnerRecordForLease(raw).currentProcessInstanceId;

    // §5.1: opaque, compared only for string equality — the same comparison the gate makes, so a
    // legacy or recycled id can only add refusals here.
    return ownerProcessInstanceId === buildProcessInstanceId()
      ? { kind: "self" }
      : { kind: "foreign", ownerProcessInstanceId };
  } catch (error) {
    return { kind: "unverified", detail: String(error) };
  }
}

// Package 2 / debt 2, review round 1. THE chokepoint: every loop-state.json write performed by
// runLoopFromState and by persistTerminalState goes through here, and `writeRunState` is called
// from exactly one place in this module — the line below.
//
// That structure is the point, and it is a correction of how the first version of this guard
// argued for its own completeness. That version sat inside persistTerminalState and justified its
// coverage with the claim "persistTerminalState is the only writer of a terminal loop-state.json".
// The claim was FALSE (review finding F-1): the outer catch's failure branches transition to
// "failed" — which is terminal, `failed: []` in legalTransitions — and call writeRunState
// directly, so a terminal status still reached a run this process did not own. The completeness
// argument is therefore no longer "I audited the call sites and they are covered"; it is "this
// module cannot write a run state except through this function", which is a property a reader can
// check with one grep instead of an audit that already went wrong once.
//
// Refusing NON-terminal writes too (review finding F-2) is deliberate and is what makes the rule
// one rule. The invariant is "do not modify a run you do not own"; terminal vs non-terminal
// describes how bad the damage is, not whether this process is allowed to do it.
//
// Reporting is latched per writer instance — one event of each kind per runLoopFromState
// invocation. Without a bound, a loop refused at every phase boundary would append an unbounded
// number of identical lines to a run owned by someone else; with no event at all it would be the
// silent failure writeBoundaryArtifacts warns about (fileStore.ts). One line is the smallest
// record that is still a record.
type OwnedRunStateWriter = (runDir: string, state: RunState) => Promise<boolean>;

function createOwnedRunStateWriter(): OwnedRunStateWriter {
  const reported = new Set<string>();

  const reportOnce = async (runDir: string, type: string, detail: string): Promise<void> => {
    if (reported.has(type)) {
      return;
    }

    reported.add(type);
    await appendEvent(runDir, { type, at: new Date().toISOString(), detail });
  };

  return async (runDir, state) => {
    const ownership = await observeOwnership(runDir);

    if (ownership.kind === "foreign") {
      // Two event types rather than one, and NOT merely for readability: `terminal_write_abandoned`
      // is the refusal that prevents an unresumable run (the debt itself), while the non-terminal
      // one prevents a lesser mutation. Latching them separately also keeps the terminal refusal
      // observable even when a non-terminal write was refused earlier in the same invocation.
      await reportOnce(
        runDir,
        isTerminalRunStatus(state.status) ? "terminal_write_abandoned" : "run_state_write_abandoned",
        `refused to write run status ${state.status} into a run owned by `
          + `${ownership.ownerProcessInstanceId}, not by ${buildProcessInstanceId()}`,
      );
      return false;
    }

    if (ownership.kind === "unverified") {
      // F-3/F-4: this proceeds — a guard that cannot read the record must not turn a stop into a
      // crash, and an unreadable record has identified nobody, least of all a DIFFERENT owner. But
      // proceeding UNRECORDED is the silent failure this repository already has a stated position
      // against, so the fail-open is written down where an operator can find it. The earlier
      // version justified the silence by saying leaseHeartbeat answers this case with
      // lease_unverifiable; that reason is withdrawn (F-4) — it holds only when a real heartbeat is
      // running, and runLoopFromState's default is INERT_LEASE_HEARTBEAT.
      await reportOnce(
        runDir,
        "ownership_unverified",
        `proceeding with a run-state write for ${buildProcessInstanceId()}: `
          + `owner record present but unreadable: ${ownership.detail}`,
      );
    }

    // The ONLY writeRunState call in this module. Everything else routes here.
    await writeRunState(runDir, state);
    return true;
  };
}

// Package 2 / debt 2: this used to be where the ownership guard lived, justified by the claim that
// it was "the only writer of a terminal loop-state.json". That claim was false (review finding
// F-1) and the guard has moved to createOwnedRunStateWriter above — see the erratum there. What
// stays true, and is all this function now claims, is that it is the only writer of a
// `loop_<terminal>` EVENT.
//
// The write goes through the injected writer, which may refuse it. The refusal is deliberately NOT
// propagated to the caller: the returned RunState and the `loop_<terminal>` event are unaffected
// by ownership, because nothing resumes off either (evaluateResumeEligibility does not read the
// event stream and the registry observes three files) while BOTH are load-bearing for reporting
// why THIS process stopped. assertHeld appends no event of its own by design, so this transition
// is the only thing that carries the stop reason out to the caller and into the log; suppressing
// it leaves a run that stopped for a lease reason naming nobody. So this process still reports its
// own stop, and the other owner's run status is left exactly as resumable as it was.
async function persistTerminalState(
  runDir: string,
  writeOwnedRunState: OwnedRunStateWriter,
  state: RunState,
  decision: TerminalDecision,
  reason: string,
): Promise<RunState> {
  const terminalState = transitionRunState(state, decision, reason);
  await appendTransitionEvent(runDir, terminalState, `loop_${decision}`, reason);
  await writeOwnedRunState(runDir, terminalState);
  return terminalState;
}

export async function runLoop(contract: LoopContract, runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
  const state = transitionRunState(initialState(contract), "planning");
  const ownerRecord = buildInitialOwnerRecord(contract, state);
  await initializeRunFiles(runDir, contract, state);
  // §7: as early as possible, but never before initializeRunFiles — the gate may append an
  // event and events.jsonl does not exist yet.
  //
  // §7.0: this comment used to claim ensureFreshRunDir had already thrown on any pre-existing
  // run file, so that "no owner record" was the ONLY observation reachable here. Both halves
  // are false, by reading. ensureFreshRunDir (fileStore.ts, blockingPaths) blocks a
  // pre-existing loop-contract.json, loop-state.json or events.jsonl, plus a non-empty
  // attempts/ or worktrees/ — owner-record.json is not on that list. And checkRunLease returns
  // rather than refuses for a record carrying no lease (leaseGate.ts §5.0) and for an expired
  // one (§7). It still REFUSES on three paths, so do not read the above as "anything passes
  // through": a non-ENOENT read failure rethrows, a structurally invalid record throws out of
  // parseOwnerRecordForLease (ownership/lease.ts), and a fresh lease naming another process
  // throws RunLeaseHeldError. leaseGate.ts and lease.ts both say so at their own call sites.
  //
  // So "no owner record" is the ordinary observation here and not the only reachable one, and
  // the writeOwnerRecord below is not guaranteed to be a creation. Reaching that overwrite does
  // require out-of-band tampering rather than any path this codebase takes: initializeRunFiles
  // writes loop-contract.json and never owner-record.json, and owner-record.json is first
  // written below this gate, so a directory this code produced always trips ensureFreshRunDir
  // first. It is constructible by deleting the blocking files while keeping owner-record.json.
  //
  // The code is unchanged: the gate taking no position on those two states is leaseGate's
  // stated design, not an oversight. Only the claim about what can be observed was wrong.
  await checkRunLease(runDir, ownerRecord.currentProcessInstanceId, Date.now());
  await writeOwnerRecord(runDir, ownerRecord);
  await appendTransitionEvent(runDir, state, "loop_planning", "run initialized and ready to plan");

  // §6.0: started only now — after the gate admitted this process AND the record naming it
  // is on disk — so it can never affirm a lease this process does not hold.
  const leaseLoss = createLeaseLossSignal();
  const heartbeat = startLeaseHeartbeat({
    runDir,
    ownerRecord,
    onLeaseLost: (error) => {
      leaseLoss.lost = error as RunLeaseLostError;
    },
  });

  try {
    return await runLoopFromState(contract, runDir, adapter, state, heartbeat, leaseLoss);
  } finally {
    // §6.0: every exit path — normal completion, stop-boundary exit, and any throw.
    await heartbeat.stop();
  }
}

// Task 3: exported so tests can pin `runExclusive` directly. A no-op here would silently
// delete every owner transfer performed without a live heartbeat (this is the default
// heartbeat for runLoopFromState, below) — it must execute `fn` and return its result.
export const INERT_LEASE_HEARTBEAT: LeaseHeartbeat = {
  adopt: () => {},
  affirmNow: async () => {},
  assertHeld: async () => {},
  runExclusive: (fn) => fn(),
  stop: async () => {},
};

// §8: the caller-owned slot a lost-lease notification lands in. runLoopFromState checks it
// at phase boundaries rather than being called back into directly, so the check point is
// always a place the loop chose to look, never wherever the heartbeat happens to fire.
export type LeaseLossSignal = { lost: RunLeaseLostError | null };

export function createLeaseLossSignal(): LeaseLossSignal {
  return { lost: null };
}

// Task B2 / L3 §5.4: the caller-owned slot a stop request lands in, shaped exactly like
// LeaseLossSignal above and read at the same phase boundary, for the same reason — the loop
// checks a place it chose to look rather than being called back into wherever a signal handler
// happens to fire. This layer provides the SLOT only: the signal handler that sets it lives in
// cli.ts, not here and not in sweepRuns.ts.
export type StopRequestSignal = { requested: boolean };

export function createStopRequestSignal(): StopRequestSignal {
  return { requested: false };
}

// A8 §4.3/§5.4: the seventh parameter is an OBJECT, not a scalar, so later layers (B2, C1) add
// KEYS here rather than further positional parameters. The parameter count stops growing at
// seven.
export type RunLoopFromStateOptions = {
  onReconciliationWriteAbandoned?: (detail: string) => void;
  stopRequested?: StopRequestSignal;
};

export async function runLoopFromState(
  contract: LoopContract,
  runDir: string,
  adapter: RuntimeAdapter,
  initialLoopState: RunState,
  heartbeat: LeaseHeartbeat = INERT_LEASE_HEARTBEAT,
  leaseLoss: LeaseLossSignal = { lost: null },
  options?: RunLoopFromStateOptions,
): Promise<RunState> {
  let state = initialLoopState;

  // Package 2 / debt 2, review round 1: created per invocation, so the abandonment-event latch is
  // scoped to this run of the loop rather than to the process. Every loop-state.json write below
  // goes through it — see createOwnedRunStateWriter for why the guard lives in the writer rather
  // than at the decision sites.
  const writeOwnedRunState = createOwnedRunStateWriter();

  // §8.1: writing attempt artifacts is a side effect, so every such write inside the attempt
  // body goes through here. Deliberately NOT pushed down into writeCompletedAttemptArtifacts:
  // that function is also called from the failure path, which has already abandoned.
  const guardedWriteArtifacts = async (
    write: () => Promise<void>,
  ): Promise<void> => {
    await heartbeat.assertHeld();
    await write();
  };

  while (true) {
    await writeOwnedRunState(runDir, state);
    // §6: the event-driven refresh. It survives environments where the timer is unreliable
    // and additionally evidences that the loop is making progress rather than merely alive.
    await heartbeat.affirmNow();

    // §8: stop at a phase boundary rather than mid-attempt, so the run never tears down
    // state a new owner might be reading. Launch no further attempt.
    if (leaseLoss.lost !== null) {
      return await persistTerminalState(runDir, writeOwnedRunState, state, "cancelled", "lease_lost");
    }

    // Task B2 / L3 §5.4: the same phase boundary, one checkpoint later. Ordered AFTER the lease
    // check on purpose — a lost lease keeps routing exactly where it always did, so this adds a
    // refusal and changes none.
    //
    // Fitted to this checkpoint ONLY, not to the second `leaseLoss.lost !== null` further down.
    // Two reasons, and the first is why the two would contradict each other: this one sits above
    // `const attempt = state.attemptsUsed + 1` just below, so stopping here spends no attempt,
    // while the other sits inside an attempt that has already been counted — and the writeRunState
    // a few lines above has just persisted `state`, so loop-state.json and the returned value are
    // byte-identical, which is what makes a stop cost the run nothing. The second reason is that
    // the finer granularity buys nothing anyway: reaching the other checkpoint means execute has
    // already run and already been paid for.
    //
    // Deliberately NOT persistTerminalState: a stop means "this process is done acting", not
    // "this run is over", and nothing in this codebase leads back out of a terminal status. The
    // event is the only record that a human asked for this, and nothing reads it — registry
    // observes three files and evaluateResumeEligibility does not read the event stream — so the
    // next sweep cannot tell this apart from an OOM kill. That is accepted here, not overlooked:
    // both want the same handling, and distinguishing them needs a new observed disk field.
    if (options?.stopRequested?.requested === true) {
      await appendEvent(runDir, {
        type: "stop_requested",
        at: new Date().toISOString(),
        detail: `stop requested at a phase boundary before attempt ${state.attemptsUsed + 1}`,
      });
      return state;
    }

    const attempt = state.attemptsUsed + 1;

    let worktreePath: string | null = null;
    let infraRetryUsed = false;

    while (!worktreePath) {
      try {
        // §8.1: adding a worktree mutates the repository, so the lease is re-checked here —
        // inside the retry loop, because the retry can be a long way from the first attempt.
        await heartbeat.assertHeld();
        worktreePath = (await createAttemptWorkspace(contract.context.repoPath, runDir, attempt)).worktreePath;
      } catch (error) {
        // §8.1: a refused lease is not a workspace-infrastructure failure and must consume
        // neither the infra retry nor the blocked_waiting_human escalation below. No worktree
        // was created, so there is nothing to abandon in place; the attempt simply never
        // starts and the run stops here.
        if (isLeaseStopError(error)) {
          return await persistTerminalState(runDir, writeOwnedRunState, state, "cancelled", error.stopReason);
        }

        if (infraRetryUsed) {
          await appendEvent(runDir, {
            type: "workspace_create_failed",
            at: new Date().toISOString(),
            detail: String(error),
          });
          state = await persistTerminalState(
            runDir,
            writeOwnedRunState,
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
      await writeOwnedRunState(runDir, state);

      const planTimeoutMs = getPhaseTimeoutMs(contract, state);
      // §8.1: launching a Claude call is a side effect.
      await heartbeat.assertHeld();
      const planOutcome = await runPhaseWithTimeout(planTimeoutMs, (abortSignal) =>
        adapter.plan(buildAttemptContext(contract, state, runDir, attempt, worktreePath, abortSignal)),
      );

      if (planOutcome.timedOut) {
        state = applyPhaseUsage(state, planOutcome.elapsedMs, undefined);
        state = await persistTerminalState(
          runDir,
          writeOwnedRunState,
          state,
          "exhausted",
          hasBudgetExceeded(state) ? BUDGET_EXHAUSTED_REASON : getPhaseTimeoutReason("plan", planTimeoutMs),
        );
        // §8.1: removing the worktree is a side effect on a directory a new owner may already
        // be reading.
        await heartbeat.assertHeld();
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
        await guardedWriteArtifacts(() => writeCompletedAttemptArtifacts(runDir, attempt, plan, execution));
        state = await persistTerminalState(runDir, writeOwnedRunState, state, "exhausted", BUDGET_EXHAUSTED_REASON);
        await heartbeat.assertHeld();
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
      await writeOwnedRunState(runDir, state);
      await appendTransitionEvent(runDir, state, "execute_started", `attempt ${attempt}`);

      const executeTimeoutMs = getPhaseTimeoutMs(contract, state);
      // §8.1: launching a Claude call is a side effect.
      await heartbeat.assertHeld();
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
          await guardedWriteArtifacts(() => writeAttemptArtifacts(runDir, attempt, {
            plan,
            executionRecovery,
          }));
          await persistBoundaryAnalysis(runDir, state, heartbeat, executionRecovery, options?.onReconciliationWriteAbandoned);
          state = await persistTerminalState(
            runDir,
            writeOwnedRunState,
            state,
            "exhausted",
            hasBudgetExceeded(state) ? BUDGET_EXHAUSTED_REASON : getPhaseTimeoutReason("execute", executeTimeoutMs),
          );
          await heartbeat.assertHeld();
          const cleanupStatus = await cleanupAttemptWorkspaceWithStatus(
            contract.context.repoPath,
            worktreePath,
            runDir,
            "cleanup after terminal decision exhausted",
          );

          if (cleanupStatus !== executionRecovery.cleanupStatus) {
            await guardedWriteArtifacts(() => writeAttemptArtifacts(runDir, attempt, {
              plan,
              executionRecovery: {
                ...executionRecovery,
                cleanupStatus,
              },
            }));
          }

          return state;
        }
      } else {
        execution = executeOutcome.result;
      }

      if (execution === null) {
        // A8 fix wave 1: forwarded because §9 names both call sites, but recorded honestly — the
        // callback is PROVABLY unreachable through here today, so no fixture can cover this
        // argument. This site passes executionRecovery `undefined`, so buildBoundaryEvidence(null)
        // returns its input-independent empty evidence, evaluateRunBoundary therefore yields
        // `no_progress` rather than `stale_candidate`, and a non-stale_candidate boundary passes
        // `reconciliationRecord: undefined` down — which makes writeBoundaryArtifacts skip the
        // entire abandon block. Measured, not merely reasoned: a probe driving this exact branch
        // with a corrupt owner-transfer.json on disk observed status `no_progress`, zero callback
        // invocations, and no reconciliation write. The gate is the EMPTY `continuitySuspicion` and
        // nothing else: evaluateRunBoundary (stopController.ts) returns `stale_candidate` only for
        // `!observedStrongProgress && continuitySuspicion.length > 0`. TWO edits open that gate, and
        // only the first touches this line: (1) a future edit gives this branch a real
        // `executionRecovery` — every non-null branch of buildBoundaryEvidence returns a NON-EMPTY
        // `continuitySuspicion`; (2) buildBoundaryEvidence's `executionRecovery === null` branch
        // stops returning `continuitySuspicion: []`, which re-opens the abandon block for every
        // recovery-less caller at once, without anyone reading this comment. That branch carries a
        // back-pointer here. Either way the path goes live and needs its own covering test.
        // What is NOT a route, because a previous fix wave claimed it was: persistBoundaryAnalysis's
        // hardcoded `observedStrongProgress: false` and `previous: null`. `input.previous` never
        // reaches a status branch at all (it only fills `strongProgressAt` / `weakProgressAt` in the
        // returned payload), and flipping `observedStrongProgress` to true returns `healthy` — one
        // branch FURTHER from `stale_candidate`, not nearer.
        await persistBoundaryAnalysis(runDir, state, heartbeat, undefined, options?.onReconciliationWriteAbandoned);
        throw new Error("execute phase completed without a result");
      }

      const completedExecution = execution;

      if (!executeUsageAlreadyApplied) {
        state = applyPhaseUsage(state, executeOutcome.elapsedMs, completedExecution.tokenUsage);
      }

      if (isPartialExecutionResult(completedExecution)) {
        await guardedWriteArtifacts(() => writeCompletedAttemptArtifacts(runDir, attempt, plan, completedExecution));

        const partialPathPolicy = evaluatePathPolicy({
          changedFiles: completedExecution.changedFiles,
          allowlistPaths: contract.safetyPolicy.allowlistPaths,
          denylistPaths: contract.safetyPolicy.denylistPaths,
          maxFilesTouched: contract.safetyPolicy.maxFilesTouched,
        });

        if (partialPathPolicy.humanGateHit) {
          state = await persistTerminalState(
            runDir,
            writeOwnedRunState,
            state,
            "blocked_waiting_human",
            partialPathPolicy.reason ?? completedExecution.failureMessage,
          );
          return state;
        }

        state = await persistTerminalState(
          runDir,
          writeOwnedRunState,
          state,
          completedExecution.failureType === "timeout" ? "exhausted" : "failed",
          completedExecution.failureMessage,
        );

        await heartbeat.assertHeld();
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
        await guardedWriteArtifacts(() => writeCompletedAttemptArtifacts(runDir, attempt, plan, completedExecution));
        state = await persistTerminalState(
          runDir,
          writeOwnedRunState,
          state,
          "blocked_waiting_human",
          pathPolicy.reason ?? "human gate or denylist hit",
        );
        return state;
      }

      if (hasBudgetExceeded(state)) {
        await guardedWriteArtifacts(() => writeCompletedAttemptArtifacts(runDir, attempt, plan, completedExecution));
        state = await persistTerminalState(runDir, writeOwnedRunState, state, "exhausted", BUDGET_EXHAUSTED_REASON);
        await heartbeat.assertHeld();
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
      await writeOwnedRunState(runDir, state);

      const verifyTimeoutMs = getPhaseTimeoutMs(contract, state);
      // §8.1: launching a Claude call is a side effect. runVerification also shells out to the
      // contract's required checks inside the attempt worktree, which is one too.
      await heartbeat.assertHeld();
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
        await guardedWriteArtifacts(() => writeCompletedAttemptArtifacts(runDir, attempt, plan, completedExecution));
        state = await persistTerminalState(
          runDir,
          writeOwnedRunState,
          state,
          "exhausted",
          hasBudgetExceeded(state) ? BUDGET_EXHAUSTED_REASON : getPhaseTimeoutReason("verify", verifyTimeoutMs),
        );
        await heartbeat.assertHeld();
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
      // Captured because the guard's closure widens the `verification` let back to `| null`.
      const completedVerification = verification;
      await guardedWriteArtifacts(() =>
        writeCompletedAttemptArtifacts(runDir, attempt, plan, execution, completedVerification),
      );

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
        await writeOwnedRunState(runDir, state);

        await heartbeat.assertHeld();

        try {
          await cleanupAttemptWorkspace(contract.context.repoPath, worktreePath);
        } catch (error) {
          state = transitionRunState(state, "failed", String(error));
          await appendTransitionEvent(runDir, state, "attempt_failed", String(error));
          await writeOwnedRunState(runDir, state);
          await heartbeat.assertHeld();
          await cleanupAttemptWorkspaceBestEffort(
            contract.context.repoPath,
            worktreePath,
            runDir,
            "cleanup after retry cleanup failure",
          );
          return state;
        }

        // §8: the same stop, checked again here because this phase boundary can be minutes
        // away from the top of the loop — the periodic heartbeat timer, not just the
        // top-of-loop affirmNow() call, can be what discovers the loss during that gap.
        if (leaseLoss.lost !== null) {
          return await persistTerminalState(runDir, writeOwnedRunState, state, "cancelled", "lease_lost");
        }

        continue;
      }

      state = await persistTerminalState(runDir, writeOwnedRunState, state, decision.kind, decision.reason);

      if (decision.kind !== "blocked_waiting_human") {
        await heartbeat.assertHeld();
        await cleanupAttemptWorkspaceBestEffort(
          contract.context.repoPath,
          worktreePath,
          runDir,
          `cleanup after terminal decision ${decision.kind}`,
        );
      }

      return state;
    } catch (error) {
      // Task B1 / L3 §5.3, option (a): a stopped heartbeat abandons the attempt in place exactly
      // as a refused lease does — no cleanup, no boundary write, no phase usage — but it must NOT
      // terminate the run. Deliberately its OWN branch, ordered ahead of isLeaseStopError rather
      // than folded into it: that branch persists "cancelled", and nothing in this codebase leads
      // back out of a terminal status (resume, sweep and runLoop all refuse one), so routing a
      // stop signal there would end the run permanently on a signal that means only "this process
      // is done acting". It is also ahead of the generic failure handling below, which would
      // otherwise transition to "failed" — a stop is not an attempt failure.
      //
      // The writeRunState is not redundant with the one at the top of the loop. §5.4's stop point
      // sits there, where the returned state is byte-identical to disk; this branch fires
      // mid-attempt, where `state` may have been advanced by applyPhaseUsage since that write.
      // Without it the returned state and the persisted one disagree and the claim that this is
      // structurally the same stop as §5.4's is false.
      if (error instanceof RunHeartbeatStoppedError) {
        await appendEvent(runDir, {
          type: "heartbeat_stopped",
          at: new Date().toISOString(),
          detail: String(error),
        });
        await writeOwnedRunState(runDir, state);
        return state;
      }

      // §8.1: the side effect was skipped and the attempt is abandoned IN PLACE. No further
      // side effect of this attempt is attempted, including its worktree cleanup — cleanup
      // is itself a side effect on a worktree the new owner may already be reading, and
      // this process has just lost the authority to touch it. The residual worktree is left
      // for the new owner, whose resume path already cleans up residual worktrees. This
      // returns before the generic failure handling below on purpose: a refused lease is not
      // an attempt failure, so it must not be fingerprinted, boundary-analysed or
      // transitioned to "failed".
      if (isLeaseStopError(error)) {
        // A guard that fired after this attempt had already persisted a terminal decision
        // blocked only the cleanup that follows it: the run has already stopped, and
        // re-deciding it as "cancelled" would be an illegal transition out of a terminal
        // status as well as another write to a run this process no longer owns.
        return isTerminalRunStatus(state.status)
          ? state
          : await persistTerminalState(runDir, writeOwnedRunState, state, "cancelled", error.stopReason);
      }

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
              writeOwnedRunState,
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
        await writeOwnedRunState(runDir, state);
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
