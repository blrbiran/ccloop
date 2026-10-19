import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { buildExecutorPrompt, buildVerifierPrompt } from "../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import type { AttemptContext, ExecutionResult } from "../../src/runtime/types.js";
import { codexFixture } from "./codex/fixture.js";

// Reported decisions and debug (ccloop spec 2026-10-20 §4.2, §7 criterion 9). The human ruled (2026-10-20) that a headless
// agent must not stop to ask, but must report the choices it made so the human can confirm or correct them later, few and
// graded. The executor prompt is where the agent learns that; every existing line stays byte-for-byte (the fake CLIs anchor
// on the second line), and the verifier must not see the report: it is supplemental, not execution evidence.
const contract = loopContractSchema.parse({
  objective: { taskId: "t", goal: "g", successCondition: "s" },
  context: { repoPath: "/repo", targetPaths: ["answer.txt"], buildTestCommands: ["true"] },
  executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 5000, totalRuntimeBudgetMs: 20000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
  safetyPolicy: { allowlistPaths: ["answer.txt"], maxFilesTouched: 1 },
  verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["answer missing"] }, escalationAndExit: {},
});
// The executor prompt of this contract at ccloop b393c32 (before this change), line by line.
const BEFORE = [
  "Return JSON only.",
  "Execute one isolated attempt for task t.",
  "Goal: g",
  "Success condition: s",
  "Required checks (run by the verifier in this worktree after you finish):",
  "- true",
  "If you cannot run a command (for example it needs approval), do not report partial or error for that reason; deliver your changes and say in stdoutStderrLog which commands you could not run.",
  "Never declare final success; only report what changed in this attempt.",
  "Allowed target paths:",
  "- answer.txt",
  "Constraints:",
  "(none)",
  "Current attempt plan (source of truth for this execution):",
  "null",
  "Execute against the current attempt plan above and report only this attempt's concrete outcome.",
  "Return either a complete object with {\"changedFiles\": string[], \"diffPatch\": string, \"commandOutputs\": string[], \"stdoutStderrLog\": string} or a partial object that also includes {\"completionStatus\": \"partial\", \"failureType\": \"timeout\" | \"error\", \"failureMessage\": string}.",
  "When possible, include optional taskResult metadata in that same complete or partial object: {\"schema\":\"task-result-v1\",\"goal\":string,\"completedWork\":string[],\"conclusions\":string[],\"outputs\":[{\"path\":string,\"label\":string}],\"limitations\":string[]}.",
  "This explanation describes this attempt only; it is not a product file, a verification claim, or an additional acceptance condition. Do not add task/run/group or verification identities. Missing explanation does not change the execution outcome.",
  "Keep taskResult UTF-8 JSON at most 65536 bytes: a nonempty goal at most 4000 characters; each text array and outputs at most 32 entries; text entries at most 4000 characters; output path at most 1024 and label at most 256 characters. Empty arrays are valid.",
  "Output paths must be relative POSIX file paths: no empty/dot/dot-dot components, absolute/drive or URL prefix, NUL or backslash. Report limitations honestly and leave actual verification to the verifier.",
  "If the attempt is interrupted, preserve any recognizable partial artifacts in those fields.",
  "If execute is aborted, you may have up to 1000ms to flush one final execute-phase result.",
  "Your final message must be exactly one JSON object: no Markdown code fence, no text before or after it.",
];
const context = { contract, plan: null } as unknown as AttemptContext;
const lines = (prompt: string) => prompt.split("\n");
const added = (prompt: string) => lines(prompt).filter((line) => !BEFORE.includes(line));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("the executor prompt asks for graded decisions (spec §4.2)", () => {
  it("keeps every existing line byte-for-byte and in order, and puts the new lines last before the final-message line", () => {
    const prompt = lines(buildExecutorPrompt(context));
    expect(prompt.filter((line) => BEFORE.includes(line))).toEqual(BEFORE);
    expect(prompt.slice(0, BEFORE.length - 1)).toEqual(BEFORE.slice(0, -1));
    expect(prompt.at(-1)).toBe(BEFORE.at(-1));
    expect(prompt).toHaveLength(BEFORE.length + 5);
  });

  it("names what a decision is, that the agent must not stop to ask, and the decision shape", () => {
    const [what] = added(buildExecutorPrompt(context));
    expect(what).toContain("decisions");
    expect(what).toContain("a question you would have stopped to ask the human in an interactive session");
    expect(what).toContain("a direction, architecture or interface choice or change");
    expect(what).toContain("Do not stop to ask: choose, continue, and report it.");
    for (const field of ["question", "chose", "alternatives", "option", "why_not", "because", "undo", "how", "cost", "blast_radius", "scope", "kind", "importance"]) expect(what).toContain(`"${field}"`);
  });

  it("grades them major or minor, asks for few, and allows none (omit or []) without mentioning null", () => {
    const [, grade] = added(buildExecutorPrompt(context));
    expect(grade).toContain('importance: "major"');
    expect(grade).toContain('"minor" for naming and local implementation trade-offs');
    expect(grade).toContain("Report few, important decisions");
    expect(grade).toContain("omit the field or give []");
    expect(added(buildExecutorPrompt(context)).join("\n")).not.toContain("null");
  });

  it("names the scope and kind values (implementation included, reconcile left out)", () => {
    const [, , values] = added(buildExecutorPrompt(context));
    expect(values).toContain("file, task, repo, cross-repo");
    expect(values).toContain("dependency, interface, scheduling, abandon, criteria, boundary, implementation");
    expect(values).not.toContain("reconcile");
  });

  it("says what undo.how names and that git revert is not to be relied on", () => {
    const [, , , undo] = added(buildExecutorPrompt(context));
    expect(undo).toContain("undo.how names what to change back");
    expect(undo).toContain("git revert only fits right after the change lands, so do not rely on it");
  });

  it("asks for debug only when the task's goal asks for it, with its shape", () => {
    const [, , , , debug] = added(buildExecutorPrompt(context));
    expect(debug).toContain("Report debug only when the task's goal asks for it");
    for (const field of ["choseInstead", "reproTests", "reproCommand", "reproduction", "not-expressible", "reproductionReason"]) expect(debug).toContain(field);
  });

  it("codex alone adds that its output schema needs null for what is not reported, before the final-message line", async () => {
    const f = await codexFixture("ok"); dirs.push(f.dir);
    await new CodexAdapter(f.config).execute(f.context);
    const prompt = lines((JSON.parse(await readFile(f.marker, "utf8")) as { prompt: string }).prompt);
    const final = prompt.indexOf(BEFORE.at(-1)!);
    expect(prompt[final - 1]).toContain("give decisions null");
    expect(prompt[final - 1]).toContain("null for each debug member");
    expect(lines(buildExecutorPrompt(f.context))).not.toContain(prompt[final - 1]);
  });
});

describe("the verifier does not see the report (spec §4.2)", () => {
  const core = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: ["ran"], stdoutStderrLog: "log" };
  const verifier = (execution: ExecutionResult) => buildVerifierPrompt({ contract, plan: null, execution } as unknown as AttemptContext);
  it("is byte-identical for an execution with decisions and debug and the same one without", () => {
    const decisions = [{ question: "q", chose: "c", alternatives: [], because: "b", undo: { how: "h", cost: "c", blast_radius: "r" }, scope: "file", kind: "implementation", importance: "minor" }];
    expect(verifier({ ...core, decisions, debug: { choseInstead: "x" } })).toBe(verifier(core));
    expect(verifier({ ...core, decisions })).toBe(verifier(core));
    expect(verifier({ ...core, debug: { reproTests: ["t"] } })).toBe(verifier(core));
  });
});
