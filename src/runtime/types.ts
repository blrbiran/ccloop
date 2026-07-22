import type { LoopContract } from "../contract/schema.js";
import type { OwnerStatus, RunState } from "../state/types.js";

export type AttemptContext = {
  contract: LoopContract;
  state: RunState;
  runDir: string;
  attempt: number;
  worktreePath: string;
  abortSignal?: AbortSignal;
  plan?: AttemptPlan;
  execution?: ExecutionResult;
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
  selectedInputField: "input_tokens" | "inputTokens" | null;
  selectedOutputField: "output_tokens" | "outputTokens" | null;
  normalizedTotal: number | null;
};

export type AttemptPlan = {
  summary: string;
  primaryTargetPaths: string[];
  tokenUsage?: number;
  usageEvidence?: UsageEvidence;
};

type ExecutionArtifacts = {
  changedFiles: string[];
  diffPatch: string;
  commandOutputs: string[];
  stdoutStderrLog: string;
  tokenUsage?: number;
  usageEvidence?: UsageEvidence;
};

export type CompleteExecutionResult = ExecutionArtifacts;

export type PartialExecutionResult = ExecutionArtifacts & {
  completionStatus: "partial";
  failureType: "timeout" | "error";
  failureMessage: string;
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

export function isPartialExecutionResult(result: ExecutionResult): result is PartialExecutionResult {
  return "completionStatus" in result && result.completionStatus === "partial";
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
};

export interface RuntimeAdapter {
  plan(context: AttemptContext): Promise<AttemptPlan>;
  execute(context: AttemptContext): Promise<ExecutePhaseResult>;
  verify(context: AttemptContext): Promise<VerificationResult>;
}
