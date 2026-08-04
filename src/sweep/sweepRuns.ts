// L3 §6/§7 — the sweep trigger layer: scan a root, filter to the rows L2 observed as eligible,
// order them deterministically, and resume them one at a time under a bounded quota.
//
// This module is a PURE FUNCTION over two injected dependencies (`scan` and `resume`): it opens
// no writer, installs no signal handler, and reads no file under any run directory (§3 #1). It
// does, however, CAUSE writes, and that is expected (§3 #2): resumeLoop appends
// `resume_requested` before any gate, each refusal path appends `resume_denied`, the lease gate
// can additionally append `lease_expired_observed`, and the CAS refusal path has filesystem
// side effects of its own. "Writes not one byte into any run directory" is literally false and
// must not be claimed anywhere.

import { scanRuns as defaultScan, defaultScanDeps } from "../registry/scanRuns.js";
import type { ScanDeps, ScanRow } from "../registry/scanRuns.js";
import { scanRootFailureDetail } from "../registry/renderRuns.js";
import type { RunObservation } from "../registry/observeRun.js";
import { resumeLoop } from "../controller/resumeLoop.js";
import type { ResumeLoopOptions } from "../controller/resumeLoop.js";
import type { StopRequestSignal } from "../controller/runLoop.js";
import type { RuntimeAdapter } from "../runtime/types.js";
import type { RunState } from "../state/types.js";

export type SweepDeps = {
  scan?: (root: string, deps: ScanDeps) => Promise<ScanRow[]>;
  scanDeps?: ScanDeps;
  resume?: (runDir: string, adapter: RuntimeAdapter, options?: ResumeLoopOptions) => Promise<RunState>;
};

export type SweepOptions = {
  root: string;
  adapterName: "scripted" | "claude";
  // §8: a CLOSURE, not an already-constructed adapter. §8's first line requires that a failure
  // READING the adapter config exits 1 without scanning, while §8/§12 require the banner to be
  // printed after the scan and before the adapter is constructed. The only shape satisfying both
  // is: the caller reads and parses the config first (failing before sweepRuns is entered) and
  // hands in a construction closure that performs no I/O, which sweepRuns calls after the banner.
  createAdapter: () => RuntimeAdapter;
  maxRuns: number;
  stopRequested: StopRequestSignal;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

// The filter, and the whole of what it claims. `eligibleForContinuation` is an OBSERVED field on
// owner-transfer.json — one of the eight criteria evaluateResumeEligibility applies, and
// reconciliation-record.json is not in L2's OBSERVED_FILES at all. So a row passing this filter
// means only "L2 observed that field as literal true", never "this run can be resumed". The
// other seven criteria are evaluated inside resumeLoop, which refuses without spending quota.
function isObservedEligible(row: ScanRow): row is RunObservation {
  if (row.kind !== "run") return false;
  const transfer = row.files.find((file) => file.file === "owner-transfer.json");
  const observation = transfer?.fields["eligibleForContinuation"];
  return observation?.kind === "present" && observation.value === true;
}

export async function sweepRuns(options: SweepOptions, deps?: SweepDeps): Promise<number> {
  const scan = deps?.scan ?? defaultScan;
  const scanDeps = deps?.scanDeps ?? defaultScanDeps;
  const resume = deps?.resume ?? resumeLoop;

  const rows = await scan(options.root, scanDeps);

  // §7: the scan failing at its own root is the ONLY thing that makes a sweep exit non-zero.
  // An interior unreadable directory is an ordinary row and the sweep proceeds over the rest.
  const rootFailure = scanRootFailureDetail(rows, options.root);
  if (rootFailure !== undefined) {
    options.stderr(`sweep: cannot scan ${options.root}: ${rootFailure}`);
    return 1;
  }

  // Sorting is not cosmetic: scanRuns contains no sort at all, so row order is whatever readdir
  // returned. "Which N runs does --max-runs pick" is only well-defined once the order is, and
  // the truncation below therefore has to come AFTER the sort, never after the filter.
  const candidates = rows
    .filter(isObservedEligible)
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  // §8/§12: banner first, adapter second. N bounds the number of runs ENTERED, not the number of
  // paid model calls — each run keeps its own attempt loop, so the paid ceiling is N ×
  // maxAttempts. The banner deliberately does not state that product: maxAttempts is per-contract
  // and no contract has been read at this point.
  options.stderr(
    `sweep: ${candidates.length} eligible run(s) under ${options.root}, max-runs ${options.maxRuns}, adapter ${options.adapterName}`,
  );

  const adapter = options.createAdapter();

  let adopted = 0;
  let refused = 0;

  for (const candidate of candidates) {
    // §6, quota accounting point (the amended ruling): the bound is on runs that actually ENTERED
    // runLoopFromState, counted at adoption rather than at return. Counting at return would let a
    // throw out of runLoopFromState's pre-try head refund a run whose attempts were already paid
    // for, and one sweep could then make unbounded paid calls under --max-runs 1. Counting every
    // CALL instead would let refusals — which never enter the loop and never pay anything —
    // starve the runs queued behind them.
    if (adopted >= options.maxRuns) break;

    // §5.4/§8: read at the boundary BETWEEN runs — the run already under way is left to reach its
    // own phase boundary (resumeLoop forwards the same slot down to runLoopFromState), and no
    // further run is started. sweepRuns installs no handler; the slot is filled by cli.ts.
    if (options.stopRequested.requested) break;

    try {
      await resume(candidate.path, adapter, {
        stopRequested: options.stopRequested,
        onAdopted: () => {
          adopted += 1;
        },
        onReconciliationWriteAbandoned: (detail) =>
          options.stderr(`sweep: ${candidate.path}: reconciliation write abandoned: ${detail}`),
      });
    } catch (error) {
      // Every per-run outcome is a reported outcome, never a sweep failure (§7). A concurrent
      // sweep losing the lease gate lands here too, and that is expected, not an error.
      refused += 1;
      options.stderr(`sweep: ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // C3 owns the report's FORMAT; this task only establishes that both sinks exist and are used.
  options.stdout(`sweep: ${adopted} adopted, ${refused} not started, of ${candidates.length} eligible`);
  return 0;
}
