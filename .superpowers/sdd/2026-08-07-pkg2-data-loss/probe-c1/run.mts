// C-1 contention probe, parent. Stages one run directory, spawns two REAL Node processes that
// hammer the production lock through affirmOwnerLease's compare-and-swap, and counts LOST UPDATES:
// base values consumed by more than one successful affirm. See child.mts for why that is exactly
// "two processes were inside the lock at once" and why the earlier timestamp-overlap metric was
// discarded.
//
// Modes:
//   staged     - a residual staged artifact is kept present (stager.mts), so
//                tryRecoverStaleOwnerTransferLock's `catch { hasStagedArtifacts }` steal branch is
//                reachable. This is the measurement.
//   nostaged   - MUST-NOT-HIT control: identical hammering, no staged artifact, so the steal branch
//                cannot fire. Must read 0 on every build; a non-zero here would mean the metric
//                itself is unsound.
//   truncated  - MUST-HIT control: staged artifact plus a process truncating the lock file to zero
//                bytes from outside. An unparseable lock reaches the same steal branch by a route
//                the fix does not claim to close (that branch is open point B and was not touched),
//                so this must read > 0 even on the FIXED build. Without it, "0 after the fix" would
//                be an unverified negative.
//
// SENSITIVITY — READ THIS BEFORE CONCLUDING ANYTHING FROM A SINGLE RUN. An independent reviewer
// measured the must-hit control's rate at roughly 0.3 violations per second: at the 5s default it
// frequently reads ZERO, and only at 10s per run, repeated, does it settle into a stable 1-4. Zero
// is also exactly what a BROKEN probe looks like, so a short truncated run is the easiest way for a
// later reader to misdiagnose this as "the control cannot fire".
//   - Run `truncated` for at least 10000ms, and repeat it; treat single-digit counts as the
//     expected magnitude, not as a weak result.
//   - No count printed by this probe is a reproducible constant. They depend on run length, machine
//     and load: the same `staged` baseline has been measured at 140, 137, 213 and 252 across
//     machines and runs. What is reproducible, and what the C-1 claim actually rests on, is the
//     DIFFERENCE between arms: thousands of CAS bases consumed with a non-zero violation count
//     before the fix, versus thousands consumed with exactly zero after it.
// The parent prints a warning below when `truncated` is run too briefly, so nobody has to remember
// this paragraph.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const mode = process.argv[2] ?? "staged";
const durationMs = Number(process.argv[3] ?? "4000");

if (mode === "truncated" && durationMs < 10000) {
  process.stderr.write(
    `WARNING: the must-hit control fires at roughly 0.3/s; at ${durationMs}ms a reading of 0 is `
      + "common and does NOT mean the probe cannot fire. Use >= 10000ms and repeat.\n",
  );
}

const runDir = await mkdtemp(join(tmpdir(), "ccloop-c1-probe-"));
await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
  runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 1,
  currentProcessInstanceId: "pid:probe", lastAffirmedAt: "GENESIS",
  ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: null,
}, null, 2));

type ChildResult = { tag: string; outcomes: Record<string, number>; successes: Array<{ base: string; wrote: string }> };

const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
const outA = join(runDir, "probe-a.json");
const outB = join(runDir, "probe-b.json");

const children = [
  execFileAsync(tsx, [join(here, "child.mts"), runDir, "A", String(durationMs), outA]),
  execFileAsync(tsx, [join(here, "child.mts"), runDir, "B", String(durationMs), outB]),
];

if (mode !== "nostaged") {
  children.push(
    execFileAsync(tsx, [join(here, "stager.mts"), join(runDir, ".owner-record.pending.json"), String(durationMs)]),
  );
}

if (mode === "truncated") {
  children.push(
    execFileAsync(tsx, [join(here, "truncator.mts"), join(runDir, ".owner-transfer.lock"), String(durationMs)]),
  );
}

await Promise.all(children);

const a = JSON.parse(await readFile(outA, "utf8")) as ChildResult;
const b = JSON.parse(await readFile(outB, "utf8")) as ChildResult;

const consumers = new Map<string, string[]>();
for (const { base, wrote } of [...a.successes, ...b.successes]) {
  consumers.set(base, [...(consumers.get(base) ?? []), wrote]);
}

const lostUpdates = [...consumers.entries()].filter(([, writers]) => writers.length > 1);

process.stdout.write(`${JSON.stringify({
  mode,
  durationMs,
  runDir,
  a: { outcomes: a.outcomes, affirmed: a.successes.length },
  b: { outcomes: b.outcomes, affirmed: b.successes.length },
  distinctBasesConsumed: consumers.size,
  // The measurement: a base value that two successful affirms both built on. Impossible while the
  // lock excludes, because the second one's in-lock re-read would have seen the first one's write.
  mutualExclusionViolations: lostUpdates.length,
  firstFiveViolations: lostUpdates.slice(0, 5),
}, null, 2)}\n`);
