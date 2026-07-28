# Task 4 report: traversal, recognition, and descent rules

## Status: DONE

## Files

- Created `src/registry/scanRuns.ts`
- Created `tests/registry/scanRuns.test.ts`

## Summary

Implemented `scanRuns(root, deps)`, a recursive traversal over an injected `DirReader`
(`readDir` + `fileExists`), producing `ScanRow[]` (`RunObservation | ScanIssue`) exactly as
specified in the brief and cross-checked against spec §4 (recognition) and §5 (traversal
rules) — no discrepancy found between the brief and the spec for this task; the brief's
exact values (`RUN_MARKER_FILES` = the five files listed in spec §4, `MAX_SCAN_DEPTH = 10`
per spec §5.4) match the spec verbatim.

### Design

`scanDir(path, depth, deps)`:

1. **Depth check first.** If `depth > MAX_SCAN_DEPTH`, return a `depth_truncated` row for
   `path` without reading it at all — the guard fires before recognition or listing, so an
   over-deep directory is never even checked for marker files.
2. **Recognition next, before any descent.** `isRunDirectory` checks `deps.dir.fileExists`
   for each of the five `RUN_MARKER_FILES` (any one present ⇒ recognized). This runs at
   every directory including the caller-supplied root itself. If recognized, call
   `observeRun(path, deps)` and return — no `readDir` call is made on a recognized
   directory, so its children (e.g. `worktrees/attempt-1/`) are never visited.
3. Otherwise `readDir(path)`; a rejection becomes a `directory_unreadable` row for `path`
   and returns immediately — this return is scoped to the single recursive call for `path`,
   so the caller's loop over sibling entries is unaffected and continues normally.
4. For each entry, skip if `isSymbolicLink` or not `isDirectory`, then recurse into
   `join(path, entry.name)` at `depth + 1`.

`defaultScanDeps` wires the real `node:fs/promises` (`readdir` with `withFileTypes: true`,
`access` for `fileExists`) alongside `defaultObserveDeps`, following the existing
`pathExists`-via-`access` convention already used in `fileStore.ts` /
`worktreeManager.ts`.

### Test coverage (9 tests, all passing)

Fully mocked via an in-memory fake filesystem builder (`buildFakeFs`), no real disk I/O,
matching the style of `observeRun.test.ts` / `readObservedFile.test.ts`:

1. `RUN_MARKER_FILES` / `MAX_SCAN_DEPTH` pinned to the brief's exact values.
2. Permissive recognition: three directories, each with exactly one different marker file
   (none `loop-contract.json`), all recognized, remaining observed fields `absent`
   (spec §12.6).
3. No descent into a recognized run at `runDir/worktrees/attempt-1/` — asserts exactly one
   row, for the outer run (spec §12.3, §5.2).
4. Symlink not followed: the fake fs registers the symlink target's contents at the joined
   path (as real `fs.readdir` would transparently return for a followed symlink), so the
   test only passes if the implementation actually consults `isSymbolicLink` — it kills an
   implementation that checks only `isDirectory`.
5. Depth off-by-one made visible: two independent chains, one exactly `MAX_SCAN_DEPTH` (10)
   deep (scans, produces a run row) and one `MAX_SCAN_DEPTH + 1` (11) deep (produces a
   single `depth_truncated` row at the 11th-level directory; the run at the bottom never
   appears).
6. Unreadable directory + continuation trap: `/root/broken` rejects `readDir`; asserts both
   the `directory_unreadable` row for it **and** the sibling `/root/ok` run row are present
   in the same result — this specifically kills an implementation that records the issue
   and then aborts.
7. Empty root → `[]`.
8. Root itself is a run directory → exactly one row for the root; the fake fs has no
   `readDir` entry registered for `/root` at all, so the test would fail loudly (fake-fs
   "no directory registered" error) if the implementation attempted to list the recognized
   root's children.

## Verification

- `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/registry/scanRuns.test.ts`:
  9/9 passed.
- Full suite: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test`: 405/405 passed, 27 test files.
- `npm run typecheck`: clean.

## Constraints honored

- Zero writes: traversal only calls `readDir`/`fileExists` on the injected `DirReader`;
  `observeRun` (Task 3) is reused unchanged and never binds `readOwnerRecord`.
- `readOwnerRecord` and `checkRunLease` are not imported or referenced anywhere in
  `scanRuns.ts`.
- Only `src/registry/scanRuns.ts` and `tests/registry/scanRuns.test.ts` were touched; no
  other files modified.
- No derived fields introduced; `ScanIssue`/`ScanRow` carry only `path`/`detail`, no
  clock comparison.
- Every condition becomes a row: recognized run, unreadable directory, and depth
  truncation are all rows; nothing is dropped silently.

## Commit

`84b7a83` — `feat: add run directory traversal with recognition and descent rules`

## Concerns / discrepancies

None found. Brief and spec agree on `RUN_MARKER_FILES` and `MAX_SCAN_DEPTH`. One point
worth flagging for the CLI task (Task 6) rather than this one: `observeRun` only observes
three of the five files that can trigger recognition (`loop-state.json`,
`owner-record.json`, `owner-transfer.json` — per spec §6's table); a run recognized solely
via `loop-contract.json` or `events.jsonl` will show all three observed files as `absent`
in its row even though the marker file that caused recognition is real and present. This is
consistent with spec §6 (which deliberately does not list those two files in the observed
fields table) and is not a defect in this task — noted here only so it is not mistaken for
a bug when the CLI renders these rows.
