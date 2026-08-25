import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  appendEvent,
  buildAtomicTempPath,
  claimOwnerRecordWithPrecondition,
  initializeRunFiles,
  isProcessActive,
  OwnerTransferLockBusyError,
  OwnerTransferMarkerFinalizeOrderInvalidError,
  OwnerTransferMarkerUnreadableError,
  OwnerTransferPendingMissingError,
  OwnerTransferPreconditionError,
  readOwnerRecord,
  readRunState,
  readOwnerTransferRecord,
  readReconciliationRecord,
  writeAttemptArtifacts,
  writeBoundaryArtifacts,
  writeOwnerRecord,
  writeOwnerTransferArtifacts,
  writeOwnerTransferRecord,
  writeRunState,
} from "../../src/persistence/fileStore.js";
import { resumeLoop, ResumeNotEligibleError } from "../../src/controller/resumeLoop.js";
import type { LoopContract } from "../../src/contract/schema.js";
import { applyOwnerEpochTransfer } from "../../src/ownership/ownerController.js";
import { buildProcessInstanceId } from "../../src/runtime/processIdentity.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import type { RunBoundaryAnalysis, RunState } from "../../src/state/types.js";
import type { OwnerRecord, OwnerTransferRecord, ReconciliationRecord } from "../../src/runtime/types.js";

// Test 5 (§4.4 rule 1) needs the actual `rename` call sequence finalizePendingOwnerTransfer
// issues, to prove it is driven by the marker's `finalizeOrder` rather than by the hardcoded
// production constants. There is no seam for that in fileStore.ts's public surface, so this
// wraps node:fs/promises' `rename` and forwards every call to the real implementation — every
// other test in this file (and fileStore.ts itself) sees unchanged behavior; only the recorded
// call log is new.
const renameSpy = vi.fn();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      renameSpy(...args);
      return actual.rename(...args);
    },
  };
});

// Package 2 whole-branch review, Lane 2 finding I-2 — the observation seam for the reconciliation
// retry bound, rebuilt under HUMAN RULING 55.
//
// WHAT THIS REPLACES, stated plainly rather than quietly dropped: the previous round observed the
// same thing by adding a pass-through `open` spy INSIDE the shared vi.mock factory above. That
// factory predates package 2 (introduced in fb62714), so under either reading of "existing" it was
// a shared fixture nobody had named, and the independent review recorded it as out of bounds
// (Low-4). Ruling 55 rolled it back: the factory above is byte-identical to what it was before this
// fix round, and the counting happens here instead, in a LOCAL vi.doMock that exists only for the
// two tests that need it — the same doMock + dynamic-import seam the crash-gap matrix and the
// two-readers race test in this file already use.
//
// WHAT IS COUNTED, and why the count means what it says (this is the correction the review's Imp-1
// asked for): each iteration of acquireOwnerTransferLock's loop publishes the lock with exactly one
// `link(staging, lockPath)`, so ONE LINK TO THE LOCK PATH IS ONE ACQUISITION ATTEMPT — including
// the inner `attempt < 2` iteration that runs when tryRecoverStaleOwnerTransferLock reports the
// lock recoverable. The previous wording claimed that equivalence for `open`, and the reviewer
// disproved it by measurement: with a stealable lock, one retry iteration issued two opens. The two
// tests below pin an exact count, and they may do so because their fixture holds the lock with a
// LIVE pid, so tryRecoverStale... returns false and each attempt is exactly one link. That fixture
// premise is named again on the assertion itself.
async function withLockAttemptCounter<T>(
  runDir: string,
  body: (
    fileStore: typeof import("../../src/persistence/fileStore.js"),
    attempts: () => number,
  ) => Promise<T>,
): Promise<T> {
  const lockPath = join(runDir, ".owner-transfer.lock");
  let attempts = 0;

  vi.resetModules();
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

    return {
      ...actual,
      link: async (...args: Parameters<typeof actual.link>) => {
        // Counted BEFORE the call, so an attempt that loses the race (EEXIST) counts exactly like
        // one that wins it. Everything is forwarded; nothing is faked.
        if (String(args[1]) === lockPath) {
          attempts += 1;
        }

        return actual.link(...args);
      },
    };
  });

  try {
    const fileStore = await import("../../src/persistence/fileStore.js");
    return await body(fileStore, () => attempts);
  } finally {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
}

const contract: LoopContract = {
  objective: { taskId: "task-1", goal: "Fix test", successCondition: "tests pass", nonGoals: [] },
  context: { repoPath: "/tmp/repo", targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
  executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
  safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
  verification: { verifierType: "command", requiredChecks: ["npm test"], rejectOn: ["tests fail"], evidenceRequired: [] },
  escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
};

const state: RunState = {
  status: "queued",
  currentAttempt: 0,
  attemptsUsed: 0,
  lastTransitionAt: "2026-07-14T00:00:00.000Z",
  waitingOnHuman: false,
  stopReason: null,
  budgetSnapshot: { attemptsRemaining: 3, timeRemainingMs: 5000, tokenBudgetRemaining: 1000 },
  recentFailures: [],
};

describe("fileStore", () => {
  it("writes owner-record.json with current epoch and process instance", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    });

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
      ownerStatus: string;
    };

    expect(owner.currentOwnerEpoch).toBe(1);
    expect(owner.currentProcessInstanceId).toBe("pid:12345");
    expect(owner.ownerStatus).toBe("current");
  });

  it("writes owner-transfer.json with prior and new epochs", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeOwnerTransferRecord(runDir, {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:12345",
      newProcessInstanceId: "pid:67890",
      transferredAt: "2026-07-22T10:05:00.000Z",
      reason: "owner lost after reconciliation",
      eligibleForContinuation: true,
    });

    const transfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
      priorOwnerEpoch: number;
      newOwnerEpoch: number;
      eligibleForContinuation: boolean;
    };

    expect(transfer.priorOwnerEpoch).toBe(1);
    expect(transfer.newOwnerEpoch).toBe(2);
    expect(transfer.eligibleForContinuation).toBe(true);
  });

  it("writes owner-transfer.json and updates owner-record.json atomically after an OWNER_LOST takeover-allowed verdict", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    });

    const transfer = applyOwnerEpochTransfer(
      {
        runId: "task-1",
        logicalSessionId: "task-1/session-1",
        currentOwnerEpoch: 1,
        currentProcessInstanceId: "pid:12345",
        lastAffirmedAt: "2026-07-22T10:00:00.000Z",
        ownerStatus: "current",
        supersededByEpoch: null,
        leaseAffirmedAt: null,
      },
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerTransferArtifacts(
      runDir,
      {
        runId: "task-1",
        logicalSessionId: "task-1/session-1",
        currentOwnerEpoch: 1,
        currentProcessInstanceId: "pid:12345",
        lastAffirmedAt: "2026-07-22T10:00:00.000Z",
        ownerStatus: "current",
        supersededByEpoch: null,
        leaseAffirmedAt: null,
      },
      transfer.nextOwnerRecord,
      transfer.transferRecord,
    );

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
    };
    const audit = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
      priorOwnerEpoch: number;
      newOwnerEpoch: number;
      eligibleForContinuation: boolean;
    };

    expect(owner.currentOwnerEpoch).toBe(2);
    expect(owner.currentProcessInstanceId).toBe("pid:67890");
    expect(audit.priorOwnerEpoch).toBe(1);
    expect(audit.newOwnerEpoch).toBe(2);
    expect(audit.eligibleForContinuation).toBe(true);
  });

  it("rejects owner transfer when persisted owner truth no longer matches the expected pre-transfer state", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeOwnerRecord(runDir, {
      ...initialOwnerRecord,
      currentProcessInstanceId: "pid:22222",
      lastAffirmedAt: "2026-07-22T10:04:00.000Z",
      ownerStatus: "lost",
    });

    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await expect(
      writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
    ).rejects.toBeInstanceOf(OwnerTransferPreconditionError);

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
      ownerStatus: string;
    };

    expect(owner.currentOwnerEpoch).toBe(1);
    expect(owner.currentProcessInstanceId).toBe("pid:22222");
    expect(owner.ownerStatus).toBe("lost");
    await expect(readFile(join(runDir, "owner-transfer.json"), "utf8")).rejects.toThrow();
  });

  it("recovers an interrupted owner transfer publish on the next owner-record read", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeOwnerTransferRecord(runDir, transfer.transferRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );

    const rawOwnerBeforeRecovery = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
    };
    expect(rawOwnerBeforeRecovery.currentOwnerEpoch).toBe(1);
    expect(rawOwnerBeforeRecovery.currentProcessInstanceId).toBe("pid:12345");

    const recoveredOwner = await readOwnerRecord(runDir);
    const recoveredTransfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
      priorOwnerEpoch: number;
      newOwnerEpoch: number;
      newProcessInstanceId: string;
    };

    expect(recoveredOwner.currentOwnerEpoch).toBe(2);
    expect(recoveredOwner.currentProcessInstanceId).toBe("pid:67890");
    expect(recoveredTransfer.priorOwnerEpoch).toBe(1);
    expect(recoveredTransfer.newOwnerEpoch).toBe(2);
    expect(recoveredTransfer.newProcessInstanceId).toBe("pid:67890");
    await expect(readFile(join(runDir, ".owner-transfer.transaction.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-record.pending.json"), "utf8")).rejects.toThrow();
  });

  it("finalizes a v2 marker with three pendings on read, publishing all three files and reclaiming the staging", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );
    const reconciliationRecord: ReconciliationRecord = {
      staleSuspicionBasis: ["owner transfer already published"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeOwnerTransferRecord(runDir, transfer.transferRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(join(runDir, ".reconciliation-record.pending.json"), JSON.stringify(reconciliationRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify(
        {
          version: 2,
          stagedAt: transfer.transferRecord.transferredAt,
          finalizeOrder: ["owner-transfer.json", "owner-record.json", "reconciliation-record.json"],
        },
        null,
        2,
      ),
    );

    const recoveredOwner = await readOwnerRecord(runDir);
    const recoveredTransfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
      priorOwnerEpoch: number;
      newOwnerEpoch: number;
      newProcessInstanceId: string;
    };
    const recoveredReconciliation = await readReconciliationRecord(runDir);

    expect(recoveredOwner.currentOwnerEpoch).toBe(2);
    expect(recoveredOwner.currentProcessInstanceId).toBe("pid:67890");
    expect(recoveredTransfer.priorOwnerEpoch).toBe(1);
    expect(recoveredTransfer.newOwnerEpoch).toBe(2);
    expect(recoveredTransfer.newProcessInstanceId).toBe("pid:67890");
    expect(recoveredReconciliation).toEqual(reconciliationRecord);
    await expect(readFile(join(runDir, ".owner-transfer.transaction.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-record.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".reconciliation-record.pending.json"), "utf8")).rejects.toThrow();
  });

  // §4.4 rule 1, Critical — the whole marker-driven design turns on this. The production
  // constants (OWNER_TRANSFER_FILE, OWNER_RECORD_FILE, RECONCILIATION_RECORD_FILE) are used both
  // to BUILD a v2 marker's finalizeOrder and, if finalize were still hardcoded, to decide publish
  // order — so with the production default order they would agree even if finalize secretly
  // ignored the marker. This fixture deliberately stages a finalizeOrder that swaps the first two
  // entries, so agreement is only possible if finalize genuinely reads and obeys
  // marker.finalizeOrder.
  it("finalizes in the order the v2 marker declares, not in the order the production constants declare", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );
    const reconciliationRecord: ReconciliationRecord = {
      staleSuspicionBasis: ["owner transfer already published"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeOwnerTransferRecord(runDir, transfer.transferRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(join(runDir, ".reconciliation-record.pending.json"), JSON.stringify(reconciliationRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify(
        {
          version: 2,
          stagedAt: transfer.transferRecord.transferredAt,
          finalizeOrder: ["owner-record.json", "owner-transfer.json", "reconciliation-record.json"],
        },
        null,
        2,
      ),
    );

    renameSpy.mockClear();
    await readOwnerRecord(runDir);

    const renamedTargets = renameSpy.mock.calls.map((call) => basename(String(call[1])));
    expect(renamedTargets).toEqual(["owner-record.json", "owner-transfer.json", "reconciliation-record.json"]);
  });

  // Fix-wave 1, Important 2+3: a v2 marker's finalizeOrder must be a complete permutation of all
  // three legal files, not merely a subset the old code would iterate literally. Before this
  // check existed, a finalizeOrder naming only 2 of the 3 legal v2 files would publish those two,
  // delete the marker, and leave the third pending (staged on disk right alongside the other two)
  // silently orphaned forever — worse than pre-A3 behavior, which handled all three v2 files
  // unconditionally regardless of finalizeOrder.
  it("refuses to finalize a v2 marker whose finalizeOrder omits a legal file, rather than silently orphaning the omitted pending", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );
    const reconciliationRecord: ReconciliationRecord = {
      staleSuspicionBasis: ["owner transfer already published"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeOwnerTransferRecord(runDir, transfer.transferRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    // Fixture precondition this test depends on: the reconciliation pending IS staged on disk,
    // matching a real v2 transaction — the marker below simply never mentions it.
    await writeFile(join(runDir, ".reconciliation-record.pending.json"), JSON.stringify(reconciliationRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify(
        {
          version: 2,
          stagedAt: transfer.transferRecord.transferredAt,
          finalizeOrder: ["owner-transfer.json", "owner-record.json"],
        },
        null,
        2,
      ),
    );

    await expect(readOwnerRecord(runDir)).rejects.toBeInstanceOf(OwnerTransferMarkerFinalizeOrderInvalidError);

    // Nothing was published and nothing was deleted: the rejection fires before any pending is
    // even read, let alone any temp/rename/unlink happens.
    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as { currentOwnerEpoch: number };
    expect(owner.currentOwnerEpoch).toBe(1);
    await expect(readFile(join(runDir, ".owner-transfer.transaction.json"), "utf8")).resolves.toEqual(expect.any(String));
    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).resolves.toEqual(expect.any(String));
    await expect(readFile(join(runDir, ".owner-record.pending.json"), "utf8")).resolves.toEqual(expect.any(String));
    await expect(readFile(join(runDir, ".reconciliation-record.pending.json"), "utf8")).resolves.toEqual(expect.any(String));
    // Task 3 / phase 1 (fix loop 1, Important-2): readOwnerRecord went through the unlocked
    // branch's acquire -> finalize -> release, and finalize threw here. The lock must still have
    // been released in the `finally` -- otherwise this run's transfer lock leaks permanently
    // every time a marker like this one is read, which is strictly worse than not acquiring a
    // lock at all.
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
  });

  // §4.4 rule 2, fail-closed / depth-defense. This branch IS reachable in production (a v2
  // marker staged with all three pendings can still find the reconciliation pending gone by the
  // time finalize runs), but "the marker and all staging survive intact" is NOT a promise that
  // survives the most common way this branch is actually reached: concurrent stale-lock recovery.
  // P2 clears a stale lock, P3 races in and reaches finalize first via the unlocked
  // readOwnerRecord fast path, P2 (still mid-cleanup from the recovery it started) deletes the
  // marker and every pending out from under P3, and P3's read of the reconciliation pending gets
  // ENOENT with nothing left to "keep". Do not cite this test as evidence of an invariant — it
  // only pins the single-process, no-racing-cleaner case.
  it("refuses to finalize a v2 marker whose reconciliation pending is missing, keeping the marker and staging in place", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeOwnerTransferRecord(runDir, transfer.transferRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    // Fixture precondition this test depends on: the reconciliation pending is deliberately never
    // written, even though the marker below declares a v2, three-file finalizeOrder that requires it.
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify(
        {
          version: 2,
          stagedAt: transfer.transferRecord.transferredAt,
          finalizeOrder: ["owner-transfer.json", "owner-record.json", "reconciliation-record.json"],
        },
        null,
        2,
      ),
    );

    await expect(readOwnerRecord(runDir)).rejects.toBeInstanceOf(OwnerTransferPendingMissingError);

    await expect(readFile(join(runDir, ".owner-transfer.transaction.json"), "utf8")).resolves.toEqual(expect.any(String));
    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).resolves.toEqual(expect.any(String));
    await expect(readFile(join(runDir, ".owner-record.pending.json"), "utf8")).resolves.toEqual(expect.any(String));
    // Task 3 / phase 1 (fix loop 1, Important-2): the lock acquired by the unlocked branch must
    // still be released in `finally` even though finalize threw here.
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
  });

  // §4.4 rule 3, depth-defense. writeJsonFileViaFixedTemp's safeUnlink → write → rename sequence
  // means production can never leave a half-written marker at this path, so this fixture reaches
  // the "unparseable" branch the only way a test can: corrupting the marker directly after it was
  // already published.
  it("refuses to finalize an unparseable marker, keeping every staged file in place", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeOwnerTransferRecord(runDir, transfer.transferRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(join(runDir, ".owner-transfer.transaction.json"), "{not valid json");

    await expect(readOwnerRecord(runDir)).rejects.toBeInstanceOf(OwnerTransferMarkerUnreadableError);

    await expect(readFile(join(runDir, ".owner-transfer.transaction.json"), "utf8")).resolves.toBe("{not valid json");
    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).resolves.toEqual(expect.any(String));
    await expect(readFile(join(runDir, ".owner-record.pending.json"), "utf8")).resolves.toEqual(expect.any(String));
    // Task 3 / phase 1 (fix loop 1, Important-2): the lock acquired by the unlocked branch must
    // still be released in `finally` even though finalize threw here.
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
  });

  it("finalizes a v1 marker over its two files without throwing", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);

    await expect(
      writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
    ).resolves.toBeUndefined();

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as { currentOwnerEpoch: number };
    const publishedTransfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
      newOwnerEpoch: number;
    };

    expect(owner.currentOwnerEpoch).toBe(2);
    expect(publishedTransfer.newOwnerEpoch).toBe(2);
    // Only two files are in a v1 finalizeOrder; reconciliation-record.json is never part of the
    // transaction, so it must stay entirely untouched.
    await expect(readFile(join(runDir, "reconciliation-record.json"), "utf8")).rejects.toThrow();
  });

  it("rejects owner transfer while a live transfer lock is held", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-07-22T10:04:59.000Z" }, null, 2),
    );

    // §3: a busy lock is now its own class, a SIBLING of OwnerTransferPreconditionError, not
    // a subclass — this test used to assert the latter, which was the bug the taxonomy split
    // fixes (a busy lock and a stale CAS base used to be indistinguishable to every consumer).
    await expect(
      writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
    ).rejects.toBeInstanceOf(OwnerTransferLockBusyError);

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
    };

    expect(owner.currentOwnerEpoch).toBe(1);
    expect(owner.currentProcessInstanceId).toBe("pid:12345");
    await expect(readFile(join(runDir, "owner-transfer.json"), "utf8")).rejects.toThrow();
  });

  // Task 1 / spec §3: OwnerTransferLockBusyError and OwnerTransferPreconditionError are
  // SIBLINGS, both extending Error directly — not a hierarchy. A subclass relationship would
  // let every existing `instanceof OwnerTransferPreconditionError` consumer keep matching a
  // busy lock as though it were a stale CAS base, silently reinstating the exact defect this
  // task fixes. Both halves are asserted in the failure case AND the non-instanceof direction.
  it("throws OwnerTransferLockBusyError for a busy lock and OwnerTransferPreconditionError for a CAS mismatch, and neither is an instance of the other", async () => {
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    // Half 1: the lock is held by a live pid (this process), so stale-recovery declines to
    // break it — a genuine busy lock, not a CAS mismatch.
    const busyRunDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await writeOwnerRecord(busyRunDir, initialOwnerRecord);
    await writeFile(
      join(busyRunDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-07-22T10:04:59.000Z" }, null, 2),
    );

    let lockBusyError: unknown;
    try {
      await writeOwnerTransferArtifacts(busyRunDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord);
    } catch (error) {
      lockBusyError = error;
    }

    expect(lockBusyError).toBeInstanceOf(OwnerTransferLockBusyError);
    expect(lockBusyError).not.toBeInstanceOf(OwnerTransferPreconditionError);

    // Half 2: no lock at all, but the persisted record has moved on — a genuine CAS mismatch.
    const casRunDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await writeOwnerRecord(casRunDir, {
      ...initialOwnerRecord,
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:other-controller",
    });

    let casMismatchError: unknown;
    try {
      await writeOwnerTransferArtifacts(casRunDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord);
    } catch (error) {
      casMismatchError = error;
    }

    expect(casMismatchError).toBeInstanceOf(OwnerTransferPreconditionError);
    expect(casMismatchError).not.toBeInstanceOf(OwnerTransferLockBusyError);
  });

  it("rejects owner transfer when the expected owner record is stale inside the locked section", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const changedOwnerRecord = {
      ...initialOwnerRecord,
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:other-controller",
      lastAffirmedAt: "2026-07-22T10:04:00.000Z",
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, changedOwnerRecord);

    await expect(
      writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
    ).rejects.toBeInstanceOf(OwnerTransferPreconditionError);
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
  });

  it("keeps a malformed lock non-recoverable even when staged artifacts are present", async () => {
    // Encodes human ruling 83 (point B): tryRecoverStaleOwnerTransferLock now fails CLOSED on
    // every exit but liveness reclamation. Staged artifacts USED to license reclaiming a lock
    // whose contents do not parse, and this test asserted that licence by name ("stale and
    // recoverable"), which is why human ruling 87 named it for a whole rewrite rather than a
    // relaxation. An unparseable lock names no holder, an unattributable holder may not be
    // declared dead, so the lock is not stolen and the staged transfer is never finalized.
    //
    // *** ERRATUM (M-6, HUMAN RULING 104) — THIS IS THE RICHER HALF OF A NEAR-DUPLICATE PAIR.
    // "leaves the lock on disk when malformed staged state names no dead holder", later in this
    // file, builds a BYTE-IDENTICAL fixture, and its single post-hoc assertion is one of the four
    // below. Human ruling 95 declined to delete either one, but left its note only on that test,
    // which is the poorer of the two: deleting THIS one costs three assertions the other lacks.
    // Do not "deduplicate" the pair without a fresh naming under human ruling 88 — ruling 87
    // named both for REWRITE, which is not authority to remove. ***
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );
    await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");

    const owner = await readOwnerRecord(runDir);

    expect(owner.currentOwnerEpoch).toBe(1);
    expect(owner.currentProcessInstanceId).toBe("pid:12345");
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).resolves.toBe("not-json\n");
    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).resolves.toContain(
      "owner lost after reconciliation",
    );
  });

  it("keeps a lock non-recoverable when its live holder is in the strong instance-id form", async () => {
    // Encodes human ruling 83 (point B) -- specifically the OTHER exit that ruling names, which
    // human ruling 87's two rewrites both missed. Ruling 83 closes two failure-open exits: parse
    // failure, and "parse success with a missing or non-`pid:<n>` holder". Both named rewrites
    // landed on the first, so the second shipped with NO test: an independent review measured that
    // reverting the guard alone -- `pid === null || isProcessActive(pid)` back to
    // `pid !== null && isProcessActive(pid)` -- leaves all 600 tests green while restoring the
    // deletion of a LIVE holder's lock. This test exists so that revert goes red.
    //
    // A PURE ADDITION under human ruling 4 ("what is authorised is ADDING tests"). It rewrites no
    // assertion and needs no named exception.
    //
    // The strong `pid:<pid>:<timeOrigin>` form is the realistic holder to use rather than an
    // invented one: it is exactly what pointC-design.md §4.2's mutation C tidies
    // acquireOwnerTransferLock into, and parsePid's /^pid:(\d+)$/ does not match it. The holder is
    // THIS process and therefore alive, so a guard that SKIPS on an unparsed holder instead of
    // REFUSING deletes the lock of a process that still holds it.
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    // The premise this test rests on, asserted rather than assumed: the strong form is NOT what
    // parsePid accepts. Without this, a future change making buildProcessInstanceId() return a bare
    // `pid:<n>` would turn the whole test into a liveness test that passes for the wrong reason.
    const strongHolder = buildProcessInstanceId();
    expect(strongHolder).toMatch(/^pid:\d+:\d+$/);
    expect(strongHolder).not.toMatch(/^pid:\d+$/);
    expect(strongHolder.startsWith(`pid:${process.pid}:`)).toBe(true);

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );
    const lockContents = JSON.stringify({ holderProcessInstanceId: strongHolder, acquiredAt: "2026-07-22T10:05:00.000Z" });
    await writeFile(join(runDir, ".owner-transfer.lock"), lockContents);

    const owner = await readOwnerRecord(runDir);

    // The lock is still there, byte for byte, and the staged transfer was never finalized behind
    // it. Under the reverted guard all three of these fail.
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).resolves.toBe(lockContents);
    expect(owner.currentOwnerEpoch).toBe(1);
    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).resolves.toContain(
      "owner lost after reconciliation",
    );
  });

  it("observes that the redline function actually ran on the strong-holder fixture", async () => {
    // M-5, HUMAN RULING 104. A PURE ADDITION under human ruling 4: it adds a criterion and rewrites
    // none, so it needs no naming under human ruling 88, and the test above is untouched.
    //
    // WHY THIS EXISTS. Every assertion in the test above is also true of a world where
    // tryRecoverStaleOwnerTransferLock was never entered at all: the lock is byte-identical, the
    // epoch is still 1, the staged transfer is still pending. That green is therefore consistent
    // with the guard REFUSING and with the call NEVER HAPPENING, and an independent review named
    // it (cleanup round, M-5). This supplies the missing positive observation — the same
    // anti-vacuity move withLockAttemptCounter already makes for the acquire path.
    //
    // WHAT IS COUNTED, and why the count means what it says: fileStore.ts holds exactly ONE
    // readFile of the lock path, the first statement of tryRecoverStaleOwnerTransferLock. So one
    // read of that path during readOwnerRecord IS one entry into the redline function. It is
    // asserted as "at least one" on purpose, so that the retry bound around it stays free to
    // change without this quietly becoming a criterion about retries.
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    // The same premise the test above asserts, kept here so this one cannot quietly turn into a
    // liveness test that passes for the wrong reason.
    const strongHolder = buildProcessInstanceId();
    expect(strongHolder).not.toMatch(/^pid:\d+$/);

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );
    const lockPath = join(runDir, ".owner-transfer.lock");
    const lockContents = JSON.stringify({ holderProcessInstanceId: strongHolder, acquiredAt: "2026-07-22T10:05:00.000Z" });
    await writeFile(lockPath, lockContents);

    let lockReads = 0;

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        readFile: async (...args: Parameters<typeof actual.readFile>) => {
          // Counted, never faked: everything is forwarded to the real implementation.
          if (String(args[0]) === lockPath) {
            lockReads += 1;
          }

          return actual.readFile(...args);
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const owner = await fileStore.readOwnerRecord(runDir);

      // The positive observation this test exists for: the code under test was entered.
      expect(lockReads).toBeGreaterThan(0);
      // And, having been entered, it refused. Both halves are needed: either alone is vacuous.
      expect(owner.currentOwnerEpoch).toBe(1);
      await expect(readFile(lockPath, "utf8")).resolves.toBe(lockContents);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("reclaims a lock whose holder is an ARRAY that String()s into pid:<n> -- pinned as measured", async () => {
    // Encodes human ruling 99 (Mi-2). ADDED, never rewritten -- human ruling 4 covers adding a
    // criterion, so no naming under ruling 88 was needed. It pins TODAY'S BEHAVIOUR ON PURPOSE,
    // not the behaviour anyone would design: parsePid matches with /^pid:(\d+)$/.exec(holder),
    // and exec coerces its argument through String(), so a holder that is not a string at all
    // still reaches the liveness gate and can license the unlink. Human ruling 94 chose to
    // record that widening in a comment rather than close it, and a claim with nothing
    // enforcing it is this package's signature defect -- so this test is what goes red if
    // someone "tidies" parsePid into a typeof guard, or widens the coercion further. If a later
    // ruling closes the gap, THIS TEST IS THE ONE TO REWRITE (human ruling 88): its failure is
    // then the intended signal, not a regression.
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    // Both premises asserted rather than assumed, so this cannot quietly become a test of
    // something else: the pid must be DEAD (otherwise the guard refuses for the ordinary reason
    // and the coercion is never exercised), and the holder must be a NON-STRING (otherwise
    // there is no coercion to pin).
    const deadPid = 999999;
    expect(isProcessActive(deadPid)).toBe(false);
    const arrayHolder = [`pid:${deadPid}`];
    expect(typeof arrayHolder).not.toBe("string");

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: arrayHolder, acquiredAt: "2026-07-22T10:05:00.000Z" }),
    );

    const owner = await readOwnerRecord(runDir);

    // Measured consequence, both halves. The second is why this matters: the coercion does not
    // merely widen an unlink, it lets an owner epoch advance behind a holder nobody could
    // attribute.
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
    expect(owner.currentOwnerEpoch).toBe(2);
  });

  it("keeps a malformed lock without staged artifacts non-recoverable", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");

    // §3: malformed-and-non-recoverable is a lock-busy outcome (fileStore.ts's
    // acquireOwnerTransferLock, not the CAS check), so it is the sibling class now.
    await expect(
      writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
    ).rejects.toBeInstanceOf(OwnerTransferLockBusyError);
  });

  it("cleans up staged owner transfer files when the lock-holder sees leftover pending files without a marker", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify({ stale: true }, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify({ stale: true }, null, 2));
    await writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord);

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
    };

    expect(owner.currentOwnerEpoch).toBe(2);
    expect(owner.currentProcessInstanceId).toBe("pid:67890");
    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-record.pending.json"), "utf8")).rejects.toThrow();
  });

  it("releases the owner transfer lock when final publish fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
          if (String(args[0]).endsWith(".owner-record.publish.tmp")) {
            throw new Error("simulated owner write failure");
          }

          return actual.writeFile(...args);
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const transfer = applyOwnerEpochTransfer(
        initialOwnerRecord,
        "pid:67890",
        "2026-07-22T10:05:00.000Z",
        "owner lost after reconciliation",
      );

      await fileStore.writeOwnerRecord(runDir, initialOwnerRecord);
      await expect(
        fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
      ).rejects.toThrow("simulated owner write failure");
      await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
      const rawOwner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
        currentOwnerEpoch: number;
        currentProcessInstanceId: string;
      };
      expect(rawOwner.currentOwnerEpoch).toBe(1);
      expect(rawOwner.currentProcessInstanceId).toBe("pid:12345");
      expect(JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8"))).toMatchObject({
        priorOwnerEpoch: 1,
        newOwnerEpoch: 2,
      });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("recovers a half-published transfer after publish failure once finalization can run", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
          if (String(args[0]).endsWith(".owner-record.publish.tmp")) {
            throw new Error("simulated owner write failure");
          }

          return actual.writeFile(...args);
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const transfer = applyOwnerEpochTransfer(
        initialOwnerRecord,
        "pid:67890",
        "2026-07-22T10:05:00.000Z",
        "owner lost after reconciliation",
      );

      await fileStore.writeOwnerRecord(runDir, initialOwnerRecord);
      await expect(
        fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
      ).rejects.toThrow("simulated owner write failure");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(await readOwnerRecord(runDir)).toMatchObject({
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:67890",
    });
    expect(JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8"))).toMatchObject({
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
    });
  });

  it("keeps a live lock in place when recovery cannot yet proceed", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      `pid:${process.pid}`,
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-07-22T10:04:59.000Z" }, null, 2),
    );

    const owner = await readOwnerRecord(runDir);

    expect(owner.currentOwnerEpoch).toBe(1);
    expect(owner.currentProcessInstanceId).toBe("pid:12345");
    expect(JSON.parse(await readFile(join(runDir, ".owner-transfer.lock"), "utf8"))).toMatchObject({
      holderProcessInstanceId: `pid:${process.pid}`,
    });
  });

  it("reconciles a stale transfer lock with pending artifacts before reading owner-record.json", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: "pid:999999", acquiredAt: "2026-07-22T10:04:59.000Z" }, null, 2),
    );

    const recoveredOwner = await readOwnerRecord(runDir);

    expect(recoveredOwner.currentOwnerEpoch).toBe(2);
    expect(recoveredOwner.currentProcessInstanceId).toBe("pid:67890");
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-transfer.transaction.json"), "utf8")).rejects.toThrow();
  });

  it("recovers an interrupted publish before applying the next transfer", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const firstTransfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );
    const secondTransfer = applyOwnerEpochTransfer(
      firstTransfer.nextOwnerRecord,
      "pid:88888",
      "2026-07-22T10:06:00.000Z",
      "owner lost after second reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(firstTransfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(firstTransfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: firstTransfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );

    await writeOwnerTransferArtifacts(runDir, firstTransfer.nextOwnerRecord, secondTransfer.nextOwnerRecord, secondTransfer.transferRecord);

    const owner = await readOwnerRecord(runDir);
    const transferRecord = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
      priorOwnerEpoch: number;
      newOwnerEpoch: number;
      newProcessInstanceId: string;
    };

    expect(owner.currentOwnerEpoch).toBe(3);
    expect(owner.currentProcessInstanceId).toBe("pid:88888");
    expect(transferRecord.priorOwnerEpoch).toBe(2);
    expect(transferRecord.newOwnerEpoch).toBe(3);
    expect(transferRecord.newProcessInstanceId).toBe("pid:88888");
  });

  it("cleans up pending artifacts after successful publish", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord);

    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-record.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-transfer.transaction.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
  });

  it("leaves the published transfer visible when owner-record finalization fails after marker staging", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
          if (String(args[0]).endsWith(".owner-record.publish.tmp")) {
            throw new Error("simulated owner write failure");
          }

          return actual.writeFile(...args);
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const transfer = applyOwnerEpochTransfer(
        initialOwnerRecord,
        "pid:67890",
        "2026-07-22T10:05:00.000Z",
        "owner lost after reconciliation",
      );

      await fileStore.writeOwnerRecord(runDir, initialOwnerRecord);
      await expect(
        fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
      ).rejects.toThrow("simulated owner write failure");

      const transferRecord = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
        priorOwnerEpoch: number;
        newOwnerEpoch: number;
      };
      expect(transferRecord.priorOwnerEpoch).toBe(1);
      expect(transferRecord.newOwnerEpoch).toBe(2);
      const rawOwner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
        currentOwnerEpoch: number;
        currentProcessInstanceId: string;
      };
      expect(rawOwner.currentOwnerEpoch).toBe(1);
      expect(rawOwner.currentProcessInstanceId).toBe("pid:12345");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("releases the lock after rejecting a stale precondition under the critical section", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const changedOwnerRecord = {
      ...initialOwnerRecord,
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:other-controller",
      lastAffirmedAt: "2026-07-22T10:04:00.000Z",
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, changedOwnerRecord);
    await expect(
      writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
    ).rejects.toBeInstanceOf(OwnerTransferPreconditionError);
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
  });

  it("leaves half-published state for later recovery when owner-record finalization fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
          if (String(args[0]).endsWith(".owner-record.publish.tmp")) {
            throw new Error("simulated owner write failure");
          }

          return actual.writeFile(...args);
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const transfer = applyOwnerEpochTransfer(
        initialOwnerRecord,
        "pid:67890",
        "2026-07-22T10:05:00.000Z",
        "owner lost after reconciliation",
      );

      await fileStore.writeOwnerRecord(runDir, initialOwnerRecord);
      await expect(
        fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
      ).rejects.toThrow("simulated owner write failure");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    const transferRecord = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
      priorOwnerEpoch: number;
      newOwnerEpoch: number;
    };
    const rawOwner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
    };

    expect(transferRecord.priorOwnerEpoch).toBe(1);
    expect(transferRecord.newOwnerEpoch).toBe(2);
    expect(rawOwner.currentOwnerEpoch).toBe(1);
    expect(rawOwner.currentProcessInstanceId).toBe("pid:12345");
  });

  it("lets a new transfer supersede a recovered previous transfer after interrupted publish", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const firstTransfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );
    const secondTransfer = applyOwnerEpochTransfer(
      firstTransfer.nextOwnerRecord,
      "pid:88888",
      "2026-07-22T10:06:00.000Z",
      "owner lost after second reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(firstTransfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(firstTransfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: firstTransfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );

    await writeOwnerTransferArtifacts(runDir, firstTransfer.nextOwnerRecord, secondTransfer.nextOwnerRecord, secondTransfer.transferRecord);

    const owner = await readOwnerRecord(runDir);
    const transferRecord = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
      priorOwnerEpoch: number;
      newOwnerEpoch: number;
      newProcessInstanceId: string;
    };

    expect(owner.currentOwnerEpoch).toBe(3);
    expect(owner.currentProcessInstanceId).toBe("pid:88888");
    expect(transferRecord.priorOwnerEpoch).toBe(2);
    expect(transferRecord.newOwnerEpoch).toBe(3);
    expect(transferRecord.newProcessInstanceId).toBe("pid:88888");
  });

  it("leaves the lock on disk when malformed staged state names no dead holder", async () => {
    // Encodes human ruling 83 (point B). The previous version asserted verbatim the behaviour
    // that ruling forbids -- `rejects.toThrow()` on the lock path, i.e. the lock had been
    // unlinked -- so human ruling 87 named it for a whole rewrite; relaxing it would have left a
    // test encoding neither the old spec nor the new one. The only condition that may delete an
    // existing lock is a parsed `pid:<n>` holder that is no longer alive under today's two-state
    // isProcessActive (human ruling 86); malformed contents never reach that check.
    //
    // *** ERRATUM (T2, HUMAN RULING 95) — THIS TEST IS A NEAR-DUPLICATE, KEPT DELIBERATELY.
    // "keeps a malformed lock non-recoverable even when staged artifacts are present" (earlier
    // in this file) builds a BYTE-IDENTICAL fixture and already asserts, verbatim, this test's
    // sole post-hoc assertion -- as one of its four. What is only here is the PRE-assertion that
    // the lock is on disk before readOwnerRecord runs, so a reader can see the delete did not
    // merely fail to happen for want of a lock. Ruling 95 declined to delete either one: both
    // encode a correct spec, and dropping a passing criterion to save a few milliseconds trades
    // real coverage for tidiness. Do not "deduplicate" these two without a fresh naming under
    // human ruling 88 -- ruling 87 named both for REWRITE, which is not authority to remove. ***
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );
    await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");

    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).resolves.toContain("not-json");
    await readOwnerRecord(runDir);
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).resolves.toBe("not-json\n");
  });

  it("publishes the transaction marker by rename, leaving only .owner-transfer.transaction.tmp when the rename fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
          if (String(args[0]).endsWith(".owner-transfer.transaction.tmp")) {
            throw new Error("simulated marker rename failure");
          }

          return actual.rename(...args);
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const transfer = applyOwnerEpochTransfer(
        initialOwnerRecord,
        "pid:67890",
        "2026-07-22T10:05:00.000Z",
        "owner lost after reconciliation",
      );

      await fileStore.writeOwnerRecord(runDir, initialOwnerRecord);
      await expect(
        fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
      ).rejects.toThrow("simulated marker rename failure");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    await expect(readFile(join(runDir, ".owner-transfer.transaction.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-transfer.transaction.tmp"), "utf8")).resolves.toContain("stagedAt");

    await claimOwnerRecordWithPrecondition(runDir, initialOwnerRecord, initialOwnerRecord);

    await expect(readFile(join(runDir, ".owner-transfer.transaction.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-transfer.transaction.tmp"), "utf8")).rejects.toThrow();
  });

  it("publishes .owner-record.pending.json by rename, leaving only .owner-record.pending.tmp when the rename fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
          if (String(args[0]).endsWith(".owner-record.pending.tmp")) {
            throw new Error("simulated owner-pending rename failure");
          }

          return actual.rename(...args);
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const transfer = applyOwnerEpochTransfer(
        initialOwnerRecord,
        "pid:67890",
        "2026-07-22T10:05:00.000Z",
        "owner lost after reconciliation",
      );

      await fileStore.writeOwnerRecord(runDir, initialOwnerRecord);
      await expect(
        fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
      ).rejects.toThrow("simulated owner-pending rename failure");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    await expect(readFile(join(runDir, ".owner-record.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-record.pending.tmp"), "utf8")).resolves.toContain("currentOwnerEpoch");

    await claimOwnerRecordWithPrecondition(runDir, initialOwnerRecord, initialOwnerRecord);

    await expect(readFile(join(runDir, ".owner-record.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-record.pending.tmp"), "utf8")).rejects.toThrow();
  });

  it("publishes .owner-transfer.pending.json by rename, leaving only .owner-transfer.pending.tmp when the rename fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
          if (String(args[0]).endsWith(".owner-transfer.pending.tmp")) {
            throw new Error("simulated transfer-pending rename failure");
          }

          return actual.rename(...args);
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const transfer = applyOwnerEpochTransfer(
        initialOwnerRecord,
        "pid:67890",
        "2026-07-22T10:05:00.000Z",
        "owner lost after reconciliation",
      );

      await fileStore.writeOwnerRecord(runDir, initialOwnerRecord);
      await expect(
        fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
      ).rejects.toThrow("simulated transfer-pending rename failure");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-transfer.pending.tmp"), "utf8")).resolves.toContain("priorOwnerEpoch");

    await claimOwnerRecordWithPrecondition(runDir, initialOwnerRecord, initialOwnerRecord);

    await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".owner-transfer.pending.tmp"), "utf8")).rejects.toThrow();
  });

  it("publishes .reconciliation-record.pending.json by rename, leaving only .reconciliation-record.pending.tmp when the rename fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const reconciliationRecord: ReconciliationRecord = {
      staleSuspicionBasis: ["owner transfer already published"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
          if (String(args[0]).endsWith(".reconciliation-record.pending.tmp")) {
            throw new Error("simulated reconciliation-pending rename failure");
          }

          return actual.rename(...args);
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const transfer = applyOwnerEpochTransfer(
        initialOwnerRecord,
        "pid:67890",
        "2026-07-22T10:05:00.000Z",
        "owner lost after reconciliation",
      );

      await fileStore.writeOwnerRecord(runDir, initialOwnerRecord);
      await expect(
        fileStore.writeOwnerTransferArtifacts(
          runDir,
          initialOwnerRecord,
          transfer.nextOwnerRecord,
          transfer.transferRecord,
          reconciliationRecord,
        ),
      ).rejects.toThrow("simulated reconciliation-pending rename failure");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    await expect(readFile(join(runDir, ".reconciliation-record.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".reconciliation-record.pending.tmp"), "utf8")).resolves.toContain("ownershipVerdict");

    await claimOwnerRecordWithPrecondition(runDir, initialOwnerRecord, initialOwnerRecord);

    await expect(readFile(join(runDir, ".reconciliation-record.pending.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(runDir, ".reconciliation-record.pending.tmp"), "utf8")).rejects.toThrow();
  });

  // §4.3: the marker's existence must sound "all three pendings are staged and complete". That
  // is only true if the reconciliation pending's rename (its atomic publish, not its writeFile)
  // happens strictly before the marker's rename. Watching writeFile instead of rename would
  // pass under an implementation that writes all three temps first and renames the marker ahead
  // of the reconciliation pending — exactly the ordering this test exists to rule out.
  it("renames the reconciliation pending strictly before it renames the transaction marker", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const reconciliationRecord: ReconciliationRecord = {
      staleSuspicionBasis: ["owner transfer already published"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    vi.resetModules();
    const renameTargetOrder: string[] = [];
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
          renameTargetOrder.push(basename(String(args[1])));
          return actual.rename(...args);
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const transfer = applyOwnerEpochTransfer(
        initialOwnerRecord,
        "pid:67890",
        "2026-07-22T10:05:00.000Z",
        "owner lost after reconciliation",
      );

      await fileStore.writeOwnerRecord(runDir, initialOwnerRecord);
      await fileStore.writeOwnerTransferArtifacts(
        runDir,
        initialOwnerRecord,
        transfer.nextOwnerRecord,
        transfer.transferRecord,
        reconciliationRecord,
      );
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    const reconciliationPendingIndex = renameTargetOrder.indexOf(".reconciliation-record.pending.json");
    const markerIndex = renameTargetOrder.indexOf(".owner-transfer.transaction.json");

    expect(reconciliationPendingIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(reconciliationPendingIndex).toBeLessThan(markerIndex);
  });

  // §9 / §10 test 6c: the 10-path cleanup invariant. Every staged temp/pending file the
  // three-file transaction can leave behind when it dies with the marker already gone must be
  // named here individually — a fixture that lists fewer than 10 would go green even while the
  // implementation leaks whichever paths it omitted, which is exactly the failure mode two
  // earlier drafts of this test had (§9 陷阱清单). The marker itself is deliberately absent:
  // "no marker" is the precondition that makes cleanupOwnerTransferStagingWithoutMarker run at
  // all, so it is not one of the 10.
  it("reclaims all ten staging paths on the next lock-held entry when the marker is already gone", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };

    await writeOwnerRecord(runDir, initialOwnerRecord);

    const strayPaths = [
      ".owner-record.pending.json",
      ".owner-transfer.pending.json",
      ".reconciliation-record.pending.json",
      ".owner-record.publish.tmp",
      ".owner-transfer.publish.tmp",
      ".reconciliation-record.publish.tmp",
      ".owner-transfer.transaction.tmp",
      ".owner-record.pending.tmp",
      ".owner-transfer.pending.tmp",
      ".reconciliation-record.pending.tmp",
    ];
    expect(strayPaths).toHaveLength(10);

    for (const strayPath of strayPaths) {
      await writeFile(join(runDir, strayPath), "stray staging content\n");
    }

    // claimOwnerRecordWithPrecondition, not readOwnerRecord: only the former passes
    // { lockHeld: true } into recoverInterruptedOwnerTransfer, which is what makes
    // cleanupOwnerTransferStagingWithoutMarker run when the marker is absent.
    await claimOwnerRecordWithPrecondition(runDir, initialOwnerRecord, initialOwnerRecord);

    for (const strayPath of strayPaths) {
      await expect(readFile(join(runDir, strayPath), "utf8")).rejects.toThrow();
    }
  });

  it("writes contract, state, events, and attempt artifacts", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await initializeRunFiles(runDir, contract, state);
    await appendEvent(runDir, { type: "attempt_started", at: "2026-07-14T00:00:01.000Z", detail: "attempt 1" });
    await writeAttemptArtifacts(runDir, 1, {
      plan: { summary: "change src/index.ts" },
      execution: { changedFiles: ["src/index.ts"], commandOutputs: ["ok"] },
      verify: { approved: false, rejectCategory: "tests-failed" },
      diffPatch: "diff --git a/src/index.ts b/src/index.ts",
      stdoutStderrLog: "npm test\nFAIL",
    });
    await writeRunState(runDir, { ...state, status: "verifying", currentAttempt: 1, attemptsUsed: 1 });

    const savedState = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
    const savedEvents = await readFile(join(runDir, "events.jsonl"), "utf8");
    const savedPlan = JSON.parse(await readFile(join(runDir, "attempts", "1", "plan.json"), "utf8"));

    expect(savedState.status).toBe("verifying");
    expect(savedEvents).toContain("attempt_started");
    expect(savedPlan.summary).toBe("change src/index.ts");
  });

  it("writes execution-recovery.json when execution recovery is present", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeAttemptArtifacts(runDir, 1, {
      plan: { summary: "plan", primaryTargetPaths: ["src/counter.js"] },
      executionRecovery: {
        executeEntered: true,
        worktreeDiffObserved: true,
        diffPatchCaptured: false,
        stdoutStderrLogCaptured: false,
        changedPathsObserved: ["src/counter.js"],
        captureStatus: "partial",
        cleanupStatus: "removed",
        failureBoundary: "token_exhausted",
      },
    });

    const contents = JSON.parse(
      await readFile(join(runDir, "attempts", "1", "execution-recovery.json"), "utf8"),
    ) as { executeEntered: true; failureBoundary: string };

    expect(contents.executeEntered).toBe(true);
    expect(contents.failureBoundary).toBe("token_exhausted");
  });

  it("writes boundary-analysis and reconciliation records when present", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_confirmed",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: {
        staleSuspicionBasis: ["healthy window exceeded", "state freshness mismatch"],
        staleConfirmed: true,
        ownershipVerdict: "OWNER_LOST",
        lastTrustedBoundary: "execute",
        conflictingEvidence: [],
        takeoverPermission: {
          allowed: false,
          reason: "ownership not yet mechanically proven",
        },
        priorOwnerEpoch: 1,
        newOwnerEpoch: 2,
        eligibleForContinuation: true,
      },
    });

    const analysis = JSON.parse(
      await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
    ) as { status: string };
    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as { staleConfirmed: boolean; takeoverPermission: { allowed: boolean } };

    expect(analysis.status).toBe("stale_confirmed");
    expect(reconciliation.staleConfirmed).toBe(true);
    expect(reconciliation.takeoverPermission.allowed).toBe(false);
  });

  it("preserves a successful reconciliation record when a loser later tries to downgrade it", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:winner",
      lastAffirmedAt: "2026-07-23T00:00:01.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    });
    await writeOwnerTransferRecord(runDir, {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:12345",
      newProcessInstanceId: "pid:winner",
      transferredAt: "2026-07-23T00:00:01.000Z",
      reason: "owner lost after reconciliation",
      eligibleForContinuation: true,
    });

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
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
        priorOwnerEpoch: 1,
        newOwnerEpoch: 2,
        eligibleForContinuation: true,
      },
    });

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: {
        staleSuspicionBasis: ["continuity evidence missing"],
        staleConfirmed: true,
        ownershipVerdict: "OWNER_UNDECIDABLE",
        lastTrustedBoundary: "execute",
        conflictingEvidence: [],
        takeoverPermission: {
          allowed: false,
          reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
        },
        priorOwnerEpoch: 2,
        newOwnerEpoch: null,
        eligibleForContinuation: false,
      },
    });

    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as {
      ownershipVerdict: string;
      priorOwnerEpoch: number | null;
      newOwnerEpoch: number | null;
      eligibleForContinuation: boolean;
      takeoverPermission: { allowed: boolean };
    };

    expect(reconciliation.ownershipVerdict).toBe("OWNER_LOST");
    expect(reconciliation.priorOwnerEpoch).toBe(1);
    expect(reconciliation.newOwnerEpoch).toBe(2);
    expect(reconciliation.eligibleForContinuation).toBe(true);
    expect(reconciliation.takeoverPermission.allowed).toBe(true);
  });

  // The post-resume square. resumeLoop keeps currentOwnerEpoch and CAS-writes a FRESH
  // currentProcessInstanceId, so transferRepresentsPublishedWinner's third clause is false for
  // every write the resumed process makes — no race, no crash. The protection above therefore does
  // not engage and the winner's published record is destroyed. Both halves are pinned on purpose:
  //   (i) that the record IS still replaced. This is the assertion that goes red the day someone
  //       "fixes" this by deleting that third clause, which the 2026-08-02 ruling forbids because
  //       it was measured to permit MORE resumes — including over an absent and a corrupt
  //       reconciliation-record.json.
  //   (ii) that the destruction is recorded rather than silent. Before this event existed the
  //       write took the `write` arm, so neither the abandon arm's callback nor its event fired
  //       and the loss produced zero output of any kind.
  it("records reconciliation_published_winner_replaced when a resumed owner downgrade replaces the published winner record", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const winnerReconciliation: ReconciliationRecord = {
      staleSuspicionBasis: ["owner transfer already published"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: {
        allowed: true,
        reason: "strict owner-loss conditions satisfied; continuation still requires a later transfer step",
      },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    // owner-record.json at epoch 2 naming the RESUMER, not the winner: exactly what
    // claimOwnerRecordWithPrecondition leaves behind after resumeLoop adopts the run.
    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:resumer",
      lastAffirmedAt: "2026-07-23T00:00:02.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    });
    await writeOwnerTransferRecord(runDir, {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:12345",
      newProcessInstanceId: "pid:winner",
      transferredAt: "2026-07-23T00:00:01.000Z",
      reason: "owner lost after reconciliation",
      eligibleForContinuation: true,
    });
    await writeFile(
      join(runDir, "reconciliation-record.json"),
      JSON.stringify(winnerReconciliation, null, 2),
    );
    // Fixture precondition for the "exactly one line" assertion below.
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: {
        staleSuspicionBasis: ["continuity evidence missing"],
        staleConfirmed: true,
        ownershipVerdict: "OWNER_UNDECIDABLE",
        lastTrustedBoundary: "execute",
        conflictingEvidence: [],
        takeoverPermission: {
          allowed: false,
          reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
        },
        priorOwnerEpoch: 2,
        newOwnerEpoch: null,
        eligibleForContinuation: false,
      },
    });

    // (i) The downgrade still wins. Deleting transferRepresentsPublishedWinner's third clause
    // turns these four assertions red.
    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as ReconciliationRecord;
    expect(reconciliation.ownershipVerdict).toBe("OWNER_UNDECIDABLE");
    expect(reconciliation.priorOwnerEpoch).toBe(2);
    expect(reconciliation.newOwnerEpoch).toBe(null);
    expect(reconciliation.eligibleForContinuation).toBe(false);

    // (ii) ...and the destroyed winner is named in events.jsonl.
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string; detail: string });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("reconciliation_published_winner_replaced");
    expect(events[0]?.detail).toBe(
      "published winner reconciliation replaced by downgrade: transfer epoch 1 -> 2 won by pid:winner; owner-record epoch 2 now held by pid:resumer",
    );
  });

  // Same post-resume square as the test above, but with a reconciliation-record.json whose content
  // parses to `null` — out-of-schema, and reachable only from outside this repo's writers, since
  // writeJsonFileAtomically always serialises a record and a truncated file yields a parse error
  // that readPersistedReconciliationRecord's catch maps to undefined. It is pinned because `null`
  // is the one such value that BREAKS: readPersistedReconciliationRecord casts an unvalidated
  // JSON.parse result, `null !== undefined`, and isSuccessfulReconciliationForTransfer then reads
  // a property off it (`[]`, `"x"`, `1`, `true` all box harmlessly instead).
  //
  // What this pins is that the observational signal changed NO decision: before it existed this
  // fixture wrote the downgrade and returned, so it must still do exactly that. Uncontained, the
  // TypeError leaves writeBoundaryArtifacts, passes persistBoundaryAnalysis, and lands in
  // runLoopFromState's outer catch, where isLeaseStopError does not match — turning a successful
  // write into a failed attempt while the corrupt file survives. Recording a loss must never be
  // able to manufacture one. Deleting describePublishedWinnerReplacement's try/catch turns this red.
  it("still lands the downgrade when reconciliation-record.json holds a value the record type cannot describe", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    // owner-record.json at epoch 2 naming the RESUMER: the same square the test above pins, so the
    // only difference under test is what is on disk where the winner's record should be.
    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:resumer",
      lastAffirmedAt: "2026-07-23T00:00:02.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    });
    await writeOwnerTransferRecord(runDir, {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:12345",
      newProcessInstanceId: "pid:winner",
      transferredAt: "2026-07-23T00:00:01.000Z",
      reason: "owner lost after reconciliation",
      eligibleForContinuation: true,
    });
    await writeFile(join(runDir, "reconciliation-record.json"), "null");

    // No `.rejects` wrapper on purpose: an unhandled rejection here fails the test with the
    // TypeError itself, which is the diagnosis rather than a bare "expected not to throw".
    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: {
        staleSuspicionBasis: ["continuity evidence missing"],
        staleConfirmed: true,
        ownershipVerdict: "OWNER_UNDECIDABLE",
        lastTrustedBoundary: "execute",
        conflictingEvidence: [],
        takeoverPermission: {
          allowed: false,
          reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
        },
        priorOwnerEpoch: 2,
        newOwnerEpoch: null,
        eligibleForContinuation: false,
      },
    });

    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as ReconciliationRecord;
    expect(reconciliation.ownershipVerdict).toBe("OWNER_UNDECIDABLE");
    expect(reconciliation.priorOwnerEpoch).toBe(2);
    expect(reconciliation.newOwnerEpoch).toBe(null);
    expect(reconciliation.eligibleForContinuation).toBe(false);
  });

  it("synthesizes a successful reconciliation view when winner transfer truth exists before any success reconciliation is written", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:winner",
      lastAffirmedAt: "2026-07-23T00:00:01.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    });
    await writeOwnerTransferRecord(runDir, {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:12345",
      newProcessInstanceId: "pid:winner",
      transferredAt: "2026-07-23T00:00:01.000Z",
      reason: "owner lost after reconciliation",
      eligibleForContinuation: true,
    });

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: {
        staleSuspicionBasis: ["continuity evidence missing"],
        staleConfirmed: true,
        ownershipVerdict: "OWNER_UNDECIDABLE",
        lastTrustedBoundary: "execute",
        conflictingEvidence: ["changed paths observed after interrupted execute: src/index.ts"],
        takeoverPermission: {
          allowed: false,
          reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
        },
        priorOwnerEpoch: 2,
        newOwnerEpoch: null,
        eligibleForContinuation: false,
      },
    });

    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as {
      staleSuspicionBasis: string[];
      staleConfirmed: boolean;
      ownershipVerdict: string;
      lastTrustedBoundary: string;
      conflictingEvidence: string[];
      takeoverPermission: { allowed: boolean; reason: string };
      priorOwnerEpoch: number | null;
      newOwnerEpoch: number | null;
      eligibleForContinuation: boolean;
    };

    expect(reconciliation.ownershipVerdict).toBe("OWNER_LOST");
    expect(reconciliation.priorOwnerEpoch).toBe(1);
    expect(reconciliation.newOwnerEpoch).toBe(2);
    expect(reconciliation.eligibleForContinuation).toBe(true);
    expect(reconciliation.takeoverPermission.allowed).toBe(true);
    expect(reconciliation.takeoverPermission.reason).toBe(
      "strict owner-loss conditions satisfied; continuation still requires a later transfer step",
    );
    expect(reconciliation.staleSuspicionBasis).toEqual(["owner transfer already published"]);
    expect(reconciliation.conflictingEvidence).toEqual([]);
    expect(reconciliation.lastTrustedBoundary).toBe("execute");
  });

  it("preserves a synthesized winner reconciliation view against a later loser downgrade", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:winner",
      lastAffirmedAt: "2026-07-23T00:00:01.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    });
    await writeOwnerTransferRecord(runDir, {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:12345",
      newProcessInstanceId: "pid:winner",
      transferredAt: "2026-07-23T00:00:01.000Z",
      reason: "owner lost after reconciliation",
      eligibleForContinuation: true,
    });

    const loserDowngrade = {
      staleSuspicionBasis: ["continuity evidence missing"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_UNDECIDABLE" as const,
      lastTrustedBoundary: "execute" as const,
      conflictingEvidence: ["changed paths observed after interrupted execute: src/index.ts"],
      takeoverPermission: {
        allowed: false,
        reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
      },
      priorOwnerEpoch: 2,
      newOwnerEpoch: null,
      eligibleForContinuation: false,
    };

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: loserDowngrade,
    });

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: loserDowngrade,
    });

    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as {
      ownershipVerdict: string;
      priorOwnerEpoch: number | null;
      newOwnerEpoch: number | null;
      eligibleForContinuation: boolean;
      takeoverPermission: { allowed: boolean };
    };

    expect(reconciliation.ownershipVerdict).toBe("OWNER_LOST");
    expect(reconciliation.priorOwnerEpoch).toBe(1);
    expect(reconciliation.newOwnerEpoch).toBe(2);
    expect(reconciliation.eligibleForContinuation).toBe(true);
    expect(reconciliation.takeoverPermission.allowed).toBe(true);
  });

  // Test 6f (§10). The three cases below pin the read-side narrowing in
  // preserveSuccessfulReconciliationIfNeeded: a read failure it cannot attribute to "no transfer
  // was ever published" must abandon the reconciliation write rather than write through it.
  //
  // They are three separate `it`s on purpose. Merged into one, an implementation that waves every
  // ENOENT through would satisfy half the assertions while the other half sat behind the same
  // `expect` — exactly the shape that let the old bare `catch { return null }` look correct.
  //
  // Scope: these pin the DECISION to abandon, not its visibility. The "events.jsonl gained a line"
  // assertions below are artifact assertions — an implementation that writes the event but never
  // routes it to an operator passes them. Visibility is carried by 12d.
  it("still writes the reconciliation record when owner-transfer.json is simply absent", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    // The precondition this case exists for: a run that never transferred ownership. Every
    // stale_candidate run reaches writeBoundaryArtifacts with a reconciliation record regardless
    // of whether a transfer ever happened, so the missing owner-transfer.json here is the normal
    // case, not a fault. Narrowing that fails closed on it would stop most runs from ever writing
    // reconciliation-record.json at all — a deleted product, not an added refusal.
    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-23T00:00:01.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    });
    await expect(readFile(join(runDir, "owner-transfer.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const loserReconciliation: ReconciliationRecord = {
      staleSuspicionBasis: ["continuity evidence missing"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_UNDECIDABLE",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: {
        allowed: false,
        reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
      },
      priorOwnerEpoch: 1,
      newOwnerEpoch: null,
      eligibleForContinuation: false,
    };

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: loserReconciliation,
    });

    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as ReconciliationRecord;

    expect(reconciliation).toEqual(loserReconciliation);
  });

  it("abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    // owner-transfer.json is readable, so the ENOENT that follows cannot be attributed to "no
    // transfer was ever published" — it comes from a different read. This is the only one of the
    // three cases that kills an implementation which waves every ENOENT through.
    await writeOwnerTransferRecord(runDir, {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:12345",
      newProcessInstanceId: "pid:winner",
      transferredAt: "2026-07-23T00:00:01.000Z",
      reason: "owner lost after reconciliation",
      eligibleForContinuation: true,
    });
    await expect(readFile(join(runDir, "owner-record.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Fixture precondition for the "exactly one line" assertion below: nothing has written to
    // events.jsonl yet, so the count is a property of this call and not of the environment.
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: {
        staleSuspicionBasis: ["continuity evidence missing"],
        staleConfirmed: true,
        ownershipVerdict: "OWNER_UNDECIDABLE",
        lastTrustedBoundary: "execute",
        conflictingEvidence: [],
        takeoverPermission: {
          allowed: false,
          reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
        },
        priorOwnerEpoch: 2,
        newOwnerEpoch: null,
        eligibleForContinuation: false,
      },
    });

    // boundary-analysis.json is written before the protection runs, so it is still there.
    const analysis = JSON.parse(
      await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
    ) as { status: string };
    expect(analysis.status).toBe("stale_candidate");

    await expect(readFile(join(runDir, "reconciliation-record.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string; detail: string });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("reconciliation_write_abandoned");
    // detail is the only thing the abandonment says about itself. Naming the file that could not
    // be read is what makes the line actionable, and the ENOENT Error stringifies with its path.
    expect(events[0]?.detail).toContain("owner-record.json");
  });

  it("abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    // All three files exist; owner-record.json simply does not parse. The failure is not an ENOENT
    // at all, so this is the case the old bare `catch { return null }` — which waved through every
    // read failure, not just the missing-file one — cannot survive.
    const persistedReconciliation: ReconciliationRecord = {
      staleSuspicionBasis: ["owner transfer already published"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: {
        allowed: true,
        reason: "strict owner-loss conditions satisfied; continuation still requires a later transfer step",
      },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    await writeFile(join(runDir, "owner-record.json"), "{ not json");
    await writeOwnerTransferRecord(runDir, {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:12345",
      newProcessInstanceId: "pid:winner",
      transferredAt: "2026-07-23T00:00:01.000Z",
      reason: "owner lost after reconciliation",
      eligibleForContinuation: true,
    });
    await writeFile(
      join(runDir, "reconciliation-record.json"),
      JSON.stringify(persistedReconciliation, null, 2),
    );
    // Fixture precondition for the "exactly one line" assertion below.
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: {
        staleSuspicionBasis: ["continuity evidence missing"],
        staleConfirmed: true,
        ownershipVerdict: "OWNER_UNDECIDABLE",
        lastTrustedBoundary: "execute",
        conflictingEvidence: [],
        takeoverPermission: {
          allowed: false,
          reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
        },
        priorOwnerEpoch: 2,
        newOwnerEpoch: null,
        eligibleForContinuation: false,
      },
    });

    const analysis = JSON.parse(
      await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
    ) as { status: string };
    expect(analysis.status).toBe("stale_candidate");

    // Not overwritten: the winner's record survives untouched.
    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as ReconciliationRecord;
    expect(reconciliation).toEqual(persistedReconciliation);

    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string; detail: string });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("reconciliation_write_abandoned");
    expect(events[0]?.detail).toContain("JSON");
  });

  // The fourth case exists because the first three all leave owner-transfer.json readable, so
  // none of them reaches the non-ENOENT arm of the try that wraps *its* read. That arm is live —
  // readOwnerTransferRecordRaw is a JSON.parse over a readFile, so a corrupt file raises a
  // SyntaxError, as would EACCES or EISDIR — and without this case a mutation confined to that
  // one arm (returning no_published_transfer from it) leaves the other three green while
  // silently restoring write-through over a record that may be the winner's.
  it("abandons the reconciliation write when owner-transfer.json is not valid JSON, appending reconciliation_write_abandoned", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const persistedReconciliation: ReconciliationRecord = {
      staleSuspicionBasis: ["owner transfer already published"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: {
        allowed: true,
        reason: "strict owner-loss conditions satisfied; continuation still requires a later transfer step",
      },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    await writeOwnerRecord(runDir, {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:winner",
      lastAffirmedAt: "2026-07-23T00:00:01.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    });
    await writeFile(join(runDir, "owner-transfer.json"), "{ not json");
    await writeFile(
      join(runDir, "reconciliation-record.json"),
      JSON.stringify(persistedReconciliation, null, 2),
    );
    // Fixture precondition for the "exactly one line" assertion below.
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_candidate",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: {
        staleSuspicionBasis: ["continuity evidence missing"],
        staleConfirmed: true,
        ownershipVerdict: "OWNER_UNDECIDABLE",
        lastTrustedBoundary: "execute",
        conflictingEvidence: [],
        takeoverPermission: {
          allowed: false,
          reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
        },
        priorOwnerEpoch: 2,
        newOwnerEpoch: null,
        eligibleForContinuation: false,
      },
    });

    const analysis = JSON.parse(
      await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
    ) as { status: string };
    expect(analysis.status).toBe("stale_candidate");

    // Not overwritten: the winner's record survives untouched.
    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as ReconciliationRecord;
    expect(reconciliation).toEqual(persistedReconciliation);

    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string; detail: string });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("reconciliation_write_abandoned");
    expect(events[0]?.detail).toContain("JSON");
  });

  // 12d(iii): the producing side of A8's operator channel. The two tests below reuse the
  // "owner-record.json is missing" fixture above (transfer published, owner record absent),
  // which is the cheapest shape that reaches the abandon branch, and add the third argument.
  // Package 2 whole-branch review, Lane 2 finding I-2 — PURE ADDITION, no existing expectation
  // touched. D2 gave the reconciliation publish its own bounded retry
  // (RECONCILIATION_LOCK_RETRY_ATTEMPTS / _DELAY_MS in src/persistence/fileStore.ts), and the
  // reviewer measured that the whole tests/ tree referenced neither constant and that cutting
  // attempts to 1 — i.e. deleting the retry outright — left the ENTIRE suite green. The transfer
  // side and the resume side each have a "clears" / "exhausted" pair; this third retry had none.
  // The two tests below are that pair, shaped after leaseLifecycle's "retries a busy owner-transfer
  // lock and completes once it clears (spec requirement 1)" / "abandons the transfer once the retry
  // bound is exhausted…".
  //
  // The lock is a REAL lock file naming this live process, so the busy path is the production one:
  // acquireOwnerTransferLock gets EEXIST, tryRecoverStaleOwnerTransferLock sees a live pid and
  // refuses to steal it, and OwnerTransferLockBusyError is what the retry loop actually catches.
  //
  // Attempt counting is by withLockAttemptCounter (see its note above), not by a mocked failure
  // count: the loop's bound is the thing under test, so nothing that shapes it may be faked.
  function busyLockRecord(): string {
    return JSON.stringify(
      { holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-07-25T00:00:00.000Z" },
      null,
      2,
    );
  }

  function staleCandidateAnalysis(): RunBoundaryAnalysis {
    return {
      status: "stale_candidate",
      strongProgressAt: "2026-07-21T10:00:00.000Z",
      weakProgressAt: "2026-07-21T10:05:00.000Z",
      suspectReason: "healthy window exceeded",
      staleCandidateReason: "continuity evidence missing",
    };
  }

  function winnerReconciliation(): ReconciliationRecord {
    return {
      staleSuspicionBasis: ["owner transfer already published"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };
  }

  async function pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async function readEventTypesOrNone(runDir: string): Promise<string[]> {
    try {
      return (await readFile(join(runDir, "events.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { type: string }).type);
    } catch {
      return [];
    }
  }

  it("retries a busy owner-transfer lock for the reconciliation publish and writes the record once it clears", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const lockPath = join(runDir, ".owner-transfer.lock");
    await writeFile(lockPath, busyLockRecord());

    const record = winnerReconciliation();

    // The release is scheduled between the first attempt (t≈0) and the third (t≈2 x 50ms), so the
    // publish can only succeed by RETRYING. The window is one-sided on purpose: the third attempt
    // cannot happen before 100ms — two real sleeps stand in front of it — so a slow machine can
    // only move the success from attempt 2 to attempt 3, never turn it into a failure.
    const release = setTimeout(() => {
      void unlink(lockPath).catch(() => undefined);
    }, 70);

    const attemptsTaken = await withLockAttemptCounter(runDir, async (fileStore, attempts) => {
      try {
        await fileStore.writeBoundaryArtifacts(runDir, {
          boundaryAnalysis: staleCandidateAnalysis(),
          reconciliationRecord: record,
        });
      } finally {
        clearTimeout(release);
      }

      return attempts();
    });

    // First, and deliberately before any file read: with the retry removed this is the assertion
    // that fails, so the test reds on an assertion rather than on an ENOENT from reading a file
    // that was never written.
    expect(await readEventTypesOrNone(runDir)).not.toContain("reconciliation_write_abandoned");

    // The retry is what got it there: attempt 1 met the live lock. `toBeGreaterThanOrEqual` rather
    // than an exact count because whether the win lands on attempt 2 or 3 is a timing detail the
    // production code does not decide; that it took more than one is the requirement.
    expect(attemptsTaken).toBeGreaterThanOrEqual(2);

    expect(JSON.parse(await readFile(join(runDir, "reconciliation-record.json"), "utf8"))).toEqual(record);
  });

  it("abandons the reconciliation publish once the reconciliation retry bound is exhausted, after exactly three lock attempts", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const lockPath = join(runDir, ".owner-transfer.lock");
    // Never released: the whole retry window meets the same live holder.
    await writeFile(lockPath, busyLockRecord());

    const attemptsTaken = await withLockAttemptCounter(runDir, async (fileStore, attempts) => {
      await fileStore.writeBoundaryArtifacts(runDir, {
        boundaryAnalysis: staleCandidateAnalysis(),
        reconciliationRecord: winnerReconciliation(),
      });

      return attempts();
    });

    // The bound itself, as a literal. This is the assertion the reviewer's mutation (attempts -> 1)
    // has to fail: it pins that the loop gave up after three attempts, not after one and not
    // unboundedly. It is the counterpart of leaseLifecycle's writeCalls assertion, written as a
    // literal here because the constant it pins is module-private.
    //
    // The count is exact only because of a fixture premise, named here rather than left implicit
    // (the review's Imp-1): the lock above is held by a LIVE pid, so
    // tryRecoverStaleOwnerTransferLock refuses to steal it and each retry costs exactly one
    // publish attempt. Against a stealable lock one retry can cost two, and this literal would be
    // measuring something else.
    expect(attemptsTaken).toBe(3);

    // Refused, recorded exactly once, and nothing published — the same three observations the
    // transfer side's exhaustion test makes.
    expect(
      (await readEventTypesOrNone(runDir)).filter((type) => type === "reconciliation_write_abandoned"),
    ).toHaveLength(1);
    await expect(readFile(join(runDir, "reconciliation-record.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // boundary-analysis.json is written before the lock is ever taken, so its presence is what
    // shows the abandonment was scoped to the reconciliation publish.
    expect(JSON.parse(await readFile(join(runDir, "boundary-analysis.json"), "utf8")).status).toBe("stale_candidate");

    // The counting seam is required to prove nothing about the behaviour it observes (ruling 55
    // asked for the seam to be replaced; a replacement nobody checked would just move the problem).
    // So the same scenario runs once more through the UNMOCKED, statically imported
    // writeBoundaryArtifacts, and every observable this test asserts is compared. If the local
    // doMock changed what is under test, these two would disagree.
    const controlDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await writeFile(join(controlDir, ".owner-transfer.lock"), busyLockRecord());
    await writeBoundaryArtifacts(controlDir, {
      boundaryAnalysis: staleCandidateAnalysis(),
      reconciliationRecord: winnerReconciliation(),
    });

    expect({
      abandonments: (await readEventTypesOrNone(controlDir)).filter((type) => type === "reconciliation_write_abandoned").length,
      reconciliationPublished: await pathExists(join(controlDir, "reconciliation-record.json")),
      analysisStatus: JSON.parse(await readFile(join(controlDir, "boundary-analysis.json"), "utf8")).status as string,
    }).toEqual({
      abandonments: (await readEventTypesOrNone(runDir)).filter((type) => type === "reconciliation_write_abandoned").length,
      reconciliationPublished: await pathExists(join(runDir, "reconciliation-record.json")),
      analysisStatus: JSON.parse(await readFile(join(runDir, "boundary-analysis.json"), "utf8")).status as string,
    });
  });

  it("calls onReconciliationWriteAbandoned exactly once with the read failure and still resolves", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeOwnerTransferRecord(runDir, {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:12345",
      newProcessInstanceId: "pid:winner",
      transferredAt: "2026-07-23T00:00:01.000Z",
      reason: "owner lost after reconciliation",
      eligibleForContinuation: true,
    });
    // Fixture precondition for "exactly once": owner-record.json is unreadable, so exactly one
    // read fails, so exactly one abandonment can be reported.
    await expect(readFile(join(runDir, "owner-record.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const abandonments: string[] = [];

    await expect(
      writeBoundaryArtifacts(
        runDir,
        {
          boundaryAnalysis: {
            status: "stale_candidate",
            strongProgressAt: "2026-07-21T10:00:00.000Z",
            weakProgressAt: "2026-07-21T10:05:00.000Z",
            suspectReason: "healthy window exceeded",
            staleCandidateReason: "continuity evidence missing",
          },
          reconciliationRecord: {
            staleSuspicionBasis: ["continuity evidence missing"],
            staleConfirmed: true,
            ownershipVerdict: "OWNER_UNDECIDABLE",
            lastTrustedBoundary: "execute",
            conflictingEvidence: [],
            takeoverPermission: {
              allowed: false,
              reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
            },
            priorOwnerEpoch: 2,
            newOwnerEpoch: null,
            eligibleForContinuation: false,
          },
        },
        { onReconciliationWriteAbandoned: (detail) => abandonments.push(detail) },
      ),
    ).resolves.toBeUndefined();

    expect(abandonments).toHaveLength(1);
    // Same content the events.jsonl line carries: String(error) of the read that failed. Naming
    // the file is what makes an operator-visible line actionable.
    expect(abandonments[0]).toContain("owner-record.json");
  });

  it("still resolves and still calls the callback when appendEvent rejects", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeOwnerTransferRecord(runDir, {
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      priorProcessInstanceId: "pid:12345",
      newProcessInstanceId: "pid:winner",
      transferredAt: "2026-07-23T00:00:01.000Z",
      reason: "owner lost after reconciliation",
      eligibleForContinuation: true,
    });
    await expect(readFile(join(runDir, "owner-record.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Makes the real appendEvent reject: appendFile onto a directory raises EISDIR. Preferred
    // over mocking appendEvent because writeBoundaryArtifacts calls it as a module-local
    // function, which no module mock can intercept — and an environment fault is what the
    // swallow exists for in the first place.
    await mkdir(join(runDir, "events.jsonl"));
    await expect(
      appendEvent(runDir, { type: "resume_requested", at: "2026-07-23T00:00:02.000Z", detail: "probe" }),
    ).rejects.toMatchObject({ code: "EISDIR" });

    const abandonments: string[] = [];

    // (a) the protective abandonment stands even without its audit line: an unwritable
    // events.jsonl must not be upgraded into a failed attempt.
    await expect(
      writeBoundaryArtifacts(
        runDir,
        {
          boundaryAnalysis: {
            status: "stale_candidate",
            strongProgressAt: "2026-07-21T10:00:00.000Z",
            weakProgressAt: "2026-07-21T10:05:00.000Z",
            suspectReason: "healthy window exceeded",
            staleCandidateReason: "continuity evidence missing",
          },
          reconciliationRecord: {
            staleSuspicionBasis: ["continuity evidence missing"],
            staleConfirmed: true,
            ownershipVerdict: "OWNER_UNDECIDABLE",
            lastTrustedBoundary: "execute",
            conflictingEvidence: [],
            takeoverPermission: {
              allowed: false,
              reason: "deny-by-default until strict owner-loss and transfer conditions are fully met",
            },
            priorOwnerEpoch: 2,
            newOwnerEpoch: null,
            eligibleForContinuation: false,
          },
        },
        { onReconciliationWriteAbandoned: (detail) => abandonments.push(detail) },
      ),
    ).resolves.toBeUndefined();

    // (b) the operator channel survives the loss of the audit channel — the whole reason the
    // swallow above it is defensible.
    expect(abandonments).toHaveLength(1);
    expect(abandonments[0]).toContain("owner-record.json");

    // The refusal itself still holds: nothing was written through.
    await expect(readFile(join(runDir, "reconciliation-record.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // §10 test 2, fixture guard. The two crash fixtures below only mean something if they really
  // put different bytes on disk, so each gets one smoke assertion first. Everything asserted here
  // is produced by writeOwnerTransferArtifacts, never written by the fixture itself — the fixture
  // writes exactly one file (owner-record.json at epoch 1) and lets the production transaction
  // stage the rest.
  it("stages a first owner transfer with no owner-transfer.json on disk beforehand", async () => {
    const runDir = await stageFirstOwnerTransferCrashedAt(5);

    // The defining property of the first-transfer fixture: none of the three transaction files
    // has ever been published, so all three are absent while the staging is complete.
    expect(await crashSnapshot(runDir)).toBe("T=absent O=e1 R=absent M=v2 P=TOR");
    expect(JSON.parse(await readFile(join(runDir, OWNER_TRANSFER_MARKER_FILE), "utf8")).finalizeOrder)
      .toEqual(["owner-transfer.json", "owner-record.json", "reconciliation-record.json"]);
    expect(JSON.parse(await readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).newOwnerEpoch).toBe(2);
    expect(JSON.parse(await readFile(join(runDir, ".owner-record.pending.json"), "utf8")).currentOwnerEpoch).toBe(2);
    expect(JSON.parse(await readFile(join(runDir, ".reconciliation-record.pending.json"), "utf8")).newOwnerEpoch).toBe(2);
  });

  it("stages a second owner transfer over a first one that already published all three files", async () => {
    const runDir = await stageDoubleOwnerTransferCrashedAt(5);

    // The defining difference from the first-transfer fixture: epoch N -> N+1 is already
    // published on all three paths, and the staged pendings carry N+2.
    expect(await crashSnapshot(runDir)).toBe("T=e2 O=e2 R=e2 M=v2 P=TOR");
    expect(JSON.parse(await readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).newOwnerEpoch).toBe(3);
    expect(JSON.parse(await readFile(join(runDir, ".owner-record.pending.json"), "utf8")).currentOwnerEpoch).toBe(3);
    expect(JSON.parse(await readFile(join(runDir, ".reconciliation-record.pending.json"), "utf8")).newOwnerEpoch).toBe(3);
  });

  // §10 test 2. The interval is the 4 readFile+JSON.parse that finalizePendingOwnerTransfer runs
  // BEFORE its try (marker 1 + pending 3) plus each of the 13 steps inside the try; the two
  // counts are recounted from the landed code, not from the spec (see the task report for the
  // raw `grep -nF -A22 'async function finalizePendingOwnerTransfer('` output). 4 + 13 = 17
  // injection points, run against both fixtures.
  //
  // The mock surface has to include `unlink`, because steps 14..17 are safeUnlink calls and
  // nothing else can produce the tail states (marker gone, pendings still present).
  //
  // The four pre-try gaps are realised as real disk states rather than as mocked read failures:
  // a mocked read leaves a perfectly staged transaction behind, so all four would collapse into
  // one indistinguishable state and three of the four would assert nothing.
  //   - gap 1 (marker parse) is the load-bearing one: §4.4 rule 3. It is DEFENCE IN DEPTH, not a
  //     reachable path — the marker is published by rename from a fully written temp, so no crash
  //     can leave it half-written. It is pinned because the branch exists and must stay fail-closed.
  //   - gaps 2..4 (a pending missing) are §4.4 rule 2 and ARE reachable: a concurrent recovery
  //     that already finalized deletes the pendings out from under a second recovery.
  //
  // Two boundaries this matrix pins that are easy to get backwards:
  //   - Gaps 1..13 are pre-commit and refuse. Gaps 14..17 are past the commit point: all three
  //     files are published there and every eligibility criterion passes, so refusing would be
  //     the bug, not the guard. They carry the name's "commits idempotently past it" clause —
  //     gap 14 still has the marker, so recovery republishes and then reclaims the marker and all
  //     three pendings; gaps 15..17 have no marker, so recovery is the zero-write read (cleanup is
  //     gated on lockHeld) and the residue survives unchanged.
  //     What the snapshot actually observes, and therefore all this clause pins, is presence and
  //     epoch: which of the three files exist and what epoch each carries, whether the marker is
  //     there (and parses), and which pendings remain. It does NOT compare file contents byte for
  //     byte, so a republish that rewrote a field the snapshot does not render would pass here.
  //   - resumeLoop reads the owner record THROUGH recovery (readOwnerRecord) and the other two
  //     RAW, all inside one Promise.all. So a mid-transaction gap is seen as "post-recovery owner
  //     record + pre-recovery transfer/reconciliation". That interleaving is exactly what the two
  //     epoch-equality criteria in evaluateResumeEligibility exist to refuse, and it is why the
  //     double-transfer fixture — not the first-transfer one — is what makes them load-bearing.
  //
  // *** AMENDED under HUMAN RULING 51 — the SIXTH named exception, which covers gaps 05..13 of both
  // fixtures (18 rows) AND NOTHING ELSE. The paragraph immediately above is kept verbatim and is now
  // HISTORY: that interleaving no longer exists. resumeLoop awaits readOwnerRecord FIRST and only
  // then reads the rest (Lane 1 finding I-4), because the interleaving was not a design, it was a
  // defect — a run interrupted inside the commit window was refused on its first resume with
  // "cannot read run artifacts" and healed by itself on the second.
  //
  // THE 18 ROWS ARE TWO DIFFERENT THINGS AND MUST NOT BE READ AS ONE (the independent review's
  // Imp-2; the earlier report merged them and that merge was false):
  //   - first-transfer fixture, 9 rows: these read `refused: cannot read run artifacts`. That
  //     refusal was MANUFACTURED BY THE DEFECT — an ENOENT on a file the recovery already in flight
  //     was about to publish. Deleting it removes a wrong answer; it grants nothing.
  //   - double-transfer fixture, 9 rows: these were refused by the two epoch-equality criteria in
  //     evaluateResumeEligibility. Those refusals were real refusals. Changing them IS A NEW
  //     PERMISSION, and it is the half that needs a ruling.
  //
  // WHAT THAT SECOND HALF DOES TO S-3, named to the sentence rather than waved at (the standing
  // position is docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md):
  //   - The clause it moves: "只增加拒绝，绝不新增许可" ("only add refusals, never add
  //     permissions"). On those 9 rows this change adds a permission. That is a deliberate,
  //     human-ruled exception (ruling 54), recorded here rather than absorbed silently.
  //   - The clause it does NOT move, and which still holds: "放松 resumeLoop 对 reconciliation 的
  //     必需性（例如「若存在则校验，不存在则跳过」）… 缺失即拒绝的 fail-closed 行为必须保留"
  //     ("relaxing resumeLoop's requirement for reconciliation — e.g. check it if present, skip it
  //     if absent — is forbidden; missing-means-refused must be preserved"). Nothing here skips a
  //     missing reconciliation-record.json. It is still required and still read; what changed is
  //     only that it is read AFTER the recovery that publishes it. Gaps 01..04 above are the
  //     evidence: where the transaction cannot be completed, resume is still refused and the disk
  //     is left untouched.
  //
  // WHY `accepted` IS THE CORRECT TERMINAL STATE ON ALL 18 ROWS — measured, and now ENFORCED. Every
  // row below carries an `afterResume` column: the state the resume attempt itself left on disk.
  // For all of gaps 05..13 in BOTH fixtures it is the fully committed, internally consistent triple
  // with the staging reclaimed — `T=e2 O=e2 R=e2 M=absent P=---` for the first-transfer fixture and
  // `T=e3 O=e3 R=e3 M=absent P=---` for the double-transfer one — which is THE SAME COMMITTED END
  // STATE gap 14 reaches, the square this comment already calls the one where "refusing would be
  // the bug, not the guard". No torn publish, no orphaned pending, no surviving marker, and the
  // epochs agree across all three files: the resume is evaluated on a committed transaction, not on
  // half of one.
  //
  // Two precision notes, both from the scoped re-review:
  //   - "the same end state" is a claim about the SNAPSHOT (presence, epoch, marker, pendings) and
  //     about the artifacts' fields — NOT about bytes. An independent reviewer compared all three
  //     files field by field against gap 14 and found them identical except owner-record.json's
  //     `lastAffirmedAt`, which is a wall clock and cannot match. An earlier version of this
  //     paragraph said "byte-for-byte", which was an overclaim and also contradicted this file's
  //     own statement that crashSnapshot "does NOT compare file contents byte for byte" (Low-3).
  //   - until fix round 3 this paragraph rested on a measurement taken OUT OF TREE, with nothing in
  //     the suite pinning it — the `after` column is taken from a second copy that only ran
  //     recovery, never a resume. That gap was the review's Imp-2, and the `afterResume` column is
  //     the repair: a regression that let an accepted resume land on a torn state now reds here. ***
  it(
    "refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives",
    async () => {
      // Soft, so one run reports BOTH fixtures' verdicts instead of aborting at the first
      // divergence: which fixture a mutation kills is the whole point of §10 test 6b.
      expect.soft(await observeCrashMatrix(stageFirstOwnerTransferCrashedAt)).toEqual([
        // Gaps 01..04: nothing is published yet AND the transaction cannot be completed (the
        // marker is unparseable, or a pending it promises is gone), so recovery refuses and resume
        // refuses with it. Unchanged by ruling 51, and deliberately so: this is the fail-closed
        // half S-3 requires, and it is what shows the amendment below is not "skip what is
        // missing".
        //
        // Gaps 05..13 BELOW ARE THE 9 AMENDED ROWS OF THIS FIXTURE (ruling 51). They used to read
        // `refused: cannot read run artifacts`. That refusal was the defect's own product: the
        // reconciliation read raced the recovery that was about to publish it. Removing it grants
        // nothing — the run was always eligible; the reader was looking too early.
        "gap 01 | T=absent O=e1 R=absent M=unparseable P=TOR | resume=refused: cannot read run artifacts | afterResume T=absent O=e1 R=absent M=unparseable P=TOR | recovery=throws OwnerTransferMarkerUnreadableError | after T=absent O=e1 R=absent M=unparseable P=TOR",
        "gap 02 | T=absent O=e1 R=absent M=v2 P=-OR | resume=refused: cannot read run artifacts | afterResume T=absent O=e1 R=absent M=v2 P=-OR | recovery=throws OwnerTransferPendingMissingError | after T=absent O=e1 R=absent M=v2 P=-OR",
        "gap 03 | T=absent O=e1 R=absent M=v2 P=T-R | resume=refused: cannot read run artifacts | afterResume T=absent O=e1 R=absent M=v2 P=T-R | recovery=throws OwnerTransferPendingMissingError | after T=absent O=e1 R=absent M=v2 P=T-R",
        "gap 04 | T=absent O=e1 R=absent M=v2 P=TO- | resume=refused: cannot read run artifacts | afterResume T=absent O=e1 R=absent M=v2 P=TO- | recovery=throws OwnerTransferPendingMissingError | after T=absent O=e1 R=absent M=v2 P=TO-",
        "gap 05 | T=absent O=e1 R=absent M=v2 P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
        "gap 06 | T=absent O=e1 R=absent M=v2 P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
        "gap 07 | T=absent O=e1 R=absent M=v2 P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
        "gap 08 | T=e2 O=e1 R=absent M=v2 P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
        "gap 09 | T=e2 O=e1 R=absent M=v2 P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
        "gap 10 | T=e2 O=e1 R=absent M=v2 P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
        "gap 11 | T=e2 O=e2 R=absent M=v2 P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
        "gap 12 | T=e2 O=e2 R=absent M=v2 P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
        "gap 13 | T=e2 O=e2 R=absent M=v2 P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
        // Past the commit point: all three published. Gap 14 still has the marker, so recovery
        // republishes idempotently and reclaims it; gaps 15..17 have no marker, so recovery is
        // the zero-write read (cleanup is gated on lockHeld) and the residue survives untouched.
        "gap 14 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
        "gap 15 | T=e2 O=e2 R=e2 M=absent P=TOR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=TOR",
        "gap 16 | T=e2 O=e2 R=e2 M=absent P=-OR | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=-OR",
        "gap 17 | T=e2 O=e2 R=e2 M=absent P=--R | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=--R",
      ]);

      expect.soft(await observeCrashMatrix(stageDoubleOwnerTransferCrashedAt)).toEqual([
        // Gaps 1..4: the published triple is internally consistent at e2 and would pass the gate
        // on its own. The refusal comes only from recovery refusing to decide — an undecidable
        // transaction must not resume even when what is published looks eligible. Unchanged.
        //
        // Gaps 05..13 BELOW ARE THE OTHER 9 AMENDED ROWS — and these are the ones that matter.
        // They were refused by real criteria (see the two comments that follow, kept verbatim as
        // history), not by a manufactured read error, so amending them ADDS A PERMISSION and is the
        // half that required human ruling 54. Measured end state after an accepted resume here:
        // `T=e3 O=e3 R=e3 M=absent P=---`, i.e. the transaction committed in full.
        "gap 01 | T=e2 O=e2 R=e2 M=unparseable P=TOR | resume=refused: cannot read run artifacts | afterResume T=e2 O=e2 R=e2 M=unparseable P=TOR | recovery=throws OwnerTransferMarkerUnreadableError | after T=e2 O=e2 R=e2 M=unparseable P=TOR",
        "gap 02 | T=e2 O=e2 R=e2 M=v2 P=-OR | resume=refused: cannot read run artifacts | afterResume T=e2 O=e2 R=e2 M=v2 P=-OR | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=-OR",
        "gap 03 | T=e2 O=e2 R=e2 M=v2 P=T-R | resume=refused: cannot read run artifacts | afterResume T=e2 O=e2 R=e2 M=v2 P=T-R | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=T-R",
        "gap 04 | T=e2 O=e2 R=e2 M=v2 P=TO- | resume=refused: cannot read run artifacts | afterResume T=e2 O=e2 R=e2 M=v2 P=TO- | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=TO-",
        // Gaps 5..7, HISTORY (kept verbatim; true before the read-order fix, false after it):
        // "recovery advances owner-record.json to e3 while owner-transfer.json is still the e2 one.
        // Criterion B (ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch) is the ONLY
        // criterion that refuses this shape — criterion A sees e2 === e2 and passes."
        // That mixed view was the interleaving itself: post-recovery owner record, pre-recovery
        // transfer. With the reads sequenced there is no mixed view left to refuse — all three
        // files are read at e3. Criterion B is NOT left unexercised by this: it is asserted
        // directly, on constructed inputs, in tests/controller/resumeLoop.gate.test.ts.
        "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
        "gap 06 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
        "gap 07 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
        // Gaps 8..13, HISTORY (kept verbatim; true before the read-order fix, false after it):
        // "owner-transfer.json is already e3 and the owner record reads e3, but
        // reconciliation-record.json is still the e2 one. Criterion B passes (e3 === e3); only
        // criterion A (reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch) refuses."
        // Same correction as above: the stale reconciliation view was the race, not the run's
        // state. Criterion A also keeps its own direct coverage in resumeLoop.gate.test.ts.
        "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
        "gap 09 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
        "gap 10 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
        "gap 11 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
        "gap 12 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
        "gap 13 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
        "gap 14 | T=e3 O=e3 R=e3 M=v2 P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
        "gap 15 | T=e3 O=e3 R=e3 M=absent P=TOR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=TOR",
        "gap 16 | T=e3 O=e3 R=e3 M=absent P=-OR | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=-OR",
        "gap 17 | T=e3 O=e3 R=e3 M=absent P=--R | resume=accepted | afterResume T=e3 O=e3 R=e3 M=absent P=--- | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=--R",
      ]);
    },
    120000,
  );
});

function ownerRecord(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:111", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
    ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: null, ...overrides,
  };
}

// Package 2 whole-branch review, Critical C-1, human ruling 50 (option O1(a)). The enforcement
// mechanism for the atomic publish, and the reason it exists at all: the two-real-process probe in
// .superpowers/sdd/2026-08-07-pkg2-data-loss/probe-c1/ measures the defect (hundreds of lost updates
// per 5s run before the fix, zero after — magnitudes, not reproducible constants; see that probe's
// SENSITIVITY note), but a probe is not a guardrail — nothing in the suite would notice if the
// publish went back to two steps. Without this test the fix would be the fifth "completeness claim
// with no enforcement behind it" in this repository's history.
//
// WHAT IS ASSERTED is the property, not the implementation: at the instant `.owner-transfer.lock`
// FIRST EXISTS, its content already parses. That is the whole of C-1's first half — an intruder
// that hits EEXIST reads whatever is there at that moment, and a zero-byte read is what sends
// tryRecoverStaleOwnerTransferLock into the `catch` branch that unlinks a live holder's lock.
// *** ERRATUM (point B, human ruling 83): the sentence above is kept verbatim; that `catch` branch
// now returns false and unlinks nothing. The property asserted below does not depend on it — it
// pins that the lock parses the instant it first exists, which is worth pinning whatever the
// intruder would have done next. ***
//
// HOW it is observed without touching production code or the shared mock factory at the top of this
// file: a LOCAL vi.doMock of node:fs/promises wraps the two calls that can bring the lock path into
// existence — `open` (the old two-step publish) and `link` (the new atomic one) — and reads the file
// back SYNCHRONOUSLY the instant either resolves. Synchronously matters: an await would let the
// production code's own next step run first and the zero-byte instant would be gone.
describe("the owner-transfer lock is published atomically, never as an empty file that fills in later", () => {
  it("has parseable content at the first instant the lock path exists", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const lockPath = join(runDir, ".owner-transfer.lock");
    const current = ownerRecord();
    await writeOwnerRecord(runDir, current);

    const sightings: Array<{ via: string; empty: boolean; parseable: boolean }> = [];

    const observe = (via: string): void => {
      const contents = readFileSync(lockPath, "utf8");
      let parseable = true;

      try {
        JSON.parse(contents);
      } catch {
        parseable = false;
      }

      sightings.push({ via, empty: contents.length === 0, parseable });
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await actual.open(...args);
          if (String(args[0]) === lockPath) {
            observe("open");
          }
          return handle;
        },
        link: async (...args: Parameters<typeof actual.link>) => {
          const result = await actual.link(...args);
          if (String(args[1]) === lockPath) {
            observe("link");
          }
          return result;
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      await fileStore.claimOwnerRecordWithPrecondition(
        runDir,
        current,
        ownerRecord({ currentProcessInstanceId: "pid:222" }),
      );

      // Anti-vacuity, and load-bearing: a wrapper that stopped seeing the lock path would make the
      // real assertion below pass forever while observing nothing — the broken-probe failure mode
      // this repository keeps hitting. Exactly one publish happens in this call.
      expect(sightings).toHaveLength(1);

      // The requirement. Under the two-step publish this reads { empty: true, parseable: false },
      // because `open(lockPath, "wx")` returns with the file created and still zero bytes.
      expect({ empty: sightings[0]?.empty, parseable: sightings[0]?.parseable })
        .toEqual({ empty: false, parseable: true });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

// Human ruling 70's separately-confirmed addendum (pointC-design.md §7, "另一件事：范围之外"),
// confirmed on 2026-08-19: turn fileStore.ts:724-726's "do not 'unify' it with this one" comment
// into an ENFORCED invariant. A pure test addition — it touches no production code and no red line.
//
// WHY this deserves a test of its own, measured rather than argued (pointC-design.md §4.2,
// mutation C): replacing acquireOwnerTransferLock's weak `pid:<pid>` holder with the strong
// buildProcessInstanceId() form is a ONE-LINE change that typechecks with ZERO errors — and it
// turns tryRecoverStaleOwnerTransferLock, the function human ruling 50 froze byte-for-byte, into an
// UNCONDITIONAL LOCK STEALER. parsePid's /^pid:(\d+)$/ returns null for the strong form, so the
// `pid !== null && isProcessActive(pid)` guard is skipped entirely and the path falls through to
// safeUnlink.
//
// *** ERRATUM (point B, HUMAN RULING 83) — THE DIRECTION REVERSED, THE INVARIANT DID NOT. The
// paragraph above is kept verbatim because it records what was measured under ruling 50. When
// mutation C was measured, an unparsed holder SKIPPED the guard (`pid !== null && isProcessActive`)
// and fell through to safeUnlink, making the function an UNCONDITIONAL LOCK STEALER. Ruling 83
// turned that guard into `pid === null || isProcessActive(pid)`, so the same one-line tidy-up now
// makes it an UNCONDITIONAL LOCK REFUSER instead: no stale lock is ever reclaimed, and every owner
// transfer behind one blocks until a human runs `ccloop unlock`. Silent data loss became a silent
// stall. That is why this test still has to exist, and why its name says the guard must be able to
// PARSE the holder rather than saying anything about stealing. ***
//
// *** ERRATUM (M-7, HUMAN RULING 104) — THE FREEZE, NAMED HERE AS IT IS EVERYWHERE ELSE. The
// erratum above corrects the direction and stops there. Every other freeze site in this tree says
// the rest of it in so many words: that freeze has since been lifted, for point B alone, and the
// function changed. src/persistence/fileStore.ts, src/sweep/lockPresence.ts,
// src/unlock/inspectLock.ts, tests/sweep/lockPresence.test.ts and tests/sweep/sweepRuns.test.ts
// all carry that sentence; this was the one site that did not. The omission was cosmetic — the
// invariant this test guards is unaffected either way. ***
//
// Three tests DO go red under that mutation today, but they report it as
// "renameCount 4 instead of 2", as a loser that was never blocked, and as a loser that published
// against a live lock — not one of them names the cause. This one names it, so the next person who
// tidies the two identity forms into one learns from a failure message why they must not.
describe("the owner-transfer lock's holder stays in the weak pid form its liveness guard can parse", () => {
  it("publishes holderProcessInstanceId as `pid:<pid>` for this live process, never the strong instance id", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const lockPath = join(runDir, ".owner-transfer.lock");
    const current = ownerRecord();
    await writeOwnerRecord(runDir, current);

    // Read SYNCHRONOUSLY at the publishing link, for the same reason the sibling test above does:
    // the lock is released before the call returns, so there is no later instant to read it at.
    const published: string[] = [];

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        link: async (...args: Parameters<typeof actual.link>) => {
          const result = await actual.link(...args);
          if (String(args[1]) === lockPath) {
            published.push(readFileSync(lockPath, "utf8"));
          }
          return result;
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      await fileStore.claimOwnerRecordWithPrecondition(
        runDir,
        current,
        ownerRecord({ currentProcessInstanceId: "pid:222" }),
      );

      // Anti-vacuity, and load-bearing: a wrapper that stopped seeing the lock path would leave
      // `published` empty and make every assertion below vacuously true — the broken-probe failure
      // mode this repository keeps hitting. Exactly one lock publish happens in this call.
      expect(published).toHaveLength(1);

      const holder = (JSON.parse(published[0] ?? "{}") as { holderProcessInstanceId?: string })
        .holderProcessInstanceId;

      // The invariant itself, stated as the guard reads it: parsePid's own regex, and the pid it
      // extracts must be THIS process — a holder that parses but names someone else would let a
      // live holder's lock be judged against the wrong process.
      expect(holder).toMatch(/^pid:\d+$/);
      expect(Number.parseInt(String(holder).slice("pid:".length), 10)).toBe(process.pid);

      // The premise that makes the invariant matter, asserted rather than assumed: the strong form
      // is NOT accepted by that regex, which is exactly why unifying the two forms disarms the
      // liveness guard. If this line ever fails, the invariant has to be re-derived — do not
      // relax it, because its failing means the two forms have converged and the reasoning above
      // no longer describes the code.
      expect(buildProcessInstanceId()).not.toMatch(/^pid:\d+$/);
      expect(holder).not.toBe(buildProcessInstanceId());
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});


// Package 2 fix round 3, the scoped re-review's Imp-1 — a defect THIS fix round introduced and the
// guard that keeps it from coming back. Making the publish atomic put a throwing statement between
// the publish and the return: `safeUnlink(stagingPath)` rethrows every errno that is not ENOENT, so
// an environment fault (EACCES/EPERM/EROFS/ESTALE/EIO) there escaped with the LOCK ALREADY ON DISK
// and no `release` in the caller's hands. That lock is not reclaimable either — its record names a
// live pid, so tryRecoverStaleOwnerTransferLock refuses it — which turns every later
// owner-transfer operation on that run into OwnerTransferLockBusyError until the process exits.
//
// Both tests below inject the fault at the one place that can produce it: `unlink` of the lock's
// staging path. Nothing else is faked, and the lock path's own unlink (release's) is left alone, so
// what is measured is the real release doing real work.
describe("a failure to clear the lock's publish staging file never costs the caller its lock", () => {
  // The staging name is buildAtomicTempPath(lockPath): same directory, a dot-prefixed name derived
  // from the lock's own basename, ending .tmp. Matching on that rather than on an exact string
  // keeps the fault injection honest — the production code picks the name, not this test.
  async function lockFileExists(lockPath: string): Promise<boolean> {
    try {
      await stat(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  function isLockStagingPath(candidate: string, runDir: string): boolean {
    return candidate.startsWith(join(runDir, "..owner-transfer.lock.")) && candidate.endsWith(".tmp");
  }

  async function withFailingStagingUnlink<T>(
    runDir: string,
    body: (fileStore: typeof import("../../src/persistence/fileStore.js")) => Promise<T>,
  ): Promise<T> {
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        unlink: async (...args: Parameters<typeof actual.unlink>) => {
          if (isLockStagingPath(String(args[0]), runDir)) {
            const error = new Error("EACCES: permission denied, unlink") as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          }

          return actual.unlink(...args);
        },
      };
    });

    try {
      return await body(await import("../../src/persistence/fileStore.js"));
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  }

  it("completes the claim and leaves no lock behind when clearing the staging file fails after the publish", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const current = ownerRecord();
    await writeOwnerRecord(runDir, current);

    // Captured as a value, not awaited bare: against the unfixed code this call rejects, and a test
    // that dies of the rejection would report an exception instead of a failed assertion.
    const outcome = await withFailingStagingUnlink(runDir, async (fileStore) =>
      fileStore
        .claimOwnerRecordWithPrecondition(runDir, current, ownerRecord({ currentProcessInstanceId: "pid:222" }))
        .then(() => ({ kind: "completed" }), (error: unknown) => ({ kind: "threw", detail: String(error) })));

    // The requirement, in two halves. First: the caller got its lock's lifecycle back — the claim
    // ran to completion rather than escaping between publish and return.
    expect(outcome).toEqual({ kind: "completed" });

    // Second, and this is the half that names the damage: release() actually ran, so the lock is
    // gone. Left behind it would be unreclaimable (live pid) and would block every owner-transfer
    // operation on this run until the process exits.
    expect(await lockFileExists(join(runDir, ".owner-transfer.lock"))).toBe(false);

    // The claim's own effect still happened; the fault was contained to the staging cleanup.
    expect((await readOwnerRecord(runDir)).currentProcessInstanceId).toBe("pid:222");
  });

  it("still reports a busy lock, not the cleanup's errno, when the staging cleanup fails on a contended acquire", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await writeOwnerRecord(runDir, ownerRecord());
    // A live holder: link() will lose with EEXIST, and tryRecoverStaleOwnerTransferLock will refuse
    // to steal it, so the correct answer is OwnerTransferLockBusyError.
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-07-25T00:00:00.000Z" }, null, 2),
    );

    const outcome = await withFailingStagingUnlink(runDir, async (fileStore) =>
      fileStore
        .claimOwnerRecordWithPrecondition(runDir, ownerRecord(), ownerRecord({ currentProcessInstanceId: "pid:222" }))
        .then(() => "completed", (error: unknown) => (error as Error).name));

    // A cleanup that rethrows would replace EEXIST with EACCES here and route a genuine contention
    // out of the busy-lock branch entirely, so the caller would see a bare errno instead.
    expect(outcome).toBe("OwnerTransferLockBusyError");
  });
});

// Package 2, the identity half of C-1, HUMAN RULING 62. Before this guard, release() unlinked
// `.owner-transfer.lock` unconditionally, so a holder whose lock had already been stolen and
// republished by someone else deleted THE NEW HOLDER'S lock on its way out — measured on dbac288
// (pointB-design.md §6.1), and covered by exactly zero tests: a prototype of the fix passed the
// whole suite unchanged, which is why ruling 62 required a guardrail alongside the fix.
//
// WHAT IS ASSERTED is the ruling's three-part behavior on the one square it names — the lock at
// `lockPath` is not the one this process published: the lock STAYS ON DISK with the other holder's
// bytes intact, release() does NOT throw (it runs in four `finally` blocks, where a rejection would
// replace the error already in flight), and the refusal is VISIBLE as an event.
//
// THE FOREIGN LOCK DELIBERATELY NAMES THIS PROCESS'S OWN PID. A second acquisition by this same
// process writes exactly that record, so this fixture is also the same-process-reentrancy square,
// and it is what makes the test kill the weaker identity check the earlier prototype used
// (`holderProcessInstanceId === \`pid:${process.pid}\``): under that check the record matches, the
// unlink goes ahead, and the other holder's lock is gone.
//
// HOW the theft is staged, without touching production code: the same local vi.doMock +
// dynamic-import seam the tests above use. `rename` to owner-record.json is the last write inside
// claimOwnerRecordWithPrecondition's lock span, so replacing the lock file the instant it resolves
// puts a foreign lock in place while this process still believes it holds one, and release() runs
// next in the `finally`.
describe("the owner-transfer lock's release only deletes the lock this process published", () => {
  const FOREIGN_LOCK_CONTENTS = JSON.stringify(
    { holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-08-11T00:00:00.000Z" },
    null,
    2,
  );

  async function readEventTypes(runDir: string): Promise<string[]> {
    try {
      return (await readFile(join(runDir, "events.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { type: string }).type);
    } catch {
      return [];
    }
  }

  async function readLockOrGone(lockPath: string): Promise<string> {
    try {
      return await readFile(lockPath, "utf8");
    } catch {
      return "GONE";
    }
  }

  // `steal: false` is the must-hit control arm: identical machinery, identical seam, no theft.
  async function claimWithOptionalTheft(
    runDir: string,
    steal: boolean,
  ): Promise<{ outcome: string; thefts: number }> {
    const lockPath = join(runDir, ".owner-transfer.lock");
    const ownerRecordPath = join(runDir, "owner-record.json");
    let thefts = 0;

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
          const result = await actual.rename(...args);

          if (steal && String(args[1]) === ownerRecordPath) {
            await actual.unlink(lockPath);
            await actual.writeFile(lockPath, FOREIGN_LOCK_CONTENTS);
            thefts += 1;
          }

          return result;
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const outcome = await fileStore
        .claimOwnerRecordWithPrecondition(runDir, ownerRecord(), ownerRecord({ currentProcessInstanceId: "pid:222" }))
        .then(() => "completed", (error: unknown) => `threw ${String(error)}`);

      return { outcome, thefts };
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  }

  it("leaves a lock it no longer owns on disk, records the refusal, and never throws out of the finally", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const lockPath = join(runDir, ".owner-transfer.lock");
    await writeOwnerRecord(runDir, ownerRecord());

    const { outcome, thefts } = await claimWithOptionalTheft(runDir, true);

    // Anti-vacuity first: a seam that stopped firing would make every assertion below pass while
    // observing nothing — the broken-probe failure mode this repository keeps hitting.
    expect(thefts).toBe(1);

    // Ruling 62's three parts, asserted together so a fix that satisfies only some of them fails
    // here. Against the unconditional unlink the lock reads "GONE".
    expect({ outcome, lock: await readLockOrGone(lockPath), events: await readEventTypes(runDir) }).toEqual({
      outcome: "completed",
      lock: FOREIGN_LOCK_CONTENTS,
      events: ["owner_transfer_lock_release_skipped"],
    });

    // The claim's own effect still happened: the guard protects the other holder's lock, it does
    // not abandon this caller's work.
    expect((await readOwnerRecord(runDir)).currentProcessInstanceId).toBe("pid:222");
  });

  it("still deletes the lock, and records nothing, when the lock is the one this process published", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const lockPath = join(runDir, ".owner-transfer.lock");
    await writeOwnerRecord(runDir, ownerRecord());

    const { outcome, thefts } = await claimWithOptionalTheft(runDir, false);

    // The must-hit half of the pair: a guard that refused everything would leave the lock behind
    // here, and every later owner-transfer operation on this run would fail as busy. Without this
    // arm the test above is also satisfied by "release() never unlinks anything".
    expect({ thefts, outcome, lock: await readLockOrGone(lockPath), events: await readEventTypes(runDir) }).toEqual({
      thefts: 0,
      outcome: "completed",
      lock: "GONE",
      events: [],
    });
  });
});

// Package 2 fix round under HUMAN RULING 64, review findings M-5 and M-2. Both describes below
// exist because the review MEASURED a hole, not because a hole was argued for.
//
// M-5: the reviewer's surviving mutation F deleted the `dev` half of the identity comparison
// (`onDisk.dev === published.dev &&`) and the whole suite stayed green — 31 files / 535 tests,
// exit 0. `ino` alone identifies a file only within one filesystem, so the surviving half of the
// comparison was doing real work with nothing enforcing it: this repository's signature shape.
//
// HOW THE CROSS-DEVICE CASE IS PRODUCED, stated plainly because it is the load-bearing caveat: NOT
// by mounting a second filesystem. A same-inode-different-device collision cannot be staged on one
// mount, and a test that silently could not produce its own precondition would be the always-green
// criterion that is worse than none. The device number is injected instead — the local
// vi.doMock seam wraps `stat` and returns the REAL Stats for the lock path with `dev` shifted by
// one, leaving `ino` untouched. What that pins is the comparison: given an on-disk file whose inode
// number matches but whose device does not, release() must refuse. What it does NOT pin is any
// claim about which kernels or mounts can produce that state — see the fix-round report.
describe("the owner-transfer lock's release compares the device as well as the inode number", () => {
  async function readEventTypes(runDir: string): Promise<string[]> {
    try {
      return (await readFile(join(runDir, "events.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { type: string }).type);
    } catch {
      return [];
    }
  }

  async function lockExists(lockPath: string): Promise<boolean> {
    try {
      await stat(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  // devShift 0 is the must-hit control arm: the SAME wrapper, the same extra call, no shift. Its
  // job is to prove the wrapper itself is not what makes release() refuse.
  async function claimWithShiftedLockDevice(
    runDir: string,
    devShift: number,
  ): Promise<{ outcome: string; shifted: number }> {
    const lockPath = join(runDir, ".owner-transfer.lock");
    let shifted = 0;

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        // Narrow on purpose: `stat` has exactly one caller in src/ (the identity check itself), and
        // it passes a plain path. The returned object keeps the real Stats prototype and every real
        // field — only `dev` moves — so nothing downstream can tell it apart from a genuine stat of
        // a file that lives on another device.
        stat: async (path: string) => {
          const real = await actual.stat(path);

          if (path !== lockPath) {
            return real;
          }

          shifted += 1;
          const relocated = Object.assign(Object.create(Object.getPrototypeOf(real) as object), real) as typeof real;
          relocated.dev = real.dev + devShift;
          return relocated;
        },
      };
    });

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      const outcome = await fileStore
        .claimOwnerRecordWithPrecondition(runDir, ownerRecord(), ownerRecord({ currentProcessInstanceId: "pid:222" }))
        .then(() => "completed", (error: unknown) => `threw ${String(error)}`);

      return { outcome, shifted };
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  }

  it("refuses to delete a lock whose inode number matches but whose device does not", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const lockPath = join(runDir, ".owner-transfer.lock");
    await writeOwnerRecord(runDir, ownerRecord());

    const { outcome, shifted } = await claimWithShiftedLockDevice(runDir, 1);

    // Anti-vacuity: one identity check happens per release, so the injection must have fired
    // exactly once. A seam that stopped matching the lock path would make the rest pass on a file
    // that was never relocated at all.
    expect(shifted).toBe(1);

    // The requirement. Under the review's mutation F — `ino` compared, `dev` dropped — the inode
    // number still matches and this reads { lockKept: false, events: [] }.
    expect({ outcome, lockKept: await lockExists(lockPath), events: await readEventTypes(runDir) }).toEqual({
      outcome: "completed",
      lockKept: true,
      events: ["owner_transfer_lock_release_skipped"],
    });
  });

  it("still deletes its own lock when the same wrapper leaves the device alone", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const lockPath = join(runDir, ".owner-transfer.lock");
    await writeOwnerRecord(runDir, ownerRecord());

    const { outcome, shifted } = await claimWithShiftedLockDevice(runDir, 0);

    // The must-hit half: same wrapper, same extra stat, shift of zero. Without this arm, the test
    // above is equally satisfied by a release() that refuses everything, and by a wrapper that
    // corrupts the Stats object in some way unrelated to `dev`.
    expect({ shifted, outcome, lockKept: await lockExists(lockPath), events: await readEventTypes(runDir) }).toEqual({
      shifted: 1,
      outcome: "completed",
      lockKept: false,
      events: [],
    });
  });
});

// M-2: the refusal event's `detail` was one sentence for every branch, and in the branch where the
// lock path has no file at all it claimed the lock was "left in place" — a false statement written
// into an audit line, whose entire value is that it can be believed. The detail is now per-branch.
//
// WHY THIS BRANCH STILL RECORDS AN EVENT AT ALL, since that is a semantic question and not a
// wording one: ruling 62 says the check failing "including cannot be read" is recorded, and this is
// the cannot-be-read case. It also earns its line — a lock that has vanished while this process was
// holding it means something removed a live holder's lock, which is the very shape C-1 is about.
// Recording it was not changed here; only the sentence was.
describe("the owner-transfer lock's release reports a vanished lock as vanished, not as left in place", () => {
  async function readEvents(runDir: string): Promise<Array<{ type: string; detail: string }>> {
    try {
      return (await readFile(join(runDir, "events.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { type: string; detail: string });
    } catch {
      return [];
    }
  }

  it("records that nothing was deleted, and never claims the lock was left in place", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const lockPath = join(runDir, ".owner-transfer.lock");
    const ownerRecordPath = join(runDir, "owner-record.json");
    await writeOwnerRecord(runDir, ownerRecord());
    let removals = 0;

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        // The same seam the steal test uses, minus the republish: the lock is removed and NOTHING
        // takes its place, so release() finds ENOENT rather than a foreign inode.
        rename: async (...args: Parameters<typeof actual.rename>) => {
          const result = await actual.rename(...args);

          if (String(args[1]) === ownerRecordPath) {
            await actual.unlink(lockPath);
            removals += 1;
          }

          return result;
        },
      };
    });

    let outcome: string;

    try {
      const fileStore = await import("../../src/persistence/fileStore.js");
      outcome = await fileStore
        .claimOwnerRecordWithPrecondition(runDir, ownerRecord(), ownerRecord({ currentProcessInstanceId: "pid:222" }))
        .then(() => "completed", (error: unknown) => `threw ${String(error)}`);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    // Anti-vacuity, and the fixture's own premise: the lock really was removed mid-span, and it
    // really is absent when release() runs.
    expect({ removals, lockPresent: await lockExists(lockPath) }).toEqual({ removals: 1, lockPresent: false });

    // The requirement. The old single-sentence detail read
    // "... no longer holds the inode this process published; left in place" here, which is false
    // twice over: nothing holds that path, and nothing was left in place.
    expect({ outcome, events: await readEvents(runDir) }).toEqual({
      outcome: "completed",
      events: [
        {
          type: "owner_transfer_lock_release_skipped",
          at: expect.any(String) as unknown as string,
          detail: ".owner-transfer.lock was already off disk at release; nothing was deleted",
        },
      ],
    });
  });

  async function lockExists(lockPath: string): Promise<boolean> {
    try {
      await stat(lockPath);
      return true;
    } catch {
      return false;
    }
  }
});

describe("claimOwnerRecordWithPrecondition", () => {
  it("writes the next record when the precondition matches", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    const current = ownerRecord();
    await writeOwnerRecord(runDir, current);
    const next = ownerRecord({ currentProcessInstanceId: "pid:222", lastAffirmedAt: "2026-07-25T01:00:00.000Z" });
    await claimOwnerRecordWithPrecondition(runDir, current, next);
    expect(await readOwnerRecord(runDir)).toEqual(next);
  });

  it("throws and leaves the record untouched when the precondition fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    const persisted = ownerRecord({ currentOwnerEpoch: 3 });
    await writeOwnerRecord(runDir, persisted);
    const stale = ownerRecord({ currentOwnerEpoch: 2 });
    const next = ownerRecord({ currentOwnerEpoch: 2, currentProcessInstanceId: "pid:222" });
    await expect(claimOwnerRecordWithPrecondition(runDir, stale, next)).rejects.toBeInstanceOf(OwnerTransferPreconditionError);
    expect(await readOwnerRecord(runDir)).toEqual(persisted);
  });
});

// Task 3 / phase 1 (2026-08-09): recoverInterruptedOwnerTransfer's unlocked branch used to be
// "probe the lock -> maybe delete it -> finalize without holding it" (G0). Two readOwnerRecord
// calls racing on the same marker could both reach finalizePendingOwnerTransfer unsynchronized,
// each writing the transaction's three fixed temp names, producing a torn or hybrid publish.
// Phase 1 changed the branch to "acquire the lock -> finalize while holding it -> release", so
// the second reader must now observe a busy lock and return without writing, instead of racing.
//
// Node is single-threaded, so this cannot be a genuine OS-level race between two processes; the
// interleaving has to be forced deterministically, or the assertion would only be checking
// whatever order the two promises happened to settle in (self-fulfilling). This uses the same
// vi.doMock("node:fs/promises", ...) + dynamic import seam the crash-gap matrix above already
// uses for fault injection (see crashOwnerTransferAtStep) — here it is used to pause reader A
// immediately after it has written real, complete lock-file content (so reader B's later
// open(lockPath, "wx") gets a genuine EEXIST from the OS, never a zero-length-lock-window read),
// and to hold A there until reader B's own failed-acquire attempt has actually happened. No
// production code is touched; the seam only observes/delays real fs calls the production code
// already makes.
describe("recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker", () => {
  it(
    "lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other returns without writing",
    async () => {
      const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
      const initialOwnerRecord = {
        runId: "task-1",
        logicalSessionId: "task-1/session-1",
        currentOwnerEpoch: 1,
        currentProcessInstanceId: "pid:12345",
        lastAffirmedAt: "2026-07-22T10:00:00.000Z",
        ownerStatus: "current" as const,
        supersededByEpoch: null,
        leaseAffirmedAt: null,
      };
      const transfer = applyOwnerEpochTransfer(
        initialOwnerRecord,
        "pid:67890",
        "2026-07-22T10:05:00.000Z",
        "owner lost after reconciliation",
      );

      // Shared with the rename-count invariant asserted after Promise.all below, so that number is
      // derived from the same source as the marker fixture, not a bare magic number:
      // finalizePendingOwnerTransfer performs exactly one rename per finalizeOrder entry, once per
      // invocation, so renameCount after both readers settle is proof of *how many times finalize
      // ran in total* -- finalizeOrder.length means exactly once; double that (or a thrown ENOENT
      // from a second finalizer hitting pendings the first already deleted) would mean two
      // finalizers raced.
      const finalizeOrder = ["owner-transfer.json", "owner-record.json"];

      await writeOwnerRecord(runDir, initialOwnerRecord);
      await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
      await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
      await writeFile(
        join(runDir, ".owner-transfer.transaction.json"),
        JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder }, null, 2),
      );
      // Deliberately no lock file: this is the unlocked (G0) shape both readers start from.

      let aOpenedLock = false;
      let renameCount = 0;
      const aLockWritten = createDeferred<void>();
      const bAttemptedAcquire = createDeferred<void>();

      vi.resetModules();
      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

        return {
          ...actual,
          // Reader A is paused immediately after its lock is PUBLISHED, so B meets a lock that is
          // on disk with complete content. Human ruling 50 changed how that publish happens, and
          // this hook followed it; the original hook and its reasoning are quoted below rather than
          // deleted, because this repository does not silently overwrite what it once did.
          //
          // ORIGINAL HOOK (until the C-1 fix): it wrapped `open`, matched `.owner-transfer.lock`,
          // and patched that one FileHandle's `writeFile`, with this verbatim reasoning:
          //   "Patches only this one FileHandle instance (reader A's), not the module or any
          //    other test. Runs the real write first so the lock file has full, valid JSON
          //    content on disk before reader B ever gets a chance to look at it -- otherwise B
          //    could observe the (unrelated, already-known) zero-length lock window instead of
          //    the busy-lock path this test targets."
          //
          // *** ERRATUM 1 (kept from the previous round, CORRECTED here per the independent
          // review's Low-1). The word "unrelated" in that sentence is FALSE, and — this is the
          // correction — it was ALREADY FALSE THE MOMENT IT WAS WRITTEN. The earlier erratum said
          // "false AFTER D2", which wrongly suggests D2 introduced the window; it did not. The
          // zero-byte window was an inherent property of the two-step publish
          // (`open(lockPath,"wx")` then `handle.writeFile`) for as long as that shape existed. The
          // window is the counter-example to this test's own subject: an intruder that hit it
          // landed in tryRecoverStaleOwnerTransferLock's `catch` branch, which never calls
          // isProcessActive and unlinks a LIVE holder's lock whenever staged artifacts exist. ***
          //
          // *** ERRATUM 2 (this round). That window is now CLOSED: under human ruling 50 the lock
          // is published atomically with `link()`, so there is no instant at which the lock exists
          // unparseable, and the fixture no longer has to steer B away from anything — B cannot
          // reach the window through the production publish at all. Measured, not assumed:
          // cross-process lost updates in the hundreds per 5s run before the fix, zero after
          // (.superpowers/sdd/2026-08-07-pkg2-data-loss/probe-c1/; the absolute counts vary with run
          // length and machine, the difference between arms does not). What is STILL open is the other
          // half of C-1 — the `catch` branch itself, which is open point B and was not touched, and
          // which an externally corrupted lock still reaches. ***
          //
          // *** ERRATUM 3 (point B, HUMAN RULING 83). ERRATUM 1 and ERRATUM 2 are kept verbatim as
          // history; both are now out of date in the same place. That `catch` branch HAS been
          // touched: it returns false without asking about staged artifacts, so it no longer "never
          // calls isProcessActive and unlinks a LIVE holder's lock", and it is no longer "the other
          // half of C-1 … still open". Both halves of C-1 are repaired — ruling 50's atomic publish
          // and ruling 83's fail-closed exits. C-1 is still NOT recorded as closed: an independent
          // review of point B found ruling 83's second exit had shipped with no test, and that gap
          // was filled separately. An externally corrupted lock still reaches the branch; what has
          // changed is that the branch now refuses it instead of stealing it. ***
          //
          // The hook had to move because it instrumented the very call ruling 50 replaced: with the
          // atomic publish, nothing ever calls `open` on the lock path, so the old hook would never
          // fire and this test would fail on its own named timeout while the invariant it guards
          // was still perfectly true. Every assertion below is UNCHANGED, and so is the instant
          // being forced: A is released only after B's failed acquire, with a complete lock on disk.
          link: async (...args: Parameters<typeof actual.link>) => {
            const result = await actual.link(...args);

            if (!aOpenedLock && String(args[1]).endsWith(".owner-transfer.lock")) {
              aOpenedLock = true;
              aLockWritten.resolve();
              await bAttemptedAcquire.promise;
            }

            return result;
          },
          readFile: async (...args: Parameters<typeof actual.readFile>) => {
            const result = await actual.readFile(...args);

            if (String(args[0]).endsWith(".owner-transfer.lock")) {
              // Reader B only ever reads the lock file from inside tryRecoverStaleOwnerTransferLock,
              // which runs exactly when its own open(lockPath, "wx") lost the EEXIST race -- i.e.
              // this fires once B's failed-acquire attempt has actually happened.
              // *** ERRATUM (M-4, HUMAN RULING 104): kept verbatim. `open(lockPath, "wx")` names
              // the publish shape human ruling 50 replaced. Production stages with
              // `open(stagingPath, "w")` and publishes with `link(staging, lockPath)`, and the
              // only `await open` in fileStore.ts is that staging one — which is what the note
              // twenty lines above already says. Read "lost the EEXIST race" as the link's
              // EEXIST. The instant being forced and every assertion below are unchanged. ***
              bAttemptedAcquire.resolve();
            }

            return result;
          },
          rename: async (...args: Parameters<typeof actual.rename>) => {
            renameCount += 1;
            return actual.rename(...args);
          },
        };
      });

      try {
        const fileStore = await import("../../src/persistence/fileStore.js");

        const aPromise = fileStore.readOwnerRecord(runDir);
        // Named timeout, well under vitest's 5000ms default: if reader A never reaches the point
        // where it has opened and written the lock file, that means the unlocked branch is not
        // acquiring a lock at all (e.g. reverted to the pre-phase-1 "probe -> maybe delete ->
        // finalize unlocked" shape) -- surface that as the failure, not a bare
        // "Test timed out in 5000ms" that names no invariant and reads like an unrelated flake.
        await withNamedTimeout(
          aLockWritten.promise,
          3000,
          "reader A never published the owner-transfer lock within 3000ms -- TWO regressions can "
            + "produce this and the message names both: (a) the unlocked branch is not acquiring a "
            + "lock before finalizing (recoverInterruptedOwnerTransfer's !lockHeld branch may have "
            + "regressed to the pre-phase-1 unlocked-finalize shape), or (b) the lock's atomic "
            + "publish has been reverted to the two-step open+write shape, in which case this hook "
            + "-- which waits on link() -- never fires even though the lock is being taken",
        );
        const bPromise = fileStore.readOwnerRecord(runDir);

        const [ownerFromA, ownerFromB] = await Promise.all([aPromise, bPromise]);

        // Reader A is the one paused-then-released by the gates above, so it is deterministically
        // the one that finalizes.
        expect(ownerFromA.currentOwnerEpoch).toBe(2);
        expect(ownerFromA.currentProcessInstanceId).toBe("pid:67890");
        // Reader B is deterministically forced to attempt its acquire while A's lock is still held
        // with real content, so it deterministically loses the acquire race and never calls
        // finalizePendingOwnerTransfer itself. What is NOT deterministic is how soon after that its
        // own plain read of owner-record.json happens relative to A's finalize -- both process pairs
        // this can legitimately return (the pre-transfer record, or the one A just published) are
        // correct outcomes of the busy-return path. Pinning one specific value here would be pinning
        // accidental scheduling, not the invariant (see task-3-impl-report.md, fix loop 1,
        // Important-1) -- the invariant this test exists to prove is asserted below instead, via a
        // count of how many times finalize actually ran.
        expect(ownerFromB.runId).toBe("task-1");
        expect([1, 2]).toContain(ownerFromB.currentOwnerEpoch);

        // The invariant: finalize ran exactly once across both concurrent calls, not twice (which
        // would mean both readers reached finalizePendingOwnerTransfer and either produced a torn
        // publish or one crashed reading pendings the other already deleted).
        expect(renameCount).toBe(finalizeOrder.length);

        // The transaction was published exactly once: no torn or duplicate publish from two
        // finalizers racing on the fixed owner-transfer / owner-record temp names.
        const publishedTransfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
          priorOwnerEpoch: number;
          newOwnerEpoch: number;
          newProcessInstanceId: string;
        };
        expect(publishedTransfer).toMatchObject({ priorOwnerEpoch: 1, newOwnerEpoch: 2, newProcessInstanceId: "pid:67890" });

        // No leftover marker, pendings, or lock: B never wrote, and A's lock was released.
        await expect(readFile(join(runDir, ".owner-transfer.transaction.json"), "utf8")).rejects.toThrow();
        await expect(readFile(join(runDir, ".owner-transfer.pending.json"), "utf8")).rejects.toThrow();
        await expect(readFile(join(runDir, ".owner-record.pending.json"), "utf8")).rejects.toThrow();
        await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }
    },
  );
});

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Turns a stuck gate into a message that names the invariant it was waiting on, instead of
// vitest's generic "Test timed out in 5000ms" -- which on its own tells a future maintainer
// nothing about which guarantee broke and reads exactly like an unrelated flake. `ms` must stay
// well under vitest's 5000ms default per-test timeout so this message wins the race.
function withNamedTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

describe("strict persisted-artifact readers", () => {
  it("reads a persisted run state", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    const state = {
      status: "executing", currentAttempt: 2, attemptsUsed: 2,
      lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false,
      stopReason: null,
      budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 1000, tokenBudgetRemaining: 500 },
      recentFailures: [],
    };
    await writeFile(join(runDir, "loop-state.json"), JSON.stringify(state));
    expect(await readRunState(runDir)).toEqual(state);
  });

  it("throws when loop-state.json is missing", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    await expect(readRunState(runDir)).rejects.toThrow();
  });

  it("throws when owner-transfer.json is unparseable", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    await writeFile(join(runDir, "owner-transfer.json"), "{ not json");
    await expect(readOwnerTransferRecord(runDir)).rejects.toThrow();
  });

  it("reads a persisted reconciliation record", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    const rec = {
      staleSuspicionBasis: [], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute", conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "ok" },
      priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true,
    };
    await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify(rec));
    expect(await readReconciliationRecord(runDir)).toEqual(rec);
  });
});

// buildAtomicTempPath is exported purely so these four properties can be asserted directly
// (design §3). Requirement R3 of the design (§7.2) is the uniqueness one: two concurrent
// writers must never pick the same temp name, because a shared fixed temp name would
// reintroduce exactly the torn publish that temp+rename is meant to remove (§4.1).
describe("buildAtomicTempPath", () => {
  it("returns a different path on two consecutive calls for the same target path", () => {
    const target = join(tmpdir(), "ccloop-fs-temp-path", "loop-state.json");

    // Not a pure function by design (§3): uniqueness per call is the whole point, so a
    // pure function of targetPath cannot satisfy this.
    expect(buildAtomicTempPath(target)).not.toBe(buildAtomicTempPath(target));
  });

  // Scope of this test, stated narrowly on purpose: it proves the process id and this
  // process's start time each sit at one fixed position in the name, ahead of the sequence
  // number. It does NOT prove that two processes cannot collide — that needs two processes.
  //
  // Both segments are taken from buildProcessInstanceId() rather than recomputed here, and
  // the start-time segment is pinned to that exact value rather than matched as `\d+`. Two
  // reasons:
  //
  //   - `\d+` cannot tell a start time from any other run of digits, so it leaves the
  //     anti-PID-recycling component with no coverage at all: replacing it with 0, with a
  //     literal, or with a second copy of the pid would keep this test green.
  //   - fileStore.ts and processIdentity.ts derive that component independently from the
  //     same reasoning, joined only by a comment. Asserting across the two modules is what
  //     makes either side changing the pid or start-time components a test failure rather
  //     than a silent divergence. Scoped deliberately: drift that leaves both components
  //     where they are — a renamed prefix, or an extra trailing segment on the instance id —
  //     does NOT fail this test, and was measured not to.
  //
  // Anchoring at both ends also matters. `toContain(String(process.pid))` is position-blind:
  // it passes whenever the digits occur anywhere, including inside the start-time or sequence
  // segments, so whether it kills a dropped-pid mutation is a matter of digit coincidence
  // rather than of the property being tested.
  it("puts this process's id and start time at fixed positions in the temp file name", () => {
    const target = join(tmpdir(), "ccloop-fs-temp-path", "loop-state.json");
    const [, pid, startTime] = buildProcessInstanceId().split(":");

    // Fails loudly here, rather than through an "undefined" in the regex below, if
    // processIdentity.ts ever stops emitting `pid:<pid>:<start time>`.
    expect(startTime).toMatch(/^\d+$/);
    expect(basename(buildAtomicTempPath(target))).toMatch(
      new RegExp(String.raw`^\.loop-state\.json\.${pid}\.${startTime}\.\d+\.tmp$`),
    );
  });

  it("places the temp file in the same directory as the target so rename cannot cross a filesystem", () => {
    const target = join(tmpdir(), "ccloop-fs-temp-path", "loop-state.json");

    expect(dirname(buildAtomicTempPath(target))).toBe(dirname(target));
  });

  // §4.1 last paragraph: the owner-transfer transaction locates and cleans up its staged
  // files by these *fixed* names. Handing one of them out here would let an unlocked
  // independent write be mistaken for transaction staging, and crash recovery would act on
  // it. The names are spelled out because getOwnerTransferPaths is module-private; the same
  // literals are already used by the transfer fixtures earlier in this file.
  it("never returns a path used by the owner-transfer transaction", () => {
    const runDir = join(tmpdir(), "ccloop-fs-temp-path");
    const ownerTransferPaths = [
      "owner-record.json",
      "owner-transfer.json",
      ".owner-record.publish.tmp",
      ".owner-transfer.publish.tmp",
      ".owner-record.pending.json",
      ".owner-transfer.pending.json",
      ".owner-transfer.transaction.json",
      ".owner-transfer.lock",
    ].map((file) => join(runDir, file));

    for (const target of [join(runDir, "owner-record.json"), join(runDir, "loop-state.json")]) {
      for (let i = 0; i < 3; i += 1) {
        expect(ownerTransferPaths).not.toContain(buildAtomicTempPath(target));
      }
    }
  });
});

// The four tests above call buildAtomicTempPath directly, so they cover the generator and
// nothing else. Nothing in them observes the path the production write actually stages at, and
// a helper that ignored the generator entirely would keep them all green: replacing the
// tempPath line in writeJsonFileAtomically with a fixed per-target
// `.${basename(path)}.publish.tmp` was measured to leave every other test in the repository
// passing — 441 of 443 AS MEASURED WHEN THE SUITE HAD 443 TESTS, the two failures being
  // the two below. The denominator is a historical record, not a live count: the suite has
  // grown since. Re-run the mutation rather than trusting either number. That fixed
// name is the specific failure §4.1 names as this design's core risk — writeRunState takes no
// lock, so two processes sharing one staging name would let one publish the other's bytes.
//
// These two tests observe the staging path through the production entry point instead, with no
// mock: §7 prefers real means, and real means reach here. buildAtomicTempPath hands out a
// monotonic sequence, so the path its *next* call returns is derivable from the one it just
// returned. A directory planted there is only reachable if production stages at exactly that
// path.
describe("writeJsonFileAtomically's staging file, observed through the production write path", () => {
  // Advances the sequence segment of a temp path by one. The rule is checked against a real
  // subsequent call in plantDirectoryAtNextStagingPath below rather than trusted, so a change
  // to the temp-name shape fails loudly there instead of quietly planting the directory on a
  // path production never touches.
  const predictNextTempPath = (tempPath: string): string => {
    const segments = tempPath.split(".");
    segments[segments.length - 2] = String(Number(segments[segments.length - 2]) + 1);
    return segments.join(".");
  };

  async function plantDirectoryAtNextStagingPath(runDir: string): Promise<string> {
    const scratch = join(runDir, "scratch.json");

    // The prediction rule, executed rather than assumed: the derived successor of one call has
    // to equal what the very next call returns.
    expect(predictNextTempPath(buildAtomicTempPath(scratch))).toBe(buildAtomicTempPath(scratch));

    const stagingPath = predictNextTempPath(buildAtomicTempPath(join(runDir, "loop-state.json")));
    await mkdir(stagingPath);
    return stagingPath;
  }

  it("is created at the path buildAtomicTempPath hands out, not at a name of the write helper's own", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-wiring-"));
    await plantDirectoryAtNextStagingPath(runDir);

    // EISDIR here comes from the staging writeFile, not from rename: loop-state.json does not
    // exist yet, so there is nothing at the target for rename to collide with. A helper that
    // staged under any other name would have written and published it instead, which is what
    // the second assertion pins.
    await expect(writeRunState(runDir, state)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(stat(join(runDir, "loop-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // §3.1 item 3. The catch in writeJsonFileAtomically cleans up with a bare try/unlink/catch and
  // deliberately not with safeUnlink, because safeUnlink rethrows anything that is not ENOENT
  // and would then replace the error the caller has to see. Only a scenario where the cleanup
  // itself fails separates the two, and the planted directory is one: writeFile fails EISDIR and
  // unlink fails EPERM. Both errnos are asserted below rather than asserted-by-comment.
  it("has its cleanup failure swallowed, so the staging write's error reaches the caller unreplaced", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-cleanup-"));
    const stagingPath = await plantDirectoryAtNextStagingPath(runDir);

    await expect(writeRunState(runDir, state)).rejects.toMatchObject({ code: "EISDIR" });

    // The cleanup could not have succeeded: its target is still there. Substituting safeUnlink
    // for the bare catch propagates this unlink's errno instead of the EISDIR asserted above.
    expect((await lstat(stagingPath)).isDirectory()).toBe(true);
    await expect(unlink(stagingPath)).rejects.toMatchObject({ code: "EPERM" });
  });
});

// loop-state.json has two writers — initializeRunFiles creates it, writeRunState rewrites it
// on every state transition — and it is both a RUN_MARKER_FILE and one of the three files L2
// observes field by field, so `ccloop ls` can be reading it at any moment, including while a
// run is initializing (design §2.1). Both writers therefore have to publish it the same way.
//
// Scope of this whole block, stated narrowly on purpose: these tests show that the target
// *path* is replaced rather than written through. They do NOT show that no intermediate state
// is ever observable to a concurrent reader — that is not deterministically provable on a real
// filesystem (§7.1) — and nothing here should be read as claiming it. Crash durability is
// likewise out of scope: this repository has no fsync anywhere (§3.1 item 6).
describe("loop-state.json is published by replacing the path, not by writing through it", () => {
  // R1 (§7.1). rename makes the name point at a new inode; writeFile on an existing file
  // truncates and rewrites the same one. That is the whole discriminator.
  it("gives loop-state.json a new inode when writeRunState overwrites it", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-state-"));
    const target = join(runDir, "loop-state.json");

    await writeRunState(runDir, state);
    const inodeBefore = (await stat(target)).ino;

    // Held open across the second write and not closed until after the assertion. rename frees
    // the inode of the file it replaces, and the filesystem is free to hand that same inode
    // number straight back to the next file created in this directory — which would make the
    // two inodes compare equal intermittently. An open descriptor pins the old inode so it
    // cannot be reused, which is what makes this comparison deterministic instead of flaky
    // (§7.1). Omitting it and then booking the intermittent red as a flake is exactly the
    // failure mode §7.1 calls out.
    const pinOldInode = await open(target, "r");
    try {
      await writeRunState(runDir, { ...state, status: "verifying", currentAttempt: 1 });

      expect((await stat(target)).ino).not.toBe(inodeBefore);
    } finally {
      await pinOldInode.close();
    }

    // Guard, not the point of the test: an inode change on a file that never received the new
    // state would prove nothing worth having.
    expect((await readRunState(runDir)).status).toBe("verifying");
  });

  // initializeRunFiles cannot use the write-twice-and-compare-inode shape: it runs
  // ensureFreshRunDir first, which refuses a directory that already contains a loop-state.json,
  // so the target can never pre-exist as a regular file and there is no old inode to replace.
  //
  // The discriminator used instead is a *dangling* symlink at the target path. ensureFreshRunDir
  // probes with access(), which follows the link and gets ENOENT, so the fresh-directory check
  // still passes — and the two candidate implementations then diverge observably:
  //
  //   - writeFile(path) opens through the symlink and creates the file it points at, leaving
  //     the symlink itself in place.
  //   - rename(temp, path) replaces the directory entry, so the symlink is gone and the path
  //     it pointed at was never created.
  //
  // Same property as the inode test above — the path was replaced, not written through — with
  // no inode-reuse hazard at all, since no inode is freed. It does lean on ensureFreshRunDir
  // probing with access() rather than lstat(); if that ever changes, this test goes red on
  // "runDir already contains prior run data" rather than passing for the wrong reason.
  it("replaces the loop-state.json path when initializeRunFiles creates it, never creating what that path pointed at", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-init-"));
    const target = join(runDir, "loop-state.json");
    const writtenThrough = join(runDir, "written-through.json");
    await symlink(writtenThrough, target);

    await initializeRunFiles(runDir, contract, state);

    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    await expect(stat(writtenThrough)).rejects.toMatchObject({ code: "ENOENT" });

    // Guard: the run state still has to be readable at the target path afterwards. This one
    // cannot discriminate on its own — reading follows a surviving symlink just as happily.
    expect(await readRunState(runDir)).toEqual(state);
  });

  // R4 (§7.2, §3.1 item 4). This branch changes only *how* loop-state.json is written, so the
  // bytes must stay exactly what the plain writeFile calls produced at both sites. Pinned to
  // the literal expression rather than to a parsed object, because a changed indent or key
  // order would otherwise surface later as unrelated tests failing for no visible reason.
  it("writes the same bytes from both writers as the plain writeFile calls they replaced", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-bytes-"));
    const target = join(runDir, "loop-state.json");

    await initializeRunFiles(runDir, contract, state);
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(state, null, 2));

    const advanced: RunState = { ...state, status: "verifying", currentAttempt: 1 };
    await writeRunState(runDir, advanced);
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(advanced, null, 2));
  });

  // R2, success half (§7.2). The staging file is an implementation detail; a stray
  // .loop-state.json.<pid>.<...>.tmp left in a run directory is a file the registry scanner
  // would then have to reason about. Asserted as the complete directory listing rather than by
  // filtering for names ending in .tmp, so a staging file under any other name fails too.
  it("leaves no staging file behind in the run directory after a successful write", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-residue-"));

    await initializeRunFiles(runDir, contract, state);
    await writeRunState(runDir, { ...state, status: "verifying", currentAttempt: 1 });

    expect((await readdir(runDir)).sort()).toEqual([
      "attempts",
      "events.jsonl",
      "loop-contract.json",
      "loop-state.json",
    ]);
  });

  // R2, failure half (§7.2). The failure is produced for real — a directory sitting at the
  // target path makes rename fail with EISDIR — rather than by mocking node:fs/promises, per
  // the §7 preference for real techniques. A real errno also carries the second half of the
  // requirement: cleanup runs inside that catch, and a cleanup failure replacing the caller's
  // error with its own is the specific way this path goes wrong (§3.1 item 3), so the test
  // pins which error comes out, not merely that one does.
  it("removes the staging file and rethrows the failure when the target path cannot be replaced", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-fail-"));
    await mkdir(join(runDir, "loop-state.json"));

    await expect(writeRunState(runDir, state)).rejects.toMatchObject({ code: "EISDIR" });

    expect(await readdir(runDir)).toEqual(["loop-state.json"]);
  });
});

// owner-record.json is the second of the three files L2 observes field by field, and
// `ccloop ls` can read it at any moment, so it has to be published the same way
// loop-state.json is (design §2.1).
//
// Scope of this block, stated as narrowly as the loop-state block above: these tests show the
// target *path* is replaced rather than written through. They do NOT show that no intermediate
// state is ever observable to a concurrent reader — not deterministically provable on a real
// filesystem (§7.1) — and they say nothing about crash durability, since this repository has
// no fsync anywhere (§3.1 item 6).
describe("owner-record.json is published by replacing the path, not by writing through it", () => {
  const ownerRecord: OwnerRecord = {
    runId: "task-1",
    logicalSessionId: "task-1/session-1",
    currentOwnerEpoch: 1,
    currentProcessInstanceId: "pid:12345",
    lastAffirmedAt: "2026-07-22T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
  };

  // R1 (§7.1a). The sole production caller — `await writeOwnerRecord(runDir, ownerRecord);` in
  // runLoop.ts, just below the lease gate — runs after initializeRunFiles, so
  // the target *usually* does not pre-exist — and when it does not, rename and writeFile leave
  // identical end states, which is why the write-twice-and-compare-inode shape cannot be the
  // discriminator for the ordinary case (§7.1a).
  //
  // "Usually", not "always": the overwrite corner is reachable in production, and this was
  // measured rather than reasoned about. A run directory holding only owner-record.json gets
  // through both guards — ensureFreshRunDir's blocking list (fileStore.ts:52-56) does not
  // include owner-record.json, and checkRunLease answers no_lease for leaseAffirmedAt: null
  // (leaseGate.ts:38-42, the documented post-transfer state) without refusing. That run then
  // reaches this call with the file already there.
  //
  // No inode test is added for that corner anyway, and the reason is narrow: the overwrite
  // path here is delegated wholesale to writeJsonFileAtomically, and that helper's overwrite
  // behaviour is already pinned by the R1 inode test at the writeRunState call site above,
  // open-handle pin and all (§7.1). What is left unpinned by that argument is only this
  // wrapper's own choice of helper *in the overwrite corner specifically*: the test below pins
  // that choice for the create case only, so a wrapper that branched on whether the target
  // already exists would survive it. That residual is stated rather than covered — deliberately,
  // and it is the only thing an inode test here would add.
  //
  // The discriminator used instead is a *dangling* symlink at the target path:
  //
  //   - writeFile(path) opens through the symlink and creates the file it points at, leaving
  //     the symlink itself in place.
  //   - rename(temp, path) replaces the directory entry, so the symlink is gone and the path
  //     it pointed at was never created.
  //
  // Both halves are asserted, because either one alone is satisfiable for the wrong reason.
  //
  // Unlike the initializeRunFiles test above, this one carries no dependency on how freshness
  // is probed: writeOwnerRecord has no ensureFreshRunDir call in front of it, so nothing here
  // has to follow or refuse the dangling link before the write is attempted.
  it("replaces the owner-record.json path when writeOwnerRecord creates it, never creating what that path pointed at", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-owner-"));
    const target = join(runDir, "owner-record.json");
    const writtenThrough = join(runDir, "written-through.json");
    await symlink(writtenThrough, target);

    await writeOwnerRecord(runDir, ownerRecord);

    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    await expect(stat(writtenThrough)).rejects.toMatchObject({ code: "ENOENT" });

    // Guard: the record still has to be readable at the target path afterwards. This cannot
    // discriminate on its own — reading follows a surviving symlink just as happily.
    expect(await readOwnerRecord(runDir)).toEqual(ownerRecord);
  });

  // R4 (§7.2, §3.1 item 4). This branch changes only *how* owner-record.json is written, so the
  // bytes must stay exactly what the plain writeFile call produced. Pinned to the literal
  // expression rather than to a parsed object, because a changed indent or key order would
  // otherwise surface later as unrelated tests failing for no visible reason.
  it("writes the same bytes as the plain writeFile call it replaced", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-owner-bytes-"));

    await writeOwnerRecord(runDir, ownerRecord);

    expect(await readFile(join(runDir, "owner-record.json"), "utf8")).toBe(
      JSON.stringify(ownerRecord, null, 2),
    );
  });
});

// writeBoundaryArtifacts writes two separate files, and each is pinned separately below.
//
// What these tests do NOT show, stated first because it is the easiest thing to read into them:
// the two files do not become atomic *with respect to each other*. After both writes go through
// rename individually, a reader can still observe boundary-analysis.json already replaced while
// reconciliation-record.json still holds its previous content — the gap between the two renames
// is untouched by this branch, and closing it belongs to debt 1 / L3 (design §4.3, §10 item 1).
//
// Scope is otherwise the same as the two blocks above: these tests show that each target *path*
// is replaced rather than written through. They do NOT show that no intermediate state is ever
// observable within a single file — not deterministically provable on a real filesystem (§7.1) —
// and they say nothing about crash durability, since this repository has no fsync anywhere
// (§3.1 item 6).
//
// The inode discriminator of §7.1 is the one that applies to both writers here, rather than the
// dangling-symlink discriminator of §7.1a, and the reason is that a pre-existing target is
// reachable at both of them:
//
//   - writeBoundaryArtifacts has no ensureFreshRunDir or any other guard in front of either
//     write, so nothing refuses a run directory that already holds these files.
//   - reconciliation-record.json pre-existing is not a corner but the case the function is built
//     around: preserveSuccessfulReconciliationIfNeeded reads the persisted record back before
//     the second write, which is what the "preserves a successful reconciliation record when a
//     loser later tries to downgrade it" test earlier in this file exercises — by calling
//     writeBoundaryArtifacts twice against one run directory. boundary-analysis.json is written
//     unconditionally on that same second call, so it is overwritten there too.
//
// Both fixtures below therefore write twice and compare inodes, which is the stronger of the two
// discriminators: unlike the symlink one it also kills an implementation that branched on
// whether the target already exists (§7.1a, "已知残留").
describe("writeBoundaryArtifacts publishes each of its two files by replacing the path, not by writing through it", () => {
  const boundaryAnalysis: RunBoundaryAnalysis = {
    status: "stale_candidate",
    strongProgressAt: "2026-07-21T10:00:00.000Z",
    weakProgressAt: "2026-07-21T10:05:00.000Z",
    suspectReason: "healthy window exceeded",
    staleCandidateReason: "continuity evidence missing",
  };

  // The fixtures below exercise the write itself, not the preservation decision in front of it —
  // that decision is "whether / what to write", which this branch does not touch. What makes that
  // true is the fixture directory rather than this flag: it contains no owner-record.json and no
  // owner-transfer.json, so readPersistedSuccessfulTransferArtifacts returns
  // { kind: "no_published_transfer" } and preserveSuccessfulReconciliationIfNeeded hands back the
  // record it was passed, wrapped as { kind: "write" }. The
  // eligibleForContinuation: true early return short-circuits to that same value, so the two
  // paths agree here and neither is load-bearing on its own: deleting that early return from
  // preserveSuccessfulReconciliationIfNeeded leaves all 53 tests in this file green.
  const reconciliationRecord: ReconciliationRecord = {
    staleSuspicionBasis: ["continuity evidence missing"],
    staleConfirmed: true,
    ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute",
    conflictingEvidence: [],
    takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
    priorOwnerEpoch: 1,
    newOwnerEpoch: 2,
    eligibleForContinuation: true,
  };

  // R1 (§7.1). rename makes the name point at a new inode; writeFile on an existing file
  // truncates and rewrites the same one. That is the whole discriminator.
  //
  // No reconciliationRecord is passed, so this test can only be answered by the
  // boundary-analysis.json write — the conditional second write never runs.
  it("gives boundary-analysis.json a new inode when writeBoundaryArtifacts overwrites it", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-boundary-"));
    const target = join(runDir, "boundary-analysis.json");

    await writeBoundaryArtifacts(runDir, { boundaryAnalysis });
    const inodeBefore = (await stat(target)).ino;

    // Held open across the second write and not closed until after the assertion. rename frees
    // the inode of the file it replaces, and the filesystem is free to hand that same inode
    // number straight back to the next file created in this directory — which would make the
    // two inodes compare equal intermittently. An open descriptor pins the old inode so it
    // cannot be reused, which is what makes this comparison deterministic instead of flaky
    // (§7.1).
    const pinOldInode = await open(target, "r");
    try {
      await writeBoundaryArtifacts(runDir, {
        boundaryAnalysis: { ...boundaryAnalysis, status: "stale_confirmed" },
      });

      expect((await stat(target)).ino).not.toBe(inodeBefore);
    } finally {
      await pinOldInode.close();
    }

    // Guard, not the point of the test: an inode change on a file that never received the new
    // analysis would prove nothing worth having.
    expect(JSON.parse(await readFile(target, "utf8")).status).toBe("stale_confirmed");
  });

  // R1 (§7.1) for the conditional write. reconciliationRecord has to be supplied on both calls:
  // the first one is what makes the target pre-exist, and without it on the second the write
  // under test is skipped entirely rather than performed non-atomically.
  //
  // Only reconciliation-record.json's inode is asserted, so reverting the boundary-analysis.json
  // write to a plain writeFile cannot make this test pass or fail.
  it("gives reconciliation-record.json a new inode when writeBoundaryArtifacts overwrites it", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-reconciliation-"));
    const target = join(runDir, "reconciliation-record.json");

    await writeBoundaryArtifacts(runDir, { boundaryAnalysis, reconciliationRecord });
    const inodeBefore = (await stat(target)).ino;

    // Same open-handle pin, and for the same reason as the test above (§7.1).
    const pinOldInode = await open(target, "r");
    try {
      await writeBoundaryArtifacts(runDir, {
        boundaryAnalysis,
        reconciliationRecord: { ...reconciliationRecord, lastTrustedBoundary: "verify" },
      });

      expect((await stat(target)).ino).not.toBe(inodeBefore);
    } finally {
      await pinOldInode.close();
    }

    // Guard, not the point of the test, and not redundant with the inode assertion above: a new
    // inode proves the path was replaced, but says nothing about what replaced it. This pins the
    // content, so it kills an implementation that renames into place a temp built from the
    // persisted record instead of the one passed in — that mutation still changes the inode, so
    // it passes the assertion above and fails only here.
    expect((await readReconciliationRecord(runDir)).lastTrustedBoundary).toBe("verify");
  });

  // R4 (§7.2, §3.1 item 4). This branch changes only *how* these two files are written, so the
  // bytes must stay exactly what the plain writeFile calls produced at both sites. Pinned to the
  // literal expression rather than to a parsed object, because a changed indent or key order
  // would otherwise surface later as unrelated tests failing for no visible reason.
  it("writes the same bytes for both files as the plain writeFile calls they replaced", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-atomic-boundary-bytes-"));

    await writeBoundaryArtifacts(runDir, { boundaryAnalysis, reconciliationRecord });

    expect(await readFile(join(runDir, "boundary-analysis.json"), "utf8")).toBe(
      JSON.stringify(boundaryAnalysis, null, 2),
    );
    expect(await readFile(join(runDir, "reconciliation-record.json"), "utf8")).toBe(
      JSON.stringify(reconciliationRecord, null, 2),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// §10 test 2 / test 6b: the crash-gap matrix of the three-file owner-transfer transaction.
// ---------------------------------------------------------------------------------------------

const OWNER_TRANSFER_MARKER_FILE = ".owner-transfer.transaction.json";

// Order matters: it is finalizeOrder's order, so gaps 2/3/4 map onto the first, second and third
// pending read before finalizePendingOwnerTransfer's try.
const CRASH_PENDING_FILES = [
  ["T", ".owner-transfer.pending.json"],
  ["O", ".owner-record.pending.json"],
  ["R", ".reconciliation-record.pending.json"],
] as const;

const CRASH_GAP_COUNT = 17; // 4 reads before the try + 13 steps inside it

function crashContract(runDir: string): LoopContract {
  return {
    ...contract,
    // Deliberately absent: the gaps that get past the eligibility gate must not go on to do real
    // git work, and a path inside the run dir cannot collide with anything on the host.
    context: { ...contract.context, repoPath: join(runDir, "repo-that-does-not-exist") },
  };
}

function crashOwnerRecord(): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1/session-1",
    currentOwnerEpoch: 1,
    currentProcessInstanceId: "pid:12345",
    lastAffirmedAt: "2026-07-22T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
  };
}

function crashReconciliation(priorOwnerEpoch: number): ReconciliationRecord {
  return {
    staleSuspicionBasis: ["owner transfer already published"],
    staleConfirmed: true,
    ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute",
    conflictingEvidence: [],
    takeoverPermission: { allowed: true, reason: "strict owner-loss conditions satisfied" },
    priorOwnerEpoch,
    newOwnerEpoch: priorOwnerEpoch + 1,
    eligibleForContinuation: true,
  };
}

// Everything resumeLoop needs to get as far as the eligibility gate: a parseable contract, a
// resumable run state, and an events log. owner-record.json is written by the caller.
async function seedCrashRunDir(): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-crash-gap-"));
  await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(crashContract(runDir), null, 2));
  await writeFile(join(runDir, "events.jsonl"), "");
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify({
    status: "executing", currentAttempt: 1, attemptsUsed: 1,
    lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 2, timeRemainingMs: 5000, tokenBudgetRemaining: 1000 },
    recentFailures: [],
  }, null, 2));
  return runDir;
}

function crashError(): NodeJS.ErrnoException {
  // Deliberately not ENOENT: safeUnlink swallows ENOENT, so an ENOENT fault would be absorbed at
  // exactly the four unlink-only steps this matrix needs to reach.
  const error = new Error("simulated crash") as NodeJS.ErrnoException;
  error.code = "EIO";
  return error;
}

// Runs one owner transfer through the production write path with a fault armed at the given step
// of finalizePendingOwnerTransfer, and leaves the run dir in whatever state that produced.
//
// Step numbering starts at the marker's own publish rename: everything before that is staging,
// everything after is finalize. Step 1 is therefore the marker readFile, steps 2..4 the three
// pending readFiles, steps 5..17 the thirteen steps inside the try.
async function crashOwnerTransferAtStep(
  runDir: string,
  expectedOwnerRecord: OwnerRecord,
  nextOwnerRecord: OwnerRecord,
  transferRecord: OwnerTransferRecord,
  reconciliationRecord: ReconciliationRecord,
  faultAtStep: number,
): Promise<void> {
  let armed = false;
  let seen = 0;

  vi.resetModules();
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const isFaultStep = (): boolean => {
      if (!armed) {
        return false;
      }

      seen += 1;
      return seen === faultAtStep;
    };

    return {
      ...actual,
      readFile: async (...args: Parameters<typeof actual.readFile>) => {
        if (isFaultStep()) throw crashError();
        return actual.readFile(...args);
      },
      writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
        if (isFaultStep()) throw crashError();
        return actual.writeFile(...args);
      },
      unlink: async (...args: Parameters<typeof actual.unlink>) => {
        if (isFaultStep()) throw crashError();
        return actual.unlink(...args);
      },
      rename: async (...args: Parameters<typeof actual.rename>) => {
        if (armed && isFaultStep()) throw crashError();
        const result = await actual.rename(...args);
        if (!armed && basename(String(args[1])) === OWNER_TRANSFER_MARKER_FILE) {
          armed = true;
        }
        return result;
      },
    };
  });

  try {
    const fileStore = await import("../../src/persistence/fileStore.js");
    await expect(
      fileStore.writeOwnerTransferArtifacts(runDir, expectedOwnerRecord, nextOwnerRecord, transferRecord, reconciliationRecord),
    ).rejects.toThrow();
  } finally {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
}

// The four pre-try gaps are read+parse failures, and a mocked read leaves a perfectly staged
// transaction behind. So they are staged with the fault at step 1 (nothing on disk touched yet)
// and then given the disk state the corresponding read would actually have hit.
async function damageForPreTryGap(runDir: string, gap: number): Promise<void> {
  if (gap === 1) {
    await writeFile(join(runDir, OWNER_TRANSFER_MARKER_FILE), "{ not json");
    return;
  }

  await unlink(join(runDir, CRASH_PENDING_FILES[gap - 2][1]));
}

// Fixture 1 of 2: owner-transfer.json has never existed. Epoch N -> N+1 crashes at `gap`.
async function stageFirstOwnerTransferCrashedAt(gap: number): Promise<string> {
  const runDir = await seedCrashRunDir();
  const initial = crashOwnerRecord();
  await writeOwnerRecord(runDir, initial);

  const transfer = applyOwnerEpochTransfer(initial, "pid:67890", "2026-07-22T10:05:00.000Z", "owner lost after reconciliation");
  await crashOwnerTransferAtStep(
    runDir, initial, transfer.nextOwnerRecord, transfer.transferRecord, crashReconciliation(1), gap <= 4 ? 1 : gap,
  );

  if (gap <= 4) {
    await damageForPreTryGap(runDir, gap);
  }

  return runDir;
}

// Fixture 2 of 2: epoch N -> N+1 has already published all three files; N+1 -> N+2 crashes at
// `gap`. This is the only shape in which the eligibility gate is reached mid-transaction at all,
// because owner-transfer.json and reconciliation-record.json are readable throughout.
async function stageDoubleOwnerTransferCrashedAt(gap: number): Promise<string> {
  const runDir = await seedCrashRunDir();
  const initial = crashOwnerRecord();
  await writeOwnerRecord(runDir, initial);

  const first = applyOwnerEpochTransfer(initial, "pid:67890", "2026-07-22T10:05:00.000Z", "owner lost after reconciliation");
  await writeOwnerTransferArtifacts(runDir, initial, first.nextOwnerRecord, first.transferRecord, crashReconciliation(1));

  const second = applyOwnerEpochTransfer(first.nextOwnerRecord, "pid:99999", "2026-07-22T10:10:00.000Z", "owner lost again");
  await crashOwnerTransferAtStep(
    runDir, first.nextOwnerRecord, second.nextOwnerRecord, second.transferRecord, crashReconciliation(2), gap <= 4 ? 1 : gap,
  );

  if (gap <= 4) {
    await damageForPreTryGap(runDir, gap);
  }

  return runDir;
}

// "Not published yet" and "published but torn" are different facts and must never render as the
// same string. Collapsing them is what makes this whole matrix blind to the single regression
// class the three-file transaction exists to prevent: swap a publish `rename` for a `writeFile`
// and a crash mid-write leaves a half-written owner-transfer.json, which a single flat catch
// would report as `T=absent` — exactly what gaps 5..7 of the first-transfer fixture already
// expect, so all 34 lines would stay green through the regression. No gap in this matrix
// produces `torn`; if one ever does, a publish stopped being atomic.
async function publishedEpoch(runDir: string, fileName: string, key: string): Promise<string> {
  let raw: string;

  try {
    raw = await readFile(join(runDir, fileName), "utf8");
  } catch {
    return "absent";
  }

  try {
    return `e${String((JSON.parse(raw) as Record<string, unknown>)[key])}`;
  } catch {
    return "torn";
  }
}

// One line describing everything the transaction can be observed to have done so far: which of
// the three files are published and at which epoch, whether the marker survives (and parses), and
// which of the three pendings are still on disk.
async function crashSnapshot(runDir: string): Promise<string> {
  const transfer = await publishedEpoch(runDir, "owner-transfer.json", "newOwnerEpoch");
  const owner = await publishedEpoch(runDir, "owner-record.json", "currentOwnerEpoch");
  const reconciliation = await publishedEpoch(runDir, "reconciliation-record.json", "newOwnerEpoch");

  let marker: string;
  try {
    const raw = await readFile(join(runDir, OWNER_TRANSFER_MARKER_FILE), "utf8");
    try {
      marker = `v${String((JSON.parse(raw) as { version: number }).version)}`;
    } catch {
      marker = "unparseable";
    }
  } catch {
    marker = "absent";
  }

  let pendings = "";
  for (const [letter, fileName] of CRASH_PENDING_FILES) {
    try {
      await stat(join(runDir, fileName));
      pendings += letter;
    } catch {
      pendings += "-";
    }
  }

  return `T=${transfer} O=${owner} R=${reconciliation} M=${marker} P=${pendings}`;
}

// Only the head of the reason is recorded for the read failures: which of the two absent files
// loses the Promise.all race is not something the transaction decides.
async function observeResume(runDir: string): Promise<string> {
  try {
    await resumeLoop(runDir, new ScriptedAdapter([]));
    return "accepted";
  } catch (error) {
    if (!(error instanceof ResumeNotEligibleError)) {
      return `unexpected ${(error as Error).name}`;
    }

    return error.message.startsWith("cannot read run artifacts")
      ? "refused: cannot read run artifacts"
      : `refused: ${error.message}`;
  }
}

// readOwnerRecord is recoverInterruptedOwnerTransfer's only unforced entry point, so this is what
// the next process does when it opens the run dir: finish the transaction where the marker
// survives, refuse loudly where the marker cannot be trusted, write nothing where it is gone.
async function observeRecovery(runDir: string): Promise<string> {
  try {
    await readOwnerRecord(runDir);
    return "ok";
  } catch (error) {
    return `throws ${(error as Error).name}`;
  }
}

// Both observations mutate the run dir (resume claims, recovery finalizes), so each gets its own
// freshly staged copy of the same gap.
async function observeCrashMatrix(stage: (gap: number) => Promise<string>): Promise<string[]> {
  const lines: string[] = [];

  for (let gap = 1; gap <= CRASH_GAP_COUNT; gap += 1) {
    const label = `gap ${String(gap).padStart(2, "0")}`;
    const forResume = await stage(gap);
    const staged = await crashSnapshot(forResume);
    const resume = await observeResume(forResume);

    const forRecovery = await stage(gap);
    const recovery = await observeRecovery(forRecovery);
    const after = await crashSnapshot(forRecovery);

    // afterResume is what the resume attempt ITSELF left on disk, and it is the enforcement the
    // scoped re-review's Imp-2 asked for: the `after` column below is taken from `forRecovery`, a
    // SECOND copy that only ever ran observeRecovery, so before this line nothing in the tree
    // pinned the state an accepted resume ends at. The justification for amending gaps 05..13
    // (human rulings 51/54) rests entirely on that state, and a justification with no guard is the
    // exact shape this repository keeps having to fix.
    //
    // Safe to assert as a fixed string: crashSnapshot renders only presence and epoch — which files
    // exist, which epoch each carries, whether the marker parses, which pendings remain. No
    // wall-clock field reaches it, so this cannot become a self-falsifying assertion the way a
    // lastAffirmedAt comparison would.
    lines.push(
      `${label} | ${staged} | resume=${resume} | afterResume ${await crashSnapshot(forResume)} `
        + `| recovery=${recovery} | after ${after}`,
    );
  }

  return lines;
}
