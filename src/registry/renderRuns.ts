// L2 run registry — serializes scan rows into the machine contract (`ScanResult`) and renders
// a human-readable table over the same data. No observation logic lives here: everything
// rendered was already decided by scanRuns/observeRun; this module only formats it. See
// docs/superpowers/specs/2026-07-28-run-registry-design.md §6.3, §8.2, §9, §10.

import type { FieldObservation, FileObservation } from "./types.js";
import type { RunObservation } from "./observeRun.js";
import type { ScanIssue, ScanRow } from "./scanRuns.js";

export type ScanResult = { schemaVersion: 1; rows: ScanRow[] };

// Spec §6.3: the JSON output carries a schemaVersion because it is an interface a later queue
// layer will consume. This layer neither renames nor drops any row — it only wraps.
export function toScanResult(rows: ScanRow[]): ScanResult {
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

// Spec §15 #1: no row is ever omitted, including one whose every field is absent — this
// function always emits the path line first, unconditional on what the fields contain.
function renderRunRow(row: RunObservation): string[] {
  const lines: string[] = [`RUN  ${row.path}  observed ${row.observedAt}`];
  for (const file of row.files) {
    lines.push(...renderFileObservation(file));
  }
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
