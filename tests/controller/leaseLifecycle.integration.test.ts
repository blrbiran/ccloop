import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, writeFile, readFile } from "node:fs/promises";
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

async function readEvents(runDir: string): Promise<{ type: string; detail: string }[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; detail: string });
}

async function readEventTypes(runDir: string): Promise<string[]> {
  return (await readEvents(runDir)).map((event) => event.type);
}

// What runLoop hands runLoopFromState after its own "planning" transition, for the tests that
// drive runLoopFromState directly.
function planningRunState(contract: LoopContract): RunState {
  return {
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
    //
    // Since task 13 the throttle is no longer what gates discovery here (see the event
    // assertion below), but the clock jump is retained: it is what the widened runtime budget
    // above is sized for, and removing it would silently change what this test measures.
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
    // Updated by task 13, and NOT by weakening the check. The `lease_lost` EVENT is appended
    // by the heartbeat, when its affirm CAS fails and the re-read names someone else
    // (leaseHeartbeat.ts, concludeLeaseLost). Task 13's assertHeld guard before the next side
    // effect — the attempt-artifact write immediately after verify — observes the rotated
    // record strictly earlier than the next top-of-loop affirm can, so the run now stops
    // before that CAS ever runs and no heartbeat event is produced. assertHeld appends no
    // event of its own by design (task 10), so the terminal transition is what records the
    // stop, carrying the same reason.
    expect(await readEvents(runDir)).toContainEqual(
      expect.objectContaining({ type: "loop_cancelled", detail: "lease_lost" }),
    );

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

    const finalState = await runLoopFromState(contract, runDir, adapter as never, planningRunState(contract), spyHeartbeat, leaseLoss);

    expect(finalState.stopReason).toBe("lease_lost");
    expect(finalState.attemptsUsed).toBe(1); // no second attempt started
    // The decisive assertion: only one top-of-loop pass happened. If Check 2 were missing,
    // deleted, or misplaced, the loop would `continue` into a second pass, affirmNow() would
    // fire again, and this would read 2 (see task-12-report.md for the mutation evidence).
    expect(affirmNowCalls).toBe(1);

    const owner = await readFile(join(runDir, "owner-record.json"), "utf8");
    expect(JSON.parse(owner)).toEqual(ownerRecordSentinel); // the stop never touches it
  });

  // §8.1 requirement 13: asserted per side-effect KIND, not once generically. Rotating from
  // INSIDE the plan phase makes the ordering deterministic — no timer race — and the next
  // Claude call (execute) is the side effect that must not happen.
  function rotateOwnerRecord(runDir: string): Promise<void> {
    const at = new Date().toISOString();
    return writeFile(join(runDir, "owner-record.json"), JSON.stringify({
      runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 99,
      currentProcessInstanceId: "pid:999:9000", lastAffirmedAt: at,
      ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: at,
    }, null, 2));
  }

  it("does not launch the next Claude call when the record names a different process", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    let executeCalls = 0;
    const adapter = {
      plan: async () => {
        await rotateOwnerRecord(runDir);
        return { summary: "s", primaryTargetPaths: ["src/index.ts"] };
      },
      execute: async () => {
        executeCalls += 1;
        throw new Error("execute must not run");
      },
      verify: async () => { throw new Error("verify must not run"); },
    };

    const finalState = await runLoop(contract, runDir, adapter as never);

    expect(executeCalls).toBe(0);
    expect(finalState.stopReason).toBe("lease_lost");
  });

  // §8.1: abandoned in place — no further side effect of the attempt, INCLUDING its
  // worktree cleanup. The residual worktree survives for the next owner, whose resume path
  // already cleans up residual worktrees before continuing.
  it("leaves the attempt worktree in place rather than unwinding it", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const adapter = {
      plan: async () => {
        await rotateOwnerRecord(runDir);
        return { summary: "s", primaryTargetPaths: ["src/index.ts"] };
      },
      execute: async () => { throw new Error("execute must not run"); },
      verify: async () => { throw new Error("verify must not run"); },
    };

    const finalState = await runLoop(contract, runDir, adapter as never);

    expect(finalState.stopReason).toBe("lease_lost");
    await expect(readdir(join(runDir, "worktrees"))).resolves.not.toHaveLength(0);
  });

  // §8.1 row two: unverifiable stops the run, does NOT claim supersession, and writes no
  // owner record.
  it("stops with lease_unverifiable and writes no owner record when the record is corrupt", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const adapter = {
      plan: async () => {
        await writeFile(join(runDir, "owner-record.json"), "{ not json");
        return { summary: "s", primaryTargetPaths: ["src/index.ts"] };
      },
      execute: async () => { throw new Error("execute must not run"); },
      verify: async () => { throw new Error("verify must not run"); },
    };

    const finalState = await runLoop(contract, runDir, adapter as never);

    expect(finalState.stopReason).toBe("lease_unverifiable");
    expect(await readFile(join(runDir, "owner-record.json"), "utf8")).toBe("{ not json");
    expect(await readEventTypes(runDir)).not.toContain("lease_lost");
  });

  // Not in the brief; found while enumerating the call sites. Several guarded cleanup sites
  // run AFTER the attempt has already persisted a terminal decision. A lease error raised
  // there cannot be re-decided as "cancelled": succeeded -> cancelled is not a legal
  // transition (legalTransitions, src/state/stateMachine.ts) and rewriting a terminal
  // decision would itself be a write to a run this process no longer owns. So the terminal
  // decision stands — and the blocked cleanup is still skipped, which is what this asserts.
  it("keeps an already-persisted terminal decision when the post-terminal cleanup is blocked", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    // Throws at the first guard that runs once a terminal state is on disk — on the success
    // path that is the post-terminal worktree cleanup — and at no guard before it.
    const heartbeat: LeaseHeartbeat = {
      affirmNow: async () => {},
      assertHeld: async () => {
        const persisted = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as RunState;

        if (persisted.status === "succeeded") {
          throw new RunLeaseLostError("run lease lost: test-injected supersession");
        }
      },
      stop: async () => {},
    };

    const finalState = await runLoopFromState(
      contract,
      runDir,
      new ScriptedAdapter([successFrame()]),
      planningRunState(contract),
      heartbeat,
    );

    expect(finalState.status).toBe("succeeded");
    await expect(readdir(join(runDir, "worktrees"))).resolves.toEqual(["attempt-1"]);
  });
});
