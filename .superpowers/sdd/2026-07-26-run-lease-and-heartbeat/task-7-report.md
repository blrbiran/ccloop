# Task 7 Report: Wire the lease gate into `resumeLoop`

## Status: DONE

## What was implemented

`src/controller/resumeLoop.ts`: added a call to `checkRunLease(runDir, buildProcessInstanceId())`
immediately after the `resume_requested` event and before the `Promise.all` that reads
owner-record / owner-transfer / reconciliation / run-state / contract. On any thrown error
(including `RunLeaseHeldError`, and the plain `Error` `checkRunLease` throws for a
structurally invalid record), the gate appends a `resume_denied` event with the error's
message as detail and rethrows the original error unchanged — so callers still see
`RunLeaseHeldError` via `instanceof`.

Import added: `import { checkRunLease } from "./leaseGate.js";` (alongside the
already-present `buildProcessInstanceId` import from `../runtime/processIdentity.js`).

This is exactly the code given in the brief's Step 3, verbatim.

## Tests added

Appended to `tests/controller/resumeLoop.integration.test.ts`:
- New imports: `LEASE_TTL_MS`, `RunLeaseHeldError` from `../../src/ownership/lease.js`.
- Helper `setLease(runDir, leaseAffirmedAt, holder?)`.
- Five new `it(...)` cases inside the existing `describe("resumeLoop", ...)` block, verbatim
  from the brief:
  1. `refuses a resume against a live lease and mutates nothing but events`
  2. `does not refuse a resume immediately after an owner transfer` (the §5.0 regression pin)
  3. `lets an eligible resume through an expired lease and records the observation`
  4. `refuses an ineligible resume with the eligibility reason even when the lease has expired`
  5. `refuses while a killed run's lease is still fresh and stops refusing after the TTL`

No existing helpers were duplicated; all reused as specified (`createRepo`, `createContract`,
`seedEligibleRun`, `successFrame`, `readEventTypes`).

## TDD evidence

**RED** — command: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/resumeLoop.integration.test.ts`
(run after adding the tests, before touching `resumeLoop.ts`):

```
Test Files  1 failed (1)
     Tests  4 failed | 5 passed (9)
```

4 of 5 new tests failed as expected:
- `refuses a resume against a live lease...` — resolved to `succeeded` instead of rejecting
  (no gate present yet to refuse).
- `lets an eligible resume through an expired lease...` — `lease_expired_observed` event
  absent (nothing observes lease expiry yet).
- `refuses an ineligible resume...even when the lease has expired` — same, event absent.
- `refuses while a killed run's lease is still fresh...` — resolved to `succeeded` instead
  of rejecting.

The 5th new test (`does not refuse a resume immediately after an owner transfer`) passed
even pre-wiring, correctly — there was nothing to refuse it. This is expected: it's a
non-regression pin, not a positive assertion of new behavior, so it can only ever fail once
the gate exists and is wired wrong.

This failure shape confirms the tests exercise real end-to-end refusal semantics through
`resumeLoop`, not a mock — the gate genuinely wasn't being called.

**GREEN** — after inserting the gate call (Step 3):

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/resumeLoop.integration.test.ts
 ✓ tests/controller/resumeLoop.integration.test.ts (9 tests) 1252ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

Full suite:
```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
 Test Files  21 passed (21)
      Tests  322 passed (322)
```
(baseline was 21 files / 317 tests; +5 new tests = 322, all green)

```
$ npm run typecheck   # tsc --noEmit -p tsconfig.json — clean, no output
$ npm run build       # tsc -p tsconfig.json ... — clean, no output
```

## Files changed

- `src/controller/resumeLoop.ts` (+16 lines): the gate call, exactly as specified.
- `tests/controller/resumeLoop.integration.test.ts` (+106 lines): 2 new imports, 1 helper,
  5 new tests.

## Commit

`3cd2cdd` — "feat: refuse a resume against a live run lease before any eligibility reasoning"
(2 files changed, 122 insertions(+), 0 deletions)

## Self-review

- **Completeness**: all 5 required test cases present verbatim from the brief; gate wired
  exactly at the specified location (after `resume_requested`, before the `Promise.all`).
  No steps skipped.
- **Quality/YAGNI**: diff is minimal — one new import, one try/catch block reusing the
  existing `appendEvent` pattern already used three other times in this file for
  `resume_denied`. No new abstractions, no new exports (per the brief's "Produces: no new
  export").
- **Discipline**: did not touch `leaseGate.ts`, `lease.ts`, or `processIdentity.ts` — only
  consumed their existing exports, as instructed. Did not reformat or "improve" surrounding
  code in `resumeLoop.ts` or the test file.
- **Testing — real behavior, not shape**: verified RED failures were the *right* kind of
  failure (missing refusal / missing event), not an unrelated crash, before writing the
  implementation. All assertions in the new tests go through the real `resumeLoop` function
  end-to-end against real temp directories and real owner-record files — no mocking of
  `checkRunLease` or the lease module.
- **Output pristine**: no test warnings, no console noise inspected in the run above beyond
  normal vitest reporting; build and typecheck both silent/clean.
- **Regression pin verified meaningfully**: confirmed the "does not refuse immediately after
  an owner transfer" test asserts at a lease age well inside `LEASE_TTL_MS` (a few seconds
  vs. a 90s TTL), matching the brief's stated intent — this is the one case a
  `lastAffirmedAt`-keyed implementation would get wrong, and it's distinct from the
  expired-lease test.

## Concerns

None. The implementation is the brief's Step 3 code verbatim; no interpretation was
required. All constraints (no new authority, refusals write no state beyond events, expiry
authorizes/refuses nothing) are directly exercised by the five new tests and pass.

---

## Fix report: review finding on "does not refuse a resume immediately after an owner transfer"

### Finding (recap)

Review flagged that this test was vacuous with respect to Task 7: `checkRunLease`'s
`no_lease` branch (hit when `leaseAffirmedAt === null`) has zero observable side effects,
so the test's two assertions held identically whether `checkRunLease` was called or never
called at all. It would not catch a regression where the gate call in `resumeLoop.ts` were
deleted or made conditional. Human ruling: strengthen (do not weaken/delete) by adding a
matched second half — same lease age, `leaseAffirmedAt` instead of `lastAffirmedAt`, a
different holder — asserting refusal.

### What was changed

`tests/controller/resumeLoop.integration.test.ts`:

1. Renamed the existing test to
   `"does not refuse a resume immediately after an owner transfer (lastAffirmedAt is not the lease field)"`
   and extended its comment to explain, in my own words, why it's vacuous alone and how it
   pairs with the new test below it: same seconds-old age, one field vs. the other, opposite
   outcomes — so the pair fails if the gate isn't wired (the twin would wrongly succeed) and
   fails if the gate reads the wrong field (this half would be wrongly refused).

2. **Split into two `it` blocks** rather than one combined body. I chose to split because
   the two halves assert opposite outcomes (`resolves` vs. `rejects`) with independent run
   directories, and combining them in a single `it` would obscure which half a failure came
   from; the "matched pair" relationship lives in the shared comment rather than shared
   code, so nothing is lost by keeping them separate. Both tests carry the pairing rationale
   in their comments.

3. New test: `"refuses a resume when leaseAffirmedAt is seconds old and held by another process"`.
   Uses a **fresh `mkdtemp` run dir** (via `seedEligibleRun`) rather than re-seeding the run
   dir the first half consumed, because by the time the first half's `resumeLoop` call
   returns, that dir is no longer in the eligible/interrupted state `resumeLoop` requires —
   it has been advanced to `status: "succeeded"`, ownership has been claimed under this
   process's own `buildProcessInstanceId()`, and the residual-worktree cleanup has already
   run. Re-deriving an eligible state from that dir would mean undoing all of that by hand;
   a clean `seedEligibleRun` into a new dir reaches the same starting point with no risk of
   carrying over incidental state from the first half, and matches how every other test in
   this file already sets up its own run dir. Sets `leaseAffirmedAt` to `new Date().toISOString()`
   (seconds old — the same order of magnitude as the first half's `lastAffirmedAt` mutation)
   with `currentProcessInstanceId: "pid:999:9000"`, and asserts the resume rejects with
   `RunLeaseHeldError`.

### Covering test run

Command: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/resumeLoop.integration.test.ts`

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l1-run-lease-heartbeat

 ✓ tests/controller/resumeLoop.integration.test.ts (10 tests) 1127ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

`npm run typecheck` — clean, no output (`tsc --noEmit -p tsconfig.json`).

### Mutation check (evidence the strengthened test can actually fail)

Temporarily commented out the gate call in `src/controller/resumeLoop.ts`:

```ts
  try {
    // await checkRunLease(runDir, buildProcessInstanceId()); // MUTATION-CHECK: temporarily disabled
  } catch (error) {
```

Re-ran the same covering command. Result: 5 of 10 failed, including — critically — the new
half of the pair, while its twin kept passing (proving the twin alone is insufficient, and
the new half is what catches this regression):

```
 ✓ resumeLoop > resumes an eligible run from the next attempt and claims ownership
 ✓ resumeLoop > refuses (and mutates nothing) when eligibility is not published
 ✓ resumeLoop > aborts when a concurrent owner-record change breaks the claim CAS
 ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh)
 × resumeLoop > refuses a resume against a live lease and mutates nothing but events
 ✓ resumeLoop > does not refuse a resume immediately after an owner transfer (lastAffirmedAt is not the lease field)
 × resumeLoop > refuses a resume when leaseAffirmedAt is seconds old and held by another process
 × resumeLoop > lets an eligible resume through an expired lease and records the observation
 × resumeLoop > refuses an ineligible resume with the eligibility reason even when the lease has expired
 × resumeLoop > refuses while a killed run's lease is still fresh and stops refusing after the TTL

 Test Files  1 failed (1)
      Tests  5 failed | 5 passed (10)
```

The new test's specific failure:
```
 × resumeLoop > refuses a resume when leaseAffirmedAt is seconds old and held by another process 129ms
   → promise resolved "{ status: 'succeeded', …(7) }" instead of rejecting
```

This is exactly the gap the finding identified: with the gate disabled, the resume silently
succeeds instead of being refused — and now a test catches it. (The other 4 failures are the
pre-existing Task 7 tests, expected to fail too since they all depend on the same gate call;
they're not new evidence, just confirmation the mutation genuinely disabled the gate.)

Restored the gate call exactly (`git diff src/controller/resumeLoop.ts` showed no diff
against the last commit after restoring), then re-ran the covering test file and
typecheck — both green/clean again (shown above, pre-mutation section).

### Commit

`(see final commit list in the terminal reply)` — new commit on top of `3cd2cdd`,
containing only the test-file split/strengthening. `src/controller/resumeLoop.ts` has no
net diff versus `3cd2cdd` (the mutation check's edit was fully reverted before committing).

### Self-review of the fix

- The original two assertions (`status === "succeeded"`, no `lease_expired_observed`) are
  unchanged — nothing was weakened or deleted, per the ruling.
- The new test is not redundant with the existing "refuses a resume against a live lease"
  test: that one uses a *fresh* lease (`new Date().toISOString()`, no meaningful age
  distinction called out) already known to refuse; this one specifically pins the lease age
  to match the first half's `lastAffirmedAt` mutation, which is the point of the pairing
  (same age, different field, opposite outcome) rather than just another "live lease
  refuses" case.
- Mutation check used the harness's own commented-out-call technique rather than deleting
  the import or the whole block, so the diff during the check was minimal and trivially
  revertible, and `git diff` confirmed exact restoration before committing.
