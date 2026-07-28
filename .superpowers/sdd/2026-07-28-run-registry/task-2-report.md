## Task 2 report: reading one observed file, with bounded re-read

### What was built

- `src/registry/readObservedFile.ts` — the I/O layer beneath `observeFields` (Task 1).
  Exports `RunFileReaders`, `ObserveDeps`, `defaultObserveDeps`, and
  `readObservedFile(runDir, spec, deps): Promise<FileObservation>`, exactly matching the
  signatures in the brief.
- `tests/registry/readObservedFile.test.ts` — 6 tests covering the brief's requirements 1–5
  plus the EACCES trap.

### Decisions and why

**Reader selection.** `readObservedFile` picks which of the three injected readers to call by
switching on `spec.file` (`"loop-state.json"` → `readRunState`, `"owner-record.json"` →
`readOwnerRecordWithoutRecovery`, `"owner-transfer.json"` → `readOwnerTransferRecord`). There is
no data-driven mapping available from `ObservedFileSpec` to a reader name, so this had to be an
explicit switch. It throws on an unrecognized filename rather than silently no-op'ing, since
`OBSERVED_FILES` is a closed, known set — a fourth spec.file value reaching this function would
itself be a bug worth surfacing loudly (Rule 12).

**Retry gating.** `maxAttempts = spec.atomic ? 1 : LEASE_VERIFY_READ_ATTEMPTS`. This uses the
per-file `atomic` flag Task 1 already carries on `ObservedFileSpec`, so no second table of
"which files retry" needed to be introduced — `loop-state.json` and `owner-record.json` are
`atomic: false` in `OBSERVED_FILES` (matching §8.1's ruling that owner-record.json's *initial*
write is non-atomic, so the conservative treatment applies file-wide), and
`owner-transfer.json` is `atomic: true`.

**Error classification.** Three-way branch per attempt:
1. `(error as NodeJS.ErrnoException).code === "ENOENT"` → `absentObservation`, returned
   immediately (no retry, no further attempts) — per the brief's explicit trap.
2. `error instanceof SyntaxError` → retryable parse failure. The verified-pure readers (§7.2)
   are exactly `readFile` + `JSON.parse(...) as T`, a blind cast with no further validation, so
   the *only* two failure shapes reaching this function are an fs error (from `readFile`) or a
   `SyntaxError` (from `JSON.parse`). `instanceof SyntaxError` is therefore a reliable
   discriminator, not a heuristic.
3. Anything else (e.g. `EACCES`) → `ioUnreadableObservation`, returned immediately, no retry.
   This is the trap the brief calls out by name: an EACCES must not fall through to `absent`.

Sleep happens only *between* attempts (`attempt < maxAttempts` guard), never after the final
attempt, satisfying requirement 5 directly via loop structure rather than a post-hoc check.

**`now()` in `ObserveDeps`.** Present in the type and wired into `defaultObserveDeps` (`() => new
Date()`) per the signature, but unused inside `readObservedFile` itself — the brief and spec
§13 are explicit that stamping/timestamping is a later task's concern and that "no clock
comparisons" applies here. Kept as a no-op pass-through so the interface Task 3 will consume is
already correct.

### Spec vs. brief

No discrepancy found. I checked brief lines 37–41 against spec §8.1 (lines 267–292) and §11
(lines 351–365) directly, plus §12.4 requirement 4 (lines 405–417) and §7.2 (lines 199–213) for
the reader bindings and line numbers cited in the brief (`fileStore.ts:566`, `:628`, `:697`,
`:701`). All matched verbatim — signatures, constant names (`LEASE_VERIFY_READ_ATTEMPTS`,
`LEASE_VERIFY_RETRY_DELAY_MS`, confirmed at `src/ownership/lease.ts:7-8` as `3` and `50`), and
behaviors. Nothing to report.

### Global constraints verified

- Zero writes: `readObservedFile.ts` calls only the three injected/imported readers, `observeFields`,
  and `deps.sleep`/`setTimeout`. No `writeFile`, `rename`, `unlink`, or `mkdir` anywhere in the file.
- `readOwnerRecord` (the recovery-running one) is neither imported nor referenced — only
  `readOwnerRecordWithoutRecovery` is imported from `fileStore.ts`.
- `checkRunLease` / `leaseGate.ts` is not imported or referenced.
- Only `src/registry/` and `tests/registry/` were touched.
- `LEASE_VERIFY_READ_ATTEMPTS` and `LEASE_VERIFY_RETRY_DELAY_MS` are imported from
  `src/ownership/lease.ts`, not hardcoded.
- No derived fields, no clock comparisons.
- `.js` extensions used on all relative import specifiers (ESM/TS style match).

### Test output

Scoped command (`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
tests/registry/readObservedFile.test.ts`):

```
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 3ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

All 6 tests complete in 3ms total — confirms `sleep` is genuinely faked (a real
`LEASE_VERIFY_RETRY_DELAY_MS` delay per retrying test would show up as tens of ms).

`npm run typecheck`: clean, no errors.

Full suite (`ECC_GATEGUARD=off DISABLE_OMC=1 npm test`), run as an extra sanity check beyond the
scoped command: 25 test files, 392 tests, all passed.

### Test-per-fake isolation

Each test builds its own `RunFileReaders`/`ObserveDeps` via a local `makeDeps()` factory with a
fresh closure-scoped `calls` counter — no shared/module-level mutable state, per the brief's
"leaked call counter" trap.

### Commit

`ef65e97` — `feat: read observed run files with bounded re-read for non-atomic writes`
(2 files changed, 295 insertions(+): `src/registry/readObservedFile.ts`,
`tests/registry/readObservedFile.test.ts`).
