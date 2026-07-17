import type { LoopContract } from "../../contract/schema.js";
import type { AttemptContext } from "../types.js";

function formatList(items: string[]): string {
  return items.length === 0 ? "(none)" : items.map((item) => `- ${item}`).join("\n");
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
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

export function buildExecutorPrompt(context: AttemptContext): string {
  const contract = context.contract;

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
    "Current attempt plan (source of truth for this execution):",
    formatJson(context.plan),
    "Execute against the current attempt plan above and report only this attempt's concrete outcome.",
    'Return either a complete object with {"changedFiles": string[], "diffPatch": string, "commandOutputs": string[], "stdoutStderrLog": string} or a partial object that also includes {"completionStatus": "partial", "failureType": "timeout" | "error", "failureMessage": string}.',
    "If the attempt is interrupted, preserve any recognizable partial artifacts in those fields.",
    `If execute is aborted, you may have up to ${contract.executionPolicy.partialOutcomeRecoveryWindowMs}ms to flush one final execute-phase result.`,
  ].join("\n");
}

export function buildVerifierPrompt(context: AttemptContext): string {
  const contract = context.contract;

  return [
    "Return JSON only.",
    `Verify task ${contract.objective.taskId}.`,
    `Goal: ${contract.objective.goal}`,
    `Success condition: ${contract.objective.successCondition}`,
    "Required checks:",
    formatList(contract.verification.requiredChecks),
    "Reject-on conditions (must force approved=false when present in evidence):",
    formatList(contract.verification.rejectOn),
    "Required evidence labels (approved must be false if any are missing from evidence):",
    formatList(contract.verification.evidenceRequired),
    "Current attempt plan:",
    formatJson(context.plan),
    "Current execution outcome:",
    formatJson(context.execution),
    "Prefer rejection backed by concrete evidence.",
    'Return an object with {"approved": boolean, "rejectCategory": string, "primaryTargetPaths": string[], "failingCommand": string | null, "safeToRetry": boolean, "evidence": string[], "pauseSignals": string[], "stopSignals": string[]}.',
  ].join("\n");
}
