import { lstat, mkdir, mkdtemp, open, readdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  appendEvent,
  buildAtomicTempPath,
  claimOwnerRecordWithPrecondition,
  initializeRunFiles,
  OwnerTransferLockBusyError,
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
import type { LoopContract } from "../../src/contract/schema.js";
import { applyOwnerEpochTransfer } from "../../src/ownership/ownerController.js";
import { buildProcessInstanceId } from "../../src/runtime/processIdentity.js";
import type { RunBoundaryAnalysis, RunState } from "../../src/state/types.js";
import type { OwnerRecord, ReconciliationRecord } from "../../src/runtime/types.js";

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

  it("treats malformed lock contents with staged artifacts as stale and recoverable", async () => {
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

    expect(owner.currentOwnerEpoch).toBe(2);
    expect(owner.currentProcessInstanceId).toBe("pid:67890");
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
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

  it("treats malformed lock contents with staged artifacts as stale and recoverable", async () => {
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

    expect(owner.currentOwnerEpoch).toBe(2);
    expect(owner.currentProcessInstanceId).toBe("pid:67890");
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
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

  it("releases the lock after recovering malformed staged state", async () => {
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
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
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
});

function ownerRecord(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:111", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
    ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: null, ...overrides,
  };
}

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
  // owner-transfer.json, so readPersistedSuccessfulTransferArtifacts returns null and
  // preserveSuccessfulReconciliationIfNeeded hands back the record it was passed. The
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
