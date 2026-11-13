import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as IdleWatchModule from "../../src/runtime/idleWatch.js";

// The two-minute limit, shortened so a silence fits in a test; runLoop reads the limit from this export.
vi.mock("../../src/runtime/idleWatch.js", async (importOriginal) => ({ ...await importOriginal<typeof IdleWatchModule>(), IDLE_CHARGE_LIMIT_MS: 300 }));

import { runLoop } from "../../src/controller/runLoop.js";
import type { LoopContract } from "../../src/contract/schema.js";
import type { AttemptContext, AttemptPlan, ExecutePhaseResult, ExecutionResult, RuntimeAdapter, VerificationResult } from "../../src/runtime/types.js";

// Working time (Orca issue #262; human, Orca session d467cbd2, 2026-11-13: 「时间预算只算真正在干活的时间」). A ~600 s network
// stall during execute was charged in full against the run's time budget, so one stall could spend the budget and end the
// run. The phase is now charged its wall clock less the idle its agent processes recorded (silence with no tool open, beyond
// the limit); used.activeMs (onPhaseSettled -> the usage ledger) and timeRemainingMs move by that same figure, so the next
// call's deadline, derived from timeRemainingMs, agrees with what the person is told was used.
const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const BUDGET_MS = 600_000;

async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-worktime-repo-"));
  dirs.push(repoDir);
  for (const args of [["init"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) await execFileAsync("git", args, { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

function contract(repoPath: string, perAttemptTimeoutMs: number): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix", successCondition: "checks pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs, totalRuntimeBudgetMs: BUDGET_MS, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["tests fail"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

const plan: AttemptPlan = { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
const execution: ExecutionResult = { changedFiles: ["src/index.ts"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" } as ExecutionResult;
const approved: VerificationResult = { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: true, evidence: [], pauseSignals: [], stopSignals: [] };
const stalled = (error: Error): Error =>
  Object.defineProperty(error, "failureCause", { value: { cause: "stalled", workObserved: true, detail: "stalled detail", retries: 0 }, enumerable: false });

/** An adapter whose execute plays an agent process against the phase's ledger, as the adapters' IdleWatch does. */
class Agent implements RuntimeAdapter {
  wallMs = 0;
  constructor(private readonly play: (c: AttemptContext) => Promise<void>) {}
  plan() { return Promise.resolve(plan); }
  async execute(c: AttemptContext): Promise<ExecutePhaseResult> {
    const started = Date.now();
    await writeFile(join(c.worktreePath, "src", "index.ts"), "export const value = 2;\n");
    try { await this.play(c); } finally { this.wallMs = Date.now() - started; }
    return { ...execution };
  }
  verify() { return Promise.resolve(approved); }
}

async function run(adapter: Agent, perAttemptTimeoutMs = 30_000) {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-worktime-run-"));
  dirs.push(runDir);
  const settled: { phase: string; elapsedMs: number }[] = [];
  const state = await runLoop(contract(await createRepo(), perAttemptTimeoutMs), runDir, adapter,
    { onPhaseSettled: async (e) => { settled.push({ phase: e.phase, elapsedMs: e.elapsedMs }); } });
  const persisted = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
  const execute = settled.filter((s) => s.phase === "execute");
  expect(execute).toHaveLength(1);
  // timeRemainingMs moves by exactly what used.activeMs is told: the phases' charged figures, nothing else.
  expect(BUDGET_MS - state.budgetSnapshot.timeRemainingMs).toBe(settled.reduce((sum, s) => sum + s.elapsedMs, 0));
  return { state, persisted, executeMs: execute[0]!.elapsedMs };
}

describe("Orca #262: a phase is charged only the time its agent was working", () => {
  it("a 1.5 s silence inside the agent process is charged only up to the limit", async () => {
    const adapter = new Agent(async (c) => {
      c.idleLedger!.start(); c.idleLedger!.mark(0);
      await sleep(1_500);
      c.idleLedger!.mark(0); c.idleLedger!.stop();
    });
    const { state, executeMs } = await run(adapter);
    expect(state.status).toBe("succeeded");
    expect(adapter.wallMs).toBeGreaterThanOrEqual(1_500);
    // Wall clock less (1.5 s - 0.3 s): the silence is charged 0.3 s.
    expect(executeMs).toBeLessThan(adapter.wallMs - 1_000);
  }, 30_000);

  it("a busy agent (an observation every 0.1 s for 1.5 s) is charged its wall clock, as before", async () => {
    const adapter = new Agent(async (c) => {
      c.idleLedger!.start();
      for (let i = 0; i < 15; i++) { await sleep(100); c.idleLedger!.mark(0); }
      c.idleLedger!.stop();
    });
    const { executeMs } = await run(adapter);
    expect(executeMs).toBeGreaterThanOrEqual(adapter.wallMs);
  }, 30_000);

  it("a 1.5 s silence with a tool open (a silent test run) is working time", async () => {
    const adapter = new Agent(async (c) => {
      c.idleLedger!.start(); c.idleLedger!.mark(1);
      await sleep(1_500);
      c.idleLedger!.mark(0); c.idleLedger!.stop();
    });
    const { executeMs } = await run(adapter);
    expect(executeMs).toBeGreaterThanOrEqual(adapter.wallMs);
  }, 30_000);

  it("ccloop's own work after the agent process stopped is charged in full", async () => {
    const adapter = new Agent(async (c) => {
      c.idleLedger!.start(); c.idleLedger!.mark(0); c.idleLedger!.stop();
      await sleep(1_500);
    });
    const { executeMs } = await run(adapter);
    expect(executeMs).toBeGreaterThanOrEqual(adapter.wallMs);
  }, 30_000);

  it("a stall the watchdog stopped still fails as stalled, and is charged only up to the limit", async () => {
    const adapter = new Agent(async (c) => {
      c.idleLedger!.start(); c.idleLedger!.mark(0);
      await sleep(1_500);
      c.idleLedger!.stop();
      throw stalled(new Error("codex-stalled: evidence"));
    });
    const { state, persisted, executeMs } = await run(adapter);
    expect(state.status).toBe("failed");
    expect(persisted.failureCause).toMatchObject({ cause: "stalled", phase: "execute" });
    expect(executeMs).toBeLessThan(adapter.wallMs - 1_000);
  }, 30_000);

  it("the tester's shape: a stall the phase timeout reached keeps cause stalled and is charged its working time, not the window", async () => {
    const adapter = new Agent(async (c) => {
      c.idleLedger!.start(); c.idleLedger!.mark(0);
      await new Promise<void>((resolve) => { if (c.abortSignal?.aborted) resolve(); else c.abortSignal?.addEventListener("abort", () => resolve(), { once: true }); });
      c.idleLedger!.stop();
      throw stalled(new Error("codex-stalled: evidence"));
    });
    const { state, persisted, executeMs } = await run(adapter, 1_500);
    expect(state.status).toBe("exhausted");
    expect(persisted.failureCause).toMatchObject({ cause: "stalled", phase: "execute" });
    // The 1.5 s window was silent: charged about the 0.3 s limit, far under the window that used to be its floor.
    expect(executeMs).toBeLessThan(1_000);
  }, 30_000);
});
