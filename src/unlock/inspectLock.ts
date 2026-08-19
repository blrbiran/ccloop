// L3 — the inspection half of `ccloop unlock` (human ruling 70 board C-d, held at fail-closed by
// human ruling 72; credential shape set by human ruling 73).
//
// This module ANSWERS and never deletes. Deletion lives in exactly one place, unlockCommand.ts, so
// that "may this lock go" and the act of removing it cannot drift apart.
//
// WHY IT DOES NOT CALL tryRecoverStaleOwnerTransferLock, even though that function asks a very
// similar question: that function's answer IS a deletion — it unlinks the lock on the way to
// returning true. A command whose entire purpose is to refuse cannot be built on a reader that
// takes the action first. Human ruling 50 also froze it byte-for-byte, so it could not be split.
//
// WHY THE TWO ANSWERS DISAGREE, and why that is deliberate rather than a bug (pointC-design.md
// §4.2, judgement 6): on a lock whose holder identity is unrecognizable, or one whose JSON is
// broken while staged artifacts exist, the redline function STEALS the lock and this command
// REFUSES it. The redline function runs unattended inside a transfer that has to make progress;
// this one runs because a human typed it. Fail-closed is the answer for the second (human ruling
// 72). The disagreement is recorded in both directions rather than resolved by making the
// dangerous one quieter.
//
// The liveness predicate is the bare-pid one and can be nothing else. pointC-design.md §4.2
// mutation C measured the alternative: "upgrading" the holder identity makes parsePid return null,
// which skips the liveness guard entirely. Hence fileStore's own parsePid/isProcessActive here,
// not a copy.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OWNER_TRANSFER_LOCK_FILE,
  type OwnerTransferLockRecord,
  isProcessActive,
  parsePid,
} from "../persistence/fileStore.js";

export type LockInspection =
  | { state: "absent" }
  | { state: "dead"; holder: string; pid: number; digest: string }
  | { state: "alive"; holder: string; pid: number; digest: string }
  | { state: "unrecognized-holder"; holder: string; digest: string }
  | { state: "unparseable"; reason: string; digest: string }
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
  try {
    // Read as bytes, not utf8. The digest human ruling 73 gates --force on is a digest of what is
    // ON DISK; hashing a decoded string would hash a lossy re-encoding of it, and the operator
    // computes theirs with shasum over the file.
    contents = await readFile(ownerTransferLockPath(runDir));
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
    return { state: "unparseable", reason: error instanceof Error ? error.message : String(error), digest };
  }

  const pid = holder === "" ? null : parsePid(holder);
  if (pid === null) {
    return { state: "unrecognized-holder", holder, digest };
  }

  return { state: isProcessActive(pid) ? "alive" : "dead", holder, pid, digest };
}
