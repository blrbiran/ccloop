# Task 2 report: bounded retry for a contended transfer — and only for that

## What changed and why

`persistOwnerTransfer` (`src/controller/runLoop.ts`) previously called
`writeOwnerTransferArtifacts` once; a busy owner-transfer lock (`OwnerTransferLockBusyError`,
Task 1) fell straight into the caller's catch and abandoned the transfer on the very first
contention. That is the defect this task exists to fix: the lock is typically busy for "a
handful of file writes," not a long time, so a legitimate transfer was being dropped for
transient contention indistinguishable (to the caller) from a real takeover.

### `src/controller/runLoop.ts`

**Two new module-level constants**, exported, placed beside `BUDGET_EXHAUSTED_REASON` at `:76`
and named for the lock (per the brief), not the loop:

```ts
export const OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS = 3;
export const OWNER_TRANSFER_LOCK_RETRY_DELAY_MS = 50;
```

**`persistOwnerTransfer`** now wraps only the `writeOwnerTransferArtifacts` call in a bounded
retry loop:

```ts
for (let attempt = 0; attempt < OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS; attempt += 1) {
  if (attempt > 0) {
    await delay(OWNER_TRANSFER_LOCK_RETRY_DELAY_MS);
  }
  try {
    await writeOwnerTransferArtifacts(runDir, expectedOwnerRecord, transfer.nextOwnerRecord, transfer.transferRecord);
    break;
  } catch (error) {
    const isLastAttempt = attempt === OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS - 1;
    if (!(error instanceof OwnerTransferLockBusyError) || isLastAttempt) {
      throw error;
    }
  }
}
```

`appendEvent({ type: "owner_epoch_transferred", ... })` stays **outside and after** this loop,
reached only once the loop has `break`-ed on success — never inside it — so a retry that
eventually succeeds cannot double-emit that event. This mirrors the brief's instruction exactly:
retry `writeOwnerTransferArtifacts` (`:608`, now inside the loop), not `appendEvent`.

The `instanceof OwnerTransferLockBusyError` check is the whole safety property: any other error
— in particular `OwnerTransferPreconditionError` (CAS mismatch) — is rethrown on the very first
attempt, never retried. This is deliberate per spec §5.2/§9's central constraint: retrying a CAS
mismatch would re-run the CAS against a freshly read record, which is a new ownership decision
wearing an old decision's justification, not a retry of the same decision.

The local `delay()` helper is a plain `new Promise(resolve => setTimeout(resolve, ms))`, matching
the shape already used by `leaseHeartbeat.ts`'s own `delay` for `assertHeld`'s read-retry loop
(same file, same pattern: `for` loop, `attempt > 0` gate before the delay, bounded by a module
constant).

On exhaustion (`isLastAttempt` true and the error is still `OwnerTransferLockBusyError`), the
function rethrows `OwnerTransferLockBusyError`, which is exactly what the caller's existing catch
branch in `persistBoundaryAnalysis` (Task 1) already expects — it appends `owner_transfer_contended`
and re-reads/re-evaluates. I updated the stale comment there (`"Task 2 adds retry here"`) to
describe what now actually happens, since it would otherwise read as a lie about the code beneath
it. No other change was made to that branch — it still appends the event exactly once, regardless
of how many internal attempts `persistOwnerTransfer` made.

### `leaseHeartbeat.ts`

No change, as the brief anticipated — nothing in this task touches it.

## Retry-budget arithmetic

- `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS = 3`, `OWNER_TRANSFER_LOCK_RETRY_DELAY_MS = 50`.
- Total worst-case wait: 2 delays (before attempts 2 and 3) × 50ms = **100ms** ≤ the brief's
  150ms budget.
- `LEASE_TTL_MS = 90_000` (`src/ownership/lease.ts:5`). 100ms / 90,000ms ≈ **0.11%** of the TTL —
  comfortably under the stated 0.2% ceiling.
- This window will run inside the exclusive span added in a later task (holding off this
  process's own heartbeat affirms for its duration), so the bound has to stay small regardless of
  how busy a contender's own critical section is. A contender's critical section is a handful of
  synchronous file writes (`writeOwnerTransferArtifacts`: two `writeJsonFile` + one rename +
  cleanup, all inside one lock hold), so 3 attempts at 50ms apart is generous relative to how long
  a legitimate holder needs, while staying negligible relative to the 90s TTL. I did not choose
  differently from the brief's suggested numbers — they already satisfy both constraints with
  margin.

## Tests, each with mutation evidence

All three added to `tests/controller/leaseLifecycle.integration.test.ts`, immediately after the
existing Task 1 contention test (`"appends owner_transfer_contended and abandons the transfer
when the owner-transfer lock stays busy"`), which is untouched. Each new test mocks
`fileStore.writeOwnerTransferArtifacts` via `vi.doMock` (the same technique the file's own
`"releases the lease when the loop throws"` test already uses for `writeRunState`) so that "the
lock becomes free" is gated on a call count rather than a real unlock racing the real ~50ms
backoff — deterministic per the brief's instruction, not a timer race.

### 1. `"retries a busy owner-transfer lock and completes once it clears (spec requirement 1)"`

Mock: call 1 throws `OwnerTransferLockBusyError`; call 2+ delegates to the real
`writeOwnerTransferArtifacts`. Asserts `writeCalls === 2`, `owner.currentOwnerEpoch === 2`,
`reconciliation.newOwnerEpoch === 2`, `eligibleForContinuation === true`, exactly one
`owner_epoch_transferred` event, and no `owner_transfer_contended` event.

- **Mutation: remove the retry** (loop bound forced to `1`). Result: `AssertionError: expected 1
  to be 2` at the `writeCalls` assertion — the transfer is abandoned on the first busy call
  exactly as it was before this task. Restored.

### 2. `"abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2)"`

Mock: every call throws `OwnerTransferLockBusyError` (lock never clears). Asserts `writeCalls ===
OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` (the bound was reached, not skipped and not unbounded),
`owner.currentOwnerEpoch === 1` (untransferred), `reconciliation.newOwnerEpoch === null`,
`eligibleForContinuation === false`, exactly one `owner_transfer_contended` event, and no
`owner_epoch_transferred` event.

- **Mutation: raise the attempt bound to `Infinity`.** Result: the test **times out** (`Error:
  Test timed out in 5000ms`) rather than passing or failing cleanly — a runaway retry against a
  lock that never clears never reaches the abandonment path at all, which is worse than a clean
  failure: it turns a bounded, evidenced abandonment into a hang. Restored to `3`.

### 3. `"retries zero times on a CAS mismatch (spec requirement 3)"`

Mock: every call throws `OwnerTransferPreconditionError` (CAS mismatch, not lock busy). Asserts
`writeCalls === 1` — the decisive assertion the brief calls for, since an implementation that
retried the mismatch and still failed every time would produce the *same outcome* (abandoned,
`newOwnerEpoch: null`) as one that never retried; only the call count tells them apart. Also
asserts the existing re-read/re-evaluate shape is unchanged: no `owner_transfer_contended` event
(this was never lock contention) and no `owner_epoch_transferred` event.

- **Mutation: delete the `instanceof OwnerTransferLockBusyError` check**, retrying every error
  including CAS mismatches. Result: `AssertionError: expected 3 to be 1` — the CAS mismatch was
  retried up to the bound instead of failing immediately, which is precisely the authority
  violation the plan calls out as the one thing this task must never do. Restored.

## Test/typecheck/build output

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
 Test Files  23 passed (23)
      Tests  363 passed (363)
```

360 baseline + 3 new = 363, all green, none skipped or weakened.

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.json
(clean, no output)

$ npm run build
> tsc -p tsconfig.json && ...
(clean, no output)
```

## Deliberately not done

- **No change to `leaseHeartbeat.ts`** — confirmed unnecessary, as the brief stated.
- **No retry around `appendEvent`** — it stays outside the loop, reached exactly once, only on
  success.
- **No retry of `OwnerTransferPreconditionError`** — the one thing the plan forbids; verified by
  mutation-testing that its removal is caught.
- **No change to the `ReconciliationRecord` schema** — untouched; the record still reports
  `newOwnerEpoch: null` on abandonment, with the event stream carrying the reason, per §5.3
  (already in place from Task 1).
- **No change to the existing Task 1 contention test** — it still exercises a *real* lock file
  held by a live pid for the whole run (never released), so with the retry now in place it simply
  takes ~100ms longer before reaching the same abandonment outcome it always asserted. Left
  untouched per "do not weaken or delete any existing test"; its behavior after this change was
  verified by running it (it remains green).
- **Did not attempt to synchronize retry attempts against wall-clock/fake timers** for test 1's
  "lock clears between attempts" scenario — used a call-count gate on the mocked write function
  instead, which the brief explicitly permits ("deterministically, not by racing a real timer")
  and which is simpler and already precedented in this test file.
