export type AttemptPlan = {
  summary: string;
  primaryTargetPaths: string[];
};

export type ExecutionResult = {
  changedFiles: string[];
  diffPatch: string;
  commandOutputs: string[];
  stdoutStderrLog: string;
};

export type VerificationResult = {
  approved: boolean;
  rejectCategory: string;
  primaryTargetPaths: string[];
  failingCommand: string | null;
  safeToRetry: boolean;
  evidence: string[];
};

export interface RuntimeAdapter {
  plan(): Promise<AttemptPlan>;
  execute(): Promise<ExecutionResult>;
  verify(): Promise<VerificationResult>;
}
