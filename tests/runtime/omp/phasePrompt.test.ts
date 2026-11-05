import { expect, it } from "vitest";
import { ompPhaseTools, phaseSystemPrompt } from "../../../src/runtime/omp/phasePrompt.js";
import { normalizeExecutionFinal } from "../../../src/runtime/executionNormalizer.js";

it("tells OMP that ccloop owns Git metadata and forbids staging or committing during execute", () => {
  const prompt = phaseSystemPrompt("execute");
  expect(prompt).toContain("Do not run git add, git reset, git commit, git checkout, or git branch");
  expect(prompt).toContain("ccloop owns Git staging, commits, and publication");
  expect(prompt).toContain("exactly one ccloop phase");
});

it("requires the verifier's string and retry fields to use the contract's exact types", () => {
  const prompt = phaseSystemPrompt("verify");
  expect(prompt).toContain('rejectCategory must be a string; use "" when approved, never null');
  expect(prompt).toContain("safeToRetry must be false when approved");
});

// Plan phase tools (spec 2026-10-27-plan-phase-tools, Orca issue 60): the plan model is told the exact tools omp gives it
// (the --tools list) and that writes, shell and MCP wait for execute -- the human kept plan read-only, so the prompt is the fix.
it("names the plan phase's tools from the --tools list, and only in plan", () => {
  expect(ompPhaseTools("plan")).toEqual(["read", "grep", "glob"]);
  expect(phaseSystemPrompt("plan")).toContain(`Tools available in this phase: ${ompPhaseTools("plan").join(", ")}.`);
  expect(phaseSystemPrompt("plan")).toContain("Writes, shell commands and MCP calls (including xd:// paths) are unavailable until the execute phase");
  expect(phaseSystemPrompt("execute")).not.toContain("Tools available in this phase");
  expect(phaseSystemPrompt("verify")).not.toContain("Tools available in this phase");
});

// Orca tester issue 123 (session 3cfc2e73): omp has no output schema, and a model flattened taskResult's fields to the top
// level, which the strict execute shape refuses after the work is done. The execute system prompt now shows the exact shape:
// both examples must decode as the normalizer decodes a final, with taskResult nested and decisions beside it.
it("shows omp's execute phase the exact answer shape, with taskResult nested, and decodes both examples", () => {
  const prompt = phaseSystemPrompt("execute");
  const example = (label: string) => {
    const line = prompt.split("\n").find((entry) => entry.startsWith(`${label}: `));
    expect(line).toBeDefined();
    return line!.slice(label.length + 2);
  };
  for (const [label, partial] of [["Complete form", false], ["Partial form", true]] as const) {
    const normalized = normalizeExecutionFinal(example(label));
    expect(normalized.status).toBe("available");
    const execution = (normalized as { execution: Record<string, unknown> }).execution;
    expect(execution.taskResult).toMatchObject({ schema: "task-result-v1" });
    expect(Object.keys(execution)).not.toContain("goal");
    expect(Object.hasOwn(execution, "completionStatus")).toBe(partial);
  }
  expect(prompt).toContain('taskResult is one nested object under the "taskResult" key: never put schema, goal, completedWork, conclusions, outputs or limitations at the top level.');
  expect(prompt).toContain("decisions, debug and flow, when you report them, are top-level keys beside changedFiles, not inside taskResult.");
  for (const phase of ["plan", "verify"] as const) {
    expect(phaseSystemPrompt(phase)).not.toContain("Complete form: ");
    expect(phaseSystemPrompt(phase)).not.toContain('"taskResult" key');
  }
});
