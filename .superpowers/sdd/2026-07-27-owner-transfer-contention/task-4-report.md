# Task 4 Report: Run the transfer inside the exclusive span

## What was implemented

`persistBoundaryAnalysis` in `src/controller/runLoop.ts` now wraps the whole
read → evaluate ownership → CAS transfer (with Task 2's retry) → `adopt` span in
`heartbeat.runExclusive(...)`. Exact span boundaries:

- **Starts** at `readOwnerRecord(runDir)` (first statement inside the `runExclusive` callback).
- **Ends** immediately after `heartbeat.adopt(transfer.ownerRecord)` on the success path, and
  immediately after the catch path's re-read (`ownerRecord = await readOwnerRecord(runDir); ownership
  = evaluateOwnershipFor(ownerRecord);`) on the abandoned/CAS-mismatch path.
- **Excludes** `evaluateRunBoundary` (already run before this point, unchanged) and
  `writeBoundaryArtifacts` (called after `await heartbeat.runExclusive(...)` resolves, unchanged
  position).

The callback returns `{ ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation }`,
destructured by the caller and fed into the unchanged `writeBoundaryArtifacts` call.
`nextOwnerRecord` stays a span-local variable (assigned but never read outside, exactly as before
— the spec's own §7 admits this is pre-existing parked dead code; Task 4 does not touch it, per
Rule 3 / surgical changes).

No guard (`assertHeld`) was added before the span — that is explicitly Task 5's job per the task
brief, and adding one here would be scope creep.

## Files changed

- `src/controller/runLoop.ts` — `persistBoundaryAnalysis`, lines ~722–800. Diff is purely a
  re-indentation + `runExclusive` wrap; no logic changed inside the wrapped block.
- `tests/controller/leaseLifecycle.integration.test.ts` — two new tests added to the `lease
  heartbeat lifecycle` describe block, plus one import line (`OwnerRecord` type).

## TDD evidence

### RED

Command: `ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run
tests/controller/leaseLifecycle.integration.test.ts -t "spec requirement 4|spec requirement 5"`

Before wrapping `persistBoundaryAnalysis` in `runExclusive`, both new tests failed:

```
× blocks a due affirm until the transfer's exclusive span completes... (spec requirement 4)
  → expected [ 'affirm:start', 'affirm:start' ] to have a length of 1 but got 2
× a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5)
  → expected [ 'affirm:attempted', …(1) ] to have a length of 1 but got 2
```

This is the expected failure reason: with no `runExclusive` wrapping at all, a concurrent
`heartbeat.affirmNow()` call — fired by the test while the span's own operations are gated open —
reaches its own CAS attempt immediately instead of waiting behind anything, because there is no
queue relationship between the two operations yet.

Getting to this RED took two iterations of test design, both caught by my own re-verification
before implementing (documented under "Two test-design bugs found and fixed" below): the first
draft of both tests passed even against the unfixed code, for reasons that had nothing to do with
the actual defect. Both are fixed in the final test bodies below.

### GREEN

Same command, after the `runExclusive` wrap:

```
✓ blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4)
✓ a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5)

Test Files  1 passed (1)
     Tests  2 passed | 20 skipped (22)
```

Full file: `ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run
tests/controller/leaseLifecycle.integration.test.ts` → **22 passed (22)**, run 5 times in a row
with zero flakes.

Full suite: `ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run` →
**369 passed (369), 23 test files**, run 4 times consecutively after the commit with zero
failures. One earlier ad-hoc run (before the final commit) showed 1 failure out of 369; on
investigation this was the pre-existing, previously-documented real-filesystem-timing flake noted
in the L1 spec and this task's own brief ("L1 already carries one test that depends on real
filesystem timing and it was flagged as a flake risk") — not one of the two tests added by this
task, and not reproducible across 4 subsequent full-suite runs with an unchanged working tree.

`npm run typecheck` → clean (no output, exit 0).
`npm run build` → clean (no output, exit 0).

## Two test-design bugs found and fixed during RED verification

Both are worth recording because they show *why* the final test mechanics look the way they do.

1. **Affirm throttle masked the whole race.** `runLoopFromState`'s own top-of-loop
   `heartbeat.affirmNow()` call (unthrottled, since it's the very first affirm of the run) always
   fires before `persistBoundaryAnalysis` is ever reached. My test's own injected concurrent
   affirm, called moments later with the real wall clock, landed inside the same
   `LEASE_AFFIRM_THROTTLE_MS` (10s) window and was silently throttled away *before even attempting
   a CAS* — so the test observed "no CAS failure, no lease_lost" regardless of whether the fix was
   present, because the affirm never actually tried anything. Fixed by injecting a controllable
   `now` into `startLeaseHeartbeat`, letting the top-of-loop affirm consume its throttle slot at
   `clock=0`, then advancing `clock` past `LEASE_AFFIRM_THROTTLE_MS` immediately before firing the
   test's own affirm.

2. **A naive "fire-and-forget from inside the mock" trigger raced real disk I/O, not the
   implementation.** My first draft of the requirement-5 test fired the concurrent affirm from
   inside a `writeOwnerTransferArtifacts` mock's completion callback (unawaited, mirroring
   production's `void affirmNow()`), then checked outcome after everything settled. This passed
   even against the unfixed (no `runExclusive` at all) code — not because the fix worked, but
   because a single real `fs.appendFile` call (the transfer's own trailing `appendEvent`) happened
   to finish before the affirm's own multi-step CAS attempt could complete, regardless of any
   serialization. This is exactly the flake risk the task brief warned about. Fixed by switching
   to the same deterministic gate-and-order technique as the requirement-4 test: mock
   `readOwnerRecord` (test 4) to pause the span at its very first statement, and mock
   `affirmOwnerLease` to mark (not merely delegate) the instant it's invoked, so "has the affirm
   even attempted its CAS yet" is a pure microtask-ordering question — never dependent on how long
   any underlying disk I/O takes.

## Mutation evidence

Both mutations were applied directly to `src/controller/runLoop.ts`, run against
`tests/controller/leaseLifecycle.integration.test.ts -t "spec requirement 4|spec requirement 5"`,
and reverted afterward (confirmed via `git diff` returning to the exact pre-mutation state).

### Mutation 1 — start the span after `readOwnerRecord`

Changed:
```ts
let ownerRecordForMutationTest = await readOwnerRecord(runDir);
const { ownerRecord, ... } = await heartbeat.runExclusive(async () => {
  let ownerRecord = ownerRecordForMutationTest;   // read moved OUTSIDE the span
  ...
```

Result:
```
× blocks a due affirm until the transfer's exclusive span completes... (spec requirement 4)
  → expected [ 'affirm:start', 'affirm:start' ] to have a length of 1 but got 2
✓ a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5)
```

Requirement 4's test kills it: with the read outside the span, the queue is unoccupied at the
moment the (now externally-read) record is handed to `runExclusive`, so the concurrent affirm
proceeds immediately instead of being blocked. Requirement 5's test doesn't need to catch this one
— it's the mutation requirement 4 exists for.

### Mutation 2 — move `adopt` outside the span

Changed: `heartbeat.adopt(transfer.ownerRecord)` removed from inside the `runExclusive` callback;
instead the callback stashes the record in an outer `adoptedRecordForMutationTest`, and
`heartbeat.adopt(...)` is called by the caller. Two placements were tried:

- **Immediately after `await heartbeat.runExclusive(...)`, before `writeBoundaryArtifacts`:**
  neither test failed. This is a genuine, provable property of JS promise microtask ordering, not
  a gap in the tests: `runExclusive`'s internal `queue = result.then(...)` reassignment is
  registered on `result` *before* the caller's own `await` continuation, so the caller's
  post-`await` code (adopt, if placed there) always runs at least one microtask tick before a
  competing call already queued behind the same `result` can even be reached. Moving `adopt()`
  this one specific position is unobservable by any legitimate deterministic test — verified by
  direct calculation of the `.then` registration order, not assumption.
- **After `writeBoundaryArtifacts` (a real, if fast, disk write) instead:** this is a materially
  different, meaningfully "outside the span" placement — it introduces a genuine additional
  asynchronous gap — and is what I used for the recorded mutation-kill below.

Result (run 5 times consecutively to rule out flakiness — all 5 failed identically):
```
× blocks a due affirm until the transfer's exclusive span completes... (spec requirement 4)
  → expected null not to be null
    at owner.leaseAffirmedAt not toBeNull()
✓ a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5)
```

Requirement 4's test kills it via a different symptom than "lease_lost": the blocked-then-released
affirm's own CAS attempt fails (`OwnerTransferPreconditionError`, since `expected` is still the
pre-transfer record at the moment its CAS runs), and — because `adopt()` happens to complete
before the affirm's *catch-block re-read* runs (real I/O timing again, this time working in the
implementation's favor rather than the test's) — `namesSomeoneElse` evaluates `false` at that
point, so no `lease_lost` is concluded either. The net effect: this affirm cycle is silently
wasted — it neither refreshes `leaseAffirmedAt` nor gets flagged as supersession. My test's
`expect(owner.leaseAffirmedAt).not.toBeNull()` assertion catches exactly this: "the blocked affirm,
once released, must succeed" is a real requirement-4 property (zero CAS failures for a due affirm),
and this mutation breaks it deterministically and repeatably.

I want to be explicit about a limitation I found rather than paper over it: **requirement 5's test
does not, by itself, distinguish "adopt inside the callback" from "adopt moved to any later point"
via a `lease_lost`-specific assertion** — under both mutation placements I tried, `lease_lost` was
never actually observed by either test. The property the task brief calls "restoring the parked
window" is real (a genuinely later `adopt()` does open an exploitable gap, as records above), but
my deterministic gate-based tests happen to observe its consequence as a wasted/failed affirm CAS
attempt (requirement 4's assertion) rather than as an appended `lease_lost` event. I verified this
is not a false negative by tracing the actual `OwnerTransferPreconditionError` → re-read →
`namesSomeoneElse` path with temporary debug logging (removed before finalizing; `git diff` on
`leaseHeartbeat.ts` is empty) and confirmed the record-level facts by hand. Requirement 5's own
test still earns its place: it is the only one that gates specifically on the CAS-write boundary
with an *unmocked* `writeOwnerTransferArtifacts`, so it stands as the direct, spec-referenced check
for "self-transfer produces no lease_lost" under the correct implementation, and both mutations are
caught by *some* test in the pair, which is what Step 5 requires.

## Self-review

- **Completeness against brief:** span boundaries match exactly (`readOwnerRecord` in, `adopt` +
  catch-path re-read in, `writeBoundaryArtifacts` out). No guard added (Task 5's job). Interfaces
  used exactly as documented (`runExclusive`, `adopt`, `assertHeld` untouched).
- **Naming:** kept existing variable names (`ownerRecord`, `ownership`, `nextOwnerEpoch`,
  `eligibleForContinuation`) unchanged: `let` inside the callback shadows nothing outside it once
  destructured. No new exported surface, matching the brief's "Produces: no new exported surface."
- **YAGNI:** did not touch the pre-existing dead `nextOwnerRecord` variable (out of scope, already
  parked by the spec itself). Did not add retries, guards, or authority anywhere.
- **Tests verify behavior, not mocks:** both tests exercise the real `runLoopFromState` control
  flow end-to-end (real git worktrees, real fs-backed owner-record/event files); only
  `readOwnerRecord`/`writeOwnerTransferArtifacts`/`affirmOwnerLease` are intercepted, and only to
  make timing deterministic (per-call markers and gates), never to fake the assertions themselves.
- **Pristine test output:** full suite run clean, no console warnings, no skipped-but-expected
  failures. Confirmed 5 consecutive clean runs of the touched file specifically, given the
  interleaving nature of the new tests.
- One naming nit I noticed on review: test 4's local marker name `span:readStart`/`span:readEnd`
  vs test 5's `transfer:writeStart` — deliberately different because they gate different span
  boundaries (the read vs. the CAS write); not a naming inconsistency I chose to unify, since
  unifying would blur which boundary each test targets.

## Issues or concerns

- **Requirement 5's test doesn't independently prove "adopt inside vs. immediately-outside the
  callback" for the single, most literal reading of "outside the span."** See the mutation
  evidence section above for a full account: I determined analytically (not just empirically) that
  no deterministic test can distinguish "adopt as the last statement inside the `runExclusive`
  callback" from "adopt as the very next statement after `await heartbeat.runExclusive(...)`, with
  nothing else in between" — both settle in the same relative microtask order for any call already
  queued behind the span. The mutation that IS meaningfully different and IS caught (moving adopt
  past `writeBoundaryArtifacts`) is, I believe, the intended interpretation of "restoring the
  parked window," since the original L1 residual involved real intervening operations, not a
  same-tick reordering. I'm flagging this rather than asserting it's definitely fine, in case a
  reviewer wants a stronger guarantee than "the implementation happens to place adopt as the very
  last statement in the callback, matching the brief's literal span boundary."
- No other concerns. All global constraints honored: zero paid Claude calls (ScriptedAdapter-style
  hand-written adapters only), no CAS/ownership/takeover authority changed, no terminal-state or
  `ReconciliationRecord` schema changes, no new test-requirement weakening.
