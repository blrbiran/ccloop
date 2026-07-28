import { describe, expect, it } from "vitest";
import { scanRuns, RUN_MARKER_FILES, MAX_SCAN_DEPTH } from "../../src/registry/scanRuns.js";
import type { DirEntry, DirReader, ScanDeps, ScanRow } from "../../src/registry/scanRuns.js";
import type { RunFileReaders } from "../../src/registry/readObservedFile.js";

// A tiny in-memory filesystem, addressed by exact path strings, so path joining in the
// implementation under test (which must use "/" the same way real fs.join would on this
// platform) is exercised the same way it would be against a real tree.
type FakeNode = {
  markers?: string[];
  dirs?: Record<string, FakeNode>;
  // A symlink entry pointing at `target`. Registered so that an implementation which fails
  // to check `isSymbolicLink` and follows it anyway will actually find the target's
  // contents — the same way a real fs.readdir on a symlinked path would. A correct
  // implementation never looks this up because it skips the entry outright.
  symlinks?: Record<string, FakeNode>;
};

function buildFakeFs(rootPath: string, root: FakeNode): { readDirMap: Map<string, DirEntry[]>; markerSet: Set<string> } {
  const readDirMap = new Map<string, DirEntry[]>();
  const markerSet = new Set<string>();

  function visit(path: string, node: FakeNode): void {
    const entries: DirEntry[] = [];

    for (const marker of node.markers ?? []) {
      markerSet.add(`${path}/${marker}`);
      entries.push({ name: marker, isDirectory: false, isSymbolicLink: false });
    }

    for (const [name, child] of Object.entries(node.dirs ?? {})) {
      entries.push({ name, isDirectory: true, isSymbolicLink: false });
      visit(`${path}/${name}`, child);
    }

    for (const [name, target] of Object.entries(node.symlinks ?? {})) {
      entries.push({ name, isDirectory: true, isSymbolicLink: true });
      visit(`${path}/${name}`, target);
    }

    readDirMap.set(path, entries);
  }

  visit(rootPath, root);
  return { readDirMap, markerSet };
}

function makeDirReader(readDirMap: Map<string, DirEntry[]>, markerSet: Set<string>): DirReader {
  return {
    readDir: async (path: string) => {
      const entries = readDirMap.get(path);
      if (!entries) throw new Error(`fake fs: no directory registered for ${path}`);
      return entries;
    },
    fileExists: async (path: string) => markerSet.has(path),
  };
}

// All-ENOENT readers: none of these tests care about parsed field content, only about which
// directories are recognized and reported. observeRun's own field-observation behavior is
// covered by tests/registry/observeRun.test.ts.
function enoentError(): NodeJS.ErrnoException {
  const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function makeScanDeps(dir: DirReader): ScanDeps {
  const noop = async () => {
    throw enoentError();
  };
  const readers: RunFileReaders = {
    readRunState: noop,
    readOwnerRecordWithoutRecovery: noop,
    readOwnerTransferRecord: noop,
  };

  return {
    readers,
    sleep: async () => {},
    now: () => new Date("2026-07-28T00:00:00.000Z"),
    dir,
  };
}

function runRows(rows: ScanRow[]): Extract<ScanRow, { kind: "run" }>[] {
  return rows.filter((r): r is Extract<ScanRow, { kind: "run" }> => r.kind === "run");
}

describe("scanRuns", () => {
  it("has the exact marker file list from spec §4", () => {
    expect(RUN_MARKER_FILES).toEqual([
      "loop-contract.json",
      "loop-state.json",
      "events.jsonl",
      "owner-record.json",
      "owner-transfer.json",
    ]);
  });

  it("sets MAX_SCAN_DEPTH to 10 per spec §5.4", () => {
    expect(MAX_SCAN_DEPTH).toBe(10);
  });

  // Requirement 1 / spec §12.6: permissive recognition. Each of the three directories
  // carries only one marker file, none of them loop-contract.json. *Kills:* recognizing
  // only by loop-contract.json.
  it("recognizes a run directory by any single marker file, reporting the rest absent", async () => {
    const { readDirMap, markerSet } = buildFakeFs("/root", {
      dirs: {
        "events-only": { markers: ["events.jsonl"] },
        "owner-record-only": { markers: ["owner-record.json"] },
        "owner-transfer-only": { markers: ["owner-transfer.json"] },
      },
    });
    const deps = makeScanDeps(makeDirReader(readDirMap, markerSet));

    const rows = await scanRuns("/root", deps);
    const runs = runRows(rows);

    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.path).sort()).toEqual([
      "/root/events-only",
      "/root/owner-record-only",
      "/root/owner-transfer-only",
    ]);

    for (const run of runs) {
      expect(run.files).toHaveLength(3);
      for (const file of run.files) {
        for (const field of Object.values(file.fields)) {
          expect(field).toEqual({ kind: "absent" });
        }
      }
    }
  });

  // Requirement 2 / spec §12.3, §5.2. A complete, valid run sits at
  // runDir/worktrees/attempt-1/ (src/workspace/worktreeManager.ts:18). *Kills:* naive
  // recursion that would report both the outer run and the nested one.
  it("does not descend into a recognized run directory", async () => {
    const { readDirMap, markerSet } = buildFakeFs("/root", {
      dirs: {
        run: {
          markers: ["loop-contract.json"],
          dirs: {
            worktrees: {
              dirs: {
                "attempt-1": {
                  markers: ["loop-contract.json", "loop-state.json", "events.jsonl"],
                },
              },
            },
          },
        },
      },
    });
    const deps = makeScanDeps(makeDirReader(readDirMap, markerSet));

    const rows = await scanRuns("/root", deps);
    const runs = runRows(rows);

    expect(runs).toHaveLength(1);
    expect(runs[0].path).toBe("/root/run");
  });

  // Requirement 3 / spec §5.3. A symlink entry pointing at a directory containing a run must
  // not be followed. The target's contents are registered in the fake fs (as real fs.readdir
  // would transparently return them for a followed symlink), so this test only passes if the
  // implementation actually consults `isSymbolicLink` rather than `isDirectory` alone.
  it("does not follow a symlinked directory, even one containing a run", async () => {
    const { readDirMap, markerSet } = buildFakeFs("/root", {
      symlinks: {
        "link-to-run": { markers: ["loop-contract.json"] },
      },
    });
    const deps = makeScanDeps(makeDirReader(readDirMap, markerSet));

    const rows = await scanRuns("/root", deps);

    expect(rows).toEqual([]);
  });

  // Requirement 4 / spec §12.7, §5.4. Depth counts directories below the root. A chain
  // exactly MAX_SCAN_DEPTH deep still scans normally (recognizing the run at the bottom); a
  // chain one deeper truncates instead, and the over-deep run itself never appears as a row.
  it("scans at exactly MAX_SCAN_DEPTH and truncates at MAX_SCAN_DEPTH + 1", async () => {
    // Builds a chain of nested single-child directories named `${prefix}1`, `${prefix}2`,
    // ..., `${prefix}N`, with `markers` placed in the innermost one.
    function chainFromNames(names: string[], markers: string[]): FakeNode {
      let node: FakeNode = { markers };
      for (let i = names.length - 1; i >= 0; i--) {
        node = { dirs: { [names[i]]: node } };
      }
      return node;
    }

    const atNames = Array.from({ length: MAX_SCAN_DEPTH }, (_, i) => `at${i + 1}`);
    const overNames = Array.from({ length: MAX_SCAN_DEPTH + 1 }, (_, i) => `over${i + 1}`);
    const atLimitPath = "/root/" + atNames.join("/");
    const overLimitPath = "/root/" + overNames.join("/");

    // Merge the two independent chains under one root.
    const root: FakeNode = {
      dirs: {
        ...chainFromNames(atNames, ["loop-contract.json"]).dirs,
        ...chainFromNames(overNames, ["loop-contract.json"]).dirs,
      },
    };

    const { readDirMap, markerSet } = buildFakeFs("/root", root);
    const deps = makeScanDeps(makeDirReader(readDirMap, markerSet));

    const rows = await scanRuns("/root", deps);

    const runs = runRows(rows);
    expect(runs.map((r) => r.path)).toContain(atLimitPath);
    expect(runs.map((r) => r.path)).not.toContain(overLimitPath);

    const truncated = rows.filter((r): r is Extract<ScanRow, { kind: "depth_truncated" }> => r.kind === "depth_truncated");
    expect(truncated).toHaveLength(1);
    expect(truncated[0].path).toBe(overLimitPath);
  });

  // Requirement 5 / spec §12.7, §5.5. A directory whose readDir rejects yields an issue row,
  // and — the trap — the scan must still return the sibling's row rather than aborting.
  it("reports an unreadable directory as a row and still scans its sibling", async () => {
    const { readDirMap, markerSet } = buildFakeFs("/root", {
      dirs: {
        ok: { markers: ["loop-contract.json"] },
      },
    });

    const baseDir = makeDirReader(readDirMap, markerSet);
    const dir: DirReader = {
      ...baseDir,
      readDir: async (path: string) => {
        if (path === "/root/broken") {
          const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return baseDir.readDir(path);
      },
    };

    // Register "/root/broken" as an existing (but unreadable) directory entry at the root.
    readDirMap.set("/root", [...(readDirMap.get("/root") ?? []), { name: "broken", isDirectory: true, isSymbolicLink: false }]);

    const deps = makeScanDeps(dir);
    const rows = await scanRuns("/root", deps);

    const unreadable = rows.filter((r): r is Extract<ScanRow, { kind: "directory_unreadable" }> => r.kind === "directory_unreadable");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].path).toBe("/root/broken");
    expect(unreadable[0].detail).toContain("EACCES");

    const runs = runRows(rows);
    expect(runs.map((r) => r.path)).toContain("/root/ok");
  });

  // Requirement 6. An empty root is not an error and not a run.
  it("returns an empty array for an empty root", async () => {
    const { readDirMap, markerSet } = buildFakeFs("/root", {});
    const deps = makeScanDeps(makeDirReader(readDirMap, markerSet));

    const rows = await scanRuns("/root", deps);

    expect(rows).toEqual([]);
  });

  // Requirement 7 / spec §5.2 applied at the root itself: recognition (and the stop-descent
  // rule) applies to the caller-supplied root exactly as it does to any directory found
  // during traversal.
  it("returns exactly one row when the root itself is a run directory", async () => {
    const markerSet = new Set<string>(["/root/loop-contract.json"]);
    // Deliberately no readDir entry registered for "/root": recognizing the root must not
    // require (or attempt) to list its children.
    const readDirMap = new Map<string, DirEntry[]>();
    const deps = makeScanDeps(makeDirReader(readDirMap, markerSet));

    const rows = await scanRuns("/root", deps);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("run");
    expect((rows[0] as Extract<ScanRow, { kind: "run" }>).path).toBe("/root");
  });
});
