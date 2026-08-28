# Re-review brief — human ruling 122: the fix round that answers the I-3(a) review

You are an independent reviewer. You did not write any of this, and you are **not** the reviewer who
wrote the report being answered here. **Nothing in this brief is established fact — every number in
it is the controller's, and the controller has been wrong before in exactly this way.**

⚠️ *** **BRIEFS IN THIS PACKAGE HAVE MISLED THEIR REVIEWERS BEFORE.** *** One asserted a false
premise about a measurement metric and its reviewer inherited it (ledger §38). Another package
document shipped a census that was wrong (§41). **Treat this document as claims to check.**

⚠️ *** **THE ROUND YOU ARE REVIEWING IS ITSELF A CORRECTION ROUND.** *** The previous review found
that the round before it had shipped a criterion whose assertion could not fail, and a branch no
criterion pinned at all. **A fix round is exactly where a fix that only looks like a fix hides.**

---

## Range

```
BASE_SHA = d4a9bb115bdd8f9114d4548af21e91130736b290   (the reviewed round's tip; also the current
                                                       remote tip -- everything at or below it is
                                                       PUBLISHED)
HEAD_SHA = 26da28e23479956ad9729aa8a211ff52a8cb17bf   (run `git rev-parse HEAD` yourself; if it
                                                       differs, STOP and say so)
```

**Three commits are the SUBJECT of this review** (find them by subject line, never by count):

| | subject line | what it claims |
|---|---|---|
| 1 | `test(fileStore): restore the weight the ruling-111 rewrite took out of one assertion …` | one assertion reordered, nothing else |
| 2 | `test(runLoop): pin the outcome and the path this criterion only implied …` | two assertions added + one erratum |
| 3 | `test(leaseHeartbeat): pin the release-path record that nothing was pinning …` | one criterion added, pure addition |

*** **No production code was changed in this round.** *** That is itself a claim — check it.

The other two commits in the range are ledger / handoff / plan **documents**: context, and their
factual claims are fair game.

---

## What this round is answering

The previous review's report is at `.superpowers/sdd/2026-08-07-pkg2-data-loss/i3a-review.md`, and
its brief at `…/i3a-review-brief.md`. **Read the report** — it is the specification this round is
measured against. Its dispositions:

| finding | what this round did |
|---|---|
| **C-1** (Critical): ruling 113's `stop()` recording branch is pinned by nothing | **human ruling 123**: add a criterion (NOT the ruling-118-style disclosure comment, which the human explicitly declined — the branch is pinnable, so it gets pinned) |
| **I-1**: a ruling-115 rewrite moved an assertion ahead of the code under test | **human ruling 124**: reorder back, keep every assertion, append a named erratum |
| **I-2**: N1 pins two negatives, not an outcome | **ruling 124**: add `expect(finalState.status).toBe("executing")` |
| **I-3**: N1 cannot tell the new branch from the ruling-106 transfer branch | **ruling 124**: add `expect(contended[0].detail).toContain("recovery blocked")` |
| **Mi-1**: a second dropped assertion was undisclosed | recorded in ledger §43 |
| **Mi-2**: a comment made false by the reordering | resolved by I-1's reorder — **verify that it really is true again** |
| **Mi-4**: the plan's M5 expectation is wrong | recorded in the plan's SECOND corrections section |
| **Mi-3** (N4's name over-claims its `stop()` coverage) and **Mi-5** (the new event type has no consumer) | **deliberately not acted on.** Mi-3 would mean renaming an existing criterion, which needs its own naming from the human; Mi-5 is ruling 85's docket. **Re-raising either is not in scope; a NEW consequence of either is.** |

**Plus one finding the previous reviewer did not make, which the controller made against itself
(K-1)**: the runLoop commit shipped two comments about mutation M8 that contradict each other —
`runLoop.ts` says M8 went green and nothing pins the line, while the criterion's comment said
"Mutation M8 is what proves this pair is load-bearing". The false sentence is kept verbatim with a
named erratum appended, because that text is **published**. ⚠️ **Check the erratum's own claims.**

---

## What the implementer claims — treat each as a claim to check

1. **The new criterion actually pins the `stop()` branch.** Deleting that branch turns it red, and
   it cannot go green for the wrong reason: it asserts the DETAIL (`lease release blocked`, the
   release path's wording) rather than only the event type, and it advances no timer, so no affirm
   records first. ⚠️ **Falsify by running the deletion yourself, and by asking what else could make
   that event appear.**
2. **The reorder restored weight and relaxed nothing.** Every assertion of the reordered criterion
   is present and unchanged in text; only the position of the `readOwnerRecord` call moved, back to
   where it stood before the ruling-115 rewrite. Claimed measurement: under a mutation adding
   `safeUnlink(lockPath)` to **both** unattributable exits, that criterion was **green** before this
   round and is **red after it, failing on the lock-contents assertion itself**. ⚠️ **Reproduce it,
   or say you did not.**
3. **`executing` is what the branch genuinely returns**, not an artefact of this fixture, and the
   assertion kills a mutation writing the terminal status `exhausted` (which previously left the
   whole suite green).
4. **The `recovery blocked` assertion kills the reverted-narrowing mutation**, which previously left
   this criterion green while the branch was never entered at all.
5. **No existing criterion was changed other than the one ruling 124 named**, and none was weakened.
   ⚠️ **Check the whole diff for a fifth changed criterion, and check that the reordered criterion
   did not lose an assertion in the process.**
6. **Comment discipline held**: no published comment edited in place; each erratum is named, carries
   no new counts, and cites no moving git reference.
7. **The errata and the ledger say only true things.** ⚠️ This is the round that exists *because* a
   comment said something false; a false statement inside its own erratum would be the sharpest
   possible finding. In particular: "M8 went green", "the criterion was green before and red after",
   "no production code changed".
8. **Ledger §43** records rulings 120–124, the review's verdict, the controller's own re-measurement
   of all four load-bearing claims, Mi-1's correction, and the new baseline.

---

## Protocol — binding

1. **Read-only on this checkout.** Never move HEAD, the index, or a branch. Never push, merge,
   commit, or delete a branch or worktree. Do not `npm install` or change machine configuration.
2. **Do not accept the implementer's self-report, and do not accept the previous reviewer's.**
   Re-measure anything you rely on.
3. **Reading the code is not measuring it.** Label each finding **measured** or **read-only argument**.
4. **Mutation only in a `git clone --local` copy.** *** Restoration is proven by the BYTE COUNTS of
   `rtk proxy git diff` and `rtk proxy git diff --cached` in the copy — `diff -r` is NOT a
   restoration proof, it cannot see the index. *** ⚠️ `git clone --local` clones committed state
   only (this round is fully committed, so the clone is enough). ⚠️ This machine aliases both `cp`
   and `rm` to their `-i` forms: `cp` can silently decline to overwrite and a plain `rm -rf` will
   HANG on a prompt. Use `cat pristine > target` and `/bin/rm -rf`. ⚠️ The clone has no
   `node_modules`; symlink the checkout's. ⚠️ **Before deleting the copy, byte-compare its criterion
   files against the checkout's.**
5. **Never filter a verification run** (`grep`/`tail`/`head`/`sed` alike; a pipe also steals the exit
   code). Redirect to a file, read the whole file back, check vitest's first `RUN` line points at the
   checkout you meant. Run tests as
   `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run`.
   ⚠️ **rtk's filter layer will lie to you**: it prints `ok` for an empty `git status --porcelain`,
   reports a 0-byte `git diff` as 1 byte, truncates long grep output to `[+N more]`, and errors on
   regexes containing parentheses. Byte comparisons go through `rtk proxy git … > file` then `wc -c`.
   Read large files with `sed -n 'a,bp'` or python, not grep.
6. **Local machine and network.** You MAY use the container runtime; ⚠️ measured at dispatch,
   OrbStack's daemon is DOWN (`/Users/biran/.orbstack/run/docker.sock` does not exist). **Linux is
   out of scope**, so you do not need it. Report any such action if you take one.
7. **A bad probe proves nothing.** This package has been burned four times, including once by a
   mutation that proved nothing while looking like a proof.
8. *** **A MUTATION IS NOT A PROOF UNTIL YOU HAVE SEEN IT GO RED** *** — yours included.
   ⚠️ **"Which assertion went red" is not a reliable discriminator** (an earlier assertion
   short-circuits): if you want to know a value, print it.
   ⚠️ *** **And the mutation you did NOT run is not evidence either** *** — that is precisely how
   the `stop()` branch went unpinned through a round with eight mutations. **For each behaviour this
   round claims to pin, name the mutation that attacks THAT behaviour, and run it.**
9. Every finding needs a **constructible scenario**; anchor code references by verbatim block plus a
   hit count, **never by line number**.
10. **A finding and its disposition are two different things.** Report it either way, saying which.
11. ⚠️ **KNOWN FLAKES — FOUR.** Under load these time out at `Test timed out in 5000ms`; they are not
    regressions:
    - `run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
    - `runLoop > persists phase usage evidence from the subprocess adapter without recomputing
      controller totals`
    - `runLoop > accounts an execute timeout that rejects after the abort as exhaustion`
    - `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting
      stale run data`
    A red run whose total duration is **~25–29s** rather than the usual **17–22s** is the load
    signature. Re-run the single file before concluding anything.

---

## Baseline measured on this checkout immediately before dispatch

- *** **`35 files / 614 tests` passed, 0 skipped** ***; `TEST_RC=0`; `typecheck` rc=0; `build` rc=0;
  duration 16.81s (`real 17.24`); vitest's `RUN` line pointed at `/Users/biran/code/skills/loop/ccloop`.
- Working tree clean: `git status --porcelain`, `git diff`, `git diff --cached` all **0 bytes**.
- *** **The criterion baseline is 614.** *** 613, 609, 604, 603, 602, 601, 600 are all dead numbers.
- *** **Redline function `tryRecoverStaleOwnerTransferLock` = 4769 bytes** ***, whole-line range
  **1017–1095 inclusive, including line 1095's trailing newline**, in `src/persistence/fileStore.ts`;
  signature hit count = 1. ⚠️ **Re-locate by signature + brace matching before measuring; line
  numbers move.** ⚠️ **The 3185 and 4496 baselines are VOID.** This round claims not to have touched
  the function at all.
- ⚠️ **darwin only.** The suite is known red on linux (`5 failed / 593 passed`, measured on an
  unrelated round). No cell of this package has run on linux for several rounds.

---

## Out of scope — not yours to re-raise

- **Everything at or below `d4a9bb1`** — that round was independently reviewed and its findings are
  dispositioned above. A NEW consequence of it is in scope; re-litigating it is not.
- **E1's I-2 cell**, **`ccloop ls` reporting locks (ruling 85)**, **linux**, **package 1**.
- *** **Do not declare point B passed, C-1 closed, or E1 anything** *** — rulings 101/102/103 ruled
  all three.
- **Whether to merge or push.** The controller may not push; that is the human's. Say whether it is
  proven, not what to do with it.

---

## Deliverable

Write your report to `.superpowers/sdd/2026-08-07-pkg2-data-loss/i3a-rereview.md` (that directory's
`.gitignore` is `*` — **do not commit it yourself**). Sections:
Strengths / Critical / Important / Minor / Verification performed / Recommendations / Assessment.
Return the same content as your final message.
