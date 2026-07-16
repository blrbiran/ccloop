export type ClaudePhase = "plan" | "execute" | "verify";

export type SubprocessAdapterConfig = {
  command: string[];
};

type ClaudePhaseRequestBase = {
  prompt: string;
  attempt: number;
  runDir: string;
  worktreePath: string;
};

export type ClaudePhaseRequest =
  | (ClaudePhaseRequestBase & {
      phase: "plan" | "verify";
    })
  | (ClaudePhaseRequestBase & {
      phase: "execute";
      partialOutcomeRecoveryWindowMs: number;
    });
