import { describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { buildVerifierPrompt } from "../../src/runtime/claude/prompts.js";
import type { AttemptContext, ExecutionResult } from "../../src/runtime/types.js";
const contract = loopContractSchema.parse({
  objective: { taskId: "t", goal: "g", successCondition: "s" },
  context: { repoPath: "/repo", targetPaths: ["answer.txt"], buildTestCommands: ["true"] },
  executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 5000, totalRuntimeBudgetMs: 20000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
  safetyPolicy: { allowlistPaths: ["answer.txt"], maxFilesTouched: 1 },
  verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["answer missing"] }, escalationAndExit: {},
});
const core = { stdoutStderrLog: "log", commandOutputs: ["ran"], diffPatch: "patch", changedFiles: ["answer.txt"] };
const expected = `Return JSON only.
Verify task t.
This is the verify phase. Do not change the attempt's files; run commands only to check the attempt.
Goal: g
Success condition: s
Required checks:
- true
Reject-on conditions (if any of these holds for this attempt, approved must be false):
- answer missing
Required evidence labels (approved must be false if any are missing from evidence):
(none)
Current attempt plan:
null
Current execution outcome:
{
  "stdoutStderrLog": "log",
  "commandOutputs": [
    "ran"
  ],
  "diffPatch": "patch",
  "changedFiles": [
    "answer.txt"
  ]
}
Prefer rejection backed by concrete evidence.
Return an object with {"approved": boolean, "rejectCategory": string, "primaryTargetPaths": string[], "failingCommand": string | null, "safeToRetry": boolean, "evidence": string[], "pauseSignals": string[], "stopSignals": string[]}.
Your final message must be exactly one JSON object: no Markdown code fence, no text before or after it.`;
const context = (execution: ExecutionResult) => ({ contract, execution }) as AttemptContext;
// Break: optional accessor evaluation must never replace baseline core evidence or prevent a verifier prompt.
describe("verifier excludes report descriptors without reading metadata", () => {
  it("preserves literal baseline prompt bytes and enumerable execution field order", () => {
    expect(buildVerifierPrompt(context(core))).toBe(expected);
  });
  it("preserves baseline prompt bytes with an enumerable throwing taskResult accessor", () => {
    const execution = Object.defineProperty({ ...core }, "taskResult", { enumerable: true, get() { throw new Error("optional report accessor executed"); } });
    expect(buildVerifierPrompt(context(execution))).toBe(expected);
  });
  it("keeps hidden core properties excluded when cloning descriptors", () => {
    const execution = Object.defineProperty({ ...core }, "toJSON", { enumerable: false, value() { throw new Error("hidden serializer must not execute"); } });
    expect(buildVerifierPrompt(context(execution))).toBe(expected);
  });
});
