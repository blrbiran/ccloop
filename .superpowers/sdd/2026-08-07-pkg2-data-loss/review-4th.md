# Independent Review — Package 2, 4th item (D2: loser's read-decide-write under the owner-transfer lock)

Range under review: `2af4137..221b8f0` (worktree `.worktrees/pkg2-s4`, branch `feat/pkg2-4th`)

## 0. Verdicts

| Verdict | Result |
|---|---|
| **Spec compliance** (brief + design D2) | ✅ **COMPLIANT** |
| **Quality** | **APPROVED** — 0 Critical, 2 Important, 3 Minor |

Neither verdict rests on the implementer's testimony. Everything load-bearing below was
re-measured or re-derived from source in this worktree.

**Headline:** D2 does close the residual TOCTOU, and it is pinned under both orders by
assertions, not by exceptions or timeouts. I reproduced the implementer's M3 and it reds
three criteria on three different assertions. The one claim I disagree with him and the
owner about is the *wording* of the unreachability premise (§4): the combination is
**reachable**, and he says so himself in his own report; what is actually true — and what I
independently established — is the narrower proposition that **D2 can neither create nor
widen it**. That narrower proposition is enough to carry the ruling. The ledger's wording is
not.

## 1. Findings summary

| # | Severity | Finding | Anchor |
|---|---|---|---|
| **I-1** | **Important** | `writeBoundaryArtifacts` now takes the cross-process `.owner-transfer.lock` on **every** stale_candidate boundary write, not only contended ones. `claimOwnerRecordWithPrecondition` takes the same lock with **no retry**, so a concurrent `resumeLoop` is now refused where it previously was not. Not named anywhere in the design's blast-radius table. | `publishReconciliationUnderTransferLock`, `claimOwnerRecordWithPrecondition` |
| **I-2** | **Important** | The ruling authorising D2's busy-lock-abandon is recorded as resting on the combination "record absent + `owner-transfer.json` present" being **unreachable**. It is not unreachable, and the consequence inside the reachable window is **deterministic, not a race**. The correct supporting claim is narrower. The record should be corrected before this is cited again. | `finalizePendingOwnerTransfer`, `resumeLoop` |
| **M-1** | Minor | The ruling-13 named test was **renamed**, so ruling 13's citation no longer resolves by name anywhere in the tree. | `runLoop.integration.test.ts` |
| **M-2** | Minor | `cleanupOwnerTransferStagingWithoutMarker` — a 10-unlink write — is now reached on a common path instead of only on transfer/claim paths, multiplying exposure to the pre-existing stolen-lock residual. | `recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })` |
| **M-3** | Minor | A process can abandon its **own** reconciliation write through contention with its **own** heartbeat's `affirmOwnerLease`, which holds the same lock. Audit-visible only. | `acquireOwnerTransferLockForReconciliation`, `affirmOwnerLease` |

No finding blocks the item. I-1 and I-2 should be dispositioned before close; the three
Minors are named-and-deferred candidates.

## 2. Spec compliance against the brief and D2

| Requirement | Source | Result | Evidence |
|---|---|---|---|
| Loser's read → decide → write is ONE critical section under `.owner-transfer.lock` | D2 §4.2 mechanism | ✅ | `publishReconciliationUnderTransferLock` acquires, recovers, calls `preserveSuccessfulReconciliationIfNeeded`, writes, releases in `finally`. The write moved **inside**; the two audit `appendEvent` calls stayed outside, deliberately and correctly (they move no decision). |
| Busy lock ⇒ bounded retry ⇒ abandon, reusing the codebase's existing shape (controller discretion, Rule 11) | impl-brief §2 | ✅ | `acquireOwnerTransferLockForReconciliation` = 3 attempts × 50 ms, same shape as `persistOwnerTransfer`'s loop. The one divergence (every failure abandons instead of rethrowing non-busy errors) is forced by `writeBoundaryArtifacts`' constraint 1 and is documented in place. Constants deliberately not imported from `runLoop.ts` — that would close an import cycle; I confirmed `runLoop.ts` imports `fileStore.ts`, so the reasoning holds. |
| No self-deadlock on the non-reentrant lock | implicit | ✅ | Enumerated **all** callers of `writeBoundaryArtifacts` in `src/`: `runLoop.ts:910` and `:912` only. The `:910` winner arm passes **no** `reconciliationRecord`, so the locked block is skipped entirely; the `:912` loser arm holds no lock. Verified with a must-hit/must-miss probe pair. |
| `readOwnerRecordRaw` substituted for `readOwnerRecord` inside `readPersistedSuccessfulTransferArtifacts` | D2 | ✅ and **necessary** | With the lock held, `readOwnerRecord` → `recoverInterruptedOwnerTransfer(runDir)` (unlocked branch) would try to re-take the same non-reentrant lock, hit its own live lock file, and `return` silently (`fileStore.ts` ~1126–1131). The substitution is not cosmetic; without it the recovery would be silently skipped. |
| Amendment authorised to exactly one named test in `runLoop.integration.test.ts` | ruling 13 / 19 | ✅ | See §5. |
| Amendment authorised to exactly one named test in `leaseLifecycle.integration.test.ts`, limited to the reconciliation-reading half, `owner_transfer_contended` assertions surviving | ruling 37 | ✅ | See §5. |
| **No other existing criterion changed anywhere in the range** | brief §4.1 | ✅ | See §5 — verified by full deletion enumeration **and** by an `it()`-name diff of both files between `2af4137` and `221b8f0`. |
| New `it`s added rather than existing criteria stretched | ruling 35 | ✅ | Two new `it`s; 58 pre-existing names in `runLoop.integration.test.ts` byte-identical and in unchanged order; all 21 in `leaseLifecycle.integration.test.ts` byte-identical. |
| Waiting points A / C untouched, B execution-surface-only | brief §4.2, ruling 34 | ✅ | `tryRecoverStaleOwnerTransferLock` is byte-identical in the range (it appears in no diff hunk); its new reachability comes only through the new `acquireOwnerTransferLock` caller, which is exactly what ruling 34 permits. |
| No linter / toolchain / `package.json` changes; package 1 untouched; spec and plan untouched | brief §4.3–4.5 | ✅ | `git diff --name-status 2af4137..221b8f0` lists exactly six paths: three SDD docs, `src/persistence/fileStore.ts`, and the two test files. |
| Three exit codes 0, suite green | brief §7 | ✅ | §8. |

**One compliance note, not a violation:** the design's §4.2 blast-radius table is a *lower*
bound and its author marked every row "未验（推理）". I measured the rows that matter and they
came out as he predicted — but the table **omits** the row I-1 describes. Prediction accuracy
on the listed rows is not coverage of the unlisted one.

## 3. Does it close the TOCTOU under BOTH interleavings?

**Yes, and the closure is pinned by assertions.** This is the part I was most prepared to
reject, and it survives.

### 3.1 The 2026-08-02 constraint, restated

The Human ruling refused a terminal-state assertion because
*"'P1's third rename puts the winner's record back' is an ordering **this harness imposes, not
a property of the system**"*. The correct discharge is therefore **not** "now we may assert the
terminal state", it is "the terminal state must be the same proposition under both orders of
the two lock spans, and each order must carry it". That is exactly what the two new `it`s do,
and the amended comment block says so in the same words.

Critically: the ⚠️ sentence is **retained** in the amended block, not deleted, with an added
clause explaining that D2 does not lift it. That is the right shape. Deleting it and asserting
a terminal state in the same test would have been the renamed damaged trajectory the brief
warned about.

### 3.2 The three orders of the two lock spans

There are three, not two, and all three are pinned:

| Order | Where the loser's span falls | Pinned by | Status |
|---|---|---|---|
| **A — loser wholly before** | Lock free; loser publishes its downgrade; winner's rename #3 then publishes over it | NEW `keeps the loser's downgrade when its protected span runs first, and still ends at the winner's reconciliation record` | ✅ |
| **B — loser overlaps the winner** | Lock held by a live pid; loser exhausts the bound and abandons; its write never lands after rename #3 | NEW `keeps the winner's reconciliation record as the terminal state when the loser's write is forced to land after the winner's last rename` | ✅ |
| **C — loser wholly after** | Lock free; loser reads the **committed** pair; `transferRepresentsPublishedWinner` holds; `resolveSuccessfulReconciliation` writes the winner's own record back | PRE-EXISTING `fileStore > preserves a successful reconciliation record when a loser later tries to downgrade it` and `> preserves a synthesized winner reconciliation view against a later loser downgrade` | ✅ (both green at HEAD, now running *through* the new lock) |

Order C is the one no new test covers, and it does not need one: it is the order the
pre-existing published-winner check always handled, and its two guardrails now exercise the
locked path and still pass. I checked this rather than assuming it, because "the new lock
broke the normal preserve path" was a live possibility.

### 3.3 Do the criteria go red on **assertions**?

Yes — measured, not accepted. Mutation M3 (faithful two-part revert of `fileStore.ts` to
`2af4137`; see §7):

| Criterion | Failure mode under M3 | Assertion? |
|---|---|---|
| `leaseLifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy` | `AssertionError: promise resolved "undefined" instead of rejecting` | ✅ assertion (`access(reconciliation-record.json)` rejects) |
| `runLoop > abandons the loser's reconciliation write against the winner's held transfer lock …` | `AssertionError: expected [] to have a length of 1` | ✅ assertion (a) |
| `runLoop > keeps the winner's reconciliation record as the terminal state …` | `AssertionError: expected false to be true` | ✅ **the terminal assertion itself**, which is deliberately the first assertion in the test |

No timeouts, no thrown exceptions, no hangs. Counts non-zero and explicit:
`Tests 3 failed | 85 passed (88)`, exit 1.

The order-A test stays **green** under M3 — correctly so, since pre-D2 also produces the
winner's record in that order. The implementer left its non-vacuity unmeasured. **I measured
it** with my own mutation M2 (`RECONCILIATION_LOCK_RETRY_ATTEMPTS = 0`, forcing abandon):
it reds on `expect(abandonments).toEqual([])` — `AssertionError: expected [ Array(1) ] to
deeply equal []`, `Tests 1 failed | 60 skipped (61)`, exit 1. So both new criteria are
non-vacuous, each against the mutation that is meaningful for it.

### 3.4 Judgment on the designer-vs-implementer disagreement (I rule it; not the owner's)

The disputed sentence is *"Everything asserted below is scoped to the loser's window."* The
designer filed it as **overturned**; the implementer filed it as **preserved** and declined to
adopt the designer's reading.

**The implementer is right, and the disagreement is a scope confusion, not a substantive
conflict.** The sentence's referent is literally "below" — the assertions of *that* test. At
HEAD every assertion in that test is still window-scoped: `reconciliationAbandonmentsInWindow`,
`ownerTransferReadOutcomesInWindow`, `publishTempRenameSourcesInWindow`, plus the two fixture
preconditions that were already there in BASE. Nothing terminal was added to it. The sentence
is true at HEAD word for word.

What the designer is actually pointing at is the *file-level policy* — the suite now does
assert a terminal state for this scenario. That is true, and it is authorised by ruling 35,
and it is discharged correctly (two orders, §3.2). But it is a different proposition from the
sentence, and merging them would have overwritten a true statement with a false one. Filing
the disagreement instead of silently resolving it was the correct call.

## 4. The unreachability argument (load-bearing)

### 4.1 My verdict

> **The combination "`reconciliation-record.json` absent while `owner-transfer.json` present"
> is REACHABLE. The ruling's premise, as recorded, is false.**
>
> **The proposition that actually carries the ruling — "D2's busy-lock abandon can neither
> create nor widen that combination" — is TRUE, and I established every leg of it myself.**

The implementer does not hide this; his own §F1.3 and §F2.2 name the window and say the
consequence is "not inert". His conclusion is stated correctly ("D2 造不出它" — D2 cannot
produce it). The problem is the **ledger and the ruling** are recorded on the stronger word,
and a future reader who cites "unreachable" will be citing something false. That is I-2.

### 4.2 What I verified with my own hands

Every probe below carried a must-hit and a must-miss control; scripts were written to disk and
run under `rtk proxy zsh`, globs quoted, `git show` wrapped in `bash -c`.

**Leg 1 — production has exactly one publisher of `owner-transfer.json`, and it publishes the
reconciliation record in the same transaction.**
`writeOwnerTransferRecord` exists but has zero callers in `src/` and its own comment says
*"Production must publish owner-transfer.json only through finalizePendingOwnerTransfer"*.
`writeOwnerTransferArtifacts` has exactly one production caller — `persistOwnerTransfer`
(`runLoop.ts:681`) — and it **always** passes a `reconciliationRecord` (`runLoop.ts:666-669`
constructs it unconditionally; the parameter is non-optional at `persistOwnerTransfer`'s
signature, `runLoop.ts:661`). Therefore the marker is **always v2**, and v2's
`finalizeOrder` always contains `RECONCILIATION_RECORD_FILE`
(`legalFinalizeOrderFileNames`, and `isValidFinalizeOrder` rejects any v2 marker that omits
it). A v1 marker — transfer without reconciliation — is producible only from a test fixture.
**This closes the sub-case I went looking for and expected to find open.**

**Leg 2 — nothing in `src/` deletes `reconciliation-record.json`.**
I enumerated all 20 `safeUnlink(` call sites in `fileStore.ts` and cross-checked them against
`getOwnerTransferPaths`. `cleanupOwnerTransferStagingWithoutMarker` unlinks nine
`*.pending` / `*.tmp` paths plus the marker temp — and **never** `ownerPath`, `transferPath`,
or `reconciliationPath`. `finalizePendingOwnerTransfer` unlinks only temps, pendings, and the
marker. No `safeUnlink(paths.reconciliationPath)` exists anywhere.

**Leg 3 — the abandon arm writes nothing and touches nothing.**
`publishReconciliationUnderTransferLock` returns the `abandon` object before entering the
`try`, so no lock is ever taken, no recovery runs, and `writeBoundaryArtifacts` returns after
its two swallowing `appendEvent`s. An existing record is left byte-for-byte alone.

**Leg 4 — the consumer surface of the absence is exactly one function, and I checked it
myself rather than taking the report's word for it.**
`reconciliation-record.json` is **not** in the registry's `OBSERVED_FILES`
(`observeFields.ts` lists `loop-state.json`, `owner-record.json`, `owner-transfer.json`;
`readObservedFile.ts`'s `pickReader` **throws** for any other name, so it is structurally
impossible for the registry to read it), and `sweepRuns.ts:100` says so in a comment. The only
consumer that fails on its absence is `resumeLoop`, through `readReconciliationRecord`
(`resumeLoop.ts:139` → `fileStore.ts:1310`, a bare `readFile` + `JSON.parse`). So the
implementer's measurement scope was complete, not merely convenient.

### 4.3 Where the combination genuinely exists — and I go further than the implementer

The window is inside `finalizePendingOwnerTransfer`'s rename loop, between rename #1
(`owner-transfer.json`) and rename #3 (`reconciliation-record.json`). It persists on disk only
if the finalizing process dies or stalls inside it.

The implementer named this window and explicitly declined to race a concurrent `resumeLoop`
against it. **He did not need to, and neither did I: the outcome is deterministic, not a
race.** From source:

1. `resumeLoop`'s `Promise.all` (`resumeLoop.ts:136-142`) issues all five reads eagerly in the
   same tick. `readReconciliationRecord` is a bare `readFile` — it will ENOENT.
2. Its sibling `readOwnerRecord` → `recoverInterruptedOwnerTransfer(runDir)` takes the
   **unlocked** branch, which tries `acquireOwnerTransferLock` and, finding the finalizer's
   live lock, `return`s silently (`fileStore.ts:1126-1131`). It therefore **cannot** repair the
   state in time, or at all, while the finalizer lives.
3. So `Promise.all` rejects and `resumeLoop` throws `ResumeNotEligibleError` — every time, not
   sometimes.

This strengthens rather than weakens the disposition: it means the window's consequence needs
no racing fixture to establish, and it also means the probe's caveat about "which ENOENT wins
the race" is immaterial to the verdict.

**Is this window D2's fault? No.** A solo winner that dies mid-finalize with no loser anywhere
produces the identical state. D2 neither creates it (leg 1) nor widens it (the loser abandons
*outside* the window; it never writes into it). In fact D2 **improves** the crashed-winner
case: a later loser now steals the stale lock and runs
`recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })`, finalizing the interrupted
transaction and restoring the record — where pre-D2 that repair rode incidentally on
`readOwnerRecord` inside a *protective read*, which the deleted comment block was explicitly
uneasy about.

### 4.4 What the record should say

Replace "the combination is unreachable" with, in substance:

> The combination is reachable only inside `finalizePendingOwnerTransfer`'s rename window, is
> pre-existing, and is not created or widened by D2. A `resumeLoop` landing in that window is
> deterministically refused. That standing defect is named and out of scope for the 4th item.

Filed as **I-2**. The disposition of the item does not change; the wording of its justification
must.

## 5. Amendments to existing criteria — independent verification

I did not accept the implementer's accounting. Three independent checks:

**Check 1 — file surface.** `git diff --name-status 2af4137..221b8f0` returns exactly six
paths. Only `src/persistence/fileStore.ts`, `tests/controller/leaseLifecycle.integration.test.ts`
and `tests/controller/runLoop.integration.test.ts` are code/test. No other test file in the
repository is touched at all, so "no other existing criterion changed" cannot be violated
outside these two files.

**Check 2 — every deleted line in `tests/`, enumerated.** `git diff -U0 2af4137..221b8f0 -- src tests`
gives 39 deletions: 15 in `fileStore.ts`, 8 in `leaseLifecycle.integration.test.ts`, 16 in
`runLoop.integration.test.ts` — matching numstat exactly. Pre-image line ranges, from the
`-U0` hunk headers:

- `leaseLifecycle` (8): 516-519, 521-522, 524-525 — the `const reconciliation = JSON.parse(...)`
  read (3 lines + a blank), two comment lines, and exactly the two assertions
  `expect(reconciliation.newOwnerEpoch).toBeNull()` /
  `expect(reconciliation.eligibleForContinuation).toBe(false)`. **That is the
  reconciliation-reading half and nothing else.** Everything the test is named for —
  `owner_transfer_contended` present, `owner_epoch_transferred` absent,
  `owner.currentOwnerEpoch === 1`, `finalState.status === "exhausted"`, `owner-transfer.json`
  never staged — survives untouched.
- `runLoop` (16): 2360-2364 and 2366-2369 (the comment block), 2389 (the `it(` name), 2527
  (the `observedRunLoopFromState` call, widened to pass the abandon callback), 2560-2564
  (comment + assertion (a)). **All sixteen fall inside the ruling-13 named test.**

**Check 3 — `it()`-name diff between BASE and HEAD, both files** (`bash -c "git show …"`, per
the zsh `:s` hazard):

- `runLoop.integration.test.ts`: 59 → 61 names. Exactly **one** name replaced (the ruling-13
  one), **two** added. The other 58 are byte-identical and in unchanged order.
- `leaseLifecycle.integration.test.ts`: 21 → 21 names, **diff is empty**. The amended test kept
  its name verbatim; only its body changed.

**Ruling 37's survival condition, checked directly.** `owner_transfer_contended` appears
untouched in the amended test, and the two spec-named busy-lock criteria are intact and green:

- `retries a busy owner-transfer lock and completes once it clears (spec requirement 1)` ✓ 598 ms
- `abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2)` ✓ 625 ms

**Verdict: exactly two existing criteria were amended, each the one its ruling names, each
within its authorised scope. No other existing criterion changed anywhere in the range.**

**M-1 (Minor).** The ruling-13 test was **renamed**. Ruling 13 authorises the amendment, and a
name is part of a test, so this is inside the grant — but the consequence is that ruling 13's
citation (`reads owner-transfer.json for the published-winner check and finalizes none of the
winner's transaction inside the publish window`) now matches **zero** lines in the tree. The
old comment block already records that this test's name was itself set by a prior human ruling
with an in-place plan amendment note. *Constructible scenario:* a future auditor greps the
ruling's quoted name to confirm the exception was honoured, gets zero hits, and concludes the
test was deleted rather than amended. Fix is one line in the plan's amendment note, or a
`(renamed 2026-08-09 → …)` breadcrumb in the comment block. Contrast: ruling 37's test kept its
name and has no such problem.

## 6. Implementer-raised items

### 6.1 The new write reaching `cleanupOwnerTransferStagingWithoutMarker` — **M-2 (Minor)**

He raised it and left it to the reviewer. My judgment:

**Not a data-loss hazard, but a real increase in exposure.** Pre-D2 the loser's path reached
`recoverInterruptedOwnerTransfer(runDir)` *without* `lockHeld`, and the no-marker branch of
that call does **nothing**. Post-D2 it reaches the `{ lockHeld: true }` branch, whose no-marker
arm calls `cleanupOwnerTransferStagingWithoutMarker` — ten `safeUnlink`s. That is a genuinely
new write on a path that previously wrote nothing when no transfer was staged.

Why it is not Critical:
- The unlinked paths are provably disjoint from the three published files (§4.2 leg 2), so it
  cannot destroy `reconciliation-record.json`, `owner-record.json`, or `owner-transfer.json`.
- It runs **under the lock**, and every stager (`writeOwnerTransferArtifacts`) also holds the
  lock while staging, so it can only ever reap orphans.
- Its two pre-existing callers (`writeOwnerTransferArtifacts`, `claimOwnerRecordWithPrecondition`,
  and `updateOwnerRecordWithPrecondition`) do exactly the same thing under exactly the same
  precondition. This is conformance, not a fork (Rule 11).

Why it is not nothing: it now fires on **every** stale_candidate boundary write, which is a far
more common event than a transfer or a resume claim. *Constructible scenario:* process A's lock
file is briefly unparseable (the window in `acquireOwnerTransferLock` between `open(lockPath,"wx")`
and `handle.writeFile`) while its pendings are already on disk; process B's now-frequent boundary
write steals the lock via `tryRecoverStaleOwnerTransferLock`'s unparseable-plus-staged branch and
cleans the pendings; A then creates its marker and `finalizePendingOwnerTransfer` throws
`OwnerTransferPendingMissingError`. Worst case is a **fail-closed failed transfer**, not data
loss — but the probability multiplier is real and the design's blast-radius table does not
mention it. Recommend recording it against waiting point B rather than fixing it here.

### 6.2 The filed disagreement with the designer — **I ruled it, see §3.4**

Not the owner's to settle. The implementer is right on the literal sentence; the designer is
pointing at a different, also-preserved proposition. Filing rather than merging was correct.

### 6.3 The stolen-lock residual — named, unpinned, and correctly so

The design's premise 1 (§4.2, "那把锁真的互斥") already declares that D2 *downgrades* the
residual from "this layer's read/write are not mutually exclusive" to "lock-protocol soundness
(§13 first entry, L5)" rather than closing it unconditionally. The in-place comment on
`publishReconciliationUnderTransferLock` repeats this verbatim at the code face, naming both
escape hatches (`tryRecoverStaleOwnerTransferLock`, and a successful resume flipping clause (b)
of `transferRepresentsPublishedWinner`). **That is the honest shape.** No new criterion was
added for it, and none should be — a test that pins "the lock is never stolen" would be pinning
the absence of L5's input, not this layer's behaviour.

### 6.4 What he did **not** raise, and I did — **I-1 (Important)**

`writeBoundaryArtifacts` now acquires the cross-process `.owner-transfer.lock` on the common
path, and the design's blast-radius table names no consequence of that. Three consequences,
each checked at source:

1. **`resumeLoop` can now be refused where it previously could not.**
   `claimOwnerRecordWithPrecondition` (`fileStore.ts:1201`) calls `acquireOwnerTransferLock`
   with **no retry loop of its own** — unlike `persistOwnerTransfer`, which retries 3×.
   `resumeLoop` maps that to `resume_denied` + `ResumeNotEligibleError` with detail
   `owner-transfer lock busy` (`resumeLoop.ts:163-169`). *Constructible scenario:* process A
   reaches a `stale_candidate` boundary carrying a reconciliation record; process B calls
   `resumeLoop` on the same run dir inside A's read→decide→write span. Pre-D2 that span held no
   lock and B's claim succeeded; post-D2 B is refused. Fail-closed and event-recorded, so no
   data loss — but it is a new user-visible refusal on a path nobody analysed.
2. **The heartbeat is safe — I checked, because a spurious lease loss here would have been
   Critical.** `affirmOwnerLease` takes the same lock, and `runAffirm`
   (`leaseHeartbeat.ts:147-155`) swallows any non-`OwnerTransferPreconditionError` and retries
   on the next tick. A busy lock therefore cannot be mistaken for supersession. **No finding.**
   Note this is load-bearing: `writeBoundaryArtifacts` is deliberately kept **outside**
   `runExclusive` (`runLoop.ts:791`), so the interval affirm genuinely can run concurrently
   with the new lock span.
3. **M-3 (Minor): a process can abandon its own reconciliation write via its own heartbeat.**
   The mirror of (2): if an affirm holds the lock across all three of the loser's attempts
   (3 × 50 ms), the loser abandons its own write and emits `reconciliation_write_abandoned`
   plus the operator callback, for no contention with any other process.
   *Constructible scenario:* a slow filesystem where `affirmOwnerLease`'s recover + read +
   atomic-write exceeds 150 ms. Consequence is bounded — per §4.2 leg 1, a run in this state
   has no `owner-transfer.json` unless a v2 transfer already published a record, so `resumeLoop`
   is not newly broken; the loss is the audit record only. `LEASE_AFFIRM_THROTTLE_MS` makes it
   rare. Named, not blocking.

## 7. Mutation experiments and restoration proofs

**Two mutations. Both proven restored.**

### M3 — faithful two-part revert (the implementer's; his M2 and M2′ are documented dead, and I did not repeat them)

- **Injection:** `git checkout 2af4137 -- src/persistence/fileStore.ts` — a full revert of the
  D2 source, which is exactly his M3 (function body reverted **and** `readOwnerRecordRaw` back
  to `readOwnerRecord`) because `fileStore.ts` has no other change in the range.
- **Injection verified:** staged numstat `15 115 src/persistence/fileStore.ts`; marker probe
  `publishReconciliationUnderTransferLock` = **0**; sanity probe `writeBoundaryArtifacts` = 7 (non-zero).
- **Result:** `Tests 3 failed | 85 passed (88)`, exit 1 — all three on assertions (§3.3).
- **Restoration:** `git checkout 221b8f0 -- src/persistence/fileStore.ts` + `git reset`.
  `rtk proxy git diff` → **0 bytes**; `rtk proxy git diff --cached` → **0 bytes** (checked
  separately, because `git checkout <commit> -- path` **stages** its change and an unstaged-only
  diff would have proven nothing); marker probe `readOwnerRecord(runDir),` (the pre-D2 form) = **0**;
  sanity probe `publishReconciliationUnderTransferLock` = **4**.
- **Green after restore:** the two files re-run, `Tests 88 passed (88)`, exit 0.

### M2 — mine, to settle the order-A test's non-vacuity (unmeasured by the implementer)

- **Injection:** `RECONCILIATION_LOCK_RETRY_ATTEMPTS = 3` → `0` with marker comment
  `CCLOOP_REVIEW_MUTATION_2`, forcing `acquireOwnerTransferLockForReconciliation` to abandon
  unconditionally.
- **Result:** `keeps the loser's downgrade when its protected span runs first …` fails with
  `AssertionError: expected [ Array(1) ] to deeply equal []` at
  `expect(abandonments).toEqual([])` — `Tests 1 failed | 60 skipped (61)`, exit 1. **Assertion,
  non-zero count.**
- **Restoration:** `rtk proxy git diff` → **0 bytes**; marker `CCLOOP_REVIEW_MUTATION_2` = **0**;
  sanity probes `RECONCILIATION_LOCK_RETRY_ATTEMPTS = 3;` = 1 and
  `publishReconciliationUnderTransferLock` = **4**.

**Final tree state:** `git status --short` shows only four untracked `.diff` / `.md` review
artifacts (three pre-existing, one this report). `git rev-parse HEAD` = `221b8f0…`, unchanged.
Nothing pushed, merged, branched, or deleted. The main checkout at
`/Users/biran/code/skills/loop/ccloop` was never touched.

## 8. Test run evidence

All runs `ECC_GATEGUARD=off DISABLE_OMC=1`, unfiltered, tee'd to disk, then searched on disk
with must-hit / must-miss probes. Every run's first `RUN` line verified as
`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4`.

| Run | Result | Exit |
|---|---|---|
| Full suite at HEAD (before any mutation) | `Test Files 31 passed (31)` / `Tests 522 passed (522)` | 0 |
| Two affected files under M3 | `Tests 3 failed \| 85 passed (88)` | 1 |
| Two affected files after M3 restore | `Tests 88 passed (88)` | 0 |
| Order-A test under M2 | `Tests 1 failed \| 60 skipped (61)` | 1 |
| **Full suite after all mutations restored** | `Test Files 31 passed (31)` / `Tests 522 passed (522)` | **0** |
| `npx tsc --noEmit` | no output | **0** |
| `npm run build` | normal output, no errors | **0** |

**Flakes: none.** Neither allowed flake occurred, and the third, on-the-books failure
(`tests/controller/runLoop.integration.test.ts > runLoop > persists phase usage evidence from
the subprocess adapter without recomputing controller totals`, ENOENT `plan.json`) did **not**
occur either — compared by full test name, in both full-suite runs. Recorded, not waved away.
Zero unexplained failures across the whole review.

**Discipline note, self-reported:** on one occasion I displayed an already-complete tee'd log
with `tail` instead of an on-disk probe. The run itself was unfiltered and saved in full; every
conclusion in this report comes from a probed on-disk search, not from that display. Reporting
it rather than leaving it implicit.

## 9. Detailed findings

### I-1 — Important — New cross-process lock on the common boundary-write path

**Symbols:** `publishReconciliationUnderTransferLock`, `acquireOwnerTransferLockForReconciliation`,
`claimOwnerRecordWithPrecondition`, `affirmOwnerLease`.
**Scenario, disposition and reasoning:** §6.4. Summary: a concurrent `resumeLoop` is newly
refusable because the claim CAS takes the same lock with no retry; the heartbeat is safe
(verified); the design's blast-radius table names none of this.
**Recommended disposition:** record the contention surface against D2 in the ledger, and decide
explicitly whether `claimOwnerRecordWithPrecondition` should adopt `persistOwnerTransfer`'s
bounded retry. Do **not** change it inside this item — that is a semantic change to a
lock-taking path and needs its own ruling.

### I-2 — Important — The recorded justification for the busy-lock-abandon path is stated on a false premise

**Symbols:** `finalizePendingOwnerTransfer`, `resumeLoop`, `readReconciliationRecord`.
**Scenario, disposition and reasoning:** §4. Summary: "unreachable" is false; "D2 cannot create
or widen it" is true and sufficient; the consequence in the reachable window is deterministic,
not a race, and is a standing pre-existing defect.
**Recommended disposition:** amend the ledger wording per §4.4 and open the finalize-window
`resumeLoop` refusal as a separately-tracked pre-existing defect. **No code change.**

### M-1 — Minor — Ruling 13's citation no longer resolves by name

See §5. One-line breadcrumb fix.

### M-2 — Minor — `cleanupOwnerTransferStagingWithoutMarker` reached far more often

See §6.1. Record against waiting point B.

### M-3 — Minor — Self-contention between the boundary write and the process's own heartbeat affirm

See §6.4(3). Named, bounded, not blocking.

### Positive samples worth recording

- The implementer's `G3b` probe **falsified his own intended conclusion** ("the absence is
  inert") and he reported the falsification instead of the conclusion. That is the behaviour
  this repository has been trying to buy.
- He filed the designer disagreement rather than merging it, and marked the one link he did not
  measure as unmeasured — which is precisely what let me find the sharper, deterministic
  argument in §4.3 instead of re-litigating a race.
- The amended comment block **retains** the 2026-08-02 ⚠️ sentence and explains why D2 does not
  lift it, rather than deleting an inconvenient ruling. The pairing of two orders is the correct
  discharge, not a workaround.

### Budget

**I cannot read a real harness token number in this thread.** The only figure available to me is
the cost hook's dollar total, which is not a token count. Per the brief's rule I give **no
estimate**.
