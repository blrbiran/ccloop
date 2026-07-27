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
import type { LeaseHeartbeat } from "../../src/controller/leaseHeartbeat.js";
import type { LoopContract } from "../../src/contract/schema.js";
import type { RunState } from "../../src/state/types.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";

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
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
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
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
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
        perAttemptTimeoutMs: 20,
        totalRuntimeBudgetMs: 20,
        partialOutcomeRecoveryWindowMs: 10,
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
});
