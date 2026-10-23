// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.5 "Prompts", §16.1 C7; review 1): with extra worktrees,
// the planner, executor and verifier prompts carry one Directories section right after the success condition, naming
// every directory's key, absolute worktree and allowed paths (and an extra's checks); the executor is told changedFiles
// stays relative to its working directory. Without extra worktrees every prompt is as before.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../../src/runtime/claude/prompts.js";
import type { AttemptContext } from "../../src/runtime/types.js";
import { RAW_CONTRACT } from "../fixtures/toolRules/argvCapture.js";

const plan = { summary: "Set answer to 42", primaryTargetPaths: ["answer.txt"] };
const multi = loopContractSchema.parse({ ...RAW_CONTRACT, context: { ...RAW_CONTRACT.context, repoKey: "app",
  additionalRepos: [{ key: "lib", repoPath: "/w/lib", targetPaths: ["lib/**", "README.md"], requiredChecks: ["npm test", "npm run lint"] }, { key: "docs", repoPath: "/w/docs", targetPaths: ["docs/**"] }] } });
const extraWorktrees = [
  { key: "lib", worktreePath: "/run/dirs/attempt-1/lib", targetPaths: ["lib/**", "README.md"], requiredChecks: ["npm test", "npm run lint"] },
  { key: "docs", worktreePath: "/run/dirs/attempt-1/docs", targetPaths: ["docs/**"], requiredChecks: [] },
];
const context = { contract: multi, worktreePath: "/run/worktrees/attempt-1", extraWorktrees, plan, execution: { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" } } as unknown as AttemptContext;
const SECTION = [
  "Directories (each is a separate git worktree; write only inside the allowed paths of each):",
  "- app (working directory): /run/worktrees/attempt-1  allowed: answer.txt",
  "- lib: /run/dirs/attempt-1/lib  allowed: lib/**, README.md  checks run there: npm test; npm run lint",
  "- docs: /run/dirs/attempt-1/docs  allowed: docs/**  checks run there: none",
];
const CHANGED_FILES = "changedFiles lists only the paths you changed in the working directory, relative to it. ccloop observes the other directories itself.";
const after = (prompt: string, line: string) => { const lines = prompt.split("\n"); return lines.slice(lines.indexOf(line) + 1); };

describe("the Directories section (C7)", () => {
  it("planner: right after the success condition, every key, path and allowed path", () => {
    const prompt = buildPlannerPrompt(multi, undefined, undefined, undefined, context);
    expect(after(prompt, "Success condition: answer is 42").slice(0, 4)).toEqual(SECTION);
    expect(prompt).not.toContain(CHANGED_FILES);
  });

  it("executor: the same section, then the changedFiles rule", () => {
    expect(after(buildExecutorPrompt(context), "Success condition: answer is 42").slice(0, 5)).toEqual([...SECTION, CHANGED_FILES]);
  });

  it("verifier: the same section, with every extra repository", () => {
    const prompt = buildVerifierPrompt(context);
    expect(after(prompt, "Success condition: answer is 42").slice(0, 4)).toEqual(SECTION);
    expect(prompt).not.toContain(CHANGED_FILES);
  });

  it("without extra worktrees: no section, and the executor prompt is the 2a2ae53 golden", async () => {
    const single = loopContractSchema.parse(structuredClone(RAW_CONTRACT));
    const plain = { contract: single, worktreePath: "/run/worktrees/attempt-1", plan } as unknown as AttemptContext;
    expect(buildExecutorPrompt({ contract: single, plan } as unknown as AttemptContext)).toBe(await readFile(new URL("../fixtures/toolRules/golden-2a2ae53/executor-prompt.txt", import.meta.url), "utf8"));
    expect(buildPlannerPrompt(single, undefined, undefined, undefined, plain)).toBe(buildPlannerPrompt(single));
    for (const prompt of [buildPlannerPrompt(single, undefined, undefined, undefined, plain), buildExecutorPrompt(plain), buildVerifierPrompt(plain)]) {
      expect(prompt).not.toContain("Directories (");
      expect(prompt).not.toContain(CHANGED_FILES);
    }
  });
});
