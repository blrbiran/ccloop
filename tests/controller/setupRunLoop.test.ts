import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { prepareContinuationContract } from "../../src/control/materialize.js";
import { runLoop } from "../../src/controller/runLoop.js";
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

async function run(setupCommands: string[] | undefined, adapter: RuntimeAdapter) {
  const repo = await repoWithIgnores();
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-setup-run-"));
  dirs.push(runDir);
  const contract = createContract(repo, ["true"]);
  if (setupCommands !== undefined) contract.context.setupCommands = setupCommands;
  const state = await runLoop(contract, runDir, adapter);
  const persisted = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
  return { state, persisted, runDir };
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
