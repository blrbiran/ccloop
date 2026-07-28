// L2 run registry — the zero-write proof against a REAL filesystem, using defaultScanDeps
// (production bindings), not injected fakes. See
// docs/superpowers/specs/2026-07-28-run-registry-design.md §7.1, §12.1.
//
// The load-bearing part of this file is the first test: it proves the fixture genuinely
// triggers readOwnerRecord's crash recovery (fileStore.ts:549-563), so that binding the
// forbidden reader (§7.1) would actually fail the second test. Without that proof, a fixture
// that silently fails to trigger recovery yields a zero-write test that passes for the wrong
// reason — spec §12.1 amendment (f).

import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { scanRuns, defaultScanDeps } from "../../src/registry/scanRuns.js";
import type { ScanRow } from "../../src/registry/scanRuns.js";
import { readOwnerRecord, writeOwnerRecord, writeOwnerTransferRecord } from "../../src/persistence/fileStore.js";
import { applyOwnerEpochTransfer } from "../../src/ownership/ownerController.js";
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
