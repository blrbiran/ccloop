import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { runLoop, runLoopFromState, createLeaseLossSignal } from "../../src/controller/runLoop.js";
import { resumeLoop } from "../../src/controller/resumeLoop.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import { LEASE_AFFIRM_THROTTLE_MS, LEASE_TTL_MS, RunLeaseLostError } from "../../src/ownership/lease.js";
import type { LeaseHeartbeat } from "../../src/controller/leaseHeartbeat.js";
import type { LoopContract } from "../../src/contract/schema.js";
import type { RunState } from "../../src/state/types.js";

const execFileAsync = promisify(execFile);

async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

// NOTE: adapted from the brief's fixture to match the real (strict) loopContractSchema
// (src/contract/schema.ts) — the brief's version used `guardrailsAndSafety` and omitted
// `safetyPolicy`/`verification`, which fails loadContract's zod .strict() parse. See
// task-5-report.md for details.
function createContract(repoPath: string): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix", successCondition: "pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["tests fail"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

// Seed an eligible, interrupted run dir at attemptsUsed=N, status "executing".
async function seedEligibleRun(runDir: string, contract: LoopContract, attemptsUsed = 1) {
  await mkdir(join(runDir, "attempts"), { recursive: true });
  await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
  await writeFile(join(runDir, "events.jsonl"), "");
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify({
    status: "executing", currentAttempt: attemptsUsed, attemptsUsed,
    lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 2, timeRemainingMs: 5000, tokenBudgetRemaining: 1000 },
    recentFailures: [],
  }));
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
    runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:100", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
    ownerStatus: "current", supersededByEpoch: null,
  }));
  await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify({
    priorOwnerEpoch: 1, newOwnerEpoch: 2, priorProcessInstanceId: "pid:100",
    newProcessInstanceId: "pid:100", transferredAt: "2026-07-25T00:00:00.000Z",
    reason: "owner lost", eligibleForContinuation: true,
  }));
  await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify({
    staleSuspicionBasis: [], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute", conflictingEvidence: [],
    takeoverPermission: { allowed: true, reason: "ok" },
    priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true,
  }));
}

function successFrame() {
  return {
    plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
    execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
    verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [] },
  };
}

function rejectFrame() {
  return {
    ...successFrame(),
    verification: { approved: false, rejectCategory: "tests fail", primaryTargetPaths: ["src/index.ts"], failingCommand: "npm test", safeToRetry: true, evidence: ["FAIL"], pauseSignals: [], stopSignals: [] },
  };
}

async function readEventTypes(runDir: string): Promise<string[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l).type as string);
}

describe("lease heartbeat lifecycle", () => {
  // §6.0 + requirement 17, written to fail against an implementation whose stop() only
  // cancels the timer. Asserted while the last heartbeat is still WELL INSIDE the TTL, so
  // "it aged out" cannot be mistaken for "it was released".
  it("releases the lease when the loop returns, so the next resume proceeds immediately", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const finalState = await runLoop(contract, runDir, new ScriptedAdapter([successFrame()]));
    expect(finalState.status).toBe("succeeded");

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.leaseAffirmedAt).toBeNull();
    // The run just finished: any lease it held would still be fresh.
    expect(Date.now() - Date.parse(owner.lastAffirmedAt)).toBeLessThan(LEASE_TTL_MS);
  });

  it("releases the lease when the loop throws", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const throwingAdapter = {
      plan: () => Promise.reject(new Error("boom")),
      execute: () => Promise.reject(new Error("boom")),
      verify: () => Promise.reject(new Error("boom")),
    };

    await runLoop(contract, runDir, throwingAdapter as never).catch(() => {});

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.leaseAffirmedAt).toBeNull();
  });

  // §6.0 for the other call site.
  it("releases the lease after a resume completes", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.leaseAffirmedAt).toBeNull();
  });

  // §8. The rotation is performed by the test writing the file directly. No production path
  // rotates a record this way, and this test must not be read as evidence that one exists.
  it("stops at the next phase boundary with stopReason lease_lost and leaves the new record intact", async () => {
    const repoPath = await createRepo();
    const baseContract = createContract(repoPath);
    // The runtime budget is widened for this test only: jumping the fake clock forward inside
    // the verify phase (below) is measured by runLoop as time spent IN that phase, and the
    // default 5000ms budget would otherwise be exhausted by the jump itself before the loop
    // ever gets a chance to notice the lost lease.
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: { ...baseContract.executionPolicy, totalRuntimeBudgetMs: 120_000 },
    };
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    // A rejecting-then-retrying script gives the loop a second attempt to reach.
    const adapter = new ScriptedAdapter([rejectFrame(), successFrame()]);

    const rotated = {
      runId: "task-1",
      logicalSessionId: "task-1:t0",
      currentOwnerEpoch: 99,
      currentProcessInstanceId: "pid:999:9000",
      lastAffirmedAt: new Date().toISOString(),
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: new Date().toISOString(),
    };

    // A hand-written wrapper, not the Proxy the brief offers as its default mechanism: a
    // Proxy trap detaches `this` when it forwards the call, and ScriptedAdapter#verify reads
    // `this.currentFrame` — so the trapped call throws. This wrapper delegates by calling the
    // scripted adapter as a bound method instead, then rotates the owner record afterward.
    //
    // The heartbeat throttles affirms to once per LEASE_AFFIRM_THROTTLE_MS (see
    // leaseHeartbeat.ts §6), and attempt 1's top-of-loop affirm (which succeeds, since the
    // record hasn't rotated yet) resets that window — so without moving the clock, attempt
    // 2's top-of-loop affirm lands inside the same throttle window and silently no-ops,
    // never attempting the CAS that would discover the rotation. Faking only `Date` (not the
    // timers) and jumping it forward here, right after the rotation, is the same pattern
    // leaseHeartbeat.test.ts itself uses to get past this throttle deterministically.
    vi.useFakeTimers({ toFake: ["Date"] });
    const rotateAfterFirstAttempt = {
      plan: (context: unknown) => adapter.plan(context as never),
      execute: (context: unknown) => adapter.execute(context as never),
      verify: async (context: unknown) => {
        const result = await adapter.verify(context as never);
        await writeFile(join(runDir, "owner-record.json"), JSON.stringify(rotated, null, 2));
        vi.setSystemTime(Date.now() + LEASE_AFFIRM_THROTTLE_MS);
        return result;
      },
    };

    let finalState;
    try {
      finalState = await runLoop(contract, runDir, rotateAfterFirstAttempt as never);
    } finally {
      vi.useRealTimers();
    }

    expect(finalState.stopReason).toBe("lease_lost");
    expect(finalState.attemptsUsed).toBe(1); // no further attempt started
    expect(await readEventTypes(runDir)).toContain("lease_lost");

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.currentOwnerEpoch).toBe(99); // the new owner's record is untouched
    expect(owner.currentProcessInstanceId).toBe("pid:999:9000");
    expect(owner.leaseAffirmedAt).toBe(rotated.leaseAffirmedAt);
  });

  // Coverage gap found in review of the test above: that test's rotation is only ever
  // observed by the top-of-loop check (Check 1), one iteration after the rotation, because
  // the heartbeat's only affirmNow() call site is the top of the loop. The retry-boundary
  // check (Check 2, right before the retry `continue`) was therefore never exercised by any
  // test. This test drives `leaseLoss` directly through runLoopFromState's sixth parameter —
  // no heartbeat, no clock games — flipping it from inside `verify`, after Check 1 for this
  // same attempt has already run and before any second iteration's Check 1 could run.
  it("check 2: stops at the retry boundary itself, without ever reaching a second top-of-loop pass", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    // Written directly, not by any production path (same caveat as the rotation above): a
    // sentinel to prove the stop never touches the owner record, without needing the real
    // owner-record machinery this direct runLoopFromState call bypasses entirely.
    const ownerRecordSentinel = { sentinel: true };
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(ownerRecordSentinel));

    const leaseLoss = createLeaseLossSignal();
    const frame = rejectFrame();
    const adapter = {
      plan: async () => frame.plan,
      execute: async () => frame.execution,
      verify: async () => {
        // Simulates the heartbeat concluding loss mid-attempt: by the time this fires, this
        // attempt's own top-of-loop check has already passed (it ran before plan/execute/
        // verify), so only the retry-boundary check can be what observes it for THIS attempt.
        leaseLoss.lost = new RunLeaseLostError("run lease lost: test-injected supersession");
        return frame.verification;
      },
    };

    // A spy heartbeat, not the inert default: counts affirmNow() calls, each of which
    // corresponds to exactly one top-of-loop pass. If the retry-boundary check did NOT catch
    // this and the loop fell through to a second iteration, affirmNow would be called twice.
    let affirmNowCalls = 0;
    const spyHeartbeat: LeaseHeartbeat = {
      affirmNow: async () => {
        affirmNowCalls += 1;
      },
      assertHeld: async () => {},
      stop: async () => {},
    };

    const initialLoopState: RunState = {
      status: "planning",
      currentAttempt: 0,
      attemptsUsed: 0,
      lastTransitionAt: new Date().toISOString(),
      waitingOnHuman: false,
      stopReason: null,
      budgetSnapshot: {
        attemptsRemaining: contract.executionPolicy.maxAttempts,
        timeRemainingMs: contract.executionPolicy.totalRuntimeBudgetMs,
        tokenBudgetRemaining: contract.executionPolicy.tokenBudget,
      },
      recentFailures: [],
    };

    const finalState = await runLoopFromState(contract, runDir, adapter as never, initialLoopState, spyHeartbeat, leaseLoss);

    expect(finalState.stopReason).toBe("lease_lost");
    expect(finalState.attemptsUsed).toBe(1); // no second attempt started
    // The decisive assertion: only one top-of-loop pass happened. If Check 2 were missing,
    // deleted, or misplaced, the loop would `continue` into a second pass, affirmNow() would
    // fire again, and this would read 2 (see task-12-report.md for the mutation evidence).
    expect(affirmNowCalls).toBe(1);

    const owner = await readFile(join(runDir, "owner-record.json"), "utf8");
    expect(JSON.parse(owner)).toEqual(ownerRecordSentinel); // the stop never touches it
  });
});
