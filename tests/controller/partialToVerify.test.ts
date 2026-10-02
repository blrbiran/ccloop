// Crash resume (2026-10-02), spec §5.1 (R-B), criterion T11. Measured with real claude (Orca N1 paid run): under
// acceptEdits the executor could not run `npm test`, wrote the file, answered `completionStatus: partial`,
// `failureType: error`, and the loop ended `failed` at once although ccloop's own verify phase would have run the
// required checks. claude's own `error` partial that changed files is now judged by verify; every other partial keeps
// today's terminal decision. The verifier here is "command", so the required checks alone decide.
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import type { LoopContract } from "../../src/contract/schema.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import type { ExecutionResult, PartialExecutionResult, VerificationResult } from "../../src/runtime/types.js";

const execFileAsync = promisify(execFile);
const BUDGET_EXHAUSTED_REASON = "runtime or token budget exhausted";

async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

function createContract(repoPath: string, requiredChecks: string[], tokenBudget = 1000): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix test", successCondition: "required checks pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 10_000, totalRuntimeBudgetMs: 60_000, tokenBudget, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "command", requiredChecks, rejectOn: ["tests fail"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

// A command verifier never asks the adapter; this answer would approve if it were consulted.
const unusedVerification: VerificationResult = {
  approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [],
};

const ownErrorPartial: PartialExecutionResult = {
  changedFiles: ["src/index.ts"],
  diffPatch: "diff --git a/src/index.ts b/src/index.ts",
  commandOutputs: [],
  stdoutStderrLog: "",
  completionStatus: "partial",
  failureType: "error",
  failureMessage: "tests could not be run",
};

async function runWith(execution: ExecutionResult, requiredChecks: string[], tokenBudget?: number) {
  const repoPath = await createRepo();
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  const adapter = new ScriptedAdapter([
    { plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] }, execution, verification: unusedVerification },
  ]);
  const finalState = await runLoop(createContract(repoPath, requiredChecks, tokenBudget), runDir, adapter);
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; detail: string });
  const verifyPath = join(runDir, "attempts", "1", "verify.json");
  const verify = await access(verifyPath).then(async () => JSON.parse(await readFile(verifyPath, "utf8")) as VerificationResult, () => null);
  return { finalState, events, types: events.map((event) => event.type), verify };
}

describe("claude's own partial error with changed files goes to verify (spec 2026-10-02 §5.1, T11)", () => {
  it("T11a: claude's own partial error with changed files goes to verify and succeeds when checks pass", async () => {
    const { finalState, events, types, verify } = await runWith(ownErrorPartial, ["true"]);
    expect(finalState.status).toBe("succeeded");
    expect(types).toEqual(["loop_planning", "attempt_started", "execute_started", "partial_execute_sent_to_verify", "execution_finished", "loop_succeeded"]);
    expect(events.find((event) => event.type === "partial_execute_sent_to_verify")?.detail)
      .toBe("failureType error, 1 changed file(s): tests could not be run");
    expect(verify).toMatchObject({ approved: true, failingCommand: null });
  }, 30_000);

  // Spec §5.1: after verify, today's stop decision applies unchanged -- a failed required check is not safe to retry.
  it("T11b: a failing required check gives today's stop decision", async () => {
    const { finalState, types, verify } = await runWith(ownErrorPartial, ["false"]);
    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("verifier rejection with no safe retry path");
    expect(types).toEqual(["loop_planning", "attempt_started", "execute_started", "partial_execute_sent_to_verify", "execution_finished", "loop_failed"]);
    expect(verify).toMatchObject({ approved: false, failingCommand: "false", safeToRetry: false });
  }, 30_000);

  it("T11c: no changed files ⇒ failed without verify", async () => {
    const { finalState, types, verify } = await runWith({ ...ownErrorPartial, changedFiles: [], diffPatch: "" }, ["true"]);
    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("tests could not be run");
    expect(types).toEqual(["loop_planning", "attempt_started", "execute_started", "loop_failed"]);
    expect(verify).toBeNull();
  }, 30_000);

  it("T11d: a runner-built partial (partialOrigin runner) ⇒ failed without verify", async () => {
    const { finalState, types, verify } = await runWith({ ...ownErrorPartial, partialOrigin: "runner", failureMessage: "Error: claude exited with code 1" }, ["true"]);
    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("Error: claude exited with code 1");
    expect(types).toEqual(["loop_planning", "attempt_started", "execute_started", "loop_failed"]);
    expect(verify).toBeNull();
  }, 30_000);

  it("T11e: timeout partial ⇒ exhausted, unchanged", async () => {
    const { finalState, types, verify } = await runWith({ ...ownErrorPartial, failureType: "timeout", failureMessage: "ran out of time" }, ["true"]);
    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe("ran out of time");
    expect(types).toEqual(["loop_planning", "attempt_started", "execute_started", "loop_exhausted"]);
    expect(verify).toBeNull();
  }, 30_000);

  // Spec §5.1 and review I8: the fall-through takes the budget check a complete execution takes, before verify.
  it("T11f: budget exceeded after execute ⇒ exhausted before verify", async () => {
    const { finalState, types, verify } = await runWith({ ...ownErrorPartial, tokenUsage: 5000 }, ["true"], 1000);
    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe(BUDGET_EXHAUSTED_REASON);
    expect(finalState.budgetSnapshot.tokenBudgetRemaining).toBe(0);
    expect(types).toEqual(["loop_planning", "attempt_started", "execute_started", "partial_execute_sent_to_verify", "loop_exhausted"]);
    expect(verify).toBeNull();
  }, 30_000);
});
