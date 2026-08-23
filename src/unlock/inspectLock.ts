// L3 — the inspection half of `ccloop unlock` (human ruling 70 board C-d, held at fail-closed by
// human ruling 72; credential shape set by human ruling 73).
//
// This module ANSWERS and never deletes. Deletion lives in exactly one place, unlockCommand.ts, so
// that "may this lock go" and the act of removing it cannot drift apart.
//
// WHY IT DOES NOT CALL tryRecoverStaleOwnerTransferLock, even though that function asks a very
// similar question: that function's answer IS a deletion — it unlinks the lock on the way to
// returning true. A command whose entire purpose is to refuse cannot be built on a reader that
// takes the action first. That reason is the load-bearing one and is unaffected by anything below.
// Human ruling 50 also froze it byte-for-byte, so it could not be split — *** that freeze has since
// been lifted for point B alone (human ruling 83); the first reason still stands on its own. ***
//
// WHY THE TWO ANSWERS DISAGREE, and why that is deliberate rather than a bug (pointC-design.md
// §4.2, judgement 6): on a lock whose holder identity is unrecognizable, or one whose JSON is
// broken while staged artifacts exist, the redline function STEALS the lock and this command
// REFUSES it. The redline function runs unattended inside a transfer that has to make progress;
// this one runs because a human typed it. Fail-closed is the answer for the second (human ruling
// 72). The disagreement is recorded in both directions rather than resolved by making the
// dangerous one quieter.
//
// *** ERRATUM (point B, HUMAN RULING 83) — THE PARAGRAPH ABOVE HAS LOST ITS PREMISE, and is kept
// verbatim because it records the design as it was argued. On BOTH cases it names — an
// unrecognizable holder identity, and broken JSON with staged artifacts present — the redline
// function no longer steals: it fails closed and refuses, exactly as this command does. So on those
// two cases the two answers now AGREE, and the reason this module keeps its own reader is the first
// one above (a reader that deletes cannot serve a command that refuses), not a disagreement.
// ⚠️ WHAT THIS ERRATUM DOES NOT CLAIM: that the two answers agree everywhere. The full cell-by-cell
// comparison has NOT been re-measured since ruling 83, and the two still ask different questions —
// this command classifies liveness in three states (human ruling 74: pid:0, an overflowing pid and
// EPERM are `liveness-unknown`), while the redline function's isProcessActive has two and reads all
// three as alive. Both directions happen to refuse on those inputs today, but that is a coincidence
// of two different predicates, not one shared answer. ***
//
// The liveness predicate is the bare-pid one and can be nothing else. pointC-design.md §4.2
// mutation C measured the alternative: "upgrading" the holder identity makes parsePid return null,
// which skips the liveness guard entirely. Hence fileStore's own parsePid/isProcessActive here,
// not a copy.

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { OWNER_TRANSFER_LOCK_FILE, type OwnerTransferLockRecord, parsePid } from "../persistence/fileStore.js";

// WHICH FILE, not which path. Every state that can authorize a deletion carries the (dev, ino) of
// the file this inspection actually read, so the deletion can re-check that the name still holds
// that same file. Human ruling 62 fixed the identical bug class in release(): it "used to unlink
// `lockPath` unconditionally: whatever file bore that name at that instant was deleted", measured
// on `dbac288`. `dev` is load-bearing alongside `ino` for the reason recorded there — an inode
// number identifies a file only within one filesystem.
export type LockIdentity = { dev: number; ino: number };

// Three outcomes, not two. fileStore's isProcessActive collapses every non-ESRCH result into
// "alive", which is the correct collapse THERE — the redline recovery function must never steal a
// lock it is unsure about. It is the wrong collapse here (human ruling 74): unlockCommand consults
// `alive` before it consults the credential, so a false "alive" produces a lock with no escape
// hatch at all. Measured cases: `pid:0` (kill(0, 0) signals the caller's own process group and does
// not throw), a pid too large to be one (TypeError, not an errno), and a pid owned by another user
// (EPERM). None of those is evidence that the holder is running.
//
// This is the SAME syscall fileStore uses, called the same way. What is not reused is the collapse
// — which is what judgement 5 of pointC-design.md §4.2 forbids reimplementing, and this does not:
// the liveness question is still `process.kill(pid, 0)` and the identity form is still parsePid's.
export type LivenessVerdict =
  | { verdict: "alive" }
  | { verdict: "dead" }
  | { verdict: "unknown"; reason: string };

export function classifyHolderLiveness(pid: number): LivenessVerdict {
  // Guarded before the syscall, because kill(0, ...) is not a query about a process at all: POSIX
  // gives pid 0 the meaning "every process in the caller's process group". It cannot throw ESRCH,
  // so it can never answer "dead", and taking its silence for "alive" strands the lock forever.
  if (pid < 1) {
    return { verdict: "unknown", reason: `pid ${pid} does not name a process that can be probed` };
  }

  try {
    process.kill(pid, 0);
    return { verdict: "alive" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return { verdict: "dead" };
    }

    // EPERM (someone else's process), ERR_INVALID_ARG_TYPE / ERR_OUT_OF_RANGE (a number too large
    // to be a pid), and anything else: the probe failed, which is not the same as it succeeding.
    return { verdict: "unknown", reason: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

export type LockInspection =
  | { state: "absent" }
  | { state: "dead"; holder: string; pid: number; digest: string; identity: LockIdentity }
  | { state: "alive"; holder: string; pid: number; digest: string; identity: LockIdentity }
  | { state: "liveness-unknown"; holder: string; pid: number; reason: string; digest: string; identity: LockIdentity }
  | { state: "unrecognized-holder"; holder: string; digest: string; identity: LockIdentity }
  | { state: "unparseable"; reason: string; digest: string; identity: LockIdentity }
  // The only state with no digest, and therefore the only one human ruling 73's --force cannot
  // reach: the credential is a hash of the file's bytes, and these bytes are unreachable. Saying
  // so is honest; inventing a substitute credential would be a second, weaker escape hatch.
  | { state: "file-unreadable"; reason: string };

export function ownerTransferLockPath(runDir: string): string {
  return join(runDir, OWNER_TRANSFER_LOCK_FILE);
}

export function digestLockContents(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function inspectOwnerTransferLock(runDir: string): Promise<LockInspection> {
  let contents: Buffer;
  let identity: LockIdentity;
  try {
    // Opened once and both facts taken from the SAME descriptor: fstat for the identity, then the
    // bytes. Doing it as stat-then-readFile would leave a window between them in which the name
    // could come to hold a different file, and the inspection would then report one file's contents
    // under another file's identity — which is the very confusion the identity exists to prevent.
    //
    // Read as bytes, not utf8. The digest human ruling 73 gates --force on is a digest of what is
    // ON DISK; hashing a decoded string would hash a lossy re-encoding of it, and the operator
    // computes theirs with shasum over the file.
    const handle = await open(ownerTransferLockPath(runDir), "r");
    try {
      const stats = await handle.stat();
      identity = { dev: stats.dev, ino: stats.ino };
      contents = await handle.readFile();
    } finally {
      // Swallowed on purpose, and this is the discipline this repository already wrote down for
      // itself at fileStore.ts:776 — "a cleanup failure must not replace the error the caller needs
      // to see". Here it would be worse than losing an error: this close() sits inside the same try
      // whose catch produces `file-unreadable`, so a close() failure after a PERFECTLY GOOD read
      // would be reported as an unreadable lock. And `file-unreadable` is the one state with no
      // digest, hence the one state with no --force route — a failed close would take the escape
      // hatch away from a lock that was entirely readable. A leaked descriptor in a CLI that is
      // about to exit is the smaller loss by a wide margin.
      await handle.close().catch(() => {});
    }
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return { state: "absent" };
    }

    return { state: "file-unreadable", reason: errno.message };
  }

  const digest = digestLockContents(contents);

  let holder: string;
  try {
    const parsed = JSON.parse(contents.toString("utf8")) as Partial<OwnerTransferLockRecord>;
    // `JSON.parse("null")` succeeds and the property read below throws a TypeError, which belongs
    // with the parse failures rather than escaping as a crash — the same grouping the redline
    // function gets from having one catch around both.
    holder = parsed.holderProcessInstanceId ?? "";
  } catch (error) {
    return {
      state: "unparseable",
      reason: error instanceof Error ? error.message : String(error),
      digest,
      identity,
    };
  }

  const pid = holder === "" ? null : parsePid(holder);
  if (pid === null) {
    return { state: "unrecognized-holder", holder, digest, identity };
  }

  const liveness = classifyHolderLiveness(pid);
  if (liveness.verdict === "unknown") {
    return { state: "liveness-unknown", holder, pid, reason: liveness.reason, digest, identity };
  }

  return { state: liveness.verdict === "alive" ? "alive" : "dead", holder, pid, digest, identity };
}
