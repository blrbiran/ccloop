# Independent re-review — human ruling 122: the fix round that answers the I-3(a) review

Range re-reviewed: `d4a9bb115bdd8f9114d4548af21e91130736b290..26da28e23479956ad9729aa8a211ff52a8cb17bf`.
`git rev-parse HEAD` on this checkout = `26da28e23479956ad9729aa8a211ff52a8cb17bf` — matches the brief.
Working tree clean before and after (`git status --porcelain`, `git diff`, `git diff --cached` all
**0 bytes**, via `rtk proxy … > file` then `wc -c`, at start and at end).

Every finding is labelled **measured** or **read-only argument**. Nothing in the brief, the ledger,
the plan, the errata or the previous reviewer's report was accepted without re-measurement. All
mutation was done in a `git clone --local` copy under the session scratchpad, which has been
restored (`git diff` 0 bytes, `git diff --cached` 0 bytes, `git status --porcelain` 16 bytes =
`?? node_modules`, my symlink), byte-compared against the checkout, and deleted with `/bin/rm -rf`.

Network: one read-only `git ls-remote origin` (see **I-1**). No container runtime. Nothing
installed. The only file I wrote inside the checkout is this report.

---

## Strengths

1. **All four load-bearing claims reproduce, each with the mutation that attacks *that* behaviour,
   and each was seen red — including the "before" half.** **Measured.** For the three fixes whose
   errata make a before/after claim I did not take the "before" on faith: I checked the BASE
   (`d4a9bb1`) version of the criterion file into the copy and re-ran the same mutation against it.

   | claim | mutation | at BASE | at HEAD |
   |---|---|---|---|
   | C-1 / ruling 123: the new criterion pins `stop()`'s recording branch | delete the whole release branch | (previous round: whole suite green; my run shows nothing else red) | **new criterion RED** — `expected [] to have a length of 1 but got +0` |
   | I-1 / ruling 124: the reorder restored weight | `await safeUnlink(lockPath)` at **both** unattributable exits | **5 red, the strong-holder criterion GREEN** | **6 red**, the strong-holder criterion **RED at the lock-contents assertion itself** |
   | I-2 / ruling 124: `executing` is pinned | the branch writes the terminal status `exhausted` | **29/29 GREEN** | **N1 RED** — `expected 'exhausted' to be 'executing'` |
   | I-3 / ruling 124: the path is pinned | revert the ruling-111 narrowing (M6) | **29/29 GREEN** | **N1 RED** — `expected 'owner transfer abandoned: …' to contain 'recovery blocked'` |

   The last row is worth its own sentence: the red *prints the transfer path's own wording*, so the
   measurement does not merely show the criterion failing, it shows **which branch produced the
   event** — exactly the discrimination I-3 said was missing.

2. **The new criterion cannot go green for the wrong reason, and I falsified that rather than
   reasoning about it.** **Measured.** I renamed the release branch's detail to the affirm branch's
   wording (`lease affirm blocked`) and left everything else alone: the criterion went **RED on the
   detail assertion**, and the received string
   (`lease affirm blocked: OwnerTransferLockUnattributableError: …`) proves the event came out of
   `releaseOwnerLease`'s catch and nowhere else. So the detail assertion is load-bearing, not
   decoration. The "no timer is advanced, so no affirm records first" premise also holds by
   measurement: under the branch-deletion mutation the run records **zero** events, not one from a
   throttled affirm.

3. **"No production code was changed" is true to the byte.** **Measured.**
   `rtk proxy git diff d4a9bb1..HEAD -- src/ package.json vitest.config.ts tsconfig.json` = **0
   bytes**. The redline function `tryRecoverStaleOwnerTransferLock`, re-located by signature
   (hit count = 1) and brace-matching rather than by line number, is lines **1017–1095**,
   **4769 bytes** including line 1095's trailing newline, sha256
   `dfb0155d5bdd0614f04fd3019976fe62951ab8c42311d4ba78a376c33a793405` — identical to what the
   previous review measured at `30dde52` and at `d4a9bb1`.

4. **Comment discipline held, measured rather than asserted.** **Measured.** Deletion counts for
   the whole range: `tests/controller/leaseHeartbeat.test.ts` 35/**0**,
   `tests/controller/leaseLifecycle.integration.test.ts` 21/**0**,
   `tests/persistence/fileStore.test.ts` 11/**1** — and that single deletion is the moved
   `readFile(… .owner-transfer.lock …)` assertion, not a comment. **Not one comment line was
   deleted anywhere in the range.** Both errata are named (`ERRATUM (I-3(a) FIX ROUND, HUMAN RULING
   124)`), neither carries a count, and neither cites a git hash or a branch.

5. **No fifth changed criterion, and nothing weakened.** **Measured.** Walking each changed hunk
   back to its enclosing `it(`: `fileStore.test.ts` hunk `@@ -929,11 +929,21 @@` lies inside
   `keeps a lock non-recoverable when its live holder is in the strong instance-id form`
   (lines 877–951); `leaseLifecycle.integration.test.ts` hunk `@@ -666,14 +666,35 @@` lies inside
   `abandons the attempt in place …` (618–707); `leaseHeartbeat.test.ts` hunk `@@ -386,6 +386,41 @@`
   is a pure addition between two existing criteria. Exactly **two** existing criteria changed, both
   named by ruling 124, and the only assertion that moved is present verbatim.

6. **Mi-2 really is repaired — I measured all three assertions, not just the one that goes red
   first.** **Measured.** The surviving comment says "Under the reverted guard all three of these
   fail." Under the guard revert (`pid === null` no longer a fail-closed exit) the criterion goes
   red on the *first* assertion, which tells you nothing about the other two, so I neutralised them
   one at a time in the copy: with assertion 1 neutralised, the **lock-contents** assertion fails
   (`ENOENT … .owner-transfer.lock`); with 1 and 2 neutralised, the **pending.json** assertion fails
   (`ENOENT … .owner-transfer.pending.json`). All three fail independently. The sentence is true
   again, which is precisely what it was not before the reorder.

7. **The erratum on I-1 is accurate down to a clause I expected to be loose.** **Measured.** It
   says "the other criteria named in the same rewrite went red and this one stayed green". The
   ruling-115 rewrite (`5365da1`) touched exactly four criteria — I recovered them by mapping that
   commit's deleted lines back to their enclosing `it(` in the pre-image: *staged artifacts are
   present*, *strong instance-id form*, *observes that the redline function actually ran*, *leaves
   the lock on disk when malformed staged state names no dead holder*. Under my lock-deleting
   mutation at BASE, three of those four went red and only *strong instance-id form* stayed green.
   The clause is exactly right. It also says the read is "moved back above them, where it stood
   before the rewrite" — verified against `5365da1~1`, where
   `const owner = await readOwnerRecord(runDir);` did sit above both file assertions.

8. **K-1 — the self-caught contradiction — checks out at the commit level.** **Measured.** Commit
   `6716ea3` contains **both** the `runLoop.ts` ruling-118 comment ("M8 deleted this line and the
   criterion below stayed green") **and** the test comment "Mutation M8 is what proves this pair is
   load-bearing". Same commit, opposite claims. And the erratum's own present-tense premise still
   holds: I re-ran M8 (delete `await writeOwnedRunState(runDir, state);` from the new branch) and
   got **614/614 green, RC=0** — the added assertions did not accidentally make that pair
   load-bearing.

9. **Ledger §43's own numbers reproduce, including the one I expected to be unverifiable.**
   **Measured.** §43 records the copy's restored baseline as `git diff` = **7821 bytes** (the three
   uncommitted criterion files). `rtk proxy git diff d4a9bb1..HEAD -- tests/` is **7821 bytes**.
   The Mi-1 correction also checks out: `5365da1` deleted **both**
   `expect(owner.currentOwnerEpoch).toBe(1)` and
   `expect(owner.currentProcessInstanceId).toBe("pid:12345")` from *staged artifacts are present*,
   and only `currentOwnerEpoch` from *strong instance-id form*.

10. **The round's own new mechanical check, applied to the whole I-3(a) round, now passes.**
    **Measured, five mutations, each seen red.** "For each branch added, name the mutation that
    deletes *that* branch." Every one of the five branches the round added now has one:

    | branch | mutation | result |
    |---|---|---|
    | `fileStore` ruling-111 narrowing | delete the `throw error` arm | 5 red (4 ruling-115 criteria + N1) |
    | `resumeLoop` entry-read detail | collapse back to `cannot read run artifacts` | N2 red |
    | `runLoop` abandonment branch | delete the branch | N1 red |
    | `leaseHeartbeat` affirm recording | delete the branch | N3 red |
    | `leaseHeartbeat` release recording | delete the branch | **new criterion red** |

    Before this round the last row was empty. That is the whole point of the round, and it is now
    true by measurement rather than by table.

11. **The two criteria that touch `stop()` are complementary, not redundant.** **Measured.**
    Dropping only the stop branch's `&& !unattributableLockRecorded` guard turns **N4** red (a
    second event appears) while the new criterion stays green; deleting the whole release branch
    turns the **new criterion** red while N4 stays green. Each pins something the other does not.

12. **The baseline reproduces.** **Measured.** `35 files / 614 tests` passed, **0 skipped**,
    `TEST_RC=0`, duration 18.23s, vitest's first `RUN` line = `/Users/biran/code/skills/loop/ccloop`;
    `npm run typecheck` rc=0; `npm run build` rc=0. Unfiltered, redirected to a file, read back whole.

---

## Critical

**None.** I attacked each of the four fixes with the mutation that names it and each went red; I
attacked the new criterion a second way (detail wording) and it went red there too; and I looked
for a fifth changed criterion and a weakened assertion and found neither.

---

## Important

### I-1 — The round is **published**, and both the ledger and the handoff say it is not. That changes which rule governs its own comments.

**Measured, and this is a fact about the world, not a defect in the fix.**

- `rtk proxy git ls-remote origin` →
  `26da28e23479956ad9729aa8a211ff52a8cb17bf	refs/heads/main` (and the same for `HEAD`).
- `.git/logs/refs/remotes/origin/main`'s last entry: `d4a9bb1… → 26da28e…`, `update by push`,
  timestamp `1787927282` = **2026-08-28 22:28:02 +0800** — about four minutes after `26da28e` was
  committed (22:24:08), and within seconds of my baseline run starting.

Three documents are now stale on this point, in descending order of consequence:

1. **The re-review brief itself** says `BASE_SHA = d4a9bb1 … also the current remote tip —
   everything at or below it is PUBLISHED`, which invites the reader to conclude that the three
   fix commits are not. They are.
2. **Ledger §43** ends with "**控制器不许 push。本节三笔与前面七笔全部只在本地。**" — true when
   written, false now.
3. **`docs/handoff/handoff.md`** (as amended by `26da28e` itself) says "修复轮那三笔（8–10）写本文
   时**只在本地**". True when written, false four minutes later.

**Why it matters, and it is not bookkeeping.** This package's comment rule is keyed on exactly this
bit: *published ⇒ verbatim + appended named erratum, never in-place*. Until 22:28 today the next
round could have edited this round's two new errata and the new criterion's comment in place. It no
longer can. If a future measurement falsifies anything inside `ERRATUM (I-3(a) FIX ROUND, HUMAN
RULING 124)` — either copy — the only legal repair is a *further* appended erratum.

**Mitigation already present, and it is the right one.** The handoff's own line immediately after
the stale sentence reads "⇒ *** 开工第一件事是自己现跑 `git ls-remote`，别信这一句。***", and the
line below it spells out the consequence for the comment rule. The document inoculates itself; I
followed it and that is how I found this.

**Disposition: raised, acted on only by reporting.** I changed nothing. The next ledger section /
handoff should record that the round is published and that its errata are now frozen text. I make
no recommendation about pushing or merging — that is the human's, and it has already happened.

---

## Minor

### Mi-1 — `unattributableLockRecorded = true;` inside the `stop()` branch is pinned by nothing, and cannot be

**Measured, seen green.** I removed just that assignment (leaving the guard and the
`appendLeaseEvent`) and ran the **full** suite: `35 files / 614 tests passed, RC=0`.

**Read-only argument for why no criterion could pin it.** `stop()` sets `stopped = true` before it
reaches `releaseOwnerLease`, and is idempotent (`if (stopped) return;`); `runAffirm` returns
immediately once `stopped`; `releaseOwnerLease` is called from nowhere else. So nothing in the
process can observe the flag after `stop()` has set it. The write is dead by construction, kept for
symmetry with the affirm branch.

**Disposition: raised, no fix recommended.** This is not a false claim — the round never said it was
pinned — and it is not the C-1 defect class, because there is no reachable behaviour behind it. I
record it because this package's stated standard is that an unpinned line says so out loud, and by
that standard a half-sentence in the existing ruling-113 comment would settle it. I would not spend
a criterion on it; there is none to spend.

### Mi-2 — Three of the round's new comments anchor positionally

**Read-only argument, verbatim-anchored.** The new criterion's comment opens "The criterion above
exercises `stop()` only AFTER three ticks have already recorded" (hit count 1); the I-3 comment says
"the three assertions above are satisfied by EITHER of them" (hit count 1); the K-1 erratum says
"the last sentence above is FALSE" (hit count 1). All three are true today — I verified the first
(N4 does tick exactly three times, `for (let tick = 0; tick < 3; tick += 1)`) and the second (there
are exactly three assertions above the added line). All three are also falsifiable by an *insertion*
that touches neither comment, which is this package's signature defect class, and all three are now
published, so the repair would have to be a further erratum.

**Disposition: raised, deliberately not acted on.** Naming the neighbour ("the criterion
`records the unattributable lock at most once per run…`") instead of "above" is the cheap
prophylactic, but it is an in-place edit of published text and therefore not available now.

### Mi-3 — "Nothing was added, removed or weakened" is literally false of the hunk it sits in

**Read-only argument.** The `fileStore.test.ts` erratum ends "Nothing was added, removed or
weakened." The hunk that carries that sentence adds ten comment lines. In context the scope is
obviously *the assertions*, and of the assertions the sentence is exactly true — I verified the
assertion set is unchanged (11 added / 1 deleted, the single deletion being the moved assertion).

**Disposition: raised, not acted on.** Wording only, and repairing it would cost a further erratum
on published text for no gain in truth.

### Mi-4 — Mi-3 and Mi-5 of the previous report remain open, by ruling

**Read-only argument, for the record only.** N4's name still says "across repeated ticks and
`stop()`" while entering `stop()` with the flag already `true`, and
`owner_transfer_lock_unattributable` still has no consumer in `src/`. The brief rules both out of
scope (a rename needs its own naming from the human; the consumer is ruling 85's docket), and I
found **no new consequence** of either: the new criterion does not make N4's name more misleading
than it was, and it adds no second producer of the event type.

**Disposition: not raised as findings — recorded so the next reader can see they were checked, not
forgotten.**

---

## Verification performed

Every command was run unfiltered, redirected to a file, and read back whole. `rtk proxy` was used
for every git measurement so rtk's filter layer could not lie about byte counts. Tests were run as
`ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run` (full suite) or
`… rtk proxy npx vitest run --run <file>` (single file), never piped.

**On the checkout (read-only throughout):**

| what | result | label |
|---|---|---|
| `git rev-parse HEAD` | `26da28e2…` — matches the brief | measured |
| `git status --porcelain` / `git diff` / `git diff --cached`, start and end | 0 / 0 / 0 bytes, twice | measured |
| full suite | `35 files / 614 tests` passed, **0 skipped**, `TEST_RC=0`, 18.23s, `RUN` = this checkout | measured |
| `npm run typecheck` / `npm run build` | rc 0 / rc 0 | measured |
| `git diff d4a9bb1..HEAD -- src/ package.json vitest.config.ts tsconfig.json` | **0 bytes** | measured |
| redline function, brace-matched from its unique signature | 1017–1095, **4769 bytes**, sha256 `dfb0155d…` | measured |
| `git diff --numstat` for the range | leaseHeartbeat.test 35/0, leaseLifecycle.test 21/0, fileStore.test 11/1; docs only otherwise | measured |
| changed-criterion map (walk-back to nearest `it(`) | exactly 2 existing criteria, both ruling-124's; 1 pure addition; **no fifth** | measured |
| `git diff d4a9bb1..HEAD -- tests/` byte count | **7821** — §43's copy-baseline number reproduces | measured |
| `5365da1` deleted lines mapped to criteria | Mi-1's correction confirmed; the four ruling-115 rewrites identified by name | measured |
| `5365da1~1` pre-image ordering | `readOwnerRecord` did sit above both file assertions before the rewrite | measured |
| `6716ea3` contents | contains both the ruling-118 comment and the false "M8 … load-bearing" sentence | measured |
| `git ls-remote origin` + `.git/logs/refs/remotes/origin/main` | remote `refs/heads/main` = `26da28e…`, pushed 2026-08-28 22:28:02 +0800 | measured |
| N4's tick count, `stop()`/`runAffirm` reachability after `stopped` | three ticks; nothing observes the flag after `stop()` | read-only argument |

**In the `git clone --local` copy** (`node_modules` symlinked from the checkout; every mutation
applied through a verbatim anchor with an asserted hit count of 1):

| # | mutation | scope | result | label |
|---|---|---|---|---|
| A | delete the whole `stop()` release-recording branch | full suite | **new criterion RED** (`expected [] to have a length of 1`); the only other red was the listed flake `records env names only…`, run 18.84s | measured, seen red |
| B | rename the release detail to `lease affirm blocked` | leaseHeartbeat | **new criterion RED** on the detail assertion; received string proves the release path emitted it | measured, seen red |
| C | `safeUnlink(lockPath)` at both unattributable exits | fileStore | **6 red**, incl. *strong instance-id form* failing **on the lock-contents assertion** | measured, seen red |
| C′ | same mutation, **BASE** `fileStore.test.ts` | fileStore | **5 red**; *strong instance-id form* **GREEN** | measured, seen green |
| D | the branch writes terminal `exhausted` | leaseLifecycle | **N1 RED**: `expected 'exhausted' to be 'executing'` | measured, seen red |
| D′ | same mutation, **BASE** `leaseLifecycle…test.ts` | leaseLifecycle | **29/29 GREEN** | measured, seen green |
| E | revert the ruling-111 narrowing (M6) | full suite | **5 red**: the four ruling-115 criteria **+ N1**, N1 on `recovery blocked` with the transfer path's wording printed | measured, seen red |
| E′ | same mutation, **BASE** `leaseLifecycle…test.ts` | leaseLifecycle | **29/29 GREEN** | measured, seen green |
| F | M8: delete `await writeOwnedRunState(runDir, state);` | full suite | **614/614 GREEN, RC=0** | measured, seen green |
| G | M1: delete the whole `runLoop` branch | leaseLifecycle | **N1 RED** (`contended` length 0) | measured, seen red |
| H | revert the `pid === null` fail-closed exit | fileStore | 3 red incl. *strong instance-id form*, failing on `readOwnerRecord` | measured, seen red |
| H2 | H + assertion 1 neutralised | that criterion | **lock-contents assertion RED** (`ENOENT … .owner-transfer.lock`) | measured, seen red |
| H3 | H + assertions 1 and 2 neutralised | that criterion | **pending.json assertion RED** (`ENOENT … .owner-transfer.pending.json`) | measured, seen red |
| I | drop `&& !unattributableLockRecorded` from the stop branch only | leaseHeartbeat | **N4 RED**; new criterion green | measured, seen red |
| J | delete `unattributableLockRecorded = true;` from the stop branch | full suite | **614/614 GREEN** ⇒ Mi-1 | measured, seen green |
| M3 | collapse the `resumeLoop` entry-read detail back | resumeLoop | **N2 RED** | measured, seen red |
| M4 | delete the affirm recording branch | leaseHeartbeat | **N3 RED**; new criterion green | measured, seen red |

**Restoration proof.** Every file was restored with `cat pristine > target` (never `cp`, aliased to
`-i`). Final state of the copy: `rtk proxy git diff` = **0 bytes**, `rtk proxy git diff --cached` =
**0 bytes**, `git status --porcelain` = **16 bytes**, whose entire content is `?? node_modules` (my
symlink). Before deletion I byte-compared all seven touched files against the checkout's — equal
length **and** equal bytes in all seven (`leaseHeartbeat.ts` 18287, `runLoop.ts` 71396,
`fileStore.ts` 90353, `resumeLoop.ts` 14995, `leaseHeartbeat.test.ts` 42406,
`leaseLifecycle.integration.test.ts` 103420, `fileStore.test.ts` 260652). The copy was then removed
with `/bin/rm -rf`. The checkout's `git status --porcelain` / `git diff` / `git diff --cached` are
0 / 0 / 0 bytes and HEAD is unmoved.

**Flakes.** I hit exactly one of the four listed flakes, once
(`run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`,
`Test timed out in 5000ms`, during mutation A, total duration 18.84s — below the 25–29s load
signature). No conclusion rests on it: mutation A's finding is a *different* test going red.

---

## Recommendations

1. **Record that the round is published.** The next ledger section and the handoff should carry
   what `git ls-remote` says today, and should say the consequence explicitly: this round's two
   errata and the new criterion's comment are now frozen text, correctable only by a further
   appended named erratum. The handoff's existing "开工第一件事是自己现跑 `git ls-remote`" line is
   the reason I found it — keep it.
2. **Keep the mechanical check, and note that it now passes for the whole I-3(a) round.** "For each
   added branch, name the mutation that deletes *that* branch" is the check that would have caught
   C-1 a round earlier. All five of this round's branches now satisfy it, measured. Worth recording
   as a completed check rather than only as a rule for next time.
3. **Add one sub-rule the reorder taught, in the same place.** The round already recorded
   "position is as load-bearing as text". The operational form is narrower and cheaper: *a
   before-the-call assertion that reads back a value the test itself wrote cannot fail.* A rewrite
   review can look for that pattern directly, without a mutation.
4. **Mi-1 needs no criterion.** If the package wants every unpinned line to say so, half a sentence
   in the existing ruling-113 comment covers the dead flag write — but that comment is published
   too, so it costs an erratum, and the line has no reachable behaviour behind it. My advice is to
   leave it and let this report be the record.
5. **Nothing here argues against the change.** The four repairs do what they claim, and I could not
   find a fifth changed criterion, a weakened assertion, or a false sentence inside either erratum.

---

## Assessment

**0 false statements found in the two errata, the new criterion's comment, ledger §43, or the
plan's second corrections section.** This was the sharpest thing available — the round exists
because a published comment said something false — and I went after it specifically: "M8 went
green" (re-ran it: 614/614 green), "the criterion was green before and red after" (re-ran it
against the BASE file: green at BASE, red at HEAD, failing on the named assertion), "no production
code changed" (0-byte diff over `src/` and the config files), "the other criteria named in the same
rewrite went red" (recovered the four names from `5365da1` and confirmed three red, one green),
"M8 and the ruling-118 comment are in the same commit" (they are), and §43's own 7821-byte copy
baseline (it reproduces exactly). Every one held.

**The four fixes are proven, not merely present.** Each has a mutation that attacks the specific
behaviour it claims to pin, each mutation was run by me and seen red, and for the three that make a
before/after claim I measured the "before" too rather than inheriting it. The new criterion
additionally survives a second, independent attack (detail wording) that a type-only assertion would
have failed. The previous review's C-1, I-1, I-2 and I-3 are each answered by something that
measurably fails when the behaviour is removed.

**The gaps that remain are small and none is in the fixes.** One dead flag write nothing can pin;
three comments anchored by position rather than by name; one sentence whose literal scope is wider
than its meaning. The one finding with real consequence is documentary and not the round's fault:
the human pushed the round four minutes after it was written, so the premise "these three commits
are local" — held by the brief, by §43 and by the handoff — is now false, and the comment rule that
follows from it has changed.

I make no statement about point B, about the disposition of any C-1 cell, or about E1, and I do not
say what should be done with the branch. On the question this re-review was asked: **the fix round
does what it claims, and I could not make it look like a fix that is only a fix in appearance.**
