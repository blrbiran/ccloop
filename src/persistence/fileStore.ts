import { access, appendFile, link, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
  await writeJsonFileAtomically(join(runDir, "loop-state.json"), initialState);
  await writeFile(join(runDir, "events.jsonl"), "");
}

export async function writeRunState(runDir: string, state: RunState): Promise<void> {
  await writeJsonFileAtomically(join(runDir, "loop-state.json"), state);
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

// This function tests TWO propositions; its name carries only the first.
//   (a) "a transfer was successfully published" — the `eligibleForContinuation === true` clause
//       and the `currentOwnerEpoch === newOwnerEpoch` clause.
//   (b) "the process that won that transfer is still the process named as owner" — the
//       `currentProcessInstanceId === newProcessInstanceId` clause, and nothing else tests it.
// (b) goes false at the SAME epoch after any successful resume, with no race and no crash:
// resumeLoop builds nextOwnerRecord by spreading ownerRecord (so currentOwnerEpoch is unchanged)
// with a fresh buildProcessInstanceId(), then CAS-writes it. From that moment the resumer's id is
// on disk where the winner's was, this function returns false, shouldProtectSuccessfulTransferTruth
// stops protecting, and writeBoundaryArtifacts replaces the winner's already-published
// eligibleForContinuation record with the resumed process's downgrade.
//
// That divergence is INTENDED, per the human ruling recorded in
// .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md: deleting clause (b)
// was measured to permit MORE resumes — for a surviving winner record, for an ABSENT one, and for
// a CORRUPT one, where readPersistedReconciliationRecord's `catch { return undefined }` routes the
// corruption into the synthesis arm — and S-3's "never permit more" forbids that. The behaviour
// kept here is therefore deliberate, not an oversight. What changed is only that the loss is no
// longer silent: on exactly the square where THIS PREDICATE IS FALSE and an on-disk successful
// record is about to be replaced, describePublishedWinnerReplacement marks the write and
// writeBoundaryArtifacts appends a reconciliation_published_winner_replaced event. That square is
// named by the whole predicate, not by clause (b): a false `eligibleForContinuation === true` or a
// `currentOwnerEpoch !== newOwnerEpoch` land on it too. (b) is merely the only route this repo can
// actually take there, because applyOwnerEpochTransfer always writes eligibleForContinuation: true.
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

// The square where shouldProtectSuccessfulTransferTruth's second conjunct holds but
// transferRepresentsPublishedWinner is FALSE: the conjunction above with that first conjunct
// negated, expressed by calling the same two predicates rather than restating either. What is
// tested is the negated predicate, which is a strict SUPERSET of "the process-instance-id clause
// is the only false one" — see that predicate's note; the post-resume route is simply the only one
// this repo can reach.
//
// Only shouldPreserveExistingReconciliationRecord is asked, not the synthesis disjunct: synthesis
// requires persistedReconciliationRecord === undefined, so nothing THE PROTECTION WOULD HAVE
// PRESERVED is lost there. That is not the same as "nothing on disk is destroyed":
// readPersistedReconciliationRecord's `catch { return undefined }` maps a CORRUPT
// reconciliation-record.json to undefined as well, so on that square a corrupt file is still
// overwritten with no event — the same silence this signal exists to remove, one square over. It
// is carried as a named gap in progress.md rather than fixed here; widening the signal to cover
// absent-vs-corrupt is a different change with a different justification.
//
// Total by construction, hence the try/catch: readPersistedReconciliationRecord casts an
// unvalidated JSON.parse result to ReconciliationRecord, so a reconciliation-record.json whose
// content parses to `null` is `!== undefined` and makes isSuccessfulReconciliationForTransfer
// throw on property access. Left uncontained that throw leaves writeBoundaryArtifacts, passes
// through persistBoundaryAnalysis, and reaches runLoopFromState's outer catch — where
// isLeaseStopError does not match — ending an otherwise-successful attempt as failed. Recording a
// loss must never be able to manufacture one, and this signal's whole warrant is that it moves no
// decision. The containment is deliberately scoped to THIS function: the identical throw on the
// transferRepresentsPublishedWinner === true square arrives via
// shouldProtectSuccessfulTransferTruth and is left exactly as it was before this signal existed,
// because degrading it to `undefined` there would route a corrupt record into the synthesis arm
// and permit MORE.
//
// Returns the detail line for the event, or undefined when this write destroys nothing that the
// protection would have kept.
function describePublishedWinnerReplacement(
  persistedOwnerRecord: OwnerRecord,
  persistedOwnerTransferRecord: OwnerTransferRecord,
  persistedReconciliationRecord: ReconciliationRecord | undefined,
  nextReconciliationRecord: ReconciliationRecord,
): string | undefined {
  try {
    if (
      transferRepresentsPublishedWinner(persistedOwnerRecord, persistedOwnerTransferRecord)
      || !shouldPreserveExistingReconciliationRecord(
        persistedReconciliationRecord,
        nextReconciliationRecord,
        persistedOwnerTransferRecord,
      )
    ) {
      return undefined;
    }

    return `published winner reconciliation replaced by downgrade: transfer epoch ${persistedOwnerTransferRecord.priorOwnerEpoch} -> ${persistedOwnerTransferRecord.newOwnerEpoch} won by ${persistedOwnerTransferRecord.newProcessInstanceId}; owner-record epoch ${persistedOwnerRecord.currentOwnerEpoch} now held by ${persistedOwnerRecord.currentProcessInstanceId}`;
  } catch {
    // A value that cannot be interpreted degrades to "no detail", never to a throw.
    return undefined;
  }
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

// Three outcomes, not two, because "no transfer was ever published" and "the transfer artifacts
// could not be read" demand opposite handling and the old `| null` could not tell them apart:
// the first must be waved through (most runs never transfer ownership), the second must fail
// closed (writing through it can overwrite a winner's record with a loser's downgrade).
type PersistedTransferArtifactsRead =
  | {
      kind: "artifacts";
      ownerRecord: OwnerRecord;
      ownerTransferRecord: OwnerTransferRecord;
      reconciliationRecord: ReconciliationRecord | undefined;
    }
  | { kind: "no_published_transfer" }
  | { kind: "unreadable"; error: unknown };

// The abandon arm carries the error rather than collapsing to a bare marker: it is the only thing
// the abandonment has to say about why the write was given up.
//
// publishedWinnerReplacedDetail rides the EXISTING write arm rather than becoming a third kind:
// this union is not exported, and the callers that reach this channel — resumeLoop,
// writeBoundaryArtifacts, runLoopFromState — never destructure it, so a third arm would make them
// absorb a shape change for a signal that changes nothing about what gets written. Optional
// because it is set on one square only; the write itself is identical with or without it.
type ReconciliationWriteDecision =
  | { kind: "write"; record: ReconciliationRecord; publishedWinnerReplacedDetail?: string }
  | { kind: "abandon"; error: unknown };

async function readPersistedSuccessfulTransferArtifacts(
  runDir: string,
): Promise<PersistedTransferArtifactsRead> {
  let ownerTransferRecord: OwnerTransferRecord;

  // owner-transfer.json is read in its own try so that an ENOENT is attributed to *this* read by
  // control flow. An ENOENT means "no transfer was ever published" only when it is this file's
  // read that raised it — a missing owner-record.json raises an indistinguishable ENOENT and means
  // something entirely different. Attributing by `error.code` plus `error.path` inside one shared
  // catch reads the same today and breaks silently the day any of these reads wraps its cause in a
  // custom error class: the wrapper drops `path` while every existing test stays green.
  try {
    ownerTransferRecord = await readOwnerTransferRecordRaw(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // This return also skips the owner-record read below. Package 2 / 4th entry (D2) changed what
      // that costs: recovery no longer rides on this function's owner-record read at all — the
      // single caller runs recoverInterruptedOwnerTransfer(runDir, { lockHeld: true }) once, before
      // this read, under the transfer lock it holds for the whole read → decide → write. So an
      // early return here skips a read, not a recovery, and the pre-D2 justification for skipping
      // that recovery (a protective read must not write) is now delivered by construction: the
      // recovery that does happen is performed by the lock holder, exactly as
      // writeOwnerTransferArtifacts and claimOwnerRecordWithPrecondition perform it.
      return { kind: "no_published_transfer" };
    }

    return { kind: "unreadable", error };
  }

  // readPersistedReconciliationRecord carries its own `catch { return undefined }` and never
  // throws, so anything this catch sees came from the owner-record read.
  //
  // readOwnerRecordRaw, not readOwnerRecord: this function now runs with the transfer lock HELD,
  // and readOwnerRecord's recoverInterruptedOwnerTransfer(runDir) — no lockHeld — would try to take
  // that same non-reentrant lock, fail against this very process's own live lock file, and swallow
  // the recovery silently. Same precedent, same reason, as the two lock holders above.
  try {
    const [ownerRecord, reconciliationRecord] = await Promise.all([
      readOwnerRecordRaw(runDir),
      readPersistedReconciliationRecord(runDir),
    ]);

    return { kind: "artifacts", ownerRecord, ownerTransferRecord, reconciliationRecord };
  } catch (error) {
    return { kind: "unreadable", error };
  }
}

async function preserveSuccessfulReconciliationIfNeeded(
  runDir: string,
  nextReconciliationRecord: ReconciliationRecord,
): Promise<ReconciliationWriteDecision> {
  if (nextReconciliationRecord.eligibleForContinuation) {
    return { kind: "write", record: nextReconciliationRecord };
  }

  const persistedArtifacts = await readPersistedSuccessfulTransferArtifacts(runDir);

  if (persistedArtifacts.kind === "no_published_transfer") {
    // Deliberately permissive, and this square must stay: every stale_candidate run reaches here
    // with a reconciliation record whether or not ownership ever changed hands, so failing closed
    // on a merely-absent owner-transfer.json would stop most runs from ever writing
    // reconciliation-record.json. That deletes a product of the normal path; it does not add a
    // refusal. The residual TOCTOU behind this observation is named and carried onward (§13).
    return { kind: "write", record: nextReconciliationRecord };
  }

  if (persistedArtifacts.kind === "unreadable") {
    return { kind: "abandon", error: persistedArtifacts.error };
  }

  return {
    kind: "write",
    record: preserveSuccessfulReconciliationIfNeededFromArtifacts(
      persistedArtifacts.ownerRecord,
      persistedArtifacts.ownerTransferRecord,
      persistedArtifacts.reconciliationRecord,
      nextReconciliationRecord,
    ),
    publishedWinnerReplacedDetail: describePublishedWinnerReplacement(
      persistedArtifacts.ownerRecord,
      persistedArtifacts.ownerTransferRecord,
      persistedArtifacts.reconciliationRecord,
      nextReconciliationRecord,
    ),
  };
}

// Package 2 / §13 4th entry (D2). Bound and delay are this module's own, deliberately NOT imported
// from the controller's OWNER_TRANSFER_LOCK_RETRY_* : runLoop.ts imports this file, so importing
// back would close a cycle. The SHAPE is the controller's, per its own bounded-retry precedent in
// persistOwnerTransfer — retry a busy lock a bounded number of times, then give up — because a
// winner's transfer transaction holds this lock for a handful of renames and giving up on the first
// EEXIST would refuse the write for a contention that clears in microseconds.
const RECONCILIATION_LOCK_RETRY_ATTEMPTS = 3;
const RECONCILIATION_LOCK_RETRY_DELAY_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Diverges from persistOwnerTransfer's loop on exactly one point, and the divergence is forced:
// there, a non-busy failure is RETHROWN; here every failure — busy-after-the-bound, and the
// non-EEXIST errnos acquireOwnerTransferLock rethrows unchanged (EACCES / ENOSPC / EROFS) — becomes
// an abandonment instead. Constraint 1 on writeBoundaryArtifacts' abandon arm is why: a throw out of
// this path reaches runLoopFromState's outer catch, where isLeaseStopError does not match an I/O
// error, and a refusal to overwrite a winner's record would be upgraded into a failed attempt.
async function acquireOwnerTransferLockForReconciliation(
  runDir: string,
): Promise<
  | { kind: "lock"; lock: { release: () => Promise<void> } }
  | { kind: "abandon"; error: unknown }
> {
  let lastBusyError: unknown = new OwnerTransferLockBusyError("owner transfer already in progress");

  for (let attempt = 0; attempt < RECONCILIATION_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await delay(RECONCILIATION_LOCK_RETRY_DELAY_MS);
    }

    try {
      return { kind: "lock", lock: await acquireOwnerTransferLock(runDir) };
    } catch (error) {
      if (!(error instanceof OwnerTransferLockBusyError)) {
        return { kind: "abandon", error };
      }

      lastBusyError = error;
    }
  }

  return { kind: "abandon", error: lastBusyError };
}

// Package 2 / §13 4th entry (D2): the loser's read → decide → write is one critical section under
// the SAME cross-process lock that a winner holds for its entire publish transaction — acquire,
// recover, three renames, release (writeOwnerTransferArtifacts). Two lock spans cannot interleave,
// so the loser's write is either wholly before the winner takes the lock (the winner's rename #3
// then publishes over it) or wholly after the winner released it (the loser then reads the
// COMMITTED pair, transferRepresentsPublishedWinner holds, and resolveSuccessfulReconciliation
// writes the winner's own record back). The third order — decide on a pre-transfer observation,
// write after rename #3 — is the one that destroyed the winner's record, and it is the one the lock
// removes. What that does NOT make order-independent is named where it lives: a lock this process
// can have stolen from it (tryRecoverStaleOwnerTransferLock) puts the third order back, and any
// successful resume turns clause (b) of transferRepresentsPublishedWinner false at the same epoch
// by human ruling, after which the protection is gone by design and not by race.
//
// The heartbeat's runExclusive is NOT an alternative to this: it is an in-process promise queue and
// constrains no other process.
//
// *** ERRATUM (package 2 whole-branch review, Critical C-1) — the sentence "Two lock spans cannot
// interleave" above is KEPT VERBATIM rather than softened, because this repository records what it
// once claimed; but that premise has been DISPROVED BY MEASUREMENT and must not be relied on:
//   - acquireOwnerTransferLock creates the lock with `open(lockPath, "wx")` and only then does
//     `handle.writeFile(...)`. Between those two awaits the lock file exists and is ZERO BYTES.
//   - An intruder that hits EEXIST in that window calls tryRecoverStaleOwnerTransferLock, whose
//     `JSON.parse("")` throws, so control lands in the `catch` branch — and that branch NEVER
//     CALLS isProcessActive. It asks only whether staged artifacts exist, and if they do it
//     `safeUnlink`s the lock and reports it recovered.
//   - So a LIVE holder's lock is taken away from it, and two lock spans DO interleave — including
//     the third order this comment says the lock removes.
// The controller reproduced this with two REAL processes (ledger §21.1, with a must-hit and a
// must-miss control), so it is not a reading of the code. It is a KNOWN, UNFIXED Critical (C-1);
// the repair is a separate human decision (open point B) and was DELIBERATELY NOT MADE in this
// round — no line of acquireOwnerTransferLock or tryRecoverStaleOwnerTransferLock was touched. ***
async function publishReconciliationUnderTransferLock(
  runDir: string,
  nextReconciliationRecord: ReconciliationRecord,
): Promise<ReconciliationWriteDecision> {
  const acquisition = await acquireOwnerTransferLockForReconciliation(runDir);

  if (acquisition.kind === "abandon") {
    return acquisition;
  }

  try {
    // The lock holder's form of the recovery this path already performed before D2, via
    // readOwnerRecord inside readPersistedSuccessfulTransferArtifacts. Same precedent as
    // writeOwnerTransferArtifacts and claimOwnerRecordWithPrecondition. Without it the decision
    // could be taken against an owner-record.json that an interrupted transfer has already
    // superseded on disk — the stale pair this entry is about.
    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
    const decision = await preserveSuccessfulReconciliationIfNeeded(runDir, nextReconciliationRecord);

    if (decision.kind === "write") {
      await writeJsonFileAtomically(
        join(runDir, "reconciliation-record.json"),
        decision.record,
      );
    }

    return decision;
  } finally {
    await acquisition.lock.release();
  }
}

export async function writeBoundaryArtifacts(
  runDir: string,
  artifacts: {
    boundaryAnalysis: RunBoundaryAnalysis;
    reconciliationRecord?: ReconciliationRecord;
  },
  // A8 §4.3: the operator channel for a protective abandonment. Optional at every one of the
  // four layers, so all existing call sites keep working unchanged; absent, the abandonment is
  // recorded in events.jsonl only and is routed nowhere. The callback's contract is "must not
  // throw" — see the note at its call site below.
  options?: { onReconciliationWriteAbandoned?: (detail: string) => void },
): Promise<void> {
  await writeJsonFileAtomically(join(runDir, "boundary-analysis.json"), artifacts.boundaryAnalysis);

  if (artifacts.reconciliationRecord !== undefined) {
    // D2: read, decision AND write all happen inside publishReconciliationUnderTransferLock's lock
    // span. The two events below stay outside it on purpose — they are audit, they move no
    // decision, and appending them under the lock would hold a cross-process critical section open
    // across an appendFile for nobody's benefit.
    const decision = await publishReconciliationUnderTransferLock(
      runDir,
      artifacts.reconciliationRecord,
    );

    if (decision.kind === "abandon") {
      // Swallowed by contract, same shape and same reason as appendLeaseEvent in
      // leaseHeartbeat.ts. Three constraints meet here:
      //   1. A protective abandonment must not throw. Left unswallowed, an unwritable events.jsonl
      //      (ENOSPC / EACCES / directory already removed) would propagate out of
      //      writeBoundaryArtifacts, through persistBoundaryAnalysis, into runLoopFromState's outer
      //      catch — where isLeaseStopError does not match an I/O error — and end the attempt as
      //      failed. Refusing to overwrite a winner's record would be upgraded into a failure.
      //   2. Only the audit half is swallowed, never the whole signal: at-the-moment visibility is
      //      carried by the operator callback that A8 inserts immediately above this appendEvent.
      //      Absent that callback, events.jsonl would be the sole outlet and swallowing it here
      //      would be a genuine silent failure.
      //   3. The precedent is this repository's own, in the same function (appendEvent) for the
      //      same reason, so this is conformance rather than a new shape.
      // The callback deliberately does NOT get this treatment: its body is inside this layer's
      // control — a single synchronous call into a sink the caller injected (sweepRuns passes
      // SweepOptions.stderr), touching no filesystem and awaiting nothing — so a throw from it is
      // a programming error in the caller and must be loud. appendFile's I/O is nobody's to fix —
      // a throw from it is an environment fact, and converting it into a failed attempt only hides
      // a small error behind a larger one. The asymmetry turns on who can fix it, not on whether
      // the callback performs I/O: it writes a note line to stderr on the spot, and that is the
      // point (a buffered note dies with the process on a SIGKILL mid-sweep).
      // Ordered BEFORE appendEvent on purpose — and stated honestly: with the swallow below in
      // place, that ordering has NO killing mutation, because swapping the two lines is an
      // equivalent mutation (a swallowed appendEvent cannot stop the callback that follows it
      // either). It is defence in depth against a future edit that removes the swallow and
      // leaves the order alone, at which point an unwritable events.jsonl would take the
      // operator's line down with it.
      options?.onReconciliationWriteAbandoned?.(String(decision.error));

      try {
        await appendEvent(runDir, {
          type: "reconciliation_write_abandoned",
          at: new Date().toISOString(),
          detail: String(decision.error),
        });
      } catch {
        // Swallowed by contract: the refusal to overwrite must stand without the audit line.
      }

      return;
    }

    // Appended AFTER the write, not before: the event asserts that a published winner's record was
    // destroyed, and if writeJsonFileAtomically throws it was not — under D2 that throw propagates
    // out of publishReconciliationUnderTransferLock, so this line is still unreachable when the
    // write failed.
    if (decision.publishedWinnerReplacedDetail !== undefined) {
      try {
        await appendEvent(runDir, {
          type: "reconciliation_published_winner_replaced",
          at: new Date().toISOString(),
          detail: decision.publishedWinnerReplacedDetail,
        });
      } catch {
        // Swallowed by contract, same shape and same reason as the abandon arm's appendEvent
        // above. Left unswallowed, an unwritable events.jsonl (ENOSPC / EACCES / directory already
        // removed) would propagate out of writeBoundaryArtifacts, through persistBoundaryAnalysis,
        // into runLoopFromState's outer catch — where isLeaseStopError does not match an I/O
        // error — and end the attempt as failed. Here the reconciliation write has ALREADY
        // succeeded, so that would convert a successful write into a failed attempt: recording a
        // loss must never be able to manufacture one. This signal is purely observational and
        // changes nothing about what was written, which is exactly why it may be dropped.
      }
    }
  }
}

const OWNER_RECORD_FILE = "owner-record.json";
const OWNER_TRANSFER_FILE = "owner-transfer.json";
const RECONCILIATION_RECORD_FILE = "reconciliation-record.json";
const OWNER_RECORD_TEMP_FILE = ".owner-record.publish.tmp";
const OWNER_TRANSFER_TEMP_FILE = ".owner-transfer.publish.tmp";
const RECONCILIATION_RECORD_TEMP_FILE = ".reconciliation-record.publish.tmp";
const OWNER_RECORD_PENDING_FILE = ".owner-record.pending.json";
const OWNER_TRANSFER_PENDING_FILE = ".owner-transfer.pending.json";
const RECONCILIATION_RECORD_PENDING_FILE = ".reconciliation-record.pending.json";
const OWNER_TRANSFER_MARKER_FILE = ".owner-transfer.transaction.json";
const OWNER_TRANSFER_LOCK_FILE = ".owner-transfer.lock";
const OWNER_TRANSFER_MARKER_TEMP_FILE = ".owner-transfer.transaction.tmp";
const OWNER_RECORD_PENDING_TEMP_FILE = ".owner-record.pending.tmp";
const OWNER_TRANSFER_PENDING_TEMP_FILE = ".owner-transfer.pending.tmp";
const RECONCILIATION_RECORD_PENDING_TEMP_FILE = ".reconciliation-record.pending.tmp";

type TransactionFileName =
  | typeof OWNER_TRANSFER_FILE
  | typeof OWNER_RECORD_FILE
  | typeof RECONCILIATION_RECORD_FILE;

type OwnerTransferTransactionMarker =
  | { version: 1; stagedAt: string; finalizeOrder: readonly [typeof OWNER_TRANSFER_FILE, typeof OWNER_RECORD_FILE] }
  | { version: 2; stagedAt: string; finalizeOrder: readonly TransactionFileName[] };

type OwnerTransferPaths = {
  ownerPath: string;
  transferPath: string;
  reconciliationPath: string;
  ownerTempPath: string;
  transferTempPath: string;
  reconciliationTempPath: string;
  ownerPendingPath: string;
  transferPendingPath: string;
  reconciliationPendingPath: string;
  transactionMarkerPath: string;
  lockPath: string;
  transactionMarkerTempPath: string;
  ownerPendingTempPath: string;
  transferPendingTempPath: string;
  reconciliationPendingTempPath: string;
};

type OwnerTransferLockRecord = {
  holderProcessInstanceId: string;
  acquiredAt: string;
};

function getOwnerTransferPaths(runDir: string): OwnerTransferPaths {
  return {
    ownerPath: join(runDir, OWNER_RECORD_FILE),
    transferPath: join(runDir, OWNER_TRANSFER_FILE),
    reconciliationPath: join(runDir, RECONCILIATION_RECORD_FILE),
    ownerTempPath: join(runDir, OWNER_RECORD_TEMP_FILE),
    transferTempPath: join(runDir, OWNER_TRANSFER_TEMP_FILE),
    reconciliationTempPath: join(runDir, RECONCILIATION_RECORD_TEMP_FILE),
    ownerPendingPath: join(runDir, OWNER_RECORD_PENDING_FILE),
    transferPendingPath: join(runDir, OWNER_TRANSFER_PENDING_FILE),
    reconciliationPendingPath: join(runDir, RECONCILIATION_RECORD_PENDING_FILE),
    transactionMarkerPath: join(runDir, OWNER_TRANSFER_MARKER_FILE),
    lockPath: join(runDir, OWNER_TRANSFER_LOCK_FILE),
    transactionMarkerTempPath: join(runDir, OWNER_TRANSFER_MARKER_TEMP_FILE),
    ownerPendingTempPath: join(runDir, OWNER_RECORD_PENDING_TEMP_FILE),
    transferPendingTempPath: join(runDir, OWNER_TRANSFER_PENDING_TEMP_FILE),
    reconciliationPendingTempPath: join(runDir, RECONCILIATION_RECORD_PENDING_TEMP_FILE),
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
  await writeJsonFileAtomically(join(runDir, OWNER_RECORD_FILE), ownerRecord);
}

// NOT atomic: this goes through the bare writeJsonFile, so a concurrent reader can observe a
// half-written owner-transfer.json. It exists only to build test fixtures — every call site is
// under tests/ (fileStore, runLoop.integration, registry/zeroWrite); production has none.
//
// Production must publish owner-transfer.json only through finalizePendingOwnerTransfer.
// Reaching for this instead silently defeats L2's single-read assumption for that file:
// OBSERVED_FILES marks owner-transfer.json `atomic: true` (observeFields.ts:46), which
// readObservedFile turns into maxAttempts = 1 (readObservedFile.ts:105), so a torn read is
// reported unreadable(parse) with no retry behind it to absorb it.
//
// Do not "fix" this by making it atomic. Atomicity is not its defect — it bypasses the entire
// transfer transaction and its crash recovery, and an atomic version would merely look safe
// enough for production to start calling (spec §6).
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

// Sibling of OwnerTransferPreconditionError, deliberately NOT a subclass: a corrupt marker is a
// third, unrelated failure from a CAS mismatch or lock contention. It surfaces through the same
// call chain as those two errors — acquireOwnerTransferLock's locked callers, and readOwnerRecord's
// unlocked recoverInterruptedOwnerTransfer / tryRecoverStaleOwnerTransferLock path — so a subclass
// would let their downstream `instanceof OwnerTransferPreconditionError` routing (runLoop.ts,
// resumeLoop.ts, leaseHeartbeat.ts) start matching an unreadable marker too, silently reusing
// behaviour that was only ever correct for a lost CAS race.
export class OwnerTransferMarkerUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerTransferMarkerUnreadableError";
  }
}

// Sibling of OwnerTransferPreconditionError, deliberately NOT a subclass, for the same reason as
// OwnerTransferMarkerUnreadableError immediately above: a missing v2 pending file is a
// fail-closed refusal to finalize, not a CAS mismatch or lock contention, and it reaches the same
// instanceof-routed consumers through the same acquireOwnerTransferLock /
// tryRecoverStaleOwnerTransferLock call chain.
export class OwnerTransferPendingMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerTransferPendingMissingError";
  }
}

// Sibling of OwnerTransferPreconditionError, deliberately NOT a subclass, same reasoning as its
// two siblings immediately above: an invalid finalizeOrder is a fourth, unrelated failure — the
// marker parsed fine, but its finalizeOrder is not a legal permutation of the file set its own
// version declares (wrong length, an unrecognized file name, or a duplicate). It reaches the same
// instanceof-routed consumers (runLoop.ts, resumeLoop.ts, leaseHeartbeat.ts) through the same
// acquireOwnerTransferLock / readOwnerRecord call chain as the other three.
export class OwnerTransferMarkerFinalizeOrderInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerTransferMarkerFinalizeOrderInvalidError";
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

// Removing the lock's staging name, on BOTH paths that reach it, and deliberately NOT through
// safeUnlink. This is the same shape writeJsonFileAtomically already uses for the same kind of
// cleanup, and its comment states one of the two reasons verbatim: "Best effort, and intentionally
// not safeUnlink: cleanup here runs while an error is already in flight, and a cleanup failure must
// not replace the error the caller needs to see. safeUnlink rethrows anything that is not ENOENT,
// which would do exactly that." That reason covers the failure path here.
//
// The SUCCESS path needs a second reason, and it is the more serious one — the scoped re-review's
// Imp-1, a defect this fix round introduced itself. `safeUnlink` after a SUCCESSFUL `link` sat
// between the publish and the `return`, where the pre-C-1 code had no throwing statement at all. A
// non-ENOENT errno there (EACCES/EPERM/EROFS/ESTALE/EIO — environment faults; concurrency cannot
// produce them, since this staging file is this attempt's alone) escaped through the outer catch's
// `if (code !== "EEXIST") throw error`, and by then THE LOCK WAS ALREADY PUBLISHED: the caller
// never received `release`, the handle was never closed, and because the lock record names a pid
// that is still alive, tryRecoverStaleOwnerTransferLock refuses to reclaim it. Every owner-transfer
// operation on that run — heartbeat affirm, transfer, reconciliation publish — would then fail with
// OwnerTransferLockBusyError until the holding process exited. Losing the staging name is a smudge;
// losing the lock is an outage, so the smudge is swallowed.
//
// On the failure path there is a third effect worth naming: safeUnlink could replace an EEXIST with
// its own errno, which would route a genuine lock contention out of the busy-lock branch entirely.
async function discardLockStaging(stagingPath: string): Promise<void> {
  try {
    await unlink(stagingPath);
  } catch {
    // swallowed on purpose; see above. A leftover staging file is inert: it is uniquely named per
    // process and per attempt, nothing reads it, and no acquisition path looks for it.
  }
}

// The identity half of C-1, fixed under HUMAN RULING 62. release() used to unlink `lockPath`
// unconditionally: whatever file bore that name at that instant was deleted, whether or not it was
// the file this holder published. Measured on `dbac288` (pointB-design.md §6.1) — a holder whose
// lock had been stolen and rebuilt by someone else deleted the NEW holder's lock on its way out.
//
// WHICH IDENTITY, and why this one rather than the lock record's own `holderProcessInstanceId`
// (which is what the earlier prototype compared): the answer is the inode this process published,
// obtained by fstat on the handle acquireOwnerTransferLock is already holding open. Three reasons.
//   1. `pid:<pid>` cannot tell two successive locks of the SAME process apart — a stale release from
//      acquisition #1 would still match acquisition #2's record and delete it. The inode can: every
//      acquisition stages into a fresh buildAtomicTempPath file, so every published lock is a
//      distinct inode, and a stale release refuses.
//   2. It compares what was actually published, not what the file claims about itself, so a lock
//      whose content is corrupt, truncated or forged is simply "not ours" without a parse step.
//   3. It needs nothing from the on-disk record, so the deliberately weak `pid:<pid>` form and its
//      only consumer (parsePid's liveness probe) stay exactly as they are — no format change, and
//      tryRecoverStaleOwnerTransferLock is not touched (point B is unruled; human ruling 50 stands).
// What it does NOT cover is named in the report: the stat and the unlink are still two syscalls, so
// a theft landing between them is undetectable here, and inode numbers are reused after deletion.
//
// MUST NOT THROW. release() is called from four `finally` blocks, so a rejection here would replace
// whatever error is already in flight — the reason ruling 62 chose "don't delete, don't throw,
// record an event". Both fstat and stat are swallowed into `false`: unreadable is not ours.
async function lockPathStillHoldsPublishedInode(handle: FileHandle, lockPath: string): Promise<boolean> {
  try {
    const published = await handle.stat();
    const onDisk = await stat(lockPath);
    return onDisk.dev === published.dev && onDisk.ino === published.ino;
  } catch {
    return false;
  }
}

// Swallowed by contract, same shape and same reason as the two appendEvent calls in
// writeBoundaryArtifacts: this is the audit half of a protective refusal, and an unwritable
// events.jsonl (ENOSPC / EACCES / directory already removed) must not turn a refusal-to-delete into
// a thrown error out of a `finally`. The refusal itself stands without the line.
async function recordSkippedForeignLockRelease(runDir: string): Promise<void> {
  try {
    await appendEvent(runDir, {
      type: "owner_transfer_lock_release_skipped",
      at: new Date().toISOString(),
      detail: `${OWNER_TRANSFER_LOCK_FILE} no longer holds the inode this process published; left in place`,
    });
  } catch {
    // see above
  }
}

// Package 2 whole-branch review, Critical C-1, fixed under human ruling 50 (option O1(a): make the
// publish atomic; do NOT touch tryRecoverStaleOwnerTransferLock, which is open point B).
//
// WHAT WAS WRONG. The lock used to be published in TWO steps: `open(lockPath, "wx")` created the
// file, and `handle.writeFile(...)` filled it. Between those two awaits the lock EXISTS AND IS ZERO
// BYTES, and an intruder that hits EEXIST in that window reads "" in
// tryRecoverStaleOwnerTransferLock, whose `JSON.parse` throws, whose `catch` branch never asks
// whether the holder is alive, and which therefore unlinks a LIVE holder's lock as soon as any
// staged artifact is present. Two processes then believe they hold the same cross-process lock.
// Measured with two real Node processes hammering this function through affirmOwnerLease's
// compare-and-swap (.superpowers/sdd/2026-08-07-pkg2-data-loss/probe-c1/): with the steal branch
// reachable, the two-step publish produced lost updates in the HUNDREDS per 5s run (140 here; an
// independent reviewer measured 137/213/252 on other runs and machines), while the same probe
// against this atomic publish consumed thousands of CAS bases and produced ZERO. The counts are not
// reproducible constants — run length, machine and load move them — so the claim rests on that
// difference between arms, not on any single number; see the probe's own SENSITIVITY note.
//
// WHAT IS DIFFERENT NOW. The content is written to a per-process, per-attempt staging path first,
// and the lock is published by `link(stagingPath, lockPath)`. `link` is an atomic test-and-set: it
// either creates the new name or fails with EEXIST, and the name it creates is a second name for an
// inode that ALREADY HOLDS THE FULL CONTENT. There is no instant at which lockPath exists and is
// unparseable, so the steal branch is no longer reachable through this function's own publish.
//
// PLATFORM (human ruling 52): the target platforms are darwin and linux, and this is where that
// dependency is written down rather than left for the next reader to infer. It rests on POSIX
// link(2): "if the link named by the new argument exists, link() shall fail" — i.e. the existence
// check and the creation are one operation in the kernel. Windows is NOT a target; package.json
// carries the same statement in machine-readable form ("os": ["darwin", "linux"]).
//
// WHAT IS DELIBERATELY UNCHANGED: everything after an EEXIST (the tryRecoverStale... call, the
// two-iteration loop, OwnerTransferLockBusyError) and the non-EEXIST rethrow, by explicit
// instruction. `release()` was the still-open half of C-1 and is no longer unchanged: human ruling
// 62 gave it the identity check described above lockPathStillHoldsPublishedInode. The acquire path
// here is still byte-identical — the check costs no I/O before the publish and adds no statement
// between the publish and the return, which is the shape the scoped re-review's Imp-1 named.
async function acquireOwnerTransferLock(runDir: string): Promise<{ release: () => Promise<void> }> {
  const { lockPath } = getOwnerTransferPaths(runDir);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Fresh on every attempt, and unique per process: buildAtomicTempPath stamps the process id,
    // the process start time and a per-call sequence number, so two acquirers — in this process or
    // any other — can never stage into the same file. "w" rather than "wx" on purpose: this path is
    // this attempt's alone, so an EEXIST here would be meaningless, and letting one escape would be
    // read by the catch below as lock contention that never happened.
    const stagingPath = buildAtomicTempPath(lockPath);

    try {
      const handle = await open(stagingPath, "w");

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
        // The publish. EEXIST here means someone else holds the lock and is routed to the
        // unchanged branch below exactly as `open(lockPath, "wx")`'s EEXIST used to be.
        await link(stagingPath, lockPath);
      } catch (error) {
        await handle.close();
        await discardLockStaging(stagingPath);
        throw error;
      }

      // The lock is published; the staging name has done its job. The handle stays open on the same
      // inode, which is what release() closes.
      await discardLockStaging(stagingPath);

      return {
        release: async () => {
          // Before the close, because the check is an fstat on this handle and a closed handle
          // cannot answer it. The close itself keeps its original position ahead of the unlink.
          const stillOurs = await lockPathStillHoldsPublishedInode(handle, lockPath);
          await handle.close();

          if (!stillOurs) {
            await recordSkippedForeignLockRelease(runDir);
            return;
          }

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
  const {
    ownerPendingPath,
    transferPendingPath,
    reconciliationPendingPath,
    ownerTempPath,
    transferTempPath,
    reconciliationTempPath,
    ownerPendingTempPath,
    transferPendingTempPath,
    reconciliationPendingTempPath,
    transactionMarkerTempPath,
  } = getOwnerTransferPaths(runDir);
  await safeUnlink(ownerPendingPath);
  await safeUnlink(transferPendingPath);
  await safeUnlink(reconciliationPendingPath);
  await safeUnlink(ownerTempPath);
  await safeUnlink(transferTempPath);
  await safeUnlink(reconciliationTempPath);
  await safeUnlink(ownerPendingTempPath);
  await safeUnlink(transferPendingTempPath);
  await safeUnlink(reconciliationPendingTempPath);
  await safeUnlink(transactionMarkerTempPath);
}

type FinalizeFileTarget = {
  pendingPath: string;
  tempPath: string;
  targetPath: string;
};

// The only two legal finalizeOrder file sets, keyed by the version that declares them. Used
// exclusively to validate that a marker's finalizeOrder is a complete permutation of the set its
// own version promises — never to decide dispatch order or which pendings get read/published.
// That stays driven by finalizeOrder itself (see the comment on finalizePendingOwnerTransfer).
function legalFinalizeOrderFileNames(version: 1 | 2): ReadonlySet<TransactionFileName> {
  return version === 2
    ? new Set([OWNER_TRANSFER_FILE, OWNER_RECORD_FILE, RECONCILIATION_RECORD_FILE])
    : new Set([OWNER_TRANSFER_FILE, OWNER_RECORD_FILE]);
}

// A marker's finalizeOrder is well-formed only if it is a full permutation of its version's legal
// file set: same length as the legal set, no unrecognized names, no duplicates. finalizeOrder is
// read at runtime off a JSON.parse'd, merely type-asserted value, so nothing here is guaranteed by
// the TransactionFileName type at the boundary where this data enters the process.
function isValidFinalizeOrder(finalizeOrder: readonly string[], legalFileNames: ReadonlySet<TransactionFileName>): boolean {
  if (finalizeOrder.length !== legalFileNames.size) {
    return false;
  }

  const seen = new Set<string>();

  for (const fileName of finalizeOrder) {
    if (!legalFileNames.has(fileName as TransactionFileName) || seen.has(fileName)) {
      return false;
    }

    seen.add(fileName);
  }

  return true;
}

// §4.4 rule 1: marker is a field that gets READ, and finalize dispatches strictly off
// marker.finalizeOrder — the file set AND the order — never off marker.version. version stays a
// discriminant on the type (so v1's finalizeOrder can stay a fixed two-element tuple) and is read
// exactly once below, only to look up which file set finalizeOrder is required to permute — never
// to decide what finalize does. A v2 marker whose finalizeOrder someday omitted
// reconciliation-record.json (the type permits it, even though nothing produces it today) would
// be rejected by the validation below, not silently honored and not silently orphaning the
// omitted pending.
async function finalizePendingOwnerTransfer(runDir: string): Promise<void> {
  const paths = getOwnerTransferPaths(runDir);

  let marker: OwnerTransferTransactionMarker;

  try {
    marker = JSON.parse(await readFile(paths.transactionMarkerPath, "utf8")) as OwnerTransferTransactionMarker;
  } catch {
    // §4.4 rule 3: an unparseable marker is fail-closed — reject before anything is touched.
    throw new OwnerTransferMarkerUnreadableError("owner transfer transaction marker could not be read or parsed");
  }

  if (!isValidFinalizeOrder(marker.finalizeOrder, legalFinalizeOrderFileNames(marker.version))) {
    // Fail-closed, same as rules 2/3: nothing has been read or touched on disk yet. Without this,
    // a v2 marker whose finalizeOrder named only 2 of the 3 legal files would iterate exactly what
    // it names, publish those, delete the marker, and leave the omitted pending silently orphaned
    // with no error and no cleanup path pointing at it — strictly less safe than the pre-A3 code,
    // which ignored finalizeOrder and unconditionally handled all three v2 files.
    throw new OwnerTransferMarkerFinalizeOrderInvalidError(
      `owner transfer transaction marker's finalizeOrder is not a valid permutation of the v${marker.version} file set`,
    );
  }

  const fileTargets: Record<TransactionFileName, FinalizeFileTarget> = {
    [OWNER_TRANSFER_FILE]: { pendingPath: paths.transferPendingPath, tempPath: paths.transferTempPath, targetPath: paths.transferPath },
    [OWNER_RECORD_FILE]: { pendingPath: paths.ownerPendingPath, tempPath: paths.ownerTempPath, targetPath: paths.ownerPath },
    [RECONCILIATION_RECORD_FILE]: {
      pendingPath: paths.reconciliationPendingPath,
      tempPath: paths.reconciliationTempPath,
      targetPath: paths.reconciliationPath,
    },
  };

  const staged: Array<FinalizeFileTarget & { value: unknown }> = [];

  for (const fileName of marker.finalizeOrder) {
    const target = fileTargets[fileName];
    let value: unknown;

    try {
      value = JSON.parse(await readFile(target.pendingPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // §4.4 rule 2: fail-closed — a marker that promises this file but finds no pending for
        // it refuses to finalize, leaving the marker and every already-checked pending in place.
        throw new OwnerTransferPendingMissingError(
          `owner transfer pending file for ${fileName} is missing while finalizing a v${marker.version} marker`,
        );
      }

      throw error;
    }

    staged.push({ ...target, value });
  }

  try {
    for (const entry of staged) {
      await safeUnlink(entry.tempPath);
      await writeJsonFile(entry.tempPath, entry.value);
      await rename(entry.tempPath, entry.targetPath);
    }

    await safeUnlink(paths.transactionMarkerPath);

    for (const entry of staged) {
      await safeUnlink(entry.pendingPath);
    }
  } catch (error) {
    await safeUnlink(paths.transferTempPath);
    await safeUnlink(paths.ownerTempPath);
    await safeUnlink(paths.reconciliationTempPath);
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

  if (!options?.lockHeld) {
    let lock: { release: () => Promise<void> };

    try {
      lock = await acquireOwnerTransferLock(runDir);
    } catch {
      // Could not acquire: another process holds a live lock (OwnerTransferLockBusyError), or the
      // acquire attempt hit a non-EEXIST errno (e.g. EACCES/ENOSPC). Either way, this read must not
      // surface a new failure mode: readOwnerRecord's caller expects the read to succeed even when
      // recovery can't run right now, same as today's "busy -> skip recovery" behaviour.
      return;
    }

    try {
      await finalizePendingOwnerTransfer(runDir);
    } finally {
      await lock.release();
    }

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
  reconciliationRecord?: ReconciliationRecord,
): Promise<void> {
  const lock = await acquireOwnerTransferLock(runDir);

  try {
    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
    const persistedOwnerRecord = await readOwnerRecordRaw(runDir);

    if (!sameOwnerRecord(persistedOwnerRecord, expectedOwnerRecord)) {
      throw new OwnerTransferPreconditionError("persisted owner record changed before owner transfer could be applied");
    }

    const paths = getOwnerTransferPaths(runDir);
    const marker: OwnerTransferTransactionMarker =
      reconciliationRecord === undefined
        ? {
            version: 1,
            stagedAt: transferRecord.transferredAt,
            finalizeOrder: [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE],
          }
        : {
            version: 2,
            stagedAt: transferRecord.transferredAt,
            finalizeOrder: [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE, RECONCILIATION_RECORD_FILE],
          };

    await writeJsonFileViaFixedTemp(paths.transferPendingTempPath, paths.transferPendingPath, transferRecord);
    await writeJsonFileViaFixedTemp(paths.ownerPendingTempPath, paths.ownerPendingPath, ownerRecord);

    if (reconciliationRecord !== undefined) {
      await writeJsonFileViaFixedTemp(paths.reconciliationPendingTempPath, paths.reconciliationPendingPath, reconciliationRecord);
    }

    await writeJsonFileViaFixedTemp(paths.transactionMarkerTempPath, paths.transactionMarkerPath, marker);
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

// Same shape as writeOwnerRecordAtomically, generalized to a caller-supplied temp path: the
// owner-transfer transaction's three staged files (marker, owner-pending, transfer-pending)
// each need their own fixed temp name so cleanupOwnerTransferStagingWithoutMarker can find and
// remove leftovers by name after a crash. Deliberately not sharing writeJsonFileAtomically,
// whose buildAtomicTempPath stamps a process id and per-call sequence number into the temp
// name — that name is unrecoverable by any later process.
async function writeJsonFileViaFixedTemp(tempPath: string, targetPath: string, value: unknown): Promise<void> {
  await safeUnlink(tempPath);
  await writeJsonFile(tempPath, value);
  await rename(tempPath, targetPath);
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
