import type { RunState, RunStatus } from "./types.js";

const legalTransitions: Record<RunStatus, RunStatus[]> = {
  queued: ["planning", "cancelled"],
  planning: ["executing", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
  executing: ["verifying", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
  verifying: ["planning", "succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
  succeeded: [],
  blocked_waiting_human: [],
  exhausted: [],
  cancelled: [],
  failed: [],
};

export function transitionRunState(state: RunState, next: RunStatus, reason?: string): RunState {
  if (!legalTransitions[state.status].includes(next)) {
    throw new Error(`illegal transition: ${state.status} -> ${next}`);
  }

  return {
    ...state,
    status: next,
    waitingOnHuman: next === "blocked_waiting_human",
    stopReason: reason ?? state.stopReason,
    lastTransitionAt: new Date().toISOString(),
  };
}
