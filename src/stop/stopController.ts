import type { FailureFingerprint, StopDecision, StopDecisionInput } from "../state/types.js";

function isRepeatedFailure(previous: FailureFingerprint | undefined, current: StopDecisionInput["verifier"]): boolean {
  if (!previous) {
    return false;
  }

  const sameTargetPaths = JSON.stringify(previous.primaryTargetPaths) === JSON.stringify(current.primaryTargetPaths);
  const sameFailingCommand = previous.failingCommand === current.failingCommand;

  return previous.rejectCategory === current.rejectCategory && (sameTargetPaths || sameFailingCommand);
}

export function evaluateStopDecision(input: StopDecisionInput): StopDecision {
  if (input.humanCancelled) {
    return { kind: "cancelled", reason: "human cancel or kill switch" };
  }

  if (input.successSatisfied || input.verifier.approved) {
    return { kind: "succeeded", reason: "success condition satisfied" };
  }

  if (input.humanGateHit) {
    return { kind: "blocked_waiting_human", reason: "human gate or denylist hit" };
  }

  if (input.attemptNumber >= input.maxAttempts) {
    return { kind: "exhausted", reason: "attempt limit reached" };
  }

  if (input.budgetExceeded) {
    return { kind: "exhausted", reason: "runtime or token budget exhausted" };
  }

  if (isRepeatedFailure(input.recentFailures.at(-1), input.verifier)) {
    return { kind: "exhausted", reason: "repeated failure pattern detected" };
  }

  if (!input.verifier.safeToRetry) {
    return { kind: "failed", reason: "verifier rejection with no safe retry path" };
  }

  if (input.attemptNumber > 1) {
    return { kind: "blocked_waiting_human", reason: "retry after first failed attempt requires human approval" };
  }

  return { kind: "retryable", reason: "first failed attempt is safe to retry" };
}
