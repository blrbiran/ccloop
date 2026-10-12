import { expect, it } from "vitest";
import { phaseSystemPrompt } from "../../../src/runtime/omp/phasePrompt.js";

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
