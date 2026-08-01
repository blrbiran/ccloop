# L2 Run Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ccloop ls <root>` — a read-only scanner that enumerates run directories beneath a root and reports raw observed state, introducing no writes, no persisted state, and no authorization.

**Architecture:** A new `src/registry/` module. Traversal recognizes run directories by marker files and stops descending into them. Observation reads three files per run through *injected reader functions* (bound to `fileStore`'s verified-pure readers in production) and records each observed field as `present` / `absent` / `unreadable`. No field is derived, compared against a clock, or interpreted.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node `fs/promises`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-28-run-registry-design.md` — the single source of truth. Where this plan and the spec disagree, **the spec wins**; report the discrepancy rather than silently following either.

## Plan Style — read this before starting

This plan deliberately gives **interface signatures, test requirements, and trap lists — not copyable implementation or test bodies.** That is a standing instruction from the repository owner, not an omission.

Two prior rounds established why: a plan carrying full copyable code produced high throughput but switched off the implementer's judgment, and every gap in the plan landed verbatim in the code. The round that gave signatures and requirements instead produced an implementer who found and reported two real plan defects.

So: **you are expected to exercise judgment.** If a requirement here is wrong, unreachable, or contradicts the spec, stop and report it. That is a successful outcome, not a failure to follow instructions.

## Global Constraints

Every task inherits these. They come from the spec; values are verbatim.

1. **Zero writes.** The scanner must not create, modify, delete, or rename anything under the scanned tree. This is the layer's entire premise (spec §3).
2. **`readOwnerRecord` (`src/persistence/fileStore.ts:566`) must never be called.** It runs `recoverInterruptedOwnerTransfer` (`:549`), which renames and unlinks. Use `readOwnerRecordWithoutRecovery` (`:628`) (spec §7.1).
3. **`checkRunLease` (`src/controller/leaseGate.ts:16`) must never be called.** It appends a `lease_expired_observed` event at `:58`. It writes (spec §7.4).
4. **No L1 or L1b code may be modified**, including write paths and the lease gate (spec §2.7). Outside `src/registry/` and `tests/registry/`, this plan touches exactly two files: `src/cli.ts` (add the `ls` subcommand) and `tests/cli/cli.test.ts` (its tests). Touching anything else is a finding.
5. **No derived fields.** No eligibility, resumability, freshness, staleness, or expiry is computed or reported (spec §3, §6.1).
6. **None of L1 spec §12's nineteen constraints may be weakened**; #2, #5, #7, #15, #17, #19 are under a standing order never to be weakened or deleted.
7. **Test command:** `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`. Add a path to scope it. **Never pipe verification runs through `| tail -N`** — truncation loses test names and makes failures unfalsifiable.
8. **No real (paid) Claude calls.** Nothing in this layer touches an adapter.
9. Commit after each task. Follow the existing commit style: lowercase `type: subject`, imperative.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/registry/types.ts` | Observation types and the observed-file specs (which fields, which JSON type, which files are non-atomic) |
| `src/registry/observeFields.ts` | Given a parsed value and a file spec, produce per-field observations |
| `src/registry/readObservedFile.ts` | Read one file through an injected reader; absent vs parse-failure; bounded re-read for non-atomic files |
| `src/registry/observeRun.ts` | Compose the above across the three observed files into one `RunObservation` |
| `src/registry/scanRuns.ts` | Traversal: recognition, descent rules, depth limit, unreadable directories |
| `src/registry/renderRuns.ts` | JSON contract and human table rendering |
| `src/cli.ts` | **Modify:** add the `ls` subcommand and its exit codes |

Tests mirror this under `tests/registry/`, plus a modification to `tests/cli/cli.test.ts`.

### Why readers are injected rather than a filesystem interface

Spec §7.2 requires reusing `fileStore`'s readers so no second JSON-reading implementation can drift. Spec §10 and §12.4 require injection so a torn read can be simulated deterministically. `fileStore`'s readers call `readFile` directly, so a filesystem-level injection cannot satisfy both.

**Resolution: inject the reader functions.** Production binds them to `fileStore`; tests bind fakes. Both requirements hold. If you find a case where this resolution breaks, report it — it is this plan's judgment call, not the spec's.

---

## Task 1: Observation types and per-field observation

**Files:**
- Create: `src/registry/types.ts`
- Create: `src/registry/observeFields.ts`
- Test: `tests/registry/observeFields.test.ts`

**Interfaces:**

*Produces* — later tasks depend on these exact names:

```ts
export type FieldObservation =
  | { kind: "present"; value: unknown }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: "parse" | "shape" | "io"; detail: string };

export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "string-or-null"
  | "literal-true";

export type ObservedFileSpec = {
  file: string;
  atomic: boolean;
  fields: { name: string; type: FieldType }[];
};

export type FileObservation = {
  file: string;
  fields: Record<string, FieldObservation>;
};

export const OBSERVED_FILES: readonly ObservedFileSpec[];

export function observeFields(parsed: unknown, spec: ObservedFileSpec): FileObservation;
```

`OBSERVED_FILES` must contain exactly these three entries. Field types are verified against `src/state/types.ts:26-35` and `src/runtime/types.ts:82-104` — do **not** re-derive them by guessing:

| file | atomic | fields |
|---|---|---|
| `loop-state.json` | `false` | `status`:string, `currentAttempt`:number, `attemptsUsed`:number, `lastTransitionAt`:string, `stopReason`:string-or-null |
| `owner-record.json` | `false` | `runId`:string, `currentOwnerEpoch`:integer, `ownerStatus`:string, `currentProcessInstanceId`:string, `leaseAffirmedAt`:string-or-null |
| `owner-transfer.json` | `true` | `eligibleForContinuation`:literal-true |

**Test requirements** — each must be able to fail against a specific wrong implementation:

1. A field present with the right type → `present` carrying the value.
2. A field missing from a parsed object → `absent`. *Kills:* an implementation that treats missing as `unreadable`, collapsing spec §11's rows 4 and 5.
3. A field present with the wrong JSON type → `unreadable` with `reason: "shape"`. Cover at minimum `currentOwnerEpoch` as a string and `leaseAffirmedAt` as a number.
4. **Observation granularity is per-field, not per-file.** An owner record with a valid `runId` and a **non-integer `currentOwnerEpoch`** must yield `runId`: `present`, `currentOwnerEpoch`: `unreadable`/`shape`, and the remaining three fields observed independently on their own merits.

   *Kills:* an implementation that delegates to `parseOwnerRecordForLease` (`src/ownership/lease.ts:64-94`). That parser **throws** on a bad `currentOwnerEpoch`, so a delegating implementation can only mark the whole file unreadable — losing the four fields that were fine. This is spec §7.3 consequence 1, and it is the only assertion here that actually distinguishes the two designs. (Asserting merely that a missing `runId` is "not silently accepted" does **not** distinguish them: a delegating implementation reads `parsed.runId`, gets `undefined`, and reports `absent` too.)

5. **`runId` and `ownerStatus` are observed at all.** Both are `absent` when missing and `unreadable`/`shape` when present with a non-string value. `parseOwnerRecordForLease` validates neither, so an implementation that treats "the parser passed" as "the record is fine" would never surface either field's corruption.
6. `stopReason: null` → `present` with value `null`, **not** `absent`. *Kills:* an implementation using a truthiness check.
7. `leaseAffirmedAt` absent entirely → `absent`. Note `OwnerRecord` documents absent-means-null for legacy records (`src/runtime/types.ts:90-93`); the registry reports the raw observation and does **not** normalize.
8. `eligibleForContinuation: false` or `"true"` → `unreadable`/`shape`. The declared type is the literal `true` (`src/runtime/types.ts:103`), so anything else means corruption (spec §6.2).
9. A non-object parsed value (array, string, `null`) → every field in the spec marked `unreadable`/`shape`, not a thrown error.

**Traps:**
- `typeof null === "object"` — requirement 9 will catch this only if you test `null` explicitly.
- `ownerStatus` is a union of string literals (`OwnerStatus`). Check only that it **is a string**; do not validate union membership. Membership checking would duplicate a definition L1 owns and would drift the moment L1 adds a status.
- Do not import `parseOwnerRecordForLease`. Requirement 4 exists to make that import fail the suite.

- [ ] **Step 1:** Write the failing tests for requirements 1–9 in `tests/registry/observeFields.test.ts`.
- [ ] **Step 2:** Run `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/registry/observeFields.test.ts`. Expected: fail — module not found.
- [ ] **Step 3:** Implement `src/registry/types.ts` and `src/registry/observeFields.ts` to the signatures above. Minimal — no reading, no I/O, no traversal.
- [ ] **Step 4:** Re-run the same command. Expected: all pass.
- [ ] **Step 5:** Run `npm run typecheck`. Expected: clean.
- [ ] **Step 6:** Commit — `feat: add per-field run observation types and observer`.

---

## Task 2: Reading one observed file, with bounded re-read

**Files:**
- Create: `src/registry/readObservedFile.ts`
- Test: `tests/registry/readObservedFile.test.ts`

**Interfaces:**

*Consumes:* `ObservedFileSpec`, `FileObservation`, `observeFields` from Task 1.

*Produces:*

```ts
export type RunFileReaders = {
  readRunState(runDir: string): Promise<unknown>;
  readOwnerRecordWithoutRecovery(runDir: string): Promise<unknown>;
  readOwnerTransferRecord(runDir: string): Promise<unknown>;
};

export type ObserveDeps = {
  readers: RunFileReaders;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

export const defaultObserveDeps: ObserveDeps;

export function readObservedFile(
  runDir: string,
  spec: ObservedFileSpec,
  deps: ObserveDeps,
): Promise<FileObservation>;
```

`defaultObserveDeps.readers` binds, in order: `readRunState` (`fileStore.ts:697`), `readOwnerRecordWithoutRecovery` (`fileStore.ts:628`), `readOwnerTransferRecord` (`fileStore.ts:701`) — all three verified pure at spec §7.2.

**Behavior required by spec §8.1:**
- ENOENT → every field `absent`. **No retry.**
- Parse failure on a file with `atomic: false` → retry using `LEASE_VERIFY_READ_ATTEMPTS` and `LEASE_VERIFY_RETRY_DELAY_MS` from `src/ownership/lease.ts:7-8`. Import those constants; do not hardcode 3 and 50.
- Parse failure on a file with `atomic: true` → every field `unreadable`/`parse`. **No retry.**
- Retry exhausted → every field `unreadable`/`parse`.

**Test requirements:**

1. First read throws a `SyntaxError`, second returns a valid object → fields report the parsed values, **and the reader was called more than once**. Assert the call count; asserting only the result would pass against an implementation that got lucky.
2. ENOENT → all fields `absent` **and the reader was called exactly once**. *Kills:* an implementation that retries every failure, which would make scanning a tree of half-initialized runs needlessly slow.
3. An atomic-spec file that fails to parse → reader called exactly once, fields `unreadable`/`parse`. *Kills:* retrying `owner-transfer.json`, which is written by rename (`fileStore.ts:535-536`) and cannot tear.
4. Parse fails on all attempts → fields `unreadable`/`parse`, reader called exactly `LEASE_VERIFY_READ_ATTEMPTS` times.
5. `sleep` is called with `LEASE_VERIFY_RETRY_DELAY_MS` between attempts, and **not** after the final attempt.

This is spec §12.4. It replaces the earlier "scan a run whose heartbeat is actively writing" requirement, which could not fail deterministically and would have added timing flake — see the spec's amendment (g) for why.

**Traps:**
- Distinguish ENOENT from a parse failure by inspecting `(error as NodeJS.ErrnoException).code === "ENOENT"`, not by matching message text.
- A permission error (`EACCES`) reaching this function is neither absent nor a parse failure. Per spec §11 it maps to every field `unreadable`/`io`, with no retry. Do not let it fall through to `absent` — that would report a present-but-forbidden file as missing. Add a test for it.
- Injected fakes must be per-test, not shared — a leaked call counter across tests produces a passing suite that proves nothing.
- Tests must inject `sleep`; a real 100 ms delay per case is exactly the timing-flake shape this branch already carries debt for.

- [ ] **Step 1:** Write the failing tests for requirements 1–5.
- [ ] **Step 2:** Run the scoped test command. Expected: fail — module not found.
- [ ] **Step 3:** Implement `readObservedFile.ts` to the signature and behavior above.
- [ ] **Step 4:** Re-run. Expected: all pass.
- [ ] **Step 5:** `npm run typecheck`. Expected: clean.
- [ ] **Step 6:** Commit — `feat: read observed run files with bounded re-read for non-atomic writes`.

---

## Task 3: Observing one run directory

**Files:**
- Create: `src/registry/observeRun.ts`
- Test: `tests/registry/observeRun.test.ts`

**Interfaces:**

*Consumes:* everything from Tasks 1 and 2.

*Produces:*

```ts
export type RunObservation = {
  kind: "run";
  path: string;
  observedAt: string;
  files: FileObservation[];
};

export function observeRun(runDir: string, deps: ObserveDeps): Promise<RunObservation>;
```

`observedAt` is `deps.now().toISOString()`. `files` carries one entry per `OBSERVED_FILES` entry, in that order, always — a file that is absent still produces a `FileObservation` whose fields are all `absent` (spec §6: a row is never omitted).

**Test requirements:**

1. A fully populated run directory → all three files observed, all fields `present`.
2. A directory with only `loop-state.json` → that file's fields `present`; the other two files still appear in `files`, all fields `absent`.
3. `observedAt` comes from the injected `now`, so the assertion is exact rather than a range.
4. The three files are read **concurrently or sequentially — either is fine — but a failure reading one must not prevent the other two from being observed.** Assert with one reader throwing an unexpected error kind.

**Traps:**
- Do not stop at the first failure. Requirement 4 is the reason.
- Do not omit a `FileObservation` when the file is absent — that is the difference between "reported absent" and "silently dropped", and the whole spec turns on it.

- [ ] **Step 1:** Write the failing tests for requirements 1–4.
- [ ] **Step 2:** Run the scoped test command. Expected: fail.
- [ ] **Step 3:** Implement `observeRun.ts`.
- [ ] **Step 4:** Re-run. Expected: all pass.
- [ ] **Step 5:** `npm run typecheck`. Expected: clean.
- [ ] **Step 6:** Commit — `feat: observe a single run directory`.

---

## Task 4: Traversal, recognition, and descent rules

**Files:**
- Create: `src/registry/scanRuns.ts`
- Test: `tests/registry/scanRuns.test.ts`

**Interfaces:**

*Consumes:* `observeRun`, `ObserveDeps`, `RunObservation`.

*Produces:*

```ts
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

export const defaultScanDeps: ScanDeps;

export const RUN_MARKER_FILES: readonly string[];
export const MAX_SCAN_DEPTH: number;

export function scanRuns(root: string, deps: ScanDeps): Promise<ScanRow[]>;
```

`RUN_MARKER_FILES` is exactly, per spec §4:
`loop-contract.json`, `loop-state.json`, `events.jsonl`, `owner-record.json`, `owner-transfer.json`.

`MAX_SCAN_DEPTH` is `10` (spec §5.4).

**Test requirements:**

1. **Permissive recognition (spec §12.6).** Three separate directories, each containing only `events.jsonl`, only `owner-record.json`, and only `owner-transfer.json` respectively — each is recognized and reported, with the remaining files' fields `absent`. *Kills:* recognizing only by `loop-contract.json`. Note `initializeRunFiles` (`fileStore.ts:72-78`) never writes `owner-record.json`; it first appears at `runLoop.ts`, the `writeOwnerRecord` call just below the lease gate, so an owner-record-only directory is a real state.
2. **No descent into a recognized run (spec §12.3).** Place a complete valid run at `<run>/worktrees/attempt-1/` and assert exactly one row is returned, for `<run>`. *Kills:* naive recursion. The path shape is from `src/workspace/worktreeManager.ts:18`.
3. Symbolic links are not followed. A symlink pointing at a directory containing a run must not produce a row.
4. **Depth truncation (spec §12.7).** A tree nested deeper than `MAX_SCAN_DEPTH` below the root yields a `depth_truncated` row — not silence, not a thrown error.
5. **Unreadable directory (spec §12.7).** A directory whose `readDir` rejects yields a `directory_unreadable` row **and the scan still returns rows for its siblings.** *Kills:* letting the rejection propagate and abort the scan.
6. An empty root returns an empty array, not an error.
7. A root that is itself a run directory returns exactly one row for the root.

**Traps:**
- Requirement 5 is about *continuing*, not just recording. Assert a sibling row is present in the same result — asserting only the issue row would pass against an implementation that aborts right after recording it.
- Recognition is per-directory and must be checked **before** descending, or requirement 2 fails.
- Symlink detection needs `withFileTypes` / `lstat` semantics; `stat` follows links and will silently defeat requirement 3. `DirEntry.isSymbolicLink` exists so this decision is made in the injected reader, not buried.
- Depth counts directories below the root; write the test so off-by-one is visible (assert at exactly `MAX_SCAN_DEPTH` it still scans, and at `MAX_SCAN_DEPTH + 1` it truncates).

- [ ] **Step 1:** Write the failing tests for requirements 1–7.
- [ ] **Step 2:** Run the scoped test command. Expected: fail.
- [ ] **Step 3:** Implement `scanRuns.ts`.
- [ ] **Step 4:** Re-run. Expected: all pass.
- [ ] **Step 5:** `npm run typecheck`. Expected: clean.
- [ ] **Step 6:** Commit — `feat: add run directory traversal with recognition and descent rules`.

---

## Task 5: Zero-write proof against a real filesystem

**Files:**
- Test: `tests/registry/zeroWrite.test.ts` (create — no source changes expected)

This task is separate because it is the layer's single most important test and its fixture preconditions are load-bearing. It runs against a **real** temp directory using `defaultScanDeps`, not injected fakes — injection would prove nothing about the production reader bindings.

**Test requirements (spec §12.1):**

1. Build a realistic run tree in a temp directory. Snapshot every path as `(relative path, size, mtimeMs, sha256 of contents)`. Run `scanRuns` with `defaultScanDeps`. Re-snapshot. Assert deep equality.

2. **The fixture must genuinely trigger `readOwnerRecord`'s recovery**, so that binding the forbidden reader fails this test. Per `fileStore.ts:549-563`, recovery requires **all** of:
   - `.owner-transfer.transaction.json` **present** — this is the trigger (`:552`); without it `recoverInterruptedOwnerTransfer` returns immediately.
   - `.owner-record.pending.json` **and** `.owner-transfer.pending.json` both present — `finalizePendingOwnerTransfer` reads them and throws ENOENT otherwise.
   - `.owner-transfer.lock` **absent** — with a live lock, `readOwnerRecord` returns without writing (`:559-561`), and the test would pass against the very implementation it targets.

   Read `getOwnerTransferPaths` (`fileStore.ts:323-330`) for the exact filenames rather than transcribing them from this plan.

3. **Assert the fixture is load-bearing.** Before asserting the scan writes nothing, assert that calling `readOwnerRecord` directly against this same fixture *does* mutate the tree. Without this, a fixture that silently fails to trigger recovery yields a test that proves nothing — which is precisely how the spec's earlier draft of this requirement was defective (amendment (f)).

4. Include in the tree: a run with a malformed `loop-state.json`, a run missing `owner-record.json`, and a nested `worktrees/attempt-1/` run — so the zero-write claim covers the error paths, not just the happy one.

**Traps:**
- Compare `mtimeMs`, not `mtime` — Date object identity comparisons can pass spuriously.
- Do not include `atime` in the snapshot; reading legitimately updates it on some mounts and the test would flake.
- The temp directory must be created fresh per test and removed after. Do not scan anything inside the repository itself.
- If requirement 3 fails — i.e. `readOwnerRecord` does *not* mutate the fixture — **stop and report**. It means the recovery preconditions have changed since the spec was written, and the fixture needs correcting before the main assertion means anything.

- [ ] **Step 1:** Write the fixture builder and requirement 3 (the load-bearing assertion) first. Run it. Expected: it passes, proving the fixture triggers recovery.
- [ ] **Step 2:** Write requirement 1's snapshot assertion. Run it. Expected: pass (the implementation is already correct if Tasks 1–4 bound the right reader).
- [ ] **Step 3:** Temporarily rebind `defaultObserveDeps.readers.readOwnerRecordWithoutRecovery` to `readOwnerRecord` in a scratch edit and re-run. Expected: **fail.** This confirms the test can detect the defect it exists for. Revert the scratch edit.
- [ ] **Step 4:** Add requirement 4's error-path fixtures. Re-run. Expected: pass.
- [ ] **Step 5:** Run the full suite: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`. Expected: all pass, no regressions.
- [ ] **Step 6:** Commit — `test: prove the registry scan writes nothing, including on the recovery path`.

---

## Task 6: CLI `ls` subcommand, rendering, and exit codes

**Files:**
- Create: `src/registry/renderRuns.ts`
- Modify: `src/cli.ts`
- Test: `tests/registry/renderRuns.test.ts`
- Test: `tests/cli/cli.test.ts` (modify)

**Interfaces:**

*Consumes:* `ScanRow`, `scanRuns`, `defaultScanDeps`.

*Produces:*

```ts
export type ScanResult = { schemaVersion: 1; rows: ScanRow[] };

export function toScanResult(rows: ScanRow[]): ScanResult;
export function renderScanTable(result: ScanResult): string;
```

**CLI behavior (spec §9):**
- `ccloop ls <root>` — human table by default, `--json` emits `ScanResult`.
- Exit `0` when the scan completed, **including when rows are `unreadable`**.
- Exit `1` when the scan itself failed (root missing or unreadable).
- Exit code `2` is never used by `ls`. In the existing CLI `2` means "the loop ran and did not succeed" (`src/cli.ts:92`); `ls` runs no loop.

**Test requirements:**

1. **No derived fields (spec §12.5).** Walk the serialized JSON of a populated `ScanResult` and assert no key matches `resumable`, `fresh`, `stale`, or `expired`, and no key containing `eligible` other than the observed literal `eligibleForContinuation`.

   The exemption is required and is the point: §6 *mandates* observing `eligibleForContinuation`, so a blanket ban on `eligible` would kill the correct implementation. Write the assertion so that adding a derived column fails while the mandated field passes — then verify that by temporarily adding a `resumable` key and confirming the test fails.

2. **Exit codes (spec §12.8).** A scan producing `unreadable` rows exits `0`. A scan whose root does not exist exits `1`. Neither exits `2`.

3. The human table states plainly that fields within a row are independent observations and do not constitute a consistent snapshot (spec §8.2). Assert the notice is present in the rendered output — this is a required part of the contract, not decoration.

4. `schemaVersion` is present and is `1`.

5. A row for a run with every field `absent` still renders a visible line. *Kills:* a renderer that filters empty rows, reintroducing the silent omission the whole spec forbids.

**Traps:**
- `src/cli.ts` currently maps a loop's status to the process exit code. `ls` has no loop and no status; do not route it through that mapping.
- Read `parseArgs` (`src/cli.ts:30`) before editing. `ls` takes a positional root and does **not** require `--adapter` or `--contract`; if the existing parser demands them for all subcommands, that is a real integration point — handle it and note it in the task report.
- Rendering must not sort or filter rows in a way that hides issue rows among run rows.
- Keep observation logic out of `cli.ts` entirely (spec §10).

- [ ] **Step 1:** Write the failing tests for requirements 1–5.
- [ ] **Step 2:** Run `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/registry/renderRuns.test.ts tests/cli/cli.test.ts`. Expected: fail.
- [ ] **Step 3:** Implement `renderRuns.ts` and wire the `ls` subcommand into `src/cli.ts`.
- [ ] **Step 4:** Re-run the scoped command. Expected: all pass.
- [ ] **Step 5:** Verify requirement 1 can fail: temporarily add a `resumable` key to a row, re-run, confirm failure, revert.
- [ ] **Step 6:** Run the full suite, `npm run typecheck`, and `npm run build`. Expected: all clean. Do **not** pipe through `tail`.
- [ ] **Step 7:** Commit — `feat: add the ccloop ls subcommand`.

---

## Final Verification

- [ ] `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run` — full suite green. Record the file and test counts. The starting baseline is **23 files / 373 tests**.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run build` — clean.
- [ ] Re-read spec §15 and confirm each success criterion has a test behind it.
- [ ] Update `.wolf/anatomy.md` with the new `src/registry/` and `tests/registry/` files.
- [ ] Append the session's entries to `.wolf/memory.md`; log any bug found to `.wolf/buglog.json`.

**Known pre-existing flake debt — do not investigate as new failures.** Four `BUDGET_EXHAUSTED_REASON` tests in `tests/controller/runLoop.integration.test.ts` (around `:1002`, `:1258`, `:1655`, `:1773`) race `perAttemptTimeoutMs` against `totalRuntimeBudgetMs`, both pinned at 20 ms, plus one L1 interleaving test that depends on real filesystem timing. This plan does not fix them. If you touch them, the only sanctioned fix is raising `perAttemptTimeoutMs` alone — `totalRuntimeBudgetMs` must stay at 20, because these tests assert the budget-exhaustion branch and raising the budget silently changes what they assert.

## Debts This Plan Does Not Take

Carried forward from spec §13, listed so no one "helpfully" fixes them here:

1. Reconciliation synthesis is unowned — L5.
2. `persistTerminalState` writes into a run it no longer owns (`runLoop.ts`, the `persistTerminalState` calls reached from the lease-loss branches `if (leaseLoss.lost !== null)` and `if (isLeaseStopError(error))` — four of the symbol's fifteen call sites, **not** all of them; see spec §13.2) — L5.
3. `heartbeat.stop()`'s release window (`leaseHeartbeat.ts:223`, `:231`) — currently unreachable; must be re-evaluated by whichever layer adds a triggering caller. **This layer adds none.**
4. `writeRunState` (`fileStore.ts:80-82`) and the initial `writeOwnerRecord` (`fileStore.ts:379-381` → `:367-369`) are non-atomic bare `writeFile` calls. This layer works around it with a bounded re-read (Task 2) rather than fixing it, because Global Constraint 4 forbids a discovery layer from rewriting another layer's write path.
