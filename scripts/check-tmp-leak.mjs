#!/usr/bin/env node
// Runs the suite with TMPDIR pointed at a fresh, empty directory and fails if anything is left in it.
//
//   node scripts/check-tmp-leak.mjs [extra vitest args]
//
// Exit 0: the suite ran and left nothing behind. Exit 1: it left entries (listed, directory kept for
// inspection). Exit 2: the suite produced no test results, so "nothing left" would prove nothing.
// Test failures alone do not fail this check; judge those with scripts/check-known-reds.mjs.
//
// ⚠️ The directory is created under os.tmpdir() with a short name on purpose: tsx puts its IPC socket
// at `$TMPDIR/tsx-<uid>/<pid>.pipe`, and macOS caps a socket path at 104 bytes. A long TMPDIR turns
// criteria red for reasons that have nothing to do with them. Do not realpath it either: a TMPDIR
// that differs from the path git reports was measured turning seven runLoop criteria red.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "cl-"));
const report = join(mkdtempSync(join(tmpdir(), "cl-report-")), "vitest.json");

const run = spawnSync(
  join(repo, "node_modules", ".bin", "vitest"),
  ["run", "--reporter=json", `--outputFile=${report}`, ...process.argv.slice(2)],
  { cwd: repo, env: { ...process.env, TMPDIR: root }, stdio: ["ignore", "ignore", "inherit"] },
);

let total = 0;
try {
  total = JSON.parse(readFileSync(report, "utf8")).numTotalTests;
} catch {}
rmSync(dirname(report), { recursive: true, force: true });

const left = readdirSync(root).sort();
console.log(`vitest exit ${run.status}, ${total} tests, ${left.length} entries left in ${root}`);
if (total === 0) {
  console.log("no test results: the check proves nothing");
  process.exit(2);
}
if (left.length > 0) {
  for (const name of left.slice(0, 50)) console.log(`  ${name}`);
  if (left.length > 50) console.log(`  ... and ${left.length - 50} more`);
  process.exit(1);
}
rmSync(root, { recursive: true, force: true });
