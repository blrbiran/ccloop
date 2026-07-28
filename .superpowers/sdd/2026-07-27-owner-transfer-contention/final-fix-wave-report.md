# Final fix wave — report

Branch `worktree-l1b-owner-transfer-contention`, base `7ee5cd3`, four new commits.

| Commit | Subject |
|---|---|
| `9707543` | test: fence the mirror interleaving direction requirement 4 left open |
| `67b5f2f` | fix: guard the catch-path owner-record re-read, per human ruling |
| `b9769bb` | test: widen the contention tests' timing fixtures and correct two stale claims |
| `84bbdf9` | docs: amend five document defects found by the final whole-branch review |

Final verification: **373/373 tests green** (up from 371; two tests added), `npm run typecheck` clean, `npm run build` clean, working tree clean. See "Flake evidence" below — the suite is green, but a pre-existing flake family in `runLoop.integration.test.ts` fired twice across 19 full-suite runs and must not be read as clean.

---

## Item 1 — spec §6 requirement 4's named mutation now dies

**Change:** one new test in `tests/controller/leaseHeartbeat.test.ts`, inside the existing
`describe("runExclusive shares the serialization queue with affirmNow")` block, immediately
after the test it mirrors:

> `it("does not invoke an incoming runExclusive fn until an already-in-flight affirm settles")`

**Where and why there.** The property is a property of `leaseHeartbeat`'s queue, not of the run
loop, and the deterministic gate it needs (a mocked `affirmOwnerLease` blocked on a
test-controlled promise) already exists in that describe block for the opposite direction. Placing
the mirror beside its twin means a future editor reading either one sees both directions of §4's
"by construction" claim in the same place, with the same technique and the same vocabulary. Putting
it in `leaseLifecycle.integration.test.ts` next to requirement 4's own test was the alternative;
rejected because that test needs the whole run loop, an injected clock and a real filesystem to
observe a property that is fully observable two layers down — and because the integration test is
what *failed* to fence this direction, so copying its shape again would risk copying its blind spot.

**Mutation evidence.** `src/controller/leaseHeartbeat.ts:197`,
`const result = queue.then(fn, fn);` → `const result = fn();` (the exact mutation requirement 4
names), leaving `queue = result.then(...)` intact.

New test — FAILS:

```
$ npx vitest run tests/controller/leaseHeartbeat.test.ts -t "already-in-flight"
 × runExclusive shares the serialization queue with affirmNow > does not invoke an incoming
   runExclusive fn until an already-in-flight affirm settles 11ms
   → expected [ 'affirm:start', 'fn:start' ] to deeply equal [ 'affirm:start' ]

  Array [
    "affirm:start",
+   "fn:start",
  ]
 ❯ tests/controller/leaseHeartbeat.test.ts:502:19
 Tests  1 failed | 19 skipped (20)
```

Requirement 4's own test, under the **same** mutation — PASSES (this is the finding, reproduced
rather than asserted):

```
$ npx vitest run tests/controller/leaseLifecycle.integration.test.ts -t "spec requirement 4"
 ✓ tests/controller/leaseLifecycle.integration.test.ts (24 tests | 23 skipped) 192ms
 Tests  1 passed | 23 skipped (24)
```

The sibling unit test in the same describe block ("does not invoke the due affirm's write until an
in-flight runExclusive fn resolves") also passes under the mutation — same surviving direction:

```
$ npx vitest run tests/controller/leaseHeartbeat.test.ts -t "does not invoke the due affirm"
 Tests  1 passed | 19 skipped (20)
```

Mutation reverted (`git checkout -- src/controller/leaseHeartbeat.ts`); all 20 tests in the file
pass afterwards. **No production code was changed for this item** — the implementation was correct
in both directions all along; the gap was test coverage, exactly as the review said.

---

## Item 2 — the catch-path re-read is guarded (human ruling)

**Change:** `src/controller/runLoop.ts` — `await heartbeat.assertHeld();` immediately before the
second `readOwnerRecord` on the CAS-mismatch / exhausted-lock-busy path, with a comment stating
why it is not the "third guard" §5.4 forbade (that phrase was about the transfer CAS; see
amendment (c)).

**Test — added, and it is deterministic**, so the "do not add a fragile fixture" escape hatch was
not needed. `tests/controller/leaseLifecycle.integration.test.ts`:

> `it("refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns")`

Construction, and why it has no timing dependence beyond the phase timeout every test in this file
already has:

- driven through `runLoopFromState` with a test-owned heartbeat, so file state is asserted **before**
  `stop()` — `releaseOwnerLease` routes through the same recovery-on-write path and would finalize
  the staged fixture afterwards, destroying the evidence. (The requirement 6 test asserts pre-stop
  for the same reason; it uses `runLoopFromState` for the same reason.)
- `writeOwnerTransferArtifacts` is mocked to do three things atomically at the instant the CAS
  fails: stage an interrupted-transfer fixture (`.owner-record.pending.json`,
  `.owner-transfer.pending.json`, `.owner-transfer.transaction.json` → epoch 555 / `pid:recovered`),
  rotate `owner-record.json` to an unrelated rival (epoch 42 / `pid:rival`), then throw
  `OwnerTransferPreconditionError`. No sleeping, no polling, no wall-clock ordering.
- evidence asserted is **file state**, not a call count: the three staged files still exist,
  `owner-transfer.json` does not, `owner-record.json` is still the rival's, `stopReason` is
  `lease_lost`.

**Mutation evidence.** Delete the new `await heartbeat.assertHeld();` (only that line) — FAILS:

```
$ npx vitest run tests/controller/leaseLifecycle.integration.test.ts -t "catch-path re-read"
 × lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than
   finalizing a staged transfer it no longer owns 372ms
   → promise rejected "Error: ENOENT: no such file or directory,… { …(4) }" instead of resolving

Caused by: Error: ENOENT: no such file or directory, access
  '/var/.../ccloop-run-hnwsPR/.owner-transfer.transaction.json'
 ❯ tests/controller/leaseLifecycle.integration.test.ts:777:7
 Tests  1 failed | 24 skipped (25)
```

That is the hazard itself, observed: without the guard, `readOwnerRecord`'s
`recoverInterruptedOwnerTransfer` finalizes a transfer to `pid:recovered` inside a run this process
has already lost. Guard restored; the file's 25 tests pass.

Note on what the test does **not** claim: with or without the guard the run still ends
`cancelled` / `lease_lost`, because the pre-write guard at `runLoop.ts:807` refuses either way. The
only difference between the two runs is the recovery write — which is precisely what is asserted,
so the assertions discriminate the guard and nothing else.

---

## Item 3 — timing fixtures widened

`tests/controller/leaseLifecycle.integration.test.ts`. **All six** occurrences of the
`perAttemptTimeoutMs: 20` / `totalRuntimeBudgetMs: 20` / `partialOutcomeRecoveryWindowMs: 10`
shape were widened to `perAttemptTimeoutMs: 200` with `totalRuntimeBudgetMs` and
`partialOutcomeRecoveryWindowMs` falling back to the contract defaults (5000 / 1000) — matching the
requirement 7 test's already-widened shape exactly. The brief says "the remaining five"; the six
line numbers it lists (`:323, :396, :489, :579, :680, :877`) are six distinct tests, all new on this
branch, and the already-widened requirement 7 test is not among them. I widened the six that were
listed. **None was left alone**, for the reasons below.

| Test | Adapter's exit | Safe? |
|---|---|---|
| `appends owner_transfer_contended and abandons the transfer…` | blocks on `waitForAbort`, never resolves | yes |
| `retries a busy owner-transfer lock and completes once it clears (req 1)` | same | yes |
| `abandons the transfer once the retry bound is exhausted… (req 2)` | same | yes |
| `retries zero times on a CAS mismatch (req 3)` | same | yes |
| `blocks a due affirm until the transfer's exclusive span completes… (req 4)` | same | yes |
| `a self-performed transfer with adopt inside the exclusive span… (req 5)` | same | yes |

**Why the widened margin cannot change which branch each reaches**, checked before changing them:

1. Every one of the six adapters `await waitForAbort(context.abortSignal)` and returns `null` — it
   blocks on the abort signal rather than racing it, so the phase timeout is the *only* exit and
   `perAttemptTimeoutMs` alone reaches the "timed out, no result" branch. This is the identical
   argument the requirement 7 test's comment already makes for itself.
2. That branch (`runLoop.ts:1046-1077`) calls `persistBoundaryAnalysis` and then **returns** a
   terminal state, so the run is one attempt long regardless of `totalRuntimeBudgetMs`. A wider
   budget cannot admit a second attempt and so cannot duplicate an event or a write-call count.
3. The only observable difference the wider budget makes is the terminal *reason*
   (`hasBudgetExceeded(state) ? BUDGET_EXHAUSTED_REASON : <phase timeout reason>`). None of the six
   asserts `stopReason`; five assert `finalState.status === "exhausted"`, which is the status on
   both sides of that ternary, and the sixth asserts no status at all.
4. `partialOutcomeRecoveryWindowMs` is consumed only by `subprocessClaudeAdapter`/`prompts.ts`
   (verified by grep across `src/`), i.e. it is inert for hand-written adapters. Dropping it changes
   nothing; it is dropped only to make the six fixtures identical to the requirement 7 one.

**Verification that each still exercises its subject** (this is the real check — a test that stops
reaching its branch is worse than a flaky one): each test's *decisive* assertion is itself proof the
branch was reached, and all still pass — `writeCalls === 2` (req 1), `writeCalls ===
OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` (req 2), `writeCalls === 1` (req 3), the
`owner_transfer_contended` event (contention test), `owner_epoch_transferred` exactly once plus
`currentOwnerEpoch === 2` (req 4), `currentOwnerEpoch === 2` under the same process id (req 5).

One shared comment explaining the shape and its rationale was added at the first widened site rather
than copied six times.

---

## Item 4 — inverted test name

`tests/controller/runLoop.integration.test.ts:1518`:
`"preserves a synthesized winner reconciliation view when…"` →
`"writes no synthesized winner reconciliation view when…"`. Name only; **no assertion, comment or
fixture touched**.

## Item 5 — retry-bound comment

`src/controller/runLoop.ts:80-81`: `"3 attempts * 50ms backoff <= 150ms total"` →
`"3 attempts with the backoff preceding attempts 2 and 3 only, so 2 * 50ms = 100ms of waiting at
worst — far below LEASE_TTL_MS (90_000ms, lease.ts, ~0.11% of it)"`. This matches the arithmetic
already recorded in the ledger for Task 2.

---

## Item 6 — document amendments

Convention followed from `docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`: an
index line in the Status area plus inline `**Amended 2026-07-28 (x): …**` markers, each stating
plainly that it corrects a defect in the document and not in the implementation. Defective sentences
are left in place and corrected beneath (or struck through, in the plan and brief, where the whole
bullet is wrong).

**Status-area index added to the spec:**

> Amendments: five, all found by the final whole-branch review of the implementation and marked
> inline as **Amended 2026-07-28 (a)–(e)** in §2, §5.1, §5.3, §5.4 and §6. Each corrects a defect in
> *this document*, not in the implementation. (a) §2's third non-goal is contradicted by shipped code
> and its reasoning is inverted; (b) §5.1 step 4 and §5.4 name a wrapper that is unreachable from
> `persistBoundaryAnalysis`; (c) §5.4's "No third guard" says more than it meant; (d) §6 requirement
> 4 names one interleaving direction where the property has two; (e) §5.3 does not record the new
> on-disk shape this design produces.

### S1 → amendment (a), spec §2 third non-goal

> **Amended 2026-07-28 (a): this non-goal is contradicted by the shipped guards, and its reasoning
> is backwards.** This corrects a defect in *this document*, not in the implementation. Two tests now
> assert `status: "cancelled"` / `stopReason: "lease_lost"` where they previously asserted
> `"exhausted"` / the budget-exhausted reason. Preceding terminal persistence is exactly what
> *causes* the flip rather than preventing it: the guard refuses by throwing, and the refusal reaches
> `isLeaseStopError` in `runLoopFromState`'s catch — which persists `"cancelled"` — before
> `persistTerminalState` would have run with the outcome this attempt was heading for. Any refusal at
> either call site therefore changes the reported run state; there is no placement that both guards
> the write and preserves the outcome. The human ruling that authorized the unconditional write guard
> (see §5.4) authorized that consequence with it. **The exit-code half of the sentence stands:**
> nothing in `src/cli.ts` maps a run status to a process exit code, so only the run state changes.
> The plan's "No terminal-state changes" Global Constraint carries the same defect and is amended
> with it.

Same defect, same date, in two more places:

- `docs/superpowers/plans/2026-07-27-owner-transfer-contention.md` — the "No terminal-state changes"
  Global Constraint is struck through and replaced with amendment (a), preserving what still holds
  (no exit-code change, no `persistTerminalState` call site moves).
- `.superpowers/sdd/2026-07-27-owner-transfer-contention/task-5-brief.md:19` — the inherited trap is
  struck through and replaced, stating that a changed terminal **status** is the expected consequence
  of a correctly placed guard here, while a changed **exit code** would still be evidence of a
  problem (and none occurs). *(This file lives under a gitignored path, so the edit is on disk but
  not in a commit — matching how the rest of the SDD ledger is kept.)*

### S2 → amendment (b), spec §5.1 step 4

> **Amended 2026-07-28 (b): there is no such wrapper in scope; the guard is inline.** This corrects a
> defect in *this document*, not in the implementation. `guardedWriteArtifacts` is a closure defined
> inside `runLoopFromState` (`runLoop.ts:910`); `persistBoundaryAnalysis` is a module-level function
> that receives only `heartbeat`, so the wrapper is unreachable from it. Step 4 reads, correctly:
> **write boundary artifacts behind an inline `await heartbeat.assertHeld()`**, matching how L1's
> other `assertHeld` sites are written. §5.4's "before the write" bullet names the same unreachable
> wrapper and is corrected by this same amendment.

### S3 → amendment (c), spec §5.4

> **Amended 2026-07-28 (c): "No third guard" was about the transfer CAS, and was read as being about
> reads.** This corrects a defect in *this document*, not in the implementation. Taken literally the
> sentence bans a guard on the catch path's *second* `readOwnerRecord` (`runLoop.ts:782`, reached on a
> CAS mismatch or an exhausted lock-busy retry) — which runs `recoverInterruptedOwnerTransfer` and
> therefore **writes**, the exact hazard the entry bullet above exists to prevent, on the path that
> most strongly indicates a rival now owns the run and up to a full retry backoff after the entry
> guard passed. Per human ruling the bullet reads, correctly:
>
> > - **every `readOwnerRecord` in this function is guarded**, entry read and catch-path re-read
> >   alike, for the one reason the entry bullet gives: recovery-on-read is a write, and a superseded
> >   process must not perform crash recovery on a run it no longer owns.
> > - the **owner-transfer CAS itself** gets no guard and keeps relying on its own precondition. That
> >   is what "no third guard" meant.
>
> The paragraph above therefore reads "**three** guards", not two. Nothing else in it changes: they
> refuse by throwing, exactly as L1's existing sites do.

### S4 → amendment (d), spec §6 requirement 4

> **Amended 2026-07-28 (d): this requirement names one direction of a two-directional property, and
> its named mutation survives it.** This corrects a defect in *this document*, not in the
> implementation — which is correct in both directions and was always correct. §4 claims the
> no-interleaving property holds "by construction", which covers both orderings; the requirement as
> written covers only "affirm becomes due *after* the span starts". The mutation it names —
> `const result = queue.then(fn, fn)` replaced by `const result = fn()` — leaves
> `queue = result.then(...)` intact, so anything queued *behind* the span still blocks correctly and
> the requirement's test passes against it. Both directions are therefore required, as separate
> tests:
>
> - **affirm after span**: an affirm becoming due while a transfer is in flight does not execute until
>   the span completes (the original wording).
> - **affirm before span**: a `runExclusive` span whose `fn` is submitted while an affirm is
>   **already in flight** does not begin `fn` until that affirm settles. This is the direction the
>   named mutation actually breaks, and the ordinary one in production: the interval timer fires
>   `void affirmNow()` at arbitrary points during an attempt, so an affirm is routinely mid-CAS when
>   `persistBoundaryAnalysis` reaches its span — which is precisely defect 2 of §1.
>
> Only with both is the mutation killed.

### S5 → amendment (e), spec §5.3

> **Amended 2026-07-28 (e): after this design, a completed `owner-transfer.json` no longer implies a
> `reconciliation-record.json`.** This records a shape this document never stated, and corrects a
> defect in *this document*, not in the implementation. §5.4's write guard is unconditional, so if
> this process's own transfer succeeds inside the exclusive span and a rival supersedes it before the
> artifact write, disk carries `owner-transfer.json` and an `owner_epoch_transferred` event but
> **neither** `boundary-analysis.json` nor `reconciliation-record.json`. That is requirement 7's
> intended behaviour, not a gap in it — the transfer is real and committed by a CAS this process
> passed, and the refused write is a process that no longer owns the run declining to write into it.
> Layers that consume reconciliation artifacts must therefore treat the transfer event, not the
> reconciliation record, as the authoritative trace of a transfer: a missing reconciliation record
> next to a completed transfer means "the writer lost the run", not "no transfer happened". The same
> ruling deliberately gave up the losing process's synthesis of the winner's reconciliation view; if
> that view is still wanted, assigning it to a process that still holds the run is L5's problem.

No amendment collided with a ruling already recorded in the ledger; (a), (c) and (e) restate rulings
the ledger already carries (Task 5's human ruling, Final-2's human ruling, and Task 5's accepted
risk respectively).

---

## Files changed

| File | Change |
|---|---|
| `src/controller/runLoop.ts` | catch-path `assertHeld` guard (+ comment); corrected retry-bound comment |
| `tests/controller/leaseHeartbeat.test.ts` | +1 test (mirror interleaving direction) |
| `tests/controller/leaseLifecycle.integration.test.ts` | +1 test (catch-path guard); six timing fixtures widened |
| `tests/controller/runLoop.integration.test.ts` | one test renamed (name only) |
| `docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md` | amendments (a)–(e) + status index |
| `docs/superpowers/plans/2026-07-27-owner-transfer-contention.md` | Global Constraint amended |
| `.superpowers/…/task-5-brief.md` | inherited trap amended (untracked path) |

No test was weakened, deleted or restructured. No production behaviour changed except the added
refusal. `ReconciliationRecord` untouched. Zero Claude calls; every adapter in the new tests is
hand-written.

## Verification

```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run   → 23 files / 373 tests passed
npm run typecheck                                    → clean
npm run build                                        → clean
git status --short                                   → clean
```

## Flake evidence — read this before calling the suite clean

Nineteen full-suite runs were executed after the changes. **Seventeen were green; two failed**, both
in `tests/controller/runLoop.integration.test.ts`, both with the identical assertion:

```
AssertionError: expected 'execute phase exceeded per-attempt ti…' to be 'runtime or token budget exhausted'
Expected: "runtime or token budget exhausted"
Received: "execute phase exceeded per-attempt timeout of 20ms"
```

- run A: `records retained cleanupStatus in execution recovery when cleanup fails` (`:1709`)
- run B: `writes stale reconciliation conflicting evidence when execute aborts after changing files`

Both are **pre-existing**, not introduced or edited here: the first was added in `d5cfc8c`
(2026-07-21), confirmed an ancestor of this branch's base. They are the same family as the flake the
ledger already names at Task 4 (`treats execute timeout with no adapter result as exhausted…`,
reproduced 1-in-10 before any of this wave's changes) — three sibling tests in one file, each pinning
`perAttemptTimeoutMs` and `totalRuntimeBudgetMs` to the same 20 ms and then asserting the
budget-exhausted reason, i.e. asserting the winner of a knife-edge race between the phase timer and
the elapsed-time accounting.

**They were deliberately not fixed**, for the reason item 3 states: these tests genuinely *depend* on
the tight `totalRuntimeBudgetMs` to reach the branch they assert (`hasBudgetExceeded` must be true
for `BUDGET_EXHAUSTED_REASON`), so the widening applied to `leaseLifecycle` cannot be applied to them
unchanged — it would change what they assert. They are also outside this wave's stated scope, and
editing three pre-existing tests in the final wave, with no review pass left, is a worse trade than
reporting them.

The plausible fix, for whoever takes it: raise **only** `perAttemptTimeoutMs` (e.g. to 200 ms) and
leave `totalRuntimeBudgetMs` at 20 ms. That makes the elapsed phase time robustly exceed the budget
instead of racing it, so `BUDGET_EXHAUSTED_REASON` becomes the deterministic outcome rather than the
likely one — strengthening the assertion rather than relaxing it. It needs its own verification pass,
since it moves in the opposite direction from item 3's widening and each of the three tests must be
re-checked against its own branch.

## Self-review

- **The item 2 guard is inside the exclusive span.** Checked against §4's constraint that
  `runExclusive`'s `fn` must not re-enter the queue: `assertHeld` is deliberately *not* part of the
  queue chain (`leaseHeartbeat.ts:252`, and L1 documents why at `:74-78`), so calling it from inside
  `fn` cannot deadlock. It takes no lock and adds one raw read.
- **The guard can only refuse.** It adds no path that grants, and its refusal is the same
  `RunLeaseLostError` fourteen other sites already throw; the outer catch handles it unchanged.
- **The item 1 test asserts before and after.** It pins `order` to `["affirm:start"]` at the moment
  of the call *and* to the full `["affirm:start", "affirm:end", "fn:start"]` at the end, so a
  regression that merely delayed `fn` without ordering it would still fail.
- **No new fake-timer usage.** The mirror test lives in the real-timer describe block, like its twin.
- **Comment-only edits** (items 4, 5) were checked for scope: the rename changes no `-t` filter used
  anywhere in the repo: grepping the old string finds only historical prose in the SDD ledger and a
  differently-named `fileStore.test.ts` test ("…against a later loser downgrade"), which is untouched.
  The retry constant values are untouched.

## Concerns

1. **The pre-existing flake family above.** The suite is green as delivered, but 2 failures in 19
   full-suite runs is not noise-free, and this wave's widening of `leaseLifecycle` lengthens that
   file's wall-clock time (~6.7 s), which runs concurrently with `runLoop.integration.test.ts` and may
   marginally raise the contention those three tests race against. I could not measure that
   attribution; the failure mode and the tests are unchanged from before this branch.
2. **Item 2's guard sharpens, but does not close, the architecture note already logged for L5.** The
   new refusal propagates the same way every other one does, into `persistTerminalState` at
   `runLoop.ts:1297-1304`, which writes into a run this process no longer owns. This wave adds one
   more path that reaches it. Left alone as instructed; it belongs on L5's inheritance list.
3. **Requirement 4's own test is still the weaker of the two.** I did not touch it (no test may be
   weakened or restructured), so the suite now contains a test whose stated "Kills:" claim is only
   true when read together with the new mirror test. Amendment (d) is what makes that legible; a
   future editor who reads only the integration test will still see an overclaimed comment.
