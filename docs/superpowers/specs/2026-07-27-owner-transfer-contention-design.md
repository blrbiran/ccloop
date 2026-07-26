# Owner Transfer Contention Design

> Status: proposed on 2026-07-27
> Scope: stop a legitimate owner transfer from being silently dropped when the owner-transfer lock is contended or the CAS base is stale, and guard the largest unguarded side effect in the run loop.
> Parent design: [`2026-07-26-run-lease-and-heartbeat-design.md`](2026-07-26-run-lease-and-heartbeat-design.md) (L1). This design discharges the two follow-ups that L1's final review deferred, plus one parked residual.
> Grandparent design: [`2026-07-22-ownership-and-reconciliation-boundaries-design.md`](2026-07-22-ownership-and-reconciliation-boundaries-design.md)

## 1. Goal

L1 gave the run loop a heartbeat. The heartbeat affirms the owner lease on a timer, and `affirmOwnerLease` reaches the owner record through `updateOwnerRecordWithPrecondition`, which takes the **owner-transfer lock** (`src/persistence/fileStore.ts:633`). L1 therefore introduced the first *periodic* contender for that lock, into a codebase whose only writer of owner records used to be episodic.

Three defects follow from that, all in `persistBoundaryAnalysis` (`src/controller/runLoop.ts:640`), and all with the same symptom: **a legitimate owner transfer disappears without a trace, and the reconciliation record reports `newOwnerEpoch: null` as though no transfer had been warranted.**

1. **Lock contention is indistinguishable from CAS mismatch.** `acquireOwnerTransferLock` throws `OwnerTransferPreconditionError` when the lock is held (`fileStore.ts:499`, `:504`), the same class `updateOwnerRecordWithPrecondition` throws when the persisted record has moved on (`:640`). `runLoop.ts:711` therefore treats "somebody else is mid-write" as "somebody else has already taken over", re-reads, re-evaluates, and never retries.
2. **The heartbeat breaks its own process's transfer.** `persistBoundaryAnalysis` reads the owner record at `runLoop.ts:683` and uses it as the CAS base at `:691`. Several awaits separate the two. A successful affirm in that gap changes only `leaseAffirmedAt` and `lastAffirmedAt`, but `sameOwnerRecord` compares whole objects by `JSON.stringify` (`fileStore.ts:404`), so the CAS fails — and per defect 1 the transfer is dropped rather than retried. This is self-inflicted: no foreign process is involved.
3. **`writeBoundaryArtifacts` is unguarded.** A process that has already lost the lease still writes boundary and reconciliation artifacts into a run it no longer owns (`runLoop.ts:720`), and still triggers recovery-on-read through `readOwnerRecord` at `:683`. This is the side-effect omission recorded as **Amended 2026-07-26 (c)** in the L1 spec §8.1.

Defect 2 also subsumes the residual parked at the end of L1: between the transfer's finalize and `heartbeat.adopt` (`runLoop.ts:706`) there are two awaits in which a heartbeat tick reads the finalized record, compares it against the not-yet-adopted expectation, and concludes a self-named `lease_lost`.

## 2. Non-Goals

This design does not:

- grant any new authority. Retrying a *contended* transfer re-attempts the same CAS against the same evidence; it never relaxes the CAS, the ownership verdict, or the takeover conditions. The added guards can only refuse.
- change the resume eligibility gate. `resumeLoop` stays fail-closed on every error from `claimOwnerRecordWithPrecondition`.
- change any terminal run state or exit code. The post-terminal window described in L1 §8.1 (**Amended (b)**) is untouched: both `persistBoundaryAnalysis` call sites (`runLoop.ts:961`, `:993`) precede terminal persistence, so no guard added here can flip a reported outcome.
- weaken or delete any of L1 §12's nineteen test requirements. Requirements 2, 5, 7, 15, 17 and 19 exist to kill specific wrong implementations and are mutation-verified; they are load-bearing.
- change the `ReconciliationRecord` schema. See §5.3.
- introduce retries anywhere except the one call site named in §5.2.
- authorize any paid Claude run.

## 3. Error taxonomy

`OwnerTransferLockBusyError` is a **sibling** of `OwnerTransferPreconditionError`, not a subclass. Both extend `Error` directly.

After this change the two classes have exactly one meaning each:

| Class | Meaning | Thrown at |
|---|---|---|
| `OwnerTransferLockBusyError` | another writer holds the owner-transfer lock, and it is not recoverable as stale | `fileStore.ts:499`, `:504` |
| `OwnerTransferPreconditionError` | the persisted owner record is not the record the caller expected (CAS mismatch) | `fileStore.ts:572`, `:603`, `:640` |

Sibling rather than subclass is deliberate. A subclass would keep every existing `instanceof OwnerTransferPreconditionError` branch matching, so each of the three consumers would silently retain behaviour that was only ever correct for a CAS mismatch. As siblings, each consumer's behaviour changes visibly and must be re-decided:

| Consumer | Today | After |
|---|---|---|
| `leaseHeartbeat.ts:151` (`runAffirm`) | non-precondition errors `return`, swallowed and retried next tick | lock-busy falls into exactly that path. This is what makes L1 §6's "swallow lock contention" implementable: contention can no longer reach the supersession decision. |
| `runLoop.ts:711` (`persistBoundaryAnalysis`) | non-precondition errors rethrow | lock-busy would now propagate, so §5.2 must handle it explicitly. The compiler cannot force this; test T2 does. |
| `resumeLoop.ts:136` | catches everything, raises `ResumeNotEligibleError` | unchanged and deliberately so — resume stays fail-closed. Only the `resume_denied` event detail becomes more precise. |

`fileStore` gains no retry, backoff, or policy of any kind. It reports which precondition failed; the controller decides what that is worth.

## 4. Serializing the transfer against the heartbeat

`LeaseHeartbeat` gains one method:

```
runExclusive: <T>(fn: () => Promise<T>) => Promise<T>
```

It chains `fn` onto the existing `queue` (`leaseHeartbeat.ts:41`) — the same serialization that already exists so that the module's two writers cannot race each other for the owner-transfer lock — and resolves or rejects with `fn`'s result. The queue must survive a rejected `fn`: a thrown error propagates to the caller *and* leaves the chain usable, following the existing `queue.then(runAffirm, runAffirm)` pattern (`:178`).

`persistBoundaryAnalysis` wraps exactly one span in it: **read the owner record → evaluate ownership → CAS transfer → `adopt`** (`runLoop.ts:683`–`:717`). Not the boundary evaluation before it, and not `writeBoundaryArtifacts` after it — there is no reason to make the heartbeat wait behind artifact writes.

Three properties then hold **by construction**, not by classification:

- no affirm can land between the record read and the CAS, so defect 2 cannot occur;
- no affirm can contend for the lock with this process's own transfer;
- `adopt` runs in the same serialized span as the CAS that produced the record, and synchronously after it, so the window parked at the end of L1 closes to zero.

Constraints on the implementation:

- `assertHeld` stays **outside** the queue. It takes no lock and must never wait behind an affirm; L1 documents this at `leaseHeartbeat.ts:74`–`:78` and the exactly-once supersession gate depends on it.
- `runExclusive` must not call `affirmNow` or otherwise re-enter the queue, and neither may `fn`.
- `runExclusive` takes no position on `stopped` or `superseded`. It serializes; it does not decide. Refusal remains the guards' job (§5.4).

## 5. `persistBoundaryAnalysis` after the change

### 5.1 Shape

1. entry guard: `await heartbeat.assertHeld()` — before anything, including `readOwnerRecord`;
2. evaluate the run boundary (pure, unchanged); return early if healthy;
3. `heartbeat.runExclusive(...)` over the read → ownership evaluation → transfer → `adopt` span;
4. write boundary artifacts through the existing `guardedWriteArtifacts` wrapper.

### 5.2 Retry policy

Inside the exclusive span, and only there:

- **lock busy** → bounded retry with a short backoff. Bounded means a fixed, small attempt count and a total wait that stays far below the lease TTL; the exact numbers are the implementer's call, stated in the plan and justified against `LEASE_TTL_MS` (§7).
- **CAS mismatch** → **no retry, ever.** Re-read, re-evaluate ownership, proceed as today. A mismatch means the evidence this transfer was computed from is stale; retrying against a re-read record would be a new decision wearing an old decision's justification.
- retries exhausted → abandon the transfer, exactly as today (`newOwnerEpoch: null`, `eligibleForContinuation: false`), plus the evidence in §5.3.

### 5.3 Evidence for an abandoned transfer

When a transfer is abandoned because the lock stayed busy, append an event recording that reason. The event stream — not the reconciliation record — is the evidence channel L2–L5 consume, and it already carries `owner_epoch_transferred` (`runLoop.ts:610`), so a contention outcome belongs beside it.

`ReconciliationRecord` is **not** extended. Adding a field would be a schema change rippling into layers that are not written yet, to express something the event already expresses. The record continues to say `newOwnerEpoch: null`; the event says why.

A CAS mismatch needs no new event: the record written by whoever won the CAS is itself the evidence, and the existing re-read/re-evaluate path already reflects it.

### 5.4 Guards

- **entry**: `assertHeld` before `readOwnerRecord`, because `readOwnerRecord` runs `recoverInterruptedOwnerTransfer` (`fileStore.ts:555`), which writes. A superseded process must not perform crash recovery on a run it no longer owns.
- **before the write**: `writeBoundaryArtifacts` goes through `guardedWriteArtifacts`, closing the drift window between the entry guard and the write — a window that contains a potentially complete epoch transfer.
- the transfer itself keeps relying on its CAS. No third guard.

Both guards refuse by throwing, identically to L1's existing fourteen `assertHeld` sites. No new refusal semantics are introduced.

## 6. Test requirements

Every requirement below must be mutation-verified: delete or invert the implementation it names and the test must fail. A requirement whose test still passes against the mutation has not been discharged.

1. A transfer that first encounters a busy lock and then acquires it **completes**, and the reconciliation record carries the new epoch. *Kills: no retry.*
2. A transfer whose lock stays busy past the retry bound is abandoned with `newOwnerEpoch: null` **and** an appended event naming lock contention as the reason. *Kills: treating lock-busy as a CAS mismatch, and abandoning with no trace.*
3. A CAS mismatch triggers **zero** retries — assert the attempt count, not just the outcome — and follows the existing re-read/re-evaluate path. *Kills: retrying the CAS, i.e. relaxing an ownership decision.*
4. An affirm that becomes due while a transfer is in flight cannot execute until the transfer's exclusive span completes; the transfer sees zero CAS failures and no `lease_lost` event is appended. *Kills: `runExclusive` executing `fn` directly instead of chaining it onto the queue.*
5. A self-performed transfer produces no `lease_lost` event, with `adopt` inside the exclusive span. *Kills: moving `adopt` outside the span, restoring the parked window.*
6. A process that has already been superseded calls `persistBoundaryAnalysis` and is refused **before** `readOwnerRecord` — assert that no recovery-on-read write occurred. *Kills: deleting the entry guard.*
7. A process superseded *after* the entry guard passes does not write boundary or reconciliation artifacts. *Kills: deleting the `guardedWriteArtifacts` wrapper.*
8. `resumeLoop` remains fail-closed when the claim hits a busy lock: `ResumeNotEligibleError`, `resume_denied` appended, and the detail distinguishes lock contention. *Kills: letting the new class escape resume's catch.*
9. The heartbeat's `runAffirm` treats a busy lock as transient: no `lease_lost` event, no supersession concluded, retried on the next tick. *Kills: routing lock contention into the supersession decision.*
10. A rejected `fn` propagates out of `runExclusive` **and** leaves the queue usable for a subsequent affirm. *Kills: a queue that deadlocks or swallows on error.*

## 7. Open risks

- **Retry bound versus TTL.** Retries run inside the exclusive span, so they hold off this process's own affirms for their duration. The bound must keep the total wait far below `LEASE_TTL_MS` (90s); the plan states the arithmetic.
- **Foreign contention is unchanged in kind.** Serialization removes only *self*-inflicted contention. A genuinely concurrent foreign writer still produces lock-busy, and §5.2's bounded retry is the whole answer to it. L2 adds more contenders, and this is the mechanism it will lean on.
- **`nextOwnerRecord` in `persistBoundaryAnalysis` is written and never read.** Pre-existing, parked in L1, untouched here.
