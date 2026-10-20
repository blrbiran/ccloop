import type { LoopContract } from "../contract/schema.js";
import type { OwnerStatus, RunState } from "../state/types.js";
import type { ModelUsageV1 } from "../control/usage.js";

export type RequiredCheckResult = { command: string; stdout: string; stderr: string };

/** Ruling B (spec 2026-10-20-verifier-sees-checks-and-last-failure-design.md §5.1): the last rejection, for a retried
 * attempt's plan and execute. evidence is null when it could not be recovered (e.g. after a crash, no matching file). */
export type LastFailure = { rejectCategory: string; failingCommand: string | null; evidence: string[] | null };

export type AttemptContext = {
  contract: LoopContract;
  state: RunState;
  runDir: string;
  attempt: number;
  worktreePath: string;
  abortSignal?: AbortSignal;
  plan?: AttemptPlan;
  execution?: ExecutionResult;
  savedExecution?: { originalBase:string; candidateHead:string; changedPaths:string[] };
  /** Ruling A (spec 2026-10-20-verifier-sees-checks-and-last-failure-design.md §4): set only for verify, by ccloop, after
   * every required check passed; one entry per check in contract order, raw streams. */
  requiredCheckResults?: RequiredCheckResult[];
  lastFailure?: LastFailure;
  onProcessRegistered?: (process: {
    pid: number;
    pgid: number;
    startedAt: string;
    phase: string;
  }) => Promise<void>;
};

export type UsageFieldEvidence = {
  status: "absent" | "finite" | "non_finite" | "invalid_type";
  value?: number;
};

export type UsageEvidence = {
  usageStatus: "present" | "absent" | "invalid";
  fields: {
    input_tokens: UsageFieldEvidence;
    inputTokens: UsageFieldEvidence;
    output_tokens: UsageFieldEvidence;
    outputTokens: UsageFieldEvidence;
  };
  /**
   * Claude only (Orca paid claude round, 2026-09-27): the prompt claude wrote to or read from its cache, which its
   * input_tokens leaves out; each finite value is part of normalizedTotal. Codex's input_tokens already includes its
   * cached input, so codex leaves this out.
   */
  cacheFields?: {
    cache_creation_input_tokens: UsageFieldEvidence;
    cache_read_input_tokens: UsageFieldEvidence;
  };
  selectedInputField: "input_tokens" | "inputTokens" | null;
  selectedOutputField: "output_tokens" | "outputTokens" | null;
  normalizedTotal: number | null;
};

export type AttemptPlan = {
  summary: string;
  primaryTargetPaths: string[];
  tokenUsage?: number;
  usageEvidence?: UsageEvidence;
  /** Orca accounts plan B2 (2026-10-07): claude's per-model breakdown of tokenUsage, absent when not known. */
  modelUsage?: ModelUsageV1[];
};

type ExecutionArtifacts = {
  /** Optional executor explanation; availability never changes the actual execution outcome. */
  taskResult?: unknown;
  /** Reported decisions and debug (spec 2026-10-20 §4.1): carried opaquely for Orca; never change the outcome. */
  decisions?: unknown;
  debug?: unknown;
  changedFiles: string[];
  diffPatch: string;
  commandOutputs: string[];
  stdoutStderrLog: string;
  tokenUsage?: number;
  usageEvidence?: UsageEvidence;
  /** Orca accounts plan B2 (2026-10-07): claude's per-model breakdown of tokenUsage, absent when not known. */
  modelUsage?: ModelUsageV1[];
};

export type CompleteExecutionResult = ExecutionArtifacts;

export type PartialExecutionResult = ExecutionArtifacts & {
  completionStatus: "partial";
  failureType: "timeout" | "error";
  failureMessage: string;
  /** Crash resume (2026-10-02), spec §5.1: set only on a partial the claude phase runner built itself, never by claude. */
  partialOrigin?: "runner";
};

export type ExecutionResult = CompleteExecutionResult | PartialExecutionResult;
export type ExecutePhaseResult = ExecutionResult | null;

export type ExecutionRecovery = {
  executeEntered: true;
  worktreeDiffObserved: true | false | "unknown";
  diffPatchCaptured: boolean;
  stdoutStderrLogCaptured: boolean;
  changedPathsObserved: string[] | null;
  captureStatus: "complete" | "partial" | "failed";
  cleanupStatus: "retained" | "removed";
  failureBoundary: "timeout" | "token_exhausted" | "runtime_exhausted";
};

export type TakeoverPermission = {
  allowed: boolean;
  reason: string;
};

export type OwnershipVerdict =
  | "OWNER_VALID"
  | "OWNER_LOST"
  | "OWNER_SUPERSEDED"
  | "OWNER_UNDECIDABLE";

export type OwnerRecord = {
  runId: string;
  logicalSessionId: string;
  currentOwnerEpoch: number;
  currentProcessInstanceId: string;
  lastAffirmedAt: string;
  ownerStatus: OwnerStatus;
  supersededByEpoch: number | null;
  // §5.0: written non-null ONLY by the lease heartbeat. `null` means "owned, but no
  // process is running it". Records written before this design omit the field; readers
  // treat absent as null.
  leaseAffirmedAt: string | null;
};

export type OwnerTransferRecord = {
  priorOwnerEpoch: number;
  newOwnerEpoch: number;
  priorProcessInstanceId: string;
  newProcessInstanceId: string;
  transferredAt: string;
  reason: string;
  eligibleForContinuation: true;
};

export type ReconciliationRecord = {
  staleSuspicionBasis: string[];
  staleConfirmed: boolean;
  ownershipVerdict: OwnershipVerdict;
  lastTrustedBoundary: "planning" | "execute" | "verify" | "terminal" | "unknown";
  conflictingEvidence: string[];
  takeoverPermission: TakeoverPermission;
  priorOwnerEpoch: number | null;
  newOwnerEpoch: number | null;
  eligibleForContinuation: boolean;
};

// Task A4 / §4.3: what `persistBoundaryAnalysis` can assemble BEFORE the epoch rule runs.
// `newOwnerEpoch` is the one field only `applyOwnerEpochTransfer` (ownerController.ts) can
// produce — `persistOwnerTransfer` fills it in after that call, never before.
export type ReconciliationDraft = Omit<ReconciliationRecord, "newOwnerEpoch">;

export function isPartialExecutionResult(result: ExecutionResult): result is PartialExecutionResult {
  return "completionStatus" in result && result.completionStatus === "partial";
}

/**
 * Orca handoff delivery (2026-09-25), spec §13.1 C-3: a phase that ended without a result (a handoff
 * deadline aborted it) may still have been OBSERVED spending tokens before it was stopped. A runtime
 * adapter reports that observation as `observedTokens` on the error it throws; anything else is "not
 * observed" (null) — never 0, never an estimate.
 * Honest registration: real codex reports usage only at phase end, so a deadline that aborts a phase
 * mid-turn usually gives the adapter nothing to observe — this then answers null, and the run's usage
 * stays unknown (unrecoverable), not a guessed value.
 *
 * *** ERRATUM (Orca backlog #15, human-authorized 2026-09-29, Orca session 2724716d) -- the sentence above that
 * "real codex reports usage only at phase end" is written as a fact, but it was never measured. The plan it came
 * from (Orca docs/superpowers/plans/2026-09-25-handoff-delivery.md, §0 item (10)) inferred it from reading the codex
 * adapter's source and marked it as a guess, because no events.jsonl from a real codex run was kept in either
 * repository to check it against; Orca's final review of that round names this comment (finding M4 in Orca
 * .superpowers/sdd/2026-09-25-handoff-delivery/final-review.md). Read that sentence as unmeasured. What this function
 * answers -- a positive safe integer the adapter observed, otherwise null, never 0 -- is unchanged. ***
 *
 * *** ERRATUM (crash resume, 2026-10-02, Orca session ece96b67; ccloop spec
 * 2026-10-02-crash-resume-and-orphan-reaping-design.md §3.2) -- "never 0" no longer holds for one case: an error
 * carrying `neverStarted: true` answers 0. That 0 is observed, not assumed: the runner proved no claude process
 * existed in the call, so nothing could have been spent. ***
 */
export function observedTokensOf(error: unknown): number | null {
  if (error !== null && typeof error === "object" && (error as { neverStarted?: unknown }).neverStarted === true) return 0;
  // Codex rate-limit spec (2026-10-13) §3.3, human ruling: a call rejected by 429 before any work booked nothing.
  if (error !== null && typeof error === "object" && (error as { rateLimitedBeforeWork?: unknown }).rateLimitedBeforeWork === true) return 0;
  const value = error !== null && typeof error === "object" ? (error as { observedTokens?: unknown }).observedTokens : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Orca single-call estimate (2026-09-27), spec §5.4: one read-only structured call. The prompt and schema are handed to
 * the agent as they are; the adapter runs it in `cwd` (an empty private directory) and keeps its evidence under runDir.
 */
export type SingleCallRequest = {
  prompt: string;
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
  cwd: string;
  runDir: string;
  /** The grant's activeMs; the adapter takes the smaller of this and its installation's timeoutMs. */
  timeoutMs: number;
  signal?: AbortSignal;
  onProcessRegistered?: AttemptContext["onProcessRegistered"];
};

export type SingleCallResult = { output: unknown; tokenUsage: number | null; usageEvidence: unknown; modelUsage?: ModelUsageV1[] };

/** Spec §5.2 item 8: the call ended but gave no structured object. The usage it spent is still carried, never 0 for null. */
export class SingleCallOutputInvalid extends Error {
  readonly code = "single-call-output-invalid" as const;
  constructor(readonly evidenceDir: string, readonly tokenUsage: number | null, readonly usageEvidence: unknown) {
    super(`single-call-output-invalid: ${evidenceDir}`);
    this.name = "SingleCallOutputInvalid";
  }
}

export type VerificationResult = {
  approved: boolean;
  rejectCategory: string;
  primaryTargetPaths: string[];
  failingCommand: string | null;
  safeToRetry: boolean;
  evidence: string[];
  pauseSignals: string[];
  stopSignals: string[];
  tokenUsage?: number;
  usageEvidence?: UsageEvidence;
  /** Orca accounts plan B2 (2026-10-07): claude's per-model breakdown of tokenUsage, absent when not known. */
  modelUsage?: ModelUsageV1[];
};

export interface RuntimeAdapter {
  /** H6: a phase owns filesystem cleanup that must finish before controller timeout cleanup. */
  readonly awaitAbortedPhaseCleanup?: boolean;
  plan(context: AttemptContext): Promise<AttemptPlan>;
  execute(context: AttemptContext): Promise<ExecutePhaseResult>;
  verify(context: AttemptContext): Promise<VerificationResult>;
  /** Orca single-call estimate (2026-09-27): only a kind whose descriptor answers singleCallExecution "v1" has it.
   * *** ERRATUM (OMP single call, Orca spec 2026-10-14 §3.2, Orca session 02f047f6, 2026-10-14) -- the omp adapter has it while its
   * descriptor answers "v1" only for some catalog rows: for omp the answer is decided per selected catalog row (accept
   * refuses the rest by the resolution) and re-checked at spawn, where the adapter refuses again. ***
   * *** ERRATUM (Orca spec 2026-10-15 §6.1, every-agent requirement chain Task 8, Orca session a852f96a, 2026-10-16) -- codex
   * has it too: its descriptor answers "v1-soft" (not "v1") per catalog row; the adapter refuses again at spawn when the
   * installed feature list is unknown. *** */
  singleCall?(request: SingleCallRequest): Promise<SingleCallResult>;
}
