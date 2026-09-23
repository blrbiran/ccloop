#!/usr/bin/env node
// Decides the round's baseline criterion mechanically (design spec §8, criterion 1): the set of
// failing tests must be a SUBSET of the known reds, compared by FULL NAME. Counting is not enough
// -- a new failure and a silenced flake give the same count, and only a by-name subset check tells
// them apart.
//
// The roster is THIRTEEN full names (twelve numbered items in spec §9/§11.1, with item 12
// covering two names as one codexWatchdog pair) -- not the seven an earlier draft of this script
// carried. See docs/superpowers/specs/2026-09-23-ls-lock-visibility-design.md §9 and §11.1, and
// .superpowers/sdd/2026-09-23-ls-lock-visibility/progress.md for how the roster grew from 7 to 12
// (13 names) over the round.
//
// Matching is by suffix in EITHER direction (`known.endsWith(name) || name.endsWith(known)`),
// not exact string equality: vitest's own `fullName` field concatenates ancestor titles and the
// test's own title with a bare space, not " > ", so this script reconstructs the full name from
// `ancestorTitles` + `title` joined by " > " (matching this repository's own convention for citing
// test names in specs, reports and this roster) and then compares by suffix so a roster entry that
// also names its file (only entry 1 does, as an anchor) still matches the reconstructed
// describe/it chain, which never includes the file path.
import { readFileSync } from "node:fs";

const KNOWN_REDS = new Set([
  // Stable red (non-flake), root cause unexamined, nobody authorized touching it.
  "tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone",
  // Load flakes (all "Test timed out in 5000ms"), §9 of the design spec.
  "run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid",
  "runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals",
  "runLoop > accounts an execute timeout that rejects after the abort as exhaustion",
  "run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data",
  "SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute",
  "Codex phase process > kills a TERM-ignoring process before returning abort",
  // Added in §11.1, measured after Task 2 (5 more names + one codexWatchdog pair = 6 more names).
  "run-scenario CLI > runs when invoked through a canonical-path alias",
  "run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist",
  "isolated Codex acceptance harness > succeeds only with real controller, three phases and published answer",
  "accepts the controller's zero-clamped soft budget and records the overrun",
  "matches historical double-space start identities on single-digit days",
  "still reaps registered groups when the observation file becomes unwritable",
]);

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: check-known-reds.mjs <vitest --reporter=json outputFile>");
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const failed = [];
for (const file of report.testResults ?? []) {
  for (const test of file.assertionResults ?? []) {
    if (test.status !== "failed") {
      continue;
    }
    const ancestors = Array.isArray(test.ancestorTitles) ? test.ancestorTitles : [];
    const title = typeof test.title === "string" ? test.title : (test.fullName ?? "");
    const reconstructed = [...ancestors, title].join(" > ");
    failed.push(reconstructed);
  }
}

const isKnown = (name) => [...KNOWN_REDS].some((known) => known.endsWith(name) || name.endsWith(known));
const unexpected = failed.filter((name) => !isKnown(name));

console.log(`known reds in roster: ${KNOWN_REDS.size}`);
console.log(`failed: ${failed.length}`);
for (const name of failed) {
  console.log(`  ${isKnown(name) ? "known " : "UNKNOWN"} ${name}`);
}
console.log(`unexpected: ${unexpected.length}`);
for (const name of unexpected) {
  console.log(`  UNEXPECTED ${name}`);
}

process.exit(unexpected.length === 0 ? 0 : 1);
