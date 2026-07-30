import { access, appendFile, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
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
  ownerTransferRecord: OwnerTransferRecord,
): ReconciliationRecord {
  return {
    staleSuspicionBasis:
      currentRecord?.takeoverPermission.allowed === true
        ? currentRecord.staleSuspicionBasis
        : ["owner transfer already published"],
    staleConfirmed: true,
    ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute",
    conflictingEvidence: [],
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

function isSuccessfulReconciliationForTransfer(
  reconciliationRecord: ReconciliationRecord,
  ownerTransferRecord: OwnerTransferRecord,
): boolean {
  return (
    reconciliationRecord.eligibleForContinuation
    && reconciliationRecord.ownershipVerdict === "OWNER_LOST"
    && reconciliationRecord.priorOwnerEpoch === ownerTransferRecord.priorOwnerEpoch
    && reconciliationRecord.newOwnerEpoch === ownerTransferRecord.newOwnerEpoch
  );
}

function isLoserDowngradeAttempt(
  nextReconciliationRecord: ReconciliationRecord,
  ownerTransferRecord: OwnerTransferRecord,
): boolean {
  return (
    (nextReconciliationRecord.priorOwnerEpoch === ownerTransferRecord.priorOwnerEpoch
      || nextReconciliationRecord.priorOwnerEpoch === ownerTransferRecord.newOwnerEpoch)
    && nextReconciliationRecord.newOwnerEpoch === null
    && nextReconciliationRecord.eligibleForContinuation === false
  );
}

function transferRepresentsPublishedWinner(
  ownerRecord: OwnerRecord,
  ownerTransferRecord: OwnerTransferRecord,
): boolean {
  return (
    ownerTransferRecord.eligibleForContinuation === true
    && ownerRecord.currentOwnerEpoch === ownerTransferRecord.newOwnerEpoch
    && ownerRecord.currentProcessInstanceId === ownerTransferRecord.newProcessInstanceId
  );
}

function shouldSynthesizeSuccessfulReconciliation(
  persistedReconciliationRecord: ReconciliationRecord | undefined,
  nextReconciliationRecord: ReconciliationRecord,
  ownerTransferRecord: OwnerTransferRecord,
): boolean {
  return (
    persistedReconciliationRecord === undefined
    && isLoserDowngradeAttempt(nextReconciliationRecord, ownerTransferRecord)
  );
}

function shouldPreserveExistingSuccessfulReconciliation(
  persistedReconciliationRecord: ReconciliationRecord | undefined,
  nextReconciliationRecord: ReconciliationRecord,
  ownerTransferRecord: OwnerTransferRecord,
): boolean {
  return (
    persistedReconciliationRecord !== undefined
    && isSuccessfulReconciliationForTransfer(persistedReconciliationRecord, ownerTransferRecord)
    && isLoserDowngradeAttempt(nextReconciliationRecord, ownerTransferRecord)
  );
}

function shouldPreserveExistingReconciliationRecord(
  persistedReconciliationRecord: ReconciliationRecord | undefined,
  nextReconciliationRecord: ReconciliationRecord,
  ownerTransferRecord: OwnerTransferRecord,
): boolean {
  return (
    persistedReconciliationRecord !== undefined
    && isSuccessfulReconciliationForTransfer(persistedReconciliationRecord, ownerTransferRecord)
    && (isLoserDowngradeAttempt(nextReconciliationRecord, ownerTransferRecord)
      || shouldSynthesizeSuccessfulReconciliation(undefined, nextReconciliationRecord, ownerTransferRecord))
  );
}

function shouldProtectSuccessfulTransferTruth(
  persistedOwnerRecord: OwnerRecord,
  persistedOwnerTransferRecord: OwnerTransferRecord,
  persistedReconciliationRecord: ReconciliationRecord | undefined,
  nextReconciliationRecord: ReconciliationRecord,
): boolean {
  return (
    transferRepresentsPublishedWinner(persistedOwnerRecord, persistedOwnerTransferRecord)
    && (shouldPreserveExistingReconciliationRecord(
      persistedReconciliationRecord,
      nextReconciliationRecord,
      persistedOwnerTransferRecord,
    )
      || shouldSynthesizeSuccessfulReconciliation(
        persistedReconciliationRecord,
        nextReconciliationRecord,
        persistedOwnerTransferRecord,
      ))
  );
}

function resolveSuccessfulReconciliation(
  persistedReconciliationRecord: ReconciliationRecord | undefined,
  nextReconciliationRecord: ReconciliationRecord,
  ownerTransferRecord: OwnerTransferRecord,
): ReconciliationRecord {
  if (
    persistedReconciliationRecord !== undefined
    && isSuccessfulReconciliationForTransfer(persistedReconciliationRecord, ownerTransferRecord)
  ) {
    return persistedReconciliationRecord;
  }

  return buildSuccessfulReconciliationFromTransfer(nextReconciliationRecord, ownerTransferRecord);
}

function preserveSuccessfulReconciliationIfNeededFromArtifacts(
  persistedOwnerRecord: OwnerRecord,
  persistedOwnerTransferRecord: OwnerTransferRecord,
  persistedReconciliationRecord: ReconciliationRecord | undefined,
  nextReconciliationRecord: ReconciliationRecord,
): ReconciliationRecord {
  if (
    !shouldProtectSuccessfulTransferTruth(
      persistedOwnerRecord,
      persistedOwnerTransferRecord,
      persistedReconciliationRecord,
      nextReconciliationRecord,
    )
  ) {
    return nextReconciliationRecord;
  }

  return resolveSuccessfulReconciliation(
    persistedReconciliationRecord,
    nextReconciliationRecord,
    persistedOwnerTransferRecord,
  );
}

async function readPersistedReconciliationRecord(runDir: string): Promise<ReconciliationRecord | undefined> {
  try {
    return JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as ReconciliationRecord;
  } catch {
    return undefined;
  }
}

async function readPersistedSuccessfulTransferArtifacts(
  runDir: string,
): Promise<
  | {
      ownerRecord: OwnerRecord;
      ownerTransferRecord: OwnerTransferRecord;
      reconciliationRecord: ReconciliationRecord | undefined;
    }
  | null
> {
  try {
    const [ownerRecord, ownerTransferRecord, reconciliationRecord] = await Promise.all([
      readOwnerRecord(runDir),
      readOwnerTransferRecordRaw(runDir),
      readPersistedReconciliationRecord(runDir),
    ]);

    return { ownerRecord, ownerTransferRecord, reconciliationRecord };
  } catch {
    return null;
  }
}

async function preserveSuccessfulReconciliationIfNeeded(
  runDir: string,
  nextReconciliationRecord: ReconciliationRecord,
): Promise<ReconciliationRecord> {
  if (nextReconciliationRecord.eligibleForContinuation) {
    return nextReconciliationRecord;
  }

  const persistedArtifacts = await readPersistedSuccessfulTransferArtifacts(runDir);
  if (persistedArtifacts === null) {
    return nextReconciliationRecord;
  }

  return preserveSuccessfulReconciliationIfNeededFromArtifacts(
    persistedArtifacts.ownerRecord,
    persistedArtifacts.ownerTransferRecord,
    persistedArtifacts.reconciliationRecord,
    nextReconciliationRecord,
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

// Same recipe as processIdentity.ts:7, and cached the same way because performance.timeOrigin
// is fixed for the life of the process: pid identifies the process, Math.trunc(timeOrigin)
// distinguishes it from a later process that gets handed the same recycled pid. Held as a
// module constant rather than rebuilt per call so the two sites cannot drift in shape.
//
// buildProcessInstanceId() is not called here only because its `pid:<pid>:<origin>` form embeds
// colons, which do not belong in a filename. The recipe is nevertheless the same one and must
// stay in sync with it; the temp-name test pins that by asserting this stamp against
// buildProcessInstanceId()'s own components.
//
// A third and deliberately weaker form exists in acquireOwnerTransferLock (`pid:<pid>`, no
// start time). It is correct as written — its only consumer, parsePid, extracts the pid for a
// liveness probe and never compares process identity — so do not "unify" it with this one.
const ATOMIC_TEMP_PROCESS_STAMP = `${process.pid}.${Math.trunc(performance.timeOrigin)}`;

let atomicTempPathSequence = 0;

// Deliberately NOT a pure function, and deliberately NOT shared with the owner-transfer
// transaction's fixed temp names (OWNER_RECORD_TEMP_FILE / OWNER_TRANSFER_TEMP_FILE).
//
// writeJsonFileAtomically has no lock around it, so two processes can be publishing the same
// target at the same moment. With a shared fixed temp name, B's writeFile would overwrite A's
// staged bytes before A's rename, and A would publish B's content — temp+rename would have
// manufactured a new torn-write source instead of removing one. Hence the process-instance
// stamp plus a per-process counter, and hence a fresh path on every call.
//
// The transaction's fixed names must stay fixed for the opposite reason: crash recovery finds
// leftover staged files by name. The two helpers are different things; do not merge them.
//
// Exported only so its uniqueness, naming and same-directory properties can be asserted
// directly.
export function buildAtomicTempPath(targetPath: string): string {
  atomicTempPathSequence += 1;
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.${ATOMIC_TEMP_PROCESS_STAMP}.${atomicTempPathSequence}.tmp`,
  );
}

// Publishes `path` only through rename, so a concurrent reader sees either the previous
// complete file or the new complete file, never a partial one. Same directory as the target,
// because rename across filesystems fails.
//
// Scope: this buys visibility atomicity for concurrent readers, not durability. There is no
// fsync on the temp file or its directory (spec §3.1 item 6; the repository has zero fsync
// calls anywhere), so a power loss or kernel crash can still lose or truncate the write.
async function writeJsonFileAtomically(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  const tempPath = buildAtomicTempPath(path);

  try {
    await writeFile(tempPath, serialized);
    await rename(tempPath, path);
  } catch (error) {
    // Best effort, and intentionally not safeUnlink: cleanup here runs while an error is
    // already in flight, and a cleanup failure must not replace the error the caller needs
    // to see. safeUnlink rethrows anything that is not ENOENT, which would do exactly that.
    try {
      await unlink(tempPath);
    } catch {
      // swallowed on purpose; the original error is rethrown below
    }

    throw error;
  }
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

// Sibling of OwnerTransferPreconditionError, deliberately NOT a subclass: the two errors mean
// different things (lock contention vs. a stale CAS base) and every consumer must re-decide its
// own behaviour for each. A subclass would let every existing `instanceof
// OwnerTransferPreconditionError` branch keep matching, silently retaining behaviour that was
// only ever correct for a CAS mismatch.
export class OwnerTransferLockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerTransferLockBusyError";
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
        throw new OwnerTransferLockBusyError("owner transfer already in progress");
      }
    }
  }

  throw new OwnerTransferLockBusyError("owner transfer already in progress");
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

export async function claimOwnerRecordWithPrecondition(
  runDir: string,
  expectedOwnerRecord: OwnerRecord,
  nextOwnerRecord: OwnerRecord,
): Promise<void> {
  const lock = await acquireOwnerTransferLock(runDir);

  try {
    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
    const persistedOwnerRecord = await readOwnerRecordRaw(runDir);

    if (!sameOwnerRecord(persistedOwnerRecord, expectedOwnerRecord)) {
      throw new OwnerTransferPreconditionError("persisted owner record changed before resume could claim it");
    }

    await writeOwnerRecordAtomically(runDir, nextOwnerRecord);
  } finally {
    await lock.release();
  }
}

// §7.1: the gate's read. readOwnerRecord runs recoverInterruptedOwnerTransfer first, which
// may finalize a pending transfer or delete staging files — both writes. A refusal must
// not trigger crash recovery as a side effect, so the gate reads raw. Recovery stays where
// it already is: on the paths that go on to claim or transfer.
export async function readOwnerRecordWithoutRecovery(runDir: string): Promise<OwnerRecord> {
  return readOwnerRecordRaw(runDir);
}

async function writeOwnerRecordAtomically(runDir: string, ownerRecord: OwnerRecord): Promise<void> {
  const { ownerPath, ownerTempPath } = getOwnerTransferPaths(runDir);
  await safeUnlink(ownerTempPath);
  await writeJsonFile(ownerTempPath, ownerRecord);
  await rename(ownerTempPath, ownerPath);
}

async function updateOwnerRecordWithPrecondition(
  runDir: string,
  expectedOwnerRecord: OwnerRecord,
  buildNext: (persisted: OwnerRecord) => OwnerRecord,
  mismatchMessage: string,
): Promise<OwnerRecord> {
  const lock = await acquireOwnerTransferLock(runDir);

  try {
    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
    const persistedOwnerRecord = await readOwnerRecordRaw(runDir);

    if (!sameOwnerRecord(persistedOwnerRecord, expectedOwnerRecord)) {
      throw new OwnerTransferPreconditionError(mismatchMessage);
    }

    const nextOwnerRecord = buildNext(persistedOwnerRecord);
    await writeOwnerRecordAtomically(runDir, nextOwnerRecord);
    return nextOwnerRecord;
  } finally {
    await lock.release();
  }
}

// §6: the heartbeat's write. Advances leaseAffirmedAt and, so the ownership design's named
// freshness anchor stops being dead, lastAffirmedAt alongside it. Never rotates an epoch,
// never changes ownerStatus, never touches supersededByEpoch.
//
// Returns the record it just wrote: the caller MUST adopt it as its next expected record
// (§6.1), because this write makes the caller's previous expectation stale immediately.
export async function affirmOwnerLease(
  runDir: string,
  expected: OwnerRecord,
  nowIso: string,
): Promise<OwnerRecord> {
  return updateOwnerRecordWithPrecondition(
    runDir,
    expected,
    (persisted) => ({ ...persisted, lastAffirmedAt: nowIso, leaseAffirmedAt: nowIso }),
    "persisted owner record changed before the lease could be affirmed",
  );
}

// §6.0: release. CAS leaseAffirmedAt back to null, leaving every other field alone — the
// run is still owned, just no longer running. Kept separate from affirmOwnerLease because
// that name would lie about writing null.
//
// Best-effort by contract: it throws on a CAS mismatch and the caller swallows that, so a
// superseded process cannot clear the lease of the owner that replaced it.
export async function releaseOwnerLease(runDir: string, expected: OwnerRecord): Promise<void> {
  await updateOwnerRecordWithPrecondition(
    runDir,
    expected,
    (persisted) => ({ ...persisted, leaseAffirmedAt: null }),
    "persisted owner record changed before the lease could be released",
  );
}

export async function readRunState(runDir: string): Promise<RunState> {
  return JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as RunState;
}

export async function readOwnerTransferRecord(runDir: string): Promise<OwnerTransferRecord> {
  return JSON.parse(await readFile(join(runDir, OWNER_TRANSFER_FILE), "utf8")) as OwnerTransferRecord;
}

export async function readReconciliationRecord(runDir: string): Promise<ReconciliationRecord> {
  return JSON.parse(await readFile(join(runDir, "reconciliation-record.json"), "utf8")) as ReconciliationRecord;
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
