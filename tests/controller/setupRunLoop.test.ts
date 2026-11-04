import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { prepareContinuationContract } from "../../src/control/materialize.js";
import { runLoop, type RunControlHooks } from "../../src/controller/runLoop.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import type { AttemptContext, AttemptPlan, ExecutePhaseResult, RuntimeAdapter, VerificationResult } from "../../src/runtime/types.js";
import { buildBundle } from "../control/optionalMaterializeFixture.js";
import { createContract, createRepo } from "./optionalFixture.js";

// Task setup commands (spec 2026-11-04 §4.4): setup runs in every attempt after the worktree exists (and after a
// continuation's predecessor tree is restored into it) and before the agent's first phase. A setup that fails ends the
// run `setup-failed` without any agent call -- the same command would fail again, and an agent working in a half-prepared
// tree only spends money on errors the task did not ask it to fix.
const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A scripted adapter that counts its calls and records, when plan starts, whether a path exists in the worktree. */
class Recording extends ScriptedAdapter {
  calls = 0;
  sawAtPlan: boolean | null = null;
  constructor(private readonly probe: string | null = null) {
    super([{
      plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
      execution: { changedFiles: ["src/index.ts"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" },
      verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] },
    }]);
  }
  override async plan(context: AttemptContext): Promise<AttemptPlan> {
    this.calls += 1;
    if (this.probe !== null) this.sawAtPlan = existsSync(join(context.worktreePath, this.probe));
    return super.plan(context);
  }
  override async execute(context: AttemptContext): Promise<ExecutePhaseResult> { this.calls += 1; return super.execute(context); }
  override async verify(context: AttemptContext): Promise<VerificationResult> { this.calls += 1; return super.verify(context); }
}

async function repoWithIgnores(): Promise<string> {
  const repo = await createRepo();
  dirs.push(repo);
  await writeFile(join(repo, ".gitignore"), "node_modules_marker\nnode_modules/\n");
  await execFileAsync("git", ["add", ".gitignore"], { cwd: repo });
  await execFileAsync("git", ["commit", "-qm", "ignores"], { cwd: repo });
  return repo;
}

async function runWith(setupCommands: string[] | undefined, adapter: RuntimeAdapter, hooks?: RunControlHooks, perAttemptTimeoutMs?: number) {
  const repo = await repoWithIgnores();
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-setup-run-"));
  dirs.push(runDir);
  const contract = createContract(repo, ["true"]);
  if (setupCommands !== undefined) contract.context.setupCommands = setupCommands;
  if (perAttemptTimeoutMs !== undefined) contract.executionPolicy.perAttemptTimeoutMs = perAttemptTimeoutMs;
  const state = await runLoop(contract, runDir, adapter, hooks);
  const persisted = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
  return { state, persisted, runDir };
}

const run = (setupCommands: string[] | undefined, adapter: RuntimeAdapter) => runWith(setupCommands, adapter);

async function events(runDir: string): Promise<Array<{ type: string; detail: string }>> {
  return (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

describe("setup commands in runLoop", () => {
  it("setup runs before the plan phase", async () => {
    const adapter = new Recording("node_modules_marker");
    const { state } = await run(["echo s > node_modules_marker"], adapter);
    expect(adapter.sawAtPlan).toBe(true);
    expect(state.status).toBe("succeeded");
  });

  it("a failing setup ends the run setup-failed with no agent call", async () => {
    const adapter = new Recording();
    const { state, persisted, runDir } = await run(["exit 2"], adapter);
    expect(state.status).toBe("failed");
    expect(persisted.status).toBe("failed");
    expect(persisted.failureCause).toEqual({ cause: "setup-failed", phase: "setup", retries: 0, detail: "exit 2 exit=2" });
    expect(adapter.calls).toBe(0);
    expect(persisted.attemptsUsed).toBe(1);
    expect(existsSync(join(runDir, "attempts", "1", "setup-1.log"))).toBe(true);
  });

  it("the attempt worktree is removed after a setup failure", async () => {
    const { runDir } = await run(["exit 2"], new Recording());
    expect(existsSync(join(runDir, "worktrees", "attempt-1"))).toBe(false);
  });

  it("a setup that writes a non-ignored file ends the run setup-failed naming it", async () => {
    const adapter = new Recording();
    const { persisted } = await run(["echo x > stray.txt"], adapter);
    expect(persisted.failureCause).toEqual({ cause: "setup-failed", phase: "setup", retries: 0, detail: "echo x > stray.txt changed: stray.txt" });
    expect(adapter.calls).toBe(0);
  });

  it("absent setupCommands runs no setup", async () => {
    const { state, runDir } = await run(undefined, new Recording());
    expect(state.status).toBe("succeeded");
    expect(existsSync(join(runDir, "attempts", "1", "setup-1.log"))).toBe(false);
  });

  // Fix round 1 ruling: setup's measured time comes off the remaining time before the first phase.
  it("setup's elapsed time is deducted before the plan phase", async () => {
    let remainingAtPlan: number | null = null;
    const adapter = new Recording();
    const plan = adapter.plan.bind(adapter);
    adapter.plan = async (context) => { remainingAtPlan = context.state.budgetSnapshot.timeRemainingMs; return plan(context); };
    await run(["sleep 0.5"], adapter);
    expect(remainingAtPlan).not.toBeNull();
    expect(remainingAtPlan!).toBeLessThanOrEqual(60_000 - 500);
  });

  // Fix round 1 (Review Focus 3): a handoff during setup ends the way a phase interrupted by a handoff does -- a boundary
  // event, the run left resumable for the handoff, no agent call -- not as a failed run.
  it("a handoff deadline during setup ends at the handoff boundary, not failed", async () => {
    const adapter = new Recording();
    const phaseAbort = new AbortController();
    setTimeout(() => phaseAbort.abort(), 300);
    const { state, persisted, runDir } = await runWith(["sleep 5"], adapter, { phaseSignal: phaseAbort.signal });
    expect(adapter.calls).toBe(0);
    expect(persisted.status).toBe("planning");
    expect(state.failureCause).toBeUndefined();
    expect((await events(runDir)).at(-1)).toMatchObject({ type: "handoff_interrupted", detail: "handoff deadline interrupted setup in attempt 1" });
  });

  it("a handoff latched at a setup registration ends at the handoff boundary", async () => {
    const adapter = new Recording();
    const stopRequested = { requested: false };
    const { persisted, runDir } = await runWith(["true"], adapter, {
      stopRequested,
      onProcessRegistered: async () => { stopRequested.requested = true; throw new Error("control-handoff-latched-before-prompt"); },
    });
    expect(adapter.calls).toBe(0);
    expect(persisted.status).toBe("planning");
    expect((await events(runDir)).at(-1)).toMatchObject({ type: "handoff_boundary", detail: "handoff requested during setup in attempt 1" });
  });

  it("a refused setup registration with no handoff ends the run failed as for a phase", async () => {
    const adapter = new Recording();
    const { persisted, runDir } = await runWith(["true"], adapter, {
      onProcessRegistered: async () => { throw new Error("control-handoff-latched-before-prompt"); },
    });
    expect(adapter.calls).toBe(0);
    expect(persisted.status).toBe("failed");
    expect(persisted.failureCause).toEqual({ cause: "unknown", phase: null, retries: 0, detail: null });
    expect(existsSync(join(runDir, "worktrees", "attempt-1"))).toBe(false);
  });

  it("each setup command's process group is registered", async () => {
    const registered: Array<{ phase: string; pid: number; pgid: number }> = [];
    const { state } = await runWith(["true"], new Recording(), { onProcessRegistered: async (registration) => { registered.push(registration); } });
    expect(state.status).toBe("succeeded");
    expect(registered.filter((entry) => entry.phase === "setup")).toHaveLength(1);
  });

  // Final-review M1: a handoff requested while setup ran stops at the boundary after setup -- the agent's first phase
  // would otherwise start (and cost) after the operator asked the run to hand off.
  it("a handoff requested during a setup that passes ends at the boundary after setup", async () => {
    const adapter = new Recording();
    const stopRequested = { requested: false };
    const { persisted, runDir } = await runWith(["true"], adapter, {
      stopRequested,
      onProcessRegistered: async () => { stopRequested.requested = true; },
    });
    expect(adapter.calls).toBe(0);
    expect(persisted.status).toBe("planning");
    expect((await events(runDir)).at(-1)).toMatchObject({ type: "handoff_boundary", detail: "handoff requested after setup in attempt 1" });
  });

  // Final-review M2 ruling: a setup stopped by the attempt's time (not its own 15-minute cap) is the attempt out of
  // time -- the operator sees the budget-exhausted reason, as for a phase that ran out of time.
  it("a setup that runs out of the attempt's time ends exhausted, not setup-failed", async () => {
    const adapter = new Recording();
    const { persisted, runDir } = await runWith(["sleep 5"], adapter, undefined, 400);
    expect(adapter.calls).toBe(0);
    expect(persisted.status).toBe("exhausted");
    expect(persisted.stopReason).toBe("runtime or token budget exhausted");
    expect(persisted.failureCause).toEqual({ cause: "budget-exhausted", phase: null, retries: 0, detail: null });
    expect(existsSync(join(runDir, "worktrees", "attempt-1"))).toBe(false);
  });

  // Final-review M6: a command may be 4096 characters; the cause Orca shows is bounded like every other cause detail.
  it("a failing 4096-character setup command's cause detail is at most 512 bytes", async () => {
    const command = `exit 3 #${"x".repeat(4096 - 8)}`;
    expect(command).toHaveLength(4096);
    const { persisted } = await run([command], new Recording());
    expect(persisted.failureCause.cause).toBe("setup-failed");
    expect(persisted.failureCause.detail.startsWith("exit 3 #xxx")).toBe(true);
    expect(Buffer.byteLength(persisted.failureCause.detail)).toBeLessThanOrEqual(512);
  });

  describe("a continuation", () => {
    async function continuation(setupCommands: string[]) {
      const h = await buildBundle();
      dirs.push(h.root);
      const contract: LoopContract = {
        objective: { taskId: "resume", goal: "continue", successCondition: "done", nonGoals: [] },
        context: { repoPath: h.targetRepo, targetPaths: ["tracked.txt"], relevantDocs: [], buildTestCommands: ["true"], constraints: [], setupCommands },
        executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 10_000, totalRuntimeBudgetMs: 20_000, tokenBudget: 100, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 0 },
        safetyPolicy: { allowlistPaths: [], denylistPaths: [], maxFilesTouched: 20, humanGateConditions: [] },
        verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["failure"], evidenceRequired: [] },
        escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
      };
      const prepared = await prepareContinuationContract(contract, h.runDir, h.input);
      let planCalls = 0;
      const adapter: RuntimeAdapter = {
        plan: async () => { planCalls += 1; throw new Error("stop after plan started"); },
        execute: async () => { throw new Error("execute should not run"); },
        verify: async () => { throw new Error("verify should not run"); },
      };
      await runLoop(prepared, h.runDir, () => adapter, { firstWorkspaceInput: h.input });
      const persisted = JSON.parse(await readFile(join(h.runDir, "loop-state.json"), "utf8"));
      return { planCalls, persisted };
    }

    // The restored tree is dirty against HEAD (staged and unstaged edits, untracked files): setup is judged by what it
    // changed, not by whether the tree is clean.
    it("a continuation's restored tree passes when setup writes only ignored files", async () => {
      const { planCalls, persisted } = await continuation(["echo more >> ignored.txt"]);
      expect(planCalls).toBe(1);
      expect(persisted.failureCause?.cause).not.toBe("setup-failed");
    });

    it("a continuation's setup that changes a restored tracked file fails naming it", async () => {
      const { planCalls, persisted } = await continuation(["echo more >> tracked.txt"]);
      expect(planCalls).toBe(0);
      expect(persisted.failureCause).toEqual({ cause: "setup-failed", phase: "setup", retries: 0, detail: "echo more >> tracked.txt changed: tracked.txt" });
    });
  });
});
