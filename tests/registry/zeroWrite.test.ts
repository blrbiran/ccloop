// L2 run registry — the zero-write proof against a REAL filesystem, using defaultScanDeps
// (production bindings), not injected fakes. See
// docs/superpowers/specs/2026-07-28-run-registry-design.md §7.1, §12.1.
//
// The load-bearing part of this file is the first test: it proves the fixture genuinely
// triggers readOwnerRecord's crash recovery (fileStore.ts:549-563), so that binding the
// forbidden reader (§7.1) would actually fail the second test. Without that proof, a fixture
// that silently fails to trigger recovery yields a zero-write test that passes for the wrong
// reason — spec §12.1 amendment (f).

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { scanRuns, defaultScanDeps } from "../../src/registry/scanRuns.js";
import type { ScanRow } from "../../src/registry/scanRuns.js";
import { readOwnerRecord, writeOwnerRecord, writeOwnerTransferRecord } from "../../src/persistence/fileStore.js";
import { applyOwnerEpochTransfer } from "../../src/ownership/ownerController.js";
import { checkRunLease } from "../../src/controller/leaseGate.js";
import { buildProcessInstanceId } from "../../src/runtime/processIdentity.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import { sweepRuns } from "../../src/sweep/sweepRuns.js";
import type { LoopContract } from "../../src/contract/schema.js";
import type { OwnerRecord } from "../../src/runtime/types.js";
import type { RunState } from "../../src/state/types.js";

type FileSnapshot = { size: number; mtimeMs: number; sha256: string };

// Snapshots every path under `root` as (relative path, size, mtimeMs, sha256 of contents).
// Deliberately compares mtimeMs, not the mtime Date object (Date equality by reference would
// pass spuriously even across a genuine rewrite), and deliberately omits atime (reading a
// file legitimately updates it on some mounts, which would make the test flake).
async function snapshotTree(root: string): Promise<Record<string, FileSnapshot>> {
  const snapshot: Record<string, FileSnapshot> = {};

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath).split(sep).join("/");

      if (entry.isSymbolicLink()) {
        // lstat/readlink, never stat: a symlink entry must never be followed while building
        // the snapshot either, or this function would defeat its own purpose.
        const stat = await lstat(fullPath);
        const target = await readlink(fullPath);
        snapshot[relPath] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256: `symlink:${target}` };
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      const [stat, contents] = await Promise.all([lstat(fullPath), readFile(fullPath)]);
      snapshot[relPath] = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: createHash("sha256").update(contents).digest("hex"),
      };
    }
  }

  await walk(root);
  return snapshot;
}

const validRunState: RunState = {
  status: "queued",
  currentAttempt: 0,
  attemptsUsed: 0,
  lastTransitionAt: "2026-07-14T00:00:00.000Z",
  waitingOnHuman: false,
  stopReason: null,
  budgetSnapshot: { attemptsRemaining: 3, timeRemainingMs: 5000, tokenBudgetRemaining: 1000 },
  recentFailures: [],
};

function baseOwnerRecord(): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1/session-1",
    currentOwnerEpoch: 1,
    currentProcessInstanceId: "pid:12345",
    lastAffirmedAt: "2026-07-22T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
  };
}

// Requirement 3 / brief step 1: builds the run whose owner-transfer state satisfies all three
// preconditions recoverInterruptedOwnerTransfer checks (fileStore.ts:549-563) at once:
//   - .owner-transfer.transaction.json present (the trigger, :552)
//   - .owner-record.pending.json and .owner-transfer.pending.json present
//     (finalizePendingOwnerTransfer reads both, :529-530, and throws ENOENT otherwise)
//   - .owner-transfer.lock absent (a live lock makes recovery a no-op, :559-561)
async function buildRecoveryRun(scanRoot: string): Promise<string> {
  const recoveryRun = join(scanRoot, "run-recovery");
  await mkdir(recoveryRun, { recursive: true });

  const initialOwnerRecord = baseOwnerRecord();
  const transfer = applyOwnerEpochTransfer(
    initialOwnerRecord,
    "pid:67890",
    "2026-07-22T10:05:00.000Z",
    "owner lost after reconciliation",
  );

  await writeOwnerRecord(recoveryRun, initialOwnerRecord);
  await writeOwnerTransferRecord(recoveryRun, transfer.transferRecord);
  await writeFile(join(recoveryRun, "loop-state.json"), JSON.stringify(validRunState, null, 2));

  await writeFile(
    join(recoveryRun, ".owner-transfer.pending.json"),
    JSON.stringify(transfer.transferRecord, null, 2),
  );
  await writeFile(
    join(recoveryRun, ".owner-record.pending.json"),
    JSON.stringify(transfer.nextOwnerRecord, null, 2),
  );
  await writeFile(
    join(recoveryRun, ".owner-transfer.transaction.json"),
    JSON.stringify(
      {
        version: 1,
        stagedAt: transfer.transferRecord.transferredAt,
        finalizeOrder: ["owner-transfer.json", "owner-record.json"],
      },
      null,
      2,
    ),
  );
  // .owner-transfer.lock deliberately absent.

  return recoveryRun;
}

// Builds the rest of the tree: brief requirement 4's error-path fixtures (a run with a
// malformed loop-state.json, a run missing owner-record.json, and a nested
// worktrees/attempt-1 run), plus the controller's extra requirement — a real symlink pointing
// at a directory that holds a valid run, placed outside scanRoot so the run is reachable only
// through the symlink.
async function buildFixture(tempRoot: string): Promise<{ scanRoot: string }> {
  const scanRoot = join(tempRoot, "scan-root");
  await buildRecoveryRun(scanRoot);

  const transferForOtherRuns = applyOwnerEpochTransfer(
    baseOwnerRecord(),
    "pid:67890",
    "2026-07-22T10:05:00.000Z",
    "owner lost after reconciliation",
  ).transferRecord;

  const malformedRun = join(scanRoot, "run-malformed-state");
  await mkdir(malformedRun, { recursive: true });
  await writeFile(join(malformedRun, "loop-state.json"), "{ this is not valid json");
  await writeOwnerRecord(malformedRun, baseOwnerRecord());
  await writeOwnerTransferRecord(malformedRun, transferForOtherRuns);

  const missingOwnerRun = join(scanRoot, "run-missing-owner");
  await mkdir(missingOwnerRun, { recursive: true });
  await writeFile(join(missingOwnerRun, "loop-state.json"), JSON.stringify(validRunState, null, 2));
  await writeOwnerTransferRecord(missingOwnerRun, transferForOtherRuns);
  // owner-record.json intentionally absent.

  const nestedOuter = join(scanRoot, "run-nested");
  const nestedInner = join(nestedOuter, "worktrees", "attempt-1");
  await mkdir(nestedInner, { recursive: true });
  await writeFile(join(nestedOuter, "loop-state.json"), JSON.stringify(validRunState, null, 2));
  await writeFile(join(nestedInner, "loop-state.json"), JSON.stringify(validRunState, null, 2));

  const symlinkTargetRun = join(tempRoot, "outside-target", "real-run");
  await mkdir(symlinkTargetRun, { recursive: true });
  await writeFile(join(symlinkTargetRun, "loop-state.json"), JSON.stringify(validRunState, null, 2));
  const symlinkParent = join(scanRoot, "run-with-symlink");
  await mkdir(symlinkParent, { recursive: true });
  await symlink(symlinkTargetRun, join(symlinkParent, "link-to-run"), "dir");

  return { scanRoot };
}

describe("zero-write proof against a real filesystem (spec §7.1, §12.1)", () => {
  it("is load-bearing: readOwnerRecord itself mutates the recovery fixture (brief step 1)", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-registry-zerowrite-"));
    try {
      const recoveryRun = await buildRecoveryRun(join(tempRoot, "scan-root"));

      const before = await snapshotTree(tempRoot);
      await readOwnerRecord(recoveryRun);
      const after = await snapshotTree(tempRoot);

      // If this fails, the fixture does not genuinely trigger recovery and the zero-write
      // test below would prove nothing — stop and report per the task brief.
      expect(after).not.toEqual(before);

      // The staging files finalize and disappear; owner-record.json / owner-transfer.json
      // are rewritten to the transferred (epoch 2) content.
      expect(after["scan-root/run-recovery/.owner-transfer.transaction.json"]).toBeUndefined();
      expect(after["scan-root/run-recovery/.owner-record.pending.json"]).toBeUndefined();
      expect(after["scan-root/run-recovery/.owner-transfer.pending.json"]).toBeUndefined();

      const rewrittenOwner = JSON.parse(
        await readFile(join(recoveryRun, "owner-record.json"), "utf8"),
      ) as OwnerRecord;
      expect(rewrittenOwner.currentOwnerEpoch).toBe(2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("scans a realistic tree with defaultScanDeps and writes nothing, including on the recovery path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-registry-zerowrite-"));
    try {
      const { scanRoot } = await buildFixture(tempRoot);

      const before = await snapshotTree(tempRoot);
      const rows = await scanRuns(scanRoot, defaultScanDeps);
      const after = await snapshotTree(tempRoot);

      expect(after).toEqual(before);

      const runs = rows.filter((row): row is Extract<ScanRow, { kind: "run" }> => row.kind === "run");
      expect(runs.map((r) => r.path).sort()).toEqual(
        [
          join(scanRoot, "run-malformed-state"),
          join(scanRoot, "run-missing-owner"),
          join(scanRoot, "run-nested"),
          join(scanRoot, "run-recovery"),
        ].sort(),
      );

      // Extra requirement (controller): the symlinked run is reachable only through
      // run-with-symlink/link-to-run, which must not be followed — its target must not be
      // reported as a run at all.
      expect(runs.some((r) => r.path.includes("real-run"))).toBe(false);
      expect(runs.some((r) => r.path.includes("outside-target"))).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

// =================================================================================================
// L3 Task C4 — the sweep WRITE SURFACE (tests 14 and 14b).
//
// These two drive the REAL sweepRuns over a REAL filesystem with its REAL default `resume`
// (resumeLoop) and REAL default `scan` — no injected stand-in on either side. That is the whole
// point: the write surface being pinned here is the one the production wiring produces.
//
// "The sweep does not write one byte into any run directory" is LITERALLY FALSE (see the header
// of src/sweep/sweepRuns.ts) and is deliberately not claimed anywhere below. Test 14 pins the
// exact shape of the writes a gate-refused run receives; test 14b pins that the recovery a sweep
// causes really happens. They are a pair: 14 alone would be satisfied by an implementation that
// does nothing at all.
//
// The fixtures below deliberately do NOT copy the `scanRuns`/`readOwnerRecord` shape of the two
// tests above — 14b has to reach `loadContract` / `cleanupResidualWorktrees(repoPath, …)` /
// `runLoopFromState`, none of which the older fixtures set up. Per the C4 brief's ruling, the
// "Test only, in this file" constraint is what is binding; the shape hint is not a ceiling.
// =================================================================================================

const execFileAsync = promisify(execFile);

// Every staging path of the owner-transfer transaction, one literal per constant in
// fileStore.ts (see OWNER_RECORD_TEMP_FILE … RECONCILIATION_RECORD_PENDING_TEMP_FILE). 11 =
// 1 marker + the 10 that cleanupOwnerTransferStagingWithoutMarker recycles; the marker is not
// one of those 10 because its ABSENCE is that function's precondition.
//
// Why test 14 asserts all eleven are absent rather than trusting the fixture: if any of them is
// present, resumeLoop's Promise.all reaches readOwnerRecord -> recoverInterruptedOwnerTransfer,
// which can finalize a pending transaction (3 renames, several unlinks and a new
// reconciliation-record.json) — and then "exactly two appended events, everything else
// byte-identical" is false for reasons that have nothing to do with the sweep. resumeLoop has no
// equivalent of L2 §7.1's readOwnerRecordWithoutRecovery protection.
const OWNER_TRANSFER_STAGING_PATHS = [
  // marker (1)
  ".owner-transfer.transaction.json",
  // pending (3)
  ".owner-record.pending.json",
  ".owner-transfer.pending.json",
  ".reconciliation-record.pending.json",
  // publish temp (3)
  ".owner-record.publish.tmp",
  ".owner-transfer.publish.tmp",
  ".reconciliation-record.publish.tmp",
  // marker temp (1)
  ".owner-transfer.transaction.tmp",
  // pending temp (3)
  ".owner-record.pending.tmp",
  ".owner-transfer.pending.tmp",
  ".reconciliation-record.pending.tmp",
] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-c4-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

// Same shape as tests/controller/resumeLoop.integration.test.ts's createContract — the strict
// (zod .strict()) loopContractSchema rejects anything else, and resumeLoop parses this file
// inside the same Promise.all that reads the four ownership artifacts.
function createContract(repoPath: string): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix", successCondition: "pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["tests fail"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

const interruptedRunState: RunState = {
  status: "executing",
  currentAttempt: 1,
  attemptsUsed: 1,
  lastTransitionAt: "2026-08-04T00:00:00.000Z",
  waitingOnHuman: false,
  stopReason: null,
  budgetSnapshot: { attemptsRemaining: 2, timeRemainingMs: 5000, tokenBudgetRemaining: 1000 },
  recentFailures: [],
};

// One pre-existing line, so "appended exactly two" can be checked as a byte PREFIX plus two
// lines rather than as a line count on a file that started empty (a rewrite-from-scratch would
// be indistinguishable from an append on an empty file).
const SEEDED_EVENT_LINE = `${JSON.stringify({ type: "fixture_seed", at: "2026-08-04T00:00:00.000Z", detail: "seeded by the C4 fixture" })}\n`;

// leaseAffirmedAt is written EXPLICITLY as null (not omitted): mechanism one below asserts the
// key is present, so that assertion cannot pass by the key simply being absent.
function c4OwnerRecord(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1:t0",
    currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:100",
    lastAffirmedAt: "2026-08-04T00:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
    ...overrides,
  };
}

function c4TransferRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    priorOwnerEpoch: 1,
    newOwnerEpoch: 2,
    priorProcessInstanceId: "pid:100",
    newProcessInstanceId: "pid:100",
    transferredAt: "2026-08-04T00:00:00.000Z",
    reason: "owner lost",
    eligibleForContinuation: true,
    ...overrides,
  };
}

function c4ReconciliationRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    staleSuspicionBasis: [],
    staleConfirmed: true,
    ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute",
    conflictingEvidence: [],
    takeoverPermission: { allowed: true, reason: "ok" },
    priorOwnerEpoch: 1,
    newOwnerEpoch: 2,
    eligibleForContinuation: true,
    ...overrides,
  };
}

// A run directory L2 OBSERVES as eligible (owner-transfer.json's eligibleForContinuation is
// literal true, which is the only field sweepRuns' filter reads) whose resume the eligibility
// GATE nevertheless refuses.
//
// Mechanism three: the refusal has to come from evaluateResumeEligibility, not from the CAS
// gate. Going through claimOwnerRecordWithPrecondition would create and delete
// .owner-transfer.lock and run a lockHeld recovery pass, so "everything else byte-identical"
// would be false against a whole-directory snapshot. reconciliation-record.json's
// eligibleForContinuation: false trips criterion 2 of the eight, so the CAS gate is never
// reached at all.
async function seedGateRefusedRun(runDir: string, contract: LoopContract): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
  await writeFile(join(runDir, "events.jsonl"), SEEDED_EVENT_LINE);
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify(interruptedRunState, null, 2));
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify(c4OwnerRecord(), null, 2));
  await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify(c4TransferRecord(), null, 2));
  await writeFile(
    join(runDir, "reconciliation-record.json"),
    JSON.stringify(c4ReconciliationRecord({ eligibleForContinuation: false }), null, 2),
  );
  // Mechanism two: no staging path is created here. Asserted, not assumed, in the test.
}

// The companion run: identical except that L2 observes it as NOT eligible, so sweepRuns' filter
// drops it and resumeLoop is never called on it. It is the subject of the companion assertion.
async function seedNonEligibleRun(runDir: string, contract: LoopContract): Promise<void> {
  await seedGateRefusedRun(runDir, contract);
  await writeFile(
    join(runDir, "owner-transfer.json"),
    JSON.stringify(c4TransferRecord({ eligibleForContinuation: false }), null, 2),
  );
}

function successFrame() {
  return {
    plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
    execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
    verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [] },
  };
}

async function readEventTypes(runDir: string): Promise<string[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line).type as string);
}

describe("sweep write surface", () => {
  it("appends exactly resume_requested and resume_denied to a gate-refused run and leaves the non-eligible run byte-identical", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-c4-writesurface-"));
    try {
      const scanRoot = join(tempRoot, "scan-root");
      // repoPath is never dereferenced on this path: the run is refused at the eligibility gate,
      // which is upstream of cleanupResidualWorktrees. If the gate ever stopped refusing, the
      // resume would fail loudly here rather than quietly passing.
      const contract = createContract(join(tempRoot, "repo-that-is-never-touched"));
      const refusedRun = join(scanRoot, "run-gate-refused");
      const nonEligibleRun = join(scanRoot, "run-not-eligible");
      await seedGateRefusedRun(refusedRun, contract);
      await seedNonEligibleRun(nonEligibleRun, contract);

      // ---- the three preconditions "exactly two events" depends on, ASSERTED before the sweep --

      // Mechanism one: leaseAffirmedAt must be null, so checkRunLease takes its `no_lease`
      // branch. If it were non-null and past the TTL, the lease gate would append a THIRD event
      // (lease_expired_observed) from inside leaseGate.ts before letting the resume proceed.
      const refusedOwnerBefore = JSON.parse(
        await readFile(join(refusedRun, "owner-record.json"), "utf8"),
      ) as Record<string, unknown>;
      // The key must be PRESENT. Without this line the null check below would also pass on a
      // record that simply omits the field.
      expect(Object.keys(refusedOwnerBefore)).toContain("leaseAffirmedAt");
      expect(refusedOwnerBefore.leaseAffirmedAt).toBeNull();
      // …and the branch is actually taken. This calls the same gate resumeLoop calls; in the
      // `no_lease` branch it writes nothing, and any other outcome fails here (before the
      // snapshot) instead of silently costing an extra event later.
      expect((await checkRunLease(refusedRun, buildProcessInstanceId())).kind).toBe("no_lease");

      // Mechanism two: no owner-transfer staging residue, all eleven paths named individually.
      expect(OWNER_TRANSFER_STAGING_PATHS).toHaveLength(11);
      // Positive control for the probe: a file that IS there must read as present, so the
      // eleven `false`s below cannot come from a broken probe or a missing directory.
      expect(await pathExists(join(refusedRun, "owner-record.json"))).toBe(true);
      for (const stagingPath of OWNER_TRANSFER_STAGING_PATHS) {
        expect([stagingPath, await pathExists(join(refusedRun, stagingPath))]).toEqual([stagingPath, false]);
      }

      // Mechanism three: the refusal must come from the eligibility gate, not the CAS gate. The
      // fixture premise is asserted here; the resume_denied detail asserted after the sweep is
      // what proves the gate that actually fired.
      const refusedReconciliation = JSON.parse(
        await readFile(join(refusedRun, "reconciliation-record.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(refusedReconciliation.eligibleForContinuation).toBe(false);

      // ---- the sweep ------------------------------------------------------------------------

      const refusedBefore = await snapshotTree(refusedRun);
      const nonEligibleBefore = await snapshotTree(nonEligibleRun);
      // Non-vacuity: both snapshots must actually describe the six seeded files. An empty
      // snapshot compares equal to an empty snapshot.
      const seededFiles = [
        "events.jsonl",
        "loop-contract.json",
        "loop-state.json",
        "owner-record.json",
        "owner-transfer.json",
        "reconciliation-record.json",
      ];
      expect(Object.keys(refusedBefore).sort()).toEqual(seededFiles);
      expect(Object.keys(nonEligibleBefore).sort()).toEqual(seededFiles);

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const exitCode = await sweepRuns({
        root: scanRoot,
        adapterName: "scripted",
        // No frame: a refused run never adopts, so the adapter must never be asked for one.
        createAdapter: () => new ScriptedAdapter([]),
        maxRuns: 5,
        stopRequested: { requested: false },
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
      });

      // A refusal is a reported outcome, not a sweep failure.
      expect(exitCode).toBe(0);
      expect(stdoutLines).toEqual([
        `${refusedRun}\trefused\treconciliation-record is not eligible for continuation`,
        "1 attempted, 0 succeeded, 1 refused, 0 errored (quota 0/5)",
      ]);
      // Exactly one run passed the filter — i.e. the non-eligible run was never a candidate.
      expect(stderrLines).toEqual([
        `sweep: 1 run(s) under ${scanRoot} observed eligibleForContinuation=true ` +
          `(an observed field, not a decision that the run may be resumed), ` +
          `will attempt at most 5, adapter=scripted`,
      ]);

      // ---- the write surface of the gate-refused run ------------------------------------------

      const refusedEventsRaw = await readFile(join(refusedRun, "events.jsonl"), "utf8");
      // Append-only: the seeded line is still there, byte for byte, at the front.
      expect(refusedEventsRaw.startsWith(SEEDED_EVENT_LINE)).toBe(true);
      const appended = refusedEventsRaw.slice(SEEDED_EVENT_LINE.length).split("\n").filter(Boolean);
      expect(appended).toHaveLength(2);
      expect(await readEventTypes(refusedRun)).toEqual(["fixture_seed", "resume_requested", "resume_denied"]);
      const denied = JSON.parse(appended[1]) as { type: string; detail: string };
      // Mechanism three, confirmed by the writer: this is criterion 2 of
      // evaluateResumeEligibility's eight, word for word. A CAS refusal would read "claim CAS
      // failed: …", a lock refusal "owner-transfer lock busy: …", and a read failure "cannot
      // read run artifacts: …" — none of which reach this string.
      expect(denied.type).toBe("resume_denied");
      expect(denied.detail).toBe("reconciliation-record is not eligible for continuation");

      // …and NOTHING ELSE in that directory changed: no owner-record rewrite from a CAS claim,
      // no .owner-transfer.lock created and removed, no staged file finalized.
      const refusedAfter = await snapshotTree(refusedRun);
      // Non-vacuity for the exclusion below: events.jsonl must exist in both snapshots and must
      // have genuinely changed, or "everything except events.jsonl is unchanged" would be a
      // claim about a file that was never written in the first place.
      expect(refusedBefore["events.jsonl"]).toBeDefined();
      expect(refusedAfter["events.jsonl"]).toBeDefined();
      expect(refusedAfter["events.jsonl"]).not.toEqual(refusedBefore["events.jsonl"]);
      const { "events.jsonl": _beforeEvents, ...refusedBeforeRest } = refusedBefore;
      const { "events.jsonl": _afterEvents, ...refusedAfterRest } = refusedAfter;
      expect(Object.keys(refusedAfterRest).sort()).toEqual(seededFiles.filter((f) => f !== "events.jsonl"));
      expect(refusedAfterRest).toEqual(refusedBeforeRest);
      // No staging residue was manufactured either.
      for (const stagingPath of OWNER_TRANSFER_STAGING_PATHS) {
        expect([stagingPath, await pathExists(join(refusedRun, stagingPath))]).toEqual([stagingPath, false]);
      }
      expect(await pathExists(join(refusedRun, ".owner-transfer.lock"))).toBe(false);

      // ---- the companion assertion: the NON-ELIGIBLE run is byte-identical ---------------------
      //
      // This is the subject of the mutation "sweep calls resume on non-eligible rows too": under
      // it, THIS directory gains resume_requested + resume_denied and this assertion fails.
      const nonEligibleAfter = await snapshotTree(nonEligibleRun);
      expect(Object.keys(nonEligibleAfter).sort()).toEqual(seededFiles);
      expect(nonEligibleAfter).toEqual(nonEligibleBefore);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  // Not on the plan's list; added by the GATE-C fix wave, and the only test in the tree that
  // enters the PRODUCTION resumeLoop from a sweep. `cannot read run artifacts:` is a cross-module
  // string contract: resumeLoop.ts writes it, sweepRuns.ts' classifyThrow routes on it, and §4.4's
  // whole "fail loudly" promise is cashed by that routing — get the two sides out of step and a
  // run whose artifacts could not be read is filed as an ordinary refusal, printed to STDOUT with
  // exit 0, and cron never alerts. Every other sweep test injects a stand-in `resume` whose
  // message is a literal in the test file, so none of them can tell the two sides apart; the two
  // indirect guards elsewhere (cli.test.ts, fileStore.test.ts) both match WITHOUT the colon and
  // survive any edit to what follows it. Nothing here restates either literal: the expected
  // report line is DERIVED from the detail resumeLoop itself wrote to events.jsonl, so it is red
  // if either side moves.
  it("routes a real unreadable-artifacts refusal out of resumeLoop to stderr as one error line", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-fixwave-readfail-"));
    try {
      const scanRoot = join(tempRoot, "scan-root");
      const runDir = join(scanRoot, "run-unreadable-contract");
      // repoPath is never dereferenced: the resume dies in the artifact-read Promise.all, which is
      // upstream of cleanupResidualWorktrees.
      await seedGateRefusedRun(runDir, createContract(join(tempRoot, "repo-that-is-never-touched")));
      // The one difference from the gate-refused fixture: loop-contract.json is well-formed JSON
      // that does not satisfy loopContractSchema, so loadContract — the fifth read in resumeLoop's
      // Promise.all — throws a ZodError. This is the read-side failure §4.4 is about, produced by
      // production code rather than by a stand-in.
      await writeFile(join(runDir, "loop-contract.json"), JSON.stringify({ notAContract: true }, null, 2));

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const exitCode = await sweepRuns({
        root: scanRoot,
        adapterName: "scripted",
        // No frame: the run never adopts, so the adapter must never be asked for one.
        createAdapter: () => new ScriptedAdapter([]),
        maxRuns: 5,
        stopRequested: { requested: false },
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
      });

      // resumeLoop really was entered and really did refuse on the read: the event it appends
      // before throwing carries the same detail as the error it throws.
      const deniedLines = (await readFile(join(runDir, "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; detail: string })
        .filter((event) => event.type === "resume_denied");
      expect(deniedLines).toHaveLength(1);
      const detail = deniedLines[0].detail;
      // Preconditions, asserted rather than assumed. (1) A ZodError's message is many lines, so
      // the report line below is genuinely exercising the fold rather than folding nothing; if a
      // future zod made it one line this fails loudly instead of going quietly vacuous. (2) The
      // sweep did not silently skip the run.
      expect(detail).toContain("\n");
      expect(await readEventTypes(runDir)).toEqual(["fixture_seed", "resume_requested", "resume_denied"]);

      expect(exitCode).toBe(0);
      // The binding assertion: outcome `error`, on stderr, ONE line, three columns, and its detail
      // is exactly what resumeLoop wrote, folded. Change the literal on either side — including
      // only what follows the colon — and this run is classified `refused` and printed on stdout
      // instead, taking both of these assertions with it.
      expect(stderrLines.slice(1)).toEqual([`${runDir}\terror\t${detail.replace(/\r?\n/g, " ")}`]);
      expect(stdoutLines).toEqual(["1 attempted, 0 succeeded, 0 refused, 1 errored (quota 0/5)"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("finalizes a staged three-file transaction during sweep and admits the run afterwards", async () => {
    const repoPath = await createRepo();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-c4-recovery-"));
    try {
      const scanRoot = join(tempRoot, "scan-root");
      const runDir = join(scanRoot, "run-staged-transaction");
      await mkdir(join(runDir, "attempts"), { recursive: true });

      // PUBLISHED (pre-finalize) state: the crash happened after the pendings and the marker were
      // written and before any of the three renames. owner-record.json is therefore still at
      // epoch 1, while owner-transfer.json and reconciliation-record.json still carry the
      // pre-transaction values of the two fields nothing in the resume path reads (`reason` and
      // `takeoverPermission.reason`) — those two are the discriminators assertion (i) uses to show
      // the STAGED bytes are what ended up published.
      //
      // Why every GATE-RELEVANT field is already at its post-finalize value here, rather than
      // being left stale so that recovery alone could supply it: resumeLoop reads the five
      // artifacts in ONE Promise.all, so readOwnerTransferRecord / readReconciliationRecord /
      // readRunState run CONCURRENTLY with readOwnerRecord's recoverInterruptedOwnerTransfer.
      // Those three are plain reads with no recovery in front of them, so whether they observe
      // the pre- or post-rename bytes is a race. Only readOwnerRecord is ordered after recovery
      // by construction — so currentOwnerEpoch (criterion 6) is the one field a fixture may
      // legitimately require recovery to supply, and it is the one this fixture uses.
      // A staged transaction whose reconciliation-record.json is not published AT ALL is refused
      // with "cannot read run artifacts: … ENOENT" for exactly this reason; that was measured,
      // not assumed (see the C4 report).
      //
      // owner-transfer.json's eligibleForContinuation is already true — that is the only field
      // sweepRuns' filter reads, so this run is a candidate even before recovery.
      await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(createContract(repoPath), null, 2));
      await writeFile(join(runDir, "events.jsonl"), "");
      await writeFile(join(runDir, "loop-state.json"), JSON.stringify(interruptedRunState, null, 2));
      await writeFile(
        join(runDir, "owner-record.json"),
        JSON.stringify(c4OwnerRecord({ currentOwnerEpoch: 1 }), null, 2),
      );
      await writeFile(
        join(runDir, "owner-transfer.json"),
        JSON.stringify(c4TransferRecord({ reason: "staged, not yet finalized" }), null, 2),
      );
      await writeFile(
        join(runDir, "reconciliation-record.json"),
        JSON.stringify(
          c4ReconciliationRecord({ takeoverPermission: { allowed: true, reason: "published before the crash" } }),
          null,
          2,
        ),
      );

      // STAGED state — L2 §12.1's precondition set verbatim (marker present, .owner-record.pending
      // .json and .owner-transfer.pending.json present, .owner-transfer.lock absent), plus this
      // layer's addition: .reconciliation-record.pending.json, and a v2 marker whose finalizeOrder
      // names all three files.
      await writeFile(
        join(runDir, ".owner-record.pending.json"),
        JSON.stringify(c4OwnerRecord({ currentOwnerEpoch: 2 }), null, 2),
      );
      await writeFile(
        join(runDir, ".owner-transfer.pending.json"),
        JSON.stringify(c4TransferRecord({ reason: "owner lost mid-publish" }), null, 2),
      );
      await writeFile(
        join(runDir, ".reconciliation-record.pending.json"),
        JSON.stringify(
          c4ReconciliationRecord({ takeoverPermission: { allowed: true, reason: "staged by the interrupted transfer" } }),
          null,
          2,
        ),
      );
      await writeFile(
        join(runDir, ".owner-transfer.transaction.json"),
        JSON.stringify(
          {
            version: 2,
            stagedAt: "2026-08-04T00:00:00.000Z",
            finalizeOrder: ["owner-transfer.json", "owner-record.json", "reconciliation-record.json"],
          },
          null,
          2,
        ),
      );

      // ---- the fixture's premises, ASSERTED (spec §12.1: "must be asserted, not assumed") -----
      expect(await pathExists(join(runDir, ".owner-transfer.transaction.json"))).toBe(true);
      expect(await pathExists(join(runDir, ".owner-record.pending.json"))).toBe(true);
      expect(await pathExists(join(runDir, ".owner-transfer.pending.json"))).toBe(true);
      expect(await pathExists(join(runDir, ".reconciliation-record.pending.json"))).toBe(true);
      // A live lock makes recoverInterruptedOwnerTransfer a no-op, which would make every
      // assertion below pass or fail for the wrong reason.
      expect(await pathExists(join(runDir, ".owner-transfer.lock"))).toBe(false);
      // The three published files still hold their PRE-finalize values. These are what make
      // assertion (i) load-bearing rather than a restatement of the fixture: each of the three
      // values asserted after the sweep differs from the value asserted here.
      const publishedOwnerBefore = JSON.parse(
        await readFile(join(runDir, "owner-record.json"), "utf8"),
      ) as OwnerRecord;
      expect(publishedOwnerBefore.currentOwnerEpoch).toBe(1);
      const publishedTransferBefore = JSON.parse(
        await readFile(join(runDir, "owner-transfer.json"), "utf8"),
      ) as { reason: string };
      expect(publishedTransferBefore.reason).toBe("staged, not yet finalized");
      const publishedReconciliationBefore = JSON.parse(
        await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
      ) as { takeoverPermission: { reason: string } };
      expect(publishedReconciliationBefore.takeoverPermission.reason).toBe("published before the crash");

      // ---- the sweep --------------------------------------------------------------------------

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const exitCode = await sweepRuns({
        root: scanRoot,
        adapterName: "scripted",
        createAdapter: () => new ScriptedAdapter([successFrame()]),
        maxRuns: 5,
        stopRequested: { requested: false },
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
      });

      // ---- (i) all three files in place, carrying the STAGED content --------------------------
      expect(await pathExists(join(runDir, "owner-record.json"))).toBe(true);
      expect(await pathExists(join(runDir, "owner-transfer.json"))).toBe(true);
      expect(await pathExists(join(runDir, "reconciliation-record.json"))).toBe(true);

      const ownerAfter = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as OwnerRecord;
      // epoch 1 -> 2 can only have come from the staged pending being published.
      expect(ownerAfter.currentOwnerEpoch).toBe(2);
      expect(ownerAfter.ownerStatus).toBe("current");
      const transferAfter = JSON.parse(
        await readFile(join(runDir, "owner-transfer.json"), "utf8"),
      ) as { reason: string; newOwnerEpoch: number };
      // The published file carried "staged, not yet finalized" before the sweep.
      expect(transferAfter.reason).toBe("owner lost mid-publish");
      expect(transferAfter.newOwnerEpoch).toBe(2);
      const reconciliationAfter = JSON.parse(
        await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
      ) as {
        ownershipVerdict: string;
        newOwnerEpoch: number;
        eligibleForContinuation: boolean;
        takeoverPermission: { reason: string };
      };
      expect(reconciliationAfter.ownershipVerdict).toBe("OWNER_LOST");
      expect(reconciliationAfter.newOwnerEpoch).toBe(2);
      expect(reconciliationAfter.eligibleForContinuation).toBe(true);
      // The published file carried "published before the crash" before the sweep.
      expect(reconciliationAfter.takeoverPermission.reason).toBe("staged by the interrupted transfer");

      // ---- (ii) the marker and every pending have been recycled --------------------------------
      expect(await pathExists(join(runDir, ".owner-transfer.transaction.json"))).toBe(false);
      expect(await pathExists(join(runDir, ".owner-record.pending.json"))).toBe(false);
      expect(await pathExists(join(runDir, ".owner-transfer.pending.json"))).toBe(false);
      expect(await pathExists(join(runDir, ".reconciliation-record.pending.json"))).toBe(false);
      // The CAS gate's lock was released, not leaked.
      expect(await pathExists(join(runDir, ".owner-transfer.lock"))).toBe(false);

      // ---- (iii) resumeLoop ADMITTED the run --------------------------------------------------
      const eventTypes = await readEventTypes(runDir);
      expect(eventTypes).toContain("resume_requested");
      expect(eventTypes).toContain("resume_adopted");
      expect(eventTypes).not.toContain("resume_denied");
      // Adoption is what claims the record for this process; it happens after the CAS gate, which
      // is downstream of every one of the eight eligibility criteria.
      expect(ownerAfter.currentProcessInstanceId).toBe(buildProcessInstanceId());
      const finalState = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as RunState;
      expect(finalState.status).toBe("succeeded");
      expect(exitCode).toBe(0);
      expect(stdoutLines).toEqual([
        `${runDir}\tsucceeded\tstopReason=success condition satisfied`,
        "1 attempted, 1 succeeded, 0 refused, 0 errored (quota 1/5)",
      ]);
      expect(stderrLines).toEqual([
        `sweep: 1 run(s) under ${scanRoot} observed eligibleForContinuation=true ` +
          `(an observed field, not a decision that the run may be resumed), ` +
          `will attempt at most 5, adapter=scripted`,
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
