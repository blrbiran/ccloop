# Task 6 Report: The acquisition gate

## Summary

Implemented `checkRunLease` in `src/controller/leaseGate.ts` exactly as specified in the
task brief, with the test file `tests/controller/leaseGate.test.ts` copied verbatim from
the brief. No deviations from the brief's code.

## What was implemented

`src/controller/leaseGate.ts` exports:
- `LeaseGateOutcome` — discriminated union with `no_record`, `no_lease`, `held_by_self`,
  `expired` branches.
- `checkRunLease(runDir, selfProcessInstanceId, nowMs?)` — the five-branch gate:
  1. Read raw owner record via `readOwnerRecordWithoutRecovery` (never `readOwnerRecord`,
     which would run interrupted-transfer recovery — a write — as a side effect of a
     refusal).
  2. `ENOENT` on that read → `{ kind: "no_record" }`. Any other read error (unreadable
     file, malformed JSON) is rethrown as a refusal, never treated as absence.
  3. Validate the raw value via `parseOwnerRecordForLease` (throws on structurally invalid
     records — missing `currentProcessInstanceId`, missing/non-integer
     `currentOwnerEpoch`, or a `leaseAffirmedAt` present but neither string nor null).
  4. `leaseAffirmedAt` absent or null → `{ kind: "no_lease", ownerRecord }`, no write.
  5. Lease present but expired (`!isLeaseFresh(...)`) → append a `lease_expired_observed`
     event, then return `{ kind: "expired", ownerRecord }`. Takes no other position —
     doesn't permit, doesn't refuse.
  6. Lease present and fresh, `currentProcessInstanceId !== selfProcessInstanceId` (opaque
     string equality only) → throw `RunLeaseHeldError(holderProcessInstanceId,
     remainingTtlMs)`.
  7. Lease present, fresh, and it's this process's own → `{ kind: "held_by_self",
     ownerRecord }`.

Before committing, I verified by reading `src/ownership/lease.ts`,
`src/persistence/fileStore.ts`, and `src/runtime/types.ts` that every consumed interface
(`isLeaseFresh`, `LEASE_TTL_MS`, `parseOwnerRecordForLease`, `RunLeaseHeldError`,
`readOwnerRecordWithoutRecovery`, `appendEvent`, `OwnerRecord`) exists with exactly the
signature the brief assumes — no reimplementation, no signature drift.

## TDD evidence

**RED** — `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseGate.test.ts`
after creating the test file only (no `src/controller/leaseGate.ts` yet):

```
FAIL  tests/controller/leaseGate.test.ts [ tests/controller/leaseGate.test.ts ]
Error: Failed to load url ../../src/controller/leaseGate.js (resolved id: ../../src/controller/leaseGate.js)
Test Files  1 failed (1)
```

Expected failure: module not found, exactly as the brief predicted for Step 2.

**GREEN** — same command after writing `src/controller/leaseGate.ts`:

```
 ✓ tests/controller/leaseGate.test.ts (11 tests) 12ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

All 11 cases pass, including the two hard-to-get-right branches:
- absent/null `leaseAffirmedAt` → `no_lease`, zero events appended.
- expired lease → `expired`, exactly one `lease_expired_observed` event, no refusal.
- same-PID-earlier-start and legacy `pid:<pid>`-format holders both refuse (string
  equality only, no pid-segment parsing).
- malformed JSON / missing `currentProcessInstanceId` / non-string non-null
  `leaseAffirmedAt` all throw a non-`RunLeaseHeldError` (validation failure, distinct from
  a live-lease refusal).

## Full verification

- `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`: **21 files / 317 tests passed**
  (baseline was 20/306; this task added 1 file / 11 tests, net +11, nothing else changed
  or broken).
- `npm run typecheck`: clean, no output beyond the `tsc` invocation line.
- `npm run build`: clean.

## Files changed

- `src/controller/leaseGate.ts` (new)
- `tests/controller/leaseGate.test.ts` (new)

## Self-review

- **Completeness**: all five branches from the brief implemented; no branch omitted, no
  branch added.
- **YAGNI**: implementation is the brief's code verbatim — no extra options, no extra
  exports, no speculative generality.
- **Refusal write discipline**: traced every throwing path (`ENOENT`-not-matched rethrow,
  `parseOwnerRecordForLease` throw, `RunLeaseHeldError` throw) — none of them call
  `appendEvent` or any other write. Only the `expired` branch writes, and that's the one
  branch the brief requires to record an event.
- **Opaque identity comparison**: confirmed `currentProcessInstanceId !==
  selfProcessInstanceId` is a plain string comparison — no parsing, no pid-segment
  extraction — satisfying constraint 5 and the recycled-PID / legacy-format test cases.
- **No new authority**: the gate only ever returns a non-throwing outcome or throws
  `RunLeaseHeldError`; it introduces no new permission path (constraint 3).
- **Ordering**: `appendEvent` is only reached after a validated owner record was
  successfully read, which can only exist once `initializeRunFiles` has already created
  `events.jsonl` — so the gate never assumes the events file exists before a caller has
  created it (per the brief's ordering note). This task doesn't wire the gate into any
  caller, per scope.
- **Style**: two-space indent, double quotes, `.js` extensions on relative imports, no
  default exports — matches the rest of the codebase (spot-checked against
  `src/ownership/lease.ts` and `src/persistence/fileStore.ts`).
- Nothing found to fix.

## Concerns

None. Implementation matches the brief exactly; full suite, typecheck, and build are all
clean.

## Commit

`75b4d32` — `feat: add the run-lease acquisition gate`
