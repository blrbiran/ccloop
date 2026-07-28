# Task 6 Report — CLI `ls` subcommand, rendering, and exit codes

Commit: `f5cbd97` — "feat: add the ccloop ls subcommand"

## What was built

- `src/registry/renderRuns.ts` (new): `ScanResult = { schemaVersion: 1; rows: ScanRow[] }`,
  `toScanResult(rows)`, `renderScanTable(result)`, and one additional exported helper,
  `scanRootFailureDetail(rows, root)` (see "Integration point" below).
- `src/cli.ts`: added a third `ParsedArgs` variant, `{ command: "ls"; root: string; json: boolean }`.
  `parseArgs` now recognizes `ls` *before* the `run`/`resume` flag-parsing branch, taking a
  positional root and an optional trailing `--json`, with no `--adapter`/`--adapter-config`/
  `--contract` requirement. `main()` handles `ls` in its own branch, entirely separate from the
  `finalState.status === "succeeded" ? 0 : 2` mapping used by `run`/`resume`.
- Tests: `tests/registry/renderRuns.test.ts` (new, 9 tests) and additions to
  `tests/cli/cli.test.ts` (+14 tests: `parseArgs ls` and `main ls`).

No other files were touched. `git diff --stat` against the pre-task tree: `src/cli.ts`,
`tests/cli/cli.test.ts` modified; `src/registry/renderRuns.ts`, `tests/registry/renderRuns.test.ts`
added — exactly what Global Constraint 4 permits.

## Requirement 1 — deliberate-failure check (verbatim result)

Per the brief, I verified the "no derived fields" test can actually fail before trusting it.

**What I added** (temporarily, in `src/registry/renderRuns.ts`):

```ts
export function toScanResult(rows: ScanRow[]): ScanResult {
  // TEMPORARY — deliberate-failure check for task-6 requirement 1, not part of the real
  // implementation. Must be reverted before commit.
  const tainted = rows.map((row) => (row.kind === "run" ? { ...row, resumable: true } : row));
  return { schemaVersion: 1, rows: tainted as ScanRow[] };
}
```

**Observed result** running `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/registry/renderRuns.test.ts`:

```
❯ tests/registry/renderRuns.test.ts (9 tests | 2 failed) 9ms
  → expected 'resumable' not to match /resumable|fresh|stale|expired/i
FAIL  tests/registry/renderRuns.test.ts > toScanResult > stamps schemaVersion 1 and carries the rows through unchanged
FAIL  tests/registry/renderRuns.test.ts > toScanResult > contains no derived fields in the serialized JSON (spec §12.5)
AssertionError: expected 'resumable' not to match /resumable|fresh|stale|expired/i
Test Files  1 failed (1)
     Tests  2 failed | 7 passed (9)
```

The failure is on the exact injected key (`resumable`), and the mandated
`eligibleForContinuation` field remained untouched and still passed in the other 7 tests. I then
reverted `toScanResult` to its original one-line body and re-ran the same command: all 9 tests
passed again (confirmed via `grep` on the log file, never piped through `tail`).

## Integration point: exit-code decision (task brief trap #2/#3)

`scanRuns` has no dedicated "root scan failed" signal — a missing/unreadable root produces the
same `ScanIssue` shape (`{ kind: "directory_unreadable", path, detail }`) as any interior
unreadable directory found during traversal. Distinguishing "root itself failed" (exit 1, spec
§9) from "an interior directory was unreadable, scan otherwise succeeded" (exit 0, spec §11)
requires a rule, since `scanDir`'s top-level readdir failure returns exactly one row,
immediately, before any child can be visited. `scanRootFailureDetail(rows, root)` encodes that
rule: it returns the failure detail iff `rows` has exactly one element, it is
`directory_unreadable`, and its `path === root`. This lives in `renderRuns.ts` (in-scope,
new file) rather than `scanRuns.ts` (an earlier task's file, not to be modified) or inline in
`cli.ts` (would smuggle observation-adjacent logic into the CLI layer, against spec §10). It has
its own three unit tests plus two CLI-level integration tests (root-missing → 1, damaged-run →
0, never 2).

`parseArgs`'s existing `run`/`resume` branch unconditionally requires `--run-dir`/`--adapter`/
`--adapter-config`, confirming the brief's flagged integration point was real. `ls` is now
handled in a separate, earlier branch of `parseArgs`, before that requirement is enforced, so it
never trips it.

## Verification

- Scoped: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/registry/renderRuns.test.ts tests/cli/cli.test.ts` → 2 files, 23 tests, all passed.
- Full suite: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run` → **29 files, 424 tests, all passed**, no skips. (The brief's stated starting baseline, 23 files / 373 tests, does not match what this worktree already contained before Task 6 — the extra files/tests are pre-existing suites — e.g. `tests/validation/evidence.test.ts`, `run-scenario CLI` — unrelated to L2 and were not touched by this task.)
- `npm run typecheck` → clean.
- `npm run build` → clean.
- `.wolf/anatomy.md`, `.wolf/cerebrum.md`, `.wolf/memory.md`, `.wolf/buglog.json` are all
  git-ignored in this repo (`.gitignore` lines 8/10/12/14) and do not exist in this worktree, so
  they were not created or updated — there is nothing checked-in for OpenWolf tracking to update.

## Discrepancies / judgment calls to report

1. **Brief's "starting baseline" (23 files / 373 tests) does not match this worktree.** Before
   any Task 6 edits, `npm test -- --run` already reported more files/tests than that baseline
   (tests unrelated to L2, e.g. `run-scenario CLI`, `evidence.test.ts`). Not a Task 6 defect —
   flagging in case the baseline in the plan document was computed against a different tree.
2. **`scanRootFailureDetail` is a new exported symbol** beyond the two interfaces named in the
   brief (`toScanResult`, `renderScanTable`). It was necessary because `ScanRow`/`ScanIssue` (L1b
   types, not to be redefined) carry no distinct signal for "the root itself is the failure,"
   and the brief's own traps section anticipates exactly this kind of necessary integration
   decision. Flagging for visibility, not as a defect.

No other spec/brief conflicts found. Where the brief and spec overlapped (schemaVersion, exit
codes, consistency notice), they agreed; I followed the spec's exact wording for the §8.2
notice content and the §9 exit-code table.

## Final review fix wave

Single fix wave addressing all four findings from the whole-branch review, followed by full
verification. Commits: `<see below>`.

### Finding 1 (IMPORTANT) — the no-derivation guard inspected only its own fixtures

**Problem:** `collectKeys` in `tests/registry/renderRuns.test.ts` only ever walked
`ScanRow` values that were module-local object literals. An optional derived field added to
production `RunObservation` and populated by production `observeRun` would never appear in
those literals, so the guard would stay green while `ccloop ls --json` shipped a derived field.

**Change:** Added a second test,
`"contains no derived fields when the rows are produced by the real scanRuns/observeRun
pipeline, not test literals"`, in `tests/registry/renderRuns.test.ts`. It builds a fake
`DirReader` (readdir/fileExists) and a fake `RunFileReaders` (the same seam
`tests/registry/scanRuns.test.ts` uses), covering one fully-observed run, one all-absent run
(recognized via `events.jsonl`, all three observed files ENOENT), one `EACCES` directory
(`directory_unreadable`), and a chain one level past `MAX_SCAN_DEPTH` (`depth_truncated`). It
then calls the real `scanRuns` (which calls the real `observeRun` -> `readObservedFile` ->
`observeFields`, all production code, only the I/O boundary is faked), passes the resulting rows
through the real `toScanResult`, and runs the same key-scanning assertions as the original test.
A sanity check first confirms the fixture actually produced one row of each of the four kinds,
so a fixture bug couldn't masquerade as "no derived fields found."
**The original fixture-based test was kept unchanged** — it still guards the renderer's own
shape independent of the pipeline.

**Deliberate-failure proof (exactly as requested):** Temporarily added an *optional* field to
the production type in `src/registry/observeRun.ts`:
```ts
export type RunObservation = {
  kind: "run";
  path: string;
  observedAt: string;
  files: FileObservation[];
  fresh?: boolean;   // added
};
```
and populated it in the production `observeRun` function's return value:
```ts
return {
  kind: "run",
  path: runDir,
  observedAt: deps.now().toISOString(),
  files,
  fresh: true,        // added
};
```
Ran `ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/registry/renderRuns.test.ts`. Result:
```
❯ tests/registry/renderRuns.test.ts (11 tests | 1 failed) 9ms
   × toScanResult > contains no derived fields when the rows are produced by the real scanRuns/observeRun pipeline, not test literals
     → expected 'fresh' not to match /resumable|fresh|stale|expired/i
 Test Files  1 failed (1)
      Tests  1 failed | 10 passed (11)
```
Exactly one test failed: the new pipeline-driven guard — on the exact injected key, `fresh`.
The other 10 tests in the file, **including the original fixture-based derivation-guard test**,
stayed green, which is the one-sidedness the finding described made visible directly (the old
test cannot see a field it never wrote into its own literals; the new test can, because it
observes what the real pipeline actually produced). Reverted both edits with
`git checkout -- src/registry/observeRun.ts` and confirmed via `git diff` / `git status` that
the file matched HEAD exactly (no leftover changes). Re-ran the same command afterward: all 11
tests passed.

**Covering tests:** `tests/registry/renderRuns.test.ts` — both the original fixture-based test
and the new pipeline-driven test, in `describe("toScanResult", ...)`.

### Finding 2 (MINOR) — `ls --json <root>` misparsed

**Change:** `src/cli.ts`, `parseArgs`'s `ls` branch. Replaced `argv[1]` (always the second
token) with `rest.find((arg) => !arg.startsWith("--"))` over `argv.slice(1)`, so the positional
root is found regardless of whether `--json` precedes or follows it; `json` is now
`rest.includes("--json")` (equivalent to before when `--json` follows the root, and now also
correct when it precedes it).

**Covering test:** `tests/cli/cli.test.ts`, `describe("parseArgs ls", ...)` —
`"parses --json before the positional root"`: `parseArgs(["ls", "--json", "/tmp/some-root"])`
now returns `{ command: "ls", root: "/tmp/some-root", json: true }`.

### Finding 3 (MINOR) — no `DT_UNKNOWN` fallback in `defaultScanDeps.readDir`

**Change:** `src/registry/scanRuns.ts`, `defaultScanDeps.readDir` only (the injected seam, per
the brief). For each dirent, if none of `isDirectory()` / `isSymbolicLink()` / `isFile()` are
true (Node's `DT_UNKNOWN` case — unpopulated `d_type`, seen on some network/FUSE filesystems),
falls back to `lstat` on the full path to resolve the real type, rather than silently treating
the entry as neither a directory nor a symlink (which previously caused it to be skipped at the
descent check, producing zero rows and no issue row for that child).

**Testability, reported honestly per the brief's instruction:** I did not add a test for this
fix. Producing a genuine `DT_UNKNOWN` dirent requires a filesystem that doesn't populate
`d_type` (some network/FUSE mounts); APFS, ext4, and tmpfs — everything available in this
environment and CI — always populate it, so no real fixture can trigger the bug here, matching
what the finding anticipated. The alternative would be mocking `node:fs/promises` (`readdir`/
`lstat`) to hand back fabricated Dirent-like objects whose `is*()` methods are stubbed to all
return `false`. I chose not to do this: this codebase has zero existing precedent for mocking
Node's fs module (`tests/registry/zeroWrite.test.ts` and `tests/registry/scanRuns.test.ts` both
test through real filesystems or an injected `DirReader`, never through module mocks), and such
a test would mostly be re-asserting "the code calls lstat when told to" against inputs I
constructed to make it do exactly that — closer to the "exercises the fallback helper in
isolation" pattern the brief explicitly warned against than to a genuine regression guard. The
fix itself is a small, directly-readable diff (three-way `is*()` check, else `lstat`), and it's
scoped to the one seam (`defaultScanDeps.readDir`) that the brief said was the right place for
it.

### Finding 4 (MINOR) — no caveat on `eligibleForContinuation` in the output

**Change:** `src/registry/renderRuns.ts`, `CONSISTENCY_NOTICE`. Appended a second sentence:
`"eligibleForContinuation is an observed field, not a decision that the run may be resumed."`
— reflecting spec §6.2 ("It is not a signal that the run may be continued... that determination
belongs to resumeLoop's gate") and spec §13.1 debt #1 (a row can show `eligibleForContinuation:
true` for a run with no reconciliation record on disk).

**Covering test:** `tests/registry/renderRuns.test.ts`, new test in
`describe("renderScanTable", ...)`: `"states plainly that eligibleForContinuation is observed,
not a resumability decision"` — asserts the rendered table matches
`/eligibleForContinuation is an observed field, not a decision/i`.

### Verification

Scoped, before the full run:
```
ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/registry/renderRuns.test.ts tests/cli/cli.test.ts tests/registry/scanRuns.test.ts
```
→ `PASS (35) FAIL (0)`.

Full suite (after reverting the Finding-1 proof edits):
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
```
→
```
 Test Files  29 passed (29)
      Tests  427 passed (427)
```
(424 baseline + 3 new tests: the Finding-1 pipeline-driven guard, the Finding-2 `--json`-before-root
parse test, and the Finding-4 notice-caveat test.)

```
npm run typecheck
```
→ clean (`tsc --noEmit -p tsconfig.json`, no output, exit 0).

```
npm run build
```
→ clean (exit 0).

All output was redirected to files under the scratchpad and inspected with `grep`/`cat` — never
piped through `tail`.

### Files touched (fix wave)

- `src/cli.ts` — Finding 2.
- `src/registry/scanRuns.ts` — Finding 3.
- `src/registry/renderRuns.ts` — Finding 4.
- `tests/cli/cli.test.ts` — Finding 2 test.
- `tests/registry/renderRuns.test.ts` — Finding 1 test, Finding 4 test.
- `src/registry/observeRun.ts` — touched only transiently for the Finding 1 deliberate-failure
  proof, then reverted; no net change (confirmed absent from `git status` and `git diff`).

No L1/L1b code modified. `readOwnerRecord` and `checkRunLease` remain unbound/uncalled (neither
touched by this wave). No writes introduced by the scanner (Finding 3's fallback only reads,
via `lstat`). No derived fields added to production output — Finding 1's proof field was
temporary and fully reverted before commit.
