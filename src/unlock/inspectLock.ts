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
// *** ERRATUM (point B, human ruling 83): the two sentences above are kept verbatim. That freeze
// has since been lifted, for point B alone. The first reason — a reader whose answer IS a deletion
// cannot serve a command whose whole job is to refuse — is load-bearing and unaffected by it. ***
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
// *** ERRATUM (I-2, HUMAN RULING 127) -- kept verbatim, and one clause in it was TOO WIDE WHEN
// WRITTEN rather than overtaken later. "On BOTH cases it names -- an unrecognizable holder
// identity, ... -- the redline function no longer steals" was measured on holders that are
// STRINGS. A holder that is not a string at all -- `["pid:999999"]`, which String()s into
// `pid:999999` -- was unrecognizable in exactly the same sense, and on that sub-cell BOTH sides
// deleted: the redline function unlinked, and this command's `dead` branch removed the lock with
// no --force and no --expect. Ruling 127 made the sentence true for that sub-cell too, by giving
// parsePid a type guard and by classifying the value the record carries rather than a rendering
// of it. The sentence is now what it always claimed to be. ***
//
// The liveness predicate is the bare-pid one and can be nothing else. pointC-design.md §4.2
// mutation C measured the alternative: "upgrading" the holder identity makes parsePid return null,
// which skips the liveness guard entirely. Hence fileStore's own parsePid/isProcessActive here,
// not a copy.
//
// *** ERRATUM (I-3, human ruling 100): the direction reversed here too. The paragraph above is
// kept verbatim because it records what mutation C measured under ruling 50. "Skips the liveness
// guard entirely" is still literally true — a null pid short-circuits `pid === null ||
// isProcessActive(pid)` before isProcessActive is ever called — but under human ruling 83 skipping
// it no longer means falling through to the unlink: the guard REFUSES first. The failure that
// alternative would cause is now an unconditional lock REFUSER, not a stealer. The reason to reuse
// fileStore's own predicates rather than grow a second one is unchanged. The other errata in this
// file carry that correction already; this paragraph was missed until the human ruling 96 review
// found it. ***
//
// *** ERRATUM (I-2, HUMAN RULING 127) -- the paragraph above is kept verbatim. The clause "a null
// pid short-circuits `pid === null || isProcessActive(pid)`" named an expression that no longer
// appears in this module in that form: this function calls classifyHolderLiveness, not
// isProcessActive, and does not combine that call with `pid === null` in one expression. What the
// clause is about -- a null pid short-circuits before any liveness probe runs -- is still how this
// module's control flow behaves; only the literal expression it quotes is gone. Where that control
// flow lives now is recorded in the ledger, not here. ***
//
// *** ERRATUM (ls lock visibility, HUMAN RULING 132) -- the closing sentence of the human-ruling-83
// erratum above ("the redline function's isProcessActive has two [states] and reads all three as
// alive") is kept verbatim and was true when written. It no longer describes the redline function:
// `tryRecoverStaleOwnerTransferLock` now asks the SAME three-state question this module asks
// (`classifyProcessLiveness`, the function `classifyHolderLiveness` below re-exports), and pid:0,
// an overflowing pid and an EPERM refusal are no longer folded into "alive" there -- they take
// their own `liveness-undetermined` exit, refused but not deleted and not called busy either. The
// two modules' predicates are no longer "two different predicates" that happen to agree; they are
// the same predicate. Full detail is recorded at the "Three outcomes, not two" erratum below. ***

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  OWNER_TRANSFER_LOCK_FILE,
  type OwnerTransferLockRecord,
  classifyProcessLiveness,
  type LivenessVerdict,
  parsePid,
} from "../persistence/fileStore.js";

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
//
// *** ERRATUM (ls lock visibility, HUMAN RULING 132) -- the paragraphs above are kept verbatim and
// their reasoning is unchanged: the three-state question still belongs to this module's callers,
// and the two-state collapse is still the right one where a deletion is authorized. What changed
// is location only. The classifier now lives in fileStore so that the redline function can ask the
// same question from the same single implementation; importing it back from here would close the
// cycle fileStore already refuses to close for its retry constants. Sentences above that read as
// "fileStore has two states and this module has three" now describe two EXPORTS of one module, not
// two implementations. The ledger for this round records the rest. ***
export type { LivenessVerdict };

// The implementation moved down into fileStore (human ruling 132). The name stays here because
// this module is where the three-state question is ASKED; what moved is only where it lives, so
// that the redline function can ask it too without importing back across the layer boundary.
export const classifyHolderLiveness = classifyProcessLiveness;

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

  // TWO values, not one, and this split is load-bearing. `rawHolder` is what the record actually
  // holds and it is what gets CLASSIFIED; `holder` is a rendering of it and it is only ever
  // DISPLAYED. Collapsing them back into one variable silently disarms parsePid's type guard on
  // this path: the rendering would turn an array into a string before parsePid ever saw it, and
  // the guard would stop being reachable. Measured 2026-09-23 -- with them collapsed, deleting
  // parsePid's guard changes nothing here at all.
  //
  // The regression this guards against is narrower than "delete the guard" and easier to miss:
  // leave parsePid's type guard exactly where it is, and just change the call below to pass
  // `holder` instead of `rawHolder`. That alone typechecks clean -- `tsc` exits 0 -- and the suite
  // shows no NEW red: measured 2026-09-23, 778/779 tests still pass, and the one failure is the
  // pre-existing, unrelated stopProof timeout already on this repo's known-red list. The only
  // things standing between an operator and that regression are this comment and the M1 mutation
  // entry in the ledger.
  let holder: string;
  let rawHolder: unknown;
  try {
    // `unknown` per field, not `string`: this is JSON, and the record's declared field types are
    // a statement about what WE write, not about what is on disk. OwnerTransferLockRecord itself
    // is unchanged -- only this read is honest about what it got.
    const parsed = JSON.parse(contents.toString("utf8")) as Partial<Record<keyof OwnerTransferLockRecord, unknown>>;
    // `JSON.parse("null")` succeeds and the property read below throws a TypeError, which belongs
    // with the parse failures rather than escaping as a crash — the same grouping the redline
    // function gets from having one catch around both.
    rawHolder = parsed.holderProcessInstanceId ?? "";
    // AFTER the `??`, never before. TypeScript declares JSON.stringify's return type as `string`
    // rather than `string | undefined`, so a `undefined` slipping through here would reach the
    // operator as the word "undefined" with tsc saying nothing. Past the `??` the value is
    // always a JSON value, and no JSON value makes JSON.stringify return undefined.
    holder = typeof rawHolder === "string" ? rawHolder : JSON.stringify(rawHolder);
  } catch (error) {
    return {
      state: "unparseable",
      reason: error instanceof Error ? error.message : String(error),
      digest,
      identity,
    };
  }

  const pid = rawHolder === "" ? null : parsePid(rawHolder);
  if (pid === null) {
    return { state: "unrecognized-holder", holder, digest, identity };
  }

  const liveness = classifyHolderLiveness(pid);
  if (liveness.verdict === "unknown") {
    return { state: "liveness-unknown", holder, pid, reason: liveness.reason, digest, identity };
  }

  return { state: liveness.verdict === "alive" ? "alive" : "dead", holder, pid, digest, identity };
}
