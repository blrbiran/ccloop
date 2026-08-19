// L3 — the sweep's owner-transfer lock probe (human ruling 70, board C-a).
//
// PRESENCE ONLY, and the restriction is the design rather than an omission. This asks the
// filesystem whether the lock path exists and answers a boolean. It does not read the file, parse
// it, extract the holder identity or judge whether that holder is alive:
//
//   - reading and parsing it would be a SECOND JSON reading implementation for this file, which
//     spec §7.2 exists to prevent ("bind the same pure readers fileStore already runs, so that no
//     second implementation drifts against the first"). The only existing one lives inside
//     tryRecoverStaleOwnerTransferLock, and human ruling 50 froze that function byte-for-byte —
//     so the choice was a forbidden second implementation, a frozen first one, or neither.
//   - judging liveness in a reporting path would put a decision where an observation belongs. The
//     line this feeds says a lock is on disk; deciding whether it is dead is a different command's
//     job, and one a human is meant to approve (board C-d).
//
// It lives in its own module, next to the sweep rather than inside sweepRuns.ts, for the same
// reason `defaultScan` / `defaultScanDeps` live in registry/scanRuns.ts: sweepRuns is a pure
// function over injected dependencies (§3 #1) and imports no filesystem module of its own.

import { access } from "node:fs/promises";
import { join } from "node:path";
import { OWNER_TRANSFER_LOCK_FILE } from "../persistence/fileStore.js";

export async function defaultLockPresence(runDir: string): Promise<boolean> {
  try {
    await access(join(runDir, OWNER_TRANSFER_LOCK_FILE));
    return true;
  } catch {
    // Every failure means the same thing to this caller: nothing is reportable here. ENOENT is the
    // ordinary answer; EACCES on the directory is one this sweep cannot do anything about either,
    // and turning it into a louder failure would make an unreadable directory able to stop a sweep
    // that §7 says only its own root may stop.
    return false;
  }
}
