// L2 run registry — the traversal. Walks a tree from a caller-supplied root, recognizing run
// directories per spec §4 and applying the descent rules of spec §5: stop at a recognized
// run, never follow symlinks, bound depth, and turn every condition the scan cannot handle
// into a row rather than a swallowed error or a shorter list.

import { access, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultObserveDeps } from "./readObservedFile.js";
import { observeRun } from "./observeRun.js";
import type { ObserveDeps } from "./readObservedFile.js";
import type { RunObservation } from "./observeRun.js";

export type ScanIssue =
  | { kind: "directory_unreadable"; path: string; detail: string }
  | { kind: "depth_truncated"; path: string };

export type ScanRow = RunObservation | ScanIssue;

export type DirEntry = { name: string; isDirectory: boolean; isSymbolicLink: boolean };

export type DirReader = {
  readDir(path: string): Promise<DirEntry[]>;
  fileExists(path: string): Promise<boolean>;
};

export type ScanDeps = ObserveDeps & { dir: DirReader };

// Spec §4: recognition is permissive — any one of these, present directly in a directory,
// makes it a run directory. Order carries no meaning; presence of any one is sufficient.
export const RUN_MARKER_FILES: readonly string[] = [
  "loop-contract.json",
  "loop-state.json",
  "events.jsonl",
  "owner-record.json",
  "owner-transfer.json",
];

// Spec §5.4: a guard against pathological nesting, not an expected condition — real trees are
// already bounded by the stop-at-a-run and no-follow-symlinks rules.
export const MAX_SCAN_DEPTH = 10;

export const defaultScanDeps: ScanDeps = {
  ...defaultObserveDeps,
  dir: {
    async readDir(path: string): Promise<DirEntry[]> {
      const entries = await readdir(path, { withFileTypes: true });
      return Promise.all(
        entries.map(async (entry) => {
          // Some filesystems (network mounts, FUSE) leave d_type unpopulated, in which case
          // every Dirent.is*() check — including isFile() — returns false (Node reports this
          // as DT_UNKNOWN, without resolving it itself). Left alone, such an entry looks like
          // neither a directory nor a symlink and is silently skipped at the descent check
          // below, which for a directory entry means a shorter scan with no issue row —
          // exactly what spec §5 / §15 #1 forbid. Resolve the real type with lstat only in
          // that unresolved case.
          if (entry.isDirectory() || entry.isSymbolicLink() || entry.isFile()) {
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              isSymbolicLink: entry.isSymbolicLink(),
            };
          }
          const stat = await lstat(join(path, entry.name));
          return { name: entry.name, isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink() };
        }),
      );
    },
    async fileExists(path: string): Promise<boolean> {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
  },
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Spec §4: a directory is a run directory iff it directly contains at least one marker file.
// Checked with the injected `fileExists` rather than by inspecting a `readDir` listing, so
// recognition and descent are two independently swappable decisions.
async function isRunDirectory(path: string, deps: ScanDeps): Promise<boolean> {
  for (const marker of RUN_MARKER_FILES) {
    if (await deps.dir.fileExists(join(path, marker))) {
      return true;
    }
  }
  return false;
}

// `depth` is the number of directories `path` sits below the scan root (the root itself is 0).
async function scanDir(path: string, depth: number, deps: ScanDeps): Promise<ScanRow[]> {
  // Spec §5.4: checked before recognition or listing — an over-deep directory is truncated
  // outright, not read at all.
  if (depth > MAX_SCAN_DEPTH) {
    return [{ kind: "depth_truncated", path }];
  }

  // Spec §5.2: recognition is checked before any descent, at every directory including the
  // caller-supplied root itself — a recognized run is reported and never listed.
  if (await isRunDirectory(path, deps)) {
    return [await observeRun(path, deps)];
  }

  let entries: DirEntry[];
  try {
    entries = await deps.dir.readDir(path);
  } catch (error) {
    // Spec §5.5: recorded as a row; never aborts the scan (siblings must still be visited by
    // the caller, which is unaffected by this function returning early for `path` alone).
    return [{ kind: "directory_unreadable", path, detail: describeError(error) }];
  }

  const rows: ScanRow[] = [];
  for (const entry of entries) {
    // Spec §5.3: symlinks are never followed, regardless of what isDirectory reports for them.
    if (!entry.isDirectory || entry.isSymbolicLink) continue;
    const childRows = await scanDir(join(path, entry.name), depth + 1, deps);
    rows.push(...childRows);
  }
  return rows;
}

export async function scanRuns(root: string, deps: ScanDeps): Promise<ScanRow[]> {
  return scanDir(root, 0, deps);
}
