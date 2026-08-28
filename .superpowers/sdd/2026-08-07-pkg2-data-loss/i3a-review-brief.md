# Review brief — human ruling 120: the I-3(a) round plus the two `leaseHeartbeat` swallows

You are an independent reviewer. You did not write any of this. **Nothing in this brief is
established fact — every number in it is the controller's, and the controller has been wrong before
in exactly this way.** Treat the whole document as a set of claims to check, not a set of givens.

⚠️ *** **BRIEFS IN THIS PACKAGE HAVE MISLED THEIR REVIEWERS BEFORE.** *** One told its reviewer that
an earlier section's figures used an irreproducible metric; that instruction was false, and the
reviewer inherited the false premise and only caught half of it (ledger §38). ⚠️ **And the previous
round's own review report contains a wrong census** of the sites that consume the error class at the
centre of this round — ledger §41 records the correction. **Do not inherit that census either;
re-take it yourself.**

---

## Range

```
BASE_SHA = 30dde526c17f850be581bbefe9764e00ef9bb4b4   (the handoff rewrite; this round starts at the
                                                       next commit)
HEAD_SHA = d4a9bb115bdd8f9114d4548af21e91130736b290   (run `git rev-parse HEAD` yourself; if it
                                                       differs, STOP and say so — nothing should be
                                                       moving HEAD while you work)
```

**Four commits are the SUBJECT of this review** (find them by subject line, never by count):

| | subject line | what it claims |
|---|---|---|
| 1 | `fix(fileStore): stop a lock that can never clear from being swallowed as if it would …` | narrows `recoverInterruptedOwnerTransfer`'s bare `catch`; rewrites 4 named criteria |
| 2 | `fix(resumeLoop): stop calling a blocked recovery an unreadable artifact …` | entry read names the real error |
| 3 | `fix(runLoop): route a blocked transfer recovery to abandonment, not to a failed attempt …` | one outer-catch route |
| 4 | `fix(leaseHeartbeat): stop retrying a lock that can never clear in silence …` | two swallows each record one event |

The other commits in the range are spec / plan / ledger / handoff **documents**. They are context,
**and their factual claims are fair game** — this package has shipped false claims in its own ledger
before. Do not spend the review on prose style.

⚠️ Two of those documents carry **self-corrections that supersede their own body text**: the spec's
**§7** and the plan's trailing **"corrections after execution"** section. Read the body **through**
those corrections; the corrections win.

---

## The binding rulings this round claims to encode

- **109 / 110** — one round covering I-3(a) **and** the two `leaseHeartbeat` swallows. Ruling 110
  invoked ruling 100 to close review **only on the single commit of ruling 108**; it does **not**
  cover this round. That is why you are here (ruling 120).
- **111** — `readOwnerRecord` meeting an unattributable transfer lock must **fail closed**: narrow
  the `catch` and let it throw.
- **112 / 113** — the heartbeat's `runAffirm` path and its `stop()` path each record **one** event,
  **with behaviour unchanged in every other respect** (tick contract, retry behaviour, release
  contract).
- **114** — `runLoop` takes "option B": **one** route in the outer catch around `runLoopFromState`;
  **both call sites unchanged, not one line.**
- **115** — names **exactly four** existing criteria the implementer may rewrite, all in
  `tests/persistence/fileStore.test.ts`:
  - `keeps a malformed lock non-recoverable even when staged artifacts are present`
  - `keeps a lock non-recoverable when its live holder is in the strong instance-id form`
  - `observes that the redline function actually ran on the strong-holder fixture`
  - `leaves the lock on disk when malformed staged state names no dead holder`
  Ruling 88's conditions bind: whole-criterion rewrite, **no relaxation**, and each rewrite must say
  which ruling it encodes.
- **118** — the `writeOwnedRunState` line that mutation M8 could not kill **stays**, with a comment
  saying plainly that no criterion pins it.
- **119** — the heartbeat must use **its own** event type `owner_transfer_lock_unattributable`, not
  the shared `owner_transfer_contended`.
- **83** (unchanged, and this round claims not to touch it): the ONLY exit that may delete an existing
  lock is "contents parse + `holderProcessInstanceId` is `pid:<n>` + that process is not alive".
  Every other exit fails closed.
- **86**: liveness here is the **two-state** `isProcessActive`, not E1's three-state classifier.

---

## What the implementer claims — treat each as a claim to check

1. **Ruling 83's delete condition is unchanged cell for cell, and the redline function
   `tryRecoverStaleOwnerTransferLock` was not modified by a single character this round.**
   ⚠️ **This is the single most important thing to falsify.** The round narrows a `catch` in the
   function's *caller*; a new delete path or a newly-reachable one could hide in that reshuffle.
2. **The narrowed `catch` lets exactly one class out.** `OwnerTransferLockBusyError` and the errno
   cells behave identically to before, cell for cell. ⚠️ Check what happens to error types nobody
   thought about — a third class, a non-`Error` throw, an `AggregateError`.
3. **`runLoop` gained exactly one branch, in the outer catch,** and the attempt is abandoned in
   place: **not** judged `failed`, **not** judged `cancelled`. **Both call sites are byte-identical.**
4. **`resumeLoop`'s entry read now names the error** instead of reporting
   `cannot read run artifacts: …`.
5. **The two heartbeat swallows each record one event and change nothing else** — same tick cadence,
   same retry behaviour, same release contract, and the `stop()` path's deliberate `catch {}` still
   swallows (by design) after recording.
6. **The four rewrites under ruling 115 strengthen rather than relax**: the carrier changed to
   `rejects.toBeInstanceOf(OwnerTransferLockUnattributableError)` while **the lock-on-disk, the
   staged-pending-not-finalized, and the `lockReads > 0` assertions are preserved verbatim**.
   ⚠️ **Check the whole diff for a fifth changed criterion** — anything changed that ruling 115 did
   not name is a violation regardless of whether it looks harmless.
7. **Four criteria were added** (N1–N4):
   - `abandons the attempt in place when the ownership read hits an unattributable transfer lock,
     without failing the run` (leaseLifecycle.integration)
   - `names an unattributable transfer lock on the entry read, instead of calling the artifacts
     unreadable` (resumeLoop.integration)
   - `records an unattributable owner-transfer lock once, and keeps ticking` (leaseHeartbeat)
   - `records the unattributable lock at most once per run, across repeated ticks and stop()`
     (leaseHeartbeat)
8. **Eight mutations were run** (ledger §42's table). ⚠️ **One of them — M8, deleting a whole
   `writeOwnedRunState` line — did NOT go red**, which is what produced ruling 118. **Check whether
   any of the other seven is hollow in the same way**, and whether M8's surviving line is genuinely
   unpinned or merely pinned by something nobody looked for.
9. **The published-comment discipline was honoured**: ruling 104's existing ERRATUM is preserved
   verbatim with a new named ERRATUM appended, and no published comment was edited in place.
10. **All three swallow sites are now handled** and no fourth exists. ⚠️ **Take this census yourself.**
    The previous round's report got a census of this exact error class wrong (ledger §41).

---

## Protocol — binding

1. **Read-only on this checkout.** Never move HEAD, the index, or a branch. Never push, merge,
   commit, or delete a branch or worktree.
2. **Do not accept the implementer's self-report.** Re-measure anything you rely on.
3. **Reading the code is not measuring it.** Label each finding **measured** or **read-only argument**.
4. **Mutation only in a `git clone --local` copy.** *** Restoration is proven by the BYTE COUNTS of
   both `rtk proxy git diff` and `rtk proxy git diff --cached` on the copy — `diff -r` is NOT a
   restoration proof, it cannot see the index. *** ⚠️ `git clone --local` clones committed state
   only. ⚠️ This machine aliases both `cp` and `rm` to their `-i` forms: `cp` can silently decline to
   overwrite and a plain `rm -rf` will HANG on a prompt until it times out. Use `cat pristine >
   target` and `/bin/rm -rf`. ⚠️ The clone has no `node_modules`; symlink the checkout's.
   ⚠️ **Before deleting a copy, byte-compare its criterion files against the checkout's** — that is
   how you prove a mutation never touched a test.
5. **Never filter a verification run** (`grep`/`tail`/`head`/`sed` alike; a pipe also steals the exit
   code). Redirect to a file, read the whole file back, check vitest's first `RUN` line points at the
   checkout you meant. Run tests as
   `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run`.
   ⚠️ **rtk's filter layer will lie to you**: it prints `ok` for an empty `git status --porcelain`,
   reports a 0-byte `git diff` as 1 byte, truncates long grep output to `[+N more]`, and errors on
   regexes containing parentheses. Any restoration proof or byte comparison must go through
   `rtk proxy git …` redirected to a file, then `wc -c`. Read large files with `sed -n 'a,bp'` or
   python, not grep.
6. **Local machine and network.** You **MAY** use this machine's container runtime and pull public
   images to take a measurement. ⚠️ **Measured at dispatch: OrbStack's daemon is DOWN**
   (`/Users/biran/.orbstack/run/docker.sock` does not exist). **Linux is OUT OF SCOPE this round**
   (see below) — you do not need it. You **MUST** report any such action if you take one. You
   **MUST NOT** install anything into this repository, modify machine configuration, or touch
   anything belonging to another running line of work.
7. **A bad probe proves nothing** — not absence, not violation. Check your probes before believing
   them. *** This package has been burned four times: `timeout` not existing on macOS read as "no
   container runtime"; `awk length()` counting bytes read as characters, which produced a false
   published accusation; `git clone --local` cloning committed state read as cloning the working
   tree; and a mutation that proved nothing while looking like a proof. ***
8. *** **A MUTATION IS NOT A PROOF UNTIL YOU HAVE SEEN IT GO RED.** *** Applies to your own
   mutations too. ⚠️ **And "which assertion went red" is not a reliable discriminator** — this round
   learned it the hard way: an earlier assertion in the same criterion short-circuits before the one
   you care about. **If you want to know a value, print that value.**
9. Every finding needs a **constructible scenario**, and code references must be **anchored** by
   verbatim block plus a hit count, **never by line number** — line numbers in this package rot fast.
   ⚠️ Anchor predicates need care too: a criterion name occurring twice in the tree may simply be two
   criteria citing each other in comments.
10. **A finding and its disposition are two different things.** Report it either way, saying which.
11. ⚠️ **KNOWN FLAKES — FOUR, NOT TWO.** Under load these time out at `Test timed out in 5000ms`;
    they are not regressions and are not to be investigated:
    - `run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
    - `runLoop > persists phase usage evidence from the subprocess adapter without recomputing
      controller totals`
    - `runLoop > accounts an execute timeout that rejects after the abort as exhaustion`
    - `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting
      stale run data`
    A red run whose **total duration is ~25–29s** rather than the usual **17–22s** is the load
    signature. Re-run the single file before concluding anything.

---

## Baseline measured on this checkout immediately before dispatch

- *** **`35 files / 613 tests` passed, 0 skipped** ***; `TEST_RC=0`; `typecheck` rc=0; `build` rc=0;
  duration 18.66s (`real 19.22`); vitest's `RUN` line pointed at
  `/Users/biran/code/skills/loop/ccloop`.
- Working tree clean: `git status --porcelain` = **0 bytes**, `git diff` = **0 bytes**,
  `git diff --cached` = **0 bytes** (all via `rtk proxy … > file` then `wc -c`).
- *** **The criterion baseline is 613.** *** 609, 604, 603, 602, 601, 600 are all dead numbers.
- *** **Redline function `tryRecoverStaleOwnerTransferLock` = 4769 bytes.** *** ⚠️ **THE METRIC,
  because omitting it cost an earlier session a dead end**: `src/persistence/fileStore.ts`, the
  whole-line range **1017–1095 inclusive, including the trailing newline of line 1095**
  (equivalently `sed -n '1017,1095p' … | wc -c`). Signature hit count = 1.
  ⚠️ **Line numbers move — re-locate by signature and brace matching before you measure.**
  ⚠️ **The 3185 and 4496 baselines are VOID.**
- ⚠️ **darwin only.** The suite is known red on linux (`5 failed / 593 passed`, measured by a
  previous reviewer on an unrelated round). **No cell of this package has been run on linux for
  several rounds.** Do not repeat that claim more broadly than it was made.

---

## Out of scope — recorded elsewhere, not yours to re-raise

- **E1's I-2 cell** (array holder + dead pid ⇒ `inspectLock` answers `dead` rather than
  `unrecognized-holder`, so `unlockCommand` deletes without `--force`). Recorded in a comment,
  code deliberately untouched — E1 is outside this package's authorisation surface. It is docketed
  under a separate ruling. Naming a NEW consequence is in scope; re-raising the cell is not.
- **`ccloop ls` reporting locks** (ruling 85) — docketed for its own round.
- **linux** — the one real coverage gap, docketed, and it needs the human to start the daemon.
- **package 1**, and **every commit at or below `30dde52`**. In particular the commit
  `fix(fileStore): name the exit for what the two-state predicate actually computes …`
  (ruling 108) sits **below** the base: ruling 110 closed it under ruling 100, and it is not yours.
- *** **Do not declare point B passed, C-1 closed, or E1 anything** *** — rulings 101/102/103 already
  ruled all three. Re-ruling them is not yours.
- **Whether this round should be merged or pushed.** The controller may not push; that is the
  human's. Say whether it is ready, not what to do with it.

---

## Deliverable

Write your report to `.superpowers/sdd/2026-08-07-pkg2-data-loss/i3a-review.md` (that directory's
`.gitignore` is `*` — **do not commit it yourself**). Sections:
Strengths / Critical / Important / Minor / Verification performed / Recommendations / Assessment.
Return the same content as your final message.
