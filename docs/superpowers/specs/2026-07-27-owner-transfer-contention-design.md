# Owner Transfer Contention Design

> Status: proposed on 2026-07-27; implemented and amended on 2026-07-28
> Amendments: five, all found by the final whole-branch review of the implementation and marked inline as **Amended 2026-07-28 (a)–(e)** in §2, §5.1, §5.3, §5.4 and §6. Each corrects a defect in *this document*, not in the implementation. (a) §2's third non-goal is contradicted by shipped code and its reasoning is inverted; (b) §5.1 step 4 and §5.4 name a wrapper that is unreachable from `persistBoundaryAnalysis`; (c) §5.4's "No third guard" says more than it meant; (d) §6 requirement 4 names one interleaving direction where the property has two; (e) §5.3 does not record the new on-disk shape this design produces.
> **Amended 2026-08-06 — note on the count above**: the paragraph above describes only the original whole-branch-review batch and is left as-is. A sixth amendment, **Amended 2026-08-06 (f)**, now also exists in §5.3 (alongside (e)); it is not part of the "five... found by the final whole-branch review" — it corrects a later, separately-discovered defect (an L3 human ruling on task A4 superseding this document, not a finding from that review round). §5.3 is already in the location list above and needs no addition; only the count and the "all found by" qualifier are stale.
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

  **Amended 2026-07-28 (a): this non-goal is contradicted by the shipped guards, and its reasoning is backwards.** This corrects a defect in *this document*, not in the implementation. Two tests now assert `status: "cancelled"` / `stopReason: "lease_lost"` where they previously asserted `"exhausted"` / the budget-exhausted reason. Preceding terminal persistence is exactly what *causes* the flip rather than preventing it: the guard refuses by throwing, and the refusal reaches `isLeaseStopError` in `runLoopFromState`'s catch — which persists `"cancelled"` — before `persistTerminalState` would have run with the outcome this attempt was heading for. Any refusal at either call site therefore changes the reported run state; there is no placement that both guards the write and preserves the outcome. The human ruling that authorized the unconditional write guard (see §5.4) authorized that consequence with it. **The exit-code half of the sentence stands:** nothing in `src/cli.ts` maps a run status to a process exit code, so only the run state changes. The plan's "No terminal-state changes" Global Constraint carries the same defect and is amended with it.
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

Sibling rather than subclass is deliberate. A subclass would keep every existing `instanceof OwnerTransferPreconditionError` branch matching, so each consumer would silently retain behaviour that was only ever correct for a CAS mismatch. As siblings, each consumer's behaviour changes visibly and must be re-decided. There are four call paths, not the two the follow-up note named:

| Consumer | Today | After |
|---|---|---|
| `leaseHeartbeat.ts:151` (`runAffirm`) | non-precondition errors `return`, swallowed and retried next tick | lock-busy falls into exactly that path. This is what makes L1 §6's "swallow lock contention" implementable: contention can no longer reach the supersession decision. |
| `runLoop.ts:711` (`persistBoundaryAnalysis`) | non-precondition errors rethrow | lock-busy would now propagate, so §5.2 must handle it explicitly. The compiler cannot force this; test T2 does. |
| `resumeLoop.ts:136` | catches everything, raises `ResumeNotEligibleError` | control flow unchanged and deliberately so — resume stays fail-closed. But its `resume_denied` detail is the hardcoded string `claim CAS failed: ...` (`resumeLoop.ts:137`), which becomes a **false statement** for a busy lock: no CAS was evaluated. The detail must be derived from which failure occurred. |
| `leaseHeartbeat.ts:208` (`stop` → `releaseOwnerLease`) | bare `catch {}`, swallows everything | unchanged, and correct as-is: a best-effort release that cannot get the lock simply lets the lease age out. Listed so it is not "fixed" into something that distinguishes cases it has no use for. |

`fileStore` gains no retry, backoff, or policy of any kind. It reports which precondition failed; the controller decides what that is worth.

## 4. Serializing the transfer against the heartbeat

`LeaseHeartbeat` gains one method:

```
runExclusive: <T>(fn: () => Promise<T>) => Promise<T>
```

It chains `fn` onto the existing `queue` (`leaseHeartbeat.ts:41`) — the same serialization that already exists so that the module's two writers cannot race each other for the owner-transfer lock — and resolves or rejects with `fn`'s result.

**Do not copy the shape of `affirmNow` here.** `queue = queue.then(runAffirm, runAffirm); return queue` (`:177`–`:180`) is safe only because `runAffirm` never rejects. `fn` can. Storing a rejecting promise back into `queue` poisons the chain: every later affirm inherits the rejection, and `stop`'s `await queue.catch(() => {})` (`:200`) would be the only thing still working. The stored chain and the returned promise must therefore be **different** promises — the stored one absorbs the rejection, the returned one carries it to the caller. Test requirement 10 exists to kill the poisoned-chain version.

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

   The guard goes **before** this early return, not after it, even though the healthy path writes nothing. Moving it behind the early return looks like a free optimization and is not: a superseded process would then evaluate a boundary and return normally, letting the caller proceed to its next side effect as though the lease still held. The guard's job is to stop the process, not to protect one write. Both call sites are rare failure paths (`runLoop.ts:961`, `:993`), so the extra read costs nothing worth having.

3. `heartbeat.runExclusive(...)` over the read → ownership evaluation → transfer → `adopt` span;
4. write boundary artifacts through the existing `guardedWriteArtifacts` wrapper.

**Amended 2026-07-28 (b): there is no such wrapper in scope; the guard is inline.** This corrects a defect in *this document*, not in the implementation. `guardedWriteArtifacts` is a closure defined inside `runLoopFromState` (`export async function runLoopFromState(` in `runLoop.ts`); `persistBoundaryAnalysis` is a module-level function that receives only `heartbeat`, so the wrapper is unreachable from it. Step 4 reads, correctly: **write boundary artifacts behind an inline `await heartbeat.assertHeld()`**, matching how L1's other `assertHeld` sites are written. §5.4's "before the write" bullet names the same unreachable wrapper and is corrected by this same amendment.

### 5.2 Retry policy

Inside the exclusive span, and only there:

- **lock busy** → bounded retry with a short backoff. Bounded means a fixed, small attempt count and a total wait that stays far below the lease TTL; the exact numbers are the implementer's call, stated in the plan and justified against `LEASE_TTL_MS` (§7).
- **CAS mismatch** → **no retry, ever.** Re-read, re-evaluate ownership, proceed as today. A mismatch means the evidence this transfer was computed from is stale; retrying against a re-read record would be a new decision wearing an old decision's justification.
- retries exhausted → abandon the transfer, exactly as today (`newOwnerEpoch: null`, `eligibleForContinuation: false`), plus the evidence in §5.3.

### 5.3 Evidence for an abandoned transfer

When a transfer is abandoned because the lock stayed busy, append an event recording that reason. The event stream — not the reconciliation record — is the evidence channel L2–L5 consume, and it already carries `owner_epoch_transferred` (`runLoop.ts:610`), so a contention outcome belongs beside it.

`ReconciliationRecord` is **not** extended. Adding a field would be a schema change rippling into layers that are not written yet, to express something the event already expresses. The record continues to say `newOwnerEpoch: null`; the event says why.

A CAS mismatch needs no new event: the record written by whoever won the CAS is itself the evidence, and the existing re-read/re-evaluate path already reflects it.

**Amended 2026-07-28 (e): after this design, a completed `owner-transfer.json` no longer implies a `reconciliation-record.json`.** This records a shape this document never stated, and corrects a defect in *this document*, not in the implementation. §5.4's write guard is unconditional, so if this process's own transfer succeeds inside the exclusive span and a rival supersedes it before the artifact write, disk carries `owner-transfer.json` and an `owner_epoch_transferred` event but **neither** `boundary-analysis.json` nor `reconciliation-record.json`. That is requirement 7's intended behaviour, not a gap in it — the transfer is real and committed by a CAS this process passed, and the refused write is a process that no longer owns the run declining to write into it. Layers that consume reconciliation artifacts must therefore treat the transfer event, not the reconciliation record, as the authoritative trace of a transfer: a missing reconciliation record next to a completed transfer means "the writer lost the run", not "no transfer happened". The same ruling deliberately gave up the losing process's synthesis of the winner's reconciliation view; if that view is still wanted, assigning it to a process that still holds the run is L5's problem.

**Amended 2026-08-06 (f): the preceding sentence's "is L5's problem" is superseded — this is now closed by L3, not inherited by L5.** This corrects a defect in *this document*, not in the implementation. Human ruling on L3 task A4 (`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md:34`): "L3 debt 1 transactionalises reconciliation so the SAME CAS publishes it. Human ruled: L3's transactionalisation SUPERSEDES L1b (e)." The same ledger records the bookkeeping consequence for L5 (`:37`): "L5's inherited-input list is unaffected in NUMBER... Record that this L1b-side assignment is now closed by L3 rather than inherited by L5." A later reviewer flagged that this in-place note had not yet been made and asked for it explicitly (`:42`: "Repo convention is an in-place *Amended (f)* note... NOT done here... Flag for the human"); this paragraph is that note, landed now.

### 5.4 Guards

- **entry**: `assertHeld` before `readOwnerRecord`, because `readOwnerRecord` runs `recoverInterruptedOwnerTransfer` (`fileStore.ts:555`), which writes. A superseded process must not perform crash recovery on a run it no longer owns.
- **before the write**: `writeBoundaryArtifacts` goes through `guardedWriteArtifacts`, closing the drift window between the entry guard and the write — a window that contains a potentially complete epoch transfer.
- the transfer itself keeps relying on its CAS. No third guard.

Both guards refuse by throwing, identically to L1's existing fourteen `assertHeld` sites. No new refusal semantics are introduced.

**Amended 2026-07-28 (c): "No third guard" was about the transfer CAS, and was read as being about reads.** This corrects a defect in *this document*, not in the implementation. Taken literally the sentence bans a guard on the catch path's *second* `readOwnerRecord` (`runLoop.ts:782`, reached on a CAS mismatch or an exhausted lock-busy retry) — which runs `recoverInterruptedOwnerTransfer` and therefore **writes**, the exact hazard the entry bullet above exists to prevent, on the path that most strongly indicates a rival now owns the run and up to a full retry backoff after the entry guard passed. Per human ruling the bullet reads, correctly:

> - **every `readOwnerRecord` in this function is guarded**, entry read and catch-path re-read alike, for the one reason the entry bullet gives: recovery-on-read is a write, and a superseded process must not perform crash recovery on a run it no longer owns.
> - the **owner-transfer CAS itself** gets no guard and keeps relying on its own precondition. That is what "no third guard" meant.

The paragraph above therefore reads "**three** guards", not two. Nothing else in it changes: they refuse by throwing, exactly as L1's existing sites do.

## 6. Test requirements

Every requirement below must be mutation-verified: delete or invert the implementation it names and the test must fail. A requirement whose test still passes against the mutation has not been discharged.

1. A transfer that first encounters a busy lock and then acquires it **completes**, and the reconciliation record carries the new epoch. *Kills: no retry.*
2. A transfer whose lock stays busy past the retry bound is abandoned with `newOwnerEpoch: null` **and** an appended event naming lock contention as the reason. *Kills: treating lock-busy as a CAS mismatch, and abandoning with no trace.*
3. A CAS mismatch triggers **zero** retries — assert the attempt count, not just the outcome — and follows the existing re-read/re-evaluate path. *Kills: retrying the CAS, i.e. relaxing an ownership decision.*
4. An affirm that becomes due while a transfer is in flight cannot execute until the transfer's exclusive span completes; the transfer sees zero CAS failures and no `lease_lost` event is appended. *Kills: `runExclusive` executing `fn` directly instead of chaining it onto the queue.*

   **Amended 2026-07-28 (d): this requirement names one direction of a two-directional property, and its named mutation survives it.** This corrects a defect in *this document*, not in the implementation — which is correct in both directions and was always correct. §4 claims the no-interleaving property holds "by construction", which covers both orderings; the requirement as written covers only "affirm becomes due *after* the span starts". The mutation it names — `const result = queue.then(fn, fn)` replaced by `const result = fn()` — leaves `queue = result.then(...)` intact, so anything queued *behind* the span still blocks correctly and the requirement's test passes against it. Both directions are therefore required, as separate tests:

   - **affirm after span**: an affirm becoming due while a transfer is in flight does not execute until the span completes (the original wording).
   - **affirm before span**: a `runExclusive` span whose `fn` is submitted while an affirm is **already in flight** does not begin `fn` until that affirm settles. This is the direction the named mutation actually breaks, and the ordinary one in production: the interval timer fires `void affirmNow()` at arbitrary points during an attempt, so an affirm is routinely mid-CAS when `persistBoundaryAnalysis` reaches its span — which is precisely defect 2 of §1.

   Only with both is the mutation killed.
5. A self-performed transfer produces no `lease_lost` event, with `adopt` inside the exclusive span. *Kills: moving `adopt` outside the span, restoring the parked window.*
6. A process that has already been superseded calls `persistBoundaryAnalysis` and is refused **before** `readOwnerRecord` — assert that no recovery-on-read write occurred. *Kills: deleting the entry guard.*
7. A process superseded *after* the entry guard passes does not write boundary or reconciliation artifacts. *Kills: deleting the `guardedWriteArtifacts` wrapper.*
8. `resumeLoop` remains fail-closed when the claim hits a busy lock: `ResumeNotEligibleError`, `resume_denied` appended, and the detail does **not** claim a CAS failure. Assert on the detail text, not merely on the error type. *Kills: letting the new class escape resume's catch, and leaving the hardcoded `claim CAS failed:` prefix on a path where no CAS was evaluated.*
9. The heartbeat's `runAffirm` treats a busy lock as transient: no `lease_lost` event, no supersession concluded, retried on the next tick. *Kills: routing lock contention into the supersession decision.*
10. A rejected `fn` propagates out of `runExclusive` **and** leaves the queue usable for a subsequent affirm. *Kills: a queue that deadlocks or swallows on error.*

## 7. Open risks

- **Retry bound versus TTL.** Retries run inside the exclusive span, so they hold off this process's own affirms for their duration. The bound must keep the total wait far below `LEASE_TTL_MS` (90s); the plan states the arithmetic.
- **Foreign contention is unchanged in kind.** Serialization removes only *self*-inflicted contention. A genuinely concurrent foreign writer still produces lock-busy, and §5.2's bounded retry is the whole answer to it. L2 adds more contenders, and this is the mechanism it will lean on.
- **`nextOwnerRecord` in `persistBoundaryAnalysis` is written and never read.** Pre-existing, parked in L1, untouched here.
