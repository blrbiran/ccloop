# Independent review — human ruling 106(b): the I-3(b) round + the two unreviewed ruling-105 commits

Reviewer: independent. Wrote none of this. Read-only on the checkout throughout; HEAD, index and
branches were never moved. Every mutation ran in a `git clone --local` copy that was restored and
then deleted.

**Verdict up front: 0 Critical, 1 Important, 3 Minor. Ready to merge: Yes.**

The single claim the brief asked me to try hardest to falsify — that human ruling 83's fail-closed
semantics are unchanged cell for cell — **survived a 75-input differential probe across three
`process.kill` errno regimes with zero mismatches**, plus a full-suite mutation that gave a
fail-closed exit a delete and was seen red. I could not break it.

The one Important finding is not a behaviour defect. It is a **false claim written into `src/`
where nothing can check it** — the exact defect class ERRATUM 4 of this very round indicts.

---

## Strengths

1. **The redline change is a faithful refactor, and I proved it rather than read it.** I extracted
   the old `tryRecoverStaleOwnerTransferLock` from `979f5f0` and the new one from HEAD, ran both
   over a 25-input corpus (absent file, `not-json`, `""`, `null`, `123`, `"hello"`, `true`, `[]`,
   `["pid:<dead>"]`, `["pid:<self>"]`, `{}`, holder `null` / `""` / `0` / `false` / `42` / `{}` /
   `[["pid:<dead>"]]` / `"upgrading"` / `"pid:0"` / `"pid:<dead>"` / `"pid:<self>"` /
   `"pid:99999999999999999999"` / `"pid:-1"`, and JSON with trailing garbage) under three
   `process.kill` regimes (real, forced `EPERM`, forced `ESRCH`), comparing **(did the lock file get
   deleted?, cleared / refused / threw)**. **75 rows, 0 mismatches.** The single deleting exit is
   the same cell it was.

2. **Moving `isProcessActive` outside the `try` is genuinely safe, and the round knew why.**
   `isProcessActive` wraps its only throwing call in its own `try` and returns from both arms, so
   the removed `catch` had nothing to catch. The round did not merely assert this — it added the
   EPERM-injection criterion and mutation M5 to pin it, and M5 goes red *only* on that criterion.

3. **`git clone --local` mutation M7 (mine, not the implementer's): giving the `unparseable` exit a
   `safeUnlink` turns two pre-existing criteria red** — `keeps a malformed lock non-recoverable even
   when staged artifacts are present` and `leaves the lock on disk when malformed staged state names
   no dead holder`. So the fail-closed property of *both* unattributable exits is pinned: the
   `no-pid-holder` one directly (the new criterion asserts the lock is still on disk), the
   `unparseable` one by those two. I went looking for a coverage hole here and there isn't one.

4. **Both of the round's "measured, not reasoned" claims reproduced exactly.** Not paraphrased —
   byte-identical to what the ledger published. See Verification.

5. **The "no code change" decision at the reconciliation site is better than the comment claims.**
   `acquireOwnerTransferLockForReconciliation` abandons on the first attempt, and
   `writeBoundaryArtifacts`'s abandon arm passes `String(decision.error)` to *both*
   `options?.onReconciliationWriteAbandoned?.(…)` and the `reconciliation_write_abandoned` event.
   The new message — reason **and** `ccloop unlock` line — therefore reaches the operator on that
   path with no new code at all. The comment justifies the non-change on retry economics only; the
   stronger justification (the operator text flows through for free) is the real one.

6. **The operator's next step actually works.** I ran `unlockOwnerTransferLock` against both
   unattributable shapes. Both refuse with rc=1 and print the escape line. Measured output:
   - `not-json` → `refused  lock unreadable: Unexpected token 'o', "not-json…" is not valid JSON`
     then `         to override: ccloop unlock <runDir> --force --expect 60498eba…`
   - `{"holderProcessInstanceId":"upgrading"}` → `refused  unrecognized holder identity: upgrading`
     then `         to override: ccloop unlock <runDir> --force --expect ffcf968f…`

   The claim that the message can safely stop at `ccloop unlock <runDir>` and let that command
   supply the `--force --expect` line is **true**, not hopeful.

7. **The ruling-107 rewrite strengthens and cannot be vacuous.** One assertion (`rejects
   .toBeInstanceOf(Busy)`) became four, and it uses `.then(onFulfilled, onRejected)` with an
   explicit throw on the resolve arm specifically so a resolving promise cannot yield `undefined`
   and quietly satisfy every assertion. That is the empty-green failure mode this package keeps
   hitting, closed on purpose.

8. **The Mi-3 chokepoint test (commit 2, never independently reviewed) is sound.** It parses with
   the TypeScript compiler rather than regex, carries two anti-vacuity must-hits (a synthetic source
   the walker must see, and a *different* real read in the module under test), and honestly
   enumerates the three things it does not catch. I mutated `acquireOwnerTransferLock` to add a
   second `await readFile(lockPath, "utf8")` and **saw it go red**: `expected [ Array(2) ] to have a
   length of 1 but got 2`. Its stated constructible scenario is real.

9. **Comment discipline held, measured.** `git show 90d3f64` and `git show 9e112f0` contain **0**
   lines matching `^-[^-]`. Both ruling-105 commits are pure additions. No published text was edited
   in place.

10. **Exactly one existing criterion was rewritten, measured.** The entire `tests/` diff over
    `979f5f0..HEAD` contains **5** lines matching `^-[^-]`, and all five are inside the single
    ruling-107 criterion. There is no second changed criterion.

---

## Critical

**None.**

---

## Important

### I-1 — "It was only ever false HERE" is false in three cells, and it is written into `src/` where nothing can check it

**Measured.**

Anchor (`src/persistence/fileStore.ts`, hit count **1** for each verbatim string):

```
        // Human ruling 106 (I-3(b)). The busy message below is TRUE for a live holder -- a transfer
```
…whose paragraph ends:
```
It was only ever false HERE
```
(hit count **1**), and the type's own comment:
```
// tell apart -- a lock a LIVE holder is using (transient: it clears when that process exits) and a
```
(hit count **1**), over:
```
  | { kind: "holder-alive"; pid: number }
```
(hit count **1**).

The round's claim 2 — and the ledger's §40 restatement (「对**活持有者**那一格 … 是**真话**；假话只发生在
不可归属那一格」) — says `owner transfer already in progress` was only ever false for an unattributable
lock. **It is also false in at least three other cells, all of which still get that exact message
with no reason and no `ccloop unlock` hint.**

Constructible scenario, measured end to end against HEAD via `writeOwnerTransferArtifacts`:

| lock contents | class thrown | message | lock left on disk |
|---|---|---|---|
| `{"holderProcessInstanceId":"pid:0"}` | `OwnerTransferLockBusyError` | `owner transfer already in progress` | yes |
| `{"holderProcessInstanceId":"pid:99999999999999999999"}` | `OwnerTransferLockBusyError` | `owner transfer already in progress` | yes |

Measured on this machine: `isProcessActive(0) = true` and `isProcessActive(1e20) = true`.
`process.kill(0, 0)` signals the caller's own process *group*, so it succeeds; an out-of-range pid
raises `ERR_OUT_OF_RANGE`, which is not `ESRCH`, so the two-state predicate answers "alive". Neither
lock is held by anything, and **neither will ever clear on its own** — which is precisely the
condition the new class was created to name. The operator gets the old lie.

The third cell is inside the round's own test suite. The new criterion is named `refuses a lock as
busy when the holder's liveness **cannot be determined**` — and the code's answer to that fixture is
`{ kind: "holder-alive", pid }`. There is a passing test whose fixture contradicts the discriminant
name it exercises. `src/unlock/inspectLock.ts` already distinguishes this case (`liveness-unknown`,
which `unlockCommand` renders as `refused  cannot determine whether pid <n> is alive: …`), so the
codebase elsewhere knows the distinction the new type folds away.

**Disposition — and I am separating the finding from it, as the protocol requires:**

- The **behaviour** is correct to leave alone. Ruling 86 pins liveness to two-state `isProcessActive`;
  ruling 83's wording makes every non-reclaiming exit fail closed, and it does (lock stays on disk in
  every row above). The published redline comment already says in so many words that "`pid:0` and
  overflowing pids stay REFUSED here exactly as they already were before this change, and point B is
  not their fix." Widening `unattributable` to swallow these cells is **new logic outside ruling
  106(a)'s authorisation**, which is confined to the return type and its consumers. **Do not fix the
  behaviour in this round.**
- The **claim** is what is wrong, and fixing a claim is inside any round's authorisation because it
  adds no logic. `It was only ever false HERE` and `a lock a LIVE holder is using (transient: it
  clears when that process exits)` are two unfalsifiable sentences in `src/` that a measurement
  contradicts. ERRATUM 4, added by commit 1 of this very review range, condemns exactly this: *"What
  is wrong is a count, written into `src/` where nothing could check it — the defect class this
  package exists to remove."* Same shape, two commits later.

I rate this Important rather than Minor because I-3(b)'s entire deliverable is *the sentence the
operator reads*, and the round has published a claim about that sentence's truth that is measurably
narrower than stated. Nothing downstream is broken; the record is.

---

## Minor

### Mi-1 — the `pid` payload of `holder-alive` is never read by anyone

**Measured.** In `src/persistence/fileStore.ts`, `outcome.kind` has hit count **2**, `outcome.why`
hit count **1**, and `outcome.pid` hit count **0**. The variant

```
  | { kind: "holder-alive"; pid: number }
```

(hit count 1) carries a field no consumer consults. Under CLAUDE.md Rule 2 ("nothing speculative")
this is one field more than the problem needed. It is also the field that makes the discriminant's
name read as a determination rather than a default — see I-1. Either drop it, or spend it: a busy
message that named the pid would be strictly more useful than the fixed string, though that would
change published text and is out of this round's wording.

### Mi-2 — the brief's own census of consumer sites is garbled (the ledger's is right)

**Measured, read-only argument for the disposition.** The brief states: *"The implementer claims 5
call sites of `acquireOwnerTransferLock`, of which 3 swallow the error."* I verified the census
myself. There are indeed exactly **5** call sites of `acquireOwnerTransferLock`
(`acquireOwnerTransferLockForReconciliation`, `recoverInterruptedOwnerTransfer`,
`writeOwnerTransferArtifacts`, `claimOwnerRecordWithPrecondition`,
`updateOwnerRecordWithPrecondition`) — but **exactly one of them swallows**
(`recoverInterruptedOwnerTransfer`'s bare `catch { return; }`, which is I-3(a) itself). The other two
swallowing sites are in `src/controller/leaseHeartbeat.ts` — the
`if (!(error instanceof OwnerTransferPreconditionError)) { return; }` arm of `runAffirm`, and the
`try { await releaseOwnerLease(…) } catch {}` in the stop path — and neither is a call site of
`acquireOwnerTransferLock`. Ledger §40 and commit `bc68a85`'s message both state this correctly
("三个吞错误的调用点" naming `recoverInterruptedOwnerTransfer` and both heartbeat sites). The **brief**
conflated two different populations. The brief said its factual claims are fair game, so it is
recorded; the implementation is unaffected.

I traced every escape route and found **no uncontained one**: `writeOwnerTransferArtifacts` is called
only from `persistOwnerTransfer` (contained by the new `runLoop` branch);
`claimOwnerRecordWithPrecondition` only from `resumeLoop` (handled by the new third branch);
`affirmOwnerLease` → `updateOwnerRecordWithPrecondition` only from `leaseHeartbeat` (swallowed —
recorded, out of scope); the reconciliation path surfaces the message to the operator. Nothing throws
the new class out of a run.

### Mi-3 — the ruling-107 rewrite is the one new unattributable criterion that does not assert the lock survived

**Measured, and the disposition is "leave it".** Its sibling — `refuses a lock whose holder identity
is not a pid as unattributable, never as busy` — closes with
`expect(await readFile(join(runDir, ".owner-transfer.lock"), "utf8")).toContain("upgrading")` and the
comment *"human ruling 83's fail-closed exit did not gain a delete."* The rewritten unparseable
criterion has no equivalent line. I went looking for the coverage hole and **there isn't one**:
mutation M7 (adding `await safeUnlink(lockPath)` before the `unparseable` return) turned two
pre-existing criteria red on the full suite. Recording it only because the asymmetry between two
adjacent criteria for the same invariant is the kind of thing a later reader will misread as
deliberate.

---

## Verification performed

All test runs were unfiltered, redirected to a file and read back whole; every `RUN` line was checked
against the intended root. All git byte counts went through `rtk proxy git …` redirected to a file
and then `wc -c`.

**Checkout state.** `git rev-parse HEAD` = `565aaae575e0c4736eaf3227630b643d517e9990` (matches the
brief's short sha). Before and after: `git status --porcelain` **0 bytes**, `git diff` **0 bytes**,
`git diff --cached` **0 bytes**. HEAD unmoved at the end.

**Baseline re-measured, not accepted.** `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run`
→ **`Test Files 35 passed (35)`, `Tests 609 passed (609)`, 0 skipped, `TEST_RC=0`, duration 19.59s**,
`RUN v2.1.9 /Users/biran/code/skills/loop/ccloop`. `npm run typecheck` rc=**0**; `npm run build`
rc=**0**. **The brief's baseline is confirmed.**

**The 4496-byte metric re-measured.** `sed -n '1001,1075p' src/persistence/fileStore.ts | wc -c` →
**4496**. `grep -c "async function tryRecoverStaleOwnerTransferLock"` → **1**. Return type is
`Promise<StaleOwnerTransferLockOutcome>`. Confirmed.

**The 609 arithmetic cross-checked against the previous round's published figure.** The
pointB-minors brief recorded `34 files / 603 tests`. This range adds exactly six criteria (one in
`leaseLifecycle.integration.test.ts`, one in `resumeLoop.integration.test.ts`, three in
`fileStore.test.ts`, one in the new `lockReadChokepoint.structure.test.ts`) and exactly one new test
file. 603 + 6 = **609**; 34 + 1 = **35**. Both figures reconcile. (The "604" the ledger voids is the
spec's soft `604+` success criterion, not a measured baseline.)

**Diff census.** Whole-`tests/` diff `979f5f0..HEAD`: **5** lines matching `^-[^-]`, all inside the
ruling-107 criterion. `git show 90d3f64`: **0**. `git show 9e112f0`: **0** (92 insertions, 1 file).

**Differential probe of the redline function** (`node`, standalone, both implementations transcribed
verbatim with the unchanged `parsePid` / `isProcessActive` / `safeUnlink` helpers): 25 lock-content
inputs × 3 `process.kill` regimes = **75 rows, 0 mismatches** on (deleted?, cleared/refused/threw).
Notable rows: `[["pid:<dead>"]]` deletes in **both** old and new (the pre-existing array-coercion
hole the Mi-2 erratum documents — unchanged, not a regression); `pid:0`, `pid:1e20` and every
`EPERM` row refuse in both.

**Mutations. Every one below was SEEN red; none is reported on prediction.** All in a
`git clone --local` copy at the same HEAD, with the checkout's `node_modules` symlinked. Unmutated
sanity first: 4 files / **136 tests passed**, `RUN` pointing at the clone.

| | mutation | named criterion | result seen |
|---|---|---|---|
| M1 | `unattributable` exit throws `Busy` instead | malformed criterion + resume-detail criterion | **red**, 3 criteria (both named ones + `refuses a lock whose holder identity is not a pid…`) |
| M2 | drop `resumeLoop`'s third branch | resume-detail criterion | **red**, 1 criterion |
| M3 | drop `runLoop`'s containment branch | `contains an unattributable transfer lock as a recorded contention…` | **red**, 1 criterion |
| M4′ | live holder treated as reclaimable **and** unlinked | `rejects owner transfer while a live transfer lock is held` | **red**, 8 criteria incl. the named one |
| M5 | `isProcessActive` rethrows non-`ESRCH` | EPERM-injection criterion | **red**, exactly 1 criterion — the named one |
| M6 *(mine)* | second `readFile(lockPath)` added to `acquireOwnerTransferLock` | Mi-3 chokepoint criterion | **red** — `expected [ Array(2) ] to have a length of 1 but got 2` |
| M7 *(mine)* | `unparseable` exit gains `safeUnlink` | *(none named — I was hunting a hole)* | **red**, 2 pre-existing criteria, on the **full suite** |

**On the hollowness question the brief raised: none of the five surviving mutations is hollow.**
Each turns its named criterion red, and M5 turns *only* its named criterion red, which is the
sharpest possible result. The ledger's account of why the original M4 proved nothing is accurate —
the loop's second iteration reaches the trailing
`throw new OwnerTransferLockBusyError("owner transfer already in progress")` and the live-holder
criterion stays green — and M4′ is a genuine replacement, not a relabelling.

**Both of claim 5's measurements reproduced, byte for byte.**
- Without the `resumeLoop` branch (M2), the failure prints the real `resume_denied` detail:
  `claim CAS failed: OwnerTransferLockUnattributableError: owner-transfer lock cannot be attributed
  to any process (unparseable); it will not clear on its own -- inspect it with: ccloop unlock …`.
  A CAS that was never evaluated. **Confirmed.**
- Without the `runLoop` branch (M3): `AssertionError: expected 'failed' to be 'exhausted'`.
  **Confirmed.**

**Operator-path probe.** `unlockOwnerTransferLock` run directly against both unattributable lock
shapes — output quoted in Strengths 6. Both refuse rc=1 and print the `--force --expect <digest>`
line.

**I-1's probe, and a bad probe caught.** My first attempt at the `pid:0` scenario imported
`applyOwnerEpochTransfer` from `fileStore.ts`, where it does not live, and failed with
`applyOwnerEpochTransfer is not a function`. That run proved nothing and is not counted; only the
corrected run (importing from `src/ownership/ownerController.js`) is reported. The
`isProcessActive(0) = true` / `isProcessActive(1e20) = true` measurements came from the surviving
assertion of the broken run and were re-confirmed by the corrected one.

**Known flakes.** M7's full-suite run showed a third failure,
`run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid` at
5004ms, with total duration **25.38s** against the clean 19.59s. That is item 1 on the brief's flake
list plus the load signature, under a mutated tree; not investigated, not counted. The clean baseline
had it green at 4458ms.

**Restoration, proven the way the protocol demands.** Clone after every mutation and at the end:
`rtk proxy git diff` = **0 bytes**, `rtk proxy git diff --cached` = **0 bytes** (checked after each
of the seven restorations, not only at the end). Clone `git status --porcelain` = 16 bytes, all of it
the `?? node_modules` symlink I created. Clone deleted with `/bin/rm -rf` after unlinking the symlink
first; the checkout's real `node_modules` verified intact afterwards. Checkout final:
status/diff/cached = **0 / 0 / 0**, HEAD `565aaae…`.

**Actions requiring disclosure.** I ran `npm run build` in the checkout (writes `dist/`, which is
ignored — `git status --porcelain` is 0 bytes after). I created and deleted two temporary probe test
files **inside the clone only** (`tests/zz-probe.test.ts`, `tests/zz-probe2.test.ts`). I did **not**
start OrbStack, pull any image, install anything, or change machine configuration. No linux
measurement was taken; I make no claim about linux.

**Out of scope, honoured.** I did not re-raise I-3(a)'s bare `catch`, `leaseHeartbeat.ts`'s two
swallows, E1's I-2 cell, ruling 85, package 1, linux, or anything at or below `979f5f0`. I make no
ruling on point B, C-1, or E1. Mi-2 above names the heartbeat sites only to correct a census, not to
re-raise the swallows.

---

## Recommendations

1. **(I-1, do this)** Append a named erratum — do not edit the published text — at the acquire site's
   `Human ruling 106 (I-3(b)). The busy message below is TRUE for a live holder` block, saying
   plainly: *`It was only ever false HERE` is too strong. The busy message is also false for a
   `pid:0` holder, for an out-of-range pid, and for any holder whose liveness the probe could not
   determine (`EPERM`). Measured: all three throw `OwnerTransferLockBusyError("owner transfer already
   in progress")` and leave the lock on disk. Those cells stay REFUSED exactly as ruling 83 and
   ruling 86 leave them; widening `unattributable` to cover them is new logic outside ruling 106(a)
   and is recorded, not fixed.* Add the same narrowing to the type's `a lock a LIVE holder is using
   (transient: it clears when that process exits)` sentence, since "transient" is false for `pid:0`.
   This is a comment-only change and needs no new authorisation.

2. **(I-1, ask the human)** `holder-alive` names a determination the two-state predicate does not
   make; `not-determined-dead` is what the code computes. Renaming the discriminant touches only the
   type and its two `outcome.kind` readers, so it is arguably inside ruling 106(a)'s "return type and
   the sites that consume it" — but it is close enough to the edge that I would put it to the human
   rather than let an implementer decide. If it is renamed, Mi-1's dead `pid` field goes with it.

3. **(Mi-3)** Add the one-line `expect(await readFile(lockPath, "utf8")).toContain("not-json")` to the
   ruling-107 criterion so both unattributable criteria assert the same invariant the same way. Under
   ruling 88 this is a further strengthening of a criterion the round is already authorised to
   rewrite; M7 shows the invariant is covered either way, so this is legibility, not coverage.

4. **(Mi-2, for the controller)** The next brief should take its consumer census from ledger §40
   rather than restating it. The ledger is right; the brief was not.

5. **(process)** The `bc68a85` self-review — catching its own M4 as hollow before shipping it — is the
   single most valuable thing in this range. Whatever produced it should be kept. It is the reason I
   had to work to find anything.

---

## Assessment

**0 Critical / 1 Important / 3 Minor. Ready to merge: Yes.**

The claim the brief singled out as most important is the one that held up best. I attacked the
"cell for cell" claim three ways — a 75-row differential of old against new, a full-suite mutation
that handed a fail-closed exit a delete, and a hand audit of the moved `try` boundary — and every one
of them came back clean. `isProcessActive`'s totality is real, not asserted, and it is pinned by a
criterion that M5 shows is load-bearing. Ruling 83's single deleting exit is byte-identical in
condition and unchanged in consequence.

All five of the round's mutations are honest: each was seen red on its named criterion, and M5 is red
on nothing else, which is what a well-aimed mutation looks like. The ledger's confession about the
original M4 checks out, and the replacement is a real replacement. Both "measured, not reasoned"
figures reproduced word for word. The comment discipline held with zero in-place edits across both
ruling-105 commits, and exactly one existing criterion changed — the one ruling 107 named.

The Important finding is a claim, not a bug. Nothing loses data, nothing fails open, and no operator
is worse off than before this round; three cells are merely no better off, while the round's prose
says they were the only cells that were already fine. Given that this package's entire purpose is
removing unfalsifiable claims from `src/`, and given that commit 1 of this very range added an
erratum indicting precisely that pattern, leaving a fresh instance of it two commits later is worth
one erratum before the next round closes.

