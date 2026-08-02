# Task A1 report — marker 与两份既有 pending 改原子写

## What was implemented

`src/persistence/fileStore.ts`:

1. Three new module-private constants (verbatim names/values from the brief), placed right
   after the existing five owner-transfer constants:
   ```ts
   const OWNER_TRANSFER_MARKER_TEMP_FILE = ".owner-transfer.transaction.tmp";
   const OWNER_RECORD_PENDING_TEMP_FILE = ".owner-record.pending.tmp";
   const OWNER_TRANSFER_PENDING_TEMP_FILE = ".owner-transfer.pending.tmp";
   ```
2. `OwnerTransferPaths` gained three keys: `transactionMarkerTempPath`, `ownerPendingTempPath`,
   `transferPendingTempPath`. `getOwnerTransferPaths` returns all three (`join(runDir, ...)`).
3. New module-private `writeJsonFileViaFixedTemp(tempPath, targetPath, value)`, placed
   immediately after `writeOwnerRecordAtomically` (same shape, generalized to a caller-supplied
   temp path, since `writeOwnerRecordAtomically` derives its temp path from `runDir` but these
   three temp names must stay fixed and shared across processes for crash recovery to find them):
   ```ts
   async function writeJsonFileViaFixedTemp(tempPath: string, targetPath: string, value: unknown): Promise<void> {
     await safeUnlink(tempPath);
     await writeJsonFile(tempPath, value);
     await rename(tempPath, targetPath);
   }
   ```
   Does **not** reuse `writeJsonFileAtomically` (its `buildAtomicTempPath` stamps a process id +
   sequence number into the name, which `cleanupOwnerTransferStagingWithoutMarker` could never
   find again by name).
4. `writeOwnerTransferArtifacts`'s staging section: the three bare `writeJsonFile(paths.…Path, …)`
   calls became three `writeJsonFileViaFixedTemp(paths.…TempPath, paths.…Path, …)` calls, in the
   same order (transferPending, ownerPending, marker).
5. `cleanupOwnerTransferStagingWithoutMarker`: grew from 4 `safeUnlink` calls to 7 — added
   `ownerPendingTempPath`, `transferPendingTempPath`, `transactionMarkerTempPath` alongside the
   existing `ownerPendingPath`, `transferPendingPath`, `ownerTempPath`, `transferTempPath`.

**Untouched, per the task's boundary and confirmed by `git diff`:** `finalizePendingOwnerTransfer`
(zero lines touched — marker temp is not added to its try/catch, per the brief's warning that
finalize never writes the marker), `hasStagedArtifacts`'s three-path check inside
`tryRecoverStaleOwnerTransferLock` (not expanded to include the new temps — expanding it would
loosen lock-stealing conditions, against the "only add refusals" boundary), `src/registry/`.

`tests/persistence/fileStore.test.ts`: three new tests added inside the `describe("fileStore", …)`
block, right after "releases the lock after recovering malformed staged state" and before
"writes contract, state, events, and attempt artifacts" (the boundary of the owner-transfer test
cluster).

## Step 1 — background numbers re-run before starting

```
$ grep -nE 'pending.json|publish.tmp|transaction.json' src/persistence/fileStore.ts
326:const OWNER_RECORD_TEMP_FILE = ".owner-record.publish.tmp";
327:const OWNER_TRANSFER_TEMP_FILE = ".owner-transfer.publish.tmp";
328:const OWNER_RECORD_PENDING_FILE = ".owner-record.pending.json";
329:const OWNER_TRANSFER_PENDING_FILE = ".owner-transfer.pending.json";
330:const OWNER_TRANSFER_MARKER_FILE = ".owner-transfer.transaction.json";
```
— 5 lines, matches plan's stated baseline exactly (326/327/328/329/330).

```
$ grep -nF -e 'await writeJsonFile(paths.transferPendingPath' -e 'await writeJsonFile(paths.ownerPendingPath' -e 'await writeJsonFile(paths.transactionMarkerPath' src/persistence/fileStore.ts
675:    await writeJsonFile(paths.transferPendingPath, transferRecord);
676:    await writeJsonFile(paths.ownerPendingPath, ownerRecord);
677:    await writeJsonFile(paths.transactionMarkerPath, marker);
```
— 3 lines, matches plan's stated baseline exactly (675/676/677).

```
$ grep -nF -A6 'async function cleanupOwnerTransferStagingWithoutMarker(' src/persistence/fileStore.ts
600:async function cleanupOwnerTransferStagingWithoutMarker(runDir: string): Promise<void> {
601-  const { ownerPendingPath, transferPendingPath, ownerTempPath, transferTempPath } = getOwnerTransferPaths(runDir);
602-  await safeUnlink(ownerPendingPath);
603-  await safeUnlink(transferPendingPath);
604-  await safeUnlink(ownerTempPath);
605-  await safeUnlink(transferTempPath);
606-}
```
— signature + 4 `safeUnlink`, 0 `rename`. Matches plan's stated baseline exactly.

No drift from the plan-stage baseline — proceeded without escalating.

## Environment note: rtk output filtering

This shell's global hook auto-rewrites `npx vitest`/`npm test` invocations through `rtk`, which
by default prints a **summarized** result (test names collapsed to pass/fail counts, full
failure detail redirected to a log file) — this collides with the project's hard "never filter
verification output" rule. All verification commands below were therefore run through
`rtk proxy "<command>"` (per `RTK.md`: "Execute raw command without filtering, for debugging"),
which prints vitest's normal unfiltered stdout/stderr. Every pasted block below is that raw
output.

## TDD evidence

### RED (Steps 2–5)

All three tests added to the production-code-untouched tree, then run individually.

**Test 4d** — full name: `fileStore > publishes the transaction marker by rename, leaving only .owner-transfer.transaction.tmp when the rename fails`

Command: `ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/persistence/fileStore.test.ts -t 'publishes the transaction marker by rename, leaving only .owner-transfer.transaction.tmp when the rename fails'`

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (56 tests | 1 failed | 55 skipped) 16ms
   × fileStore > publishes the transaction marker by rename, leaving only .owner-transfer.transaction.tmp when the rename fails 16ms
     → promise resolved "undefined" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > publishes the transaction marker by rename, leaving only .owner-transfer.transaction.tmp when the rename fails
AssertionError: promise resolved "undefined" instead of rejecting

- Expected:
[Error: rejected promise]

+ Received:
undefined

 ❯ tests/persistence/fileStore.test.ts:1107:7
    1105|       await expect(
    1106|         fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerReco…
    1107|       ).rejects.toThrow("simulated marker rename failure");
       |       ^
    1108|     } finally {
    1109|       vi.doUnmock("node:fs/promises");

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 55 skipped (56)
```

Red as expected — marker was still a bare `writeJsonFile`, so nothing rejects when the mocked
`rename` throws.

**Test 4e(i)** — full name: `fileStore > publishes .owner-record.pending.json by rename, leaving only .owner-record.pending.tmp when the rename fails`

Command: `ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/persistence/fileStore.test.ts -t 'publishes .owner-record.pending.json by rename, leaving only .owner-record.pending.tmp when the rename fails'`

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (56 tests | 1 failed | 55 skipped) 12ms
   × fileStore > publishes .owner-record.pending.json by rename, leaving only .owner-record.pending.tmp when the rename fails 12ms
     → promise resolved "undefined" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > publishes .owner-record.pending.json by rename, leaving only .owner-record.pending.tmp when the rename fails
AssertionError: promise resolved "undefined" instead of rejecting

- Expected:
[Error: rejected promise]

+ Received:
undefined

 ❯ tests/persistence/fileStore.test.ts:1163:7
    1161|       await expect(
    1162|         fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerReco…
    1163|       ).rejects.toThrow("simulated owner-pending rename failure");
       |       ^
    1164|     } finally {
    1165|       vi.doUnmock("node:fs/promises");

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 55 skipped (56)
```

**Test 4e(ii)** — full name: `fileStore > publishes .owner-transfer.pending.json by rename, leaving only .owner-transfer.pending.tmp when the rename fails`

Command: `ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/persistence/fileStore.test.ts -t 'publishes .owner-transfer.pending.json by rename, leaving only .owner-transfer.pending.tmp when the rename fails'`

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (56 tests | 1 failed | 55 skipped) 14ms
   × fileStore > publishes .owner-transfer.pending.json by rename, leaving only .owner-transfer.pending.tmp when the rename fails 14ms
     → promise resolved "undefined" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > publishes .owner-transfer.pending.json by rename, leaving only .owner-transfer.pending.tmp when the rename fails
AssertionError: promise resolved "undefined" instead of rejecting

- Expected:
[Error: rejected promise]

+ Received:
undefined

 ❯ tests/persistence/fileStore.test.ts:1219:7
    1217|       await expect(
    1218|         fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerReco…
    1219|       ).rejects.toThrow("simulated transfer-pending rename failure");
       |       ^
    1220|     } finally {
    1221|       vi.doUnmock("node:fs/promises");

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 55 skipped (56)
```

### GREEN (Step 7 — after implementation)

**4d**:
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (56 tests | 55 skipped) 12ms

 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)
```

**4e(i)**:
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (56 tests | 55 skipped) 11ms

 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)
```

**4e(ii)**:
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (56 tests | 55 skipped) 10ms

 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)
```

### Full suite after implementation

`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`:

```
 Test Files  29 passed (29)
      Tests  449 passed (449)
   Start at  09:38:10
   Duration  16.09s (transform 1.95s, setup 0ms, collect 3.08s, tests 51.74s, environment 4ms, prepare 1.65s)
```

29 files / 449 tests (446 baseline + 3 new), exit 0. Flake (B)
(`run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`)
and flake (F) (inside `runLoop.integration.test.ts`, 49/49 passed in that file) both landed `✓`
this run — no failures of any kind.

## Mutation evidence (Step 8) — three mutations, six raw outputs

Each mutation: revert one `writeJsonFileViaFixedTemp(...)` call in
`writeOwnerTransferArtifacts` back to the bare `writeJsonFile(paths.…Path, …)` it replaced —
production code, not fixture. Injected via `Edit` directly in `src/persistence/fileStore.ts`,
single test run before and after, then reverted before moving to the next mutation.

### Mutation 1 — marker: `writeJsonFileViaFixedTemp(paths.transactionMarkerTempPath, paths.transactionMarkerPath, marker)` → `writeJsonFile(paths.transactionMarkerPath, marker)`

Target test: `fileStore > publishes the transaction marker by rename, leaving only .owner-transfer.transaction.tmp when the rename fails`

BEFORE injection (green):
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (56 tests | 55 skipped) 12ms

 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)
```

AFTER injection (red):
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (56 tests | 1 failed | 55 skipped) 16ms
   × fileStore > publishes the transaction marker by rename, leaving only .owner-transfer.transaction.tmp when the rename fails 15ms
     → promise resolved "undefined" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > publishes the transaction marker by rename, leaving only .owner-transfer.transaction.tmp when the rename fails
AssertionError: promise resolved "undefined" instead of rejecting

- Expected:
[Error: rejected promise]

+ Received:
undefined

 ❯ tests/persistence/fileStore.test.ts:1107:7
    1105|       await expect(
    1106|         fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerReco…
    1107|       ).rejects.toThrow("simulated marker rename failure");
       |       ^
    1108|     } finally {
    1109|       vi.doUnmock("node:fs/promises");

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 55 skipped (56)
```

Reverted immediately after.

### Mutation 2 — owner-pending: `writeJsonFileViaFixedTemp(paths.ownerPendingTempPath, paths.ownerPendingPath, ownerRecord)` → `writeJsonFile(paths.ownerPendingPath, ownerRecord)`

Target test: `fileStore > publishes .owner-record.pending.json by rename, leaving only .owner-record.pending.tmp when the rename fails`

BEFORE injection (green):
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (56 tests | 55 skipped) 9ms

 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)
```

AFTER injection (red):
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (56 tests | 1 failed | 55 skipped) 16ms
   × fileStore > publishes .owner-record.pending.json by rename, leaving only .owner-record.pending.tmp when the rename fails 16ms
     → promise resolved "undefined" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > publishes .owner-record.pending.json by rename, leaving only .owner-record.pending.tmp when the rename fails
AssertionError: promise resolved "undefined" instead of rejecting

- Expected:
[Error: rejected promise]

+ Received:
undefined

 ❯ tests/persistence/fileStore.test.ts:1163:7
    1161|       await expect(
    1162|         fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerReco…
    1163|       ).rejects.toThrow("simulated owner-pending rename failure");
       |       ^
    1164|     } finally {
    1165|       vi.doUnmock("node:fs/promises");

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 55 skipped (56)
```

Reverted immediately after.

### Mutation 3 — transfer-pending: `writeJsonFileViaFixedTemp(paths.transferPendingTempPath, paths.transferPendingPath, transferRecord)` → `writeJsonFile(paths.transferPendingPath, transferRecord)`

Target test: `fileStore > publishes .owner-transfer.pending.json by rename, leaving only .owner-transfer.pending.tmp when the rename fails`

BEFORE injection (green):
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (56 tests | 55 skipped) 11ms

 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)
```

AFTER injection (red):
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (56 tests | 1 failed | 55 skipped) 16ms
   × fileStore > publishes .owner-transfer.pending.json by rename, leaving only .owner-transfer.pending.tmp when the rename fails 15ms
     → promise resolved "undefined" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > publishes .owner-transfer.pending.json by rename, leaving only .owner-transfer.pending.tmp when the rename fails
AssertionError: promise resolved "undefined" instead of rejecting

- Expected:
[Error: rejected promise]

+ Received:
undefined

 ❯ tests/persistence/fileStore.test.ts:1219:7
    1217|       await expect(
    1218|         fileStore.writeOwnerTransferArtifacts(runDir, initialOwnerReco…
    1219|       ).rejects.toThrow("simulated transfer-pending rename failure");
       |       ^
    1220|     } finally {
    1221|       vi.doUnmock("node:fs/promises");

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 55 skipped (56)
```

Reverted immediately after. `git diff --stat -- src/persistence/fileStore.ts` after all three
reverts showed the same `36 insertions(+), 4 deletions(-)` as right after Step 6 — confirming no
mutation leaked into the committed state.

## Post-mutation-cycle full verification (before commit)

`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`:
```
 Test Files  29 passed (29)
      Tests  449 passed (449)
   Start at  09:40:33
   Duration  16.13s (transform 2.09s, setup 0ms, collect 3.26s, tests 49.74s, environment 5ms, prepare 1.67s)

test_exit=0
```

`npm run typecheck`:
```
> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0
```

`npm run build`:
```
> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "..."

build_exit=0
```

## Files changed

- `src/persistence/fileStore.ts` — 3 new constants, `OwnerTransferPaths` +3 keys,
  `getOwnerTransferPaths` +3 return fields, new `writeJsonFileViaFixedTemp`,
  `writeOwnerTransferArtifacts` staging section switched to it,
  `cleanupOwnerTransferStagingWithoutMarker` 4 → 7 `safeUnlink` calls.
- `tests/persistence/fileStore.test.ts` — 3 new tests (4d, 4e(i), 4e(ii)).

## Repo-wide stale line-number scan (post-edit)

Ran `grep -rnF 'fileStore.ts:'` (and `.test.ts` internal references) across the repo. All hits
inside historical dated plan/spec/decision documents (`docs/superpowers/plans/**`,
`docs/superpowers/specs/**`, `docs/superpowers/decisions/**`, `.superpowers/sdd/**/progress.md`)
were already stale **before** this task started — confirmed by diffing against `git show
HEAD~1:src/persistence/fileStore.ts` (e.g. `fileStore.ts:535-536` at HEAD~1 was inside
`tryRecoverStaleOwnerTransferLock`, not the rename this task's own edit touches — pre-existing
drift, part of the acknowledged "六处案底"). Out of scope for A1 per Rule 3 (don't fix adjacent
things) and because these are frozen historical records, not living specs.

The two references inside **living** code (`tests/persistence/fileStore.test.ts:1950` →
`fileStore.ts:52-56`; `src/registry/observeFields.ts:9` → `fileStore.ts:77 and :82`) both sit
**before** this task's insertion point (line 324) and were re-verified accurate against the
current file after the edit. No new staleness was introduced by this task's edit.

## Self-review

- **Completeness**: all six brief-mandated production changes present (3 constants, 3
  `OwnerTransferPaths` keys + `getOwnerTransferPaths` wiring, `writeJsonFileViaFixedTemp`, 3
  staging-write swaps, `cleanupOwnerTransferStagingWithoutMarker` 4→7). Both mandatory pending
  sub-cases (4e(i), 4e(ii)) covered, not just the marker. `finalizePendingOwnerTransfer` and
  `hasStagedArtifacts` confirmed untouched via `git diff`.
- **Quality**: `writeJsonFileViaFixedTemp` copies `writeOwnerRecordAtomically`'s exact three-line
  shape per the brief's "逐字同形" instruction, documented with a comment explaining why it isn't
  merged with `writeJsonFileAtomically`.
- **Discipline**: no refactor of adjacent code; the four pre-existing `safeUnlink` calls in
  `cleanupOwnerTransferStagingWithoutMarker` were left exactly as they were, only extended.
  `hasStagedArtifacts` deliberately not touched, matching the brief's explicit "不要顺手" warning.
- **Tests**: all three test names have every clause backed by an assertion (temp exists / json
  absent pre-recovery, both absent post-recovery). Mutation coverage confirms each of the three
  assertions is load-bearing on the production write path, not on the test's own mock/fixture
  wiring. Recovery is driven through `claimOwnerRecordWithPrecondition` (a real locked entry
  point) as required, never through `readOwnerRecord`.

## Concerns

- The repo's global `rtk` shell hook filters/summarizes vitest output by default, which directly
  conflicts with this project's "never filter verification output" rule. I worked around it with
  `rtk proxy "<command>"` for every verification command in this report; flagging this as an
  environment-level friction point in case later tasks in this group hit the same thing and don't
  know the workaround.
