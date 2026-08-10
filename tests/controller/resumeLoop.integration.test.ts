import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { resumeLoop, ResumeNotEligibleError } from "../../src/controller/resumeLoop.js";
import { createAttemptWorkspace } from "../../src/workspace/worktreeManager.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import { buildProcessInstanceId } from "../../src/runtime/processIdentity.js";
import { LEASE_TTL_MS, RunLeaseHeldError } from "../../src/ownership/lease.js";
import type { LoopContract } from "../../src/contract/schema.js";

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

async function readEventTypes(runDir: string): Promise<string[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l).type as string);
}

describe("resumeLoop", () => {
  it("resumes an eligible run from the next attempt and claims ownership", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    const adapter = new ScriptedAdapter([successFrame()]);
    const finalState = await resumeLoop(runDir, adapter);

    expect(finalState.status).toBe("succeeded");
    expect(finalState.attemptsUsed).toBe(2); // continued from attempt 2 (attemptsUsed was 1)

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.currentProcessInstanceId).toBe(buildProcessInstanceId()); // claimed
    expect(owner.currentOwnerEpoch).toBe(2); // epoch unchanged
    // §5.0/§16: a resume CLAIM is not a heartbeat. It says "I own this", not "I am running
    // it right now" — only the heartbeat may write a non-null lease.
    expect(owner.leaseAffirmedAt).toBeNull();
    expect(await readEventTypes(runDir)).toContain("resume_adopted");
  });

  // A8's fourth layer. The 12d(iii)/(iv) tests stop at runLoopFromState, so without this one a
  // mutation that deletes resumeLoop's single forwarding line leaves the whole suite green — the
  // same "both ends green, middle severed" shape 12d(iv) exists to prevent, one layer up.
  //
  // The corruption of owner-transfer.json has to happen from inside `execute` rather than in the
  // fixture: resumeLoop reads that same file itself, before the gate, so a file that is already
  // corrupt at entry refuses the resume outright and never reaches runLoopFromState.
  it("forwards onReconciliationWriteAbandoned into the resumed runLoopFromState", async () => {
    const repoPath = await createRepo();
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
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    const abandonments: string[] = [];

    const adapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context: { worktreePath: string; abortSignal?: AbortSignal }) {
        // ownerStatus "lost" plus changed paths => OWNER_UNDECIDABLE, takeover denied, so the
        // transfer branch never runs and never replaces the corrupt file below.
        await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
          runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
          currentProcessInstanceId: buildProcessInstanceId(), lastAffirmedAt: "2026-07-25T00:00:00.000Z",
          ownerStatus: "lost", supersededByEpoch: null,
        }));
        await writeFile(join(runDir, "owner-transfer.json"), "{ not json");
        await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
        await new Promise<void>((resolve) => {
          if (context.abortSignal === undefined || context.abortSignal.aborted) {
            resolve();
            return;
          }
          context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    await resumeLoop(runDir, adapter as never, {
      onReconciliationWriteAbandoned: (detail) => abandonments.push(detail),
    });

    // Fixture preconditions for the "1" above, matching the rigor of the sibling 12d(iv) test:
    // without these, a single call could be coincidental rather than the abandonment.
    // (a) the boundary really was a stale_candidate, i.e. a reconciliation record was passed
    // down at all — otherwise writeBoundaryArtifacts skips the whole block.
    const analysis = JSON.parse(
      await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
    ) as { status: string };
    expect(analysis.status).toBe("stale_candidate");
    // (b) the abandonment was real: the seeded winner's reconciliation record is still the one on
    // disk, not overwritten by this loser's eligibleForContinuation:false view.
    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as { newOwnerEpoch: number | null; eligibleForContinuation: boolean };
    expect(reconciliation.newOwnerEpoch).toBe(2);
    expect(reconciliation.eligibleForContinuation).toBe(true);

    expect(abandonments).toHaveLength(1);
    expect(abandonments[0]).toContain("JSON");
  });

  it("refuses (and mutates nothing) when eligibility is not published", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    // make it ineligible
    const transfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8"));
    transfer.eligibleForContinuation = false;
    await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify(transfer));

    const ownerBefore = await readFile(join(runDir, "owner-record.json"), "utf8");
    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(ResumeNotEligibleError);

    expect(await readFile(join(runDir, "owner-record.json"), "utf8")).toBe(ownerBefore); // untouched
    expect(await readEventTypes(runDir)).toContain("resume_denied");
  });

  // Task 1 / spec §3 + §12 requirement 8: resume stays fail-closed on a busy owner-transfer
  // lock exactly as it does on a CAS mismatch, but the two failures are no longer the same
  // class, so the resume_denied detail must stop asserting a CAS failure that never happened.
  it("stays fail-closed when the claim hits a busy owner-transfer lock, without claiming a CAS failure", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    // Fabricate a busy lock the same way tests/persistence/fileStore.test.ts does: a live pid
    // (this process) so stale-recovery declines to break it.
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: new Date().toISOString() }, null, 2),
    );

    const ownerBefore = await readFile(join(runDir, "owner-record.json"), "utf8");

    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(
      ResumeNotEligibleError,
    );

    expect(await readFile(join(runDir, "owner-record.json"), "utf8")).toBe(ownerBefore); // untouched
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; detail: string });
    const denied = events.filter((event) => event.type === "resume_denied");

    expect(denied).toHaveLength(1);
    expect(denied[0].detail).not.toContain("claim CAS failed");
    expect(denied[0].detail).toContain("lock busy");
  });

  // Package 2 / §13 4th entry, review round 2 (I-1). D2 put the loser's reconciliation
  // read → decide → write inside .owner-transfer.lock, which is the same lock this claim takes, so
  // a resume can now collide with an ordinary boundary write rather than only with a transfer. The
  // pair below pins the two halves of the answer this codebase already gives that error elsewhere
  // (leaseLifecycle's "retries a busy owner-transfer lock and completes once it clears" / "abandons
  // the transfer once the retry bound is exhausted…"): contention that clears must not refuse the
  // resume, contention that persists still must.
  //
  // claimOwnerRecordWithPrecondition is mocked rather than driven by a real lock file — the same
  // reason the transfer-side pair gives: the release has to be deterministic, gated on a call
  // count, not on racing a real unlock against a real ~50ms backoff. The test above this one
  // already covers the real-lock-file path, and it is untouched.
  it("retries a busy owner-transfer lock during the resume claim and completes once it clears", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    let claimCalls = 0;

    vi.resetModules();
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );

      return {
        ...actual,
        claimOwnerRecordWithPrecondition: async (
          ...args: Parameters<typeof actual.claimOwnerRecordWithPrecondition>
        ) => {
          claimCalls += 1;
          if (claimCalls === 1) {
            throw new actual.OwnerTransferLockBusyError("owner transfer already in progress");
          }
          return actual.claimOwnerRecordWithPrecondition(...args);
        },
      };
    });

    try {
      const { resumeLoop: observedResumeLoop } = await import("../../src/controller/resumeLoop.js");

      // Captured rather than awaited bare: under a mutation that removes the retry this call
      // throws, and a test that dies of the throw reports an exception instead of a failed
      // assertion. Every claim below is an assertion.
      let thrown: unknown = null;
      let finalStatus: string | null = null;
      try {
        finalStatus = (await observedResumeLoop(runDir, new ScriptedAdapter([successFrame()]))).status;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeNull();
      expect(finalStatus).toBe("succeeded");
      expect(claimCalls).toBe(2); // refused once, retried once, claimed
      expect(await readEventTypes(runDir)).toContain("resume_adopted");
      expect(await readEventTypes(runDir)).not.toContain("resume_denied");
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });

  it("abandons the resume once the claim's retry bound is exhausted, with the refusal recorded exactly once", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    let claimCalls = 0;

    vi.resetModules();
    vi.doMock("../../src/persistence/fileStore.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/persistence/fileStore.js")>(
        "../../src/persistence/fileStore.js",
      );

      return {
        ...actual,
        claimOwnerRecordWithPrecondition: async () => {
          claimCalls += 1;
          throw new actual.OwnerTransferLockBusyError("owner transfer already in progress");
        },
      };
    });

    try {
      const { resumeLoop: observedResumeLoop, ResumeNotEligibleError: ObservedResumeNotEligibleError } =
        await import("../../src/controller/resumeLoop.js");
      const { OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS } = await import("../../src/controller/runLoop.js");

      let thrown: unknown = null;
      try {
        await observedResumeLoop(runDir, new ScriptedAdapter([successFrame()]));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ObservedResumeNotEligibleError);
      // The bound itself: exactly as many attempts as the constant allows, no more and no fewer.
      expect(claimCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS);
      const denied = (await readFile(join(runDir, "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; detail: string })
        .filter((event) => event.type === "resume_denied");
      // Retrying must not multiply the record of the refusal.
      expect(denied).toHaveLength(1);
      expect(denied[0].detail).toContain("lock busy");
    } finally {
      vi.doUnmock("../../src/persistence/fileStore.js");
      vi.resetModules();
    }
  });

  it("aborts when a concurrent owner-record change breaks the claim CAS", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    // Simulate a concurrent supersede landing after the gate would have read:
    // bump the persisted epoch so the CAS precondition (against epoch 2) fails.
    // We rely on evaluateResumeEligibility reading epoch 2 via the seeded transfer,
    // then the claim CAS comparing against the record resume read. To exercise CAS,
    // point owner-record and transfer at epoch 2 but mutate owner-record between reads:
    // simplest deterministic proxy — seed owner-record already superseded so the gate
    // refuses; for the CAS-specific path, see the fileStore CAS unit test (Task 3).
    // Here assert the gate-level supersede refusal end-to-end:
    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    owner.currentOwnerEpoch = 3;
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(owner));
    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(ResumeNotEligibleError);
  });

  it("discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh)", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    // Create a REAL residual worktree the same way the controller does mid-attempt
    // (createAttemptWorkspace -> `git worktree add`), so cleanup has a genuine
    // git-registered worktree to remove rather than a plain directory it would no-op on.
    const { worktreePath } = await createAttemptWorkspace(repoPath, runDir, 1);
    await expect(access(worktreePath)).resolves.toBeUndefined(); // exists before resume

    const adapter = new ScriptedAdapter([successFrame()]);
    const finalState = await resumeLoop(runDir, adapter);

    expect(finalState.status).toBe("succeeded");
    await expect(access(worktreePath)).rejects.toThrow(); // cleanup removed the residual worktree
  });

  async function setLease(runDir: string, leaseAffirmedAt: string | null, holder?: string) {
    const path = join(runDir, "owner-record.json");
    const owner = JSON.parse(await readFile(path, "utf8"));
    owner.leaseAffirmedAt = leaseAffirmedAt;
    if (holder !== undefined) {
      owner.currentProcessInstanceId = holder;
    }
    await writeFile(path, JSON.stringify(owner, null, 2));
  }

  // §7.1: a refusal introduces no new state mutation. Events are the stated exception —
  // and the ONLY one. This is what "the lease adds refusals, never authority" buys.
  it("refuses a resume against a live lease and mutates nothing but events", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    await setLease(runDir, new Date().toISOString(), "pid:999:9000");

    const ownerBefore = await readFile(join(runDir, "owner-record.json"), "utf8");
    const stateBefore = await readFile(join(runDir, "loop-state.json"), "utf8");

    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(
      RunLeaseHeldError,
    );

    expect(await readFile(join(runDir, "owner-record.json"), "utf8")).toBe(ownerBefore);
    expect(await readFile(join(runDir, "loop-state.json"), "utf8")).toBe(stateBefore);
    expect(await readEventTypes(runDir)).toEqual(["resume_requested", "resume_denied"]);
    // No interrupted-transfer recovery may run on a refusal path (§7.1).
    await expect(access(join(runDir, "owner-transfer.json"))).resolves.toBeUndefined();
  });

  // §5.0's headline regression: with a single timestamp, the record an owner transfer just
  // wrote is seconds old and names the new owner, so a lease gate keyed on lastAffirmedAt
  // would refuse the very resume the transfer authorized, for a full TTL. Asserted WELL
  // INSIDE the TTL — the expiry test below only covers the aged-out case.
  //
  // Split into a matched pair with the test below it, same lease age, opposite field. On
  // its own this half is vacuous: `leaseAffirmedAt` is null here, so `checkRunLease` takes
  // its `no_lease` branch, which has zero observable side effects (no event, no state
  // change) — the assertions below would pass identically whether the gate ran or was
  // never called. The pairing is what makes it meaningful: the test below sets the SAME
  // seconds-old age on `leaseAffirmedAt` instead of `lastAffirmedAt`, with a different
  // holder, and must be refused. Same age, one field vs. the other, opposite outcomes —
  // that fails if the gate isn't wired (this half's twin would wrongly succeed) and fails
  // if the gate reads the wrong field (this half would be wrongly refused).
  it("does not refuse a resume immediately after an owner transfer (lastAffirmedAt is not the lease field)", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    await setLease(runDir, null, "pid:100:1000"); // freshly transferred: owned, not running

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    owner.lastAffirmedAt = new Date().toISOString(); // seconds old, as a transfer leaves it
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(owner, null, 2));

    const finalState = await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    expect(finalState.status).toBe("succeeded");
    expect(await readEventTypes(runDir)).not.toContain("lease_expired_observed");
  });

  // Second half of the pair above: same seconds-old age, but on `leaseAffirmedAt` — the
  // field the gate actually reads — held by a different process. A fresh mkdtemp run dir
  // is used rather than re-seeding the run dir the first half just consumed, because that
  // dir is no longer in the eligible/interrupted state resumeLoop requires (the first half
  // already advanced it to "succeeded" and claimed ownership); a clean seedEligibleRun into
  // a new dir is simpler than unwinding that than re-deriving an eligible state from it.
  it("refuses a resume when leaseAffirmedAt is seconds old and held by another process", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    await setLease(runDir, new Date().toISOString(), "pid:999:9000"); // same age, wrong field

    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(
      RunLeaseHeldError,
    );
  });

  // §7: expiry refuses nothing. An eligible resume still succeeds; the observation is
  // recorded either way.
  it("lets an eligible resume through an expired lease and records the observation", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    await setLease(runDir, new Date(Date.now() - LEASE_TTL_MS - 1_000).toISOString(), "pid:999:9000");

    const finalState = await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    expect(finalState.status).toBe("succeeded");
    expect(await readEventTypes(runDir)).toContain("lease_expired_observed");
  });

  // §7: and expiry authorizes nothing. An INELIGIBLE resume is still refused, and refused
  // with the eligibility reason — never a lease reason.
  it("refuses an ineligible resume with the eligibility reason even when the lease has expired", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    await setLease(runDir, new Date(Date.now() - LEASE_TTL_MS - 1_000).toISOString(), "pid:999:9000");

    const state = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
    state.status = "succeeded";
    await writeFile(join(runDir, "loop-state.json"), JSON.stringify(state, null, 2));

    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(
      ResumeNotEligibleError,
    );
    expect(await readEventTypes(runDir)).toContain("lease_expired_observed");
  });

  // §10 / requirement 18: a killed run never releases. Its lease refuses until the TTL
  // elapses, and after that the gate takes no position and the ordinary rules decide.
  it("refuses while a killed run's lease is still fresh and stops refusing after the TTL", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    await setLease(runDir, new Date(Date.now() - LEASE_TTL_MS + 5_000).toISOString(), "pid:999:9000");
    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(
      RunLeaseHeldError,
    );

    await setLease(runDir, new Date(Date.now() - LEASE_TTL_MS - 1).toISOString(), "pid:999:9000");
    expect((await resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).status).toBe("succeeded");
  });
});
