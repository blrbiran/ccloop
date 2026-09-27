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
    })
  | {
      // Orca single-call estimate (2026-09-27), spec §5.4: the caller's schema and output cap, run in `cwd`.
      phase: "single-call";
      prompt: string;
      attempt: number;
      runDir: string;
      cwd: string;
      schema: Record<string, unknown>;
      maxOutputTokens: number;
    };
