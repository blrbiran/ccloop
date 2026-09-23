// L2 run registry — tests for the serialization (`toScanResult`) and human rendering
// (`renderScanTable`) surface. See
// docs/superpowers/specs/2026-07-28-run-registry-design.md §6.3, §8.2, §9, §12.5, §12.8.

import { describe, expect, it } from "vitest";
import { toScanResult, renderScanTable, scanRootFailureDetail } from "../../src/registry/renderRuns.js";
import { scanRuns, MAX_SCAN_DEPTH } from "../../src/registry/scanRuns.js";
import type { DirEntry, DirReader, ScanDeps, ScanIssue, ScanRow } from "../../src/registry/scanRuns.js";
import type { RunFileReaders } from "../../src/registry/readObservedFile.js";
import { attachLockInspections } from "../../src/unlock/lockRows.js";
import type { ReportedRunRow } from "../../src/unlock/lockRows.js";

// Task 9 (human ruling 131) widened toScanResult/renderScanTable's row type from ScanRow to
// ReportedScanRow, so every RUN fixture below now needs a `lock` field to satisfy the type AND
// to avoid a real runtime crash in renderRunRow's lock-block renderer (it reads `row.lock.state`
// unconditionally). This is the only change made to these two pre-existing fixtures; every
// `it(...)` body below is untouched, and `lock: { state: "absent" }` does not change what any of
// them assert.
const fullyObservedRun: ReportedRunRow = {
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
  lock: { state: "absent" },
};

const allAbsentRun: ReportedRunRow = {
  kind: "run",
  path: "/fake/root/run-empty",
  observedAt: "2026-07-28T00:00:00.000Z",
  files: [
    { file: "loop-state.json", fields: { status: { kind: "absent" } } },
    { file: "owner-record.json", fields: { runId: { kind: "absent" } } },
    { file: "owner-transfer.json", fields: { eligibleForContinuation: { kind: "absent" } } },
  ],
  lock: { state: "absent" },
};

const directoryUnreadableRow: ScanIssue = {
  kind: "directory_unreadable",
  path: "/fake/root/locked",
  detail: "EACCES: permission denied",
};

const depthTruncatedRow: ScanIssue = { kind: "depth_truncated", path: "/fake/root/very/deep/path" };

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
  //
  // ⚠️ MEASURED, NOT ASSUMED (ls-lock-visibility round, Tasks 8-10 fix round 1, Important
  // finding): this guard's ban list is `/resumable|fresh|stale|expired/i` plus a narrow
  // exemption for `eligible`. It does NOT ban `lock` or `state`, and Task 9's owner-transfer
  // lock block adds exactly those two keys to the serialized output. Ran the real
  // `toScanResult` over a row carrying a lock block and checked the guard's own pattern
  // against every key it produced (`lock`, `state`, `holder`, `pid`, `digest`, `identity`):
  // NONE of them match `/resumable|fresh|stale|expired/i`, so this test stays green with the
  // lock block present exactly as it did without it — command `npx tsx .probe-guard-lock.ts`
  // (a throwaway probe against the real `toScanResult`, not reproduced here), output
  // `does the guard pattern match ANY key? false`.
  //
  // This test's own comment two paragraphs below already says its "real target is a future
  // well-meaning derived column" that would slip past this ban list unnoticed. THIS ROUND IS
  // THAT COLUMN: `lock.state` is a derived judgment (dead/alive/liveness-unknown/...) riding
  // inside the serialized output, and this guard cannot see it. It is deliberately NOT
  // extended to ban `lock`/`state` here — human ruling 131 already named this exact
  // derived-judgment tradeoff as accepted for `ls` (design spec §3.7) — but a reviewer reading
  // "this test is green" must not read that as "this test checked the lock block." It didn't.
  // Recorded durably in `.superpowers/sdd/2026-09-23-ls-lock-visibility/progress.md` as well,
  // since the SDD ledger this was first noted in is deleted when the plan completes.
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

    // This test's whole point is the RAW registry pipeline (scanRuns/observeRun) -- so `rows`
    // itself is deliberately built without going anywhere near Task 8's attachLockInspections,
    // same as before. What changed (fix round 1, Minor): rather than casting `rows` past the
    // type system with `as unknown as ReportedScanRow[]`, this attaches a real (stubbed) lock to
    // each row the same way `fullyObservedRun`/`allAbsentRun` above do, so `result` is a genuine
    // ReportedScanRow[] value with no unchecked cast anywhere in this file.
    const reportedRows = await attachLockInspections(rows, {
      inspect: async () => ({ state: "absent" }),
    });
    const result = toScanResult(reportedRows);
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

// Task 9 (human ruling 131): the seven-state owner-transfer.lock block. Each state gets its own
// criterion asserting LITERAL text, not shape (design spec §5.3 #2) -- a criterion that only
// checked "a lock block appeared" would stay green under a mutation that renders the wrong state's
// words. digest values are hand-written literals (spec §5.3 #3), never computed by calling
// digestLockContents, so the expectation cannot be produced by the same code path it is checking.
describe("renderScanTable — owner-transfer.lock block (human ruling 131, spec §3.5)", () => {
  const baseRun = {
    kind: "run" as const,
    path: "/runs/run-1",
    observedAt: "2026-09-23T00:00:00.000Z",
    files: [],
  };

  it("renders the absent state with only a state line, and no next: line", () => {
    const row: ReportedRunRow = { ...baseRun, lock: { state: "absent" } };
    const out = renderScanTable(toScanResult([row]));

    expect(out).toContain("  owner-transfer.lock");
    expect(out).toContain("    state: absent");
    // Nothing to clear -- absent renders no next: line at all.
    expect(out).not.toContain("next:");
  });

  it("renders the dead state with holder, pid, full digest and a next command", () => {
    const row: ReportedRunRow = {
      ...baseRun,
      lock: {
        state: "dead",
        holder: "pid:12345",
        pid: 12345,
        digest: "a".repeat(64),
        identity: { dev: 1, ino: 2 },
      },
    };
    const out = renderScanTable(toScanResult([row]));

    expect(out).toContain("    state: dead");
    expect(out).toContain("    holder: pid:12345");
    expect(out).toContain("    pid: 12345");
    expect(out).toContain(`    digest: ${"a".repeat(64)}`);
    expect(out).toContain("    next: ccloop unlock /runs/run-1");
  });

  it("renders the alive state with holder, pid, full digest and a next command", () => {
    const row: ReportedRunRow = {
      ...baseRun,
      lock: {
        state: "alive",
        holder: "pid:12345",
        pid: 12345,
        digest: "b".repeat(64),
        identity: { dev: 1, ino: 2 },
      },
    };
    const out = renderScanTable(toScanResult([row]));

    expect(out).toContain("    state: alive");
    expect(out).toContain("    holder: pid:12345");
    expect(out).toContain("    pid: 12345");
    expect(out).toContain(`    digest: ${"b".repeat(64)}`);
    expect(out).toContain("    next: ccloop unlock /runs/run-1");
  });

  it("renders the liveness-unknown state with holder, pid, reason, full digest and a next command", () => {
    const row: ReportedRunRow = {
      ...baseRun,
      lock: {
        state: "liveness-unknown",
        holder: "pid:1",
        pid: 1,
        reason: "EPERM",
        digest: "c".repeat(64),
        identity: { dev: 1, ino: 2 },
      },
    };
    const out = renderScanTable(toScanResult([row]));

    expect(out).toContain("    state: liveness-unknown");
    expect(out).toContain("    holder: pid:1");
    expect(out).toContain("    pid: 1");
    expect(out).toContain("    reason: EPERM");
    expect(out).toContain(`    digest: ${"c".repeat(64)}`);
    expect(out).toContain("    next: ccloop unlock /runs/run-1");
  });

  it("renders an unrecognized holder with its holder text and its full digest", () => {
    const row: ReportedRunRow = {
      ...baseRun,
      lock: {
        state: "unrecognized-holder",
        holder: '["pid","1"]',
        // A literal digest, written out rather than computed: an expectation the code under test
        // produces can never fail.
        digest: "a".repeat(64),
        identity: { dev: 1, ino: 2 },
      },
    };
    const out = renderScanTable(toScanResult([row]));

    expect(out).toContain("  owner-transfer.lock");
    expect(out).toContain("    state: unrecognized-holder");
    expect(out).toContain('    holder: ["pid","1"]');
    expect(out).toContain(`    digest: ${"a".repeat(64)}`);
    expect(out).toContain("    next: ccloop unlock /runs/run-1");
  });

  it("renders the unparseable state with its parse-failure reason and full digest", () => {
    const row: ReportedRunRow = {
      ...baseRun,
      lock: {
        state: "unparseable",
        reason: "Unexpected token } in JSON at position 4",
        digest: "d".repeat(64),
        identity: { dev: 1, ino: 2 },
      },
    };
    const out = renderScanTable(toScanResult([row]));

    expect(out).toContain("    state: unparseable");
    expect(out).toContain("    reason: Unexpected token } in JSON at position 4");
    expect(out).toContain(`    digest: ${"d".repeat(64)}`);
    expect(out).toContain("    next: ccloop unlock /runs/run-1");
  });

  it("renders an unreadable lock file with no digest line at all, because it has no credential", () => {
    const row: ReportedRunRow = {
      ...baseRun,
      lock: { state: "file-unreadable", reason: "EACCES" },
    };
    const out = renderScanTable(toScanResult([row]));

    expect(out).toContain("    state: file-unreadable");
    expect(out).toContain("    reason: EACCES");
    // The one state with no digest: --force's credential is a hash of bytes that cannot be read.
    // Printing a digest line here would advertise an escape hatch that does not exist.
    expect(out).not.toContain("digest:");
    expect(out).toContain("    next: ccloop unlock /runs/run-1");
  });
});
