// The `ls` command's lock column. It is a SECOND consumer of inspectLock's single reader -- the
// first is unlockCommand -- and deliberately not a second reader: run-registry spec 7.2 exists to
// stop a second JSON reading implementation from drifting against the first.
//
// It lives beside that reader rather than inside the registry, and the reason is `sweep`: sweep
// runs scanRuns too (sweepRuns.ts), so making the inspector a ScanDeps dependency would start
// probing liveness inside a command that deliberately asks only whether a lock file exists. A
// separate layer leaves sweep untouched, and leaves registry's observation types -- which carry no
// derived meaning -- exactly as they are. Human ruling 131.
import type { RunObservation } from "../registry/observeRun.js";
import type { ScanIssue, ScanRow } from "../registry/scanRuns.js";
import { type LockInspection, inspectOwnerTransferLock } from "./inspectLock.js";

// Written as run-rows-with-a-lock UNIONED with issue rows, never as `ScanRow | (RunObservation &
// { lock })`: that spelling collapses back to ScanRow on assignment and leaves `row.lock` an error
// on access, which would quietly give up the guarantee the next line states.
export type ReportedRunRow = RunObservation & { lock: LockInspection };
export type ReportedScanRow = ReportedRunRow | ScanIssue;

export type LockRowDeps = { inspect(runDir: string): Promise<LockInspection> };

export const defaultLockRowDeps: LockRowDeps = { inspect: inspectOwnerTransferLock };

// EVERY run row gets a lock field, including `absent`. A missing key reads as "not probed", which
// is a different fact, and run-registry spec 15 #1 already refuses to omit rows for the same
// reason. Issue rows are passed through untouched: there is no run directory to probe.
export async function attachLockInspections(
  rows: ScanRow[],
  deps: LockRowDeps,
): Promise<ReportedScanRow[]> {
  const attached: ReportedScanRow[] = [];
  for (const row of rows) {
    if (row.kind !== "run") {
      attached.push(row);
      continue;
    }
    attached.push({ ...row, lock: await deps.inspect(row.path) });
  }
  return attached;
}
