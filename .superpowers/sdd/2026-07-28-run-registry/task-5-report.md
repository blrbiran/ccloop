# Task 5 report: zero-write proof against a real filesystem

## Status: DONE

## Files

- Created `tests/registry/zeroWrite.test.ts`
- No source changes (as expected; the one temporary source edit made for the deliberate-
  failure check — see below — was fully reverted before the final run and confirmed clean
  via `git diff`)

## Summary

Added a real-filesystem test (`mkdtemp` + `node:fs/promises`, `defaultScanDeps` — no
injection) proving `scanRuns` writes nothing, including when the fixture genuinely triggers
`readOwnerRecord`'s crash recovery. No discrepancy between the brief and spec §7.1/§12.1 was
found; brief and spec describe the same three preconditions in the same terms, and both are
correct against the current `fileStore.ts:549-563` implementation.

### Fixture design

`buildRecoveryRun(scanRoot)` builds `run-recovery/` with all three
`recoverInterruptedOwnerTransfer` preconditions simultaneously:
- `.owner-transfer.transaction.json` present (trigger, `:552`)
- `.owner-record.pending.json` and `.owner-transfer.pending.json` present (read by
  `finalizePendingOwnerTransfer`, `:529-530`)
- `.owner-transfer.lock` **absent**

`buildFixture(tempRoot)` adds brief requirement 4's error-path fixtures — `run-malformed-state`
(malformed `loop-state.json`), `run-missing-owner` (no `owner-record.json`), `run-nested`
(valid nested run at `worktrees/attempt-1/`) — plus the controller's extra requirement: a real
`symlink()` at `run-with-symlink/link-to-run` pointing at `outside-target/real-run`, a valid
run placed *outside* `scanRoot` so it is reachable only through the symlink.

`snapshotTree(root)` walks the whole temp directory (both `scanRoot` and the out-of-band
`outside-target`) recording `(relative path, size, mtimeMs, sha256)` per the traps: compares
`mtimeMs` not `mtime`, omits `atime`, and for symlink entries uses `lstat`/`readlink` (never
follows) so the snapshot function itself can't defeat the symlink assertion.

### Step 3 — deliberate-failure check (brief-mandated)

Per the brief, I temporarily rebound `defaultObserveDeps.readers.readOwnerRecordWithoutRecovery`
to the forbidden `readOwnerRecord` in `src/registry/readObservedFile.ts`, re-ran the suite,
and reverted.

**Observed result: the zero-write test failed, as required.** Test 1 (the load-bearing
assertion) still passed unchanged. Test 2 failed with a `toEqual` mismatch: after the scratch
rebind, `scanRuns` on `run-recovery` caused `.owner-transfer.transaction.json`,
`.owner-record.pending.json`, and `.owner-transfer.pending.json` to disappear from the
snapshot entirely, and `owner-record.json` / `owner-transfer.json` to be rewritten in place —
`owner-record.json`'s `currentOwnerEpoch` changed from `1` to `2` and both files' `mtimeMs`
advanced, while every other fixture file (the 12 unaffected entries) stayed byte-identical.
This is exactly the finalize-transfer mutation `recoverInterruptedOwnerTransfer` performs, and
it confirms the fixture is load-bearing: an implementation that bound the forbidden reader is
caught by this test. The scratch edit was reverted; `git diff src/registry/readObservedFile.ts`
is empty.

## Verification

- `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/registry/zeroWrite.test.ts`:
  2/2 passed (both the load-bearing assertion and the zero-write scan).
- Deliberate-failure check (scratch edit in place): 1/2 passed, 1 failed as required — see
  above. Edit reverted; confirmed clean via `git diff`.
- `npm run typecheck`: clean.
- Full suite: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`: 407/407 passed, 28 test
  files, no regressions.

## Constraints honored

- Zero writes by the scanner: confirmed against the real `node:fs` bindings in
  `defaultScanDeps`, not a fake.
- `readOwnerRecord` is called only inside the test (deliberately, for the load-bearing
  assertion), never by production code — confirmed the scratch rebind was reverted and
  `readObservedFile.ts` is byte-identical to its committed version.
- Only `tests/registry/zeroWrite.test.ts` was added; no file outside `src/registry/` or
  `tests/registry/` was modified in the final state.
- Test fixtures write extensively (that's expected and necessary to build the tree); only the
  *scan itself* is asserted zero-write.

## Commit

`534b3ad` — `test: prove the registry scan writes nothing, including on the recovery path`

## Concerns / discrepancies

None. The brief's step-by-step preconditions matched the spec and the actual
`fileStore.ts:549-563` behavior exactly on the first attempt; no correction to the fixture was
needed. One minor design choice worth surfacing: the symlink target run was placed *outside*
`scanRoot` (in a sibling `outside-target/` directory under the same temp root) rather than
nested reachably-elsewhere-within `scanRoot`, so that a broken implementation which followed
the symlink would be unambiguously caught (the target is otherwise completely unreachable by
normal traversal) rather than possibly also being found via a second, legitimate path.
