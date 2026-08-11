// Keeps a residual staged artifact present for the duration of the run.
//
// Why this process exists, stated plainly rather than buried: the steal branch in
// tryRecoverStaleOwnerTransferLock only fires when `.owner-transfer.transaction.json`,
// `.owner-record.pending.json` or `.owner-transfer.pending.json` exists. The production critical
// section itself removes them — recoverInterruptedOwnerTransfer({lockHeld:true}) with no marker
// calls cleanupOwnerTransferStagingWithoutMarker — so a single crashed transfer's residue is
// consumed by the first admitted call and the precondition would hold for one iteration only.
// This process re-creates it, which is the probe holding its fixture, NOT widening any window: the
// lock's publish window is untouched and no lock file is ever written by anything but fileStore.ts.
import { writeFile } from "node:fs/promises";

const [pendingPath, durationMsRaw] = process.argv.slice(2);
const deadline = Date.now() + Number(durationMsRaw);
let restaged = 0;

while (Date.now() < deadline) {
  await writeFile(pendingPath, JSON.stringify({ currentOwnerEpoch: 2 }, null, 2));
  restaged += 1;
}

process.stdout.write(`${JSON.stringify({ restaged })}\n`);
