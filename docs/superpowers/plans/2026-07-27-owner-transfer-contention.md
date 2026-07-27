# Owner Transfer Contention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a legitimate owner transfer from being silently dropped when the owner-transfer lock is contended or the CAS base has drifted, and guard the run loop's largest unguarded side effect.

**Architecture:** Split the one overloaded error class into two siblings so every consumer must re-decide what it does; keep retry policy in the controller and none in `fileStore`; serialize this process's transfer against its own heartbeat through the heartbeat's existing queue, which removes self-inflicted contention by construction; add two guards to `persistBoundaryAnalysis`.

**Tech Stack:** TypeScript (NodeNext ESM), Vitest, no new dependencies.

**Spec:** [`docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`](../specs/2026-07-27-owner-transfer-contention-design.md). The spec is the source of truth; where this plan and the spec disagree, the spec wins and the plan is the defect.

## Deliberate deviation from the writing-plans skill

This plan gives **interface signatures, test requirements and trap lists — not copy-paste implementations**, on the human's explicit instruction. L1's retrospective found that fully-coded plans produced fast implementation and switched off implementer judgement: every omission in the plan landed verbatim in the code and had to be caught by post-hoc review. You are expected to design the code. If a requirement here looks wrong, say so before implementing it.

## Global Constraints

- Run tests with `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`. Also run `npm run typecheck` and `npm run build` before declaring a task complete.
- **Zero paid Claude calls.** Use `ScriptedAdapter` or hand-written stub adapters, as the existing tests do. A real Claude call needs prior human approval.
- **No new authority.** Every change here either refuses more or retries the same CAS against the same evidence. Nothing relaxes a CAS, an ownership verdict, or a takeover condition.
- **Do not weaken or delete any of L1 §12's nineteen test requirements** (`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`). Requirements 2, 5, 7, 15, 17 and 19 exist to kill specific wrong implementations, are mutation-verified, and are under a standing human instruction to stay.
- **No terminal-state changes.** No exit code, no run status, no `persistTerminalState` call moves.
- **`ReconciliationRecord` schema is frozen.** New evidence goes into the event stream.
- Every task ends with the full suite green, not just its own tests.
- Every new test must be **mutation-verified**: break the implementation it names, watch it fail, restore. Record the mutation and the observed failure in the task report. A test that survives its mutation has not discharged its requirement.

## File Structure

| File | Change | Responsibility after the change |
|---|---|---|
| `src/persistence/fileStore.ts` | modify | Reports *which* precondition failed. Holds no retry, backoff or policy. |
| `src/controller/leaseHeartbeat.ts` | modify | Gains `runExclusive`; keeps `assertHeld` out of the queue. |
| `src/controller/runLoop.ts` | modify | Owns retry policy, the contention event, the exclusive span, and both new guards. |
| `src/controller/resumeLoop.ts` | modify | Stays fail-closed; stops describing a lock failure as a CAS failure. |
| `tests/persistence/fileStore.test.ts` | modify | Error-class discrimination at the source. |
| `tests/controller/leaseHeartbeat.test.ts` | modify | `runExclusive` serialization and queue survival. |
| `tests/controller/leaseLifecycle.integration.test.ts` | modify | Transfer/affirm interleaving, self-transfer, guards. |
| `tests/controller/resumeLoop.integration.test.ts` | modify | Resume stays fail-closed on a busy lock. |

Existing test files are large. Add to the file whose subject matches; do not create parallel files.

---

### Task 1: Split the error class and re-decide all four consumers

**Files:**
- Modify: `src/persistence/fileStore.ts` (new class near `OwnerTransferPreconditionError` at `:387`; both throw sites in `acquireOwnerTransferLock` at `:499` and `:504`)
- Modify: `src/controller/runLoop.ts:710-717` (the `catch` in `persistBoundaryAnalysis`)
- Modify: `src/controller/resumeLoop.ts:136-139` (the `resume_denied` detail)
- Test: `tests/persistence/fileStore.test.ts` (test 1), `tests/controller/leaseHeartbeat.test.ts` (test 2), `tests/controller/resumeLoop.integration.test.ts` (test 3), `tests/controller/leaseLifecycle.integration.test.ts` (test 4)

**Interfaces:**
- Produces: `export class OwnerTransferLockBusyError extends Error` — a **sibling** of `OwnerTransferPreconditionError`, both extending `Error` directly. Set `this.name` to the class name, matching the existing class's shape at `:389`.
- Produces: an appended event whose type names owner-transfer contention (suggested `owner_transfer_contended`), with a detail stating the transfer was abandoned because the lock was held. Later tasks reuse this event type verbatim — fix its spelling here.
- Consumes: nothing.

**What each consumer must end up doing** (spec §3 — four call paths, not two):

| Call path | Required behaviour |
|---|---|
| `leaseHeartbeat.ts:151` `runAffirm` | lock-busy is transient: return, swallowed, retried next tick. It must **never** reach the supersession decision. |
| `leaseHeartbeat.ts:208` `stop` → `releaseOwnerLease` | unchanged. The bare `catch {}` at `:209` is already correct. Do not add discrimination it has no use for. |
| `runLoop.ts:711` | lock-busy becomes its own branch: append the contention event, then re-read and re-evaluate exactly as the CAS-mismatch branch does. **No retry in this task** — Task 2 adds it. |
| `resumeLoop.ts:137` | stays fail-closed. The detail must stop asserting `claim CAS failed` when no CAS was evaluated. |

**Traps:**
- Making the new class a **subclass** of `OwnerTransferPreconditionError` defeats the entire task: every `instanceof` branch keeps matching and nothing is re-decided. Siblings.
- `runLoop.ts:711` rethrows anything that is not an `OwnerTransferPreconditionError`. If you add the class without adding the branch, a busy lock stops being a dropped transfer and becomes a crashed run — worse than the defect being fixed. The suite will not catch this for you; no existing test contends the lock through `runLoop`.
- The `leaseHeartbeat.ts:149-150` comment already claims lock contention is swallowed. It is false today. After this task it is true — leave the comment, do not "correct" it.

- [ ] **Step 1: Write the failing tests.** Four, all mutation-targeted:
  1. `acquireOwnerTransferLock` throws `OwnerTransferLockBusyError` (not `OwnerTransferPreconditionError`) when the lock is held by a live pid, and a CAS mismatch still throws `OwnerTransferPreconditionError`. Assert the two are **not** `instanceof` each other. Fabricate the busy lock by writing `.owner-transfer.lock` directly, as `tests/persistence/fileStore.test.ts:276` and `:567` already do, with `holderProcessInstanceId: pid:<this process>` so stale-recovery declines to break it.
  2. **Spec requirement 9:** the heartbeat's affirm hitting a busy lock appends no `lease_lost`, concludes no supersession, and affirms normally on a later tick.
  3. **Spec requirement 8:** resume claiming against a busy lock still raises `ResumeNotEligibleError` and appends `resume_denied`, and the detail does **not** claim a CAS failure. Assert the detail text.
  4. **Spec requirement 2 (partial — the event only):** a transfer abandoned because the lock is held appends the contention event, and the reconciliation record still reports `newOwnerEpoch: null`.
- [ ] **Step 2: Run them and confirm each fails for the stated reason,** not for a setup error. A test that fails because the fixture is wrong proves nothing.
- [ ] **Step 3: Implement.** New class, both throw sites, and the four consumer decisions above.
- [ ] **Step 4: Run the full suite, typecheck and build.**
- [ ] **Step 5: Mutation-verify.** For each new test, apply the mutation it targets, observe the failure, restore: (1) make the new class extend `OwnerTransferPreconditionError`; (2) route lock-busy into the supersession path; (3) restore the hardcoded `claim CAS failed:` detail; (4) delete the contention event append.
- [ ] **Step 6: Commit.** Message states that the two classes now have one meaning each.

---

### Task 2: Bounded retry for a contended transfer — and only for that

**Files:**
- Modify: `src/controller/runLoop.ts` (`persistOwnerTransfer` at `:600-618`; new constants beside `BUDGET_EXHAUSTED_REASON` at `:75`)
- Test: `tests/controller/leaseLifecycle.integration.test.ts`

**Interfaces:**
- Consumes: `OwnerTransferLockBusyError` and the contention event from Task 1.
- Produces: two exported-or-module-level constants for the attempt count and the backoff delay. Name them for the lock, not for the loop. The retry lives **inside `persistOwnerTransfer`, around `writeOwnerTransferArtifacts` (`:608`) only** — not around `appendEvent`, which must stay exactly-once.
- Produces: on exhaustion, `persistOwnerTransfer` rethrows `OwnerTransferLockBusyError`; the caller's branch from Task 1 appends the event and re-evaluates.

**Retry budget:** state the arithmetic in your task report. The whole retry window runs inside what becomes an exclusive span in Task 4, holding off this process's own affirms for its duration, so it must stay far below `LEASE_TTL_MS` (90 000 ms, `src/ownership/lease.ts:5`). A contender's critical section is a handful of file writes. Three attempts with a ~50 ms backoff (≤150 ms total, under 0.2% of the TTL) satisfies both ends; if you choose differently, justify it against those two numbers.

**Traps:**
- **Retrying a CAS mismatch is the one thing this plan must not do.** A mismatch means the evidence the transfer was computed from is stale; re-running the CAS against a freshly read record would be a new ownership decision wearing an old decision's justification. Lock-busy only.
- Retrying around `appendEvent` as well as the write would emit duplicate `owner_epoch_transferred` events on a retry that eventually succeeds.
- A retry loop that swallows the final failure turns a dropped transfer into a *silent* dropped transfer, which is the original defect.

- [ ] **Step 1: Write the failing tests.** Three:
  1. **Spec requirement 1:** a transfer whose first attempt finds the lock held and whose next attempt finds it free **completes**, and the reconciliation record carries the new epoch. Release the lock from the test between attempts — deterministically, not by racing a real timer.
  2. **Spec requirement 2 (completion):** a lock held for the whole retry window leaves `newOwnerEpoch: null`, `eligibleForContinuation: false`, and the contention event appended exactly once.
  3. **Spec requirement 3:** a CAS mismatch produces **zero** retries. Assert the attempt count — count calls to the write, not just the outcome; an outcome-only assertion passes against the wrong implementation.
- [ ] **Step 2: Run them and confirm each fails for the stated reason.**
- [ ] **Step 3: Implement the bounded retry.**
- [ ] **Step 4: Run the full suite, typecheck and build.**
- [ ] **Step 5: Mutation-verify:** (1) remove the retry; (2) extend the retry to CAS mismatch; (3) raise the attempt bound to infinite and confirm test 2 hangs or fails rather than passing.
- [ ] **Step 6: Commit.**

---

### Task 3: `LeaseHeartbeat.runExclusive`

**Files:**
- Modify: `src/controller/leaseHeartbeat.ts` (type at `:19-24`, queue at `:41`, near `affirmNow` at `:177`)
- Modify: `src/controller/runLoop.ts:789-794` (`INERT_LEASE_HEARTBEAT`)
- Test: `tests/controller/leaseHeartbeat.test.ts`

**Interfaces:**
- Produces: `runExclusive: <T>(fn: () => Promise<T>) => Promise<T>` on the `LeaseHeartbeat` type. Chains `fn` onto the existing `queue`; resolves or rejects with `fn`'s result.
- Produces: `INERT_LEASE_HEARTBEAT.runExclusive` **must execute `fn` and return its result.** It is the default heartbeat for `runLoopFromState` (`runLoop.ts:810`), so a no-op version silently deletes every owner transfer performed without a live heartbeat.

**Traps:**
- **Do not copy `affirmNow`'s shape.** `queue = queue.then(runAffirm, runAffirm); return queue` (`:177-180`) is safe only because `runAffirm` never rejects. `fn` can. Storing a rejecting promise back into `queue` poisons the chain: every later affirm inherits the rejection and `stop`'s `await queue.catch(() => {})` (`:200`) becomes the only surviving consumer. The stored chain and the returned promise must be **different** promises — the stored one absorbs the rejection, the returned one carries it out.
- `assertHeld` stays **outside** the queue. It takes no lock, must never wait behind an affirm, and the exactly-once supersession gate documented at `:74-78` depends on that. Do not "tidy" it into the chain.
- `runExclusive` takes **no position** on `stopped` or `superseded`. It serializes; it does not decide. Refusal belongs to the guards in Task 5. Adding a `superseded` check here would duplicate a decision that already has one home.
- `fn` must not re-enter the queue (no `affirmNow`, no nested `runExclusive`) — that self-deadlocks.

- [ ] **Step 1: Write the failing tests.** Three:
  1. Serialization: an affirm that becomes due while `fn` is in flight does not execute until `fn` resolves. Assert the observed order, using the injectable `now` (`:30`) and a deferred `fn` rather than wall-clock sleeps.
  2. **Spec requirement 10:** a rejecting `fn` propagates its error to the `runExclusive` caller **and** a subsequent affirm still runs. This is the poisoned-chain killer.
  3. `INERT_LEASE_HEARTBEAT.runExclusive` executes `fn` and returns its value.
- [ ] **Step 2: Run them and confirm each fails for the stated reason.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite, typecheck and build.**
- [ ] **Step 5: Mutation-verify:** (1) make `runExclusive` call `fn` directly without chaining; (2) store the rejecting promise back into `queue`; (3) make the inert `runExclusive` a no-op returning `undefined`.
- [ ] **Step 6: Commit.**

---

### Task 4: Run the transfer inside the exclusive span

**Files:**
- Modify: `src/controller/runLoop.ts:683-717` (inside `persistBoundaryAnalysis`)
- Test: `tests/controller/leaseLifecycle.integration.test.ts`

**Interfaces:**
- Consumes: `heartbeat.runExclusive` (Task 3), the retry (Task 2).
- Produces: no new exported surface. The span covers **read the owner record → evaluate ownership → CAS transfer (with retry) → `adopt`** and returns whatever the surrounding code needs (`ownership`, `nextOwnerEpoch`, `eligibleForContinuation`, the possibly re-read `ownerRecord`).

**Span boundaries — exact:** starts at the `readOwnerRecord` on `:683`, ends immediately after `heartbeat.adopt(...)` on `:706` (and after the catch-path re-read on `:715-716`). It does **not** include `evaluateRunBoundary` before it or `writeBoundaryArtifacts` after it; there is no reason to make the heartbeat wait behind artifact writes.

**Traps:**
- `adopt` must stay **inside** the span and **synchronously** after the CAS that produced the record. That is the whole point: it is what closes the window parked at the end of L1 to zero. Any `await` inserted between the CAS and `adopt` reopens it.
- Including `readOwnerRecord` is not optional. If the span starts after the read, the record can drift between read and CAS — which is defect 2, the one this task exists to remove.
- The catch path's re-read (`:715`) is a read of the same contended record and belongs inside the span too.

- [ ] **Step 1: Write the failing tests.** Two:
  1. **Spec requirement 4:** an affirm falling due while a transfer is in flight cannot execute until the span completes; the transfer sees **zero** CAS failures and no `lease_lost` is appended. Drive this deterministically (injected `now`, a deferred write) — L1 already carries one test that depends on real filesystem timing and it was flagged as a flake risk; do not add a second.
  2. **Spec requirement 5:** a self-performed transfer appends **no** `lease_lost` event, with `adopt` inside the span.
- [ ] **Step 2: Run them and confirm each fails for the stated reason.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite, typecheck and build.**
- [ ] **Step 5: Mutation-verify:** (1) start the span after `readOwnerRecord`; (2) move `adopt` outside the span.
- [ ] **Step 6: Commit.**

---

### Task 5: Guard `persistBoundaryAnalysis`

**Files:**
- Modify: `src/controller/runLoop.ts:640-660` (function entry) and `:720` (`writeBoundaryArtifacts`)
- Test: `tests/controller/leaseLifecycle.integration.test.ts`

**Interfaces:**
- Consumes: `heartbeat.assertHeld` and the existing `guardedWriteArtifacts` wrapper (already used at `:957` and `:977`).
- Produces: no new exported surface.

**Placement — exact:**
- entry `assertHeld` **before everything**, including `readOwnerRecord`, because `readOwnerRecord` runs `recoverInterruptedOwnerTransfer` (`fileStore.ts:555`), which writes. A superseded process must not perform crash recovery on a run it no longer owns.
- the guard goes **before the healthy early return at `:658-660`, not after it.** Moving it after looks like a free optimization and is not: a superseded process would evaluate a boundary and return normally, letting the caller proceed to its next side effect as though the lease still held. The guard's job is to stop the process, not to protect one write. Both call sites (`:961`, `:993`) are rare failure paths, so the extra read costs nothing worth having.
- `writeBoundaryArtifacts` goes through `guardedWriteArtifacts`, closing the drift window between the entry guard and the write — a window that contains a potentially complete epoch transfer.
- **No third guard.** The transfer keeps relying on its CAS.

**Traps:**
- Guards refuse by throwing, exactly like L1's existing fourteen `assertHeld` sites. Do not invent a return-code refusal for these two.
- Both call sites precede terminal persistence (`:961` before `:962`, `:993` before its throw), so no guard added here may change a reported outcome. If a test starts showing a different terminal status or exit code, the guard is in the wrong place.

- [ ] **Step 1: Write the failing tests.** Two:
  1. **Spec requirement 6:** an already-superseded process calling `persistBoundaryAnalysis` is refused **before** `readOwnerRecord` — assert that no recovery-on-read write occurred, not merely that the call threw.
  2. **Spec requirement 7:** a process superseded *after* the entry guard passes writes no boundary or reconciliation artifacts.
- [ ] **Step 2: Run them and confirm each fails for the stated reason.**
- [ ] **Step 3: Implement both guards.**
- [ ] **Step 4: Run the full suite, typecheck and build.**
- [ ] **Step 5: Mutation-verify:** (1) delete the entry guard; (2) move the entry guard after the healthy early return; (3) unwrap `writeBoundaryArtifacts`.
- [ ] **Step 6: Commit.**

---

## Spec requirement → task coverage

| Spec §6 requirement | Task |
|---|---|
| 1 — retry succeeds on a later attempt | 2 |
| 2 — exhausted retry leaves `newOwnerEpoch: null` + contention event | 1 (event), 2 (exhaustion) |
| 3 — CAS mismatch retries zero times | 2 |
| 4 — affirm cannot interleave with a transfer | 4 |
| 5 — self-transfer emits no `lease_lost` | 4 |
| 6 — entry guard precedes `readOwnerRecord` | 5 |
| 7 — no artifacts written after supersession | 5 |
| 8 — resume stays fail-closed, detail is honest | 1 |
| 9 — heartbeat treats lock-busy as transient | 1 |
| 10 — rejecting `fn` does not poison the queue | 3 |

| Spec section | Task |
|---|---|
| §3 error taxonomy, all four consumers | 1 |
| §4 `runExclusive` | 3 |
| §5.1 shape / §5.4 guards | 5 (guards), 4 (span) |
| §5.2 retry policy | 2 |
| §5.3 evidence | 1 (event), 2 (exhaustion path) |

## Definition of done

- All ten spec requirements have a test, and every test has recorded mutation evidence.
- `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run` green (356 + new), `npm run typecheck` and `npm run build` clean.
- No L1 §12 requirement weakened or deleted.
- Zero paid Claude calls.
