# Task 1 report: split the error class and re-decide all four consumers

## What changed and why

The owner-transfer lock and the owner-record CAS used to throw the same class,
`OwnerTransferPreconditionError`, for two semantically different failures: "another writer
holds the lock" and "the persisted record moved on since I read it." Every consumer's
`instanceof OwnerTransferPreconditionError` check therefore treated lock contention as though
it were a stale CAS base — silently dropping a legitimate owner transfer whenever the lock was
merely busy.

### `src/persistence/fileStore.ts`

Added `OwnerTransferLockBusyError extends Error` (near `OwnerTransferPreconditionError` at
`:387`), a **sibling**, not a subclass — extending `Error` directly and setting `this.name` the
same way the existing class does. Changed both throw sites inside `acquireOwnerTransferLock`
(the "not recoverable as stale, still held by a live pid" branch and the "loop exhausted its two
attempts" fallback) from `OwnerTransferPreconditionError` to `OwnerTransferLockBusyError`. No
other throw site in the file changed: `writeOwnerTransferArtifacts`'s own CAS check and
`updateOwnerRecordWithPrecondition`'s CAS check still throw `OwnerTransferPreconditionError`,
because those really are CAS mismatches.

Sibling rather than subclass is deliberate and load-bearing: a subclass would let every existing
`instanceof OwnerTransferPreconditionError` branch keep matching, so no consumer's behaviour
would actually change and the defect this task exists to fix would silently persist.

### `src/controller/runLoop.ts` (`persistBoundaryAnalysis`, the `try`/`catch` around
`persistOwnerTransfer`)

The catch block gained an explicit branch for `OwnerTransferLockBusyError`: append an
`owner_transfer_contended` event (detail: `"owner transfer abandoned: owner-transfer lock
busy"`), then fall through into the same re-read/re-evaluate that the CAS-mismatch branch
already does. `nextOwnerRecord`/`nextOwnerEpoch`/`eligibleForContinuation` are never touched in
this branch, so the reconciliation record still reports `newOwnerEpoch: null` — the event is the
only new evidence, per spec §5.3 (the `ReconciliationRecord` schema is frozen). Anything that is
neither `OwnerTransferLockBusyError` nor `OwnerTransferPreconditionError` still rethrows, exactly
as before. No retry: this is explicitly deferred to Task 2.

### `src/controller/resumeLoop.ts` (the `claimOwnerRecordWithPrecondition` catch)

The hardcoded `claim CAS failed: ${error}` detail becomes conditional: an
`OwnerTransferLockBusyError` produces `owner-transfer lock busy: ${error}` instead, so the
`resume_denied` event and the thrown `ResumeNotEligibleError` never assert a CAS failure that
never happened. Everything else — the catch-all shape, `ResumeNotEligibleError` being thrown,
resume staying fail-closed on any error — is unchanged.

### `src/controller/leaseHeartbeat.ts`

**No code change.** `runAffirm`'s existing catch —
`if (!(error instanceof OwnerTransferPreconditionError)) { return; }` — already swallows and
retries any error that is not `OwnerTransferPreconditionError`. Since
`OwnerTransferLockBusyError` is a sibling, not a subclass, it was never `instanceof
OwnerTransferPreconditionError` even before this task's source changes; the class split alone is
what makes this branch correct, by construction, for the first time. `stop()`'s bare `catch {}`
at `:209` was also left untouched, per the brief.

## Tests, one per requirement, each with mutation evidence

### 1. `tests/persistence/fileStore.test.ts` — siblinghood (spec §3, requirement 1)

- Updated two **existing** tests whose scenario actually exercises the busy-lock path inside
  `acquireOwnerTransferLock` (a live-pid holder, and a malformed lock with no staged artifacts)
  to expect `OwnerTransferLockBusyError` instead of `OwnerTransferPreconditionError`. These were
  not weakened — the scenario and its meaning (reject the transfer) are unchanged; only the
  now-correct expected class changed, because the old assertion encoded the very bug this task
  fixes.
- Added: **"throws OwnerTransferLockBusyError for a busy lock and OwnerTransferPreconditionError
  for a CAS mismatch, and neither is an instance of the other."** Two halves in one test: a
  live-pid-held lock (busy) vs. no lock but a moved-on record (CAS mismatch), asserting
  `toBeInstanceOf` **and** `not.toBeInstanceOf` in both directions.
  - **Mutation applied:** `export class OwnerTransferLockBusyError extends Error` →
    `extends OwnerTransferPreconditionError`.
  - **Observed failure:** `expected OwnerTransferLockBusyError: owner transfe… to not be an
    instance of OwnerTransferPreconditionError` at the `expect(lockBusyError).not.toBeInstanceOf
    (OwnerTransferPreconditionError)` line. Reverted; full file re-run green (37/37).

### 2. `tests/controller/leaseHeartbeat.test.ts` — requirement 9

Added: **"treats a busy owner-transfer lock as transient: no lease_lost, no supersession
concluded, retried next tick."** Fabricates `.owner-transfer.lock` with a live pid (this test
process), calls `affirmNow()`, asserts no `lease_lost` event, `onLeaseLost` never fired, and
`leaseAffirmedAt` stays exactly what `seed()` wrote (proving the lock acquisition failed before
any read/write of `owner-record.json`, not merely that nothing bad happened). Then frees the lock
and asserts the **next** tick affirms normally (`leaseAffirmedAt` becomes non-null) — proving this
was a retry, not a permanent refusal.

- **Mutation applied:** in `runAffirm`'s catch, before the existing
  `!(error instanceof OwnerTransferPreconditionError)` check, inserted a branch that treats
  `OwnerTransferLockBusyError` as sufficient evidence of supersession by itself:
  `if (error.name === "OwnerTransferLockBusyError") { await concludeLeaseLost(expected); return; }`
  — the literal "route lock contention into the supersession decision" bug the design names.
- **Observed failure:** `expected [ …(1) ] to have a length of +0 but got 1` at
  `expect(lost).toHaveLength(0)` — `onLeaseLost` fired on a merely-busy lock. Reverted; full file
  re-run green (15/15).

Note on why the mutation had to be this specific shape: with an *unchanged* persisted record, a
milder mutation that only widens which errors reach the existing
read-persisted/compare/conclude path would still find `namesSomeoneElse` false and return
harmlessly — it would not fail this test. The design's own framing ("routes lock contention into
the supersession decision") is best represented as treating lock-busy as supersession *by
itself*, which is also the more realistic mistake an implementer would make (reasoning "if I
can't get the lock, someone else must already own this").

### 3. `tests/controller/resumeLoop.integration.test.ts` — requirement 8

Added: **"stays fail-closed when the claim hits a busy owner-transfer lock, without claiming a
CAS failure."** Fabricates the busy lock the same way, calls `resumeLoop`, asserts
`ResumeNotEligibleError`, the owner record is untouched, exactly one `resume_denied` event is
appended, and its `detail` does **not** contain `"claim CAS failed"` but does contain
`"lock busy"`.

- **Mutation applied:** reverted the conditional detail back to the hardcoded
  `` `claim CAS failed: ${String(error)}` `` unconditionally.
- **Observed failure:** `expected 'claim CAS failed: OwnerTransferLockBu…' not to contain 'claim
  CAS failed'` at the `not.toContain` assertion. Reverted; full file re-run green (11/11).

### 4. `tests/controller/leaseLifecycle.integration.test.ts` — requirement 2 (partial: event only)

Added: **"appends owner_transfer_contended and abandons the transfer when the owner-transfer
lock stays busy."** Modelled directly on
`tests/controller/runLoop.integration.test.ts`'s existing "persists owner transfer artifacts and
continuation eligibility after a controller-owned OWNER_LOST takeover-allowed verdict..." test
(same boundary/ownership setup reaching `persistBoundaryAnalysis`'s `stale_candidate` +
`OWNER_LOST` + takeover-allowed branch, via `runLoop.ts:961`'s execute-timeout path), with one
addition: the `execute()` adapter also writes a live-pid-held `.owner-transfer.lock` right before
returning, so the CAS this attempt would perform never gets past lock acquisition. Asserts: the
owner record still names the *original* (lost) owner (transfer never landed), the reconciliation
record's `newOwnerEpoch` is `null` and `eligibleForContinuation` is `false`, `owner-transfer.json`
was never staged, the event stream contains `owner_transfer_contended`, and does **not** contain
`owner_epoch_transferred`.

- **Mutation applied:** in `runLoop.ts`'s new `OwnerTransferLockBusyError` branch, deleted the
  `appendEvent(...)` call (left the branch present but empty, still falling through to
  re-read/re-evaluate — isolating the mutation to exactly "no event," not "no branch at all").
- **Observed failure:** `expected [ …(4) ] to deep equally contain ObjectContaining{…}` — the
  4-event stream (`loop_planning`, `attempt_started`, `execute_started`, `loop_exhausted`) had no
  `owner_transfer_contended` event. Reverted; full file re-run green (17/17).

## Test / typecheck / build output (after all mutations reverted)

```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
 Test Files  23 passed (23)
      Tests  360 passed (360)
```

Baseline was 356; this task added 4 new tests (360 − 356 = 4), matching one new test per
requirement (1, 8, 9, and 2-partial). No existing test was deleted; two existing
`fileStore.test.ts` tests had only their expected error class corrected (see above), not their
scenario or intent.

```
npm run typecheck   →  tsc --noEmit -p tsconfig.json   (clean, no output)
npm run build       →  tsc -p tsconfig.json && ...      (clean, no output)
```

## Deliberately not done (out of scope for this task)

- **No retry.** A busy lock in `runLoop.ts`'s `persistBoundaryAnalysis` still abandons the
  transfer on the first failure — Task 2 adds bounded retry inside the exclusive span.
- **No `LeaseHeartbeat.runExclusive` / queue serialization.** Task 4's job (§4 of the design).
  This task's tests fabricate contention with a directly-written lock file rather than a real
  concurrent heartbeat, exactly as the brief anticipates ("no existing test contends the lock
  through runLoop").
- **`leaseHeartbeat.ts:208`'s bare `catch {}` in `stop()`** — untouched, per explicit
  instruction. It has no use for the new discrimination (a best-effort release either way).
- **No `ReconciliationRecord` schema change.** The abandoned-transfer shape
  (`newOwnerEpoch: null`, `eligibleForContinuation: false`) is identical to today's; the event
  stream carries the new evidence.
- **No terminal-state / exit-code changes.** Both call sites of `persistBoundaryAnalysis`
  precede terminal persistence; nothing here touches it.
- **No changes to `writeOwnerTransferArtifacts`'s or `updateOwnerRecordWithPrecondition`'s own
  CAS-mismatch throw sites** — those remain `OwnerTransferPreconditionError`, correctly, since
  they really are CAS mismatches, not lock contention.

## Commits

Implementation (source + tests) landed in one commit, matching this repo's convention of
committing tests together with the code they verify; this report followed in a second commit.
See the commit list returned to the caller.
