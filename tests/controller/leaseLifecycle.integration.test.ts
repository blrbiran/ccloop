import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { runLoop, runLoopFromState, createLeaseLossSignal } from "../../src/controller/runLoop.js";
import { resumeLoop } from "../../src/controller/resumeLoop.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import { LEASE_AFFIRM_THROTTLE_MS, LEASE_TTL_MS, RunLeaseLostError } from "../../src/ownership/lease.js";
import { buildProcessInstanceId } from "../../src/runtime/processIdentity.js";
import { startLeaseHeartbeat } from "../../src/controller/leaseHeartbeat.js";
import type { LeaseHeartbeat } from "../../src/controller/leaseHeartbeat.js";
import type { LoopContract } from "../../src/contract/schema.js";
import type { RunState } from "../../src/state/types.js";
import type { OwnerRecord, RuntimeAdapter } from "../../src/runtime/types.js";

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

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readEvents(runDir: string): Promise<{ type: string; detail: string }[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; detail: string });
}

async function readEventTypes(runDir: string): Promise<string[]> {
  return (await readEvents(runDir)).map((event) => event.type);
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
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

  // §6.0 + requirement 17's second half: "and separately after it throws". A REJECTING ADAPTER
  // does not reach it — runLoopFromState converts every adapter failure into a terminal state
  // and RETURNS, which is the case the test above already covers. The throw has to come from
  // outside that catch, so this fails the loop's own state write: the first one succeeds (the
  // lease is affirmed straight after it, which is what makes the release below observable),
  // every later one rejects, and the second rejection lands while the catch block is already
  // handling the first — leaving no handler between it and the caller.
  it("releases the lease when the loop throws", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    vi.resetModules();
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );
      let writes = 0;

      return {
        ...actual,
        writeRunState: async (observedRunDir: string, state: RunState) => {
          writes += 1;

          if (writes > 1) {
            throw new Error("loop-state.json write failed");
          }

          await actual.writeRunState(observedRunDir, state);
        },
      };
    });

    try {
      const { runLoop: observedRunLoop } = await import("../../src/controller/runLoop.js");

      // The decisive assertion of this test's premise: the loop THREW, rather than returning a
      // terminal state as it does for every adapter failure.
      await expect(observedRunLoop(contract, runDir, new ScriptedAdapter([successFrame()])))
        .rejects.toThrow("loop-state.json write failed");

      const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
      expect(owner.leaseAffirmedAt).toBeNull();
      // Released, not aged out: the affirm that preceded the throw is still well inside the TTL.
      expect(Date.now() - Date.parse(owner.lastAffirmedAt)).toBeLessThan(LEASE_TTL_MS);
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
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

  // Task 1 / spec §3, §5.3 and §12 requirement 2 (partial — the event only): a transfer
  // abandoned because the owner-transfer lock stayed busy must leave the same trace shape as
  // any other abandoned transfer (newOwnerEpoch: null) PLUS an event naming the reason — the
  // reconciliation record itself is frozen (§5.3) and stays silent about WHY.
  //
  // Modelled on runLoop.integration.test.ts's "persists owner transfer artifacts..." test
  // (same boundary/ownership setup, same OWNER_LOST-and-takeover-allowed path into
  // persistBoundaryAnalysis's stale_candidate branch), with one addition: a live-pid holder on
  // .owner-transfer.lock so the CAS this attempt would perform never gets past lock
  // acquisition. No retry in this task (Task 2 adds it), so the transfer is abandoned exactly
  // as it is today for any other reason — but now with the contention event as evidence.
  it("appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    // Timing shape shared by every contention test in this file, widened from the original
    // 20ms/20ms/10ms (final whole-branch review, Final-3): the adapter below always times out
    // (it blocks on the abort signal rather than racing it), so perAttemptTimeoutMs alone
    // reaches the "timedOut, no result" branch deterministically. Pinning totalRuntimeBudgetMs
    // to 20ms as well added nothing and raced real wall-clock file I/O — under load
    // hasBudgetExceeded fires first and diverts the run before persistBoundaryAnalysis is ever
    // called, which would fail every decisive assertion below. It is left at the contract's
    // generous default; that branch terminates the run in one attempt either way, so the wider
    // budget cannot let a second attempt run.
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 200,
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
        // A live-pid holder (this process), so stale-recovery declines to break it: the
        // owner-transfer lock stays genuinely busy for the CAS this attempt is about to make.
        await writeFile(
          join(runDir, ".owner-transfer.lock"),
          JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: new Date().toISOString() }, null, 2),
        );
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
    };
    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as { ownershipVerdict: string; newOwnerEpoch: number | null; eligibleForContinuation: boolean };

    // The transfer never happened: the record still names the ORIGINAL (lost) owner, not this
    // process, and the reconciliation record reports the same "abandoned" shape as any other
    // dropped transfer.
    expect(owner.currentOwnerEpoch).toBe(1);
    expect(reconciliation.newOwnerEpoch).toBeNull();
    expect(reconciliation.eligibleForContinuation).toBe(false);
    expect(finalState.status).toBe("exhausted");
    await expect(access(join(runDir, "owner-transfer.json"))).rejects.toThrow(); // never staged

    expect(await readEvents(runDir)).toContainEqual(
      expect.objectContaining({ type: "owner_transfer_contended" }),
    );
    expect(await readEventTypes(runDir)).not.toContain("owner_epoch_transferred");
  });

  // Task 2 / spec §5.2 requirement 1: a transfer whose first attempt finds the owner-transfer
  // lock busy, and whose next attempt finds it free, must still complete. `writeOwnerTransferArtifacts`
  // is mocked (rather than using a real lock file, as the test above does) so the lock's
  // "release" is deterministic — gated on a call count, not on racing persistOwnerTransfer's
  // real ~50ms backoff against a real unlock. The first call simulates a foreign holder; every
  // call after it delegates to the real implementation.
  it("retries a busy owner-transfer lock and completes once it clears (spec requirement 1)", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 200,
      },
    };

    vi.resetModules();
    let writeCalls = 0;
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );

      return {
        ...actual,
        writeOwnerTransferArtifacts: async (
          ...args: Parameters<typeof actual.writeOwnerTransferArtifacts>
        ) => {
          writeCalls += 1;

          if (writeCalls === 1) {
            throw new actual.OwnerTransferLockBusyError("owner transfer already in progress");
          }

          return actual.writeOwnerTransferArtifacts(...args);
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

      const finalState = await observedRunLoop(contract, runDir, adapter as never);

      const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
        currentOwnerEpoch: number;
      };
      const reconciliation = JSON.parse(
        await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
      ) as { newOwnerEpoch: number | null; eligibleForContinuation: boolean };

      // The decisive assertion: two calls happened (one busy, one that succeeded), not one.
      // An implementation with no retry would fail this at 1, with the transfer abandoned.
      expect(writeCalls).toBe(2);
      expect(owner.currentOwnerEpoch).toBe(2);
      expect(reconciliation.newOwnerEpoch).toBe(2);
      expect(reconciliation.eligibleForContinuation).toBe(true);
      expect(finalState.status).toBe("exhausted");
      expect(await readEventTypes(runDir)).toContain("owner_epoch_transferred");
      // Emitted exactly once, by the retry's eventual success, not once per failed attempt.
      expect(
        (await readEvents(runDir)).filter((event) => event.type === "owner_epoch_transferred"),
      ).toHaveLength(1);
      expect(await readEventTypes(runDir)).not.toContain("owner_transfer_contended");
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });

  // Task 2 / spec §5.2 requirement 2: a lock that stays busy for the WHOLE retry window is
  // abandoned exactly like today (newOwnerEpoch: null, eligibleForContinuation: false), plus the
  // contention event appended exactly once — never once per retry attempt, and never silently.
  it("abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2)", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 200,
      },
    };

    vi.resetModules();
    let writeCalls = 0;
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );

      return {
        ...actual,
        writeOwnerTransferArtifacts: async () => {
          writeCalls += 1;
          throw new actual.OwnerTransferLockBusyError("owner transfer already in progress");
        },
      };
    });

    try {
      const { runLoop: observedRunLoop, OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS } = await import(
        "../../src/controller/runLoop.js"
      );

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

      const finalState = await observedRunLoop(contract, runDir, adapter as never);

      const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
        currentOwnerEpoch: number;
      };
      const reconciliation = JSON.parse(
        await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
      ) as { newOwnerEpoch: number | null; eligibleForContinuation: boolean };

      // The decisive assertion: the retry bound was exhausted, not skipped and not unbounded.
      expect(writeCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS);
      expect(owner.currentOwnerEpoch).toBe(1); // never transferred
      expect(reconciliation.newOwnerEpoch).toBeNull();
      expect(reconciliation.eligibleForContinuation).toBe(false);
      expect(finalState.status).toBe("exhausted");
      // Exactly once: the caller's catch branch appends this after persistOwnerTransfer's retry
      // loop gives up, not once per attempt inside the loop.
      expect(
        (await readEvents(runDir)).filter((event) => event.type === "owner_transfer_contended"),
      ).toHaveLength(1);
      expect(await readEventTypes(runDir)).not.toContain("owner_epoch_transferred");
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });

  // Task 2 / spec §5.2 requirement 3, and the trap the plan calls out explicitly: retrying a CAS
  // mismatch would re-run the CAS against evidence this transfer never evaluated — a new
  // ownership decision wearing an old one's justification. Asserts the ATTEMPT COUNT, not just
  // the outcome: an implementation that retried the mismatch and still failed on every retry
  // would produce the same outcome (abandoned, newOwnerEpoch: null) as one that never retried,
  // so only the call count distinguishes them.
  it("retries zero times on a CAS mismatch (spec requirement 3)", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 200,
      },
    };

    vi.resetModules();
    let writeCalls = 0;
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );

      return {
        ...actual,
        writeOwnerTransferArtifacts: async () => {
          writeCalls += 1;
          throw new actual.OwnerTransferPreconditionError(
            "persisted owner record changed before owner transfer could be applied",
          );
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

      const finalState = await observedRunLoop(contract, runDir, adapter as never);

      const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
        currentOwnerEpoch: number;
      };
      const reconciliation = JSON.parse(
        await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
      ) as { newOwnerEpoch: number | null; eligibleForContinuation: boolean };

      // The decisive assertion: exactly one attempt, never retried.
      expect(writeCalls).toBe(1);
      expect(owner.currentOwnerEpoch).toBe(1); // never transferred
      expect(reconciliation.newOwnerEpoch).toBeNull();
      expect(reconciliation.eligibleForContinuation).toBe(false);
      expect(finalState.status).toBe("exhausted");
      // The existing re-read/re-evaluate path, unchanged: no contention event (this was never
      // lock contention) and no transfer event (nothing was ever staged).
      expect(await readEventTypes(runDir)).not.toContain("owner_transfer_contended");
      expect(await readEventTypes(runDir)).not.toContain("owner_epoch_transferred");
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });

  // Final whole-branch review, Final-2 (human-ruled): the CAS-mismatch / lock-busy catch path
  // re-reads the owner record, and `readOwnerRecord` runs recoverInterruptedOwnerTransfer — a
  // WRITE. That is the very side effect the entry guard exists to prevent (§5.4: "a superseded
  // process must not perform crash recovery on a run it no longer owns"), and this instance sits
  // on the path that most strongly indicates a rival now owns the run, up to a full retry
  // backoff after the entry guard passed.
  //
  // Fixture: the requirement 3 (CAS mismatch) path, driven through runLoopFromState so the test
  // owns the heartbeat and can assert file state BEFORE stop() — releaseOwnerLease routes
  // through the same recovery-on-write path and would finalize the staged fixture afterwards,
  // confounding the evidence (the same reason the requirement 6 test asserts pre-stop).
  // writeOwnerTransferArtifacts is mocked to do three things at the instant the CAS fails:
  // stage an interrupted-transfer fixture, rotate owner-record.json to an unrelated rival, and
  // throw the precondition error. With the guard, the re-read never happens and the staged
  // transfer is untouched; without it, recovery-on-read finalizes a transfer to `pid:recovered`
  // inside a run this process has already lost.
  it("refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 200,
      },
    };

    const processInstanceId = buildProcessInstanceId();
    const initialOwnerRecord: OwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1:t0",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: processInstanceId,
      lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "lost",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(initialOwnerRecord, null, 2));

    // Staged-but-uncommitted owner transfer, with a distinct epoch/process so any trace of it
    // reaching owner-record.json is unambiguous.
    const pendingOwner = {
      runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 555,
      currentProcessInstanceId: "pid:recovered", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current", supersededByEpoch: null,
    };
    const pendingTransfer = {
      priorOwnerEpoch: 1, newOwnerEpoch: 555, priorProcessInstanceId: processInstanceId,
      newProcessInstanceId: "pid:recovered", transferredAt: "2026-07-25T00:00:00.000Z",
      reason: "staged before crash", eligibleForContinuation: true,
    };
    const marker = {
      version: 1, stagedAt: "2026-07-25T00:00:00.000Z",
      finalizeOrder: ["owner-transfer.json", "owner-record.json"],
    };
    const rivalRecord = {
      runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 42,
      currentProcessInstanceId: "pid:rival", lastAffirmedAt: new Date().toISOString(),
      ownerStatus: "current", supersededByEpoch: null,
    };

    vi.resetModules();
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );

      return {
        ...actual,
        writeOwnerTransferArtifacts: async () => {
          await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(pendingOwner, null, 2));
          await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(pendingTransfer, null, 2));
          await writeFile(join(runDir, ".owner-transfer.transaction.json"), JSON.stringify(marker, null, 2));
          await writeFile(join(runDir, "owner-record.json"), JSON.stringify(rivalRecord, null, 2));
          throw new actual.OwnerTransferPreconditionError(
            "persisted owner record changed before owner transfer could be applied",
          );
        },
      };
    });

    try {
      const { runLoopFromState: observedRunLoopFromState } = await import("../../src/controller/runLoop.js");
      const { startLeaseHeartbeat: mockedStartLeaseHeartbeat } = await import(
        "../../src/controller/leaseHeartbeat.js"
      );

      const leaseLoss = createLeaseLossSignal();
      const heartbeat = mockedStartLeaseHeartbeat({
        runDir,
        ownerRecord: initialOwnerRecord,
        onLeaseLost: (error) => {
          leaseLoss.lost = error as never;
        },
      });

      const adapter: RuntimeAdapter = {
        async plan() {
          return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
        },
        async execute(context) {
          await waitForAbort(context.abortSignal);
          return null;
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      const finalState = await observedRunLoopFromState(
        contract,
        runDir,
        adapter,
        planningRunState(contract),
        heartbeat,
        leaseLoss,
      );

      expect(finalState.stopReason).toBe("lease_lost");

      // The decisive assertions: the staged transfer was never finalized. An unguarded re-read
      // renames these into owner-transfer.json / owner-record.json and deletes the marker.
      await expect(access(join(runDir, ".owner-transfer.transaction.json"))).resolves.toBeUndefined();
      await expect(access(join(runDir, ".owner-record.pending.json"))).resolves.toBeUndefined();
      await expect(access(join(runDir, ".owner-transfer.pending.json"))).resolves.toBeUndefined();
      await expect(access(join(runDir, "owner-transfer.json"))).rejects.toThrow();

      const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
        currentOwnerEpoch: number;
        currentProcessInstanceId: string;
      };
      expect(owner.currentOwnerEpoch).toBe(42); // still the rival's record, untouched by recovery
      expect(owner.currentProcessInstanceId).toBe("pid:rival");

      await heartbeat.stop();
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });

  // Task 4 / spec §12 (owner-transfer-contention design) requirement 4: an affirm that becomes
  // due while a transfer is in flight must not execute until the transfer's exclusive span
  // completes; the transfer sees zero CAS failures and no lease_lost is appended.
  //
  // Driven deterministically (no real 30s timer, no wall-clock racing): readOwnerRecord — the
  // span's OWN first statement — is mocked to pause on a test-controlled deferred promise, so
  // "did the affirm's own CAS attempt start before the span released" becomes an exact,
  // race-free observation rather than a real-timing guess (the same technique
  // leaseHeartbeat.test.ts uses for the equivalent unit-level property). Gating at the read
  // rather than at the transfer's write matters: it is the earliest point inside the span, so
  // it kills both a runExclusive that never chains fn onto the queue at all AND a span that
  // starts one statement too late (after readOwnerRecord instead of at it) — either mutation
  // leaves the queue unoccupied at this point, letting the concurrent affirm through early.
  //
  // runLoopFromState (not runLoop()) is driven directly so the test holds the SAME heartbeat
  // instance persistBoundaryAnalysis uses, and can call affirmNow() on it — simulating the
  // interval timer landing mid-span. The owner record already shows ownerStatus "lost" under
  // the SAME processInstanceId the heartbeat is constructed with: a self-transfer (defect 2's
  // scenario — this process reclaiming its own record), not a foreign takeover.
  it("blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4)", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 200,
      },
    };

    const processInstanceId = buildProcessInstanceId();
    const initialOwnerRecord: OwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1:t0",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: processInstanceId,
      lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "lost",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(initialOwnerRecord, null, 2));

    vi.resetModules();
    const order: string[] = [];
    let releaseSpanRead: () => void = () => {};
    const spanReadGate = new Promise<void>((resolve) => {
      releaseSpanRead = resolve;
    });
    // Gates only the FIRST readOwnerRecord call — persistBoundaryAnalysis's own span read. The
    // catch path's re-read (only reached on a CAS mismatch, which this scenario never hits)
    // would otherwise also match and deadlock the test.
    let readCalls = 0;

    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );

      return {
        ...actual,
        readOwnerRecord: async (...args: Parameters<typeof actual.readOwnerRecord>) => {
          readCalls += 1;
          if (readCalls === 1) {
            order.push("span:readStart");
            await spanReadGate;
          }
          const result = await actual.readOwnerRecord(...args);
          if (readCalls === 1) {
            order.push("span:readEnd");
          }
          return result;
        },
        affirmOwnerLease: async (...args: Parameters<typeof actual.affirmOwnerLease>) => {
          order.push("affirm:start");
          const result = await actual.affirmOwnerLease(...args);
          order.push("affirm:end");
          return result;
        },
      };
    });

    try {
      const { runLoopFromState: observedRunLoopFromState } = await import("../../src/controller/runLoop.js");
      const { startLeaseHeartbeat: mockedStartLeaseHeartbeat } = await import(
        "../../src/controller/leaseHeartbeat.js"
      );

      // Injected clock: runLoopFromState's own top-of-loop `heartbeat.affirmNow()` (unthrottled,
      // since it is the very first affirm) fires at clock=0, before the transfer is even
      // reached. Without advancing the clock past LEASE_AFFIRM_THROTTLE_MS before THIS test's
      // own mid-span affirmNow() call, that call would be silently throttled away and never
      // even attempt its CAS — masking the very race this test exists to exercise.
      let clock = 0;

      const lost: unknown[] = [];
      const leaseLoss = createLeaseLossSignal();
      const heartbeat = mockedStartLeaseHeartbeat({
        runDir,
        ownerRecord: initialOwnerRecord,
        onLeaseLost: (error) => {
          lost.push(error);
          leaseLoss.lost = error as never;
        },
        now: () => clock,
      });

      const adapter: RuntimeAdapter = {
        async plan() {
          return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
        },
        async execute(context) {
          await waitForAbort(context.abortSignal);
          return null;
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      const runPromise = observedRunLoopFromState(
        contract,
        runDir,
        adapter,
        planningRunState(contract),
        heartbeat,
        leaseLoss,
      );

      // Wait until the span's own read has actually started — the earliest point inside
      // heartbeat.runExclusive's fn, proving the span is already occupying the queue at the
      // moment specified by the exact boundary ("starts at readOwnerRecord").
      while (!order.includes("span:readStart")) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // The top-of-loop affirm (clock=0) already ran and completed by this point (it precedes
      // the span chronologically). Clear its throttle window before triggering ours.
      clock = LEASE_AFFIRM_THROTTLE_MS + 1;
      const affirmStartsBefore = order.filter((entry) => entry === "affirm:start").length;

      // An affirm becoming due mid-span: called directly (no real 30s timer needed) on the
      // SAME heartbeat instance persistBoundaryAnalysis is using.
      const affirmPromise = heartbeat.affirmNow();

      // Several microtask turns: plenty of opportunity for a broken runExclusive (one that
      // executes fn directly instead of chaining it onto the queue), or a span that starts one
      // statement too late, to let this affirm's own CAS attempt start early.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(order.filter((entry) => entry === "affirm:start")).toHaveLength(affirmStartsBefore);

      releaseSpanRead();
      await affirmPromise;
      const finalState = await runPromise;

      // The decisive ordering: THIS affirm's own CAS attempt (the second one — the first was
      // the harmless top-of-loop affirm, long since finished) never starts until the span's own
      // read has finished.
      expect(order.lastIndexOf("affirm:start")).toBeGreaterThan(order.indexOf("span:readEnd"));

      // Zero CAS failures for the blocked-then-released affirm, and no lease_lost: checked
      // before the other, more granular assertions below so a failure here (the blocked affirm
      // wrongly concluding self-supersession) is reported as exactly that, not as a downstream
      // symptom.
      expect(lost).toHaveLength(0);
      expect(await readEventTypes(runDir)).not.toContain("lease_lost");
      expect(await readEventTypes(runDir)).toContain("owner_epoch_transferred");
      expect(await readEventTypes(runDir)).not.toContain("owner_transfer_contended");
      // Exactly one owner_epoch_transferred event, never retried or abandoned because the
      // blocked affirm couldn't invalidate the transfer's CAS base.
      expect(
        (await readEvents(runDir)).filter((event) => event.type === "owner_epoch_transferred"),
      ).toHaveLength(1);

      // Read the record BEFORE heartbeat.stop(), which — correctly, per requirement 17 — clears
      // leaseAffirmedAt back to null on release; checking after stop() would conflate that with
      // this assertion (the blocked affirm ran to completion rather than being dropped).
      const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
        currentOwnerEpoch: number;
        leaseAffirmedAt: string | null;
      };
      expect(owner.currentOwnerEpoch).toBe(2);
      // The blocked affirm still ran to completion afterward (against the now-adopted record),
      // proving it was queued and eventually served, not dropped.
      expect(owner.leaseAffirmedAt).not.toBeNull();

      await heartbeat.stop();
      expect(finalState.status).toBe("exhausted");
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });

  // Task 4 / spec §12 (owner-transfer-contention design) requirement 5: a self-performed
  // transfer appends no lease_lost event. Same deterministic gate-and-queue technique as the
  // requirement 4 test above (a real timing race here would be exactly the second flake risk
  // the plan told us not to add): writeOwnerTransferArtifacts is left UNMOCKED (the real CAS
  // write), gated only by the deferred promise below, so the transfer's CAS genuinely runs
  // inside the span while an affirm is fired mid-flight. What this fences is that a due affirm
  // cannot reach its own CAS attempt while that write is still pending, and that the
  // self-transfer this produces appends no lease_lost event and leaves the record's identity
  // intact.
  //
  // This test does NOT independently fence "adopt specifically must sit inside the span,
  // synchronously after the CAS" — see task-4-report.md's mutation evidence: moving adopt() to
  // just outside the runExclusive callback (with no other change) is provably unobservable to
  // any deterministic test, since the caller's post-await continuation and a competing queued
  // call settle in the same relative promise order either way. That property is fenced instead
  // by the requirement 4 test's `expect(owner.leaseAffirmedAt).not.toBeNull()` assertion, which
  // fails when adopt is moved past a genuinely later point (e.g. past writeBoundaryArtifacts).
  it("a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5)", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 200,
      },
    };

    const processInstanceId = buildProcessInstanceId();
    const initialOwnerRecord: OwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1:t0",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: processInstanceId,
      lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "lost",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(initialOwnerRecord, null, 2));

    vi.resetModules();
    const order: string[] = [];
    let releaseTransferWrite: () => void = () => {};
    const transferGate = new Promise<void>((resolve) => {
      releaseTransferWrite = resolve;
    });
    // Injected clock — same rationale as the requirement 4 test: without advancing it past
    // LEASE_AFFIRM_THROTTLE_MS before firing our own affirm below, runLoopFromState's own
    // unthrottled top-of-loop affirm would silently throttle this one away before it ever
    // attempted its CAS, masking the race entirely.
    let clock = 0;

    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );

      return {
        ...actual,
        writeOwnerTransferArtifacts: async (
          ...args: Parameters<typeof actual.writeOwnerTransferArtifacts>
        ) => {
          order.push("transfer:writeStart");
          await transferGate;
          return actual.writeOwnerTransferArtifacts(...args);
        },
        // Marks the instant runAffirm actually attempts its CAS — a pure ordering signal, not a
        // completion one, so the assertion below never depends on how long the real CAS I/O
        // underneath it happens to take.
        affirmOwnerLease: async (...args: Parameters<typeof actual.affirmOwnerLease>) => {
          order.push("affirm:attempted");
          return actual.affirmOwnerLease(...args);
        },
      };
    });

    try {
      const { runLoopFromState: observedRunLoopFromState } = await import("../../src/controller/runLoop.js");
      const { startLeaseHeartbeat: mockedStartLeaseHeartbeat } = await import(
        "../../src/controller/leaseHeartbeat.js"
      );

      const lost: unknown[] = [];
      const leaseLoss = createLeaseLossSignal();
      const heartbeat = mockedStartLeaseHeartbeat({
        runDir,
        ownerRecord: initialOwnerRecord,
        onLeaseLost: (error) => {
          lost.push(error);
          leaseLoss.lost = error as never;
        },
        now: () => clock,
      });

      const adapter: RuntimeAdapter = {
        async plan() {
          return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
        },
        async execute(context) {
          await waitForAbort(context.abortSignal);
          return null;
        },
        async verify() {
          throw new Error("verify should not run");
        },
      };

      const runPromise = observedRunLoopFromState(
        contract,
        runDir,
        adapter,
        planningRunState(contract),
        heartbeat,
        leaseLoss,
      );

      while (!order.includes("transfer:writeStart")) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      clock = LEASE_AFFIRM_THROTTLE_MS + 1;
      const attemptsBefore = order.filter((entry) => entry === "affirm:attempted").length;
      const affirmPromise = heartbeat.affirmNow();

      // A pure ordering check: with the transfer's own CAS still pending behind the gate, a
      // correct runExclusive cannot have let this affirm reach its own CAS attempt yet.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(order.filter((entry) => entry === "affirm:attempted")).toHaveLength(attemptsBefore);

      releaseTransferWrite();
      await affirmPromise;
      await runPromise;
      await heartbeat.stop();

      expect(await readEventTypes(runDir)).not.toContain("lease_lost");
      expect(lost).toHaveLength(0);

      const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
        currentOwnerEpoch: number;
        currentProcessInstanceId: string;
      };
      expect(owner.currentOwnerEpoch).toBe(2);
      expect(owner.currentProcessInstanceId).toBe(processInstanceId);
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
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
      adopt: () => {},
      affirmNow: async () => {
        affirmNowCalls += 1;
      },
      assertHeld: async () => {},
      runExclusive: (fn) => fn(),
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

    // Review finding 1. The guard is what concluded supersession here, and it sets `superseded`,
    // which makes runAffirm return early forever — so if the guard does not append this event,
    // nothing ever will, and a run that stopped for a lease reason names nobody. End-to-end
    // through the real runLoop and the real heartbeat, on a real events.jsonl: the detail has to
    // answer "who took this run over", which needs BOTH sides of the comparison.
    const leaseLostEvents = (await readEvents(runDir)).filter((event) => event.type === "lease_lost");
    expect(leaseLostEvents).toHaveLength(1); // exactly once, not once per mechanism
    expect(leaseLostEvents[0].detail).toBe(
      `expected ${buildProcessInstanceId()} at epoch 1, observed pid:999:9000 at epoch 99`,
    );
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

    // Review finding 2, and the reason the event above is a DISTINCT type: the refusal is
    // recorded — a refusal that leaves no trace reads as a run that merely stopped — but it
    // claims no supersession and names no observed owner, because the record could not be read.
    // It still names the process that refused, and why.
    const unverifiableEvents = (await readEvents(runDir)).filter((event) => event.type === "lease_unverifiable");
    expect(unverifiableEvents).toHaveLength(1);
    expect(unverifiableEvents[0].detail).toContain(`expected ${buildProcessInstanceId()} at epoch 1`);
    expect(unverifiableEvents[0].detail).toContain("owner record unreadable after 3 attempts");
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
      adopt: () => {},
      affirmNow: async () => {},
      assertHeld: async () => {
        const persisted = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as RunState;

        if (persisted.status === "succeeded") {
          throw new RunLeaseLostError("run lease lost: test-injected supersession");
        }
      },
      runExclusive: (fn) => fn(),
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

  // Final-review finding: two of the twelve assertHeld guard sites — the plan-phase and
  // verify-phase Claude calls — could be DELETED with the whole suite still green. What those
  // two prevent is a superseded process spending money on a Claude call, so "nothing fails if
  // they go" is the wrong state for them to be in.
  //
  // Rather than one test per site, this drives the whole success path with a heartbeat that
  // refuses at its n-th call and states, per n, exactly which phases have run by then. Deleting
  // any guard on this path is caught twice over: the numbering shifts, so some case observes a
  // phase its expectation forbids, and the guard COUNT asserted by the case below this one
  // changes. The two Claude-call guards are cases 2 and 4.
  //
  // Only the six guards on the SUCCESS path are fenced here. The other six live on timeout,
  // partial-execution and retry paths, which this scenario never reaches.
  const successPathGuardSites = [
    { refusalIndex: 1, site: "attempt worktree creation", phasesBefore: [] as string[] },
    { refusalIndex: 2, site: "plan Claude call", phasesBefore: [] as string[] },
    { refusalIndex: 3, site: "execute Claude call", phasesBefore: ["plan"] },
    { refusalIndex: 4, site: "verify Claude call", phasesBefore: ["plan", "execute"] },
    { refusalIndex: 5, site: "attempt artifact write", phasesBefore: ["plan", "execute", "verify"] },
    { refusalIndex: 6, site: "post-terminal worktree cleanup", phasesBefore: ["plan", "execute", "verify"] },
  ];

  async function runSuccessPathWithRefusalAt(refusalIndex: number | null): Promise<{
    runDir: string;
    phases: string[];
    guardCalls: number;
    finalState: RunState;
  }> {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const phases: string[] = [];
    const scripted = new ScriptedAdapter([successFrame()]);
    // Records the phase before delegating, so a phase that runs is recorded even if it throws.
    const adapter = {
      plan: (context: unknown) => {
        phases.push("plan");
        return scripted.plan(context as never);
      },
      execute: (context: unknown) => {
        phases.push("execute");
        return scripted.execute(context as never);
      },
      verify: (context: unknown) => {
        phases.push("verify");
        return scripted.verify(context as never);
      },
    };

    let guardCalls = 0;
    const heartbeat: LeaseHeartbeat = {
      adopt: () => {},
      affirmNow: async () => {},
      assertHeld: async () => {
        guardCalls += 1;

        if (guardCalls === refusalIndex) {
          throw new RunLeaseLostError("run lease lost: test-injected supersession");
        }
      },
      runExclusive: (fn) => fn(),
      stop: async () => {},
    };

    const finalState = await runLoopFromState(
      contract,
      runDir,
      adapter as never,
      planningRunState(contract),
      heartbeat,
    );

    return { runDir, phases, guardCalls, finalState };
  }

  it.each(successPathGuardSites)(
    "runs no further phase once the guard before the $site refuses",
    async ({ refusalIndex, phasesBefore }) => {
      const { runDir, phases, finalState } = await runSuccessPathWithRefusalAt(refusalIndex);

      // The decisive assertion: the refused side effect, and every side effect after it, did
      // not happen. For cases 2 and 4 that is a Claude call a superseded process would
      // otherwise have paid for.
      expect(phases).toEqual(phasesBefore);
      // Guards 1-5 refuse before the attempt reaches a terminal decision, so the run stops with
      // the lease reason; guard 6 fires after one is already persisted, and that decision stands
      // (see the test above).
      expect(finalState.status).toBe(refusalIndex === 6 ? "succeeded" : "cancelled");
      expect(finalState.stopReason === "lease_lost").toBe(refusalIndex !== 6);
      // Abandoned IN PLACE: whatever the attempt had already created stays, and nothing new is
      // created. The artifact write is itself guard 5, so it happens only in the last case.
      expect(await pathExists(join(runDir, "worktrees", "attempt-1"))).toBe(refusalIndex > 1);
      expect(await pathExists(join(runDir, "attempts", "1", "plan.json"))).toBe(refusalIndex === 6);
    },
  );

  // The other half of the fence: the number of guards on this path. Deleting one leaves every
  // case above satisfiable by a shifted numbering, but there is no numbering in which five
  // guards are six.
  it("passes exactly six guards, and completes, when none of them refuses", async () => {
    const { phases, guardCalls, finalState } = await runSuccessPathWithRefusalAt(null);

    expect(guardCalls).toBe(successPathGuardSites.length);
    expect(phases).toEqual(["plan", "execute", "verify"]);
    expect(finalState.status).toBe("succeeded");
  });

  // Task 5 / spec §12 requirement 6: persistBoundaryAnalysis's entry guard must precede
  // readOwnerRecord, because readOwnerRecord runs recoverInterruptedOwnerTransfer
  // (fileStore.ts) — a WRITE that finalizes any interrupted owner transfer it finds staged.
  // A superseded process must not perform that recovery on a run it no longer owns.
  //
  // Reached via the non-timeout "execute returned no result" branch (runLoop.ts, the
  // `if (execution === null)` check right after the execute phase), because NO assertHeld
  // guard sits between adapter.execute() returning and persistBoundaryAnalysis being called
  // on that branch — unlike the timeout branch, which passes through guardedWriteArtifacts
  // first. That makes persistBoundaryAnalysis's own entry guard unambiguously the first (and
  // only) assertHeld call to observe the rotation below, rather than one of several.
  //
  // "assert that no recovery-on-read write occurred, not merely that the call threw"
  // (task-5-brief.md step 1.1): a real interrupted-transfer fixture (transaction marker +
  // pending owner/transfer records, fileStore.ts's OWNER_TRANSFER_MARKER_FILE etc.) is staged
  // before the run starts. If recoverInterruptedOwnerTransfer ran, it would finalize that
  // fixture — deleting the marker and overwriting owner-record.json with the pending record.
  // A guard placed anywhere else in the function (e.g. only before the write) would still let
  // that finalization happen and this test would catch it; only a guard preceding
  // readOwnerRecord keeps the fixture untouched.
  //
  // Built with a manually-constructed heartbeat (not the `runLoop()` convenience wrapper)
  // whose `stop()` is deliberately never called: `stop()` releases the lease via
  // `releaseOwnerLease` -> `updateOwnerRecordWithPrecondition`, which ALSO runs
  // `recoverInterruptedOwnerTransfer` (with `lockHeld: true`) as an unrelated, pre-existing
  // cleanup step — finalizing the same staged fixture for a completely different reason and
  // confounding the assertions below. Checking file state right after `runLoopFromState`
  // resolves, before any `stop()`, isolates persistBoundaryAnalysis's own guard from that
  // unrelated path.
  //
  // The staged fixture is written from inside adapter.execute(), NOT before the run starts:
  // `affirmOwnerLease` (the heartbeat's OWN top-of-loop affirm, called once per iteration
  // before this attempt even begins) routes through the SAME `updateOwnerRecordWithPrecondition`
  // -> `recoverInterruptedOwnerTransfer` path — a second, legitimate, pre-existing caller of
  // recovery-on-write that is out of this task's scope. Staging the fixture only after that
  // first affirm has already run (and no-opped, against the clean initial record) isolates
  // what this test targets: persistBoundaryAnalysis's OWN read, not the heartbeat's.
  it("refuses persistBoundaryAnalysis before readOwnerRecord can finalize a staged transfer, once superseded (spec requirement 6)", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const ownerRecord: OwnerRecord = {
      runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 1,
      currentProcessInstanceId: buildProcessInstanceId(), lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: "2026-07-25T00:00:00.000Z",
    };
    await mkdir(join(runDir, "attempts"), { recursive: true });
    await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
    await writeFile(join(runDir, "events.jsonl"), "");
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(ownerRecord, null, 2));

    // A staged-but-uncommitted owner transfer: if readOwnerRecord's recovery-on-read ever ran,
    // finalizePendingOwnerTransfer would rename these into owner-record.json / owner-transfer.json
    // and delete the marker. Distinct epoch/process from anything else in this test, so any
    // trace of it landing in owner-record.json is unambiguous.
    const pendingOwner = {
      runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 555,
      currentProcessInstanceId: "pid:recovered", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current", supersededByEpoch: null,
    };
    const pendingTransfer = {
      priorOwnerEpoch: 1, newOwnerEpoch: 555, priorProcessInstanceId: buildProcessInstanceId(),
      newProcessInstanceId: "pid:recovered", transferredAt: "2026-07-25T00:00:00.000Z",
      reason: "staged before crash", eligibleForContinuation: true,
    };
    const marker = {
      version: 1, stagedAt: "2026-07-25T00:00:00.000Z",
      finalizeOrder: ["owner-transfer.json", "owner-record.json"],
    };

    const rivalRecord = {
      runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 42,
      currentProcessInstanceId: "pid:rival", lastAffirmedAt: new Date().toISOString(),
      ownerStatus: "current", supersededByEpoch: null,
    };

    const adapter = {
      plan: async () => ({ summary: "s", primaryTargetPaths: ["src/index.ts"] }),
      execute: async () => {
        // Stage the interrupted-transfer fixture only now — after the top-of-loop affirm has
        // already run once, harmlessly, against the clean record above — then simulate this
        // process being superseded by a rival: discovered only when persistBoundaryAnalysis's
        // guard next checks.
        await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(pendingOwner, null, 2));
        await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(pendingTransfer, null, 2));
        await writeFile(join(runDir, ".owner-transfer.transaction.json"), JSON.stringify(marker, null, 2));
        await writeFile(join(runDir, "owner-record.json"), JSON.stringify(rivalRecord, null, 2));
        return null; // resolves immediately: no timeout, so no guard runs between this and persistBoundaryAnalysis
      },
      verify: async () => { throw new Error("verify must not run"); },
    };

    const leaseLoss = createLeaseLossSignal();
    const heartbeat = startLeaseHeartbeat({
      runDir,
      ownerRecord,
      onLeaseLost: (error) => {
        leaseLoss.lost = error as never;
      },
    });

    const finalState = await runLoopFromState(
      contract,
      runDir,
      adapter as never,
      planningRunState(contract),
      heartbeat,
      leaseLoss,
    );

    expect(finalState.stopReason).toBe("lease_lost");

    // The decisive assertions: the staged transfer was never finalized. If recovery-on-read
    // had run, the marker would be gone and owner-record.json would show epoch 555 / pid:recovered.
    await expect(access(join(runDir, ".owner-transfer.transaction.json"))).resolves.toBeUndefined();
    await expect(access(join(runDir, ".owner-record.pending.json"))).resolves.toBeUndefined();
    await expect(access(join(runDir, ".owner-transfer.pending.json"))).resolves.toBeUndefined();

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.currentOwnerEpoch).toBe(42); // still the rival's record, untouched by recovery
    expect(owner.currentProcessInstanceId).toBe("pid:rival");
    await expect(access(join(runDir, "owner-transfer.json"))).rejects.toThrow(); // never finalized either
  });

  // Task 5 / spec §12 requirement 7, AMENDED by task A4 (L3 debt 1 / §4.3): once
  // persistBoundaryAnalysis's entry guard has passed, a process superseded WHILE the function
  // runs — specifically, after it completes its own owner-transfer CAS and adopts the result,
  // but before it reaches the LATER assertHeld that guards writeBoundaryArtifacts — must still
  // write no boundary-analysis.json. The transfer itself is real and already committed to disk
  // (§4/Task 4: it happens inside the heartbeat's exclusive span and is not undone); what this
  // guards is only the write that follows the span.
  //
  // reconciliation-record.json is DIFFERENT after task A4, and deliberately so: task A2 made it
  // the transaction's third file (staged and finalized atomically alongside owner-transfer.json
  // and owner-record.json, by the SAME CAS), and task A4 is what starts actually passing it
  // through on the winner path. So a committed transfer now ALWAYS carries its reconciliation
  // record with it — that is the whole point of the L3 "sweep and transactional continuation"
  // work this test's own commit belongs to, closing exactly the crash window the pre-A4 spec
  // amendment below described as intentional. `docs/superpowers/specs/2026-07-27-owner-transfer-
  // contention-design.md` §5.3's amendment (e) — "a completed owner-transfer.json no longer
  // implies a reconciliation-record.json" — described the OLD (pre-transactionalization) gap;
  // it is superseded by this plan, not violated by it.
  //
  // Modelled on the "owner_transfer_contended" test's OWNER_LOST + takeoverAllowed fixture
  // (same execute-timeout shape, same "lost" owner record), reaching the SAME call site
  // (persistBoundaryAnalysis with executionRecovery) that test exercises. The difference: here
  // writeOwnerTransferArtifacts is mocked to let the real CAS transfer succeed, then
  // immediately rotate owner-record.json to a THIRD, unrelated rival — simulating a takeover
  // that lands in the instant between this process's own adopted transfer and its artifact
  // write.
  it("writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4)", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    // Wider margins than the 20ms/20ms shape this was originally modelled on (Minor 7 from
    // review): the adapter below always times out (it blocks on the abort signal rather than
    // racing it), so a short perAttemptTimeoutMs alone is enough to reach the "timedOut" branch
    // deterministically — there is no need to ALSO race a tiny totalRuntimeBudgetMs against
    // real wall-clock file I/O to get there, and doing so was exactly the shape flagged
    // elsewhere in this task as flake-prone. totalRuntimeBudgetMs is left at the contract's
    // generous default so `hasBudgetExceeded` has no realistic chance of firing early and
    // diverting the run before it ever reaches execute.
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 200,
      },
    };

    vi.resetModules();
    const rivalRecord = {
      runId: "task-1", logicalSessionId: "task-1:lost", currentOwnerEpoch: 77,
      currentProcessInstanceId: "pid:rival-9000", lastAffirmedAt: new Date().toISOString(),
      ownerStatus: "current", supersededByEpoch: null,
    };
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );

      return {
        ...actual,
        writeOwnerTransferArtifacts: async (
          ...args: Parameters<typeof actual.writeOwnerTransferArtifacts>
        ) => {
          await actual.writeOwnerTransferArtifacts(...args);
          // The real self-transfer just committed and will be adopted next. A rival now takes
          // over before this attempt can write its boundary/reconciliation artifacts.
          await writeFile(join(runDir, "owner-record.json"), JSON.stringify(rivalRecord, null, 2));
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

      const finalState = await observedRunLoop(contract, runDir, adapter as never);

      expect(finalState.stopReason).toBe("lease_lost");
      // The decisive assertions: the transfer committed (owner-transfer.json exists, and named
      // this process before the rival's rotation overwrote owner-record.json), and so — after
      // task A4 — did the reconciliation record that transfer's own transaction publishes
      // alongside it. Only boundary-analysis.json, gated by the LATER assertHeld this rival
      // supersession lands before, was withheld.
      await expect(access(join(runDir, "owner-transfer.json"))).resolves.toBeUndefined();
      await expect(access(join(runDir, "boundary-analysis.json"))).rejects.toThrow();
      await expect(access(join(runDir, "reconciliation-record.json"))).resolves.toBeUndefined();

      const reconciliation = JSON.parse(await readFile(join(runDir, "reconciliation-record.json"), "utf8")) as {
        ownershipVerdict: string;
        priorOwnerEpoch: number | null;
        newOwnerEpoch: number | null;
        eligibleForContinuation: boolean;
      };
      expect(reconciliation.ownershipVerdict).toBe("OWNER_LOST");
      expect(reconciliation.priorOwnerEpoch).toBe(1);
      expect(reconciliation.newOwnerEpoch).toBe(2);
      expect(reconciliation.eligibleForContinuation).toBe(true);

      const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
      expect(owner.currentOwnerEpoch).toBe(77); // the rival's record stands, untouched by this process
      expect(owner.currentProcessInstanceId).toBe("pid:rival-9000");
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });
});
