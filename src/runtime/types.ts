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

export type ExecutionResult = {
  changedFiles: string[];
  diffPatch: string;
  commandOutputs: string[];
  stdoutStderrLog: string;
  tokenUsage?: number;
};

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
  execute(context: AttemptContext): Promise<ExecutionResult>;
  verify(context: AttemptContext): Promise<VerificationResult>;
}
