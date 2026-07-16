import type { LoopContract } from "../../contract/schema.js";

function formatList(items: string[]): string {
  return items.length === 0 ? "(none)" : items.map((item) => `- ${item}`).join("\n");
}

export function buildPlannerPrompt(contract: LoopContract): string {
  return [
    "Return JSON only.",
    `Plan one isolated L2 attempt for task ${contract.objective.taskId}.`,
    `Goal: ${contract.objective.goal}`,
    `Success condition: ${contract.objective.successCondition}`,
    "Non-goals:",
    formatList(contract.objective.nonGoals),
    "Target paths:",
    formatList(contract.context.targetPaths),
    "Constraints:",
    formatList(contract.context.constraints),
    'Return an object with {"summary": string, "primaryTargetPaths": string[]}.',
  ].join("\n");
}

export function buildExecutorPrompt(contract: LoopContract): string {
  return [
    "Return JSON only.",
    `Execute one isolated attempt for task ${contract.objective.taskId}.`,
    `Goal: ${contract.objective.goal}`,
    `Success condition: ${contract.objective.successCondition}`,
    "Never declare final success; only report what changed in this attempt.",
    "Allowed target paths:",
    formatList(contract.context.targetPaths),
    "Constraints:",
    formatList(contract.context.constraints),
    'Return either a complete object with {"changedFiles": string[], "diffPatch": string, "commandOutputs": string[], "stdoutStderrLog": string} or a partial object that also includes {"completionStatus": "partial", "failureType": "timeout" | "error", "failureMessage": string}.',
    "If the attempt is interrupted, preserve any recognizable partial artifacts in those fields.",
    `If execute is aborted, you may have up to ${contract.executionPolicy.partialOutcomeRecoveryWindowMs}ms to flush one final execute-phase result.`,
  ].join("\n");
}

export function buildVerifierPrompt(contract: LoopContract): string {
  return [
    "Return JSON only.",
    `Verify task ${contract.objective.taskId}.`,
    `Goal: ${contract.objective.goal}`,
    `Success condition: ${contract.objective.successCondition}`,
    "Required checks:",
    formatList(contract.verification.requiredChecks),
    "Prefer rejection backed by concrete evidence.",
    'Return an object with {"approved": boolean, "rejectCategory": string, "primaryTargetPaths": string[], "failingCommand": string | null, "safeToRetry": boolean, "evidence": string[], "pauseSignals": string[], "stopSignals": string[]}.',
  ].join("\n");
}
