import { expect, it } from "vitest";
import { ompPhaseTools, phaseSystemPrompt } from "../../../src/runtime/omp/phasePrompt.js";

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
