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
import { defaultLockPresence } from "./lockPresence.js";
import type { RunObservation } from "../registry/observeRun.js";
import { ResumeNotEligibleError, resumeLoop } from "../controller/resumeLoop.js";
import type { ResumeLoopOptions } from "../controller/resumeLoop.js";
import type { StopRequestSignal } from "../controller/runLoop.js";
import { RunLeaseHeldError } from "../ownership/lease.js";
import type { RuntimeAdapter } from "../runtime/types.js";
import type { RunState, RunStatus } from "../state/types.js";

// §8's outcome domain, exactly eight values. The five terminal RunStatus values are reported
// under their own names — `cancelled` is NOT folded into `failed`, because the operator's next
// step differs (a run that failed on its own merits vs one stopped for ownership/signal reasons).
type Outcome =
  | "succeeded"
  | "failed"
  | "exhausted"
  | "blocked_waiting_human"
  | "cancelled"
  | "interrupted"
  | "refused"
  | "error";

// Exhaustive over RunStatus on purpose: a new status added to the state machine becomes a
// compile error here rather than a silently miscounted tally key. The split mirrors
// state/stateMachine.ts's legalTransitions — a status is terminal exactly when nothing legally
// follows it — and tests/sweep/sweepRuns.test.ts asserts the two agree.
function outcomeForStatus(status: RunStatus): Outcome {
  switch (status) {
    case "succeeded":
    case "failed":
    case "exhausted":
    case "blocked_waiting_human":
    case "cancelled":
      return status;
    case "queued":
    case "planning":
    case "executing":
    case "verifying":
      return "interrupted";
  }
}

// §8's error-routing table. The prefix test comes FIRST: a read-side failure is a
// ResumeNotEligibleError too, and it is the one refusal that is not a normal result.
function classifyThrow(error: unknown): { outcome: Outcome; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  // §4.4: the routing key is the message prefix, not the error type. `Error.cause` was rejected
  // there — ResumeNotEligibleError's single-argument constructor is a public signature the tests
  // also `new`, and the prefix already catches every read-side throw out of resumeLoop's
  // Promise.all without touching resumeLoop.ts. The cost, accepted here: this collapses ALL
  // read-side failures into `error` without distinguishing the cause. Nothing is lost for
  // diagnosis — the detail carries the full message, which embeds the original String(error).
  if (error instanceof ResumeNotEligibleError && message.startsWith("cannot read run artifacts:")) {
    return { outcome: "error", detail: message };
  }
  // A refusal is a REPORTED RESULT, not a sweep failure: the gate said no, or another process
  // holds the lease and is presumably running the very run this sweep wanted.
  if (error instanceof ResumeNotEligibleError || error instanceof RunLeaseHeldError) {
    return { outcome: "refused", detail: message };
  }
  return { outcome: "error", detail: message };
}

export type SweepDeps = {
  scan?: (root: string, deps: ScanDeps) => Promise<ScanRow[]>;
  scanDeps?: ScanDeps;
  resume?: (runDir: string, adapter: RuntimeAdapter, options?: ResumeLoopOptions) => Promise<RunState>;
  // Presence only, and injected for the same reason `scan` is: it is the sweep's only filesystem
  // access under a run directory, so keeping it a dependency is what keeps sweepRuns itself the
  // pure function §3 #1 describes.
  lockPresence?: (runDir: string) => Promise<boolean>;
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
  const lockPresence = deps?.lockPresence ?? defaultLockPresence;

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
  // and no contract has been read at this point. Both numbers are required: §12's whole argument
  // is that choosing `--adapter claude` is an INFORMED and BOUNDED approval of this sweep, and
  // without N the "informed" half does not hold.
  //
  // The count is named for what it counts. A bare "eligible" reads as "these N runs will run",
  // while the filter covers ONE of evaluateResumeEligibility's eight criteria (isObservedEligible
  // above) — an operator can approve `--adapter claude` on a count of 17 and have all 17 refused
  // at the gate, which empties the "informed" half just as surely as dropping N would. The
  // qualification is the same one `ccloop ls` prints over the same field (CONSISTENCY_NOTICE in
  // ../registry/renderRuns.ts), stated in the same terms so the two read-only surfaces agree.
  options.stderr(
    `sweep: ${candidates.length} run(s) under ${options.root} observed eligibleForContinuation=true ` +
      `(an observed field, not a decision that the run may be resumed), ` +
      `will attempt at most ${options.maxRuns}, adapter=${options.adapterName}`,
  );

  // Human ruling 70, board C-b. Over `rows`, NOT `candidates`, and the difference is the whole
  // point: a run whose owner-transfer.json never landed is not a candidate, is not counted in the
  // banner, and — measured, pointC-design.md §4.1/§8.5 — is reported by nothing else this tool
  // prints. A candidate holding the same lock is already loud, as a `refused` report line below.
  // Reporting is a property of what is on disk; candidacy is a different question.
  //
  // Sorted for the same reason the candidate list is: scanRuns contains no sort, so row order is
  // whatever readdir returned, and an operator diffing two sweeps of an unchanged tree would see
  // the lines move. The probe runs after the sort so the calls are ordered too.
  //
  // Sequential rather than Promise.all: the note lines are this wave's own output and §8's
  // one-line-per-thing contract reads them in order, which a concurrent map would not preserve.
  const lockedRowPaths = rows
    .filter((row): row is RunObservation => row.kind === "run")
    .map((row) => row.path)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  for (const path of lockedRowPaths) {
    if (await lockPresence(path)) {
      options.stderr(
        `note  ${path}  owner_transfer_lock_present  a transfer lock is on disk; `
          + `this sweep does not read it and makes no claim about whether its holder is alive`,
      );
    }
  }

  const adapter = options.createAdapter();

  let adopted = 0;
  let attempted = 0;
  const tally: Record<Outcome, number> = {
    succeeded: 0,
    failed: 0,
    exhausted: 0,
    blocked_waiting_human: 0,
    cancelled: 0,
    interrupted: 0,
    refused: 0,
    error: 0,
  };
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

    attempted += 1;
    let report: { outcome: Outcome; detail: string };
    try {
      const finalState = await resume(candidate.path, adapter, {
        stopRequested: options.stopRequested,
        onAdopted: () => {
          adopted += 1;
        },
        // §4.3: another line entirely, never a cell in the three-column report — the abandonment
        // is ORTHOGONAL to the run's final classification (a run that ends `succeeded` can still
        // produce one). One line per invocation: no dedup, no aggregation.
        //
        // Written AT THE CALLBACK, not buffered for a flush after the loop. A sweep can run for
        // hours under --max-runs 50; if run 3 abandons a reconciliation write and the process is
        // SIGKILLed at run 40, a buffer dies with the process and cron's "any stderr is an alert"
        // rule never fires — for an event whose entire purpose is that visibility. Buffering also
        // bought nothing: the only ordering §4.3 asks for is between note lines themselves, and a
        // sequential for-await gives that either way.
        //
        // `detail` is a String(error) and a SyntaxError message can contain newlines, which would
        // split one note into what looks like several output lines. The three-column report line
        // below folds for the same reason and by the same rule — it is this wave's own output, not
        // something inherited, and §8's "one line per attempted run" is its whole contract.
        //
        // Deliberately NOT wrapped in try/catch: `options.stderr` throwing is a programming error
        // in the caller, and swallowing it here would hide it (Rule 12).
        onReconciliationWriteAbandoned: (detail) => {
          options.stderr(
            `note  ${candidate.path}  reconciliation_write_abandoned  ${detail.replace(/\r?\n/g, " ")}`,
          );
        },
      });
      const outcome = outcomeForStatus(finalState.status);
      report =
        outcome === "interrupted"
          ? {
              outcome,
              // GATE-B pinned that non-terminal does NOT imply resumable: this layer's filter is
              // built on ONE of evaluateResumeEligibility's eight criteria, and criteria 5-8 are
              // never evaluated here. So this line states what is known and nothing more — it
              // must not be worded, here or anywhere downstream, as "this run can be resumed".
              detail:
                `status=${finalState.status}, stopReason=${String(finalState.stopReason)}, ` +
                `non-terminal — this sweep makes no claim that it can be resumed`,
            }
          : { outcome, detail: `stopReason=${String(finalState.stopReason)}` };
    } catch (error) {
      report = classifyThrow(error);
    }

    // Every per-run outcome is a reported outcome, never a sweep failure (§7). A concurrent
    // sweep losing the lease gate lands here too, and that is expected, not an error.
    tally[report.outcome] += 1;
    const sink = report.outcome === "error" ? options.stderr : options.stdout;
    // §8 is "one line per attempted run", and `detail` is a String(error): a ZodError out of
    // loadContract runs to a dozen lines. Unfolded, one run becomes that many output lines, all
    // but the first without a path column — and a cron job parsing the report by line reads one
    // run as a dozen ownerless records. Folded on the same rule as the note line above.
    sink(`${candidate.path}\t${report.outcome}\t${report.detail.replace(/\r?\n/g, " ")}`);
  }

  // C1's summary added `adopted` and `refused`, which are not mutually exclusive: a run that
  // adopted and then threw counted in BOTH, and the line could read "7 adopted, 2 not started,
  // of 8 eligible". These counts are derived from the report lines instead — one outcome per
  // attempted run — so no run is counted twice. Quota is reported separately because it is a
  // different denominator on purpose: a refusal is attempted and spends nothing.
  options.stdout(
    `${attempted} attempted, ${tally.succeeded} succeeded, ${tally.refused} refused, ${tally.error} errored ` +
      `(quota ${adopted}/${options.maxRuns})`,
  );
  return 0;
}
