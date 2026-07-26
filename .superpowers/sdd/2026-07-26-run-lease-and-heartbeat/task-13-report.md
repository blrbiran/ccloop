# Task 13 report — re-check the lease before every side effect; abandon in place

**Status: DONE_WITH_CONCERNS** (concerns are observations, not known defects — see §7)

Commit: `cfde8b9 feat: re-check the lease before every side effect and abandon the attempt in place`

Suite: **23 files / 346 tests green** (baseline 342 + 4 new), `npm run typecheck` and `npm run build` clean.

---

## 1. What was implemented

`heartbeat.assertHeld()` (task 10) now runs immediately before every side-effecting step inside
`runLoopFromState`'s attempt body, and a refusal abandons the attempt in place:

- **The lease branch is the first thing in the attempt-body `catch`**, before `failureReason` is
  computed and before any of the existing handling (partial-execution artifacts, path policy,
  the `failed` transition, and — decisively — the unconditional
  `if (worktreePath !== null) cleanupAttemptWorkspaceBestEffort(...)`). It `return`s, so a lease
  stop takes none of that path.
- Stop reason comes from the error: `lease_lost` only when supersession was concluded from a
  clean read, `lease_unverifiable` when the record could not be read/validated within the
  bounded retry. Both are `cancelled`, never `failed`.
- No owner record is written on either path. `heartbeat.stop()` still runs from `runLoop`'s
  `finally`; on the `lease_lost` path its `releaseOwnerLease` CAS cannot match and is swallowed,
  which is why the new owner's record stays byte-identical.
- One local helper `guardedWriteArtifacts(write)` per the brief; cleanups and Claude calls get a
  bare `await heartbeat.assertHeld();` immediately above them.
- `isLeaseStopError(error)` narrows to the two lease errors; needed at two sites (see §2, item
  createAttemptWorkspace).

### Two judgement calls beyond the brief

**(a) Guards that fire after a terminal decision is already persisted.** Ten of the guarded
cleanup sites sit *after* their branch has already called `persistTerminalState`. The brief's
`return await persistTerminalState(runDir, state, "cancelled", error.stopReason)` would then
attempt `succeeded -> cancelled` / `exhausted -> cancelled`, which `transitionRunState` rejects
as an illegal transition (`legalTransitions`, `src/state/stateMachine.ts`) — that would have
thrown out of `runLoopFromState` instead of returning a `RunState`. Resolution: the lease branch
keeps an already-terminal state as it stands.

```ts
return isTerminalRunStatus(state.status)
  ? state
  : await persistTerminalState(runDir, state, "cancelled", error.stopReason);
```

Rationale: the run has *already stopped*; the blocked side effect was only the cleanup that
follows the decision. Re-deciding a terminal run would also be one more write to a run this
process no longer owns. `isTerminalRunStatus` was added to `src/state/stateMachine.ts` and is
**derived** from `legalTransitions` (`legalTransitions[status].length === 0`), not a second
restatement of which statuses are terminal. This is the one file touched beyond the brief's two.
Covered by a 4th test (§4, T4).

**(b) `createAttemptWorkspace` is outside the attempt-body `try`.** Its guard therefore cannot
be handled by the catch that handles everything else. Placing the guard *inside* the existing
workspace-retry `try` (immediately before the call, and inside the retry loop so a retry is
re-checked too) means the refusal lands in the workspace-retry `catch` — where, left alone, it
would have been mis-reported as an infrastructure failure, consumed the single infra retry and
eventually escalated to `blocked_waiting_human`. So that `catch` re-classifies it first:

```ts
if (isLeaseStopError(error)) {
  return await persistTerminalState(runDir, state, "cancelled", error.stopReason);
}
```

No worktree was created at that point, so there is nothing to abandon in place; the attempt
simply never starts. `state` is non-terminal here (top of the loop), so the transition is legal.

---

## 2. Enumeration: every call site, guarded and deliberately not

Line numbers are post-change (`src/controller/runLoop.ts`).

### Kind 1 — Claude calls (3 of 3 guarded)

| Site | Call | Guard |
|---|---|---|
| 876 | `runPhaseWithTimeout(... adapter.plan ...)` | 875 |
| 924 | `runPhaseWithTimeout(... adapter.execute ...)` | 923 |
| 1067 | `runPhaseWithTimeout(... runVerification ...)` | 1066 |

The verify guard also covers `runRequiredChecks`, which shells out inside the attempt worktree.

### Kind 2 — attempt-artifact writes (8 of 8 in the attempt body guarded)

All via `guardedWriteArtifacts`: 904 (budget exceeded after plan), 945 + 965 (execute-timeout
with no result: the recovery artifact and the cleanup-status re-write), 992 (partial execution),
1036 (path-policy human gate), 1047 (budget exceeded after execute), 1079 (verify timeout), 1099
(main path, with verification).

**Deliberately NOT guarded — 1208, `writeCompletedAttemptArtifacts` inside the attempt-body
`catch`.** This is the brief's warning made concrete: it is on the failure path, i.e. a path that
has already abandoned. A guard there would be a new throw site inside a `catch` with no enclosing
`try`, so a refusal would escape `runLoopFromState` entirely instead of stopping the run. It is
also unreachable on a lease stop, because the lease branch returns above it. For the same reason
the guard is not pushed down into `writeCompletedAttemptArtifacts` itself.

The brief says "the four direct call sites"; there are in fact **eight** in the attempt body (plus
the one in the catch). All eight are guarded — the count in the brief is simply low.

### Kind 3 — worktree mutation and removal (10 of 10 in the attempt body guarded)

| Site | Call | Guard |
|---|---|---|
| 835 | `createAttemptWorkspace` | 834 (inside the retry loop; refusal handled in that `catch`) |
| 891 | `cleanupAttemptWorkspaceBestEffort` (plan timeout) | 890 |
| 907 | `cleanupAttemptWorkspaceBestEffort` (budget after plan) | 906 |
| 957 | `cleanupAttemptWorkspaceWithStatus` (execute timeout) | 956 |
| 1019 | `cleanupAttemptWorkspaceBestEffort` (partial execute) | 1018 |
| 1050 | `cleanupAttemptWorkspaceBestEffort` (budget after execute) | 1049 |
| 1087 | `cleanupAttemptWorkspaceBestEffort` (verify timeout) | 1086 |
| 1145 | `cleanupAttemptWorkspace` (retry boundary) | 1142 — placed **outside** that call's own `try`, so a refusal is not mistaken for a cleanup failure and transitioned to `failed` |
| 1151 | `cleanupAttemptWorkspaceBestEffort` (after retry cleanup failure) | 1150 |
| 1174 | `cleanupAttemptWorkspaceBestEffort` (terminal decision) | 1173 |

**Deliberately NOT guarded:**

- **1235, `cleanupAttemptWorkspaceBestEffort` in the attempt-body `catch`.** This is the exact
  unconditional cleanup the task warns about. Guarding it would be both pointless (the lease
  branch returns above it) and harmful (a throw inside `catch` escapes the function).
- **`cleanupAttemptWorkspaceWithStatus` / `cleanupAttemptWorkspaceBestEffort` bodies (lines
  310–336).** These are the shared implementations; guarding runs at the call sites, so guarding
  here would double-check the guarded paths and, worse, silently guard the *unguarded* paths
  above and `resumeLoop`'s `cleanupResidualWorktrees`.
- **`resumeLoop`'s `cleanupResidualWorktrees`.** Not inside the attempt body, and it is the new
  owner's own cleanup of what a previous owner abandoned — the counterpart of this task.

### Not a listed kind, so left alone per "and nowhere else"

`persistBoundaryAnalysis` (949, 981) writes boundary/reconciliation/owner-transfer artifacts and
can write an owner record. It is **not guarded**: the brief's three kinds do not include it and
Step 3 says "nowhere else". Both call sites are immediately preceded by a guard anyway (a guarded
artifact write at 945, and the execute guard at 923 for the "completed without a result" path).
Flagged in §7 rather than fixed.

### Position of the lease branch relative to the catch's cleanup

```
} catch (error) {
  if (isLeaseStopError(error)) { return ...; }     ← line 1191, FIRST statement in the catch
  const failureReason = ...                        ← 1201
  if (error instanceof PhaseExecutionError) {...}  ← partial artifacts, path policy
  if (state.status !== "failed") {...}             ← transition to failed + events
  if (worktreePath !== null) {                     ← 1234
    await cleanupAttemptWorkspaceBestEffort(...);  ← 1235  the unconditional cleanup, never reached
  }
```

---

## 3. Where each kind is proven

| Kind | Test |
|---|---|
| Claude calls | `does not launch the next Claude call when the record names a different process` — `executeCalls` stays 0 after the record rotates inside `plan`. Mutation-verified: deleting the execute-phase guard makes this fail (§5). |
| Attempt-artifact writes | `stops with lease_unverifiable and writes no owner record when the record is corrupt` — the refusal is raised by a guard and the run stops `cancelled/lease_unverifiable` with `owner-record.json` byte-identical and no `lease_lost` event. Also `stops at the next phase boundary …`, whose stop is now produced by the guard on the post-verify artifact write. |
| Worktree mutation/removal | `leaves the attempt worktree in place rather than unwinding it` — `runDir/worktrees` is non-empty after the stop. Mutation-verified: adding a cleanup to the lease branch makes this (and only the two residue tests) fail (§5). |

`keeps an already-persisted terminal decision when the post-terminal cleanup is blocked` covers
judgement call (a): the terminal decision survives *and* the cleanup is still skipped.

---

## 4. TDD evidence

### RED

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts
 ❯ tests/controller/leaseLifecycle.integration.test.ts (9 tests | 4 failed)

AssertionError: expected 1 to be 0 // Object.is equality          ← T1 expect(executeCalls).toBe(0)
AssertionError: expected 'Error: execute must not run' to be 'lease_lost'          ← T2
AssertionError: expected 'Error: execute must not run' to be 'lease_unverifiable'  ← T3
AssertionError: expected [] to deeply equal [ 'attempt-1' ]                        ← T4

 Tests  4 failed | 5 passed (9)
```

Each failure is the *right* failure for a missing guard:

- T1: with no guard the execute Claude call was launched despite the record naming
  `pid:999:9000` — `executeCalls` was 1.
- T2/T3: no guard means no lease error at all, so execute ran, threw, and the run ended `failed`
  with the stub's message as `stopReason` — not `lease_lost` / `lease_unverifiable`.
- T4: the worktree was cleaned up unconditionally, so `worktrees/` read back empty.

### GREEN

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts
 ✓ tests/controller/leaseLifecycle.integration.test.ts (9 tests) 1432ms
 Test Files  1 passed (1)
      Tests  9 passed (9)

$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run && npm run typecheck && npm run build
 Test Files  23 passed (23)
      Tests  346 passed (346)
> tsc --noEmit -p tsconfig.json          (clean)
> tsc -p tsconfig.json && node -e ...    (clean)
```

---

## 5. Mutation evidence (that the tests fence the *design*, not just the code)

**Mutation A — unwind instead of abandoning in place.** Added a cleanup inside the lease branch
before its `return`:

```
   × leaves the attempt worktree in place rather than unwinding it
   × keeps an already-persisted terminal decision when the post-terminal cleanup is blocked
      Tests  2 failed | 7 passed (9)
```

Exactly the two residue tests fail, and nothing else — the abandon-in-place rule is fenced
precisely, and no other test accidentally depends on it.

**Mutation B — delete the execute-phase Claude-call guard.**

```
   × does not launch the next Claude call when the record names a different process
   × leaves the attempt worktree in place rather than unwinding it
   × stops with lease_unverifiable and writes no owner record when the record is corrupt
      Tests  3 failed | 6 passed (9)
```

Both mutations were reverted; the suite is green at the commit.

---

## 6. Existing tests that changed, and why each change is correct

### 6.1 `leaseLifecycle` — "stops at the next phase boundary with stopReason lease_lost …" (task 12)

Broke on `expect(await readEventTypes(runDir)).toContain("lease_lost")`. All its other
assertions (`stopReason === "lease_lost"`, `attemptsUsed === 1`, the new owner's record
byte-identical) still pass unchanged.

**Correct consequence, not a regression.** That test rotates `owner-record.json` inside `verify`.
The `lease_lost` *event* is appended only by the heartbeat, when its affirm CAS fails and the
re-read names someone else (`leaseHeartbeat.ts`, `concludeLeaseLost`). Task 13's guard on the
attempt-artifact write immediately after `verify` observes the rotated record strictly earlier
than the next top-of-loop `affirmNow()` can, so the run stops before that CAS ever runs. This is
exactly the intended effect of the task ("narrowing the window from one phase to one side
effect"); the throttle-jump machinery the test used to reach the next affirm is now moot (kept,
with a note, because the widened runtime budget is sized for it).

`assertHeld` appends no event by design (task 10), so the stop is recorded by the terminal
transition instead. The assertion now checks that, and checks the *detail* too, which the old
one did not:

```ts
expect(await readEvents(runDir)).toContainEqual(
  expect.objectContaining({ type: "loop_cancelled", detail: "lease_lost" }),
);
```

### 6.2 `runLoop.integration` — five reconciliation tests

All five failed with `ENOENT … reconciliation-record.json` / `owner-transfer.json`. Each
overwrites `owner-record.json` from inside `execute` with `currentProcessInstanceId:
"pid:12345"`, then lets execute time out so the boundary machinery runs. Post-task-13 the guard
on the execute-timeout recovery artifact refuses first, so `persistBoundaryAnalysis` never runs.

**The refusal is correct**: a process whose run dir says another process instance owns the run
must not write reconciliation or owner-transfer artifacts — the *new* owner reconciles, not the
loser. But "assert nothing is written" would have deleted the only coverage of the ownership
reconciliation machinery, which is a different subsystem and still reachable.

Repair (5 lines): the fixtures now write `currentProcessInstanceId: buildProcessInstanceId()`.
Justification, verified before changing anything:

- The ownership signal those tests exercise is `ownerStatus: "lost"`, which flows into
  `derivePersistedOwnerStillSupported` → `evaluateOwnership`. The **process identity is never
  read** by the reconciliation logic; no assertion in any of the five referenced `pid:12345`.
- Nothing in `src/` ever *writes* `ownerStatus` (checked by grep: only
  `ownerController.ts:54/58` and `resumeLoop.ts:59` read it). So "record still names this
  process, but reports a lost owner" is precisely the case that remains reachable after L1,
  which makes the repaired fixtures *more* faithful than the originals, not less.
- Result: all 46 tests in that file pass with **every assertion unchanged**, including the exact
  `readEventTypes` sequences and the `owner_epoch_transferred` transfer artifacts.

A one-paragraph comment above the first of the five records this in the test file.

---

## 7. Concerns

1. **A self-performed owner-epoch transfer makes this process's own lease read as lost.**
   `persistBoundaryAnalysis` → `persistOwnerTransfer` writes epoch N+1 naming *this same
   process*; the heartbeat's `expected` still holds epoch N, and task 10's `namesSomeoneElse`
   compares epochs, so the next `assertHeld` concludes `lease_lost`. Observable consequence
   today is limited and benign: that branch has already persisted `exhausted`, so judgement call
   (a) keeps the terminal state and the only loss is the attempt worktree not being removed
   (its recorded `cleanupStatus` was already `"retained"`, so the artifacts stay truthful, and
   the resume path cleans residual worktrees). I did **not** "fix" it: it would mean weakening
   task 10's frozen supersession criterion, and per constraint 4 the safe direction for a lease
   is to refuse. Worth an explicit decision in a later layer if the transfer path ever needs to
   keep acting.
2. **`persistBoundaryAnalysis` is unguarded** (§2). It writes more, and more consequential,
   artifacts than the writes that *are* guarded — including an owner record on the transfer
   path. Left alone because Step 3 says "nowhere else"; both call sites happen to be immediately
   preceded by a guard. Flagging rather than silently extending the guard set.
3. **Cost of the guards.** ~22 `assertHeld()` calls per attempt, each an unthrottled read of
   `owner-record.json` (up to 3 reads with 50 ms backoff on failure). That is the design
   ("nothing is saved by skipping it" — task 10), but it is a real increase in per-attempt I/O
   and it makes `owner-record.json` a hot read path.
4. **Task 12's top-of-loop check is now nearly unreachable in the scenario that used to cover
   it.** With a guard before every side effect, a rotation is almost always discovered by a
   guard first. Check 2 (retry boundary) still has its own direct test; check 1 remains as a
   cheap, I/O-free backstop but its end-to-end coverage is now incidental. Not a defect — the
   two mechanisms are deliberately layered — but the coverage map's row 8 is now discharged by
   task 13's tests as much as by task 12's.
5. **`state/stateMachine.ts` was modified**, which the brief did not list. 6 lines, additive,
   derived from the existing table; no existing behavior touched.

---

## 8. Files changed

| File | Change |
|---|---|
| `src/controller/runLoop.ts` | +94/−12: `isLeaseStopError`, `guardedWriteArtifacts`, 22 guards, the lease branch at the top of the attempt-body catch, and the lease re-classification in the workspace-retry catch |
| `src/state/stateMachine.ts` | +6: `isTerminalRunStatus`, derived from `legalTransitions` |
| `tests/controller/leaseLifecycle.integration.test.ts` | +4 tests (3 from the brief + the post-terminal case); `readEvents` helper; `planningRunState` helper (removes the inline duplicate in the check-2 test); the event assertion described in §6.1 |
| `tests/controller/runLoop.integration.test.ts` | 5 fixture identities + one explanatory comment (§6.2) |

## 9. Self-review findings, fixed before reporting

- **Over-guarding check.** Re-walked every `writeAttemptArtifacts` /
  `writeCompletedAttemptArtifacts` / `cleanup*` / `createAttemptWorkspace` / `runPhaseWithTimeout`
  occurrence in the file (§2). The two sites in the `catch` are deliberately unguarded; nothing
  else in the attempt body is.
- **No guard is behind a condition that could skip it.** Every guard is a straight-line statement
  immediately above its side effect. At site 965 the *write* is conditional, but the guard sits
  inside `guardedWriteArtifacts` immediately before that write, so the guard-to-effect
  relationship is unconditional.
- **An adapter cannot spoof a lease stop.** `runPhaseWithTimeout` wraps any operation rejection
  in `PhaseExecutionError`, so an adapter throwing `RunLeaseLostError` cannot reach the lease
  branch. The only sources of lease errors inside the `try` are the guards.
- Moved the retry-boundary guard (1142) *outside* the `try` around `cleanupAttemptWorkspace`
  after noticing that inside it, a refusal would be caught there and mis-transitioned to
  `failed` with the lease error as the failure reason.
- Added `const completedVerification = verification` (with a comment) because the guard closure
  widens the mutable `verification` let back to `| null`.
- Removed the 14-line inline `RunState` literal duplicated by the new test by extracting
  `planningRunState`.

---

# Fix round 1 — the observable half of the contract (review findings 1–3)

Commit: the `fix: append the lease_lost event from the guard that concludes supersession`
commit (referenced by subject, not SHA, so amending cannot leave this line stale).
Suite: **23 files / 346 tests green** (no new cases — new assertions inside existing tests),
`npm run typecheck` and `npm run build` clean. Neither the guard placement nor the
abandon-in-place logic changed; `src/controller/runLoop.ts` is byte-identical to the first
commit.

## F1.1 Emit site chosen: inside `assertHeld` — and it was not a free choice

I picked the single site in `src/controller/leaseHeartbeat.ts`, not the two/three lease branches
in `runLoop.ts`. The deciding reason is a constraint, not a preference:

**Only `assertHeld` can see both sides of the comparison.** The required detail is the observed
*and* expected owner records. `RunLeaseLostError`'s message carries the observed side alone
(`owner record now names X at epoch Y`), and `expected` is closure state inside
`startLeaseHeartbeat` that `runLoopFromState` has no access to at all. Emitting from the lease
branches could therefore only ever have produced half the artifact the finding asks for — unless
I widened the error class or made `runLoop` re-read the record itself (a second, racy read that
still could not name `expected`). So the runLoop-side option was not merely more verbose; it
could not satisfy the requirement.

Two supporting reasons:

- **It closes the hole where the hole is made.** `assertHeld` is what sets `superseded = true`,
  and that is exactly what makes `concludeLeaseLost`'s append unreachable afterwards
  (`runAffirm` returns early on `superseded`). Fixing it at that line keeps the invariant
  "whichever mechanism concludes supersession appends the event" local and checkable, instead of
  splitting the conclusion from its consequence across two modules.
- **One emit site, and every future `assertHeld` consumer inherits it.** The `createAttemptWorkspace`
  catch — a third lease branch that the runLoop-side option would have had to remember —
  gets the event for free.

### Why making `assertHeld` a writer is acceptable

Stated explicitly, as asked:

- It writes **only on the two paths where it is about to throw**. The held-lease fast path — the
  one that runs before all 21 guarded side effects — remains a pure read. This adds no writes per
  side effect; it adds at most one append per run, at the moment the run is already stopping.
- What it appends is an **append to `events.jsonl`**: no lock is taken, the owner-transfer lock
  is untouched, and it cannot interfere with the CAS chain that `affirmOwnerLease` /
  `releaseOwnerLease` depend on. The "takes no lock, so nothing is saved by skipping it"
  reasoning in `assertHeld`'s own comment still holds.
- The design already has refusal paths append events, and already states that a refused
  directory is never byte-identical to its prior state — so a refusal that writes an event is
  within the established contract, and `checkRunLease` (§7) already does exactly this.
- It cannot run before `initializeRunFiles` (requirement 14): the heartbeat is started only after
  that call in `runLoop`, and after the CAS claim in `resumeLoop`. Task 8's requirement-14 test
  still passes.

### How the append is kept from throwing

Extracted `appendLeaseEvent(type, detail)`, which wraps `appendEvent` in `try {} catch {}` and
swallows — the same discipline Task 9's fix round applied to `concludeLeaseLost`, whose inline
append this now replaces so there is exactly one guarded writer and one detail-shape source.
The comment records the second reason the swallow matters here, which is specific to this task:
out of `assertHeld` an unguarded append failure would **replace a lease refusal with an I/O
error** — failing open on the one path whose entire job is to fail closed. The `throw` follows
the append unconditionally.

Also added a `!superseded` check around the append so the event is appended **exactly once per
run by whichever mechanism concludes first**, rather than a duplicate when the heartbeat got
there before a guard. Pinned by `expect(leaseLostEvents).toHaveLength(1)`.

## F1.2 What the detail contains

Identical string for both mechanisms, from the shared `describeSupersession`:

```
expected pid:63155:1769470000000 at epoch 1, observed pid:999:9000 at epoch 99
```

Process instance **and** epoch on each side, which answers "who took this run over". Asserted by
exact equality (not `toContain`) in the end-to-end test, so a future change that drops either
side fails.

## F2 The `lease_unverifiable` path — a distinct type, and why I emit one at all

`lease_unverifiable` gets its own event type, emitted immediately before the
`RunLeaseUnverifiableError` throw:

```
expected pid:63155:1769470000000 at epoch 1, owner record unreadable after 3 attempts: <lastError>
```

- **Not `lease_lost`**, because this path deliberately claims no supersession: there is no
  observed owner to name, and naming one would assert precisely what could not be read. The
  brief's `expect(...).not.toContain("lease_lost")` assertion now proves that distinction rather
  than the absence of any record.
- **Emitted anyway**, because it is the remaining zero-trace case that finding 2 describes: on
  the already-terminal escape a refusal otherwise leaves a run reporting `succeeded`/`exhausted`
  with nothing at all on disk. It still names the process that refused and why.
- Finding 2's `lease_lost` case is covered by the same change: the post-terminal escape now
  always has the `lease_lost` event with full detail, appended by the guard that concluded. The
  returned state stays terminal (accepted as correct by the review), so the fix is purely the
  event, as directed.

## F3 Pinning the changed execution path

All **four** re-fixtured reconciliation tests that now self-transfer (or are overtaken), trip the
guard, and take the post-terminal escape are pinned, not just the ones whose event sequence
forced an update:

| Test | Added |
|---|---|
| `writes an OWNER_LOST reconciliation record …` | `lease_lost` present + `worktrees/` retains `attempt-1` |
| `persists owner transfer artifacts …` | `lease_lost` in the exact event sequence + retained worktree + exact detail |
| `preserves the winner reconciliation view …` | same three |
| `preserves a synthesized winner reconciliation view …` | same three |

Each carries a comment saying **that the path changed**, not only that the identity did — the gap
the reviewer named. The details also make the two causes distinguishable at a glance: the
self-transfer tests assert `expected <this pid> at epoch 1, observed <this pid> at epoch 2` (the
same process at two epochs — the §7 concern 1 wrinkle, now observable), while the mocked ones
assert `observed pid:other-controller at epoch 2` (a genuine foreign takeover).

## Test and mutation output

### End-to-end proof the event reaches a real run's log (F1)

`tests/controller/leaseLifecycle.integration.test.ts` — real `runLoop`, real `startLeaseHeartbeat`,
real `events.jsonl`; the record is rotated from inside `plan` and the guard before the execute
Claude call concludes:

```ts
const leaseLostEvents = (await readEvents(runDir)).filter((event) => event.type === "lease_lost");
expect(leaseLostEvents).toHaveLength(1);
expect(leaseLostEvents[0].detail).toBe(
  `expected ${buildProcessInstanceId()} at epoch 1, observed pid:999:9000 at epoch 99`,
);
```

### Mutation C — remove the emit from `assertHeld` (keep `superseded = true`)

```
   × lease heartbeat lifecycle > does not launch the next Claude call when the record names a different process
   × runLoop > writes an OWNER_LOST reconciliation record with transferred ownership …
   × runLoop > persists owner transfer artifacts and continuation eligibility …
   × runLoop > preserves the winner reconciliation view when another controller already completed the transfer
   × runLoop > preserves a synthesized winner reconciliation view …
      Tests  5 failed | 50 passed (55)
```

The new end-to-end test and all four finding-3 pins fail. Reverted.

### Fence A re-confirmed — cleanup added to the lease branch (unwind instead of abandon)

```
   × leaves the attempt worktree in place rather than unwinding it
   × keeps an already-persisted terminal decision when the post-terminal cleanup is blocked
   × runLoop > writes an OWNER_LOST reconciliation record …
   × runLoop > persists owner transfer artifacts …
   × runLoop > preserves the winner reconciliation view …
   × runLoop > preserves a synthesized winner reconciliation view …
      Tests  6 failed | 49 passed (55)
```

Still holds, and now **stronger**: the four newly pinned tests catch this mutation too, where
before they were silent. Reverted.

### Fence B re-confirmed — execute-phase Claude-call guard deleted

```
   × does not launch the next Claude call when the record names a different process
   × leaves the attempt worktree in place rather than unwinding it
   × stops with lease_unverifiable and writes no owner record when the record is corrupt
      Tests  3 failed | 6 passed (9)
```

Still holds. Reverted; `git diff src/controller/runLoop.ts` against the first commit is empty.

### Covering files, then everything

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts \
    tests/controller/leaseHeartbeat.test.ts tests/controller/runLoop.integration.test.ts
 Test Files  3 passed (3)
      Tests  67 passed (67)

$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
 Test Files  23 passed (23)
      Tests  346 passed (346)

$ npm run typecheck      (clean)
$ npm run build          (clean)
```

## Files changed in this round

| File | Change |
|---|---|
| `src/controller/leaseHeartbeat.ts` | +47/−15: `appendLeaseEvent` (guarded, shared), `describeSupersession` (shared detail shape), the exactly-once `lease_lost` append in `assertHeld`, the distinct `lease_unverifiable` append; `concludeLeaseLost` now routes through the shared helpers with no behavior change |
| `tests/controller/leaseLifecycle.integration.test.ts` | end-to-end `lease_lost` type+detail assertions; `lease_unverifiable` type+detail assertions; `buildProcessInstanceId` import |
| `tests/controller/runLoop.integration.test.ts` | `readEventDetails` helper; `readdir` import; four finding-3 pins (event sequence, retained worktree, exact detail) |

`src/controller/runLoop.ts` and `src/state/stateMachine.ts`: unchanged this round.

## Note on the deferred Minor items

Not addressed, per instruction. One correction I accept for the record: the guard count is **21
sites across 14 statements** (`createAttemptWorkspace` was double-counted in §1/§2 above), and
the per-attempt I/O figure in §7 concern 3 is ~4× high because the branches are mutually
exclusive — a single attempt traverses roughly 5–6 guards, not 21.

---

# Fix round 2 — the exactly-once gate was asymmetric (new Important finding)

Commit: the `fix: conclude supersession exactly once through a single shared gate` commit.
Suite: **23 files / 347 tests green** (+1 new test), `npm run typecheck` and `npm run build`
clean. `src/controller/runLoop.ts` and `src/state/stateMachine.ts` are **byte-identical** to fix
round 1 (`git diff HEAD --numstat` on both returns nothing) — this round is confined to
`leaseHeartbeat.ts` and its test.

The finding is correct and was introduced by my own fix: I gated `assertHeld`'s append on
`superseded` but left `concludeLeaseLost` setting the flag and appending unconditionally, so the
invariant my own assertion claimed (`toHaveLength(1)`) was only true for the orderings the suite
happened to exercise.

## F2.1 The gate: one shared conclusion, not two similar gates

I took the shared-helper option rather than adding a second gate, because the two entry points
have *different* obligations (one throws, one invokes a callback) and only the append is common
to both. Two gates that must stay provably equivalent is a maintenance claim; one gate is a fact.

```ts
const concludeSupersededOnce = async (persisted: OwnerRecord): Promise<void> => {
  if (superseded) {
    return;
  }

  superseded = true;
  await appendLeaseEvent("lease_lost", describeSupersession(persisted));
};
```

`assertHeld` now calls it and then throws; `concludeLeaseLost` calls it and then signals. There is
exactly one place that reads or writes `superseded` for the purpose of concluding, and exactly one
`appendLeaseEvent("lease_lost", …)` call in the module.

**Ordering:** the check precedes the assignment, deliberately, and the reason is written at the
call site: on the heartbeat-first path `concludeSupersededOnce` is itself what sets the flag, so a
naive `if (!superseded)` *after* the assignment would suppress the event on the very path that is
supposed to emit it. That failure mode is now pinned by three tests (mutation output below), not
just by the comment.

## F2.2 What the gate covers, and why `onLeaseLost` is outside it

The gate covers **the append only**. `onLeaseLost` stays unconditional, and this is not a
conflation I am leaving unargued — the two are not interchangeable:

- `superseded` records that supersession has been **concluded**, not that the caller has been
  **signalled**. `assertHeld` sets the flag and never signals: it throws into its caller instead
  (task 10's design, unchanged).
- So in exactly the interleaving this finding is about — guard concludes first, affirm arrives
  second — gating the callback on `superseded` would suppress the **only** signal that ever
  existed, leaving the caller's `leaseLoss` slot `null`. That is a real behavioral loss, not a
  removed redundancy: it would make task 12's boundary checks depend on which mechanism won a
  race.
- A redundant signal, by contrast, costs nothing: it is an idempotent assignment to a
  caller-owned slot, and by §8's no-new-authority rule it can only ever cause a *stop*.

Asserted explicitly in the new test: `expect(lost).toHaveLength(1)` alongside
`expect(leaseLost).toHaveLength(1)` — the callback fires on a path where the append is suppressed.

## F2.3 The new test hits the window by construction, not by luck

`tests/controller/leaseHeartbeat.test.ts` → `assertHeld` →
*"appends one lease_lost event when a guard concludes while an affirm is already in flight"*.
No production hook; only the module's public surface plus the real filesystem.

1. `affirmNow()` chains `runAffirm` onto an already-resolved `queue`, so `runAffirm` is scheduled
   as a **microtask** and has not run when `affirmNow()` returns. The promise is deliberately not
   awaited.
2. `assertHeld()` is then called synchronously and runs to its first `await`, **issuing** its one
   owner-record read before yielding.
3. The microtask drains: `runAffirm` passes its `stopped || superseded` entry check — the flag is
   still `false`, which is the *precondition of the race* and is guaranteed here by microtask
   ordering, not hoped for — and suspends inside `affirmOwnerLease`.
4. `assertHeld`'s single read resolves ahead of `affirmOwnerLease`'s lock-acquire → recover →
   read → CAS chain (roughly eight filesystem round trips against one). It concludes, sets the
   flag, appends.
5. `runAffirm`'s CAS fails its precondition, it re-reads, finds the rotation, and reaches
   `concludeLeaseLost` **second** — where the ungated append produced the duplicate.

Real timers, because step 4's margin rests on real filesystem work. Step 3 is exact; step 4 is a
robust asymmetry (1 fs op vs ~8) rather than a knife-edge — and the mutation below is what proves
the ordering actually occurs, since a duplicate can only be produced if the guard appended first
and the affirm appended second.

## Test and mutation output

### The new test, and the covering files

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts
 ✓ tests/controller/leaseHeartbeat.test.ts (13 tests) 308ms
      Tests  13 passed (13)

$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts \
    tests/controller/leaseLifecycle.integration.test.ts tests/controller/runLoop.integration.test.ts
 Test Files  3 passed (3)
      Tests  68 passed (68)
```

### Mutation D — restore the pre-fix asymmetry (`concludeLeaseLost` appends unconditionally)

```
   × assertHeld > appends one lease_lost event when a guard concludes while an affirm is already in flight
     → expected [ { type: 'lease_lost', …(2) }, …(1) ] to have a length of 1 but got 2
      Tests  1 failed | 12 passed (13)
```

Two `lease_lost` events, which is only possible if the guard concluded first and the in-flight
affirm appended second — so this is simultaneously the mutation fence and the proof that the
interleaving is genuinely reached. Reverted.

### Mutation E — the mis-ordered gate the coordinator warned about (check *after* the assignment)

```
   × startLeaseHeartbeat > reports lease loss only after a re-read confirms a different owner
   × assertHeld > appends one lease_lost event when a guard concludes while an affirm is already in flight
   × lease heartbeat lifecycle > does not launch the next Claude call when the record names a different process
      Tests  3 failed | 19 passed (22)
```

The heartbeat-first path, the interleaving path and the guard-first end-to-end path all fail — so
"emits on the heartbeat-first path" is explicitly asserted, as asked, and not merely assumed.
Reverted.

### Existing exactly-once assertion, and everything

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
 Test Files  23 passed (23)
      Tests  347 passed (347)

$ npm run typecheck      (clean)
$ npm run build          (clean)
```

The fix-round-1 assertion `expect(leaseLostEvents).toHaveLength(1)` in
`leaseLifecycle.integration.test.ts` still passes, and the heartbeat-first test in
`leaseHeartbeat.test.ts` was strengthened from `expect(raw).toContain("lease_lost")` to an exact
count plus exact detail so the mis-ordered-gate failure mode cannot pass there either.

## Files changed in this round

| File | Change |
|---|---|
| `src/controller/leaseHeartbeat.ts` | +32/−7: `concludeSupersededOnce` (the single gate, check before assignment); `concludeLeaseLost` and `assertHeld` both route through it; `onLeaseLost` deliberately left outside the gate, with the reasoning recorded at the call site |
| `tests/controller/leaseHeartbeat.test.ts` | +1 test for the interleaving; heartbeat-first path strengthened to exact count + exact detail |

Out of scope this round, per instruction and still in the ledger for the whole-branch review: the
self-performed-transfer interaction and `persistBoundaryAnalysis` being unguarded.
