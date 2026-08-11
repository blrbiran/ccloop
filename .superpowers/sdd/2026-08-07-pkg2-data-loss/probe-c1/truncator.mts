// Must-hit control, external half. Continuously truncates .owner-transfer.lock to zero bytes from
// OUTSIDE the process under test, which is a corruption source the fix cannot and does not claim to
// prevent: an unparseable lock still sends an intruder into tryRecoverStaleOwnerTransferLock's
// `catch` branch, which still steals whenever staged artifacts exist (that branch is open point B
// and was deliberately not touched).
//
// Its whole job is to prove the probe can still FIRE against the fixed build. Without it, "0
// violations after the fix" would be an unverified negative.
import { truncate } from "node:fs/promises";

const [lockPath, durationMsRaw] = process.argv.slice(2);
const deadline = Date.now() + Number(durationMsRaw);
let truncated = 0;

while (Date.now() < deadline) {
  try {
    await truncate(lockPath, 0);
    truncated += 1;
  } catch {
    // ENOENT most of the time: no lock is held at this instant. Nothing to do.
  }
}

process.stdout.write(`${JSON.stringify({ truncated })}\n`);
