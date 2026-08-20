// L3 — the acting half of `ccloop unlock` (human ruling 70 board C-d, held at fail-closed by human
// ruling 72; --force credential set by human ruling 73).
//
// THE ONLY PLACE IN THIS COMMAND THAT DELETES. inspectLock.ts answers and never acts; everything
// that decides whether the answer authorizes a deletion is here, in one branch statement, so that
// a future edit cannot add a second route to the unlink without walking past it.
//
// Fail-closed, restated because it is the whole design: a state this code cannot interpret is a
// state it refuses. The cost is real and was measured before it was chosen — pointC-design.md
// §8.5 found that a `{not json` lock with no staged artifacts is stranded on disk forever by the
// normal transfer path, and this command refuses that same shape. That intersection is the entire
// reason --force exists. Human ruling 72 weighed it against the alternative (delete what you
// cannot read) and held fail-closed, because "unreadable" does not mean "unheld": a lock whose
// bytes were truncated mid-write still belongs to a process that may be running, and losing that
// process's work is the failure mode this whole package is about.
//
// --force is gated on a digest of the lock's bytes rather than on the holder id C-d first named,
// because the one cell that genuinely needs it is the cell with no readable holder id (human
// ruling 73). It proves the operator looked at this lock — and, since a changed lock produces a
// changed digest, it also refuses a lock that was replaced between the looking and the typing.
//
// A LIVE HOLDER IS NEVER REMOVED, --force INCLUDED. Human ruling 70's C-e says pin that a live pid
// is never deleted, and the strongest reading is that no path reaches the unlink. The hatch exists
// for locks that are permanently stranded; a live holder's lock is not stranded, it is released
// when that process exits. So the live case is checked before the credential is even considered,
// and the refusal deliberately prints no --force line to copy.

import { stat, unlink } from "node:fs/promises";
import { type LockIdentity, inspectOwnerTransferLock, ownerTransferLockPath } from "./inspectLock.js";

export type UnlockOptions = {
  runDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
} & (
  | { force: false }
  // The credential is required by the TYPE when force is set, so `--force` with nothing to check
  // against cannot be constructed here at all — it is rejected in parseArgs, and this makes the
  // rejection structural rather than a second runtime check that could be forgotten.
  | { force: true; expectedDigest: string }
);

// The errno is carried, not collapsed into the word "unremovable". This command exists so that a
// HUMAN can get a stuck run moving again; telling them "could not be removed" while discarding
// whether it was EACCES, EPERM, EIO or ENOTEMPTY leaves them with nothing to act on — which is the
// shape this project keeps naming as a silent failure.
export type LockRemoval =
  | { outcome: "removed" }
  | { outcome: "changed" }
  | { outcome: "gone" }
  | { outcome: "unremovable"; reason: string };

// Both catches in removeLockIfUnchanged take their reason through here, so that "the same way" is
// structural rather than two hand-copies of one expression — copies are how the two catches drifted
// apart in the first place, and the next edit could split them again just as quietly.
//
// String() is NOT total: it throws on an object with a null prototype. A delete path that throws out
// of its own catch reports "the command crashed" instead of "the lock is still there", which is the
// substitution this whole function is written to avoid, so the fallback keeps even that case a
// value. Neither branch is reachable through node:fs, which always rejects with an Error; both are
// pinned by tests against a mock, because the comments here claim the property.
function reasonFrom(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

// The deletion re-checks WHICH FILE the name holds, not merely that a name is there. Both
// independent reviews of this command found the same defect: the inspection reads the lock, and the
// unlink that followed named only the path. Between the two, a legitimate concurrent recovery can
// reclaim a dead holder's lock and publish a fresh, LIVE one at the same name — and this command
// would then delete it while reporting `removed  holder=... was not alive`, a false statement about
// a live holder's lock.
//
// This is the bug class human ruling 62 already fixed once, for release(): it "used to unlink
// `lockPath` unconditionally: whatever file bore that name at that instant was deleted", measured on
// `dbac288`. The technique is the one recorded there — compare (dev, ino), both halves load-bearing
// because an inode number identifies a file only within one filesystem.
//
// WHAT THIS DOES NOT DO, stated because the same comment in fileStore states it: the stat and the
// unlink are still two syscalls, so a replacement landing between THEM is undetectable. The window
// goes from "the whole inspection" down to "two adjacent syscalls". It is not closed.
export async function removeLockIfUnchanged(lockPath: string, identity: LockIdentity): Promise<LockRemoval> {
  let onDisk;
  try {
    onDisk = await stat(lockPath);
  } catch (error) {
    // Already off disk is not a failure to report as one: someone else cleared it, which is the
    // outcome this command wanted anyway. Every OTHER errno is a failure, and keeps its name.
    //
    // Optional-chained, because this catch may be handed something that is not an object at all. It
    // read `.code` unguarded until a review measured what that costs: a rejection of null threw a
    // TypeError out of a delete path, which is the "the command crashed" answer the catch below
    // exists to prevent. One function must not disagree with itself about whether the value it
    // caught can be trusted.
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { outcome: "gone" };
    }

    return { outcome: "unremovable", reason: reasonFrom(error) };
  }

  if (onDisk.dev !== identity.dev || onDisk.ino !== identity.ino) {
    return { outcome: "changed" };
  }

  try {
    await unlink(lockPath);
  } catch (error) {
    // Nothing was deleted, and a rejection escaping a delete path would be reported as "the command
    // crashed" rather than "the lock is still there" — which is the fact the operator needs. It is
    // turned into a value rather than swallowed outright, so the reason survives to the output.
    return { outcome: "unremovable", reason: reasonFrom(error) };
  }

  return { outcome: "removed" };
}

function forceLine(runDir: string, digest: string): string {
  // Human ruling 72 attached this to the fail-closed decision: the refusal hands over a command
  // line with the digest already computed, so the honest cost of fail-closed ("a human has to read
  // the scene") is one paste rather than a research task.
  return `         to override: ccloop unlock ${runDir} --force --expect ${digest}`;
}

export async function unlockOwnerTransferLock(options: UnlockOptions): Promise<number> {
  const { runDir, stdout, stderr } = options;
  const inspection = await inspectOwnerTransferLock(runDir);

  if (inspection.state === "absent") {
    stdout("absent   no owner-transfer lock present");
    return 0;
  }

  if (inspection.state === "file-unreadable") {
    stderr(`refused  lock file unreadable: ${inspection.reason}`);
    stderr("         --force is unavailable here: its credential is a digest of the lock's bytes,");
    stderr("         and these bytes cannot be read");
    return 1;
  }

  // Before the credential, on purpose. See the header: no --force route may exist past this point.
  if (inspection.state === "alive") {
    stderr(`refused  pid ${inspection.pid} is alive`);
    stderr(`         --force cannot remove a live holder's lock; wait for pid ${inspection.pid} to exit`);
    return 1;
  }

  if (inspection.state === "dead") {
    const removal = await removeLockIfUnchanged(ownerTransferLockPath(runDir), inspection.identity);
    if (removal.outcome !== "removed") {
      return reportFailedRemoval(removal, stdout, stderr);
    }

    stdout(`removed  holder=${inspection.holder} was not alive`);
    return 0;
  }

  const refusal =
    inspection.state === "unrecognized-holder"
      ? `refused  unrecognized holder identity: ${inspection.holder}`
      : inspection.state === "liveness-unknown"
        ? // Distinct from both neighbours on purpose. "unreadable" would be a false statement — the
          // record parsed fine and named a holder; what failed was the probe. An operator told the
          // wrong reason looks for the wrong fix.
          `refused  cannot determine whether pid ${inspection.pid} is alive: ${inspection.reason}`
        : `refused  lock unreadable: ${inspection.reason}`;

  if (!options.force) {
    stderr(refusal);
    stderr(forceLine(runDir, inspection.digest));
    return 1;
  }

  if (options.expectedDigest !== inspection.digest) {
    stderr("refused  --expect does not match the lock on disk");
    stderr(`         on disk: ${inspection.digest}`);
    return 1;
  }

  const removal = await removeLockIfUnchanged(ownerTransferLockPath(runDir), inspection.identity);
  if (removal.outcome !== "removed") {
    return reportFailedRemoval(removal, stdout, stderr);
  }

  // Deliberately not the shape the criterion-authorized removal prints. An operator reading a log
  // has to be able to tell "the liveness criterion authorized this" from "a human overrode it",
  // and a shared wording would erase that distinction at exactly the place it matters most.
  stdout(
    inspection.state === "unrecognized-holder"
      ? `removed  forced past unrecognized holder identity: ${inspection.holder}`
      : inspection.state === "liveness-unknown"
        ? `removed  forced past undetermined liveness of pid ${inspection.pid}`
        : "removed  forced past unreadable lock contents",
  );
  return 0;
}

// `gone` is the only one of the three that is not a refusal: the lock this command was asked to
// clear is off disk, which is what the operator wanted. It still must not print `removed`, because
// this invocation did not remove it and an audit line saying otherwise would be false.
function reportFailedRemoval(
  removal: Exclude<LockRemoval, { outcome: "removed" }>,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): number {
  if (removal.outcome === "gone") {
    stdout("absent   the lock was already off disk by the time it would have been removed");
    return 0;
  }

  if (removal.outcome === "changed") {
    stderr("refused  the lock changed on disk between being read and being removed");
    stderr("         the file now at that name is not the one that was inspected; nothing was deleted");
    return 1;
  }

  stderr(`refused  the lock could not be removed: ${removal.reason}`);
  stderr("         nothing was deleted");
  return 1;
}
