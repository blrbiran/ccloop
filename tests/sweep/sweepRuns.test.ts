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
import { RunLeaseHeldError } from "../../src/ownership/lease.js";
import type { ScanRow } from "../../src/registry/scanRuns.js";
import type { FieldObservation } from "../../src/registry/types.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { isTerminalRunStatus } from "../../src/state/stateMachine.js";
import type { RunState, RunStatus } from "../../src/state/types.js";

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

// A RunState in any status the report has to classify, terminal or not.
function stateWith(status: RunStatus, stopReason: string | null): RunState {
  return { ...finishedState, status, stopReason, waitingOnHuman: status === "blocked_waiting_human" };
}

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
    // Literal updated by task C3, which owns the banner's format; the ORDERING this test pins is
    // unchanged and still asserted by the two lines around this one.
    expect(order[0]).toBe(`stderr:sweep: 1 eligible run(s) under ${ROOT}, will attempt at most 100, adapter=scripted`);
    expect(order[1]).toBe("createAdapter");
  });

  it("prints the banner with the eligible count and the quota before constructing the adapter", async () => {
    // Three numbers that must not be confusable: 4 scanned rows, 3 of them observed eligible, a
    // quota of 2. A banner that printed the row count, or the quota where the eligible count
    // belongs, or a hardcoded number, passes a single-run fixture and fails this one. §12's
    // bounded-approval argument needs BOTH the size of the candidate set and the bound on it.
    const eligiblePaths = [`${ROOT}/run-1`, `${ROOT}/run-2`, `${ROOT}/run-4`];
    const rows: ScanRow[] = [
      ...eligiblePaths.map((path) => runRow(path, ELIGIBLE)),
      runRow(`${ROOT}/run-3`, { kind: "absent" }),
    ];
    const maxRuns = 2;
    // Precondition, asserted rather than assumed: the row count, the eligible count and the
    // quota are pairwise distinct, so no assertion below can pass by printing the wrong one of
    // the three.
    expect(new Set([rows.length, eligiblePaths.length, maxRuns]).size).toBe(3);

    const order: string[] = [];
    const h = harness(rows, () => Promise.resolve(finishedState), {
      maxRuns,
      adapterName: "claude",
      createAdapter: () => {
        order.push("createAdapter");
        return inertAdapter;
      },
      stderr: (line) => order.push(`stderr:${line}`),
    });

    const exitCode = await sweepRuns(h.options, h.deps);

    expect(exitCode).toBe(0);
    expect(order[0]).toBe(`stderr:sweep: 3 eligible run(s) under ${ROOT}, will attempt at most 2, adapter=claude`);
    // The adapter was constructed exactly once, and after the banner — without this half the
    // assertion above would also hold for a sweep that built the adapter first.
    expect(order.filter((entry) => entry === "createAdapter")).toEqual(["createAdapter"]);
    expect(order[1]).toBe("createAdapter");
  });

  it("prints one tab-aligned report line per attempted run and a summary line", async () => {
    // One run per value of the eight-value outcome domain, so the exact-line assertions below
    // cover the whole domain instead of a lucky corner of it. Two rows carry the load on the
    // summary's two different denominators: run-7 is ATTEMPTED but spends no quota, and run-8
    // adopts and then throws — it spends quota and is reported ONCE, as `error`, never also as
    // `refused`. A summary that added `adopted` and `refused` would contradict itself there.
    const cases: {
      name: string;
      outcome: string;
      detail: string;
      sink: "stdout" | "stderr";
      resume: (options?: ResumeLoopOptions) => Promise<RunState>;
    }[] = [
      {
        name: "run-1", outcome: "succeeded", detail: "stopReason=null", sink: "stdout",
        resume: (o) => { o?.onAdopted?.(); return Promise.resolve(stateWith("succeeded", null)); },
      },
      {
        name: "run-2", outcome: "failed", detail: "stopReason=verifier_rejected", sink: "stdout",
        resume: (o) => { o?.onAdopted?.(); return Promise.resolve(stateWith("failed", "verifier_rejected")); },
      },
      {
        name: "run-3", outcome: "exhausted", detail: "stopReason=attempts_exhausted", sink: "stdout",
        resume: (o) => { o?.onAdopted?.(); return Promise.resolve(stateWith("exhausted", "attempts_exhausted")); },
      },
      {
        name: "run-4", outcome: "blocked_waiting_human", detail: "stopReason=human_gate", sink: "stdout",
        resume: (o) => { o?.onAdopted?.(); return Promise.resolve(stateWith("blocked_waiting_human", "human_gate")); },
      },
      {
        // §8 keeps `cancelled` out of `failed` on purpose: the operator's next step differs, and
        // the stopReason is the only thing that says which ownership/signal cause it was.
        name: "run-5", outcome: "cancelled", detail: "stopReason=owner_lost", sink: "stdout",
        resume: (o) => { o?.onAdopted?.(); return Promise.resolve(stateWith("cancelled", "owner_lost")); },
      },
      {
        // Non-terminal return. The wording states only what is known — GATE-B pinned that a
        // non-terminal run is NOT thereby a resumable one, and this layer establishes nothing
        // about the seven eligibility criteria it never evaluated.
        name: "run-6", outcome: "interrupted",
        detail: "status=executing, stopReason=stop_requested, non-terminal — this sweep makes no claim that it can be resumed",
        sink: "stdout",
        resume: (o) => { o?.onAdopted?.(); return Promise.resolve(stateWith("executing", "stop_requested")); },
      },
      {
        // The OTHER refusal source, and the one nothing else covers: another process holds the
        // lease and is presumably running this very run. §8 files it as a normal result on
        // stdout, not as an error — dropping it from the refusal branch would send a routine
        // "someone else got there first" to the stderr that cron alerts on. (The
        // ResumeNotEligibleError half of that branch is covered by the 12c test's contrast row.)
        name: "run-7", outcome: "refused", detail: "run lease is held by proc-9 for another 30000ms", sink: "stdout",
        resume: () => Promise.reject(new RunLeaseHeldError("proc-9", 30000)),
      },
      {
        name: "run-8", outcome: "error", detail: "ENOSPC: no space left on device, write loop-state.json", sink: "stderr",
        resume: (o) => { o?.onAdopted?.(); return Promise.reject(new Error("ENOSPC: no space left on device, write loop-state.json")); },
      },
    ];
    // Precondition, asserted rather than assumed: the table really does cover all eight outcome
    // values. If it ever degenerated to fewer, the exact-line assertions would still pass while
    // silently covering less.
    expect(new Set(cases.map((entry) => entry.outcome)).size).toBe(8);
    // Cross-module, not a restatement: sweepRuns decides "terminal" with its own switch, and the
    // state machine decides it from legalTransitions. The five statuses reported under their own
    // names must be exactly the ones the state machine calls terminal, and run-6's must not be.
    for (const status of ["succeeded", "failed", "exhausted", "blocked_waiting_human", "cancelled"] as const) {
      expect(isTerminalRunStatus(status)).toBe(true);
    }
    expect(isTerminalRunStatus("executing")).toBe(false);

    const rows: ScanRow[] = cases.map((entry) => runRow(`${ROOT}/${entry.name}`, ELIGIBLE));
    const byPath = new Map(cases.map((entry) => [`${ROOT}/${entry.name}`, entry]));
    const h = harness(
      rows,
      (runDir, _adapter, resumeOptions) => byPath.get(runDir)!.resume(resumeOptions),
      { maxRuns: 8 },
    );

    const exitCode = await sweepRuns(h.options, h.deps);

    expect(exitCode).toBe(0);
    const line = (entry: (typeof cases)[number]) => `${ROOT}/${entry.name}\t${entry.outcome}\t${entry.detail}`;
    expect(h.stdoutLines).toEqual([
      ...cases.filter((entry) => entry.sink === "stdout").map(line),
      "8 attempted, 1 succeeded, 1 refused, 1 errored (quota 7/8)",
    ]);
    // The banner is stderr line 0; the `error` row is the only other thing on stderr here.
    expect(h.stderrLines.slice(1)).toEqual(cases.filter((entry) => entry.sink === "stderr").map(line));
    // Three columns, tab-aligned, on every report line — a `detail` that leaked a tab, or a
    // fourth column, would still satisfy the equalities above if they were substring checks.
    for (const reported of [...h.stdoutLines.slice(0, -1), ...h.stderrLines.slice(1)]) {
      expect(reported.split("\t").length).toBe(3);
    }
  });

  it("routes a cannot-read-run-artifacts refusal to stderr as an error, not to stdout as a refusal", async () => {
    // §4.4: the routing key is the message PREFIX, not the error class. Both runs below throw the
    // same class, so a router keyed on the class alone cannot tell them apart — and getting this
    // wrong is silent, because a read side that blew up would be filed as an ordinary "the gate
    // said no" and never reach the stderr that cron alerts on.
    const readFailure = "cannot read run artifacts: Error: EACCES: permission denied, open 'owner-transfer.json'";
    const gateRefusal = "owner-transfer is not eligible for continuation";
    // Preconditions, asserted rather than assumed: one message carries the prefix and the other
    // does not. If the fixture ever drifted so that both did (or neither), the split asserted
    // below would be produced by the fixture rather than by the router.
    expect(readFailure.startsWith("cannot read run artifacts:")).toBe(true);
    expect(gateRefusal.startsWith("cannot read run artifacts:")).toBe(false);

    const rows: ScanRow[] = [runRow(`${ROOT}/run-1`, ELIGIBLE), runRow(`${ROOT}/run-2`, ELIGIBLE)];
    const h = harness(rows, (runDir) =>
      Promise.reject(new ResumeNotEligibleError(runDir === `${ROOT}/run-1` ? readFailure : gateRefusal)),
    );

    const exitCode = await sweepRuns(h.options, h.deps);

    expect(exitCode).toBe(0);
    // outcome `error`, on stderr, detail carrying the message in full — the diagnosis this
    // routing gives up (it does not distinguish WHICH read failed) lives entirely in that text.
    expect(h.stderrLines.slice(1)).toEqual([`${ROOT}/run-1\terror\t${readFailure}`]);
    // ...and nowhere on stdout, while the contrast row is still an ordinary stdout refusal.
    expect(h.stdoutLines).toEqual([
      `${ROOT}/run-2\trefused\t${gateRefusal}`,
      "2 attempted, 0 succeeded, 1 refused, 1 errored (quota 0/100)",
    ]);
  });

  it("prints a reconciliation_write_abandoned note on stderr without changing the run outcome", async () => {
    // §4.3: the abandonment is ORTHOGONAL to the run's final classification — both runs here end
    // `succeeded` AND produce a note. Filing it under `error` would let one local event misreport
    // the whole run. run-2's detail carries a newline, which must be folded so that one
    // abandonment stays one line instead of looking like several.
    const plainDetail = "EACCES: permission denied, rename 'reconciliation-record.json.tmp'";
    const multilineDetail = "SyntaxError: Unexpected end of JSON input\nat JSON.parse (<anonymous>)";
    // Scrambled on purpose: note lines follow the sweep's TRAVERSAL order (the sorted order), not
    // the order the scan handed the rows back in.
    const rows: ScanRow[] = [runRow(`${ROOT}/run-2`, ELIGIBLE), runRow(`${ROOT}/run-1`, ELIGIBLE)];
    // Preconditions, asserted rather than assumed: the fixture really is out of sorted order, and
    // the second detail really does contain the newline the folding exists for. Without the
    // first, the note-order assertion would hold for an implementation with no ordering at all;
    // without the second, the folding assertion would pass on a string that never needed folding.
    expect(rows.map((row) => (row.kind === "run" ? row.path : ""))).toEqual([`${ROOT}/run-2`, `${ROOT}/run-1`]);
    expect(multilineDetail).toContain("\n");

    const h = harness(rows, (runDir, _adapter, resumeOptions) => {
      resumeOptions?.onAdopted?.();
      resumeOptions?.onReconciliationWriteAbandoned?.(runDir === `${ROOT}/run-1` ? plainDetail : multilineDetail);
      return Promise.resolve(finishedState);
    });

    const exitCode = await sweepRuns(h.options, h.deps);

    // (4) the exit code is what a completed sweep returns; the abandonment does not change it.
    expect(exitCode).toBe(0);
    // (2) both runs' own outcomes are untouched and still on stdout, and (3) `errored` is 0.
    // Checked BEFORE the stderr assertion on purpose: filing the abandonment under `error` would
    // move these lines to stderr as well, and this ordering makes that failure report itself
    // against the clause it actually violates instead of against the note line's.
    expect(h.stdoutLines).toEqual([
      `${ROOT}/run-1\tsucceeded\tstopReason=null`,
      `${ROOT}/run-2\tsucceeded\tstopReason=null`,
      "2 attempted, 2 succeeded, 0 refused, 0 errored (quota 2/100)",
    ]);
    // (1) one note line per callback invocation, on stderr, in traversal order, each on ONE line
    // — and nothing else on stderr past the banner.
    expect(h.stderrLines.slice(1)).toEqual([
      `note  ${ROOT}/run-1  reconciliation_write_abandoned  ${plainDetail}`,
      `note  ${ROOT}/run-2  reconciliation_write_abandoned  SyntaxError: Unexpected end of JSON input at JSON.parse (<anonymous>)`,
    ]);
    // The note is a separate line, never a fourth column or a cell of the three-column report.
    expect(h.stdoutLines.join("\n")).not.toContain("reconciliation_write_abandoned");
  });

  it("keeps the abandonment note on stderr even when the run throws afterwards", async () => {
    // The guard behind rejecting the "read the notes off resume's return value" design: on a
    // throw path there is no return value, so a note collected only at return is lost exactly
    // when an operator most needs it. Recording it in the callback is what survives the throw.
    const abandonDetail = "EACCES: permission denied, rename 'reconciliation-record.json.tmp'";
    const throwMessage = "ENOSPC: no space left on device, write loop-state.json";
    const rows: ScanRow[] = [runRow(`${ROOT}/run-1`, ELIGIBLE)];

    let abandonedThenThrew = 0;
    const h = harness(rows, (_runDir, _adapter, resumeOptions) => {
      resumeOptions?.onAdopted?.();
      resumeOptions?.onReconciliationWriteAbandoned?.(abandonDetail);
      abandonedThenThrew += 1;
      return Promise.reject(new Error(throwMessage));
    });

    const exitCode = await sweepRuns(h.options, h.deps);

    // The stand-in really did abandon and then throw — the counter sits between the callback and
    // the rejection, so without this the assertions below would also hold for a run that never
    // reached the throw at all.
    expect(abandonedThenThrew).toBe(1);
    expect(exitCode).toBe(0);
    // BOTH lines survive, on stderr. Their relative order is deliberately NOT asserted: the
    // cross-stream ordering promise was withdrawn, and the only ordering this layer promises is
    // between note lines themselves.
    expect(h.stderrLines).toContain(`note  ${ROOT}/run-1  reconciliation_write_abandoned  ${abandonDetail}`);
    expect(h.stderrLines).toContain(`${ROOT}/run-1\terror\t${throwMessage}`);
  });
});
