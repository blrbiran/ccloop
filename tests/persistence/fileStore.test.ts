import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  appendEvent,
  initializeRunFiles,
  OwnerTransferPreconditionError,
  readOwnerRecord,
  writeAttemptArtifacts,
  writeBoundaryArtifacts,
  writeOwnerRecord,
  writeOwnerTransferArtifacts,
  writeOwnerTransferRecord,
  writeRunState,
} from "../../src/persistence/fileStore.js";
import type { LoopContract } from "../../src/contract/schema.js";
import { applyOwnerEpochTransfer } from "../../src/ownership/ownerController.js";
import type { RunState } from "../../src/state/types.js";

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

    await expect(
      writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
    ).rejects.toBeInstanceOf(OwnerTransferPreconditionError);

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
      currentOwnerEpoch: number;
      currentProcessInstanceId: string;
    };

    expect(owner.currentOwnerEpoch).toBe(1);
    expect(owner.currentProcessInstanceId).toBe("pid:12345");
    await expect(readFile(join(runDir, "owner-transfer.json"), "utf8")).rejects.toThrow();
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
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");

    await expect(
      writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
    ).rejects.toBeInstanceOf(OwnerTransferPreconditionError);
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
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");

    await expect(
      writeOwnerTransferArtifacts(runDir, initialOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord),
    ).rejects.toBeInstanceOf(OwnerTransferPreconditionError);
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
