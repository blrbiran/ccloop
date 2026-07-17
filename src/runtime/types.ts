import type { LoopContract } from "../contract/schema.js";
import type { RunState } from "../state/types.js";

export type AttemptContext = {
  contract: LoopContract;
  state: RunState;
  runDir: string;
  attempt: number;
  worktreePath: string;
  abortSignal?: AbortSignal;
};

export type AttemptPlan = {
  summary: string;
  primaryTargetPaths: string[];
  tokenUsage?: number;
};

type ExecutionArtifacts = {
  changedFiles: string[];
  diffPatch: string;
  commandOutputs: string[];
  stdoutStderrLog: string;
  tokenUsage?: number;
};

export type CompleteExecutionResult = ExecutionArtifacts;

export type PartialExecutionResult = ExecutionArtifacts & {
  completionStatus: "partial";
  failureType: "timeout" | "error";
  failureMessage: string;
};

export type ExecutionResult = CompleteExecutionResult | PartialExecutionResult;
export type ExecutePhaseResult = ExecutionResult | null;

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
};

export interface RuntimeAdapter {
  plan(context: AttemptContext): Promise<AttemptPlan>;
  execute(context: AttemptContext): Promise<ExecutePhaseResult>;
  verify(context: AttemptContext): Promise<VerificationResult>;
}
