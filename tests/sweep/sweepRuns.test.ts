// L3 §6/§7 sweep trigger layer — tests for sweepRuns' scan -> filter -> sort -> quota ->
// sequential-resume pipeline. Every test drives the real sweepRuns with an injected `resume`
// stand-in and an injected `scan`, so no test touches a real run directory: sweepRuns itself is
// a pure function over those two dependencies (it opens no writer, installs no signal handler,
// and reads no file under a run directory).
//
// NOTE ON WHAT THE FILTER MEANS (GATE-B condition 2): the filter is built on the L2 OBSERVATION
// `owner-transfer.json`.eligibleForContinuation === true. That is one of the eight criteria
// evaluateResumeEligibility applies; reconciliation-record.json is not even in L2's
// OBSERVED_FILES. So an included row means "L2 observed that field as true", never "this run can
// be resumed" — the remaining refusals happen inside resumeLoop, and those refusals are the
// subject of the quota tests below.

import { describe, expect, it } from "vitest";
import { sweepRuns } from "../../src/sweep/sweepRuns.js";
import type { SweepDeps, SweepOptions } from "../../src/sweep/sweepRuns.js";
import { ResumeNotEligibleError } from "../../src/controller/resumeLoop.js";
import type { ResumeLoopOptions } from "../../src/controller/resumeLoop.js";
import type { ScanRow } from "../../src/registry/scanRuns.js";
import type { FieldObservation } from "../../src/registry/types.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import type { RunState } from "../../src/state/types.js";

const ROOT = "/fake/root";

// A row shaped exactly like observeRun's output: one FileObservation per OBSERVED_FILES entry,
// in that order, none omitted. Only owner-transfer.json's field varies across fixtures, because
// that is the only field the filter under test reads.
function runRow(path: string, eligibleForContinuation: FieldObservation): ScanRow {
  return {
    kind: "run",
    path,
    observedAt: "2026-08-04T00:00:00.000Z",
    files: [
      {
        file: "loop-state.json",
        fields: {
          status: { kind: "present", value: "executing" },
          currentAttempt: { kind: "present", value: 1 },
          attemptsUsed: { kind: "present", value: 1 },
          lastTransitionAt: { kind: "present", value: "2026-08-04T00:00:00.000Z" },
          stopReason: { kind: "present", value: null },
        },
      },
      {
        file: "owner-record.json",
        fields: {
          runId: { kind: "present", value: path },
          currentOwnerEpoch: { kind: "present", value: 2 },
          ownerStatus: { kind: "present", value: "current" },
          currentProcessInstanceId: { kind: "present", value: "proc-1" },
          leaseAffirmedAt: { kind: "present", value: null },
        },
      },
      {
        file: "owner-transfer.json",
        fields: { eligibleForContinuation },
      },
    ],
  };
}

const ELIGIBLE: FieldObservation = { kind: "present", value: true };

const finishedState: RunState = {
  status: "succeeded",
  currentAttempt: 1,
  attemptsUsed: 1,
  lastTransitionAt: "2026-08-04T00:00:00.000Z",
  waitingOnHuman: false,
  stopReason: null,
  budgetSnapshot: { attemptsRemaining: 0, timeRemainingMs: 0, tokenBudgetRemaining: 0 },
  recentFailures: [],
};

// Never invoked: every test injects `resume`, and no production code path in these tests calls
// into an adapter. It exists only so createAdapter has something to return.
const inertAdapter = {
  plan: () => Promise.reject(new Error("adapter.plan must not be reached in a sweep test")),
  execute: () => Promise.reject(new Error("adapter.execute must not be reached in a sweep test")),
  verify: () => Promise.reject(new Error("adapter.verify must not be reached in a sweep test")),
} as unknown as RuntimeAdapter;

type Harness = {
  options: SweepOptions;
  deps: SweepDeps;
  resumeCalls: string[];
  stdoutLines: string[];
  stderrLines: string[];
  adapterConstructions: number;
};

function harness(
  rows: ScanRow[],
  resume: (runDir: string, adapter: RuntimeAdapter, options?: ResumeLoopOptions) => Promise<RunState>,
  overrides: Partial<SweepOptions> = {},
): Harness {
  const resumeCalls: string[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const state = { adapterConstructions: 0 };

  const options: SweepOptions = {
    root: ROOT,
    adapterName: "scripted",
    createAdapter: () => {
      state.adapterConstructions += 1;
      return inertAdapter;
    },
    maxRuns: 100,
    stopRequested: { requested: false },
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    ...overrides,
  };

  const deps: SweepDeps = {
    scan: (root) => {
      expect(root).toBe(options.root);
      return Promise.resolve(rows);
    },
    resume: (runDir, adapter, resumeOptions) => {
      resumeCalls.push(runDir);
      return resume(runDir, adapter, resumeOptions);
    },
  };

  return {
    options,
    deps,
    resumeCalls,
    stdoutLines,
    stderrLines,
    get adapterConstructions() {
      return state.adapterConstructions;
    },
  };
}

describe("sweepRuns", () => {
  it("resumes only the rows observed as eligible for continuation", async () => {
    // Four run rows and one issue row. The three non-eligible run rows cover every way the
    // observation can fail to be `present(true)`: the field absent, the file unreadable as a
    // whole (shape), and a value that is not literal true.
    const rows: ScanRow[] = [
      runRow(`${ROOT}/a-eligible`, ELIGIBLE),
      runRow(`${ROOT}/b-absent`, { kind: "absent" }),
      runRow(`${ROOT}/c-unreadable`, { kind: "unreadable", reason: "shape", detail: "expected literal-true, got string" }),
      runRow(`${ROOT}/d-eligible`, ELIGIBLE),
      { kind: "directory_unreadable", path: `${ROOT}/e-locked`, detail: "EACCES: permission denied" },
    ];
    // Precondition, asserted rather than assumed: the fixture really does contain rows the
    // filter must reject. If this fixture ever degenerated to "everything is eligible", the
    // assertion below would pass for the wrong reason.
    expect(rows.filter((row) => row.kind === "run").length).toBe(4);
    expect(rows.filter((row) => row.kind !== "run").length).toBe(1);

    const h = harness(rows, () => Promise.resolve(finishedState));
    const exitCode = await sweepRuns(h.options, h.deps);

    expect(exitCode).toBe(0);
    expect(h.resumeCalls).toEqual([`${ROOT}/a-eligible`, `${ROOT}/d-eligible`]);
  });

  it("continues to the next run after one is refused", async () => {
    // The refusal is the shape resumeLoop actually throws when a gate rejects; sweep must record
    // it and move on, because a refused run is a reported outcome, not a sweep failure (§7).
    const rows: ScanRow[] = [
      runRow(`${ROOT}/run-1`, ELIGIBLE),
      runRow(`${ROOT}/run-2`, ELIGIBLE),
      runRow(`${ROOT}/run-3`, ELIGIBLE),
    ];

    let refusals = 0;
    const h = harness(rows, (runDir) => {
      if (runDir === `${ROOT}/run-1`) {
        refusals += 1;
        return Promise.reject(new ResumeNotEligibleError("owner-transfer is not eligible for continuation"));
      }
      return Promise.resolve(finishedState);
    });

    const exitCode = await sweepRuns(h.options, h.deps);

    // The refusal really happened — without this, "the later runs were called" would be
    // consistent with a stand-in that never threw at all.
    expect(refusals).toBe(1);
    expect(h.resumeCalls).toEqual([`${ROOT}/run-1`, `${ROOT}/run-2`, `${ROOT}/run-3`]);
    expect(exitCode).toBe(0);
  });

  it("attempts only the first max-runs directories in lexicographic order", async () => {
    // The scan hands the rows back SCRAMBLED on purpose: scanRuns has no sort of its own, so row
    // order is whatever readdir produced. Without the sort inside sweepRuns, "the first two"
    // would be run-04 and run-01 here.
    const scrambled = ["run-04", "run-01", "run-05", "run-03", "run-02"];
    const rows: ScanRow[] = scrambled.map((name) => runRow(`${ROOT}/${name}`, ELIGIBLE));
    // Precondition, asserted rather than assumed: the fixture order is genuinely not the sorted
    // order, so a missing sort really can change the answer. If this ever became sorted input,
    // the ordering assertion below would pass without exercising the sort at all.
    const paths = rows.map((row) => (row.kind === "run" ? row.path : ""));
    expect(paths).not.toEqual([...paths].sort());

    const h = harness(
      rows,
      (_runDir, _adapter, resumeOptions) => {
        resumeOptions?.onAdopted?.();
        return Promise.resolve(finishedState);
      },
      { maxRuns: 2 },
    );

    const exitCode = await sweepRuns(h.options, h.deps);

    expect(exitCode).toBe(0);
    expect(h.resumeCalls).toEqual([`${ROOT}/run-01`, `${ROOT}/run-02`]);
    // §12's bounded-approval argument is only auditable if the banner states both the size of
    // the candidate set and the bound applied to it.
    const banner = h.stderrLines[0] ?? "";
    expect(banner).toContain("5");
    expect(banner).toContain("2");
  });

  it("does not spend quota on a refused run", async () => {
    // Refusals must not starve the runs behind them: this is exactly why the layer chose "a
    // refusal costs nothing" over a backoff file in the run directory.
    const rows: ScanRow[] = [
      runRow(`${ROOT}/run-1`, ELIGIBLE),
      runRow(`${ROOT}/run-2`, ELIGIBLE),
      runRow(`${ROOT}/run-3`, ELIGIBLE),
    ];

    const adoptions: string[] = [];
    const h = harness(
      rows,
      (runDir, _adapter, resumeOptions) => {
        if (runDir !== `${ROOT}/run-3`) {
          // A gate refusal throws BEFORE resume_adopted is appended, so onAdopted never fires.
          return Promise.reject(new ResumeNotEligibleError("run status succeeded is not resumable"));
        }
        resumeOptions?.onAdopted?.();
        adoptions.push(runDir);
        return Promise.resolve(finishedState);
      },
      { maxRuns: 2 },
    );

    const exitCode = await sweepRuns(h.options, h.deps);

    expect(exitCode).toBe(0);
    // Both halves are load-bearing: the first two really were refused without adopting, and the
    // third — beyond maxRuns if refusals had counted — still ran.
    expect(adoptions).toEqual([`${ROOT}/run-3`]);
    expect(h.resumeCalls).toEqual([`${ROOT}/run-1`, `${ROOT}/run-2`, `${ROOT}/run-3`]);
  });

  it("spends quota at onAdopted, not at return, so a later throw cannot refund it", async () => {
    // The timing this pins is real, not hypothetical: runLoopFromState's while(true) opens with
    // two awaits OUTSIDE any try (writeRunState, affirmNow). A throw there escapes resumeLoop
    // after k attempts have already been paid for. Counting at return would refund that run and
    // let one sweep make unbounded paid calls under --max-runs 1.
    const rows: ScanRow[] = [
      runRow(`${ROOT}/run-1`, ELIGIBLE),
      runRow(`${ROOT}/run-2`, ELIGIBLE),
      runRow(`${ROOT}/run-3`, ELIGIBLE),
    ];

    let adoptedThenThrew = 0;
    const h = harness(
      rows,
      (_runDir, _adapter, resumeOptions) => {
        resumeOptions?.onAdopted?.();
        adoptedThenThrew += 1;
        return Promise.reject(new Error("ENOSPC: no space left on device, write loop-state.json"));
      },
      { maxRuns: 1 },
    );

    const exitCode = await sweepRuns(h.options, h.deps);

    expect(exitCode).toBe(0);
    // The one run that started did adopt and then throw — the exact sequence that a
    // count-at-return implementation would refund.
    expect(adoptedThenThrew).toBe(1);
    expect(h.resumeCalls).toEqual([`${ROOT}/run-1`]);
  });

  it("starts no further run once the stop signal is set", async () => {
    // The slot, not the handler: cli.ts owns the signal handler (sweepRuns installs none). What
    // is testable here — and what matters — is that the loop reads the slot at the boundary
    // between runs and launches nothing after it is set.
    const rows: ScanRow[] = [
      runRow(`${ROOT}/run-1`, ELIGIBLE),
      runRow(`${ROOT}/run-2`, ELIGIBLE),
      runRow(`${ROOT}/run-3`, ELIGIBLE),
    ];

    const stopRequested = { requested: false };
    const h = harness(
      rows,
      (_runDir, _adapter, resumeOptions) => {
        resumeOptions?.onAdopted?.();
        // The run under way sets the slot, exactly as a SIGINT arriving mid-run would.
        stopRequested.requested = true;
        return Promise.resolve(finishedState);
      },
      { stopRequested },
    );
    // Precondition, asserted rather than assumed: the sweep starts with the slot CLEAR, so the
    // single call below cannot be explained by a sweep that refused to start anything at all.
    expect(stopRequested.requested).toBe(false);

    const exitCode = await sweepRuns(h.options, h.deps);

    expect(stopRequested.requested).toBe(true);
    expect(h.resumeCalls).toEqual([`${ROOT}/run-1`]);
    // A stop is an orderly finish, not a failure.
    expect(exitCode).toBe(0);
  });

  // Not on the plan's list of four; added because §8's stated reason for taking a CONSTRUCTION
  // CLOSURE instead of a built adapter is precisely that it makes this ordering observable —
  // "adapter-config read failure exits 1 without scanning" and "the banner prints after the scan
  // and before the adapter is constructed" only coexist in that shape, and an untested ordering
  // constraint is one a later edit can invert in silence.
  it("prints the banner before constructing the adapter", async () => {
    const rows: ScanRow[] = [runRow(`${ROOT}/run-1`, ELIGIBLE)];

    const order: string[] = [];
    const h = harness(rows, () => Promise.resolve(finishedState), {
      createAdapter: () => {
        order.push("createAdapter");
        return inertAdapter;
      },
      stderr: (line) => order.push(`stderr:${line}`),
    });

    const exitCode = await sweepRuns(h.options, h.deps);

    expect(exitCode).toBe(0);
    // Both events happened, and the banner was first.
    expect(order.filter((entry) => entry === "createAdapter")).toEqual(["createAdapter"]);
    expect(order[0]).toBe(`stderr:sweep: 1 eligible run(s) under ${ROOT}, max-runs 100, adapter scripted`);
    expect(order[1]).toBe("createAdapter");
  });
});
