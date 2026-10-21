import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop, runLoopFromState } from "../../src/controller/runLoop.js";
import type { LoopContract } from "../../src/contract/schema.js";
import { collectExecution } from "../../src/control/collect.js";
import type { AttemptContext, AttemptPlan, ExecutePhaseResult, ExecutionResult, RuntimeAdapter, VerificationResult } from "../../src/runtime/types.js";
import { fixture as optionalFixture } from "../control/optionalFixture.js";

// Failure causes (ccloop spec 2026-10-21-failure-causes-and-transient-retries-design.md §5): every failed or exhausted run
// records why, by a fixed precedence, so Orca can tell "the check failed" from "the provider was down" from "the budget
// ran out" without parsing stopReason. A wrong row here sends Orca's ladder or fallback the wrong way.
const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-cause-repo-"));
  dirs.push(repoDir);
  for (const args of [["init"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) await execFileAsync("git", args, { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

function contract(repoPath: string, options: { requiredChecks?: string[]; verifierType?: "agent" | "command"; maxAttempts?: number } = {}): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix", successCondition: "checks pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: options.maxAttempts ?? 3, perAttemptTimeoutMs: 10_000, totalRuntimeBudgetMs: 60_000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: options.verifierType ?? "agent", requiredChecks: options.requiredChecks ?? ["true"], rejectOn: ["tests fail"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

const plan: AttemptPlan = { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
const execution: ExecutionResult = { changedFiles: ["src/index.ts"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" } as ExecutionResult;
const verdict = (fields: Partial<VerificationResult>): VerificationResult => ({
  approved: false, rejectCategory: "wrong-output", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: true, evidence: [], pauseSignals: [], stopSignals: [], ...fields,
});
const withCause = <T extends object>(value: T, cause: string, retries = 0): T =>
  Object.defineProperty(value, "failureCause", { value: { cause, workObserved: false, detail: `${cause} detail`, retries }, enumerable: false });

/** An adapter whose phases are functions of the attempt. */
class Stub implements RuntimeAdapter {
  constructor(private readonly phases: { plan?: (c: AttemptContext) => Promise<AttemptPlan>; execute?: (c: AttemptContext) => Promise<ExecutePhaseResult>; verify?: (c: AttemptContext) => Promise<VerificationResult> }) {}
  plan(c: AttemptContext) { return this.phases.plan?.(c) ?? Promise.resolve(plan); }
  async execute(c: AttemptContext) {
    await writeFile(join(c.worktreePath, "src", "index.ts"), `export const value = ${c.attempt + 1};\n`);
    return this.phases.execute?.(c) ?? { ...execution };
  }
  verify(c: AttemptContext) { return this.phases.verify?.(c) ?? Promise.resolve(verdict({ approved: true, rejectCategory: "" })); }
}

async function run(adapter: RuntimeAdapter, options: Parameters<typeof contract>[1] = {}) {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-cause-run-"));
  dirs.push(runDir);
  const state = await runLoop(contract(await createRepo(), options), runDir, adapter);
  const persisted = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
  return { state, persisted };
}

describe("test 6: a failed or exhausted run records its cause by precedence", () => {
  it("row 3: a phase exception carries the adapter's classified cause, phase and retries", async () => {
    const { state, persisted } = await run(new Stub({ plan: async () => { throw withCause(new Error("codex-exit-error: x"), "provider-5xx", 3); } }));
    expect(state.status).toBe("failed");
    expect(persisted.failureCause).toEqual({ cause: "provider-5xx", phase: "plan", retries: 3, detail: "provider-5xx detail" });
  });

  it("row 3: an exception without a cause is unknown (no failed run without a cause)", async () => {
    const { state } = await run(new Stub({ execute: async () => { throw new Error("boom"); } }));
    expect([state.status, state.failureCause?.cause]).toEqual(["failed", "unknown"]);
  });

  it("row 3/4: an adapter timeout is budget-exhausted", async () => {
    const { state } = await run(new Stub({ verify: async () => { throw withCause(new Error("claude-timeout: x"), "budget-exhausted"); } }));
    expect([state.status, state.failureCause?.cause, state.failureCause?.phase]).toEqual(["failed", "budget-exhausted", "verify"]);
  });

  it("row 2: a runner-built partial carrying a cause ends with that cause", async () => {
    const partial = withCause({ ...execution, completionStatus: "partial" as const, failureType: "error" as const, failureMessage: "API error", partialOrigin: "runner" as const }, "rate-limited");
    const { state } = await run(new Stub({ execute: async () => partial }));
    expect([state.status, state.failureCause?.cause, state.failureCause?.phase]).toEqual(["failed", "rate-limited", "execute"]);
  });

  it("row 1 exhausted: the same check failing twice is required-check-failed, not budget-exhausted", async () => {
    const { state } = await run(new Stub({}), { verifierType: "command", requiredChecks: ["false"] });
    expect([state.status, state.failureCause?.cause]).toEqual(["exhausted", "required-check-failed"]);
  });

  it("row 1 exhausted at the attempt limit: a single-attempt verifier rejection is verifier-rejected", async () => {
    const { state } = await run(new Stub({ verify: async () => verdict({}) }), { maxAttempts: 1 });
    expect([state.status, state.failureCause?.cause]).toEqual(["exhausted", "verifier-rejected"]);
  });

  it("row 1 blocked_waiting_human: a second, different rejection the stop rules gate records the rejection", async () => {
    const { state } = await run(new Stub({ verify: async (c) => verdict({ rejectCategory: c.attempt === 1 ? "wrong-output" : "missing-test" }) }));
    expect([state.status, state.failureCause?.cause]).toEqual(["blocked_waiting_human", "verifier-rejected"]);
  });

  // Round 2 I-B: the budget/attempt stop at the top of the loop, right after a persisted rejection, keeps the rejection's
  // category. Driven from a persisted state, exactly what a crash resume between the rejection and that check reads.
  it.each([
    [[{ rejectCategory: "required-check-failed", primaryTargetPaths: ["src/index.ts"], failingCommand: "false" }], "required-check-failed"],
    [[{ rejectCategory: "wrong-output", primaryTargetPaths: [], failingCommand: null }], "verifier-rejected"],
    [[], "budget-exhausted"],
  ])("row 1 via the top-of-loop stop after a persisted rejection %j => %s", async (recentFailures, cause) => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-cause-run-"));
    dirs.push(runDir);
    const persisted = { status: "planning" as const, currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: new Date().toISOString(), waitingOnHuman: false,
      stopReason: "retry", budgetSnapshot: { attemptsRemaining: 0, timeRemainingMs: 50_000, tokenBudgetRemaining: 900 }, recentFailures };
    const state = await runLoopFromState(contract(await createRepo(), { maxAttempts: 1 }), runDir, new Stub({}), persisted);
    expect([state.status, state.failureCause?.cause]).toEqual(["exhausted", cause]);
  });

  it("row 6: a success records no cause", async () => {
    const { state, persisted } = await run(new Stub({}));
    expect(state.status).toBe("succeeded");
    expect(persisted).not.toHaveProperty("failureCause");
  });
});

describe("test 7: collect exposes the cause at top level and keeps both terminal shapes", () => {
  it.each([3, 4])("protocol %s: terminal without the cause, failureCause beside it", async (protocol) => {
    const { root, envelope } = await optionalFixture();
    await mkdir(join(root, "control")); await mkdir(join(root, "run"));
    const state = { status: "failed", currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-10-21T00:00:00Z", waitingOnHuman: false, stopReason: "x", budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 10, tokenBudgetRemaining: 0 }, recentFailures: [] };
    const failureCause = { cause: "provider-5xx", phase: "plan", retries: 3, detail: null };
    const candidate = { groupId: "g", workItemId: "w", taskId: "t", runId: "r", generation: 1, graphVersion: 1, targetVersion: 1, checkpointId: "c", usageHighWater: 0, result: "failed", artifacts: [], snapshot: null, missing: [], unresolvedRequestIds: [], stopProof: null, terminalOutcome: "failed", handoff: { artifactId: "h", hash: "a".repeat(64) } };
    await writeFile(join(root, "run", "loop-state.json"), JSON.stringify({ ...state, failureCause }), { mode: 0o600 });
    await writeFile(join(root, "control", "candidate.json"), JSON.stringify(candidate), { mode: 0o600 });
    const result = await collectExecution({ ...envelope, protocol } as typeof envelope, 0);
    expect(result.terminal).toEqual(state);
    expect(result.failureCause).toEqual(failureCause);
  });
});
