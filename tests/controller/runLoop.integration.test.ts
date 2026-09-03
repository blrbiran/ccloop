import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupAttemptWorkspaceBestEffort, createLeaseLossSignal, createStopRequestSignal, parseChangedPathsFromGitStatus, runLoop, runLoopFromState } from "../../src/controller/runLoop.js";
import { createAttemptWorkspace } from "../../src/workspace/worktreeManager.js";
import { initializeRunFiles, writeOwnerRecord } from "../../src/persistence/fileStore.js";
import { RunHeartbeatStoppedError, RunLeaseLostError } from "../../src/ownership/lease.js";
import type { LeaseHeartbeat } from "../../src/controller/leaseHeartbeat.js";
import { evaluateResumeEligibility, resumeLoop } from "../../src/controller/resumeLoop.js";
import { SubprocessClaudeAdapter } from "../../src/runtime/claude/subprocessClaudeAdapter.js";
import type { LoopContract } from "../../src/contract/schema.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import { buildProcessInstanceId } from "../../src/runtime/processIdentity.js";
import { evaluateRunBoundary } from "../../src/stop/stopController.js";
import type { AttemptContext, OwnerRecord, OwnerTransferRecord, ReconciliationRecord, RuntimeAdapter } from "../../src/runtime/types.js";
import type { RunState } from "../../src/state/types.js";

const execFileAsync = promisify(execFile);
const phaseRunnerPath = fileURLToPath(new URL("../../scripts/claude-phase-runner.mjs", import.meta.url));

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

async function createUsageAwareFakeClaude(): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), "ccloop-controller-claude-bin-"));
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? "";
let structured_output;
let usage;
if (prompt.includes("Plan one isolated L2 attempt")) {
  structured_output = { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
  usage = { input_tokens: 100, output_tokens: 10, inputTokens: 999, secretSentinel: "DO_NOT_PERSIST" };
} else if (prompt.includes("Execute one isolated attempt")) {
  structured_output = { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" };
  usage = { inputTokens: 200, outputTokens: 20, unknown_usage: 777 };
} else {
  structured_output = { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["verified"], pauseSignals: [], stopSignals: [] };
  usage = { input_tokens: 300, outputTokens: 30 };
}
process.stdout.write(JSON.stringify({ structured_output, usage }));
`);
  await chmod(claudePath, 0o755);
  return binDir;
}

function createContract(repoPath: string): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix test", successCondition: "required checks pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["tests fail"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

async function readEventTypes(runDir: string): Promise<string[]> {
  const contents = await readFile(join(runDir, "events.jsonl"), "utf8");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).type as string);
}

async function readEventDetails(runDir: string, type: string): Promise<string[]> {
  const contents = await readFile(join(runDir, "events.jsonl"), "utf8");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; detail: string })
    .filter((event) => event.type === type)
    .map((event) => event.detail);
}

async function readRunState(runDir: string): Promise<RunState> {
  return JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as RunState;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return;
  }

  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// For the tests that assert the BUDGET_EXHAUSTED side of an execute timeout.
//
// getPhaseTimeoutMs clamps the phase timeout to min(perAttemptTimeoutMs, timeRemainingMs), so
// once totalRuntimeBudgetMs is 20 the execute timeout IS the remaining budget — raising
// perAttemptTimeoutMs cannot separate them. The controller then charges the measured elapsed
// time back against that same budget, so the two land on the same millisecond and a single
// millisecond decides the stop reason.
//
// The observable is that a setTimeout(N) which has already fired can be measured as N-1 ms of
// elapsed time by Date.now(). Only that is claimed here: it was observed directly, whereas the
// cause is not established from this repo — 1ms truncation across two Date.now() reads predicts
// the same observable as any difference in clock source, and nothing in this codebase
// distinguishes them. One leftover millisecond makes hasBudgetExceeded's `=== 0` false, so the
// per-attempt-timeout reason wins instead of BUDGET_EXHAUSTED_REASON.
//
// Because the execute phase is awaited with awaitAbortedResult, whatever the adapter does after
// the abort is included in the elapsed time. So the adapter spends the flush window the
// controller's own prompt promises it after an abort — partialOutcomeRecoveryWindowMs, read
// from the contract below rather than duplicated as a literal. The margin
// (elapsed - remaining budget) therefore has a floor of that window minus the <=1ms skew,
// structurally ~9ms, instead of hovering at 0. That floor is the load-bearing claim; the
// measured bands are hardware-dependent and are recorded only as observations, with their
// sample sizes, because a band is only as wide as the number of draws behind it: without the
// flush, -1..+3ms over 20 samples here and -1..+4ms elsewhere; with it, +11..+15ms over 160
// samples here and +10..+13ms elsewhere. The coupling runs the other way too, deliberately: a
// contract that set the
// window to 0 would put these tests back on the knife edge, and that is visible here instead of
// buried in a constant.
//
// It does not weaken the assertion: the budget must still reach exactly 0 for these tests to
// pass, and mutating the budget path still turns every one of them red.
async function waitForAbortThenFlush(context: AttemptContext): Promise<void> {
  await waitForAbort(context.abortSignal);
  await delay(context.contract.executionPolicy.partialOutcomeRecoveryWindowMs);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function makeRunState(status: RunState["status"]): RunState {
  return {
    status,
    currentAttempt: 1,
    attemptsUsed: 1,
    lastTransitionAt: "2026-07-21T10:00:00.000Z",
    waitingOnHuman: false,
    stopReason: null,
    budgetSnapshot: {
      attemptsRemaining: 2,
      timeRemainingMs: 5_000,
      tokenBudgetRemaining: 1_000,
    },
    recentFailures: [],
  };
}

function successFrame() {
  return {
    plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
    execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
    verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["npm test passed"], pauseSignals: [], stopSignals: [] },
  };
}

async function seedRunWithLiveAttemptWorktree(): Promise<{ runDir: string; repoPath: string; worktreePath: string }> {
  const repoPath = await createRepo();
  const contract = createContract(repoPath);
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  await initializeRunFiles(runDir, contract, makeRunState("executing"));
  const { worktreePath } = await createAttemptWorkspace(repoPath, runDir, 1);
  return { runDir, repoPath, worktreePath };
}

describe("evaluateRunBoundary", () => {
  it("routes to no_progress when strong progress stops and weak progress is exhausted without stale evidence", () => {
    const result = evaluateRunBoundary({
      now: "2026-07-21T10:10:00.000Z",
      previous: {
        status: "weakly_progressing",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: null,
        staleCandidateReason: null,
      },
      runState: makeRunState("executing"),
      observedStrongProgress: false,
      observedWeakProgress: false,
      continuitySuspicion: [],
    });

    expect(result.status).toBe("no_progress");
    expect(result.suspectReason).toBe("weak progress exhausted without strong progress");
  });

  it("routes to stale_candidate when continuity suspicion outranks generic no-progress", () => {
    const result = evaluateRunBoundary({
      now: "2026-07-21T10:10:00.000Z",
      previous: {
        status: "suspect",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: null,
        suspectReason: "healthy window exceeded",
        staleCandidateReason: null,
      },
      runState: makeRunState("executing"),
      observedStrongProgress: false,
      observedWeakProgress: false,
      continuitySuspicion: ["state freshness mismatch"],
    });

    expect(result.status).toBe("stale_candidate");
    expect(result.staleCandidateReason).toContain("state freshness mismatch");
  });
});

describe("parseChangedPathsFromGitStatus", () => {
  it("returns destination paths for rename and copy porcelain -z records", () => {
    const statusOutput = [
      "R  renamed file.ts",
      "original file.ts",
      "C  copied file.ts",
      "source file.ts",
      " M modified.ts",
      '?? quote "name".ts',
      "",
    ].join("\0");

    expect(parseChangedPathsFromGitStatus(statusOutput)).toEqual([
      "renamed file.ts",
      "copied file.ts",
      "modified.ts",
      'quote "name".ts',
    ]);
  });
});

describe("runLoop", () => {
  it("succeeds when verification approves", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
        verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["npm test passed"], pauseSignals: [], stopSignals: [] },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);

    expect(finalState.status).toBe("succeeded");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(await readEventTypes(runDir)).toEqual([
      "loop_planning",
      "attempt_started",
      "execute_started",
      "execution_finished",
      "loop_succeeded",
    ]);
  });

  it("rejects reusing a runDir that already contains preserved run state", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        allowlistPaths: ["src/allowed/**"],
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");

    const firstAdapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const firstState = await runLoop(contract, runDir, firstAdapter);
    const originalStateFile = await readFile(join(runDir, "loop-state.json"), "utf8");
    const originalEventsFile = await readFile(join(runDir, "events.jsonl"), "utf8");
    let planCalled = false;

    const secondAdapter: RuntimeAdapter = {
      async plan() {
        planCalled = true;
        throw new Error("plan should not run");
      },
      async execute() {
        throw new Error("execute should not run");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    expect(firstState.status).toBe("blocked_waiting_human");
    await expect(runLoop(contract, runDir, secondAdapter)).rejects.toThrow(
      "runDir already contains prior run data",
    );
    expect(planCalled).toBe(false);
    expect(await readFile(join(runDir, "loop-state.json"), "utf8")).toBe(originalStateFile);
    expect(await readFile(join(runDir, "events.jsonl"), "utf8")).toBe(originalEventsFile);

    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });
    expect(stdout).toContain(attemptWorktreePath);
  });

  it("succeeds from requiredChecks alone when verifierType is command", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      verification: {
        ...baseContract.verification,
        verifierType: "command",
        evidenceRequired: ["command output"],
      },
    };
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedVerify = JSON.parse(await readFile(join(runDir, "attempts", "1", "verify.json"), "utf8")) as {
      approved: boolean;
      evidence: string[];
      failingCommand: string | null;
    };

    expect(finalState.status).toBe("succeeded");
    expect(verifyCalled).toBe(false);
    expect(persistedVerify.approved).toBe(true);
    expect(persistedVerify.failingCommand).toBeNull();
    expect(persistedVerify.evidence[0]).toContain("required check passed: true");
  });

  it("does not succeed when verifierType is command and a required check fails", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      verification: {
        ...baseContract.verification,
        verifierType: "command",
        requiredChecks: ["false"],
      },
    };
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedVerify = JSON.parse(await readFile(join(runDir, "attempts", "1", "verify.json"), "utf8")) as {
      approved: boolean;
      rejectCategory: string;
      failingCommand: string | null;
    };

    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("verifier rejection with no safe retry path");
    expect(verifyCalled).toBe(false);
    expect(persistedVerify).toMatchObject({
      approved: false,
      rejectCategory: "required-check-failed",
      failingCommand: "false",
    });
  });

  it("skips adapter.verify when agent verification requiredChecks fail", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      verification: {
        ...baseContract.verification,
        verifierType: "agent",
        requiredChecks: ["false"],
      },
    };
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        verifyCalled = true;
        return {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["should not be used"],
          pauseSignals: [],
          stopSignals: [],
        };
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedVerify = JSON.parse(await readFile(join(runDir, "attempts", "1", "verify.json"), "utf8")) as {
      approved: boolean;
      rejectCategory: string;
      failingCommand: string | null;
    };

    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("verifier rejection with no safe retry path");
    expect(verifyCalled).toBe(false);
    expect(persistedVerify).toMatchObject({
      approved: false,
      rejectCategory: "required-check-failed",
      failingCommand: "false",
    });
  });

  it("does not succeed when approved verification is missing required evidence", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      verification: {
        ...baseContract.verification,
        evidenceRequired: ["proof token"],
      },
    };

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        return {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["looks good"],
          pauseSignals: [],
          stopSignals: [],
        };
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedVerify = JSON.parse(await readFile(join(runDir, "attempts", "1", "verify.json"), "utf8")) as {
      approved: boolean;
      rejectCategory: string;
      evidence: string[];
    };

    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("verifier rejection with no safe retry path");
    expect(persistedVerify.approved).toBe(false);
    expect(persistedVerify.rejectCategory).toBe("missing-required-evidence");
    expect(persistedVerify.evidence).toContain("missing required evidence: proof token");
  });

  it("blocks for human input when approval also hits a pauseOn gate", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      escalationAndExit: {
        ...baseContract.escalationAndExit,
        pauseOn: ["needs-human-review"],
      },
    };

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
        verification: {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["looks good"],
          pauseSignals: ["needs-human-review"],
          stopSignals: [],
        },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
  });

  it("blocks for human input before verify when path-policy gating hits", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        allowlistPaths: ["src/allowed/**"],
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.stopReason).toBe("allowlist miss: src/index.ts");
    expect(verifyCalled).toBe(false);
    expect(stdout).toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual([
      "loop_planning",
      "attempt_started",
      "execute_started",
      "loop_blocked_waiting_human",
    ]);
  });

  it("prioritizes the post-execute path-policy human gate over budget exhaustion", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        allowlistPaths: ["src/allowed/**"],
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => 1_000);

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
          tokenUsage: 1_000,
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    try {
      const finalState = await runLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);
      const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

      expect(finalState.status).toBe("blocked_waiting_human");
      expect(finalState.attemptsUsed).toBe(1);
      expect(finalState.stopReason).toBe("allowlist miss: src/index.ts");
      expect(finalState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        tokenBudgetRemaining: 0,
      });
      expect(persistedState.status).toBe("blocked_waiting_human");
      expect(persistedState.stopReason).toBe("allowlist miss: src/index.ts");
      expect(persistedState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        tokenBudgetRemaining: 0,
      });
      expect(verifyCalled).toBe(false);
      expect(stdout).toContain(attemptWorktreePath);
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "execute_started",
        "loop_blocked_waiting_human",
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("persists retry-ready planning state before retry cleanup runs", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const cleanupStates: RunState[] = [];

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        cleanupAttemptWorkspace: async (actualRepoPath: string, worktreePath: string) => {
          cleanupStates.push(await readRunState(runDir));
          await actual.cleanupAttemptWorkspace(actualRepoPath, worktreePath);
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter = new ScriptedAdapter([
        {
          plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
          execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "fail" },
          verification: { approved: false, rejectCategory: "tests-failed", primaryTargetPaths: ["src/index.ts"], failingCommand: "npm test", safeToRetry: true, evidence: ["FAIL"], pauseSignals: [], stopSignals: [] },
        },
        {
          plan: { summary: "change src/index.ts again", primaryTargetPaths: ["src/index.ts"] },
          execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited again"], stdoutStderrLog: "ok" },
          verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["pass"], pauseSignals: [], stopSignals: [] },
        },
      ]);

      const finalState = await observedRunLoop(contract, runDir, adapter);

      expect(finalState.status).toBe("succeeded");
      expect(cleanupStates).not.toHaveLength(0);
      expect(cleanupStates[0]).toMatchObject({
        status: "planning",
        currentAttempt: 1,
        attemptsUsed: 1,
        budgetSnapshot: { attemptsRemaining: 2 },
      });
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("passes phase state plus plan/execution context to each adapter step", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const seenContexts: Array<{
      phase: string;
      status: string;
      currentAttempt: number;
      attemptsUsed: number;
      attempt: number;
      planSummary?: string;
      executionChangedFiles?: string[];
    }> = [];

    const adapter: RuntimeAdapter = {
      async plan(context) {
        seenContexts.push({
          phase: "plan",
          status: context.state.status,
          currentAttempt: context.state.currentAttempt,
          attemptsUsed: context.state.attemptsUsed,
          attempt: context.attempt,
          planSummary: context.plan?.summary,
          executionChangedFiles: context.execution?.changedFiles,
        });
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        seenContexts.push({
          phase: "execute",
          status: context.state.status,
          currentAttempt: context.state.currentAttempt,
          attemptsUsed: context.state.attemptsUsed,
          attempt: context.attempt,
          planSummary: context.plan?.summary,
          executionChangedFiles: context.execution?.changedFiles,
        });
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify(context) {
        seenContexts.push({
          phase: "verify",
          status: context.state.status,
          currentAttempt: context.state.currentAttempt,
          attemptsUsed: context.state.attemptsUsed,
          attempt: context.attempt,
          planSummary: context.plan?.summary,
          executionChangedFiles: context.execution?.changedFiles,
        });
        return {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["npm test passed"],
          pauseSignals: [],
          stopSignals: [],
        };
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);

    expect(finalState.status).toBe("succeeded");
    expect(seenContexts).toEqual([
      {
        phase: "plan",
        status: "planning",
        currentAttempt: 1,
        attemptsUsed: 1,
        attempt: 1,
        planSummary: undefined,
        executionChangedFiles: undefined,
      },
      {
        phase: "execute",
        status: "executing",
        currentAttempt: 1,
        attemptsUsed: 1,
        attempt: 1,
        planSummary: "change src/index.ts",
        executionChangedFiles: undefined,
      },
      {
        phase: "verify",
        status: "verifying",
        currentAttempt: 1,
        attemptsUsed: 1,
        attempt: 1,
        planSummary: "change src/index.ts",
        executionChangedFiles: ["src/index.ts"],
      },
    ]);
  });

  it("stops immediately when a stopOn signal matches", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      escalationAndExit: {
        ...baseContract.escalationAndExit,
        stopOn: ["contract-stop"],
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
        verification: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: "npm test",
          safeToRetry: true,
          evidence: ["found stop signal"],
          pauseSignals: [],
          stopSignals: ["contract-stop"],
        },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("cancelled");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.stopReason).toBe("stopOn signal matched: contract-stop");
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual([
      "loop_planning",
      "attempt_started",
      "execute_started",
      "execution_finished",
      "loop_cancelled",
    ]);
  });

  it("exhausts the run when planning exceeds per-attempt timeout", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let executeCalled = false;
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        await delay(160);
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        executeCalled = true;
        throw new Error("execute should not run");
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe("plan phase exceeded per-attempt timeout of 20ms");
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.budgetSnapshot.tokenBudgetRemaining).toBe(1000);
    expect(finalState.budgetSnapshot.timeRemainingMs).toBeLessThan(5000);
    expect(persistedState.status).toBe("exhausted");
    expect(persistedState.stopReason).toBe("plan phase exceeded per-attempt timeout of 20ms");
    expect(executeCalled).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "loop_exhausted"]);
  });

  it("records execute_started before calling adapter.execute", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const seenEventsBeforeExecute: string[][] = [];

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        seenEventsBeforeExecute.push(await readEventTypes(context.runDir));
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        return {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["done"],
          pauseSignals: [],
          stopSignals: [],
        };
      },
    };

    await runLoop(contract, runDir, adapter);

    expect(seenEventsBeforeExecute).toEqual([["loop_planning", "attempt_started", "execute_started"]]);
  });

  it("writes no_progress without a reconciliation record for a non-stale null execute result", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    await runLoop(contract, runDir, adapter);

    const boundaryAnalysis = JSON.parse(
      await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
    ) as { status: string; staleCandidateReason: string | null; suspectReason: string | null };

    expect(boundaryAnalysis.status).toBe("no_progress");
    expect(boundaryAnalysis.staleCandidateReason).toBeNull();
    expect(boundaryAnalysis.suspectReason).toBe("weak progress exhausted without strong progress");
    expect(await pathExists(join(runDir, "reconciliation-record.json"))).toBe(false);
  });

  it("persists execution-recovery.json when execute is entered but returns no result before exhaustion", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    await runLoop(contract, runDir, adapter);

    const recovery = JSON.parse(
      await readFile(join(runDir, "attempts", "1", "execution-recovery.json"), "utf8"),
    ) as { executeEntered: true; captureStatus: string; cleanupStatus: string };

    expect(recovery.executeEntered).toBe(true);
    expect(recovery.captureStatus).toBe("partial");
    expect(recovery.cleanupStatus).toBe("removed");
  });

  it("writes stale reconciliation conflicting evidence when execute aborts after changing files", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 3;\n");
        await waitForAbortThenFlush(context);
        throw new DOMException("The operation was aborted", "AbortError");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const recovery = JSON.parse(
      await readFile(join(runDir, "attempts", "1", "execution-recovery.json"), "utf8"),
    ) as {
      executeEntered: true;
      captureStatus: string;
      cleanupStatus: string;
      failureBoundary: string;
      changedPathsObserved: string[] | null;
    };
    const boundaryAnalysis = JSON.parse(
      await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
    ) as { status: string; staleCandidateReason: string | null };
    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as {
      staleSuspicionBasis: string[];
      conflictingEvidence: string[];
      staleConfirmed: boolean;
    };

    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe(BUDGET_EXHAUSTED_REASON);
    expect(recovery.executeEntered).toBe(true);
    expect(recovery.captureStatus).toBe("partial");
    expect(recovery.cleanupStatus).toBe("removed");
    expect(recovery.failureBoundary).toBe("runtime_exhausted");
    expect(recovery.changedPathsObserved).toContain("src/index.ts");
    expect(boundaryAnalysis.status).toBe("stale_candidate");
    expect(boundaryAnalysis.staleCandidateReason).toContain("src/index.ts");
    expect(reconciliation.staleConfirmed).toBe(true);
    expect(reconciliation.staleSuspicionBasis[0]).toContain("src/index.ts");
    expect(reconciliation.conflictingEvidence.length).toBeGreaterThan(0);
    expect(reconciliation.conflictingEvidence.join(" ")).toContain("src/index.ts");
    // Terminal consistency: execution-recovery.json is the authoritative record of the
    // final cleanupStatus ("removed" here, after cleanup succeeds post-boundary-analysis).
    // reconciliation-record must not embed a cleanup status, since that snapshot is taken
    // before cleanup and would otherwise stay stale ("retained"), contradicting recovery.
    expect(reconciliation.conflictingEvidence.join(" ")).not.toContain("with cleanup");
    expect(reconciliation.conflictingEvidence.join(" ")).not.toContain("retained");
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "execute_started", "loop_exhausted"]);
  });

  // Task B1 / L3 §5.3 test 7b (§10 test 9 folded in). runLoopFromState is driven directly because
  // runLoop() builds its own heartbeat, and the heartbeat is the injection point: runExclusive has
  // exactly one production call site, inside persistBoundaryAnalysis.
  //
  // The fixture is the execute-timeout-with-no-result route. That choice is load-bearing, not
  // convenience: it is the route where persistBoundaryAnalysis is followed IMMEDIATELY by
  // persistTerminalState("exhausted"), so "the run was not terminated" is an observation with
  // something to observe. Three of the assertions below pin degradations the plan declares
  // ACCEPTED rather than desirable — the boundary/reconciliation write, the cleanupStatus
  // backfill and the worktree cleanup are all skipped by this branch. They are asserted precisely
  // because an accepted behaviour change that no test names is a silent one.
  it("returns a resumable state without terminating the run when the heartbeat stops mid-attempt", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const state: RunState = {
      status: "planning",
      currentAttempt: 0,
      attemptsUsed: 0,
      lastTransitionAt: "2026-07-23T00:00:00.000Z",
      waitingOnHuman: false,
      stopReason: null,
      budgetSnapshot: {
        attemptsRemaining: contract.executionPolicy.maxAttempts,
        timeRemainingMs: contract.executionPolicy.totalRuntimeBudgetMs,
        tokenBudgetRemaining: contract.executionPolicy.tokenBudget,
      },
      recentFailures: [],
    };

    await initializeRunFiles(runDir, contract, state);

    let observedWorktreePath = "";
    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        observedWorktreePath = context.worktreePath;
        // Fixture precondition for reaching the injection at all: a changed path is what makes
        // buildBoundaryEvidence return a non-empty continuitySuspicion, so evaluateRunBoundary
        // answers `stale_candidate` and persistBoundaryAnalysis does NOT take its `healthy` early
        // return — which sits above runExclusive.
        await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    let runExclusiveCalls = 0;
    // A stub standing in for a real heartbeat whose stop() landed while this attempt was in
    // flight. ONLY runExclusive refuses: per the second half of the hard constraint, assertHeld
    // must never throw this error — from inside the workspace retry loop it would miss
    // isLeaseStopError, fall through to the infra-retry escalation and terminate the run as
    // blocked_waiting_human, which is the same permanent termination through a third door.
    const heartbeat: LeaseHeartbeat = {
      adopt: () => {},
      affirmNow: async () => {},
      assertHeld: async () => {},
      runExclusive: async () => {
        runExclusiveCalls += 1;
        throw new RunHeartbeatStoppedError("run heartbeat has stopped: test-injected mid-attempt stop");
      },
      stop: async () => {},
    };

    const finalState = await runLoopFromState(contract, runDir, adapter, state, heartbeat);

    // Fixture precondition: the injection really fired, at the one production call site, exactly
    // once. Without it every assertion below would hold vacuously for a run that never reached
    // persistBoundaryAnalysis.
    expect(runExclusiveCalls).toBe(1);
    expect(observedWorktreePath).not.toBe("");

    const persisted = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as RunState;
    const recovery = JSON.parse(
      await readFile(join(runDir, "attempts", "1", "execution-recovery.json"), "utf8"),
    ) as { executeEntered: boolean; cleanupStatus: string };

    // (i) persistTerminalState was not called. It is the only writer of a `loop_<terminal>` event
    // and of a terminal status, and neither appears — in the event log, on disk, or in the return
    // value. The event list is exact rather than a `not.toContain`, so the new branch's own
    // `heartbeat_stopped` event is pinned in the same assertion.
    expect(await readEventTypes(runDir)).toEqual(["attempt_started", "execute_started", "heartbeat_stopped"]);
    expect(persisted.status).toBe("executing");
    expect(persisted.stopReason).toBeNull();
    // What the branch's extra writeRunState buys, and the reason it is not redundant with the
    // top-of-loop write: `state` has been advanced by applyPhaseUsage since then (the execute
    // phase consumed measurable runtime), so a branch that only returned it would hand back a
    // state whose budgetSnapshot disagrees with the one on disk.
    expect(persisted).toEqual(finalState);

    // (ii) execution-recovery.json's cleanupStatus was never backfilled: it still carries the
    // value written before persistBoundaryAnalysis ran.
    expect(recovery.executeEntered).toBe(true);
    expect(recovery.cleanupStatus).toBe("retained");

    // (iii) the run stays resumable. RESUMABLE_STATUSES is module-private in
    // src/controller/resumeLoop.ts, so its three members are inlined here rather than exported.
    expect(["planning", "executing", "verifying"]).toContain(finalState.status);

    // (iv) cleanupAttemptWorkspaceBestEffort did not run. It removes the worktree with
    // `git worktree remove --force` (src/workspace/worktreeManager.ts), so the directory
    // surviving is the observable of the call never happening. Accepted by the plan on the same
    // grounds as L1 §12 requirement 9: the residual worktree is the next owner's to collect.
    expect(await pathExists(observedWorktreePath)).toBe(true);

    // The write persistBoundaryAnalysis performs AFTER runExclusive returns never happened
    // either — the refusal escapes before it, which is what keeps a published reconciliation
    // record out of this branch's reach.
    expect(await pathExists(join(runDir, "boundary-analysis.json"))).toBe(false);
  });

  // Package 2 / Task 2 (debt 2, fixed): persistTerminalState (src/controller/runLoop.ts,
  // module-private, not exported) now reads owner-record.json before it writes anything, and
  // refuses when that record names a process other than this one. Task 1 pinned the defect with
  // this same scenario and the opposite expectations; the scenario is unchanged and only the
  // expectations are flipped, so the two versions are directly comparable.
  //
  // Reached through the FIRST `leaseLoss.lost !== null` checkpoint at the top of the loop
  // (runLoopFromState) — the same branch runLoop() itself takes in production the moment its own
  // heartbeat reports a RunLeaseLostError. owner-record.json on disk already names a DIFFERENT,
  // live, current, non-superseded owner at a newer epoch before that checkpoint is reached.
  //
  // The requirement being pinned is not "nothing happens". It is the SPLIT, and the split is the
  // whole fix: this process still reports its own stop (a cancelled/lease_lost return value and a
  // loop_cancelled event — the only records of why it stopped, since assertHeld appends none),
  // while the other owner's loop-state.json is left byte-identical and still resumable. A guard
  // widened to suppress the reporting half too would pass a "not cancelled on disk" check and
  // still be wrong, so the reporting half is asserted here as positively as the disk half.
  //
  // Resumability is proved with the production gate (evaluateResumeEligibility) rather than by
  // reading the status back and calling it good, and the control at the end feeds that same gate
  // the status the unguarded code used to persist — showing the gate is not answering `ok` for
  // some reason unrelated to the write that did not happen.
  it("refuses to write a terminal status into a run a different, current owner already holds when this process's own lease is lost, leaving that run resumable", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const state: RunState = { ...makeRunState("planning"), currentAttempt: 0, attemptsUsed: 0 };

    await initializeRunFiles(runDir, contract, state);
    // Written by initializeRunFiles through the same writeJsonFileAtomically that writeRunState
    // uses (src/persistence/fileStore.ts), so the comparison at the end is a byte comparison and
    // not a comparison of two serializers.
    const persistedStateBeforeLoss = await readFile(join(runDir, "loop-state.json"), "utf8");

    // Ownership has already changed hands: a different process instance is the CURRENT, live
    // owner at epoch 2 (ownerStatus "current", not superseded). The `state` above belongs to the
    // process about to discover its own lease died — it is not this owner.
    const newOwnerProcessInstanceId = "pid:999999:1234567890";
    const ownerRecord: OwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1:t0",
      currentOwnerEpoch: 2,
      currentProcessInstanceId: newOwnerProcessInstanceId,
      lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: "2026-07-25T00:00:00.000Z",
    };
    await writeOwnerRecord(runDir, ownerRecord);

    const leaseLoss = createLeaseLossSignal();
    leaseLoss.lost = new RunLeaseLostError("test-injected: this process's own lease died");

    const adapter: RuntimeAdapter = {
      async plan() {
        throw new Error("plan should not run: the lease-loss checkpoint sits above any attempt");
      },
      async execute() {
        throw new Error("execute should not run");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoopFromState(contract, runDir, adapter, state, undefined, leaseLoss);

    // The exact (not `toContain`) list carries three things at once. `run_state_write_abandoned`
    // is the top-of-loop write being refused — that write sits ABOVE the lease-loss checkpoint and
    // used to mutate the other owner's file (review finding F-2). `loop_cancelled` is the stop
    // still being reported (written only by persistTerminalState). `terminal_write_abandoned` is
    // the terminal write being refused (written only by the guard). The list also rules out any
    // adapter call having slipped through above the checkpoint.
    //
    // Two distinct abandonment types rather than one repeated: the guard latches one event of each
    // kind per runLoopFromState invocation, so this also pins that the terminal refusal stays
    // visible even though a non-terminal refusal happened first.
    expect(await readEventTypes(runDir)).toEqual([
      "run_state_write_abandoned",
      "loop_cancelled",
      "terminal_write_abandoned",
    ]);

    // Reporting half: unchanged by the fix. This process tells its caller why it stopped.
    expect(finalState.status).toBe("cancelled");
    expect(finalState.stopReason).toBe("lease_lost");

    // Disk half: the run belongs to someone else and its status is not this process's to write.
    const persisted = await readRunState(runDir);
    expect(persisted.status).toBe("planning");
    // The divergence between the two IS the fix, so it is asserted rather than left implied — the
    // unguarded code made these two equal, and that equality was the data loss.
    expect(persisted).not.toEqual(finalState);

    // Stronger than "the status is not cancelled": loop-state.json is byte-identical to what stood
    // there before this process ever reached the checkpoint. The top-of-loop writeRunState runs
    // above the lease-loss check and is therefore included in what this pins — the real owner's
    // file is not merely still resumable, it is unmodified.
    expect(await readFile(join(runDir, "loop-state.json"), "utf8")).toBe(persistedStateBeforeLoss);

    // The requirement itself, via the production gate: the other owner can still resume. Fed the
    // SAME ownerRecord written above plus an ownerTransfer/reconciliation pair satisfying every
    // other criterion, so the run status is the only variable left in the verdict.
    const ownerTransfer: OwnerTransferRecord = {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:100:1",
      newProcessInstanceId: newOwnerProcessInstanceId,
      transferredAt: "2026-07-25T00:00:00.000Z",
      reason: "owner lost",
      eligibleForContinuation: true,
    };
    const reconciliation: ReconciliationRecord = {
      staleSuspicionBasis: [],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "ok" },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    const result = evaluateResumeEligibility({ ownerRecord, ownerTransfer, reconciliation, runState: persisted });
    expect(result).toEqual({ ok: true });

    // Control: identical input except runState.status forced to the value the unguarded code used
    // to persist here. "cancelled" is a dead end — no legal transition leads out of it
    // (src/state/stateMachine.ts, `cancelled: []`) and it is absent from RESUMABLE_STATUSES
    // (src/controller/resumeLoop.ts) — so this alone flips the verdict. That is what makes the
    // `ok: true` above an assertion about the write that did not happen, rather than an artifact
    // of how the owner/transfer/reconciliation fixtures happen to be shaped.
    const controlResult = evaluateResumeEligibility({
      ownerRecord,
      ownerTransfer,
      reconciliation,
      runState: { ...persisted, status: "cancelled" },
    });
    expect(controlResult).toEqual({ ok: false, reason: "run status cancelled is not resumable" });
  });

  // Package 2 / debt 2, review finding F-1 (Critical). The FIRST version of the ownership guard
  // sat inside persistTerminalState and justified its coverage with "persistTerminalState is the
  // only writer of a terminal loop-state.json". That was false: "failed" is terminal
  // (src/state/stateMachine.ts, `failed: []`) and runLoopFromState's outer catch transitions to it
  // and calls writeRunState directly, entirely outside persistTerminalState. So a terminal status
  // still landed in a run owned by someone else, with exactly the debt-2 consequence.
  //
  // This test reaches that branch specifically — a plain adapter failure, NOT a lease error, so
  // isLeaseStopError does not match and control falls through to the generic failure handling at
  // the bottom of the catch. It would pass against the first version of the guard, which is the
  // point: it is the regression the first version's own reasoning hid.
  it("refuses to write a terminal failed status into a run a different owner holds when the attempt fails for a non-lease reason", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const state: RunState = { ...makeRunState("planning"), currentAttempt: 0, attemptsUsed: 0 };

    await initializeRunFiles(runDir, contract, state);
    const persistedStateBefore = await readFile(join(runDir, "loop-state.json"), "utf8");

    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1:t0",
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:999999:1234567890",
      lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: "2026-07-25T00:00:00.000Z",
    });

    const adapter: RuntimeAdapter = {
      // A plain failure, deliberately not a lease error: this is what routes to the outer catch's
      // generic `transitionRunState(state, "failed", …)` + writeRunState pair.
      async plan() {
        throw new Error("test-injected: adapter failure that is not a lease error");
      },
      async execute() {
        throw new Error("execute should not run");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoopFromState(contract, runDir, adapter, state);

    // Reporting half, unchanged: this process still reports that its own attempt failed.
    expect(finalState.status).toBe("failed");

    // The requirement: the other owner's run status was NOT written. Without the fix this reads
    // "failed", which is terminal and unresumable exactly as "cancelled" is.
    const persisted = await readRunState(runDir);
    expect(persisted.status).toBe("planning");
    expect(await readFile(join(runDir, "loop-state.json"), "utf8")).toBe(persistedStateBefore);
    expect(await readEventTypes(runDir)).toContain("terminal_write_abandoned");

    // Proved with the production gate rather than by eyeballing the status, and with a control
    // that feeds the same gate the status the unguarded code would have persisted.
    const ownerRecord = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as OwnerRecord;
    const ownerTransfer: OwnerTransferRecord = {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:100:1",
      newProcessInstanceId: "pid:999999:1234567890",
      transferredAt: "2026-07-25T00:00:00.000Z",
      reason: "owner lost",
      eligibleForContinuation: true,
    };
    const reconciliation: ReconciliationRecord = {
      staleSuspicionBasis: [],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "ok" },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    expect(evaluateResumeEligibility({ ownerRecord, ownerTransfer, reconciliation, runState: persisted }))
      .toEqual({ ok: true });
    expect(evaluateResumeEligibility({
      ownerRecord,
      ownerTransfer,
      reconciliation,
      runState: { ...persisted, status: "failed" },
    })).toEqual({ ok: false, reason: "run status failed is not resumable" });
  });

  // Package 2 whole-branch review, Lane 1 finding I-1 — NEW COVERAGE, added under HUMAN RULING 48,
  // the fifth named exception. That grant covers exactly the additions below and the constant
  // assertions in the two retry tests; it authorises no other change to any existing expectation.
  //
  // What was missing, measured rather than argued: the controller opened the guard for
  // `exhausted`, `blocked_waiting_human` and `succeeded` — i.e. let a foreign-owned run be written
  // with each of those three terminal statuses — and the WHOLE suite stayed green at 524/524. The
  // same mutation applied to `failed` / `cancelled` goes red, which is the must-hit control that
  // proves the mutation surface is live. So these three terminal statuses had ZERO assertions
  // behind them.
  //
  // They are not a lesser case of `failed`/`cancelled`. None of the three is in RESUMABLE_STATUSES
  // (src/controller/resumeLoop.ts), so writing any of them into a run this process does not own
  // makes that run unresumable for its real owner — the exact damage shape of Critical finding
  // F-1. Each test below therefore ends the same way that finding's own test does: with the
  // production gate answering `ok` for what is on disk, and a control feeding that same gate the
  // status the unguarded writer would have persisted.
  const foreignOwnerProcessInstanceId = "pid:999999:1234567890";

  const foreignOwnerTransfer: OwnerTransferRecord = {
    priorOwnerEpoch: 1,
    newOwnerEpoch: 2,
    priorProcessInstanceId: "pid:100:1",
    newProcessInstanceId: foreignOwnerProcessInstanceId,
    transferredAt: "2026-07-25T00:00:00.000Z",
    reason: "owner lost",
    eligibleForContinuation: true,
  };

  const foreignReconciliation: ReconciliationRecord = {
    staleSuspicionBasis: [],
    staleConfirmed: true,
    ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute",
    conflictingEvidence: [],
    takeoverPermission: { allowed: true, reason: "ok" },
    priorOwnerEpoch: 1,
    newOwnerEpoch: 2,
    eligibleForContinuation: true,
  };

  // Runs one loop to a terminal state against a run whose owner-record.json names a DIFFERENT,
  // current, live owner, and reports everything the assertions below need. The fixture is the F-1
  // test's, unchanged; only the route to the terminal status differs per caller.
  async function observeTerminalWriteAgainstForeignOwner(
    contract: LoopContract,
    adapter: RuntimeAdapter,
  ): Promise<{
    finalState: RunState;
    persisted: RunState;
    persistedBytesBefore: string;
    persistedBytesAfter: string;
    eventTypes: string[];
    ownerRecord: OwnerRecord;
  }> {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const state: RunState = { ...makeRunState("planning"), currentAttempt: 0, attemptsUsed: 0 };

    await initializeRunFiles(runDir, contract, state);
    const persistedBytesBefore = await readFile(join(runDir, "loop-state.json"), "utf8");

    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1:t0",
      currentOwnerEpoch: 2,
      currentProcessInstanceId: foreignOwnerProcessInstanceId,
      lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: "2026-07-25T00:00:00.000Z",
    });

    const finalState = await runLoopFromState(contract, runDir, adapter, state);

    return {
      finalState,
      persisted: await readRunState(runDir),
      persistedBytesBefore,
      persistedBytesAfter: await readFile(join(runDir, "loop-state.json"), "utf8"),
      eventTypes: await readEventTypes(runDir),
      ownerRecord: JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as OwnerRecord,
    };
  }

  // The two halves that must BOTH hold, exactly as in the F-1 test: this process still reports its
  // own terminal outcome to its caller, and the other owner's loop-state.json is byte-identical and
  // still resumable. A guard widened to suppress the reporting half would pass a "not written on
  // disk" check and still be wrong.
  async function expectForeignOwnersRunLeftResumable(
    observation: Awaited<ReturnType<typeof observeTerminalWriteAgainstForeignOwner>>,
    terminalStatus: RunState["status"],
  ): Promise<void> {
    expect(observation.finalState.status).toBe(terminalStatus);
    expect(observation.persisted.status).toBe("planning");
    expect(observation.persistedBytesAfter).toBe(observation.persistedBytesBefore);
    expect(observation.eventTypes).toContain("terminal_write_abandoned");

    expect(evaluateResumeEligibility({
      ownerRecord: observation.ownerRecord,
      ownerTransfer: foreignOwnerTransfer,
      reconciliation: foreignReconciliation,
      runState: observation.persisted,
    })).toEqual({ ok: true });

    // The control, and the reason this is F-1 damage rather than a cosmetic difference: fed the
    // status the unguarded writer would have persisted, the same gate refuses.
    expect(evaluateResumeEligibility({
      ownerRecord: observation.ownerRecord,
      ownerTransfer: foreignOwnerTransfer,
      reconciliation: foreignReconciliation,
      runState: { ...observation.persisted, status: terminalStatus },
    })).toEqual({ ok: false, reason: `run status ${terminalStatus} is not resumable` });
  }

  it("refuses to write a terminal succeeded status into a run a different owner holds", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const adapter = new ScriptedAdapter([successFrame()]);

    await expectForeignOwnersRunLeftResumable(
      await observeTerminalWriteAgainstForeignOwner(contract, adapter),
      "succeeded",
    );
  });

  it("refuses to write a terminal exhausted status into a run a different owner holds", async () => {
    const repoPath = await createRepo();
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: { ...baseContract.executionPolicy, perAttemptTimeoutMs: 20 },
    };

    // The per-attempt timeout route, copied from "exhausts the run when planning exceeds
    // per-attempt timeout": plan outlives its own phase timeout, so the run ends exhausted without
    // ever reaching execute.
    const adapter: RuntimeAdapter = {
      async plan() {
        await delay(160);
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        throw new Error("execute should not run");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    await expectForeignOwnersRunLeftResumable(
      await observeTerminalWriteAgainstForeignOwner(contract, adapter),
      "exhausted",
    );
  });

  it("refuses to write a terminal blocked_waiting_human status into a run a different owner holds", async () => {
    const repoPath = await createRepo();
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      escalationAndExit: { ...baseContract.escalationAndExit, pauseOn: ["needs-human-review"] },
    };

    // The pauseOn route, copied from "blocks for human input when approval also hits a pauseOn
    // gate": verification approves but raises a pause signal the contract gates on.
    const adapter = new ScriptedAdapter([
      {
        ...successFrame(),
        verification: { ...successFrame().verification, pauseSignals: ["needs-human-review"] },
      },
    ]);

    await expectForeignOwnersRunLeftResumable(
      await observeTerminalWriteAgainstForeignOwner(contract, adapter),
      "blocked_waiting_human",
    );
  });

  // Package 2 / debt 2, task S4 — the thinnest cell (#7). This is the SECOND terminal write site of
  // Critical finding F-1: the retryable path's `cleanupAttemptWorkspace` throw, which transitions to
  // "failed" and persists it. Of the nine loop-state.json write sites the guard covers, this one was
  // neither mutated by the reviewer nor pinned by any named test; it was carried solely by the
  // structural claim that every write routes through the guarded writer — a claim that, until S4,
  // had no enforcement mechanism behind it. A structural argument covering a site nothing tests is
  // how F-1 happened in the first place, so the site gets its own regression.
  //
  // Reached deliberately, not incidentally: the frame rejects verification (safeToRetry) so the
  // decision is `retryable`, and cleanupAttemptWorkspace is mocked to throw so control enters the
  // catch inside that branch — the ONLY route to this write. It is not the outer catch's failure
  // branch, which the F-1 test above already covers.
  it("refuses to write the terminal failed status of a retry-cleanup failure into a run a different owner holds", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const state: RunState = { ...makeRunState("planning"), currentAttempt: 0, attemptsUsed: 0 };

    await initializeRunFiles(runDir, contract, state);
    // Written by initializeRunFiles through the same writeJsonFileAtomically that writeRunState
    // uses (src/persistence/fileStore.ts), so the comparison below is a byte comparison and not a
    // comparison of two serializers.
    const persistedStateBefore = await readFile(join(runDir, "loop-state.json"), "utf8");

    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1:t0",
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:999999:1234567890",
      lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: "2026-07-25T00:00:00.000Z",
    });

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        cleanupAttemptWorkspace: async () => {
          throw new Error("test-injected: retry cleanup failed");
        },
      };
    });

    try {
      const { runLoopFromState: observedRunLoopFromState } = await import("../../src/controller/runLoop.js");
      const adapter = new ScriptedAdapter([
        {
          plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
          execution: {
            changedFiles: ["src/index.ts"],
            diffPatch: "diff --git a/src/index.ts b/src/index.ts",
            commandOutputs: ["edited"],
            stdoutStderrLog: "fail",
          },
          verification: {
            approved: false,
            rejectCategory: "tests-failed",
            primaryTargetPaths: ["src/index.ts"],
            failingCommand: "npm test",
            safeToRetry: true,
            evidence: ["FAIL"],
            pauseSignals: [],
            stopSignals: [],
          },
        },
      ]);

      const finalState = await observedRunLoopFromState(contract, runDir, adapter, state);

      // Reporting half, unchanged: this process still reports that its own attempt failed, and for
      // the cleanup reason. Asserting it keeps the test honest about what the guard does NOT do —
      // it does not suppress this process's own account of why it stopped.
      expect(finalState.status).toBe("failed");
      expect(finalState.stopReason).toBe("Error: test-injected: retry cleanup failed");

      // The requirement. Without the guard at this site loop-state.json reads "failed", which is
      // terminal and therefore unresumable — the data loss the debt names. Two independent
      // observables of the same fact: the parsed status, and the file byte-for-byte untouched.
      const persisted = await readRunState(runDir);
      expect(persisted.status).toBe("planning");
      expect(await readFile(join(runDir, "loop-state.json"), "utf8")).toBe(persistedStateBefore);

      // Not silent. A refusal with no record is the failure mode this repository has a stated
      // position against, and `terminal_write_abandoned` rather than the non-terminal event is what
      // says the refusal that mattered — the terminal one — is the one that happened here.
      expect(await readEventTypes(runDir)).toContain("terminal_write_abandoned");

      // Proved with the production gate rather than by eyeballing the status, and with a control
      // that feeds the same gate the status the unguarded code would have persisted.
      const ownerRecord = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as OwnerRecord;
      const ownerTransfer: OwnerTransferRecord = {
        priorOwnerEpoch: 1,
        newOwnerEpoch: 2,
        priorProcessInstanceId: "pid:100:1",
        newProcessInstanceId: "pid:999999:1234567890",
        transferredAt: "2026-07-25T00:00:00.000Z",
        reason: "owner lost",
        eligibleForContinuation: true,
      };
      const reconciliation: ReconciliationRecord = {
        staleSuspicionBasis: [],
        staleConfirmed: true,
        ownershipVerdict: "OWNER_LOST",
        lastTrustedBoundary: "execute",
        conflictingEvidence: [],
        takeoverPermission: { allowed: true, reason: "ok" },
        priorOwnerEpoch: 1,
        newOwnerEpoch: 2,
        eligibleForContinuation: true,
      };

      expect(evaluateResumeEligibility({ ownerRecord, ownerTransfer, reconciliation, runState: persisted }))
        .toEqual({ ok: true });
      expect(evaluateResumeEligibility({
        ownerRecord,
        ownerTransfer,
        reconciliation,
        runState: { ...persisted, status: "failed" },
      })).toEqual({ ok: false, reason: "run status failed is not resumable" });
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  // Package 2 / debt 2, review finding F-3/F-4. The guard fails OPEN when it cannot read the owner
  // record — a record it could not parse has identified nobody, least of all a different owner,
  // and refusing there would turn a stop into a crash. What F-3 caught is that the first version
  // failed open with no trace at all, which is the silent failure this repository already has a
  // stated position against (fileStore.ts, writeBoundaryArtifacts).
  //
  // This pins BOTH halves: the write proceeds AND the fail-open is recorded. Asserting only the
  // event would pass against a guard that refused the write; asserting only the write would pass
  // against the silent version.
  it("records ownership_unverified and still writes when the owner record is present but unreadable", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const state: RunState = { ...makeRunState("planning"), currentAttempt: 0, attemptsUsed: 0 };

    await initializeRunFiles(runDir, contract, state);
    await writeFile(join(runDir, "owner-record.json"), "{ not json");

    const leaseLoss = createLeaseLossSignal();
    leaseLoss.lost = new RunLeaseLostError("test-injected: this process's own lease died");

    const adapter: RuntimeAdapter = {
      async plan() {
        throw new Error("plan should not run: the lease-loss checkpoint sits above any attempt");
      },
      async execute() {
        throw new Error("execute should not run");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoopFromState(contract, runDir, adapter, state, undefined, leaseLoss);

    // Fail-open: the write happened. An unreadable record must not strand a run that may well be
    // this process's own, and must not convert a stop into a crash.
    expect(finalState.status).toBe("cancelled");
    expect((await readRunState(runDir)).status).toBe("cancelled");

    // Not silent: exactly one record of the fail-open, and no false accusation of a foreign owner.
    const eventTypes = await readEventTypes(runDir);
    expect(eventTypes).toContain("ownership_unverified");
    expect(eventTypes).not.toContain("terminal_write_abandoned");
    expect(eventTypes).not.toContain("run_state_write_abandoned");
    expect(eventTypes.filter((type) => type === "ownership_unverified")).toHaveLength(1);
  });

  // Task B2 / L3 §5.4 test 8. runLoopFromState is driven directly because runLoop() takes no
  // options object and the stop slot lives on one.
  //
  // The adapter script is load-bearing rather than incidental. The slot could have been fitted to
  // EITHER of the two `leaseLoss.lost !== null` checkpoints, and an implementation that chose the
  // other one — inside the attempt, on the retryable path after verification is rejected — also
  // returns a non-terminal state here. What separates them is only that it returns having already
  // spent an attempt, so frame 1 rejects verification specifically to give that implementation a
  // path to its checkpoint: planCalls, the untouched loop-state.json and the exact event list are
  // then three independent observables of "stopped before any attempt" versus "stopped after one".
  it("returns a resumable state at the loop top when the stop signal is set, without spending an attempt", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    // attemptsUsed 0, so the attempt this stop prevents would be attempt 1. That number is what
    // keeps the alternative placement reachable: evaluateStopDecision (src/stop/stopController.ts)
    // answers `retryable` only for `attemptNumber === 1` and `blocked_waiting_human` for any
    // later one, and the attempt-internal checkpoint sits on the retryable path alone. Seeded at
    // attemptsUsed 1 this test would still be red under that mutation, but red for having
    // terminated rather than for having spent an attempt — a weaker kill.
    const state: RunState = { ...makeRunState("planning"), currentAttempt: 0, attemptsUsed: 0 };

    await initializeRunFiles(runDir, contract, state);
    // Written by initializeRunFiles through the same writeJsonFileAtomically that writeRunState
    // uses (src/persistence/fileStore.ts), so this comparison is a byte comparison and not a
    // comparison of two serializers.
    const persistedStateBeforeStop = await readFile(join(runDir, "loop-state.json"), "utf8");

    const base = successFrame();
    const rejectFrame = {
      ...base,
      verification: {
        ...base.verification,
        approved: false,
        rejectCategory: "tests fail",
        failingCommand: "npm test",
        safeToRetry: true,
        evidence: ["FAIL"],
      },
    };
    const scripted = new ScriptedAdapter([rejectFrame, successFrame()]);
    // plan is the first adapter call of every attempt, so counting it counts attempts entered —
    // and each one is a real (paid) model call in production.
    let planCalls = 0;
    const adapter: RuntimeAdapter = {
      async plan(context) {
        planCalls += 1;
        return await scripted.plan(context);
      },
      async execute(context) {
        return await scripted.execute(context);
      },
      async verify(context) {
        return await scripted.verify(context);
      },
    };

    const stopRequested = createStopRequestSignal();
    stopRequested.requested = true;

    const finalState = await runLoopFromState(contract, runDir, adapter, state, undefined, undefined, {
      stopRequested,
    });

    // No attempt was entered at all — the return happens above `const attempt = state.attemptsUsed + 1`.
    expect(planCalls).toBe(0);
    expect(await readdir(join(runDir, "attempts"))).toEqual([]);

    // The named requirement: not merely "attemptsUsed did not grow" in the returned value, but
    // loop-state.json byte-identical to what stood there before the stop. That is what makes the
    // stop cost nothing — the next sweep re-reads exactly the state it would have read anyway.
    expect(finalState.attemptsUsed).toBe(state.attemptsUsed);
    expect(await readFile(join(runDir, "loop-state.json"), "utf8")).toBe(persistedStateBeforeStop);

    // Exactly one event, and no terminal one: persistTerminalState is the only writer of a
    // `loop_<terminal>` event, and appendTransitionEvent the only writer of `attempt_started`.
    // Both absences are pinned in the same assertion as the new event's presence.
    expect(await readEventTypes(runDir)).toEqual(["stop_requested"]);

    // The run stays resumable. RESUMABLE_STATUSES is module-private in
    // src/controller/resumeLoop.ts, so its three members are inlined here rather than exported.
    expect(["planning", "executing", "verifying"]).toContain(finalState.status);
    expect(finalState.stopReason).toBeNull();
  });

  it("writes owner-record.json when a run is initialized", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        },
        verification: {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["pass"],
          pauseSignals: [],
          stopSignals: [],
        },
      },
    ]);

    await runLoop(contract, runDir, adapter);

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      ownerStatus: string;
    };

    expect(owner.currentOwnerEpoch).toBe(1);
    expect(owner.ownerStatus).toBe("current");
  });

  // The five reconciliation tests below overwrite owner-record.json from inside `execute` to
  // drive evaluateOwnership's inputs. They named a foreign `pid:12345` until task 13 added a
  // lease re-check immediately before every side effect: a record naming another process
  // instance is now (correctly) refused as supersession before the boundary machinery runs at
  // all, which would have left these tests asserting on artifacts that must never be written
  // by a superseded owner. The ownership signal they actually exercise is `ownerStatus`
  // ("lost"), never the process identity — nothing in src/ writes ownerStatus, so a record
  // that still names THIS process while reporting a lost owner is exactly the case that
  // remains reachable — so the fixtures name this process and let ownerStatus carry the loss.
  // Every assertion in all five is unchanged.
  it("keeps changed-path stale reconciliation on OWNER_UNDECIDABLE even when persisted owner truth is lost", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
          runId: "task-1",
          logicalSessionId: "task-1:lost-with-changes",
          currentOwnerEpoch: 1,
          currentProcessInstanceId: buildProcessInstanceId(),
          lastAffirmedAt: "2026-07-23T00:00:00.000Z",
          ownerStatus: "lost",
          supersededByEpoch: null,
        }, null, 2));
        await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    await runLoop(contract, runDir, adapter);

    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as {
      ownershipVerdict: string;
      priorOwnerEpoch: number | null;
      newOwnerEpoch: number | null;
      eligibleForContinuation: boolean;
      takeoverPermission: { allowed: boolean };
    };

    expect(reconciliation.ownershipVerdict).toBe("OWNER_UNDECIDABLE");
    expect(reconciliation.priorOwnerEpoch).toBe(1);
    expect(reconciliation.newOwnerEpoch).toBeNull();
    expect(reconciliation.eligibleForContinuation).toBe(false);
    expect(reconciliation.takeoverPermission.allowed).toBe(false);
  });

  // 12d(iv): the ONLY coverage of A8's three middle layers. The other 12d cases either call
  // fileStore directly or stand in for resumeLoop, so all of them would stay green against an
  // implementation that added the parameter at every layer and forgot to pass it down.
  //
  // The fixture has to satisfy four constraints at once, and each one rules out an easier shape:
  //   1. owner-record.json is valid and there is no transfer marker, so readOwnerRecord — which
  //      persistBoundaryAnalysis calls OUTSIDE any try, before writeBoundaryArtifacts — succeeds
  //      and recoverInterruptedOwnerTransfer early-returns instead of rewriting the transfer.
  //   2. owner-transfer.json exists but does not parse, which is what makes the persisted-artifact
  //      read fail closed and abandon.
  //   3. ownerStatus "lost" with changed paths yields OWNER_UNDECIDABLE / takeover denied, so the
  //      transfer branch does not run and does not overwrite the corrupt file with a valid one.
  //   4. the boundary is a stale_candidate carrying eligibleForContinuation: false, so a
  //      reconciliation record is actually passed down and the preserve check does not early-return.
  it("forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const state: RunState = {
      status: "planning",
      currentAttempt: 0,
      attemptsUsed: 0,
      lastTransitionAt: "2026-07-23T00:00:00.000Z",
      waitingOnHuman: false,
      stopReason: null,
      budgetSnapshot: {
        attemptsRemaining: contract.executionPolicy.maxAttempts,
        timeRemainingMs: contract.executionPolicy.totalRuntimeBudgetMs,
        tokenBudgetRemaining: contract.executionPolicy.tokenBudget,
      },
      recentFailures: [],
    };

    await initializeRunFiles(runDir, contract, state);
    // Constraint 1.
    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1:abandon-routing",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: buildProcessInstanceId(),
      lastAffirmedAt: "2026-07-23T00:00:00.000Z",
      ownerStatus: "lost",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    });
    // Constraint 2.
    await writeFile(join(runDir, "owner-transfer.json"), "{ not json");
    expect(await pathExists(join(runDir, ".owner-transfer.transaction.json"))).toBe(false);

    const abandonments: string[] = [];

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        // Changed paths keep the verdict at OWNER_UNDECIDABLE (constraint 3), the same lever the
        // OWNER_UNDECIDABLE test above pulls.
        await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    await runLoopFromState(contract, runDir, adapter, state, undefined, undefined, {
      onReconciliationWriteAbandoned: (detail) => abandonments.push(detail),
    });

    // Fixture precondition for the assertions below: the boundary really was a stale_candidate,
    // i.e. a reconciliation record was passed down at all (constraint 4).
    const analysis = JSON.parse(
      await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
    ) as { status: string };
    expect(analysis.status).toBe("stale_candidate");

    expect(abandonments).toHaveLength(1);
    // The detail reaching the operator is the read failure itself, unchanged by the three layers
    // it travelled through.
    expect(abandonments[0]).toContain("JSON");
    // And the abandonment was real: the corrupt transfer stopped the write rather than being
    // written through.
    expect(await pathExists(join(runDir, "reconciliation-record.json"))).toBe(false);
  });

  it("writes an OWNER_LOST reconciliation record with transferred ownership when persisted owner truth no longer supports ownership and continuity evidence does not rescue it", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
          runId: "task-1",
          logicalSessionId: "task-1:lost",
          currentOwnerEpoch: 1,
          currentProcessInstanceId: buildProcessInstanceId(),
          lastAffirmedAt: "2026-07-23T00:00:00.000Z",
          ownerStatus: "lost",
          supersededByEpoch: null,
        }, null, 2));
        await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 3;\n");
        await execFileAsync("git", ["checkout", "--", "src/index.ts"], { cwd: context.worktreePath });
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    await runLoop(contract, runDir, adapter);

    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as {
      ownershipVerdict: string;
      priorOwnerEpoch: number | null;
      newOwnerEpoch: number | null;
      eligibleForContinuation: boolean;
      takeoverPermission: { allowed: boolean };
    };

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
    };
    const transfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
      priorOwnerEpoch: number;
      newOwnerEpoch: number;
      eligibleForContinuation: boolean;
    };

    expect(reconciliation.ownershipVerdict).toBe("OWNER_LOST");
    expect(reconciliation.priorOwnerEpoch).toBe(1);
    expect(reconciliation.newOwnerEpoch).toBe(2);
    expect(reconciliation.eligibleForContinuation).toBe(true);
    expect(reconciliation.takeoverPermission.allowed).toBe(true);
    expect(owner.currentOwnerEpoch).toBe(2);
    expect(owner.currentProcessInstanceId).toBe(buildProcessInstanceId());
    expect(transfer.priorOwnerEpoch).toBe(1);
    expect(transfer.newOwnerEpoch).toBe(2);
    expect(transfer.eligibleForContinuation).toBe(true);
    // Final-review fix 1. The transfer asserted above was performed by THIS process, to itself:
    // the heartbeat adopts the record it just wrote, so the epoch rotation is not a takeover and
    // must not be reported as one. Written to fail against the pre-fix behavior, where the
    // stale expectation made the next guard conclude supersession — emitting a lease_lost event
    // naming this same process on both sides, and refusing the post-terminal cleanup below.
    expect(await readEventTypes(runDir)).not.toContain("lease_lost");
    // And the side effect that spurious refusal blocked happens: the attempt worktree is
    // removed rather than leaked as a registered git worktree in the user's repo.
    await expect(readdir(join(runDir, "worktrees"))).resolves.toEqual([]);
  });

  // Task A4 / §4.3: the decisive proof that reconciliation-record.json is now published INSIDE
  // persistOwnerTransfer's own transaction, not by the writeBoundaryArtifacts call that used to
  // follow it. Driven through runLoopFromState (via runLoop, which calls it) for a REAL transfer
  // — the same winner scenario as the test above — with heartbeat.assertHeld() wrapped so its
  // very next call after the transaction publishes reconciliation-record.json throws instead of
  // delegating.
  //
  // The discriminating assertion is boundary-analysis.json's ABSENCE, not reconciliation-record
  // .json's presence: the injection's own trigger condition (pathExists on
  // reconciliation-record.json) already guarantees the latter once the crash is observed at all,
  // so asserting it alone would be implied by the setup rather than by the fix. boundary-analysis
  // .json is written by the very call (writeBoundaryArtifacts) this task's winner path now skips,
  // which sits AFTER the injected failure — so its absence is genuine, falsifiable evidence that
  // reconciliation was already committed before that later call was ever reached. See the inline
  // comment at the assertion itself for the full argument (fix-wave-1 review finding).
  //
  // ⚠️ Do not rewrite this as "prove refusal before the fix, success after": a single committed
  // test can only run one tree. The pre-fix (red) side is provided separately by the reverse
  // mutation on this same test (see task-A4-report.md).
  it("publishes reconciliation-record.json inside the transfer transaction even when assertHeld throws afterwards", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const injectedFailureMessage = "injected: assertHeld failure right after the reconciliation transaction";

    vi.resetModules();
    vi.doMock("../../src/controller/leaseHeartbeat.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/controller/leaseHeartbeat.js")>(
        "../../src/controller/leaseHeartbeat.js",
      );

      return {
        ...actual,
        startLeaseHeartbeat: (options: Parameters<typeof actual.startLeaseHeartbeat>[0]) => {
          const real = actual.startLeaseHeartbeat(options);
          let injected = false;

          return {
            ...real,
            // Delegates to the real assertHeld on every call EXCEPT the first one observed after
            // reconciliation-record.json exists on disk — which, in this scenario, can only be
            // the call at the tail of persistBoundaryAnalysis, immediately before the
            // writeBoundaryArtifacts call this task removed reconciliation from. Every assertHeld
            // call before the transfer succeeds still runs for real, so nothing about the
            // transfer's own CAS or the entry guard is short-circuited.
            assertHeld: async () => {
              if (!injected && (await pathExists(join(runDir, "reconciliation-record.json")))) {
                injected = true;
                throw new Error(injectedFailureMessage);
              }

              await real.assertHeld();
            },
          };
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");

      const adapter: RuntimeAdapter = {
        async plan() {
          return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
        },
        async execute(context) {
          await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
            runId: "task-1",
            logicalSessionId: "task-1:lost-assertheld",
            currentOwnerEpoch: 1,
            currentProcessInstanceId: buildProcessInstanceId(),
            lastAffirmedAt: "2026-07-23T00:00:00.000Z",
            ownerStatus: "lost",
            supersededByEpoch: null,
          }, null, 2));
          await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 3;\n");
          await execFileAsync("git", ["checkout", "--", "src/index.ts"], { cwd: context.worktreePath });
          await waitForAbort(context.abortSignal);
          return null;
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      // The decisive premise: persistBoundaryAnalysis itself threw the injected error, rather
      // than completing and returning normally. runLoop.ts's own generic attempt-failure catch
      // (unrelated to this task, and unchanged by it) then catches ANY non-lease error escaping
      // the attempt body and decisively writes status "failed" rather than leaving loop-state.json
      // ambiguous — so the call resolves rather than rejects, with the injected message carried
      // as stopReason. A genuine OS-level process crash at the same instant (what this injection
      // stands in for) has no such catch to run at all, and would leave loop-state.json exactly
      // where its last real write left it: "executing", from before persistBoundaryAnalysis was
      // ever called.
      const finalState = await observedRunLoop(contract, runDir, adapter);

      // ⚠️ Fix-wave-1 review finding: the injected assertHeld only ever throws once
      // pathExists("reconciliation-record.json") is already true, so `finalState.status ===
      // "failed"` alone is IMPLIED by that trigger condition and cannot discriminate "reconciliation
      // was published transactionally" from any other explanation of the crash — checking
      // pathExists("reconciliation-record.json") right after would be tautological. The assertion
      // that actually carries this test's claim is the one below: boundary-analysis.json must be
      // ABSENT. It is written by the SAME writeBoundaryArtifacts call the winner path now skips
      // (src/controller/runLoop.ts, persistBoundaryAnalysis's tail), which sits AFTER the injected
      // assertHeld — so its absence is not implied by the injection's own trigger condition, and it
      // is what distinguishes "reconciliation came from the transaction, before that call was ever
      // reached" from "reconciliation came from writeBoundaryArtifacts", which — had it run at all —
      // would have written this file too.
      expect(await pathExists(join(runDir, "boundary-analysis.json"))).toBe(false);

      // (a) reconciliation-record.json is already on disk despite the crash.
      expect(await pathExists(join(runDir, "reconciliation-record.json"))).toBe(true);
      const reconciliation = JSON.parse(
        await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
      ) as {
        ownershipVerdict: string;
        priorOwnerEpoch: number | null;
        newOwnerEpoch: number | null;
        eligibleForContinuation: boolean;
      };
      expect(reconciliation.ownershipVerdict).toBe("OWNER_LOST");
      expect(reconciliation.priorOwnerEpoch).toBe(1);
      expect(reconciliation.newOwnerEpoch).toBe(2);
      expect(reconciliation.eligibleForContinuation).toBe(true);

      // Supporting, not decisive on their own (see the note above): the crash's own visible
      // symptom, kept as corroborating evidence once the boundary-analysis.json / reconciliation
      // assertions above have already done the discriminating work.
      expect(finalState.status).toBe("failed");
      expect(finalState.stopReason).toContain(injectedFailureMessage);

      // (b) SCOPE NOTE (fix-wave-1 review finding): this does not prove "resumeLoop lets the actual
      // crashed run through" — the production path in THIS scenario never leaves loop-state.json at
      // a resumable status, because runLoop.ts's own generic attempt-failure catch (unrelated to
      // this task, unchanged by it) always writes a decisive terminal "failed" once it catches a
      // JS-level exception, and "failed" is not in RESUMABLE_STATUSES. No JS-catchable injection can
      // avoid that catch, since it is the same try/catch surrounding the await this test's injection
      // fires from. What this DOES prove, narrower than "resumeLoop permits continuation of this
      // scenario": the reconciliation-record.json this transaction published is itself
      // eligibility-shaped — feeding it (plus the untouched owner-record.json/owner-transfer.json,
      // also published by the same transaction) to resumeLoop's gate, alongside a loop-state.json
      // status a genuine OS-level crash (as opposed to this JS-catchable stand-in for one) would
      // have left in place, does not trip resume_denied. The assertion below is still falsifiable —
      // a draft field assembled wrong (e.g. wrong ownershipVerdict, mismatched newOwnerEpoch, or
      // eligibleForContinuation false) fails resumeLoop's criteria 2/3/4 and would show up as
      // resume_denied — so this is a real, scope-limited check, not a tautology dressed up as one.
      // Every artifact resumeLoop reads other than loop-state.json (owner-record.json,
      // owner-transfer.json, reconciliation-record.json) is untouched by the generic catch above and
      // already reflects the real, transactionally-published transfer.
      const crashedLoopState = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as {
        status: string;
      };
      expect(crashedLoopState.status).toBe("failed"); // sanity: confirms the stand-in below is needed
      await writeFile(
        join(runDir, "loop-state.json"),
        JSON.stringify({ ...crashedLoopState, status: "executing", stopReason: null }, null, 2),
      );

      const resumedAdapter = new ScriptedAdapter([
        {
          plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
          execution: { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" },
          verification: {
            approved: true,
            rejectCategory: "",
            primaryTargetPaths: ["src/index.ts"],
            failingCommand: null,
            safeToRetry: false,
            evidence: ["ok"],
            pauseSignals: [],
            stopSignals: [],
          },
        },
      ]);
      await resumeLoop(runDir, resumedAdapter);

      const events = await readEventTypes(runDir);
      expect(events).toContain("resume_adopted");
      expect(events).not.toContain("resume_denied");
    } finally {
      vi.doUnmock("../../src/controller/leaseHeartbeat.js");
      vi.resetModules();
    }
  });

  // Task A4 / §4.3: the winner path no longer passes `reconciliationRecord` to
  // writeBoundaryArtifacts — persistOwnerTransfer already published it transactionally, so a
  // second write here would be the very "winner writes it twice" this task removes. Driven
  // through the same real winner-transfer scenario as the two tests above (via runLoop, which
  // calls persistBoundaryAnalysis internally — persistBoundaryAnalysis itself is not exported).
  //
  // fileStore.js's writeBoundaryArtifacts is wrapped, not replaced: the wrapper takes its "before"
  // stat immediately before delegating to the real call and its "after" stat immediately once the
  // real call returns, with nothing else touching the target in between.
  //
  // ⚠️ Snapshot placement is load-bearing. Taking the baseline any earlier — e.g. before
  // persistBoundaryAnalysis even starts — would straddle the transaction's OWN publish rename of
  // reconciliation-record.json (persistOwnerTransfer, reached earlier inside
  // persistBoundaryAnalysis), which always changes the inode once, for a reason unrelated to what
  // this test pins. Taken there, this test would fail unconditionally, and the failure would say
  // nothing about whether the winner writes the file a second time.
  it("leaves the reconciliation-record.json inode untouched when the winner writes boundary artifacts", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const target = join(runDir, "reconciliation-record.json");
    const inodes: { before: number | null; after: number | null } = { before: null, after: null };
    let capturedArtifactKeys: string[] | null = null;
    let writeBoundaryArtifactsCalls = 0;

    vi.resetModules();
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );

      return {
        ...actual,
        writeBoundaryArtifacts: async (...args: Parameters<typeof actual.writeBoundaryArtifacts>) => {
          writeBoundaryArtifactsCalls += 1;
          capturedArtifactKeys = Object.keys(args[1]);
          // Immediately before delegating: by the winner scenario's own construction, the
          // transaction has already published this file, so it exists here.
          inodes.before = (await stat(target)).ino;
          await actual.writeBoundaryArtifacts(...args);
          // Immediately after the real call returns.
          inodes.after = (await stat(target)).ino;
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");

      const adapter: RuntimeAdapter = {
        async plan() {
          return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
        },
        async execute(context) {
          await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
            runId: "task-1",
            logicalSessionId: "task-1:lost-6d",
            currentOwnerEpoch: 1,
            currentProcessInstanceId: buildProcessInstanceId(),
            lastAffirmedAt: "2026-07-23T00:00:00.000Z",
            ownerStatus: "lost",
            supersededByEpoch: null,
          }, null, 2));
          await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 3;\n");
          await execFileAsync("git", ["checkout", "--", "src/index.ts"], { cwd: context.worktreePath });
          await waitForAbort(context.abortSignal);
          return null;
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      await observedRunLoop(contract, runDir, adapter);

      // The test's own claim, first so that it is the assertion that fires: the file the winner's
      // transaction published is still the same inode after writeBoundaryArtifacts returned.
      expect(inodes.before).not.toBeNull();
      expect(inodes.after).toBe(inodes.before);

      // Corroborating context, not the point of the test: exactly one writeBoundaryArtifacts call
      // happened (this scenario runs a single attempt), and it did not carry a reconciliationRecord
      // key at all — together they establish WHY an unchanged inode means what the name says,
      // rather than meaning the write simply never happened. Kept below the inode assertions on
      // purpose: placed above, a mutation that adds the reconciliationRecord key back reds here and
      // the clause the test is named for never gets an assertion of its own to fail.
      expect(writeBoundaryArtifactsCalls).toBe(1);
      expect(capturedArtifactKeys).toEqual(["boundaryAnalysis"]);

      const reconciliation = JSON.parse(await readFile(target, "utf8")) as { newOwnerEpoch: number | null };
      expect(reconciliation.newOwnerEpoch).toBe(2);
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });

  // Task A9 / §4.3 test 6e: the only guardrail for this layer's finalize-order re-ruling
  // (owner-transfer.json is published FIRST, reconciliation-record.json LAST). Two processes meet
  // inside the publish window: P1 (the winner) is mid-transaction, and P2 (the loser) reaches its
  // own boundary write while P1's three renames are still in flight.
  //
  // Deterministic interleaving, decided by the MOCK and never by the fixture: node:fs/promises'
  // `rename` is wrapped, and the FIRST rename whose source is one of the transaction's three fixed
  // publish temps — whichever file finalizeOrder happens to put first — runs the loser's entire
  // runLoopFromState to completion before P1 is allowed to proceed. That is what keeps the fixture
  // out of the mutation surface: both mutations recorded in task-A9-report.md change production
  // code only, and this fixture is byte-identical across the unmutated and both mutated runs. A
  // fixture-driven interleaving (a fixed sleep, or staging the files by hand) would move the
  // interleaving point every time production changed which file is published first — i.e. it would
  // mutate along with the code and pin nothing.
  //
  // The loser side must go through runLoopFromState because persistBoundaryAnalysis is not
  // exported and must not be exported for this; the winner side is hand-built directly on
  // fileStore's export surface.
  //
  // ⚠️ What assertion (a) pins, stated honestly: it pins the loser's successful PROTECTIVE READ of
  // owner-transfer.json — i.e. the PRECONDITION for the published-winner check, not the check
  // itself. With that file already published, readPersistedSuccessfulTransferArtifacts gets past
  // its first read and can go on to reach transferRepresentsPublishedWinner; published later, the
  // read ends in ENOENT and takes the check with it. More than one path satisfies (a) without the
  // check ever running — two are known, and this list is examples, not an enumeration. (i) if the
  // readOwnerRecord in that function's subsequent Promise.all throws, the read returns
  // { kind: "unreadable" } and the write is abandoned. (ii) readOwnerTransferRecordRaw is the
  // single statement `JSON.parse(await readFile(...))`, and the doMock'd readFile below pushes
  // "ok" the instant `actual.readFile` resolves — BEFORE the parse — so a present-but-torn
  // owner-transfer.json records "ok" for (a) and then the parse throws a SyntaxError, which is
  // non-ENOENT, so the first catch returns { kind: "unreadable" } too. In both, (a) is green with
  // transferRepresentsPublishedWinner never evaluated, which is the point: (a) pins the
  // precondition, not the check. Neither path is silent HERE, but neither is unconditionally
  // recorded either: the abandonment reaches the operator callback only when one was supplied
  // (onReconciliationWriteAbandoned is optional at all four layers), and its events.jsonl line is
  // written inside a try/catch that writeBoundaryArtifacts swallows by contract. With no callback
  // supplied AND an unwritable events.jsonl, the abandonment reaches nothing — which is precisely
  // the case that function's own constraint 2 names as "a genuine silent failure". That is why the
  // gap is left named rather than closed here.
  //
  // ⚠️ Amended by package 2 / §13 4th entry (D2), and the amendment is narrow. Assertion (a) used
  // to read `expect(ownerTransferReadOutcomesInWindow).toContain("ok")`. D2 puts the loser's
  // read → decide → write inside the same .owner-transfer.lock that P1 holds for its whole
  // transaction, so inside this window the loser never reaches that read at all: it finds the lock
  // held by a live pid, exhausts its bounded retry and abandons. The observation the old (a) made
  // is not weakened here, it is no longer reachable — so (a) is REPLACED by the observation that
  // now stands in the same place, and the array it used to inspect is asserted EMPTY rather than
  // deleted, so that a future edit which lets the loser read here again reds this test instead of
  // passing silently.
  //
  // It still does NOT pin "the winner was not overwritten", and still could not: nothing below
  // observes the state after P1's transaction completes. What changed is WHY the loser does not
  // overwrite — before D2 it went on to write its downgrade, now it is refused the lock. The
  // terminal property lives in the two interleaving tests that follow this one, which is where it
  // belongs: it is a claim about both processes having finished, not about the loser's window.
  //
  // ⚠️ No terminal-state assertion here, deliberately, and D2 does NOT lift that. "P1's third
  // rename puts the winner's record back" is an ordering this harness imposes, not a property of
  // the system — in production the loser's write may perfectly well land after rename #3. Asserting
  // it as correct behaviour would write a damaged trajectory into the suite. That sentence survives
  // D2 intact and is why the two tests below assert the terminal state under BOTH lock orders
  // instead of under this one: a terminal assertion that holds only for the order the fixture
  // happens to produce is the same damaged trajectory under a new name. Everything asserted below
  // is scoped to the loser's window.
  //
  // Assertion (b) observes finalize through its rename SOURCES rather than through a spy on
  // finalizePendingOwnerTransfer (not exported, and not to be exported for a test), and it is a
  // set-membership assertion rather than a rename COUNT: writeBoundaryArtifacts renames on its own
  // account, so counting renames gives two numbers that are both wrong. The transaction's three
  // publish temps are fixed names; the loser's own atomic writes go through buildAtomicTempPath,
  // whose per-process stamp and sequence number make a collision impossible.
  //
  // ⚠️ Mutation 2 (removing the live-process early return in tryRecoverStaleOwnerTransferLock) also
  // fails a handful of pre-existing tests elsewhere in the suite that have nothing to do with this
  // one — the list is in task-A9-report.md. That list is NOISE, not this test's guardrail: the only
  // thing that counts as evidence is this named test, run alone, going red.
  // The name is deliberately NOT the one the plan's Step 2 mandated ("keeps the loser from writing
  // through the winner's reconciliation inside the publish window"): that name's first clause has
  // no assertion behind it and states the opposite of what the ⚠️ block above documents — the loser
  // DOES write its downgrade in this window, because the residual TOCTOU is not closed at this
  // layer. A name is what appears in failure output, so it names the two things actually asserted:
  // clause 1 is assertion (a), clause 2 is assertion (b). Human ruling; the plan carries the
  // matching in-place amendment note (Amended 2026-08-02 (d), §Task A9).
  //
  // *** SOURCE ANCHOR for that human ruling, added by the package 2 whole-branch fix round: the
  // ruling is HUMAN RULING 13 of the package 2 ledger
  // (.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md). CORRECTED per the independent
  // review's Low-2, which found the first version of this anchor described the grant too NARROWLY:
  // ruling 13 is a named widening of scope that authorised package 2 to CHANGE THIS JUDGEMENT AT
  // ALL — renaming it is one consequence of that grant, not the whole of it. It is recorded
  // here because a whole-branch reviewer searched the entire repository for "ruling 13" and got
  // zero hits while the same search hit for rulings 14/17/37 — i.e. the search surface was proven
  // live and this one anchor was genuinely missing — so a reader of this test could not learn from
  // the code that its name was changed under a named grant of permission. Nothing about the test
  // changes here; only the anchor is added. ***
  it("abandons the loser's reconciliation write against the winner's held transfer lock and finalizes none of the winner's transaction inside the publish window", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const state: RunState = {
      status: "planning",
      currentAttempt: 0,
      attemptsUsed: 0,
      lastTransitionAt: "2026-07-23T00:00:00.000Z",
      waitingOnHuman: false,
      stopReason: null,
      budgetSnapshot: {
        attemptsRemaining: contract.executionPolicy.maxAttempts,
        timeRemainingMs: contract.executionPolicy.totalRuntimeBudgetMs,
        tokenBudgetRemaining: contract.executionPolicy.tokenBudget,
      },
      recentFailures: [],
    };

    const transactionPublishTempNames = new Set([
      ".owner-transfer.publish.tmp",
      ".owner-record.publish.tmp",
      ".reconciliation-record.publish.tmp",
    ]);

    let loserWindowOpen = false;
    let interleaved = false;
    let runLoserInsideWindow: (() => Promise<void>) | null = null;
    const ownerTransferReadOutcomesInWindow: string[] = [];
    const publishTempRenameSourcesInWindow: string[] = [];
    const reconciliationAbandonmentsInWindow: string[] = [];

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        readFile: async (...args: Parameters<typeof actual.readFile>) => {
          const observed = loserWindowOpen && basename(String(args[0])) === "owner-transfer.json";

          try {
            const contents = await actual.readFile(...args);

            if (observed) {
              ownerTransferReadOutcomesInWindow.push("ok");
            }

            return contents;
          } catch (error) {
            if (observed) {
              ownerTransferReadOutcomesInWindow.push(`failed:${(error as NodeJS.ErrnoException).code}`);
            }

            throw error;
          }
        },
        rename: async (...args: Parameters<typeof actual.rename>) => {
          const source = basename(String(args[0]));

          if (loserWindowOpen && transactionPublishTempNames.has(source)) {
            publishTempRenameSourcesInWindow.push(source);
          }

          await actual.rename(...args);

          // The window opens AFTER the first publish rename has landed, so the loser observes the
          // transaction one file into its finalize — the instant the re-ruling is about.
          if (!interleaved && runLoserInsideWindow !== null && transactionPublishTempNames.has(source)) {
            interleaved = true;
            loserWindowOpen = true;

            try {
              await runLoserInsideWindow();
            } finally {
              loserWindowOpen = false;
            }
          }
        },
      };
    });

    try {
      const { writeOwnerTransferArtifacts } = await import("../../src/persistence/fileStore.js");
      const { runLoopFromState: observedRunLoopFromState } = await import("../../src/controller/runLoop.js");
      const { applyOwnerEpochTransfer } = await import("../../src/ownership/ownerController.js");

      await initializeRunFiles(runDir, contract, state);
      // The pre-transfer truth, and P1's CAS expectation. `ownerStatus: "lost"` plus changed paths
      // is the same lever the OWNER_UNDECIDABLE test above pulls: it keeps the loser's verdict at
      // OWNER_UNDECIDABLE with takeover denied, so the loser never attempts a transfer of its own
      // and reaches writeBoundaryArtifacts carrying a stale_candidate reconciliation record —
      // without which preserveSuccessfulReconciliationIfNeeded early-returns and neither assertion
      // below could observe anything.
      const priorOwnerRecord = {
        runId: "task-1",
        logicalSessionId: "task-1:publish-window",
        currentOwnerEpoch: 1,
        currentProcessInstanceId: buildProcessInstanceId(),
        lastAffirmedAt: "2026-07-23T00:00:00.000Z",
        ownerStatus: "lost" as const,
        supersededByEpoch: null,
        leaseAffirmedAt: null,
      };
      await writeOwnerRecord(runDir, priorOwnerRecord);
      expect(await pathExists(join(runDir, "owner-transfer.json"))).toBe(false);

      const winner = applyOwnerEpochTransfer(
        priorOwnerRecord,
        "pid:67890",
        "2026-07-23T00:01:00.000Z",
        "owner lost after reconciliation",
      );

      const adapter: RuntimeAdapter = {
        async plan() {
          return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
        },
        async execute(context) {
          await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
          await waitForAbort(context.abortSignal);
          return null;
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      runLoserInsideWindow = async () => {
        await observedRunLoopFromState(contract, runDir, adapter, state, undefined, undefined, {
          onReconciliationWriteAbandoned: (detail) => {
            reconciliationAbandonmentsInWindow.push(detail);
          },
        });
      };

      // P1. Its lock is held for the whole transaction by `pid:${process.pid}` — this very test
      // process, hence a demonstrably LIVE pid — which is the second step of the re-ruling: the
      // loser's readOwnerRecord must find that live lock and decline to finalize P1's transaction
      // on its behalf. Mutation 2 removes exactly that decline.
      await writeOwnerTransferArtifacts(
        runDir,
        priorOwnerRecord,
        winner.nextOwnerRecord,
        winner.transferRecord,
        {
          staleSuspicionBasis: ["winner: continuity suspicion confirmed"],
          staleConfirmed: true,
          ownershipVerdict: "OWNER_LOST",
          lastTrustedBoundary: "execute",
          conflictingEvidence: [],
          takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
          priorOwnerEpoch: 1,
          newOwnerEpoch: 2,
          eligibleForContinuation: true,
        },
      );

      // Fixture preconditions. Without these, both assertions below would pass vacuously on a
      // window that never opened or a loser that never carried a reconciliation record.
      expect(interleaved).toBe(true);
      const analysis = JSON.parse(
        await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
      ) as { status: string };
      expect(analysis.status).toBe("stale_candidate");

      // (a) The loser's protective write was ABANDONED inside the window, and abandoned for the
      // one reason D2 introduces: P1's transfer lock was held by a live pid for the whole
      // transaction, so the loser's read → decide → write never started. The detail string is the
      // operator-visible half of that abandonment (the events.jsonl half is written under a
      // swallowing try/catch and cannot carry a test's weight).
      expect(reconciliationAbandonmentsInWindow).toHaveLength(1);
      expect(reconciliationAbandonmentsInWindow[0]).toContain("OwnerTransferLockBusyError");
      // …and the read the old assertion (a) pinned is now unreachable here rather than merely
      // unobserved: the loser opened no protective read of owner-transfer.json at all.
      expect(ownerTransferReadOutcomesInWindow).toEqual([]);

      // (b) The loser did not finalize the winner's transaction on its behalf: no rename inside its
      // window took one of the transaction's publish temps as its source.
      expect(publishTempRenameSourcesInWindow).toEqual([]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  // Package 2 / §13 4th entry (D2) — interleaving 1 of 2. The pair exists because ONE terminal
  // assertion is not evidence: the 2026-08-02 ruling on the test above rejected a terminal
  // assertion precisely because the order it depended on was the harness's choice. A terminal state
  // that is identical under BOTH orders of the two lock spans is a property of the system; a
  // terminal state observed under one order is that same rejected trajectory wearing a new name. So
  // this file asserts the same terminal proposition twice, once per order, and neither test is
  // complete without the other.
  //
  // Order 1: the loser's whole span (acquire → read → decide → write → release) runs BEFORE the
  // winner takes the lock. Nothing is mocked and nothing is interleaved — this order needs no
  // fixture trickery, because two spans that do not overlap in time are exactly what the lock
  // produces on its own.
  //
  // The first two assertions are the ones that carry weight against the alternative fix this design
  // rejected (fail closed on a merely-absent owner-transfer.json): under that alternative the loser
  // writes nothing here, and "the terminal state is the winner's" would still be green — order
  // independence bought by deleting a product of the normal path. Asserting the loser's downgrade
  // IS on disk before the winner runs is what refuses that trade.
  it("keeps the loser's downgrade when its protected span runs first, and still ends at the winner's reconciliation record", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const state: RunState = {
      status: "planning",
      currentAttempt: 0,
      attemptsUsed: 0,
      lastTransitionAt: "2026-07-23T00:00:00.000Z",
      waitingOnHuman: false,
      stopReason: null,
      budgetSnapshot: {
        attemptsRemaining: contract.executionPolicy.maxAttempts,
        timeRemainingMs: contract.executionPolicy.totalRuntimeBudgetMs,
        tokenBudgetRemaining: contract.executionPolicy.tokenBudget,
      },
      recentFailures: [],
    };

    // Same lever as the test above: `ownerStatus: "lost"` plus changed paths keeps the loser's
    // verdict at OWNER_UNDECIDABLE with takeover denied, so it attempts no transfer of its own and
    // reaches writeBoundaryArtifacts carrying a stale_candidate downgrade.
    const priorOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1:lock-order-loser-first",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: buildProcessInstanceId(),
      lastAffirmedAt: "2026-07-23T00:00:00.000Z",
      ownerStatus: "lost" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };

    await initializeRunFiles(runDir, contract, state);
    await writeOwnerRecord(runDir, priorOwnerRecord);

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const abandonments: string[] = [];
    await runLoopFromState(contract, runDir, adapter, state, undefined, undefined, {
      onReconciliationWriteAbandoned: (detail) => {
        abandonments.push(detail);
      },
    });

    // The claim this order is here to make: acquiring the lock did not turn the normal path into a
    // refusal. A free lock is the common case (no concurrent transfer), and in it the loser still
    // publishes its downgrade.
    expect(abandonments).toEqual([]);
    const loserRecord = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as { newOwnerEpoch: number | null; eligibleForContinuation: boolean };
    expect(loserRecord.eligibleForContinuation).toBe(false);
    expect(loserRecord.newOwnerEpoch).toBeNull();

    // Fixture precondition: the loser left ownership alone, so the winner's CAS below is a genuine
    // epoch-1 transfer and not a mismatch dressed up as one.
    const persistedOwnerRecord = JSON.parse(
      await readFile(join(runDir, "owner-record.json"), "utf8"),
    ) as OwnerRecord;
    expect(persistedOwnerRecord.currentOwnerEpoch).toBe(1);

    const { writeOwnerTransferArtifacts } = await import("../../src/persistence/fileStore.js");
    const { applyOwnerEpochTransfer } = await import("../../src/ownership/ownerController.js");
    const winner = applyOwnerEpochTransfer(
      persistedOwnerRecord,
      "pid:67890",
      "2026-07-23T00:01:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerTransferArtifacts(
      runDir,
      persistedOwnerRecord,
      winner.nextOwnerRecord,
      winner.transferRecord,
      {
        staleSuspicionBasis: ["winner: continuity suspicion confirmed"],
        staleConfirmed: true,
        ownershipVerdict: "OWNER_LOST",
        lastTrustedBoundary: "execute",
        conflictingEvidence: [],
        takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
        priorOwnerEpoch: 1,
        newOwnerEpoch: 2,
        eligibleForContinuation: true,
      },
    );

    // The terminal proposition, order 1 of 2.
    const terminal = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as { newOwnerEpoch: number | null; eligibleForContinuation: boolean };
    expect(terminal.eligibleForContinuation).toBe(true);
    expect(terminal.newOwnerEpoch).toBe(2);
  });

  // Package 2 / §13 4th entry (D2) — interleaving 2 of 2, and the one with teeth.
  //
  // The fixture does not arrange the SAFE order and then assert it came out well; it arranges the
  // damaging one and asserts the system refuses to be put in it. Two hooks on node:fs/promises'
  // `rename` drive it: (i) the winner's transaction is held at its FIRST publish rename, i.e. with
  // owner-transfer.json published and owner-record.json still at the old epoch — the stale pair
  // that makes the published-winner check return false; (ii) the loser's own publish of
  // reconciliation-record.json is held until the winner's transaction has FULLY completed, so if
  // the loser ever gets that far its write lands after rename #3. That is the ordering the
  // 2026-08-02 ruling named as production-reachable ("the loser's write may perfectly well land
  // after rename #3"), and before D2 it ends with the winner's record destroyed.
  //
  // Under D2 hook (ii) never fires: the loser cannot start its read → decide → write while the
  // winner holds the transfer lock, and the winner is released instead by the loser's run
  // FINISHING (the Promise.race below), not by the loser reaching a write. Both branches of that
  // race are live — one per code shape — which is what keeps this fixture from deadlocking on
  // whichever shape it is measuring.
  //
  // The terminal assertion is deliberately first, ahead of the corroborating context: it is the
  // proposition the test is named for, so it must be the assertion that fires. Its pair is the test
  // above; neither order alone establishes anything, and a reviewer who runs only one of them has
  // measured a harness, not a system.
  it("keeps the winner's reconciliation record as the terminal state when the loser's write is forced to land after the winner's last rename", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const state: RunState = {
      status: "planning",
      currentAttempt: 0,
      attemptsUsed: 0,
      lastTransitionAt: "2026-07-23T00:00:00.000Z",
      waitingOnHuman: false,
      stopReason: null,
      budgetSnapshot: {
        attemptsRemaining: contract.executionPolicy.maxAttempts,
        timeRemainingMs: contract.executionPolicy.totalRuntimeBudgetMs,
        tokenBudgetRemaining: contract.executionPolicy.tokenBudget,
      },
      recentFailures: [],
    };

    const transactionPublishTempNames = new Set([
      ".owner-transfer.publish.tmp",
      ".owner-record.publish.tmp",
      ".reconciliation-record.publish.tmp",
    ]);

    let interleaved = false;
    let loserReachedItsOwnPublish = false;
    let runLoser: (() => Promise<void>) | null = null;
    let loserRun: Promise<void> | null = null;
    const abandonments: string[] = [];
    let releaseWinner: () => void = () => {};
    const winnerMayProceed = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let markWinnerTransactionDone: () => void = () => {};
    const winnerTransactionDone = new Promise<void>((resolve) => {
      markWinnerTransactionDone = resolve;
    });

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
          const source = basename(String(args[0]));
          const target = basename(String(args[1]));

          // Hook (ii). The loser's own atomic publish goes through buildAtomicTempPath, whose
          // per-process stamp cannot collide with the transaction's three fixed publish temps, so
          // the source test distinguishes the two writers without a spy.
          if (target === "reconciliation-record.json" && !transactionPublishTempNames.has(source)) {
            loserReachedItsOwnPublish = true;
            releaseWinner();
            await winnerTransactionDone;
          }

          await actual.rename(...args);

          // Hook (i).
          if (!interleaved && runLoser !== null && transactionPublishTempNames.has(source)) {
            interleaved = true;
            loserRun = runLoser();
            await Promise.race([winnerMayProceed, loserRun.then(() => undefined, () => undefined)]);
          }
        },
      };
    });

    try {
      const { writeOwnerTransferArtifacts } = await import("../../src/persistence/fileStore.js");
      const { runLoopFromState: observedRunLoopFromState } = await import("../../src/controller/runLoop.js");
      const { applyOwnerEpochTransfer } = await import("../../src/ownership/ownerController.js");

      await initializeRunFiles(runDir, contract, state);
      const priorOwnerRecord = {
        runId: "task-1",
        logicalSessionId: "task-1:lock-order-winner-first",
        currentOwnerEpoch: 1,
        currentProcessInstanceId: buildProcessInstanceId(),
        lastAffirmedAt: "2026-07-23T00:00:00.000Z",
        ownerStatus: "lost" as const,
        supersededByEpoch: null,
        leaseAffirmedAt: null,
      };
      await writeOwnerRecord(runDir, priorOwnerRecord);

      const winner = applyOwnerEpochTransfer(
        priorOwnerRecord,
        "pid:67890",
        "2026-07-23T00:01:00.000Z",
        "owner lost after reconciliation",
      );

      const adapter: RuntimeAdapter = {
        async plan() {
          return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
        },
        async execute(context) {
          await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
          await waitForAbort(context.abortSignal);
          return null;
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      runLoser = async () => {
        await observedRunLoopFromState(contract, runDir, adapter, state, undefined, undefined, {
          onReconciliationWriteAbandoned: (detail) => {
            abandonments.push(detail);
          },
        });
      };

      // P1, holding the lock for its whole transaction under this very test process's live pid.
      await writeOwnerTransferArtifacts(
        runDir,
        priorOwnerRecord,
        winner.nextOwnerRecord,
        winner.transferRecord,
        {
          staleSuspicionBasis: ["winner: continuity suspicion confirmed"],
          staleConfirmed: true,
          ownershipVerdict: "OWNER_LOST",
          lastTrustedBoundary: "execute",
          conflictingEvidence: [],
          takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
          priorOwnerEpoch: 1,
          newOwnerEpoch: 2,
          eligibleForContinuation: true,
        },
      );
      markWinnerTransactionDone();

      if (loserRun !== null) {
        await loserRun;
      }

      // The terminal proposition, order 2 of 2 — same proposition as the test above, opposite order.
      const terminal = JSON.parse(
        await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
      ) as { newOwnerEpoch: number | null; eligibleForContinuation: boolean };
      expect(terminal.eligibleForContinuation).toBe(true);
      expect(terminal.newOwnerEpoch).toBe(2);

      // Corroborating context, kept below the claim on purpose. Without these the terminal
      // assertion could be green on a fixture where the two never met at all.
      expect(interleaved).toBe(true);
      const analysis = JSON.parse(
        await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
      ) as { status: string };
      expect(analysis.status).toBe("stale_candidate");
      expect(loserReachedItsOwnPublish).toBe(false);
      expect(abandonments).toHaveLength(1);
      expect(abandonments[0]).toContain("OwnerTransferLockBusyError");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("persists owner transfer artifacts and continuation eligibility after a controller-owned OWNER_LOST takeover-allowed verdict without resuming execution", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
          runId: "task-1",
          logicalSessionId: "task-1:lost",
          currentOwnerEpoch: 1,
          currentProcessInstanceId: buildProcessInstanceId(),
          lastAffirmedAt: "2026-07-23T00:00:00.000Z",
          ownerStatus: "lost",
          supersededByEpoch: null,
        }, null, 2));
        await waitForAbortThenFlush(context);
        return null;
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
    };
    const transfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
      priorOwnerEpoch: number;
      newOwnerEpoch: number;
      eligibleForContinuation: boolean;
      newProcessInstanceId: string;
    };
    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as {
      ownershipVerdict: string;
      priorOwnerEpoch: number | null;
      newOwnerEpoch: number | null;
      eligibleForContinuation: boolean;
    };

    expect(owner.currentOwnerEpoch).toBe(2);
    expect(owner.currentProcessInstanceId).toBe(buildProcessInstanceId());
    expect(transfer.priorOwnerEpoch).toBe(1);
    expect(transfer.newOwnerEpoch).toBe(2);
    expect(transfer.eligibleForContinuation).toBe(true);
    expect(transfer.newProcessInstanceId).toBe(buildProcessInstanceId());
    expect(reconciliation.ownershipVerdict).toBe("OWNER_LOST");
    expect(reconciliation.priorOwnerEpoch).toBe(1);
    expect(reconciliation.newOwnerEpoch).toBe(2);
    expect(reconciliation.eligibleForContinuation).toBe(true);
    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe(BUDGET_EXHAUSTED_REASON);
    expect(verifyCalled).toBe(false);
    // Final-review fix 1. The transfer moves the record to epoch 2 and names THIS process; the
    // heartbeat adopts it, so the guards that follow compare against what is actually on disk
    // and none of them concludes supersession. Before the fix this list ended in a "lease_lost"
    // event whose expected and observed process instance IDs were IDENTICAL — a false takeover
    // signal in the evidence stream that exists for later layers to consume.
    expect(await readEventTypes(runDir)).toEqual([
      "loop_planning",
      "attempt_started",
      "execute_started",
      "owner_epoch_transferred",
      "loop_exhausted",
    ]);
    // The post-terminal cleanup is no longer refused, so the attempt worktree is removed
    // instead of being leaked as a registered git worktree in the user's repo. The
    // already-persisted terminal decision is untouched either way (asserted above).
    await expect(readdir(join(runDir, "worktrees"))).resolves.toEqual([]);
    // Stated separately from the event-list assertion because it is the specific defect:
    // no event may claim this process was superseded by itself.
    expect(await readEventDetails(runDir, "lease_lost")).toEqual([]);
  });

  it("preserves the winner reconciliation view when another controller already completed the transfer", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    vi.resetModules();
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );
      let readCount = 0;

      return {
        ...actual,
        readOwnerRecord: async (observedRunDir: string) => {
          const owner = await actual.readOwnerRecord(observedRunDir);
          readCount += 1;

          if (readCount === 1) {
            await actual.writeOwnerRecord(observedRunDir, {
              ...owner,
              currentOwnerEpoch: owner.currentOwnerEpoch + 1,
              currentProcessInstanceId: "pid:other-controller",
              lastAffirmedAt: "2026-07-23T00:00:01.000Z",
              ownerStatus: "current",
            });
            await actual.writeOwnerTransferRecord(observedRunDir, {
              priorOwnerEpoch: owner.currentOwnerEpoch,
              newOwnerEpoch: owner.currentOwnerEpoch + 1,
              priorProcessInstanceId: owner.currentProcessInstanceId,
              newProcessInstanceId: "pid:other-controller",
              transferredAt: "2026-07-23T00:00:01.000Z",
              reason: "owner lost after reconciliation",
              eligibleForContinuation: true,
            });
            await actual.writeBoundaryArtifacts(observedRunDir, {
              boundaryAnalysis: {
                status: "stale_candidate",
                strongProgressAt: null,
                weakProgressAt: null,
                suspectReason: null,
                staleCandidateReason: "continuity evidence missing",
              },
              reconciliationRecord: {
                staleSuspicionBasis: ["continuity evidence missing"],
                staleConfirmed: true,
                ownershipVerdict: "OWNER_LOST",
                lastTrustedBoundary: "execute",
                conflictingEvidence: [],
                takeoverPermission: {
                  allowed: true,
                  reason: "strict owner-loss conditions satisfied; continuation still requires a later transfer step",
                },
                priorOwnerEpoch: owner.currentOwnerEpoch,
                newOwnerEpoch: owner.currentOwnerEpoch + 1,
                eligibleForContinuation: true,
              },
            });
          }

          return owner;
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter: RuntimeAdapter = {
        async plan() {
          return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
        },
        async execute(context) {
          await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
            runId: "task-1",
            logicalSessionId: "task-1:lost",
            currentOwnerEpoch: 1,
            currentProcessInstanceId: buildProcessInstanceId(),
            lastAffirmedAt: "2026-07-23T00:00:00.000Z",
            ownerStatus: "lost",
            supersededByEpoch: null,
          }, null, 2));
          await waitForAbort(context.abortSignal);
          return null;
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
        currentOwnerEpoch: number;
        currentProcessInstanceId: string;
        ownerStatus: string;
      };
      const transfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
        priorOwnerEpoch: number;
        newOwnerEpoch: number;
        newProcessInstanceId: string;
        eligibleForContinuation: boolean;
      };
      const reconciliation = JSON.parse(
        await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
      ) as {
        ownershipVerdict: string;
        priorOwnerEpoch: number | null;
        newOwnerEpoch: number | null;
        eligibleForContinuation: boolean;
        takeoverPermission: { allowed: boolean };
      };

      expect(owner.currentOwnerEpoch).toBe(2);
      expect(owner.currentProcessInstanceId).toBe("pid:other-controller");
      expect(owner.ownerStatus).toBe("current");
      expect(transfer.priorOwnerEpoch).toBe(1);
      expect(transfer.newOwnerEpoch).toBe(2);
      expect(transfer.newProcessInstanceId).toBe("pid:other-controller");
      expect(transfer.eligibleForContinuation).toBe(true);
      expect(reconciliation.ownershipVerdict).toBe("OWNER_LOST");
      expect(reconciliation.priorOwnerEpoch).toBe(1);
      expect(reconciliation.newOwnerEpoch).toBe(2);
      expect(reconciliation.eligibleForContinuation).toBe(true);
      expect(reconciliation.takeoverPermission.allowed).toBe(true);
      // Task 5, human ruling: persistBoundaryAnalysis's write guard is unconditional, so this
      // process's own (failed-CAS, would-have-preserved-the-winner) write never happens at all
      // — refused BEFORE persistTerminalState ever runs, not after it. The run therefore never
      // reaches "exhausted"; "cancelled"/lease_lost is the reported terminal outcome instead.
      // The reconciliation/owner/transfer field assertions above are unaffected: those files
      // were written directly by the mocked "other controller" (readOwnerRecord's fake write),
      // not by this process, so their content is identical whether or not this process's own
      // (now-refused) write ever lands.
      expect(finalState.status).toBe("cancelled");
      expect(finalState.stopReason).toBe("lease_lost");
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "execute_started",
        // Task 5: the other controller's record is what persistBoundaryAnalysis's OWN write
        // guard now reads (before this process would have written anything), so it concludes
        // supersession here — earlier than the old post-terminal-cleanup guard used to. This
        // is a genuine foreign takeover: this transfer is not performed by this process, its
        // CAS fails against the other controller's record, and heartbeat.adopt is never
        // reached — leaving the stale expectation and the refusal exactly as they were. Note
        // the two sides of the detail below differ.
        "lease_lost",
        // Emitted by the outer catch's isLeaseStopError branch, since state.status was not yet
        // terminal when the guard fired (this attempt never got as far as persistTerminalState).
        "loop_cancelled",
        // Package 2 / task 2, human ruling 14. persistTerminalState's ownership guard reads
        // owner-record.json, finds pid:other-controller rather than this process, and declines to
        // persist the terminal run status — recording the abandonment here rather than failing
        // silently. The status this process reports (asserted above) is unchanged; what the guard
        // withholds is the write to a run it no longer owns. This entry was added because the
        // exhaustive list's premise changed, not because the list was wrong.
        "terminal_write_abandoned",
      ]);
      await expect(readdir(join(runDir, "worktrees"))).resolves.toEqual(["attempt-1"]);
      expect(await readEventDetails(runDir, "lease_lost")).toEqual([
        `expected ${buildProcessInstanceId()} at epoch 1, observed pid:other-controller at epoch 2`,
      ]);
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });

  it("writes no synthesized winner reconciliation view when another controller already completed the transfer before success reconciliation was written", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    vi.resetModules();
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );
      let readCount = 0;

      return {
        ...actual,
        readOwnerRecord: async (observedRunDir: string) => {
          const owner = await actual.readOwnerRecord(observedRunDir);
          readCount += 1;

          if (readCount === 1) {
            await actual.writeOwnerRecord(observedRunDir, {
              ...owner,
              currentOwnerEpoch: owner.currentOwnerEpoch + 1,
              currentProcessInstanceId: "pid:other-controller",
              lastAffirmedAt: "2026-07-23T00:00:01.000Z",
              ownerStatus: "current",
            });
            await actual.writeOwnerTransferRecord(observedRunDir, {
              priorOwnerEpoch: owner.currentOwnerEpoch,
              newOwnerEpoch: owner.currentOwnerEpoch + 1,
              priorProcessInstanceId: owner.currentProcessInstanceId,
              newProcessInstanceId: "pid:other-controller",
              transferredAt: "2026-07-23T00:00:01.000Z",
              reason: "owner lost after reconciliation",
              eligibleForContinuation: true,
            });
          }

          return owner;
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter: RuntimeAdapter = {
        async plan() {
          return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
        },
        async execute(context) {
          await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
            runId: "task-1",
            logicalSessionId: "task-1:lost",
            currentOwnerEpoch: 1,
            currentProcessInstanceId: buildProcessInstanceId(),
            lastAffirmedAt: "2026-07-23T00:00:00.000Z",
            ownerStatus: "lost",
            supersededByEpoch: null,
          }, null, 2));
          await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
          await waitForAbort(context.abortSignal);
          return null;
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
        currentOwnerEpoch: number;
        currentProcessInstanceId: string;
        ownerStatus: string;
      };
      const transfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
        priorOwnerEpoch: number;
        newOwnerEpoch: number;
        newProcessInstanceId: string;
        eligibleForContinuation: boolean;
      };

      expect(owner.currentOwnerEpoch).toBe(2);
      expect(owner.currentProcessInstanceId).toBe("pid:other-controller");
      expect(owner.ownerStatus).toBe("current");
      expect(transfer.priorOwnerEpoch).toBe(1);
      expect(transfer.newOwnerEpoch).toBe(2);
      expect(transfer.newProcessInstanceId).toBe("pid:other-controller");
      expect(transfer.eligibleForContinuation).toBe(true);
      // Task 5, human ruling: persistBoundaryAnalysis's write guard is unconditional. Unlike
      // the sibling test above (where the mocked "other controller" wrote
      // reconciliation-record.json directly), THIS test's whole point was that no
      // reconciliation-record.json exists yet — only owner-record.json / owner-transfer.json,
      // published by the rival — and it is THIS process's OWN write that used to synthesize
      // one from them (writeBoundaryArtifacts's `readPersistedSuccessfulTransferArtifacts` /
      // `resolveSuccessfulReconciliation` path, fileStore.ts). That write is refused before it
      // ever runs now, so the synthesis never happens: neither reconciliation-record.json nor
      // boundary-analysis.json is created at all. The old field-by-field assertions about the
      // synthesized content are removed; a superseded process no longer produces that view —
      // if it is still wanted, it belongs to whichever process still holds the run (L5's
      // problem, not this branch's).
      await expect(access(join(runDir, "reconciliation-record.json"))).rejects.toThrow();
      await expect(access(join(runDir, "boundary-analysis.json"))).rejects.toThrow();
      expect(finalState.status).toBe("cancelled");
      expect(finalState.stopReason).toBe("lease_lost");
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "execute_started",
        // Task 5: same mechanism as the sibling test above — persistBoundaryAnalysis's own
        // write guard now concludes supersession before this process would have written (or,
        // here, synthesized) anything, earlier than the old post-terminal-cleanup guard used
        // to. A genuine foreign takeover: this transfer is not performed by this process, its
        // CAS fails against the other controller's record, and heartbeat.adopt is never
        // reached.
        "lease_lost",
        // Emitted by the outer catch's isLeaseStopError branch, since state.status was not yet
        // terminal when the guard fired.
        "loop_cancelled",
        // Package 2 / task 2, human ruling 14 — same mechanism as the sibling test above:
        // persistTerminalState's ownership guard declines to persist the terminal run status into
        // a run owned by pid:other-controller, and records that abandonment rather than failing
        // silently.
        "terminal_write_abandoned",
      ]);
      await expect(readdir(join(runDir, "worktrees"))).resolves.toEqual(["attempt-1"]);
      expect(await readEventDetails(runDir, "lease_lost")).toEqual([
        `expected ${buildProcessInstanceId()} at epoch 1, observed pid:other-controller at epoch 2`,
      ]);
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });

  it("records retained cleanupStatus in execution recovery when cleanup fails", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        cleanupAttemptWorkspace: async () => {
          throw new Error("cleanup exploded");
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter: RuntimeAdapter = {
        async plan() {
          return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
        },
        async execute(context) {
          await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 4;\n");
          await waitForAbortThenFlush(context);
          return null;
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const recovery = JSON.parse(
        await readFile(join(runDir, "attempts", "1", "execution-recovery.json"), "utf8"),
      ) as {
        executeEntered: true;
        captureStatus: string;
        cleanupStatus: string;
      };

      expect(finalState.status).toBe("exhausted");
      expect(finalState.stopReason).toBe(BUDGET_EXHAUSTED_REASON);
      expect(recovery.executeEntered).toBe(true);
      expect(recovery.captureStatus).toBe("partial");
      expect(recovery.cleanupStatus).toBe("retained");
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "execute_started",
        "loop_exhausted",
        "workspace_cleanup_failed",
      ]);
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("persists completed plan artifacts when execute timeout yields no adapter result before verify", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe("execute phase exceeded per-attempt timeout of 20ms");
    expect(persistedState.status).toBe("exhausted");
    expect(persistedState.stopReason).toBe("execute phase exceeded per-attempt timeout of 20ms");
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(false);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "execute_started", "loop_exhausted"]);
  });


  it("treats execute timeout with no adapter result as exhausted even if files changed in the worktree", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        denylistPaths: ["secret.txt"],
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "touch denylisted file", primaryTargetPaths: ["secret.txt"] };
      },
      async execute(context) {
        await writeFile(join(context.worktreePath, "secret.txt"), "partial output\n");
        await waitForAbortThenFlush(context);
        return null;
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe("runtime or token budget exhausted");
    expect(finalState.budgetSnapshot).toMatchObject({
      attemptsRemaining: 2,
      timeRemainingMs: 0,
    });
    expect(persistedState.status).toBe("exhausted");
    expect(persistedState.stopReason).toBe("runtime or token budget exhausted");
    expect(persistedState.budgetSnapshot).toMatchObject({
      attemptsRemaining: 2,
      timeRemainingMs: 0,
    });
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(false);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "execute_started", "loop_exhausted"]);
  });

  it("blocks for human input on execute timeout when the adapter returns a partial outcome with gated files", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 50,
      },
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        denylistPaths: ["secret.txt"],
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "touch denylisted file", primaryTargetPaths: ["secret.txt"] };
      },
      async execute(context) {
        await writeFile(join(context.worktreePath, "secret.txt"), "partial output\n");
        await delay(60);
        return {
          completionStatus: "partial",
          failureType: "timeout",
          failureMessage: "adapter timed out",
          changedFiles: ["secret.txt"],
          diffPatch: "diff --git a/secret.txt b/secret.txt",
          commandOutputs: ["edited"],
          stdoutStderrLog: "timed out",
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.stopReason).toBe("denylist match: secret.txt");
    expect(finalState.budgetSnapshot).toMatchObject({
      attemptsRemaining: 2,
      timeRemainingMs: 0,
    });
    expect(persistedState.status).toBe("blocked_waiting_human");
    expect(persistedState.stopReason).toBe("denylist match: secret.txt");
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "diff.patch"))).toBe(true);
    expect(await pathExists(join(attemptDir, "stdout-stderr.log"))).toBe(true);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "execute_started", "loop_blocked_waiting_human"]);
  });


  it("continues normally when execute returns a complete result during the recovery window", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 20,
        partialOutcomeRecoveryWindowMs: 30,
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        await delay(40);
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        };
      },
      async verify() {
        verifyCalled = true;
        return {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["npm test passed"],
          pauseSignals: [],
          stopSignals: [],
        };
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("succeeded");
    expect(finalState.stopReason).toBe("success condition satisfied");
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.budgetSnapshot.timeRemainingMs).toBeLessThan(baseContract.executionPolicy.totalRuntimeBudgetMs);
    expect(persistedState.status).toBe("succeeded");
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(true);
    expect(verifyCalled).toBe(true);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "execute_started", "execution_finished", "loop_succeeded"]);
  });

  it("blocks for human input on execute errors when the adapter returns a partial outcome with gated files", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        denylistPaths: ["secret.txt"],
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "touch denylisted file", primaryTargetPaths: ["secret.txt"] };
      },
      async execute() {
        return {
          completionStatus: "partial",
          failureType: "error",
          failureMessage: "adapter exploded",
          changedFiles: ["secret.txt"],
          diffPatch: "diff --git a/secret.txt b/secret.txt",
          commandOutputs: ["edited"],
          stdoutStderrLog: "error",
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.stopReason).toBe("denylist match: secret.txt");
    expect(persistedState.status).toBe("blocked_waiting_human");
    expect(persistedState.stopReason).toBe("denylist match: secret.txt");
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(true);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "execute_started", "loop_blocked_waiting_human"]);
  });

  it("treats execute errors without adapter partial outcome as failed even if files changed in the worktree", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      safetyPolicy: {
        ...baseContract.safetyPolicy,
        denylistPaths: ["secret.txt"],
      },
    };
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "touch denylisted file", primaryTargetPaths: ["secret.txt"] };
      },
      async execute(context) {
        await writeFile(join(context.worktreePath, "secret.txt"), "partial output\n");
        throw new Error("execute exploded");
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("failed");
    expect(finalState.stopReason).toBe("Error: execute exploded");
    expect(persistedState.status).toBe("failed");
    expect(persistedState.stopReason).toBe("Error: execute exploded");
    expect(await pathExists(join(attemptDir, "plan.json"))).toBe(false);
    expect(await pathExists(join(attemptDir, "execution.json"))).toBe(false);
    expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "execute_started", "attempt_failed"]);
  });

  it("caps phase timeout by the remaining runtime budget", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 1_000,
        totalRuntimeBudgetMs: 20,
      },
    };
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let executeCalled = false;
    let verifyCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        await delay(60);
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        executeCalled = true;
        throw new Error("execute should not run");
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe("runtime or token budget exhausted");
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(finalState.budgetSnapshot.timeRemainingMs).toBe(0);
    expect(persistedState.status).toBe("exhausted");
    expect(persistedState.stopReason).toBe("runtime or token budget exhausted");
    expect(executeCalled).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(stdout).not.toContain(attemptWorktreePath);
    expect(await readEventTypes(runDir)).toEqual(["loop_planning", "loop_exhausted"]);
  });

  // getPhaseTimeoutMs is min(perAttemptTimeoutMs, timeRemainingMs), so when the budget is the
  // smaller operand a fired timeout means the budget is spent BY DEFINITION. The exhaustion
  // predicate must not re-derive that fact from a wall-clock reading: hasBudgetExceeded wants
  // timeRemainingMs === 0, which needs the charged elapsed to reach the timeout, and the two
  // clock reads bracketing the timer are only accurate to the clock's resolution.
  //
  // Freezing Date while leaving the timers real (the toFake: ["Date"] pattern
  // leaseLifecycle.integration.test.ts already uses) drives the measured elapsed to 0. That is
  // the same dependence the sibling test above rides on a sub-millisecond margin, made
  // deterministic instead of probabilistic — this test does not measure timing, it asserts the
  // decision does not consult the clock at all.
  //
  // Charging the raw elapsedMs in the timeout branches of runPhaseWithTimeout instead of
  // Math.max(elapsedMs, timeoutMs) makes this test fail: the run stops with the per-attempt
  // timeout reason and an untouched timeRemainingMs rather than exhausting.
  it("accounts a budget-capped phase timeout as exhaustion even when the clock reports no elapsed time", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 1_000,
        totalRuntimeBudgetMs: 20,
      },
    };
    let executeCalled = false;

    const adapter: RuntimeAdapter = {
      async plan() {
        await delay(60);
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        executeCalled = true;
        throw new Error("execute should not run");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    vi.useFakeTimers({ toFake: ["Date"] });
    let finalState;
    try {
      finalState = await runLoop(contract, runDir, adapter);
    } finally {
      vi.useRealTimers();
    }

    expect(finalState.status).toBe("exhausted");
    expect(finalState.stopReason).toBe("runtime or token budget exhausted");
    expect(finalState.budgetSnapshot.timeRemainingMs).toBe(0);
    expect(executeCalled).toBe(false);
  });

  // The three tests above and below freeze Date. Their own try/finally cannot restore it if the
  // test itself times out while runLoop is pending, and a frozen Date would then leak into every
  // later test in this file. Cheap to close, so closed.
  afterEach(() => {
    vi.useRealTimers();
  });

  // The plan-phase test above only reaches the non-awaited timeout return. The execute phase is
  // the one that passes awaitAbortedResult, and it has TWO further returns — one for an
  // operation that resolves after the abort, one for an operation that rejects after it. Both
  // carry their own quota floor, and a whole-branch review proved by running that reverting both
  // of them leaves the suite green: the change shipped three behaviour changes and guarded one.
  // These two tests guard the other two.
  //
  // This one also pins a contract-visible consequence that no test pinned AS A CONSEQUENCE OF
  // THE QUOTA FLOOR. An earlier claim here — "no test pinned it in either direction" — was
  // false: "persists execution-recovery.json when execute is entered but returns no result
  // before exhaustion" above has asserted failureBoundary === "runtime_exhausted" since before
  // this branch (it is in the 07180a7 version of this file too). What it does not pin is the
  // floor: it sets perAttemptTimeoutMs === totalRuntimeBudgetMs === 20 and reaches
  // runtime_exhausted through measured wall clock, so reverting both quota floors in
  // runPhaseWithTimeout leaves it green — the whole-branch mutation that motivated these two
  // tests measured exactly that. getExecutionFailureBoundary branches on timeRemainingMs === 0,
  // so here, where perAttemptTimeoutMs (1000) is far above the budget (20), the persisted
  // failureBoundary is what proves the floor was applied and not merely that the run stopped.
  it("accounts an execute timeout that resolves after the abort as exhaustion, and records the boundary as runtime_exhausted", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 1_000,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await waitForAbortThenFlush(context);
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    vi.useFakeTimers({ toFake: ["Date"] });
    let finalState;
    try {
      finalState = await runLoop(contract, runDir, adapter);
    } finally {
      vi.useRealTimers();
    }

    const recovery = JSON.parse(
      await readFile(join(runDir, "attempts", "1", "execution-recovery.json"), "utf8"),
    ) as { failureBoundary: string };

    expect(finalState.stopReason).toBe("runtime or token budget exhausted");
    expect(finalState.budgetSnapshot.timeRemainingMs).toBe(0);
    expect(recovery.failureBoundary).toBe("runtime_exhausted");
  });

  // The sibling of the above: the operation REJECTS after the abort, which is a different return
  // statement carrying its own floor. Asserting the same exhaustion from a rejection is what
  // separates the two — revert only this one's floor and only this test goes red.
  it("accounts an execute timeout that rejects after the abort as exhaustion", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 1_000,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
      },
    };

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await waitForAbortThenFlush(context);
        throw new Error("adapter failed after the abort");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    vi.useFakeTimers({ toFake: ["Date"] });
    let finalState;
    try {
      finalState = await runLoop(contract, runDir, adapter);
    } finally {
      vi.useRealTimers();
    }

    expect(finalState.stopReason).toBe("runtime or token budget exhausted");
    expect(finalState.budgetSnapshot.timeRemainingMs).toBe(0);
  });

  it("persists phase usage evidence from the subprocess adapter without recomputing controller totals", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const originalPath = process.env.PATH;
    const fakeBinDir = await createUsageAwareFakeClaude();
    const adapter = new SubprocessClaudeAdapter({ command: ["node", phaseRunnerPath] });

    try {
      process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;

      const finalState = await runLoop(contract, runDir, adapter);
      const attemptDir = join(runDir, "attempts", "1");
      const plan = JSON.parse(await readFile(join(attemptDir, "plan.json"), "utf8")) as {
        tokenUsage: number;
        usageEvidence: {
          normalizedTotal: number | null;
          selectedInputField: string | null;
          selectedOutputField: string | null;
        };
      };
      const execution = JSON.parse(await readFile(join(attemptDir, "execution.json"), "utf8")) as {
        tokenUsage: number;
        usageEvidence: {
          normalizedTotal: number | null;
          selectedInputField: string | null;
          selectedOutputField: string | null;
        };
      };
      const verify = JSON.parse(await readFile(join(attemptDir, "verify.json"), "utf8")) as {
        tokenUsage: number;
        usageEvidence: {
          normalizedTotal: number | null;
          selectedInputField: string | null;
          selectedOutputField: string | null;
        };
      };
      const persistedState = await readRunState(runDir);
      const serializedArtifacts = JSON.stringify({ plan, execution, verify });

      expect(finalState.status).toBe("succeeded");
      expect(plan.tokenUsage).toBe(110);
      expect(execution.tokenUsage).toBe(220);
      expect(verify.tokenUsage).toBe(330);
      expect(plan.usageEvidence.normalizedTotal).toBe(plan.tokenUsage);
      expect(execution.usageEvidence.normalizedTotal).toBe(execution.tokenUsage);
      expect(verify.usageEvidence.normalizedTotal).toBe(verify.tokenUsage);
      expect(plan.usageEvidence.selectedInputField).toBe("input_tokens");
      expect(plan.usageEvidence.selectedOutputField).toBe("output_tokens");
      expect(execution.usageEvidence.selectedInputField).toBe("inputTokens");
      expect(execution.usageEvidence.selectedOutputField).toBe("outputTokens");
      expect(verify.usageEvidence.selectedInputField).toBe("input_tokens");
      expect(verify.usageEvidence.selectedOutputField).toBe("outputTokens");
      expect(persistedState.budgetSnapshot.tokenBudgetRemaining).toBe(1000 - 110 - 220 - 330);
      expect(serializedArtifacts).not.toContain("DO_NOT_PERSIST");
      expect(serializedArtifacts).not.toContain("unknown_usage");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it("stops after plan token usage exhausts the token budget", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let executeCalled = false;
    let verifyCalled = false;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => 1_000);

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"], tokenUsage: 1_000 };
      },
      async execute() {
        executeCalled = true;
        throw new Error("execute should not run");
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    try {
      const finalState = await runLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);
      const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

      expect(finalState.status).toBe("exhausted");
      expect(finalState.stopReason).toBe("runtime or token budget exhausted");
      expect(finalState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 5_000,
        tokenBudgetRemaining: 0,
      });
      expect(persistedState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 5_000,
        tokenBudgetRemaining: 0,
      });
      expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
      expect(await pathExists(join(attemptDir, "execution.json"))).toBe(false);
      expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
      expect(executeCalled).toBe(false);
      expect(verifyCalled).toBe(false);
      expect(stdout).not.toContain(attemptWorktreePath);
      expect(await readEventTypes(runDir)).toEqual(["loop_planning", "loop_exhausted"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("stops after execute token usage exhausts the token budget", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const attemptDir = join(runDir, "attempts", "1");
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    let verifyCalled = false;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => 1_000);

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute() {
        return {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
          tokenUsage: 1_000,
        };
      },
      async verify() {
        verifyCalled = true;
        throw new Error("verify should not run");
      },
    };

    try {
      const finalState = await runLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);
      const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

      expect(finalState.status).toBe("exhausted");
      expect(finalState.stopReason).toBe("runtime or token budget exhausted");
      expect(finalState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 5_000,
        tokenBudgetRemaining: 0,
      });
      expect(persistedState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 5_000,
        tokenBudgetRemaining: 0,
      });
      expect(await pathExists(join(attemptDir, "plan.json"))).toBe(true);
      expect(await pathExists(join(attemptDir, "execution.json"))).toBe(true);
      expect(await pathExists(join(attemptDir, "diff.patch"))).toBe(true);
      expect(await pathExists(join(attemptDir, "stdout-stderr.log"))).toBe(true);
      expect(await pathExists(join(attemptDir, "verify.json"))).toBe(false);
      expect(verifyCalled).toBe(false);
      expect(stdout).not.toContain(attemptWorktreePath);
      expect(await readEventTypes(runDir)).toEqual(["loop_planning", "attempt_started", "execute_started", "loop_exhausted"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("exhausts the run when adapter-reported token usage exceeds the token budget", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");
    // §7/§6.0: the lease gate and, after this task, the heartbeat's affirmNow() at the top
    // of the loop each call Date.now() before the plan phase's own timing calls — one for
    // the gate, three for the heartbeat's throttle check and affirm write — so four extra
    // timestamp values are needed at the start before the plan phase's startedAtMs/elapsedMs
    // pair (1_000 / 1_600, giving the 600ms elapsed this test asserts on).
    const timestamps = [1_000, 1_000, 1_000, 1_000, 1_000, 1_600];
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => timestamps.shift() ?? 1_600);

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"], tokenUsage: 400 },
        execution: {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "fail",
          tokenUsage: 350,
        },
        verification: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: "npm test",
          safeToRetry: true,
          evidence: ["token budget exhausted"],
          pauseSignals: [],
          stopSignals: [],
          tokenUsage: 500,
        },
      },
    ]);

    try {
      const finalState = await runLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);
      const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

      expect(finalState.status).toBe("exhausted");
      expect(finalState.stopReason).toBe("runtime or token budget exhausted");
      expect(finalState.attemptsUsed).toBe(1);
      expect(finalState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 4_400,
        tokenBudgetRemaining: 0,
      });
      expect(persistedState.budgetSnapshot).toMatchObject({
        attemptsRemaining: 2,
        timeRemainingMs: 4_400,
        tokenBudgetRemaining: 0,
      });
      expect(stdout).not.toContain(attemptWorktreePath);
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "execute_started",
        "execution_finished",
        "loop_exhausted",
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("returns the terminal state when cleanup fails after a non-human terminal decision", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        cleanupAttemptWorkspace: async () => {
          throw new Error("cleanup exploded");
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter = new ScriptedAdapter([
        {
          plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
          execution: {
            changedFiles: ["src/index.ts"],
            diffPatch: "diff --git a/src/index.ts b/src/index.ts",
            commandOutputs: ["edited"],
            stdoutStderrLog: "ok",
          },
          verification: {
            approved: true,
            rejectCategory: "",
            primaryTargetPaths: ["src/index.ts"],
            failingCommand: null,
            safeToRetry: false,
            evidence: ["pass"],
            pauseSignals: [],
            stopSignals: [],
          },
        },
      ]);

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);
      const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

      expect(finalState.status).toBe("succeeded");
      expect(finalState.stopReason).toBe("success condition satisfied");
      expect(persistedState.status).toBe("succeeded");
      expect(persistedState.stopReason).toBe("success condition satisfied");
      expect(stdout).toContain(attemptWorktreePath);
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "execute_started",
        "execution_finished",
        "loop_succeeded",
        "workspace_cleanup_failed",
      ]);
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("returns a failed terminal state when retry cleanup fails", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        cleanupAttemptWorkspace: async () => {
          throw new Error("cleanup exploded");
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter = new ScriptedAdapter([
        {
          plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
          execution: {
            changedFiles: ["src/index.ts"],
            diffPatch: "diff --git a/src/index.ts b/src/index.ts",
            commandOutputs: ["edited"],
            stdoutStderrLog: "fail",
          },
          verification: {
            approved: false,
            rejectCategory: "tests-failed",
            primaryTargetPaths: ["src/index.ts"],
            failingCommand: "npm test",
            safeToRetry: true,
            evidence: ["FAIL"],
            pauseSignals: [],
            stopSignals: [],
          },
        },
      ]);

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);

      expect(finalState.status).toBe("failed");
      expect(finalState.stopReason).toBe("Error: cleanup exploded");
      expect(persistedState.status).toBe("failed");
      expect(persistedState.stopReason).toBe("Error: cleanup exploded");
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_started",
        "execute_started",
        "execution_finished",
        "verification_rejected",
        "attempt_failed",
        "workspace_cleanup_failed",
      ]);
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("returns failed when planning throws and follow-up cleanup also fails", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        cleanupAttemptWorkspace: async () => {
          throw new Error("cleanup exploded");
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter: RuntimeAdapter = {
        async plan() {
          throw new Error("plan exploded");
        },
        async execute() {
          throw new Error("execute should not run");
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);

      expect(finalState.status).toBe("failed");
      expect(finalState.stopReason).toBe("Error: plan exploded");
      expect(persistedState.status).toBe("failed");
      expect(persistedState.stopReason).toBe("Error: plan exploded");
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "attempt_failed",
        "workspace_cleanup_failed",
      ]);
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("counts a thrown planning attempt as consumed", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    const attemptWorktreePath = join(runDir, "worktrees", "attempt-1");

    const adapter: RuntimeAdapter = {
      async plan() {
        throw new Error("plan exploded");
      },
      async execute() {
        throw new Error("execute should not run");
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);
    const persistedState = await readRunState(runDir);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("failed");
    expect(finalState.currentAttempt).toBe(1);
    expect(finalState.attemptsUsed).toBe(1);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(persistedState.currentAttempt).toBe(1);
    expect(persistedState.attemptsUsed).toBe(1);
    expect(persistedState.budgetSnapshot.attemptsRemaining).toBe(2);
    expect(stdout).not.toContain(attemptWorktreePath);
  });

  it("records both diagnostic and canonical terminal events when worktree creation fails twice", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);
    let planCalled = false;

    vi.resetModules();
    vi.doMock("../../src/workspace/worktreeManager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/workspace/worktreeManager.js")>(
        "../../src/workspace/worktreeManager.js",
      );

      return {
        ...actual,
        createAttemptWorkspace: async () => {
          throw new Error("workspace exploded");
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");
      const adapter: RuntimeAdapter = {
        async plan() {
          planCalled = true;
          throw new Error("plan should not run");
        },
        async execute() {
          throw new Error("execute should not run");
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      const finalState = await observedRunLoop(contract, runDir, adapter);
      const persistedState = await readRunState(runDir);

      expect(finalState.status).toBe("blocked_waiting_human");
      expect(finalState.attemptsUsed).toBe(0);
      expect(finalState.stopReason).toBe("workspace unavailable: Error: workspace exploded");
      expect(persistedState.status).toBe("blocked_waiting_human");
      expect(persistedState.stopReason).toBe("workspace unavailable: Error: workspace exploded");
      expect(planCalled).toBe(false);
      expect(await readEventTypes(runDir)).toEqual([
        "loop_planning",
        "workspace_retry",
        "workspace_create_failed",
        "loop_blocked_waiting_human",
      ]);
    } finally {
      vi.doUnmock("../../src/workspace/worktreeManager.js");
      vi.resetModules();
    }
  });

  it("preserves transition-event completeness when the run blocks for human input", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(repoPath);

    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "fail" },
        verification: { approved: false, rejectCategory: "tests-failed", primaryTargetPaths: ["src/index.ts"], failingCommand: "npm test", safeToRetry: true, evidence: ["FAIL"], pauseSignals: [], stopSignals: [] },
      },
      {
        plan: { summary: "change src/index.ts again", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited again"], stdoutStderrLog: "fail" },
        verification: { approved: false, rejectCategory: "different-reason", primaryTargetPaths: ["src/index.ts"], failingCommand: "npm test", safeToRetry: true, evidence: ["FAIL"], pauseSignals: [], stopSignals: [] },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });

    expect(finalState.status).toBe("blocked_waiting_human");
    expect(finalState.attemptsUsed).toBe(2);
    expect(finalState.budgetSnapshot.attemptsRemaining).toBe(1);
    expect(stdout).toContain(join(runDir, "worktrees", "attempt-2"));
    expect(await readEventTypes(runDir)).toEqual([
      "loop_planning",
      "attempt_started",
      "execute_started",
      "execution_finished",
      "verification_rejected",
      "attempt_started",
      "execute_started",
      "execution_finished",
      "loop_blocked_waiting_human",
    ]);
  });

  // §7.0 + requirement 3: a second start on an occupied directory fails LOUDLY from
  // ensureFreshRunDir and never reaches the lease gate. The §10.1 TOCTOU window is
  // documented, not simulated — no test may assert that two concurrent starts both proceed.
  it("throws from ensureFreshRunDir on a second start rather than reaching the lease gate", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await runLoop(contract, runDir, new ScriptedAdapter([successFrame()]));

    await expect(runLoop(contract, runDir, new ScriptedAdapter([successFrame()]))).rejects.toThrow(
      /already contains prior run data/,
    );
  });

  // §7 ordering: the gate may append an event, and events.jsonl does not exist before
  // initializeRunFiles. A gate placed one line earlier would crash every fresh start.
  it("appends no event before initializeRunFiles on a brand-new run directory", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await runLoop(contract, runDir, new ScriptedAdapter([successFrame()]));

    const types = await readEventTypes(runDir);
    expect(types[0]).toBe("loop_planning");
    expect(types).not.toContain("lease_expired_observed");
  });

  it("removes the attempt worktree even when publishing the attempt commit fails", async () => {
    // Wiring publish ahead of removal must not turn a publish failure into a
    // leaked worktree: eleven of the twelve cleanup call sites are error paths
    // that already ran best-effort, and a throw there would strand a worktree
    // that nothing else will ever clean up.
    const { runDir, repoPath, worktreePath } = await seedRunWithLiveAttemptWorktree();

    // Make publishing fail without making removal fail: an unwritable refs
    // directory blocks update-ref while `git worktree remove` still works.
    await chmod(join(repoPath, ".git", "refs"), 0o500);
    try {
      await cleanupAttemptWorkspaceBestEffort(repoPath, worktreePath, runDir, "test");
    } finally {
      await chmod(join(repoPath, ".git", "refs"), 0o700);
    }

    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoPath });
    expect(stdout).not.toContain(worktreePath);

    expect(await readEventTypes(runDir)).toContain("attempt_commit_publish_failed");
  });
});
