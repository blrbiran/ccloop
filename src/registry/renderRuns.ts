// L2 run registry — serializes scan rows into the machine contract (`ScanResult`) and renders
// a human-readable table over the same data. No observation logic lives here: everything
// rendered was already decided by scanRuns/observeRun; this module only formats it. See
// docs/superpowers/specs/2026-07-28-run-registry-design.md §6.3, §8.2, §9, §10.

import type { FieldObservation, FileObservation } from "./types.js";
import type { ScanIssue, ScanRow } from "./scanRuns.js";
// type-only: renderRuns.ts consumes the lock shape Task 8 produces, but must never VALUE-import
// from src/unlock/. The reason is NOT a cycle: measured (final fix wave of this round),
// src/unlock/lockRows.ts type-only imports back into ../registry/observeRun.js and
// ../registry/scanRuns.js, src/unlock/inspectLock.ts value-imports only ../persistence/fileStore.js,
// and fileStore.ts value-imports nothing from src/ -- so renderRuns -> lockRows -> inspectLock ->
// fileStore is a terminating DAG and closes nothing. The real reason is weaker but genuine:
// sweepRuns.ts VALUE-imports scanRootFailureDetail FROM this file, so a value import the other way
// would drag the lock inspector into sweep's runtime graph -- and sweep deliberately does no
// liveness probing (§3.3; src/sweep/lockPresence.ts). `import type` is erased at compile time and
// carries no such risk (design spec §3.2, human ruling 131).
import type { LockInspection } from "../unlock/inspectLock.js";
import type { ReportedRunRow, ReportedScanRow } from "../unlock/lockRows.js";

export type ScanResult = { schemaVersion: 1; rows: ReportedScanRow[] };

// Spec §6.3: the JSON output carries a schemaVersion because it is an interface a later queue
// layer will consume. This layer neither renames nor drops any row — it only wraps.
//
// schemaVersion stays 1, not 2 (design spec §3.4 decision A): the lock block is a new key on an
// existing row shape, not a change to any field an old consumer already reads.
export function toScanResult(rows: ReportedScanRow[]): ScanResult {
  return { schemaVersion: 1, rows };
}

function renderFieldObservation(observation: FieldObservation): string {
  switch (observation.kind) {
    case "present":
      return `present(${JSON.stringify(observation.value)})`;
    case "absent":
      return "absent";
    case "unreadable":
      return `unreadable(${observation.reason}): ${observation.detail}`;
  }
}

function renderFileObservation(file: FileObservation): string[] {
  const lines: string[] = [`  ${file.file}`];
  for (const [name, observation] of Object.entries(file.fields)) {
    lines.push(`    ${name}: ${renderFieldObservation(observation)}`);
  }
  return lines;
}

// Human ruling 131: the full seven states of inspectOwnerTransferLock, not just presence.
// `ls` reports the structured state name, the state's own fields, and the next command --
// never its own prose. `ccloop unlock` already owns the honest wording for each state (design
// spec §3.4 decision F); a second, ls-authored account of the same lock could drift from it.
//
// `digest` renders in FULL (64 hex), never truncated -- it is the credential `ccloop unlock
// --force --expect` needs, and a truncated one could not be pasted back in. `identity`
// (dev/ino) is never rendered: it is an internal re-check fact for the delete path, not
// something an operator acts on.
//
// `file-unreadable` is the one state that renders no `digest:` line at all: its credential is a
// hash of bytes that could not be read, so there is nothing to show (inspectLock.ts's own
// comment on that state says the same). `absent` renders no `next:` line: there is no lock to
// clear.
function renderLockBlock(lock: LockInspection, runPath: string): string[] {
  const lines: string[] = ["  owner-transfer.lock", `    state: ${lock.state}`];
  if (lock.state === "absent") {
    return lines;
  }
  switch (lock.state) {
    case "dead":
    case "alive":
      lines.push(`    holder: ${lock.holder}`, `    pid: ${lock.pid}`, `    digest: ${lock.digest}`);
      break;
    case "liveness-unknown":
      lines.push(
        `    holder: ${lock.holder}`,
        `    pid: ${lock.pid}`,
        `    reason: ${lock.reason}`,
        `    digest: ${lock.digest}`,
      );
      break;
    case "unrecognized-holder":
      lines.push(`    holder: ${lock.holder}`, `    digest: ${lock.digest}`);
      break;
    case "unparseable":
      lines.push(`    reason: ${lock.reason}`, `    digest: ${lock.digest}`);
      break;
    case "file-unreadable":
      lines.push(`    reason: ${lock.reason}`);
      break;
  }
  lines.push(`    next: ccloop unlock ${runPath}`);
  return lines;
}

// Spec §15 #1: no row is ever omitted, including one whose every field is absent — this
// function always emits the path line first, unconditional on what the fields contain.
function renderRunRow(row: ReportedRunRow): string[] {
  const lines: string[] = [`RUN  ${row.path}  observed ${row.observedAt}`];
  for (const file of row.files) {
    lines.push(...renderFileObservation(file));
  }
  lines.push(...renderLockBlock(row.lock, row.path));
  return lines;
}

function renderIssueRow(row: ScanIssue): string {
  switch (row.kind) {
    case "directory_unreadable":
      return `ISSUE directory_unreadable  ${row.path}  (${row.detail})`;
    case "depth_truncated":
      return `ISSUE depth_truncated  ${row.path}`;
  }
}

// Spec §8.2: this notice is part of the contract, not decoration — a row assembles several
// files that may have been read at different instants, and the combination is not a snapshot.
const CONSISTENCY_NOTICE =
  "Fields within a row are independent observations and do not constitute a consistent snapshot. " +
  "eligibleForContinuation is an observed field, not a decision that the run may be resumed.";

// Renders every row in scan order — never sorted or filtered, so an issue row can never be
// pushed out of view by run rows (spec §15 #1, task brief trap).
export function renderScanTable(result: ScanResult): string {
  const lines: string[] = [CONSISTENCY_NOTICE, ""];

  if (result.rows.length === 0) {
    lines.push("(no runs found)");
    return lines.join("\n");
  }

  for (const row of result.rows) {
    lines.push(...(row.kind === "run" ? renderRunRow(row) : [renderIssueRow(row)]));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// Spec §9 / §11: distinguishes "the scan itself failed" (root missing or unreadable) from an
// ordinary interior directory_unreadable row (the scan succeeded; the failure is reported as a
// row, per §11, not as a command failure). scanDir (scanRuns.ts) returns exactly one row,
// immediately, when the *root's own* readdir fails — no child could have been visited yet — so
// "exactly one row, a directory_unreadable row, whose path is the root" is a precise signal
// that the failure was the root itself and not some interior directory found during traversal.
export function scanRootFailureDetail(rows: ScanRow[], root: string): string | undefined {
  const [only] = rows;
  if (rows.length === 1 && only?.kind === "directory_unreadable" && only.path === root) {
    return only.detail;
  }
  return undefined;
}
