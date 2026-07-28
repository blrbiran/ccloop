# Task 3 Report: Observing one run directory

## Status: DONE

## Commit

`e688e90` — feat: observe a single run directory

## What was built

`src/registry/observeRun.ts` exports `RunObservation` and `observeRun(runDir, deps)`,
exactly per the brief's signature:

```ts
export type RunObservation = {
  kind: "run";
  path: string;
  observedAt: string;
  files: FileObservation[];
};

export async function observeRun(runDir: string, deps: ObserveDeps): Promise<RunObservation>
```

Implementation: `Promise.all(OBSERVED_FILES.map((spec) => readObservedFile(runDir, spec, deps)))`,
then wraps the result with `kind: "run"`, `path: runDir`, `observedAt: deps.now().toISOString()`.
`deps.now()` is called exactly once per `observeRun` call, not once per file — the spec and brief
both only need it stamped once on the row.

No hand-built `ObservedFileSpec` — specs are drawn only from the imported `OBSERVED_FILES`
(carried-forward constraint from Task 2's review). No new reader is bound; `defaultObserveDeps`
from Task 2 is reused as-is by any caller.

### Why `Promise.all` alone satisfies requirement 4 (no short-circuit on failure)

Traced `readObservedFile` (Task 2, `src/registry/readObservedFile.ts`): every reader failure it
observes — ENOENT, `SyntaxError` (parse, with bounded retry), or any other error — is caught
internally and resolved to a `FileObservation` (absent / unreadable-parse / unreadable-io
respectively). It never rethrows. So each element of the `Promise.all` array always resolves;
none can reject and short-circuit the others. This was verified, not assumed — see the four
`readObservedFile.test.ts` cases and the trace above.

## Test requirements — mapped to `tests/registry/observeRun.test.ts`

1. Fully populated run → all three files, every field `present`. ✅
2. Only `loop-state.json` present → that file's fields `present`; `owner-record.json` and
   `owner-transfer.json` still appear in `files`, in `OBSERVED_FILES` order, all fields `absent`. ✅
3. `observedAt` asserted as the exact string from the injected `now()` (`"2026-07-28T00:00:00.000Z"`),
   not a range. ✅
4. One reader throws an unexpected error kind (`TypeError`, not ENOENT/`SyntaxError`) — asserted
   that file's fields become `unreadable/io` while the other two files still resolve `present`
   (i.e., the failure does not stop the other two from being observed). ✅

Followed the brief's method: wrote the tests first, confirmed they failed for the right reason
(`observeRun.js` did not exist — `Failed to load url ../../src/registry/observeRun.js`), then
implemented, then re-ran green.

## Verification

- `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/registry/observeRun.test.ts` →
  4 passed, 0 failed.
- `ECC_GATEGUARD=off DISABLE_OMC=1 npm test` (full suite) → 26 files, 396 tests, all passed.
  No regressions in unrelated suites (lease lifecycle, runLoop, subprocess adapter, evidence, etc.).
- `npm run typecheck` → clean, no errors.

## Spec vs. brief discrepancy check

Read spec §6 (Observation Record Shape) in full. §6 states each row carries `path` and
`observedAt` plus per-file observations, and "a row is never omitted" — consistent with the
brief. §6 does not itself mention a `kind` discriminator field on the row. This is not a
contradiction: nothing in §6 forbids an additional tag, and later sections (§12 test
requirements 7–8) describe other row kinds a directory scan can produce — a truncation row
and a failure row for an unreadable directory — which only make sense as siblings of a `"run"`
kind in a future discriminated union that Task 4/5 will build. I read `kind: "run"` as
forward-compatible scaffolding for that union, not a derived/meaningful field (it carries no
eligibility, freshness, or resumability meaning — it only tags "this is a normally-recognized
run row" vs. some other future row shape). No discrepancy worth blocking on; flagging it here
per the brief's instruction to report rather than silently pick, since it was the one place the
brief added information not textually present in §6.

## Constraints honored

- Zero writes: no filesystem I/O added; `observeRun` only calls the injected `readObservedFile`,
  which itself only calls the injected readers.
- `readOwnerRecord` (fileStore.ts:566) and `checkRunLease` (leaseGate.ts:16): neither imported,
  called, or bound anywhere in this file.
- Only files touched: `src/registry/observeRun.ts` (new), `tests/registry/observeRun.test.ts` (new).
- ESM import specifiers all end in `.js`.

## Concerns

None blocking. The one soft note is the `kind: "run"` discrepancy above — surfaced for
visibility in case a later task's plan disagrees with this reading.
