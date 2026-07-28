// L2 run registry — tests for the serialization (`toScanResult`) and human rendering
// (`renderScanTable`) surface. See
// docs/superpowers/specs/2026-07-28-run-registry-design.md §6.3, §8.2, §9, §12.5, §12.8.

import { describe, expect, it } from "vitest";
import { toScanResult, renderScanTable, scanRootFailureDetail } from "../../src/registry/renderRuns.js";
import { scanRuns, MAX_SCAN_DEPTH } from "../../src/registry/scanRuns.js";
import type { DirEntry, DirReader, ScanDeps, ScanRow } from "../../src/registry/scanRuns.js";
import type { RunFileReaders } from "../../src/registry/readObservedFile.js";

const fullyObservedRun: ScanRow = {
  kind: "run",
  path: "/fake/root/run-1",
  observedAt: "2026-07-28T00:00:00.000Z",
  files: [
    {
      file: "loop-state.json",
      fields: {
        status: { kind: "present", value: "queued" },
        currentAttempt: { kind: "present", value: 1 },
        attemptsUsed: { kind: "present", value: 0 },
        lastTransitionAt: { kind: "present", value: "2026-07-28T00:00:00.000Z" },
        stopReason: { kind: "present", value: null },
      },
    },
    {
      file: "owner-record.json",
      fields: {
        runId: { kind: "present", value: "run-1" },
        currentOwnerEpoch: { kind: "present", value: 1 },
        ownerStatus: { kind: "present", value: "active" },
        currentProcessInstanceId: { kind: "present", value: "proc-1" },
        leaseAffirmedAt: { kind: "present", value: "2026-07-28T00:00:00.000Z" },
      },
    },
    {
      file: "owner-transfer.json",
      fields: {
        eligibleForContinuation: { kind: "present", value: true },
      },
    },
  ],
};

const allAbsentRun: ScanRow = {
  kind: "run",
  path: "/fake/root/run-empty",
  observedAt: "2026-07-28T00:00:00.000Z",
  files: [
    { file: "loop-state.json", fields: { status: { kind: "absent" } } },
    { file: "owner-record.json", fields: { runId: { kind: "absent" } } },
    { file: "owner-transfer.json", fields: { eligibleForContinuation: { kind: "absent" } } },
  ],
};

const directoryUnreadableRow: ScanRow = {
  kind: "directory_unreadable",
  path: "/fake/root/locked",
  detail: "EACCES: permission denied",
};

const depthTruncatedRow: ScanRow = { kind: "depth_truncated", path: "/fake/root/very/deep/path" };

// Walks every object/array in a value and collects every object key seen, recursively.
function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      keys.add(key);
      collectKeys(val, keys);
    }
  }
}

describe("toScanResult", () => {
  // Requirement 4: schemaVersion is present and is 1 (spec §6.3).
  it("stamps schemaVersion 1 and carries the rows through unchanged", () => {
    const result = toScanResult([fullyObservedRun, directoryUnreadableRow]);
    expect(result.schemaVersion).toBe(1);
    expect(result.rows).toEqual([fullyObservedRun, directoryUnreadableRow]);
  });

  // Requirement 1 (spec §12.5): no derived field of any kind may appear in the serialized
  // output. The exemption for the mandated literal `eligibleForContinuation` is required —
  // §6 mandates observing it, so a blanket ban on any `eligible`-matching key would kill the
  // correct implementation. `kind` (the structural discriminant on rows and field
  // observations) does not match any forbidden pattern and is not exempted specially — it
  // simply never trips the assertion below.
  it("contains no derived fields in the serialized JSON (spec §12.5)", () => {
    const result = toScanResult([fullyObservedRun, allAbsentRun, directoryUnreadableRow, depthTruncatedRow]);
    const serialized = JSON.parse(JSON.stringify(result)) as unknown;

    const keys = new Set<string>();
    collectKeys(serialized, keys);

    for (const key of keys) {
      expect(key).not.toMatch(/resumable|fresh|stale|expired/i);
      if (/eligible/i.test(key)) {
        expect(key).toBe("eligibleForContinuation");
      }
    }

    // Sanity check that the exemption is actually exercised, not vacuously true because the
    // fixture never contained the field.
    expect(keys.has("eligibleForContinuation")).toBe(true);
  });

  // Finding: the test above walks module-local `ScanRow` literals, hand-authored in this file.
  // That constrains this file's shape, not what `scanRuns`/`observeRun` actually produce — a
  // new *optional* field added to production `RunObservation` and populated in production code
  // would ship unnoticed, because the literals above would still typecheck unchanged. This
  // test instead drives the real pipeline (`scanRuns` -> `observeRun` -> `readObservedFile` ->
  // `observeFields`, all production code) over a fake `DirReader`/`RunFileReaders` boundary —
  // the same seam tests/registry/scanRuns.test.ts uses — so a row actually assembled by that
  // pipeline is what gets serialized and checked (spec §15 #3: "enforced by a test, not by
  // convention").
  it("contains no derived fields when the rows are produced by the real scanRuns/observeRun pipeline, not test literals", async () => {
    const root = "/pipeline-root";
    const fullRun = `${root}/run-full`;
    const emptyRun = `${root}/run-empty`;
    const lockedDir = `${root}/locked`;

    // A chain one directory longer than MAX_SCAN_DEPTH allows, so the deepest directory is
    // truncated before it is ever listed or recognized (scanRuns.ts checks depth before both).
    const chainNames = Array.from({ length: MAX_SCAN_DEPTH + 1 }, (_, i) => `d${i + 1}`);
    const chainPaths: string[] = [];
    for (const name of chainNames) {
      chainPaths.push(`${chainPaths.at(-1) ?? root}/${name}`);
    }
    const truncatedPath = chainPaths.at(-1)!;

    const readDirMap = new Map<string, DirEntry[]>();
    readDirMap.set(root, [
      { name: "run-full", isDirectory: true, isSymbolicLink: false },
      { name: "run-empty", isDirectory: true, isSymbolicLink: false },
      { name: "locked", isDirectory: true, isSymbolicLink: false },
      { name: chainNames[0]!, isDirectory: true, isSymbolicLink: false },
    ]);
    readDirMap.set(fullRun, [
      { name: "loop-state.json", isDirectory: false, isSymbolicLink: false },
      { name: "owner-record.json", isDirectory: false, isSymbolicLink: false },
      { name: "owner-transfer.json", isDirectory: false, isSymbolicLink: false },
    ]);
    readDirMap.set(emptyRun, [{ name: "events.jsonl", isDirectory: false, isSymbolicLink: false }]);
    // Every chain directory but the last lists its single child; the last is never listed —
    // it is truncated on entry, before scanDir would call readDir on it.
    for (let i = 0; i < chainNames.length - 1; i++) {
      readDirMap.set(chainPaths[i]!, [{ name: chainNames[i + 1]!, isDirectory: true, isSymbolicLink: false }]);
    }

    const markerSet = new Set<string>([
      `${fullRun}/loop-state.json`,
      `${fullRun}/owner-record.json`,
      `${fullRun}/owner-transfer.json`,
      `${emptyRun}/events.jsonl`,
    ]);

    const dir: DirReader = {
      readDir: async (path: string) => {
        if (path === lockedDir) {
          const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        const entries = readDirMap.get(path);
        if (!entries) throw new Error(`fake fs: no directory registered for ${path}`);
        return entries;
      },
      fileExists: async (path: string) => markerSet.has(path),
    };

    function enoentError(): NodeJS.ErrnoException {
      const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return error;
    }

    const readers: RunFileReaders = {
      readRunState: async (runDir: string) => {
        if (runDir === fullRun) {
          return {
            status: "queued",
            currentAttempt: 1,
            attemptsUsed: 0,
            lastTransitionAt: "2026-07-28T00:00:00.000Z",
            stopReason: null,
          };
        }
        throw enoentError();
      },
      readOwnerRecordWithoutRecovery: async (runDir: string) => {
        if (runDir === fullRun) {
          return {
            runId: "run-full",
            currentOwnerEpoch: 1,
            ownerStatus: "active",
            currentProcessInstanceId: "proc-1",
            leaseAffirmedAt: "2026-07-28T00:00:00.000Z",
          };
        }
        throw enoentError();
      },
      readOwnerTransferRecord: async (runDir: string) => {
        if (runDir === fullRun) {
          return { eligibleForContinuation: true };
        }
        throw enoentError();
      },
    };

    const deps: ScanDeps = {
      readers,
      sleep: async () => {},
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      dir,
    };

    const rows = await scanRuns(root, deps);

    // Sanity check the fixture actually produced one of each row kind — otherwise a bug in the
    // fixture, not the guard, would be why no derived field ever showed up.
    expect(rows.filter((r) => r.kind === "run").map((r) => r.path).sort()).toEqual([emptyRun, fullRun]);
    expect(rows.some((r) => r.kind === "directory_unreadable" && r.path === lockedDir)).toBe(true);
    expect(rows.some((r) => r.kind === "depth_truncated" && r.path === truncatedPath)).toBe(true);

    const result = toScanResult(rows);
    const serialized = JSON.parse(JSON.stringify(result)) as unknown;

    const keys = new Set<string>();
    collectKeys(serialized, keys);

    for (const key of keys) {
      expect(key).not.toMatch(/resumable|fresh|stale|expired/i);
      if (/eligible/i.test(key)) {
        expect(key).toBe("eligibleForContinuation");
      }
    }

    expect(keys.has("eligibleForContinuation")).toBe(true);
  });
});

describe("renderScanTable", () => {
  // Requirement 3 (spec §8.2): the human table must state, in the rendered text itself, that
  // fields within a row are independent observations and do not constitute a consistent
  // snapshot. This is part of the contract, not decoration.
  it("states plainly that fields within a row are independent observations, not a snapshot", () => {
    const table = renderScanTable(toScanResult([fullyObservedRun]));
    expect(table).toMatch(/independent observation/i);
    expect(table).toMatch(/do not constitute a consistent snapshot|not a consistent snapshot/i);
  });

  // Finding: eligibleForContinuation can read true for a run with no reconciliation record on
  // disk (spec §13.1 #1) — the one field a hurried operator could misread as permission to
  // resume. The notice must caveat it explicitly.
  it("states plainly that eligibleForContinuation is observed, not a resumability decision", () => {
    const table = renderScanTable(toScanResult([fullyObservedRun]));
    expect(table).toMatch(/eligibleForContinuation is an observed field, not a decision/i);
  });

  // Requirement 5: a row whose every field is absent must still render a visible line —
  // kills a renderer that filters "empty" rows and reintroduces silent omission.
  it("renders a visible line for a run whose every field is absent", () => {
    const table = renderScanTable(toScanResult([allAbsentRun]));
    expect(table).toContain(allAbsentRun.path);
  });

  it("renders issue rows (directory_unreadable, depth_truncated) alongside run rows, not hidden or sorted away", () => {
    const table = renderScanTable(toScanResult([fullyObservedRun, directoryUnreadableRow, depthTruncatedRow]));
    expect(table).toContain(fullyObservedRun.path);
    expect(table).toContain(directoryUnreadableRow.path);
    expect(table.indexOf(directoryUnreadableRow.detail)).toBeGreaterThan(-1);
    expect(table).toContain(depthTruncatedRow.path);
  });

  it("renders the empty-scan case without throwing", () => {
    expect(() => renderScanTable(toScanResult([]))).not.toThrow();
  });
});

describe("scanRootFailureDetail", () => {
  // Spec §9 / §12.8: exit 1 iff the scan itself failed (root missing or unreadable) — the
  // single row is the root path itself. An interior directory_unreadable row (root scan
  // otherwise succeeded) must NOT be mistaken for a root failure.
  it("reports a failure detail when the sole row is a directory_unreadable row for the root itself", () => {
    const root = "/fake/missing-root";
    const rows: ScanRow[] = [{ kind: "directory_unreadable", path: root, detail: "ENOENT: no such file or directory" }];
    expect(scanRootFailureDetail(rows, root)).toBe("ENOENT: no such file or directory");
  });

  it("does not report a failure when an interior directory is unreadable but the root scan succeeded", () => {
    const root = "/fake/root";
    const rows: ScanRow[] = [fullyObservedRun, { kind: "directory_unreadable", path: "/fake/root/locked", detail: "EACCES" }];
    expect(scanRootFailureDetail(rows, root)).toBeUndefined();
  });

  it("does not report a failure for a normal successful scan", () => {
    expect(scanRootFailureDetail([fullyObservedRun], "/fake/root")).toBeUndefined();
  });
});
