export type ClaudePhase = "plan" | "execute" | "verify";

export type SubprocessAdapterConfig = {
  command: string[];
};

export type ClaudePhaseRequest = {
  phase: ClaudePhase;
  prompt: string;
  attempt: number;
  runDir: string;
  worktreePath: string;
};
