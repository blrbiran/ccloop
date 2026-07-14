export type RunStatus =
  | "queued"
  | "planning"
  | "executing"
  | "verifying"
  | "succeeded"
  | "blocked_waiting_human"
  | "exhausted"
  | "cancelled"
  | "failed";

export type FailureFingerprint = {
  rejectCategory: string;
  primaryTargetPaths: string[];
  failingCommand: string | null;
};

export type BudgetSnapshot = {
  attemptsRemaining: number;
  timeRemainingMs: number;
  tokenBudgetRemaining: number;
};

export type RunState = {
  status: RunStatus;
  currentAttempt: number;
  attemptsUsed: number;
  lastTransitionAt: string;
  waitingOnHuman: boolean;
  stopReason: string | null;
  budgetSnapshot: BudgetSnapshot;
  recentFailures: FailureFingerprint[];
};

export type StopDecision = {
  kind: "retryable" | "succeeded" | "blocked_waiting_human" | "exhausted" | "cancelled" | "failed";
  reason: string;
};

export type StopDecisionInput = {
  humanCancelled: boolean;
  successSatisfied: boolean;
  humanGateHit: boolean;
  attemptNumber: number;
  maxAttempts: number;
  budgetExceeded: boolean;
  recentFailures: FailureFingerprint[];
  verifier: {
    approved: boolean;
    rejectCategory: string;
    primaryTargetPaths: string[];
    failingCommand: string | null;
    safeToRetry: boolean;
  };
};
