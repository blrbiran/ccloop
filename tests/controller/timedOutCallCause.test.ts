import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import type { LoopContract } from "../../src/contract/schema.js";
import type { AttemptContext, AttemptPlan, ExecutePhaseResult, RuntimeAdapter, VerificationResult } from "../../src/runtime/types.js";

// Orca issue #262: a codex execute stopped by the idle watchdog (`stalled`) while the phase timeout fired ended the run
// `exhausted` with failureCause `budget-exhausted`, so Orca told the person the budget was too small and retried a network
// stall as a spent budget. The call's own cause is the answer; the timeout stays the run's trigger (status and stop reason).
const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-262-repo-"));
  dirs.push(repoDir);
  for (const args of [["init"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) await execFileAsync("git", args, { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

function contract(repoPath: string): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix", successCondition: "checks pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 300, totalRuntimeBudgetMs: 60_000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["tests fail"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

const plan: AttemptPlan = { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
const withCause = <T extends object>(value: T, cause: string, retries = 0): T =>
  Object.defineProperty(value, "failureCause", { value: { cause, workObserved: true, detail: `${cause} detail`, retries }, enumerable: false });

/** An execute that outlives the phase timeout and, once aborted, fails with `cause` attached (or answers null). */
class TimedOut implements RuntimeAdapter {
  constructor(private readonly cause: string | null) {}
  plan() { return Promise.resolve(plan); }
  async execute(c: AttemptContext): Promise<ExecutePhaseResult> {
    await new Promise<void>((resolve) => { if (c.abortSignal?.aborted) resolve(); else c.abortSignal?.addEventListener("abort", () => resolve(), { once: true }); });
    if (this.cause === null) return null as unknown as ExecutePhaseResult;
    throw withCause(new Error(`codex-${this.cause}: evidence`), this.cause, 1);
  }
  verify(): Promise<VerificationResult> { throw new Error("verify must not run"); }
}

async function run(adapter: RuntimeAdapter) {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-262-run-"));
  dirs.push(runDir);
  const state = await runLoop(contract(await createRepo()), runDir, adapter);
  const persisted = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
  return { state, persisted };
}

describe("Orca #262: an execute timeout keeps the cause its call recorded", () => {
  it.each(["stalled", "network"])("a call that ended %s before the timeout reached it records that cause, not budget-exhausted", async (cause) => {
    const { state, persisted } = await run(new TimedOut(cause));
    expect(state.status).toBe("exhausted");
    expect(state.stopReason).toBe("execute phase exceeded per-attempt timeout of 300ms");
    expect(persisted.failureCause).toEqual({ cause, phase: "execute", retries: 1, detail: `${cause} detail` });
  }, 30_000);

  it.each([["no call cause", null], ["a call cause of unknown", "unknown"], ["a call cause of budget-exhausted", "budget-exhausted"]])(
    "%s keeps row 4: budget-exhausted with no phase", async (_label, cause) => {
      const { state, persisted } = await run(new TimedOut(cause));
      expect(state.status).toBe("exhausted");
      expect(persisted.failureCause).toEqual({ cause: "budget-exhausted", phase: null, retries: 0, detail: null });
    }, 30_000);
});
