import { describe, expect, it } from "vitest";
import { loopContractSchema } from "../../../src/contract/schema.js";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../../../src/runtime/claude/prompts.js";
import type { AttemptContext } from "../../../src/runtime/types.js";

// Codex phase output hardening (2026-10-08), spec §3.1. A third-party model ran an investigate task's plan phase as if it
// were the execute phase (apply_patch in a read-only sandbox) and wrapped its answer in prose. The prompts now say what
// each phase must not do and how the final message must look. Every existing line stays byte-for-byte and in order: the
// fake CLIs find the phase and task on the second line, so new text goes after it or at the end.
const READ_ONLY = "This is the planning phase only. The workspace is read-only: do not create, edit or delete files, do not run apply_patch, and do not carry out the task. A later execute phase does the work this plan describes.";
const PLAN_CONSTRAINTS = "Constraints (they bind the execute phase; plan for them, do not act on them now):";
const VERIFY_NO_EDIT = "This is the verify phase. Do not create, edit or delete files; run commands only to check the attempt.";
const FINAL_MESSAGE = "Your final message must be exactly one JSON object: no Markdown code fence, no text before or after it.";
// The Orca investigate constraint that, read at plan time, told the planner to write the report now (spec §1, R1).
const INVESTIGATE = "Investigate only; write the findings to the report file and change nothing else.";

const contract = loopContractSchema.parse({
  objective: { taskId: "t", goal: "g", successCondition: "s" },
  context: { repoPath: "/repo", targetPaths: ["report.md"], buildTestCommands: ["true"], constraints: [INVESTIGATE] },
  executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 5000, totalRuntimeBudgetMs: 20000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
  safetyPolicy: { allowlistPaths: ["report.md"], maxFilesTouched: 1 },
  verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["report missing"] },
  escalationAndExit: {},
});
const context = { contract } as unknown as AttemptContext;
const lines = (prompt: string) => prompt.split("\n");

describe("phase prompts (codex phase output hardening)", () => {
  it("keeps the first two lines of every prompt", () => {
    expect(lines(buildPlannerPrompt(contract)).slice(0, 2)).toEqual(["Return JSON only.", "Plan one isolated L2 attempt for task t."]);
    expect(lines(buildExecutorPrompt(context)).slice(0, 2)).toEqual(["Return JSON only.", "Execute one isolated attempt for task t."]);
    expect(lines(buildVerifierPrompt(context)).slice(0, 2)).toEqual(["Return JSON only.", "Verify task t."]);
  });

  it("keeps every existing planner line in order around the new ones", () => {
    const old = lines(buildPlannerPrompt(contract)).filter((line) => line !== READ_ONLY && line !== FINAL_MESSAGE).map((line) => (line === PLAN_CONSTRAINTS ? "Constraints:" : line));
    expect(old).toEqual(["Return JSON only.", "Plan one isolated L2 attempt for task t.", "Goal: g", "Success condition: s", "Non-goals:", "(none)", "Target paths:", "- report.md", "Constraints:", `- ${INVESTIGATE}`, 'Return an object with {"summary": string, "primaryTargetPaths": string[]}.']);
  });

  it("tells the planner the phase is read-only, right after the task line", () => {
    expect(lines(buildPlannerPrompt(contract))[2]).toBe(READ_ONLY);
  });

  it("labels the planner's constraints as binding the execute phase", () => {
    const planner = lines(buildPlannerPrompt(contract));
    expect(planner[planner.indexOf(PLAN_CONSTRAINTS) + 1]).toBe(`- ${INVESTIGATE}`);
    expect(planner).not.toContain("Constraints:");
  });

  it("keeps the executor's own bare Constraints heading", () => {
    const executor = lines(buildExecutorPrompt(context));
    expect(executor[executor.indexOf("Constraints:") + 1]).toBe(`- ${INVESTIGATE}`);
    expect(executor).not.toContain(PLAN_CONSTRAINTS);
  });

  it("keeps every existing verifier line in order around the new ones", () => {
    const old = lines(buildVerifierPrompt(context)).filter((line) => line !== VERIFY_NO_EDIT && line !== FINAL_MESSAGE);
    expect(old).toEqual([
      "Return JSON only.", "Verify task t.", "Goal: g", "Success condition: s", "Required checks:", "- true",
      "Reject-on conditions (if any of these holds for this attempt, approved must be false):", "- report missing",
      "Required evidence labels (approved must be false if any are missing from evidence):", "(none)",
      "Current attempt plan:", "null", "Current execution outcome:", "null", "Prefer rejection backed by concrete evidence.",
      'Return an object with {"approved": boolean, "rejectCategory": string, "primaryTargetPaths": string[], "failingCommand": string | null, "safeToRetry": boolean, "evidence": string[], "pauseSignals": string[], "stopSignals": string[]}.',
    ]);
  });

  it("tells the verifier not to edit files, right after the task line", () => {
    expect(lines(buildVerifierPrompt(context))[2]).toBe(VERIFY_NO_EDIT);
  });

  for (const { name, build } of [
    { name: "planner", build: () => buildPlannerPrompt(contract) },
    { name: "executor", build: () => buildExecutorPrompt(context) },
    { name: "verifier", build: () => buildVerifierPrompt(context) },
  ]) it(`ends the ${name} prompt with the final-message line`, () => {
    expect(lines(build()).at(-1)).toBe(FINAL_MESSAGE);
  });
});
