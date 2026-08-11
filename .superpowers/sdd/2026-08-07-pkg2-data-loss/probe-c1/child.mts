// C-1 contention probe, child process. One of two REAL Node processes hammering the PRODUCTION
// lock through a production entry point. Nothing here widens the lock's publish window and nothing
// plants a lock file by hand: every lock file that exists was created by fileStore.ts itself.
//
// THE METRIC IS A LOST UPDATE, NOT A TIMESTAMP OVERLAP. A first version of this probe counted
// overlapping call intervals and was thrown away: its must-NOT-hit control (no staged artifacts, so
// the steal branch is unreachable) reported 4364 "violations", i.e. the metric was measuring call
// interleaving, not mutual exclusion. What follows needs no clock at all.
//
// affirmOwnerLease -> updateOwnerRecordWithPrecondition is a compare-and-swap performed INSIDE the
// lock: read owner-record.json, compare it to `expected`, write the successor. Each successful
// affirm therefore consumes exactly one base value and produces exactly one successor. The caller
// supplies the successor's stamp, so each process stamps its writes with a globally unique id.
//
//   Under correct mutual exclusion the successful writes form a CHAIN: every success is based on
//   the value the previous success wrote, so NO BASE VALUE CAN BE CONSUMED TWICE. A second process
//   that got inside the lock at the same time reads the same base, passes the same comparison, and
//   writes over the first — a lost update, and the base id appears twice.
//
// So: violations = base ids consumed by more than one successful affirm. Values are unique by
// construction, so ABA cannot manufacture one. The metric UNDER-counts (a stolen lock only produces
// a duplicate base when the two critical sections interleave read-before-write), which is the safe
// direction for a claim of "0 after the fix" — and the must-hit control exists precisely to prove
// the probe can still fire on the fixed build.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { affirmOwnerLease } from "../../../../src/persistence/fileStore.js";
import type { OwnerRecord } from "../../../../src/runtime/types.js";

const [runDir, tag, durationMsRaw, outPath] = process.argv.slice(2);

const ownerPath = join(runDir, "owner-record.json");
const deadline = Date.now() + Number(durationMsRaw);
const successes: Array<{ base: string; wrote: string }> = [];
const outcomes: Record<string, number> = {};

let iteration = 0;

while (Date.now() < deadline) {
  iteration += 1;

  let expected: OwnerRecord;
  try {
    expected = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerRecord;
  } catch {
    outcomes.unreadableBase = (outcomes.unreadableBase ?? 0) + 1;
    continue;
  }

  // The successor's stamp is caller-supplied and stored verbatim, so this is a globally unique
  // value id. affirmOwnerLease writes it into lastAffirmedAt, which is what the next reader will
  // present as its base.
  const wrote = `${tag}#${iteration}`;

  try {
    await affirmOwnerLease(runDir, expected, wrote);
    successes.push({ base: String(expected.lastAffirmedAt), wrote });
    outcomes.affirmed = (outcomes.affirmed ?? 0) + 1;
  } catch (error) {
    const name = (error as Error).name;
    outcomes[name] = (outcomes[name] ?? 0) + 1;
  }
}

await writeFile(outPath, JSON.stringify({ tag, outcomes, successes }, null, 2));
