import { access, appendFile, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoopContract } from "../contract/schema.js";
import type {
  ExecutionRecovery,
  OwnerRecord,
  OwnerTransferRecord,
  ReconciliationRecord,
} from "../runtime/types.js";
import type { RunBoundaryAnalysis, RunState } from "../state/types.js";

export type RunEvent = {
  type: string;
  at: string;
  detail: string;
};

export type AttemptArtifacts = {
  plan: unknown;
  execution?: unknown;
  verify?: unknown;
  diffPatch?: string;
  stdoutStderrLog?: string;
  executionRecovery?: ExecutionRecovery;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function ensureFreshRunDir(runDir: string): Promise<void> {
  await mkdir(runDir, { recursive: true });

  const blockingPaths = [
    [join(runDir, "loop-contract.json"), "loop-contract.json"],
    [join(runDir, "loop-state.json"), "loop-state.json"],
    [join(runDir, "events.jsonl"), "events.jsonl"],
  ] as const;

  for (const [path, label] of blockingPaths) {
    if (await pathExists(path)) {
      throw new Error(`runDir already contains prior run data (${label}); V1 does not support reinitializing an existing automated run`);
    }
  }

  if (await directoryHasEntries(join(runDir, "attempts"))) {
    throw new Error("runDir already contains prior run data (attempts); V1 does not support reinitializing an existing automated run");
  }

  if (await directoryHasEntries(join(runDir, "worktrees"))) {
    throw new Error("runDir already contains prior run data (worktrees); V1 does not support reinitializing an existing automated run");
  }
}

export async function initializeRunFiles(runDir: string, contract: LoopContract, initialState: RunState): Promise<void> {
  await ensureFreshRunDir(runDir);
  await mkdir(join(runDir, "attempts"), { recursive: true });
  await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify(initialState, null, 2));
  await writeFile(join(runDir, "events.jsonl"), "");
}

export async function writeRunState(runDir: string, state: RunState): Promise<void> {
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify(state, null, 2));
}

export async function appendEvent(runDir: string, event: RunEvent): Promise<void> {
  await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

function buildSuccessfulReconciliationFromTransfer(
  currentRecord: ReconciliationRecord | undefined,
  ownerRecord: OwnerRecord,
  ownerTransferRecord: OwnerTransferRecord,
): ReconciliationRecord {
  return {
    staleSuspicionBasis: currentRecord?.staleSuspicionBasis ?? ["continuity evidence missing"],
    staleConfirmed: currentRecord?.staleConfirmed ?? true,
    ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: currentRecord?.lastTrustedBoundary ?? "execute",
    conflictingEvidence: currentRecord?.conflictingEvidence ?? [],
    takeoverPermission: {
      allowed: true,
      reason:
        currentRecord?.takeoverPermission.allowed === true
          ? currentRecord.takeoverPermission.reason
          : "strict owner-loss conditions satisfied; continuation still requires a later transfer step",
    },
    priorOwnerEpoch: ownerTransferRecord.priorOwnerEpoch,
    newOwnerEpoch: ownerTransferRecord.newOwnerEpoch,
    eligibleForContinuation: true,
  };
}

async function preserveSuccessfulReconciliationIfNeeded(
  runDir: string,
  nextReconciliationRecord: ReconciliationRecord,
): Promise<ReconciliationRecord> {
  if (nextReconciliationRecord.eligibleForContinuation) {
    return nextReconciliationRecord;
  }

  let persistedOwnerRecord: OwnerRecord;
  let persistedOwnerTransferRecord: OwnerTransferRecord;
  let persistedReconciliationRecord: ReconciliationRecord | undefined;

  try {
    [persistedOwnerRecord, persistedOwnerTransferRecord] = await Promise.all([
      readOwnerRecord(runDir),
      readOwnerTransferRecordRaw(runDir),
    ]);
  } catch {
    return nextReconciliationRecord;
  }

  try {
    persistedReconciliationRecord = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as ReconciliationRecord;
  } catch {
    persistedReconciliationRecord = undefined;
  }

  const transferRepresentsPublishedWinner =
    persistedOwnerTransferRecord.eligibleForContinuation === true
    && persistedOwnerRecord.currentOwnerEpoch === persistedOwnerTransferRecord.newOwnerEpoch
    && persistedOwnerRecord.currentProcessInstanceId === persistedOwnerTransferRecord.newProcessInstanceId;

  if (!transferRepresentsPublishedWinner) {
    return nextReconciliationRecord;
  }

  const isLoserDowngradeAttempt =
    (nextReconciliationRecord.priorOwnerEpoch === persistedOwnerTransferRecord.priorOwnerEpoch
      || nextReconciliationRecord.priorOwnerEpoch === persistedOwnerTransferRecord.newOwnerEpoch)
    && nextReconciliationRecord.newOwnerEpoch === null
    && nextReconciliationRecord.eligibleForContinuation === false;

  if (!isLoserDowngradeAttempt) {
    return nextReconciliationRecord;
  }

  if (
    persistedReconciliationRecord !== undefined
    && persistedReconciliationRecord.eligibleForContinuation
    && persistedReconciliationRecord.ownershipVerdict === "OWNER_LOST"
    && persistedReconciliationRecord.priorOwnerEpoch === persistedOwnerTransferRecord.priorOwnerEpoch
    && persistedReconciliationRecord.newOwnerEpoch === persistedOwnerTransferRecord.newOwnerEpoch
  ) {
    return persistedReconciliationRecord;
  }

  return buildSuccessfulReconciliationFromTransfer(
    nextReconciliationRecord,
    persistedOwnerRecord,
    persistedOwnerTransferRecord,
  );
}

export async function writeBoundaryArtifacts(
  runDir: string,
  artifacts: {
    boundaryAnalysis: RunBoundaryAnalysis;
    reconciliationRecord?: ReconciliationRecord;
  },
): Promise<void> {
  await writeFile(join(runDir, "boundary-analysis.json"), JSON.stringify(artifacts.boundaryAnalysis, null, 2));

  if (artifacts.reconciliationRecord !== undefined) {
    const reconciliationRecord = await preserveSuccessfulReconciliationIfNeeded(
      runDir,
      artifacts.reconciliationRecord,
    );

    await writeFile(
      join(runDir, "reconciliation-record.json"),
      JSON.stringify(reconciliationRecord, null, 2),
    );
  }
}

const OWNER_RECORD_FILE = "owner-record.json";
const OWNER_TRANSFER_FILE = "owner-transfer.json";
const OWNER_RECORD_TEMP_FILE = ".owner-record.publish.tmp";
const OWNER_TRANSFER_TEMP_FILE = ".owner-transfer.publish.tmp";
const OWNER_RECORD_PENDING_FILE = ".owner-record.pending.json";
const OWNER_TRANSFER_PENDING_FILE = ".owner-transfer.pending.json";
const OWNER_TRANSFER_MARKER_FILE = ".owner-transfer.transaction.json";
const OWNER_TRANSFER_LOCK_FILE = ".owner-transfer.lock";

type OwnerTransferTransactionMarker = {
  version: 1;
  stagedAt: string;
  finalizeOrder: [typeof OWNER_TRANSFER_FILE, typeof OWNER_RECORD_FILE];
};

type OwnerTransferPaths = {
  ownerPath: string;
  transferPath: string;
  ownerTempPath: string;
  transferTempPath: string;
  ownerPendingPath: string;
  transferPendingPath: string;
  transactionMarkerPath: string;
  lockPath: string;
};

type OwnerTransferLockRecord = {
  holderProcessInstanceId: string;
  acquiredAt: string;
};

function getOwnerTransferPaths(runDir: string): OwnerTransferPaths {
  return {
    ownerPath: join(runDir, OWNER_RECORD_FILE),
    transferPath: join(runDir, OWNER_TRANSFER_FILE),
    ownerTempPath: join(runDir, OWNER_RECORD_TEMP_FILE),
    transferTempPath: join(runDir, OWNER_TRANSFER_TEMP_FILE),
    ownerPendingPath: join(runDir, OWNER_RECORD_PENDING_FILE),
    transferPendingPath: join(runDir, OWNER_TRANSFER_PENDING_FILE),
    transactionMarkerPath: join(runDir, OWNER_TRANSFER_MARKER_FILE),
    lockPath: join(runDir, OWNER_TRANSFER_LOCK_FILE),
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function readOwnerRecordRaw(runDir: string): Promise<OwnerRecord> {
  return JSON.parse(await readFile(join(runDir, OWNER_RECORD_FILE), "utf8")) as OwnerRecord;
}

async function readOwnerTransferRecordRaw(runDir: string): Promise<OwnerTransferRecord> {
  return JSON.parse(await readFile(join(runDir, OWNER_TRANSFER_FILE), "utf8")) as OwnerTransferRecord;
}

export async function writeOwnerRecord(runDir: string, ownerRecord: OwnerRecord): Promise<void> {
  await writeJsonFile(join(runDir, OWNER_RECORD_FILE), ownerRecord);
}

export async function writeOwnerTransferRecord(runDir: string, transferRecord: OwnerTransferRecord): Promise<void> {
  await writeJsonFile(join(runDir, OWNER_TRANSFER_FILE), transferRecord);
}

export class OwnerTransferPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerTransferPreconditionError";
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function sameOwnerRecord(left: OwnerRecord, right: OwnerRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parsePid(processInstanceId: string): number | null {
  const match = /^pid:(\d+)$/.exec(processInstanceId);
  return match === null ? null : Number.parseInt(match[1], 10);
}

function isProcessActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }

    return true;
  }
}

async function tryRecoverStaleOwnerTransferLock(runDir: string): Promise<boolean> {
  const { lockPath, ownerPendingPath, transferPendingPath, transactionMarkerPath } = getOwnerTransferPaths(runDir);
  let lockContents = "";

  try {
    lockContents = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;
    const pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;

    if (pid !== null && isProcessActive(pid)) {
      return false;
    }
  } catch {
    const hasStagedArtifacts =
      await pathExists(transactionMarkerPath)
      || await pathExists(ownerPendingPath)
      || await pathExists(transferPendingPath);

    if (!hasStagedArtifacts) {
      return false;
    }
  }

  await safeUnlink(lockPath);
  return true;
}

async function acquireOwnerTransferLock(runDir: string): Promise<{ release: () => Promise<void> }> {
  const { lockPath } = getOwnerTransferPaths(runDir);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");

      try {
        await handle.writeFile(
          JSON.stringify(
            {
              holderProcessInstanceId: `pid:${process.pid}`,
              acquiredAt: new Date().toISOString(),
            } satisfies OwnerTransferLockRecord,
            null,
            2,
          ),
        );
      } catch (error) {
        await handle.close();
        await safeUnlink(lockPath);
        throw error;
      }

      return {
        release: async () => {
          await handle.close();
          await safeUnlink(lockPath);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      if (!(await tryRecoverStaleOwnerTransferLock(runDir))) {
        throw new OwnerTransferPreconditionError("owner transfer already in progress");
      }
    }
  }

  throw new OwnerTransferPreconditionError("owner transfer already in progress");
}

async function cleanupOwnerTransferStagingWithoutMarker(runDir: string): Promise<void> {
  const { ownerPendingPath, transferPendingPath, ownerTempPath, transferTempPath } = getOwnerTransferPaths(runDir);
  await safeUnlink(ownerPendingPath);
  await safeUnlink(transferPendingPath);
  await safeUnlink(ownerTempPath);
  await safeUnlink(transferTempPath);
}

async function finalizePendingOwnerTransfer(runDir: string): Promise<void> {
  const paths = getOwnerTransferPaths(runDir);
  const ownerRecord = JSON.parse(await readFile(paths.ownerPendingPath, "utf8")) as OwnerRecord;
  const transferRecord = JSON.parse(await readFile(paths.transferPendingPath, "utf8")) as OwnerTransferRecord;

  try {
    await safeUnlink(paths.transferTempPath);
    await safeUnlink(paths.ownerTempPath);
    await writeJsonFile(paths.transferTempPath, transferRecord);
    await rename(paths.transferTempPath, paths.transferPath);
    await writeJsonFile(paths.ownerTempPath, ownerRecord);
    await rename(paths.ownerTempPath, paths.ownerPath);
    await safeUnlink(paths.transactionMarkerPath);
    await safeUnlink(paths.transferPendingPath);
    await safeUnlink(paths.ownerPendingPath);
  } catch (error) {
    await safeUnlink(paths.transferTempPath);
    await safeUnlink(paths.ownerTempPath);
    throw error;
  }
}

async function recoverInterruptedOwnerTransfer(runDir: string, options?: { lockHeld?: boolean }): Promise<void> {
  const paths = getOwnerTransferPaths(runDir);

  if (!(await pathExists(paths.transactionMarkerPath))) {
    if (options?.lockHeld) {
      await cleanupOwnerTransferStagingWithoutMarker(runDir);
    }
    return;
  }

  if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))) {
    return;
  }

  await finalizePendingOwnerTransfer(runDir);
}

export async function readOwnerRecord(runDir: string): Promise<OwnerRecord> {
  await recoverInterruptedOwnerTransfer(runDir);
  return readOwnerRecordRaw(runDir);
}

export async function writeOwnerTransferArtifacts(
  runDir: string,
  expectedOwnerRecord: OwnerRecord,
  ownerRecord: OwnerRecord,
  transferRecord: OwnerTransferRecord,
): Promise<void> {
  const lock = await acquireOwnerTransferLock(runDir);

  try {
    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
    const persistedOwnerRecord = await readOwnerRecordRaw(runDir);

    if (!sameOwnerRecord(persistedOwnerRecord, expectedOwnerRecord)) {
      throw new OwnerTransferPreconditionError("persisted owner record changed before owner transfer could be applied");
    }

    const paths = getOwnerTransferPaths(runDir);
    const marker: OwnerTransferTransactionMarker = {
      version: 1,
      stagedAt: transferRecord.transferredAt,
      finalizeOrder: [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE],
    };

    await writeJsonFile(paths.transferPendingPath, transferRecord);
    await writeJsonFile(paths.ownerPendingPath, ownerRecord);
    await writeJsonFile(paths.transactionMarkerPath, marker);
    await finalizePendingOwnerTransfer(runDir);
  } finally {
    await lock.release();
  }
}

export async function writeAttemptArtifacts(runDir: string, attempt: number, artifacts: AttemptArtifacts): Promise<void> {
  const attemptDir = join(runDir, "attempts", String(attempt));
  await mkdir(attemptDir, { recursive: true });
  await writeFile(join(attemptDir, "plan.json"), JSON.stringify(artifacts.plan, null, 2));

  if (artifacts.execution !== undefined) {
    await writeFile(join(attemptDir, "execution.json"), JSON.stringify(artifacts.execution, null, 2));
  }

  if (artifacts.verify !== undefined) {
    await writeFile(join(attemptDir, "verify.json"), JSON.stringify(artifacts.verify, null, 2));
  }

  if (artifacts.diffPatch !== undefined) {
    await writeFile(join(attemptDir, "diff.patch"), artifacts.diffPatch);
  }

  if (artifacts.stdoutStderrLog !== undefined) {
    await writeFile(join(attemptDir, "stdout-stderr.log"), artifacts.stdoutStderrLog);
  }

  if (artifacts.executionRecovery !== undefined) {
    await writeFile(
      join(attemptDir, "execution-recovery.json"),
      JSON.stringify(artifacts.executionRecovery, null, 2),
    );
  }
}
