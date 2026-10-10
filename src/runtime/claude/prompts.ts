import type { LoopContract } from "../../contract/schema.js";
import type { AttemptContext } from "../types.js";

function formatList(items: string[]): string {
  return items.length === 0 ? "(none)" : items.map((item) => `- ${item}`).join("\n");
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

// Codex phase output hardening (2026-10-08), spec §3.1: every existing line stays byte-for-byte and in order (the fake
// CLIs anchor on the second line); new text is inserted after the second line or appended as the last line.
const FINAL_MESSAGE_LINE = "Your final message must be exactly one JSON object: no Markdown code fence, no text before or after it.";

export function buildPlannerPrompt(contract: LoopContract): string {
  return [
    "Return JSON only.",
    `Plan one isolated L2 attempt for task ${contract.objective.taskId}.`,
    "This is the planning phase only. The workspace is read-only: do not create, edit or delete files, do not run apply_patch, and do not carry out the task. A later execute phase does the work this plan describes.",
    `Goal: ${contract.objective.goal}`,
    `Success condition: ${contract.objective.successCondition}`,
    "Non-goals:",
    formatList(contract.objective.nonGoals),
    "Target paths:",
    formatList(contract.context.targetPaths),
    "Constraints (they bind the execute phase; plan for them, do not act on them now):",
    formatList(contract.context.constraints),
    'Return an object with {"summary": string, "primaryTargetPaths": string[]}.',
    FINAL_MESSAGE_LINE,
  ].join("\n");
}

export function buildExecutorPrompt(context: AttemptContext): string {
  const contract = context.contract;

  return [
    "Return JSON only.",
    `Execute one isolated attempt for task ${contract.objective.taskId}.`,
    `Goal: ${contract.objective.goal}`,
    `Success condition: ${contract.objective.successCondition}`,
    // Crash resume (2026-10-02), spec §5.2 (R-B): an executor that could not run a check reported partial/error, and the
    // run ended without the verify phase that would have run it.
    "Required checks (run by the verifier in this worktree after you finish):",
    formatList(contract.verification.requiredChecks),
    "If you cannot run a command (for example it needs approval), do not report partial or error for that reason; deliver your changes and say in stdoutStderrLog which commands you could not run.",
    "Never declare final success; only report what changed in this attempt.",
    "Allowed target paths:",
    formatList(contract.context.targetPaths),
    "Constraints:",
    formatList(contract.context.constraints),
    "Current attempt plan (source of truth for this execution):",
    formatJson(context.plan),
    "Execute against the current attempt plan above and report only this attempt's concrete outcome.",
    'Return either a complete object with {"changedFiles": string[], "diffPatch": string, "commandOutputs": string[], "stdoutStderrLog": string} or a partial object that also includes {"completionStatus": "partial", "failureType": "timeout" | "error", "failureMessage": string}.',
    'When possible, include optional taskResult metadata in that same complete or partial object: {"schema":"task-result-v1","goal":string,"completedWork":string[],"conclusions":string[],"outputs":[{"path":string,"label":string}],"limitations":string[]}.',
    "This explanation describes this attempt only; it is not a product file, a verification claim, or an additional acceptance condition. Do not add task/run/group or verification identities. Missing explanation does not change the execution outcome.",
    "Keep taskResult UTF-8 JSON at most 65536 bytes: a nonempty goal at most 4000 characters; each text array and outputs at most 32 entries; text entries at most 4000 characters; output path at most 1024 and label at most 256 characters. Empty arrays are valid.",
    "Output paths must be relative POSIX file paths: no empty/dot/dot-dot components, absolute/drive or URL prefix, NUL or backslash. Report limitations honestly and leave actual verification to the verifier.",
    "If the attempt is interrupted, preserve any recognizable partial artifacts in those fields.",
    `If execute is aborted, you may have up to ${contract.executionPolicy.partialOutcomeRecoveryWindowMs}ms to flush one final execute-phase result.`,
    FINAL_MESSAGE_LINE,
  ].join("\n");
}

export function buildVerifierPrompt(context: AttemptContext): string {
  const contract = context.contract;
  // The Agent explanation is supplemental; verification continues to see the same actual execution evidence.
  const { taskResult: _taskResult, ...executionCore } = context.execution ?? {};

  return [
    "Return JSON only.",
    `Verify task ${contract.objective.taskId}.`,
    "This is the verify phase. Do not change the attempt's files; run commands only to check the attempt.",
    `Goal: ${contract.objective.goal}`,
    `Success condition: ${contract.objective.successCondition}`,
    "Required checks:",
    formatList(contract.verification.requiredChecks),
    "Reject-on conditions (if any of these holds for this attempt, approved must be false):",
    formatList(contract.verification.rejectOn),
    "Required evidence labels (approved must be false if any are missing from evidence):",
    formatList(contract.verification.evidenceRequired),
    "Current attempt plan:",
    formatJson(context.plan),
    "Current execution outcome:",
    formatJson(context.execution === undefined ? undefined : executionCore),
    "Prefer rejection backed by concrete evidence.",
    'Return an object with {"approved": boolean, "rejectCategory": string, "primaryTargetPaths": string[], "failingCommand": string | null, "safeToRetry": boolean, "evidence": string[], "pauseSignals": string[], "stopSignals": string[]}.',
    FINAL_MESSAGE_LINE,
  ].join("\n");
}
