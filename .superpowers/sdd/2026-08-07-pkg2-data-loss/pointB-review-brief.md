# Review brief — point B (the redline change) and its comment round

Reviewer seat: **fresh and independent**. You are not the controller and not any prior reviewer on
this package; do not inherit anyone's conclusions, including the implementer's. Scoped, not
whole-branch.

## Range — exactly two commits

| Commit | Subject | Under review |
|---|---|---|
| `9dd044d` | `fix(owner-transfer): make stale-lock recovery fail closed (point B, human ruling 83)` | **YES** |
| `e22d1ea` | `docs(unlock): correct the twelve comments point B turned false (human ruling 91)` | **YES** |
| `61f3f50`, `926d6dd` | ledger `§29`／`§30` under `.superpowers/sdd/` | **NO** — documentation, read them as context only |

Parent of the first is `1bd6f06`.

```bash
cd /Users/biran/code/skills/loop/ccloop
rtk proxy git show 9dd044d
rtk proxy git show e22d1ea
rtk proxy git log --oneline 1bd6f06..HEAD
```

## ⚠️ THE RED LINE IS THE SUBJECT THIS TIME — READ THIS TWICE

Every earlier brief in this package told you `tryRecoverStaleOwnerTransferLock` in
`src/persistence/fileStore.ts` is a **red line**, byte-identical to `86d3bd6`'s copy at **970
bytes**, and asked you to verify that and propose nothing for it. *** **That instruction is DEAD.**
*** Human ruling 83 authorised changing that function, and `9dd044d` changed it. Its new size is
**1558 bytes**. If you find a document, comment or habit telling you the function is frozen, that
document is out of date — say so, do not obey it.

What IS still out of authorisation, and must not be proposed here (record it as an observation
instead, saying so): the lock ACQUIRE path (`acquireOwnerTransferLock`), `release()`, E1
(`ccloop unlock`), the sweep, `ccloop ls`, and package 1.

## What point B is

`tryRecoverStaleOwnerTransferLock` decides whether an existing `.owner-transfer.lock` may be
deleted so an owner transfer can proceed. Human ruling 83, verbatim and binding — judge compliance
with it, do not re-litigate it:

> Every exit other than liveness reclamation fails CLOSED. **The only condition that may delete an
> existing lock is: the contents parse, `holderProcessInstanceId` has the form `pid:<n>`, and that
> process is no longer alive.** Everything else (parse failure; parse success with a missing or
> non-`pid:<n>` holder) returns `false` and does not delete. Staged artifacts are no longer grounds
> for reclaiming.
> **"No longer alive" = today's TWO-STATE `isProcessActive` (human ruling 86)**, not E1's
> three-state `classifyHolderLiveness`. So `pid:0` and overflowing pids are NOT in scope — they were
> permanently REFUSED before this change and still are; point B is not their fix.

Human ruling 87 named exactly two assertions in `tests/persistence/fileStore.test.ts` for a **whole
rewrite, no relaxation**, and human ruling 88 requires each rewritten test to state which ruling it
now encodes. The old names were `treats malformed lock contents with staged artifacts as stale and
recoverable` and `releases the lock after recovering malformed staged state`.

## What the implementer claims — treat each as a claim to check

1. The change is exactly `BUILD_B'` from `pointB-ruling-package-v2.md` §3, which predicted both
   failure-open exits closed and `pid:0`/overflow pid unchanged.
2. Judgement cost is **zero beyond the two named tests**: 600 tests before, 600 after, zero skipped.
3. Both rewritten tests are **not vacuous**: measured in a `git clone --local` whose production code
   was pristine (redline still 970 bytes, `diff` rc=0 vs `86d3bd6`), both went red on their own new
   claims (`expected 2 to be 1`; lock `ENOENT instead of resolving`), while the sibling
   `keeps a malformed lock without staged artifacts non-recoverable` stayed green on both sides.
4. The rewrites **tighten** rather than widen: lock contents now asserted byte-for-byte
   (`toBe("not-json\n")` rather than `toContain`), plus a new assertion that the staged transfer was
   never finalized.
5. The comment round is **comment-only**: 94 changed lines across 6 files, no line of it non-`//`.
6. Nothing was silently overwritten: statements true under ruling 50 are kept verbatim with a named
   `ERRATUM` appended.

## Landing points

1. **Is the new guard actually total?** `if (pid === null || isProcessActive(pid)) return false;`
   followed by `catch { return false; }`. Enumerate every value `lockContents` can hold and every
   way `JSON.parse` / `parsePid` / `isProcessActive` can behave, and find an input that still
   reaches `safeUnlink` with a live or unattributable holder. `JSON.parse` accepts more than
   objects — what does `"null"`, `"0"`, `"[]"`, `'"pid:1"'` do here? Does the cast to
   `Partial<OwnerTransferLockRecord>` lie for any of them? Can `parsed.holderProcessInstanceId` be a
   non-string that survives the truthiness test?
2. **Can `isProcessActive` throw?** If it can, the `catch` now swallows it into `return false`
   rather than the old staged-artifact branch. Is that a behaviour change nobody named? Is failing
   closed the right answer there, and is it *silent*?
3. **The removed `pathExists` calls.** They were the only reads of `ownerPendingPath`,
   `transferPendingPath`, `transactionMarkerPath` in this function. Confirm nothing else depended on
   those reads happening (an fs side effect, an ordering, a test hook that patched them). Confirm
   `pathExists` and those three path fields are still used elsewhere and did not become dead.
4. **Deadlock risk — the cost of failing closed.** Construct the scenario where a run is now
   permanently stuck that previously recovered on its own. Is the operator told? Trace what a user
   sees: `ccloop resume`, `ccloop sweep`, `ccloop ls`. The implementer relies on
   `ccloop unlock --force --expect` as the escape hatch — **verify it actually opens THIS lock**,
   end to end, not by reading the constant. Nobody in this package has run it against a real bad
   lock; if you do, you are the first, and say so.
5. **The two rewritten tests.** Do they pin what their new names say? Prove by mutation that each
   can go red and that the message names the cause. Is the "staged transfer never finalized"
   assertion measuring what it claims, or is that file absent for an unrelated reason? Are the two
   now so alike that one is redundant — and is the pre-existing sibling
   `keeps a malformed lock without staged artifacts non-recoverable` now a duplicate of the first?
6. **Was anything else silently retired?** The old behaviour had assertions elsewhere in the suite.
   The implementer says only two tests moved. Look for a test that still passes but now passes
   *vacuously* because the branch it was aimed at no longer exists.
7. **The comment round, `e22d1ea`.** This file's comments carry design rulings, so a wrong comment
   is a defect. Check each new `ERRATUM` sentence against what the code actually does. Three claim
   a direction reversed (`parsePid`'s comment, its enforcing test, and `inspectLock.ts`'s "why the
   two answers disagree") — **verify the reversal claim itself is right**, in both directions, by
   measurement rather than reading. The `inspectLock.ts` erratum explicitly says it does NOT claim
   the two answers agree everywhere; check that hedge is honest and that the paragraph it corrects
   has no remaining false sentence.
8. **Anything new and silent.** An error path that quietly becomes a different, less useful answer
   is this project's signature defect. Look for one introduced here.

## Protocol — binding

1. **Read-only on this checkout.** Never move HEAD, the index, or a branch. Never push, merge,
   commit, or delete a branch or worktree.
2. **Do not accept the implementer's self-report.** Re-measure anything you rely on.
3. **Reading the code is not measuring it.** Label each finding as measured or read-only argument.
4. **Mutation only in a `git clone --local` copy.** *** Restoration is proven by the BYTE COUNTS of
   both `rtk proxy git diff` and `rtk proxy git diff --cached` on the copy — `diff -r` is NOT a
   restoration proof, it cannot see the index. *** Verify any file copy landed with `diff`.
   ⚠️ This machine aliases both `cp` and `rm` to their `-i` forms: `cp` can silently decline to
   overwrite, and a plain `rm -rf` will HANG on a confirmation prompt until it times out. Use
   `cat pristine > target` and `/bin/rm -rf`.
5. **Never filter a verification run** (`grep`/`tail`/`head`/`sed` alike; a pipe also steals the exit
   code). Redirect to a file, read the whole file back, check vitest's first `RUN` line points at
   the checkout you meant. Run tests as
   `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run`.
   ⚠️ **rtk's filter layer will lie to you**: it prints `ok` for an empty `git status --porcelain`,
   and reports a 0-byte `git diff` as 1 byte. Any restoration proof or byte comparison must go
   through `rtk proxy git …` redirected to a file, then `wc -c`.
6. **Local machine and network.** You **MAY** use this machine's container runtime (OrbStack; start
   it if the daemon is down) and pull public images to take a measurement. You **MUST** report every
   such action. You **MUST NOT** install anything into this repository, modify the machine's
   configuration, or touch anything belonging to another running line of work. If a measurement
   needs more than that, say what you would have measured and stop.
7. **A bad probe proves nothing** — not absence, not violation. A previous round read a `timeout 15
   docker info` returning 127 as "no container runtime"; macOS has no `timeout`, so 127 was the
   shell reporting a missing binary. Check your probes before believing them.
8. Every finding needs a **constructible scenario**, and code references must be **anchored** by
   verbatim block plus a hit count, never by line number — line numbers in this package rot fast.
9. **A finding and its disposition are two different things.** Report it either way, saying which.
10. Known allowed flakes, by **full test name**, not to be investigated:
    `evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`,
    and `persists phase usage evidence…` (ruling 10).

## Baseline measured on this checkout immediately before dispatch

`34 files / 600 tests` passed, **0 skipped**; `TEST_RC=0`; `typecheck` rc=0; `build` rc=0;
`tryRecoverStaleOwnerTransferLock` = **1558 bytes**, signature hit count 1.
⚠️ **darwin only.** The suite is known red on linux (`5 failed / 593 passed`, measured by a previous
reviewer on an unrelated round); **point B has not been run on linux at all**. Do not repeat that
claim more broadly than it was made.

## Out of scope — recorded elsewhere, not yours to re-raise

Points A and C, `ccloop ls` reporting locks (human ruling 85, a separate round), package 1, and the
logged open items (`pid:0` / overflow-pid false-"alive", N-2, M-1, M-3, `foreign` wording).
Whether E1 "passes" is unruled; do not declare it.

## Deliverable

Write your report to `.superpowers/sdd/2026-08-07-pkg2-data-loss/pointB-review.md` (that directory's
`.gitignore` is `*` — it needs `git add -f`; **do not commit it yourself**). Sections: Strengths /
Critical / Important / Minor / Verification performed / Recommendations / Assessment. Return the
same content as your final message.
