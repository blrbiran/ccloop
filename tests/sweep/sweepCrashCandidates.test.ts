// Spec 2026-10-02 crash-resume §4.4 / T10: sweep's second candidate class, chosen from observed fields only.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepRuns } from "../../src/sweep/sweepRuns.js";
import type { SweepDeps, SweepOptions } from "../../src/sweep/sweepRuns.js";
import type { ScanRow } from "../../src/registry/scanRuns.js";
import type { FieldObservation } from "../../src/registry/types.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import type { RunState } from "../../src/state/types.js";

const ROOT = "/fake/root";
const OBSERVED_AT = "2026-08-04T00:00:00.000Z";
const lease = (agoMs: number): FieldObservation => ({ kind: "present", value: new Date(Date.parse(OBSERVED_AT) - agoMs).toISOString() });

function row(path: string, o: { transfer: FieldObservation; status: string; lease: FieldObservation }): ScanRow {
  return {
    kind: "run",
    path,
    observedAt: OBSERVED_AT,
    files: [
      { file: "loop-state.json", fields: { status: { kind: "present", value: o.status } } },
      { file: "owner-record.json", fields: { leaseAffirmedAt: o.lease } },
      { file: "owner-transfer.json", fields: { eligibleForContinuation: o.transfer } },
    ],
  };
}
const ABSENT: FieldObservation = { kind: "absent" };
const ELIGIBLE: FieldObservation = { kind: "present", value: true };
const NULL_LEASE: FieldObservation = { kind: "present", value: null };

const done = { status: "succeeded", stopReason: null } as unknown as RunState;
const BANNER_B = (k: number) =>
  `sweep: ${k} run(s) under ${ROOT} have no owner-transfer.json, a resumable status and an expired lease (observed fields; each is resumed only if its owner is confirmed dead)`;

async function run(rows: ScanRow[], resume: (dir: string) => Promise<RunState> = () => Promise.resolve(done)) {
  const calls: string[] = [];
  const err: string[] = [];
  const options: SweepOptions = {
    root: ROOT, adapterName: "scripted", createAdapter: () => ({}) as RuntimeAdapter, maxRuns: 100,
    stopRequested: { requested: false }, stdout: () => {}, stderr: (l) => err.push(l),
  };
  const deps: SweepDeps = {
    scan: () => Promise.resolve(rows),
    resume: (dir) => { calls.push(dir); return resume(dir); },
    lockPresence: () => Promise.resolve(false),
  };
  await sweepRuns(options, deps);
  return { calls, err };
}

describe("sweep class (b): killed runs from observed fields", () => {
  const A = row("/fake/root/b-a", { transfer: ELIGIBLE, status: "executing", lease: NULL_LEASE });
  const B = row("/fake/root/a-b", { transfer: ABSENT, status: "executing", lease: lease(91_000) });
  const C = row("/fake/root/c", { transfer: ABSENT, status: "executing", lease: lease(10_000) });
  const D = row("/fake/root/d", { transfer: ABSENT, status: "executing", lease: NULL_LEASE });
  const E = row("/fake/root/e", { transfer: ABSENT, status: "succeeded", lease: lease(91_000) });

  it("takes only the expired-lease resumable row, counts it on its own line, resumes in path order, survives a rejection", async () => {
    const { calls, err } = await run([A, B, C, D, E], (dir) =>
      dir.endsWith("a-b") ? Promise.reject(new Error("boom")) : Promise.resolve(done));
    expect(calls).toEqual(["/fake/root/a-b", "/fake/root/b-a"]);
    expect(err[0]).toBe(
      `sweep: 1 run(s) under ${ROOT} observed eligibleForContinuation=true (an observed field, not a decision that the run may be resumed), will attempt at most 100, adapter=scripted`);
    expect(err[1]).toBe(BANNER_B(1));
  });

  it("prints no second line when there is no class (b) row", async () => {
    const { err } = await run([A, C, D, E]);
    expect(err.filter((l) => l.startsWith("sweep:"))).toHaveLength(1);
    expect(err.some((l) => l.includes("no owner-transfer.json"))).toBe(false);
  });

  it("leaves an Orca control run (basename run with a sibling control/) to Orca, and does not count it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sweep-ctl-"));
    mkdirSync(join(tmp, "x", "run"), { recursive: true });
    mkdirSync(join(tmp, "x", "control"));
    mkdirSync(join(tmp, "y", "run"), { recursive: true });
    const shape = { transfer: ABSENT, status: "executing", lease: lease(91_000) };
    const { calls, err } = await run([row(join(tmp, "x", "run"), shape), row(join(tmp, "y", "run"), shape)]);
    expect(calls).toEqual([join(tmp, "y", "run")]);
    expect(err[1]).toBe(BANNER_B(1));
  });
});
