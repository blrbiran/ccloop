# Independent review — human ruling 120: the I-3(a) round plus the two `leaseHeartbeat` swallows

Range reviewed: `30dde526c17f850be581bbefe9764e00ef9bb4b4..d4a9bb115bdd8f9114d4548af21e91130736b290`.
`git rev-parse HEAD` on this checkout = `d4a9bb115bdd8f9114d4548af21e91130736b290` — matches the brief.
Working tree was clean before and after (`git status --porcelain`, `git diff`, `git diff --cached`
all **0 bytes**, via `rtk proxy … > file` then `wc -c`, at start and at end).

Every finding below is labelled **measured** or **read-only argument**. Nothing in the brief, the
spec, the plan or the ledger was accepted without re-measurement. All mutation was done in a
`git clone --local` copy under
`/private/tmp/claude-501/…/scratchpad/copy`, which has been restored and deleted.

No container runtime was used. No network was used. Nothing was installed. The only file I wrote
inside the checkout is this report.

---

## Strengths

1. **Ruling 83's redline function is untouched, and that is now hash-proven, not eyeballed.**
   **Measured.** `tryRecoverStaleOwnerTransferLock` located by brace-matching from its unique
   definition line (signature hit count = 1): lines **1017–1095**, **4769 bytes** including line
   1095's trailing newline — identical at `30dde52` and at HEAD, and
   `sha256 = dfb0155d5bdd0614f04fd3019976fe62951ab8c42311d4ba78a376c33a793405` on both sides.
   Not one character changed. The brief's metric reproduces exactly.

2. **The single deleting exit is well pinned in aggregate — I attacked it and it held.**
   **Measured (my own mutation, seen red).** In the copy I gave *both* `unattributable` exits an
   `await safeUnlink(lockPath)` — i.e. a lock that is still refused but is deleted anyway, the
   precise ruling-83 violation that would not be caught by any "does it still throw" assertion.
   Result: **5 criteria red** (`keeps a malformed lock non-recoverable even when staged artifacts
   are present`, `observes that the redline function actually ran on the strong-holder fixture`,
   `leaves the lock on disk when malformed staged state names no dead holder`, `keeps a malformed
   lock without staged artifacts non-recoverable`, `refuses a lock whose holder identity is not a
   pid as unattributable, never as busy`). Ruling 83 as a whole is defended. (One of the four
   named rewrites did **not** go red — see Important I-1.)

3. **The narrowing is exactly one class wide.** **Read-only argument, verbatim-anchored.** The
   whole of the changed catch is

   ```
       } catch (error) {
         …
         if (error instanceof OwnerTransferLockUnattributableError) {
           throw error;
         }
         …
         return;
       }
   ```

   `OwnerTransferLockBusyError`, `OwnerTransferMarkerUnreadableError`,
   `OwnerTransferPendingMissingError`, `OwnerTransferMarkerFinalizeOrderInvalidError` and
   `OwnerTransferPreconditionError` are all declared as **siblings**, none a subclass of another
   (each `extends Error` directly; hit count for `extends Error {` in that block = 5) — so no
   third class, no `AggregateError`, and no non-`Error` throw can take the new exit; every one of
   them falls through to the unchanged `return`. Busy and the errno cells are byte-for-byte the
   old behaviour. `finalizePendingOwnerTransfer` sits **outside** this try, so the marker classes
   never reached this catch to begin with.

4. **`runLoop`'s two call sites really are untouched.** **Measured.**
   `git diff --numstat` for the range gives `src/controller/runLoop.ts` = **33 added / 0 deleted**,
   in a **single hunk** at the outer catch. Ruling 114's "option B, both call sites unchanged, not
   one line" holds literally. The new branch sits after the `RunHeartbeatStoppedError` branch and
   **before** `isLeaseStopError` and the generic failure handling, as required.

5. **Published-comment discipline honoured.** **Measured.** Deletion counts for the whole range:
   `fileStore.ts` 17/**1**, `leaseHeartbeat.ts` 35/**1**, `resumeLoop.ts` 11/**2**,
   `runLoop.ts` 33/**0**. The single deletions in `fileStore.ts` and `leaseHeartbeat.ts` are the
   `} catch {` → `} catch (error) {` lines; `resumeLoop`'s two are the old detail-string code
   lines. **No comment line was deleted anywhere in the range.** Ruling 104's ERRATUM at
   `tests/persistence/fileStore.test.ts` is preserved verbatim with a new named ERRATUM appended
   (pure-addition hunk `@@ -828,6 +828,15 @@`), and the same pattern holds for the `fileStore.ts`
   catch comment.

6. **Six of the round's eight mutations reproduce, independently.** **Measured, each seen red or
   green in my own copy:** M1 (delete the `runLoop` branch → N1 red, `contended` count 0), M3
   (delete the `resumeLoop` branch → N2 red), M4 (delete the affirm branch → N3 red, N4 green),
   M5 (drop the dedup flag → N3 **and** N4 red), M6 (revert the narrowing → exactly the four
   ruling-115 criteria red, 609 pass), M8 (delete the `writeOwnedRunState` line → **full suite
   613/613 green**, confirming ruling 118's premise against the whole suite, not just N1).

7. **The consumer census is correct — I re-took it rather than inheriting it.** **Measured**
   (python walk of `src/**/*.ts`, not `rtk grep`, because rtk truncates):
   `acquireOwnerTransferLock` has **5 direct call sites** (`acquireOwnerTransferLockForReconciliation`,
   `recoverInterruptedOwnerTransfer`, `writeOwnerTransferArtifacts`,
   `claimOwnerRecordWithPrecondition`, `updateOwnerRecordWithPrecondition`). Outside `fileStore.ts`
   the class can surface at exactly **7 sites**: `runLoop.ts` 682 / 801 / 895,
   `resumeLoop.ts` 65 / 211, `leaseHeartbeat.ts` 153 / 280. All seven are now routed
   (`instanceof OwnerTransferLockUnattributableError` hit count in `src/` = 6 branches + the
   reconciliation abandon arm's `!(… instanceof OwnerTransferLockBusyError)`). **There is no
   fourth swallow of this class in `src/`.** §41's corrected census reproduces exactly.

8. **The baseline reproduces.** **Measured.** `35 files / 613 tests` passed, **0 skipped**,
   `TEST_RC=0`, duration 18.18s, vitest's first `RUN` line = `/Users/biran/code/skills/loop/ccloop`;
   `typecheck` rc=0; `build` rc=0. Unfiltered, redirected to a file and read back whole.

9. **The self-corrections are honest.** Spec §7 and the plan's "corrections after execution"
   both overturn their own bodies where measurement said so (M2's failure mode, ruling 118,
   ruling 119, and the "which assertion went red is not a discriminator" lesson). §42 records
   M8's non-red rather than hiding it. This is the behaviour the package exists to produce.

---

## Critical

### C-1 — Ruling 113's `stop()` recording branch is pinned by **nothing**, and unlike M8 that is not disclosed anywhere

**Measured, seen green.** In the copy I deleted the entire `stop()` branch — the whole of

```
      if (error instanceof OwnerTransferLockUnattributableError && !unattributableLockRecorded) {
        unattributableLockRecorded = true;
        await appendLeaseEvent("owner_transfer_lock_unattributable", `lease release blocked: ${String(error)}`);
      }
```

(hit count 1 in `src/controller/leaseHeartbeat.ts`) and ran the **full** suite unfiltered:

```
 Test Files  35 passed (35)
      Tests  613 passed (613)
RC=0
```

Half of commit 4 — one of the three swallows this round exists to close — can be removed without a
single criterion noticing.

**Why N4 does not catch it.** A directed probe (I printed the values rather than reading which
assertion went red, per the round's own lesson) instrumented `stop()`'s catch with
`console.log("PROBE_STOP_CATCH isUnattr=", …, "flag=", unattributableLockRecorded)` and ran the
full suite. 27 hits total:

| context | `isUnattr` | `flag` at entry |
|---|---|---|
| `leaseHeartbeat > records the unattributable lock at most once per run, across repeated ticks and stop()` (N4) | `true` | **`true`** |
| `leaseLifecycle > contains an unattributable transfer lock as a recorded contention instead of throwing out of the attempt` | `true` | `false` |
| `leaseLifecycle > abandons the attempt in place when the ownership read hits an unattributable transfer lock, without failing the run` (N1) | `true` | `false` |
| 24 other stops | `false` | `false` |

In N4 the flag is **already `true`** when `stop()` is reached — the three ticks recorded first — so
N4 never executes the branch body at all. The two `leaseLifecycle` criteria *do* execute it, but
neither asserts on `owner_transfer_lock_unattributable`; N1 counts `owner_transfer_contended` only.

**What §42 does and does not say.** §42's M4 row — "N4 仍绿（`stop()` 那支照记 1 条）" — is
**true**, and I reproduced it: with the affirm branch deleted the flag stays `false` and `stop()`
does record. So there is no false claim in the ledger. What is missing is the converse mutation.
The eight-mutation table contains no mutation that kills the `stop()` branch, and the round
therefore never learned that it is unpinned. Ruling 118 established the precedent for exactly this
situation — an unpinned line stays, *with a comment saying plainly that no criterion pins it*. The
`stop()` branch has no such comment; its comment reads as if the behaviour were established.

**Constructible scenario where the branch matters.** A run whose heartbeat's last affirm precedes
the appearance of the unattributable lock (the affirm throttle is `LEASE_AFFIRM_THROTTLE_MS`), and
which then stops: `releaseOwnerLease` walks into the lock, the flag is still `false`, and the
branch is the *only* thing that tells the operator anything at all before the lease ages out. With
the branch silently regressed, the operator sees exactly the silence ruling 113 was passed to
remove — and no test would go red.

**Disposition: raised, not acted on.** No code behaviour is wrong today; this is a verification and
disclosure gap. It needs either (a) one criterion that drives `stop()` into the lock with the flag
still `false` and asserts one `owner_transfer_lock_unattributable` event, or (b) a ruling-118-style
in-code disclosure. I recommend (a): the fixture is cheap — seed the heartbeat, write the
unparseable lock without advancing timers past the throttle, call `stop()`, count the event.

---

## Important

### I-1 — One of the four ruling-115 rewrites moved an assertion **ahead of the code under test**, making it inert

**Measured, seen green while its three siblings went red.** In
`keeps a lock non-recoverable when its live holder is in the strong instance-id form`, the rewrite
did more than swap the carrier: it **deleted the `const owner = await readOwnerRecord(runDir);`
line from its old position and re-introduced the call two assertions later.** The current order is

```
    await writeFile(join(runDir, ".owner-transfer.lock"), lockContents);

    // The lock is still there, byte for byte, and the staged transfer was never finalized behind
    // it. Under the reverted guard all three of these fail.
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).resolves.toBe(lockContents);
    …
    await expect(readOwnerRecord(runDir)).rejects.toBeInstanceOf(OwnerTransferLockUnattributableError);
```

The lock-on-disk assertion now runs **immediately after the `writeFile` that created the lock and
before `readOwnerRecord` is ever called**. It asserts that a file the test just wrote still contains
what the test just wrote. It observes nothing the production code did.

Proof it is inert: under my lock-deleting mutation (Strengths #2) the other three named rewrites
went red on exactly this assertion, and **this criterion stayed green**. Ledger §42's claim —
"锁在盘上、staged pending 未 finalize、`lockReads > 0` 三类断言逐字保留" — is true of the *text*
and false of the *weight*: for this criterion, that assertion no longer carries any.

Under ruling 88's binding conditions (whole-criterion rewrite, **no relaxation**), this is a
relaxation, notwithstanding that it is redundantly covered by three other criteria.

**Disposition: raised.** The fix is one line of ordering — move
`await expect(readOwnerRecord(runDir)).rejects.toBeInstanceOf(…)` above the lock-contents
assertion — and it restores the criterion to what its own comment claims.

### I-2 — N1 pins no positive outcome: a mutation that ends the run **terminally** passes the whole suite

**Measured, seen green.** N1's outcome assertions are `expect(finalState.status).not.toBe("failed")`
and `.not.toBe("cancelled")`, plus `persisted.status === finalState.status`. Nothing pins the
value. In the copy I changed the new branch to

```
        state = { ...state, status: "exhausted" as const };
        await writeOwnedRunState(runDir, state);
        return state;
```

`exhausted` is **terminal** (`legalTransitions.exhausted = []`, so `isTerminalRunStatus` is true),
and nothing in this codebase leads back out of a terminal status — the same argument the
`RunHeartbeatStoppedError` branch's own comment makes for why a stop must not be routed to
"cancelled". Full-suite result: **612 passed, 1 failed**, and the one failure was
`run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`,
a listed known flake, which passed on a re-run of that file alone (`39 passed, RC=0`).
So the mutation is **not** killed by anything.

I also measured what the branch actually does today, by printing it rather than inferring it:
`PROBE_FINAL_STATUS= "executing"`, `attemptsUsed= 1`, `loop-state.json` on disk `"status":
"executing"`, events `["loop_planning","attempt_started","execute_started",
"owner_transfer_contended","owner_transfer_lock_unattributable"]`. The behaviour is right — the
attempt is genuinely abandoned in place. The criterion named "abandons the attempt in place …"
simply does not encode "in place"; `succeeded` and `blocked_waiting_human` would slip through too.

**Disposition: raised.** One added assertion — `expect(finalState.status).toBe("executing")`, or
`expect(isTerminalRunStatus(finalState.status)).toBe(false)` — closes it.

### I-3 — N1's event assertions cannot tell the new branch from the ruling-106 transfer branch

**Measured.** Under M6 (narrowing reverted to a bare `catch`) only the four `fileStore` criteria
went red — **N1 stayed green**, even though the new ruling-114 branch is then never entered at all.
With the narrowing reverted, `readOwnerRecord` resolves, ownership evaluation proceeds to
`persistOwnerTransfer`, the *transfer* path meets the same lock and its ruling-106 branch
(`runLoop.ts` hit at `type: "owner_transfer_contended"`, detail `owner transfer abandoned:
${String(error)}`) emits an event that satisfies every one of N1's assertions: count 1,
`toContain("cannot be attributed")`, `toContain("ccloop unlock")`, status not failed/cancelled.

N1 is not hollow — M1 (deleting the branch) does turn it red, which I reproduced (`expected [] to
have a length of 1 but got +0`), so on today's code the event provably comes from the new branch.
But the criterion is green-for-the-right-reason only by accident of which path throws first; it has
no assertion that distinguishes `owner transfer recovery blocked:` from `owner transfer abandoned:`.

**Disposition: raised.** `expect(contended[0].detail).toContain("recovery blocked")` is a one-line
fix and makes M6's green on N1 impossible.

---

## Minor

### Mi-1 — A second assertion was deleted from the first rewrite, and only the first deletion is disclosed

**Measured.** `keeps a malformed lock non-recoverable even when staged artifacts are present` lost
**two** assertions, not one:

```
-    expect(owner.currentOwnerEpoch).toBe(1);
-    expect(owner.currentProcessInstanceId).toBe("pid:12345");
```

Spec §3.2's "诚实交代" and ledger §42 both name only `currentOwnerEpoch === 1` as replaced. The
`currentProcessInstanceId` assertion is equally unsalvageable (the read no longer returns a record)
and its removal is defensible — but it is undisclosed, in a package whose whole discipline is that
what is removed is said out loud.

### Mi-2 — A comment made false by this round's own edit, inside the file this round edited

**Measured (follows from I-1).** In the same criterion, the surviving comment reads "The lock is
still there, byte for byte, and the staged transfer was never finalized behind it. **Under the
reverted guard all three of these fail.**" After the reordering, the first of the three cannot
fail under any guard. This is precisely the "a count/claim written where nothing can check it"
defect class ERRATUM 4 in `fileStore.ts` names as the reason this package exists — and unlike the
twelve documented out-of-authorisation stale comments, this one was made false *by this round*, in
a line this round was explicitly authorised to touch.

### Mi-3 — N4's name over-claims its `stop()` coverage

**Measured (the probe in C-1).** `records the unattributable lock at most once per run, across
repeated ticks and stop()` does exercise `stop()`, but with the flag already `true`; it therefore
asserts only that `stop()` adds no *second* event, never that `stop()` records a first one. The
name reads as if both halves were covered.

### Mi-4 — The plan's M5 expectation is off, in a direction its corrections section does not cover

**Measured.** The plan's Step-5 table predicts M5 → "**N4 红**（条数 > 1），N3 仍绿". I measured
**both** N3 and N4 red (N3's fixture ticks twice). Ledger §42's row ("计数变 **2** 与 **7**") is the
accurate record and matches my measurement; only the plan body is wrong, and its "corrections after
execution" section does not list this among the four discrepancies it records.

### Mi-5 — The new event type has no consumer

**Read-only argument.** `owner_transfer_lock_unattributable` appears in `src/` at exactly two sites,
both `appendLeaseEvent` calls in `leaseHeartbeat.ts`; nothing reads it. Event types here are
free-form strings (`appendEvent` takes `type: string`), so nothing is broken and no registry needed
updating. Recording it in `events.jsonl` is the operator channel this round was asked for.

**Disposition: raised, deliberately not acted on.** Surfacing locks to the operator elsewhere is
ruling 85's docket, not this round's.

---

## Verification performed

Every command was run unfiltered, redirected to a file, and read back whole. `rtk proxy` was used
for every git measurement so rtk's filter layer could not lie about byte counts.

**On the checkout (read-only throughout):**

| what | result | label |
|---|---|---|
| `git rev-parse HEAD` | `d4a9bb11…` — matches the brief | measured |
| `git status --porcelain` / `git diff` / `git diff --cached`, before and after all work | 0 / 0 / 0 bytes, twice | measured |
| `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run` | `35 files / 613 tests` passed, **0 skipped**, `TEST_RC=0`, 18.18s, `RUN` line = this checkout | measured |
| `npm run typecheck` | rc 0 | measured |
| `npm run build` | rc 0 | measured |
| redline function, brace-matched from its unique definition | 1017–1095, **4769 bytes**, sha256 `dfb0155d…` | measured |
| same function at `30dde52` | 1017–1095, 4769 bytes, **same sha256** | measured |
| `git diff --numstat` for the range | runLoop 33/0, fileStore 17/1, leaseHeartbeat 35/1, resumeLoop 11/2; the three other test files **purely additive** (68/0, 69/0, 43/0); fileStore.test.ts 36/10 | measured |
| changed-criterion map (python walk-back to nearest `it(`) | exactly the **four** ruling-115 names; **no fifth criterion changed** anywhere in the range | measured |
| consumer census (python walk of `src/**/*.ts`) | 5 direct `acquireOwnerTransferLock` call sites; 7 consumer sites outside `fileStore.ts`; all 7 routed; no fourth swallow | measured |
| error-class hierarchy | five siblings, none a subclass of another | read-only argument |
| `appendLeaseEvent` | wraps `appendEvent` in its own `try/catch` that swallows — the new recording adds no failure surface | read-only argument |

**In the `git clone --local` copy** (`node_modules` symlinked from the checkout; every mutation
verified against a verbatim anchor with an asserted hit count of 1 before applying):

| | mutation | result | label |
|---|---|---|---|
| mine | `await safeUnlink(lockPath)` added to **both** unattributable exits | **5 red**; the strong-holder criterion **green** ⇒ I-1 | measured, seen red |
| mine | new `runLoop` branch sets `status: "exhausted"` before persisting | **full suite green** except one known flake, which passed on re-run ⇒ I-2 | measured, seen green |
| mine | delete `stop()`'s recording branch entirely | **613/613 green, RC=0** ⇒ C-1 | measured, seen green |
| mine | probe printing `isUnattr` / `flag` at `stop()`'s catch | 27 hits; N4 enters with `flag=true` ⇒ C-1, Mi-3 | measured |
| mine | probe printing `finalState.status`, disk state and event types in N1 | `"executing"`, disk agrees, 5 events ⇒ I-2 | measured |
| M1 | delete the new `runLoop` branch | N1 red (`contended` 0) | measured, seen red |
| M3 | delete the `resumeLoop` branch | N2 red | measured, seen red |
| M4 | delete the affirm branch | N3 red, N4 green | measured, seen red |
| M5 | drop the dedup flag (both branches) | N3 **and** N4 red | measured, seen red |
| M6 | revert the narrowing to a bare `catch` | exactly the four ruling-115 criteria red, 609 pass; **N1/N2/N3/N4 all green** ⇒ I-3 | measured, seen red |
| M8 | delete the `writeOwnedRunState` line | **613/613 green** — ruling 118 confirmed against the whole suite | measured, seen green |

**Restoration proof.** After every mutation the file was restored with
`cat pristine > target` (never `cp`, which is aliased to `-i`), and at the end
`rtk proxy git diff` = **0 bytes** and `rtk proxy git diff --cached` = **0 bytes** in the copy;
`git status --porcelain` in the copy = 16 bytes, whose entire content is `?? node_modules` (my
symlink). Before deleting the copy I byte-compared all eight touched files against the checkout's:
sha256 equal and byte lengths equal in all eight (fileStore.test.ts 259793, leaseHeartbeat.test.ts
40469, leaseLifecycle.integration.test.ts 101550, resumeLoop.integration.test.ts 37674,
fileStore.ts 90353, runLoop.ts 71396, resumeLoop.ts 14995, leaseHeartbeat.ts 18287) — **no mutation
ever touched a criterion file.** The copy was then removed with `/bin/rm -rf`.

**Flakes.** I hit exactly one of the four listed flakes, once
(`run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`,
`Test timed out in 5000ms`, run duration 19.47s — below the 25–29s load signature). Re-running that
file alone gave `39 passed, RC=0`. No conclusion rests on it.

---

## Recommendations

1. **C-1 first.** Add a criterion that drives `stop()` into the unattributable lock with
   `unattributableLockRecorded` still `false` and asserts exactly one
   `owner_transfer_lock_unattributable` event — then run the "delete the `stop()` branch" mutation
   and *see it red*. If the human would rather not spend a criterion, ruling 118's precedent
   applies instead: the branch stays with a comment saying plainly that nothing pins it. What
   should not stand is the current state, where an unpinned deliverable reads as a pinned one.
2. **I-1.** Move `await expect(readOwnerRecord(runDir)).rejects.toBeInstanceOf(…)` above the
   lock-contents assertion in `keeps a lock non-recoverable when its live holder is in the strong
   instance-id form`, and re-run my lock-deleting mutation to see that criterion go red. Then Mi-2's
   comment becomes true again by itself.
3. **I-2 / I-3.** Two added assertions in N1: `expect(finalState.status).toBe("executing")` (or the
   `isTerminalRunStatus` form) and `expect(contended[0].detail).toContain("recovery blocked")`.
   Both are additions under ruling 4 and need no new named exception.
4. **Mi-1.** One sentence in the ledger recording that the first rewrite dropped
   `currentProcessInstanceId` as well as `currentOwnerEpoch`.
5. **Mi-4.** The plan's "corrections after execution" section should pick up the M5 expectation.
6. **A methodological note worth keeping.** The round already learned "which assertion went red is
   not a discriminator". C-1 adds its converse: **which mutation you did not run is not evidence
   either.** The eight-mutation table looks complete because every branch the round *added* has a
   mutation named after it — except the `stop()` branch, which is covered only indirectly, through
   another branch's mutation. A cheap structural check for the next round: for each branch added,
   name the mutation that deletes *that* branch, and confirm one exists.

---

## Assessment

**0 false claims found in the ledger, the spec, or the plan.** Every number I re-measured — the
613 baseline, the 4769-byte redline function, the byte-identity of `tryRecoverStaleOwnerTransferLock`,
the untouched call sites, the consumer census, M1/M3/M4/M5/M6/M8 — came back the way §42 records it.
Ruling 83's delete condition is unchanged cell for cell and survived my own attack on it. The
narrowing is exactly one class wide. The published-comment discipline held: not one comment line was
deleted in the whole range.

**The code in this round is, as far as I can measure it, correct.** What is not finished is the
proof. One of the three swallows the round exists to close — ruling 113's `stop()` path — can be
deleted without a single test going red, and that was neither measured nor disclosed; one of the
four named rewrites lost an assertion's weight to a reordering that ruling 88 forbids; and the
criterion carrying the whole `runLoop` commit pins two negatives where it should pin an outcome.

**Not ready as it stands** — but the gap is small and entirely in the criteria, not the production
code: one new criterion, one assertion reordering, and two added assertions. With those four edits
and their mutations seen red, I would call this round proven. Whether to merge or push is the
human's; nothing here argues against the change itself.
