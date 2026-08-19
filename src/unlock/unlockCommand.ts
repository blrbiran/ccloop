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

import { unlink } from "node:fs/promises";
import { inspectOwnerTransferLock, ownerTransferLockPath } from "./inspectLock.js";

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
    await unlink(ownerTransferLockPath(runDir));
    stdout(`removed  holder=${inspection.holder} was not alive`);
    return 0;
  }

  const refusal =
    inspection.state === "unrecognized-holder"
      ? `refused  unrecognized holder identity: ${inspection.holder}`
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

  await unlink(ownerTransferLockPath(runDir));
  // Deliberately not the shape the criterion-authorized removal prints. An operator reading a log
  // has to be able to tell "the liveness criterion authorized this" from "a human overrode it",
  // and a shared wording would erase that distinction at exactly the place it matters most.
  stdout(
    inspection.state === "unrecognized-holder"
      ? `removed  forced past unrecognized holder identity: ${inspection.holder}`
      : "removed  forced past unreadable lock contents",
  );
  return 0;
}
