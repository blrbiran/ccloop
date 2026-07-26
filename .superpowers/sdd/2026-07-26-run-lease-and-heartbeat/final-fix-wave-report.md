# L1 run lease + heartbeat — final whole-branch fix wave

Worktree: `.claude/worktrees/l1-run-lease-heartbeat`. Branch head before this wave: `ffecc79`.

All six findings were addressed. Nothing was found to be wrong or harmful; one finding (FIX 3)
turned out to have a crash hazard hiding behind the suggested detail string, which is handled and
covered.

## Commits

| SHA | Subject |
| --- | --- |
| `c3ca149` | fix: name the expiry instant in the lease_expired_observed detail (FIX 3) |
| `f90a819` | fix: stop reading this process's own owner transfer as a takeover (FIX 1, 2, 4, 5) |
| `3958dda` | test: fence the lease guards on the success path against deletion (FIX 6) |

Nothing pushed.

Commit granularity: FIX 1/2/4 all touch `src/controller/leaseHeartbeat.ts` or
`tests/controller/leaseHeartbeat.test.ts`, and FIX 1's interface change requires the same test
file FIX 5 rewrites (`leaseLifecycle.integration.test.ts`) to gain `adopt` on its two hand-written
`LeaseHeartbeat` literals or the tree does not typecheck. Splitting them further would have meant
committing a tree that fails `npm run typecheck`, so they share one commit whose message separates
the four.

## Final verification

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
 Test Files  23 passed (23)
      Tests  356 passed (356)
   Duration  16.08s

$ npm run typecheck      # clean, no output
$ npm run build          # clean
```

356 = 347 baseline + 1 (FIX 2) + 1 (FIX 3) + 7 (FIX 6).

---

## FIX 1 — a self-performed owner-epoch transfer made this process report itself superseded

### What changed

- `src/controller/leaseHeartbeat.ts`: `LeaseHeartbeat` gains `adopt(record: OwnerRecord): void`,
  implemented as the same closure-state replacement a successful affirm performs
  (`expected = record`), so the next affirm's CAS compares against what is on disk.
- `src/controller/runLoop.ts`: `persistBoundaryAnalysis` takes the heartbeat handle (third
  parameter, before the optional `executionRecovery`); both call sites pass it. Immediately after
  `persistOwnerTransfer` resolves, `heartbeat.adopt(transfer.ownerRecord)`.
- `INERT_LEASE_HEARTBEAT` in `runLoopFromState` gains `adopt: () => {}`; so do the two
  hand-written `LeaseHeartbeat` literals in `tests/controller/leaseLifecycle.integration.test.ts`.

### What happens if `adopt` is called after `superseded` is set

It is dropped — `adopt` returns early and `expected` is left naming the record this process was
superseded from. This is the safe direction, and the unsafe one is not hypothetical: `superseded`
does **not** gate `assertHeld`; `assertHeld` refuses purely by comparing `expected` against the
persisted record. So replacing `expected` with a record that matches disk would make
`namesSomeoneElse` answer `false` again and every later guard would pass — resurrecting a run that
had already concluded it lost the lease. Dropping the adopt keeps that refusal permanent.

It should also be unreachable in practice: a superseded process's `persistOwnerTransfer` CAS
cannot match the new owner's record, so it throws `OwnerTransferPreconditionError` and the adopt
call is never reached. The guard is defence for the case where that reasoning stops holding.

### Why this cannot remove a real refusal

`adopt` is called on exactly one line, on the success path of a CAS
(`writeOwnerTransferArtifacts`) that only succeeds if the persisted record still equals the record
this process expected. A foreign transfer fails that CAS, takes the `OwnerTransferPreconditionError`
branch, and never reaches the adopt. Two of the four reconciliation tests (the mocked
`pid:other-controller` ones) are exactly that case and still assert their `lease_lost` event, its
differing expected/observed sides, and their retained `attempt-1` worktree.

### The four reconciliation tests in `tests/controller/runLoop.integration.test.ts`

Behaviour actually changed in **two** of the four — the two where this process transfers the epoch
to itself. The other two transfer to `pid:other-controller` through a `readOwnerRecord` mock, so
their CAS fails, no adopt happens, and their assertions were already asserting correct behaviour.
This is stated plainly rather than forced into a uniform "all four changed".

1. **"writes an OWNER_LOST reconciliation record with transferred ownership when persisted owner
   truth no longer supports ownership and continuity evidence does not rescue it"** (self-transfer)
   — was: `readEventTypes` contains `lease_lost`, `worktrees` = `["attempt-1"]`.
   Now asserts: `readEventTypes` does **not** contain `lease_lost`, and `worktrees` = `[]` (the
   post-terminal cleanup ran, so no `git worktree` is leaked).
2. **"persists owner transfer artifacts and continuation eligibility after a controller-owned
   OWNER_LOST takeover-allowed verdict without resuming execution"** (self-transfer) — was: the
   exact event list ending in `lease_lost`, `worktrees` = `["attempt-1"]`, and a `lease_lost`
   detail with identical expected/observed IDs.
   Now asserts: the exact event list `["loop_planning", "attempt_started", "execute_started",
   "owner_epoch_transferred", "loop_exhausted"]`, `worktrees` = `[]`, and
   `readEventDetails(runDir, "lease_lost")` = `[]` — stated separately because "no event may claim
   this process was superseded by itself" is the specific defect.
3. **"preserves the winner reconciliation view when another controller already completed the
   transfer"** (foreign transfer) — assertions unchanged and still passing: `lease_lost` present,
   detail `expected <self> at epoch 1, observed pid:other-controller at epoch 2`, worktree
   retained. Comment extended to record *why* it is unchanged: the CAS fails, so `adopt` is never
   reached — this test is what pins the "cannot remove a real refusal" side of the fix.
4. **"preserves a synthesized winner reconciliation view when another controller already completed
   the transfer before success reconciliation was written"** (foreign transfer) — same as 3;
   assertions unchanged, comment extended the same way.

### Mutation evidence

Removing the single line `heartbeat.adopt(transfer.ownerRecord);` from `src/controller/runLoop.ts`:

```
$ npx vitest run tests/controller/runLoop.integration.test.ts
   × runLoop > writes an OWNER_LOST reconciliation record with transferred ownership when persisted owner truth no longer supports ownership and continuity evidence does not rescue it
   × runLoop > persists owner transfer artifacts and continuation eligibility after a controller-owned OWNER_LOST takeover-allowed verdict without resuming execution
      Tests  2 failed | 44 passed (46)
```

with, for the second:

```
- Expected
+ Received
  Array [
    "loop_planning", "attempt_started", "execute_started",
    "owner_epoch_transferred", "loop_exhausted",
+   "lease_lost",
  ]
```

Line restored; the same file then runs 46/46.

---

## FIX 2 — `runAffirm` concluded supersession from an unvalidated record

`src/controller/leaseHeartbeat.ts`: the re-read after a failed CAS is now
`parseOwnerRecordForLease(await readOwnerRecordWithoutRecovery(...))`. A parse failure falls into
the existing `catch` and is treated as transient — the same classification `assertHeld` applies,
because it is the same one criterion.

New test (`tests/controller/leaseHeartbeat.test.ts`, `startLeaseHeartbeat` block): **"treats a
structurally invalid record as transient rather than concluding supersession"**. It writes
well-formed JSON of the wrong shape (`{ "currentOwnerEpoch": 2 }`), awaits `affirmNow()`, and
asserts no `onLeaseLost` signal and no `lease_lost` event — then restores a valid record and
asserts the next affirm succeeds, which an implementation that had concluded supersession (and so
returns early from `runAffirm` forever) could not do.

### Mutation evidence — test fails before the parse is added

Reverting line 164 to the bare `persisted = await readOwnerRecordWithoutRecovery(options.runDir);`:

```
 FAIL  tests/controller/leaseHeartbeat.test.ts > startLeaseHeartbeat > treats a structurally invalid record as transient rather than concluding supersession
AssertionError: expected [ …(1) ] to have a length of +0 but got 1
 ❯ tests/controller/leaseHeartbeat.test.ts:243:18
    243|     expect(lost).toHaveLength(0);
      Tests  1 failed | 13 passed (14)
```

Restored: 14/14 pass.

---

## FIX 3 — the `lease_expired_observed` detail named the wrong instant

`src/controller/leaseGate.ts` now writes
`lease held by <id> expired at <affirmation + LEASE_TTL_MS> (last affirmed <affirmation>)`.

**One thing the suggested string would have broken.** `isLeaseFresh` also answers "not fresh" for a
structurally *valid* but unparseable timestamp (any string passes `parseOwnerRecordForLease`), so
that record reaches this branch. `new Date(Date.parse("not-a-timestamp") + LEASE_TTL_MS)
.toISOString()` throws `RangeError`, which would have propagated out of `checkRunLease` — turning
an observation the gate is contractually required to pass through into a crash that refuses the
run. The expiry instant is therefore computed only when the affirmation parses; otherwise the
detail says `expired at an unparseable instant`.

Tests in `tests/controller/leaseGate.test.ts`:

- the existing "takes no position on an expired lease and records the observation" now also
  asserts the full detail string (written to fail against `expired at ${leaseAffirmedAt}`);
- new: "still passes control on, naming no expiry instant, when leaseAffirmedAt is unparseable".

```
$ npx vitest run tests/controller/leaseGate.test.ts tests/controller/leaseHeartbeat.test.ts
 Test Files  2 passed (2)   Tests  26 passed
```

---

## FIX 4 — leaked fake timers in the `assertHeld` describe block

Added `beforeEach(() => { vi.useRealTimers(); })` to `describe("assertHeld")`.

**`beforeEach` rather than `afterEach`**, deliberately: `afterEach` only cleans up after a leak
originating *inside this block*, while `beforeEach` also covers a fake clock leaked from anywhere
earlier in the file. Both would have handled the specific test named in the finding; the
`beforeEach` handles the general case, and it costs the same.

### Mutation evidence

Injected a `throw` into the first `assertHeld` test just before its own `vi.useRealTimers()`.

Without the `beforeEach` (i.e. the pre-fix file):

```
   × assertHeld > is never throttled: ... 5ms
   × assertHeld > rejects as unverifiable — not as lost — when the record cannot be read 5002ms
     → Test timed out in 5000ms.
   × assertHeld > rejects as unverifiable when the record is structurally invalid 5001ms
     → Test timed out in 5000ms.
      Tests  3 failed | 11 passed (14)
```

With the `beforeEach` in place, same injected throw:

```
   × assertHeld > is never throttled: ... 5ms
      Tests  1 failed | 13 passed (14)
```

One real failure instead of one failure plus two 5-second hangs. Injected throw removed; 14/14.

---

## FIX 5 — the "releases the lease when the loop throws" test now exercises a throw

A real throw path out of `runLoop` does exist, and it is not the adapter: `runLoopFromState`'s
`catch` converts every adapter failure into a terminal state and returns. The throw has to come
from the loop's own bookkeeping *outside* that catch — a `writeRunState` rejection. The first
`writeRunState` succeeds (the lease is affirmed immediately after it, which is what makes the
release observable); a later one rejects inside the `try`, and the `catch`'s own `writeRunState`
rejects too, leaving no handler between it and the caller.

The test (`tests/controller/leaseLifecycle.integration.test.ts`) now `vi.doMock`s
`src/persistence/fileStore.js` to fail `writeRunState` after the first call, asserts
`rejects.toThrow("loop-state.json write failed")` — the premise of the test, previously untested —
and then asserts `leaseAffirmedAt === null` with the last affirmation still inside the TTL.

No production hook was added; the mock is the same `vi.doMock` pattern the existing integration
tests use. No paid Claude calls (`ScriptedAdapter`).

### Evidence the assertion is not vacuous

With `releaseOwnerLease` removed from `stop()`:

```
 FAIL  ... > releases the lease when the loop throws
- Expected: null
+ Received: "2026-07-26T15:03:12.348Z"
 ❯ tests/controller/leaseLifecycle.integration.test.ts:177:37
```

So the lease *was* held at the moment of the throw, and `stop()`'s release is what clears it.
Restored: 9/9 in that file at the time, 16/16 now.

### For the humans — a document correction, not a code one

The plan's coverage appendix
(`docs/superpowers/plans/2026-07-26-run-lease-and-heartbeat.md`) claimed requirement 17's
"and separately after it throws" was discharged by the old test. It was not: that test's
`.catch(() => {})` was dead code and its adapter took the same path as the preceding test. It is
discharged **now**, by the rewritten test — but the appendix overstated the position for as long
as the old test stood, and the humans may want to note that in the document's history. No document
was edited (the spec is frozen and the plan is theirs).

---

## FIX 6 — fencing the twelve `assertHeld` guard sites

Attempted and landed, in the shape the reviewer suggested, with one honest limitation.

`tests/controller/leaseLifecycle.integration.test.ts` gains a helper that drives
`runLoopFromState` over the success path with a `ScriptedAdapter`, an adapter wrapper that records
each phase as it is entered, and an injected `LeaseHeartbeat` whose `assertHeld` throws
`RunLeaseLostError` on its *n*-th call. The success path passes exactly six guards:

| n | guard site | phases that have run |
| --- | --- | --- |
| 1 | attempt worktree creation | — |
| 2 | **plan Claude call** | — |
| 3 | execute Claude call | plan |
| 4 | **verify Claude call** | plan, execute |
| 5 | attempt artifact write | plan, execute, verify |
| 6 | post-terminal worktree cleanup | plan, execute, verify |

Each `it.each` case asserts the exact phase list, the resulting status/stop reason (`cancelled` +
`lease_lost` for 1–5; `succeeded` for 6, where a terminal decision is already persisted and stands),
that the attempt worktree survives whenever one was created, and that the attempt artifacts exist
only in the case where the write itself was not the refused effect. A final test refuses at no
guard and pins the count at six.

That count assertion is what makes deletion impossible to hide: a shifted numbering can satisfy
individual cases, but there is no numbering in which five guards are six.

### Mutation evidence

Deleting the plan-phase `await heartbeat.assertHeld();`:

```
   × runs no further phase once the guard before the 'plan Claude call' refuses
   × runs no further phase once the guard before the 'execute Claude call' refuses
   × runs no further phase once the guard before the 'verify Claude call' refuses
   × runs no further phase once the guard before the 'attempt artifact write' refuses
   × runs no further phase once the guard before the 'post-terminal worktree cleanup' refuses
   × passes exactly six guards, and completes, when none of them refuses
      Tests  6 failed | 10 passed (16)
```

Deleting the verify-phase `await heartbeat.assertHeld();`:

```
   × runs no further phase once the guard before the 'verify Claude call' refuses
   × runs no further phase once the guard before the 'attempt artifact write' refuses
   × runs no further phase once the guard before the 'post-terminal worktree cleanup' refuses
   × passes exactly six guards, and completes, when none of them refuses
      Tests  4 failed | 12 passed (16)
```

Both restored; 16/16.

### Limitation, stated rather than glossed

This fences **six** of the twelve sites — the six on the success path. The other six are on the
plan/execute/verify timeout paths, the partial-execution path and the retry-cleanup path, which
this scenario never enters. Reaching them would need a differently-shaped scenario per path, which
is a much larger test surface than "one test for the cost of one". The two sites the finding named
as unfenced (the plan-phase and verify-phase Claude calls — the money-spending ones) are both
inside the six.

---

## Deliberately not done

- **The spec was not edited.** Several of these findings have their root cause in it (notably
  FIX 1's "the only legal way for the owner record to change under a running owner is a formal
  reconciliation transfer, which supersedes that owner" — which does not model a running owner
  transferring to itself). Those are the humans' spec amendments.
- **The plan document was not edited**, including its coverage appendix (see FIX 5 above).
- **The two deferred follow-ups were not touched**: the lock-busy vs CAS-mismatch error
  conflation in `fileStore.ts`, and guarding `persistBoundaryAnalysis` itself. FIX 1 threads the
  heartbeat *into* `persistBoundaryAnalysis` but guards nothing with it — the parameter is used on
  exactly one line, to adopt a record that function itself wrote, and the code comment says so.
- **`fileStore.ts`'s owner-transfer lock format (`pid:<pid>`) and `parsePid`** are untouched.
- **No already-persisted terminal state is rewritten** anywhere; the post-terminal escape in
  `runLoopFromState` is unchanged, and FIX 6's case 6 asserts it still holds.
- **`adopt` does not reset the affirm throttle.** After a self-transfer the record is on disk with
  `leaseAffirmedAt: null` (that is what `applyOwnerEpochTransfer` writes), so the lease is
  re-established by the next un-throttled affirm — at most `LEASE_AFFIRM_THROTTLE_MS` (10s) later,
  against a 90s TTL. Resetting the throttle would have been extra behaviour beyond the finding.
- **No `.wolf/` bookkeeping files were updated.** This is a fix-wave branch under review; adding
  churn there risks conflicts with other worktrees, and nothing in the fix wave changed the file
  inventory. Flagged here rather than done silently.
