# Review brief — the point B cleanup round (A, C, B) plus Mi-2 and T2

Reviewer seat: **fresh and independent**. You are not the controller and not any prior reviewer on
this package; do not inherit anyone's conclusions, including the implementer's. Scoped, not
whole-branch.

⚠️ **These five commits have never been reviewed by anyone.** The previous independent review of
this package was performed BEFORE the first three of them existed — they are its fallout, written
by the same controller whose work it was auditing. Two of them are already on `origin/main`, so for
those this is an after-the-fact review, not a gate. Judge them as unreviewed work.

## Range — exactly five commits

| Commit | Subject | Under review |
|---|---|---|
| `29aa60e` | `test(fileStore): pin the exit human ruling 83 closed and nobody covered` (**A**) | **YES** |
| `83ac585` | `docs(comments): make e22d1ea's own method claim true -- restore what it overwrote` (**C**) | **YES** |
| `5d1349e` | `docs(unlock): correct the six stale comments the first round missed (human ruling 93)` (**B**) | **YES** |
| `862491f` | `docs(comments): record that parsePid's coercion widens the redline's "ONLY condition" (Mi-2, human ruling 94)` | **YES** |
| `3d65e2b` | `docs(comments): mark the near-duplicate malformed-lock test as kept on purpose (T2, human ruling 95)` | **YES** |
| `6a5a37b`, `b38d07f`, `9a62f31` | ledger `§31`／`§32` and the handoff | **NO** — read as context only |

Parent of the first is `f315576`.

```bash
cd /Users/biran/code/skills/loop/ccloop
rtk proxy git show 29aa60e; rtk proxy git show 83ac585; rtk proxy git show 5d1349e
rtk proxy git show 862491f; rtk proxy git show 3d65e2b
rtk proxy git log --oneline f315576..HEAD
```

## ⚠️ THE RED LINE IS A SUBJECT HERE TOO — AND ITS BASELINE MOVED TWICE

`tryRecoverStaleOwnerTransferLock` in `src/persistence/fileStore.ts` was frozen at **970 bytes** for
most of this package's life. *** **Both that freeze and that number are DEAD.** *** Human ruling 83
authorised changing the function (that landed in `9dd044d`, already reviewed, **not** under review
here) and human ruling 94 authorised the comment appended to it by `862491f` (**under review**).
Its size is now **2515 bytes**, signature hit count 1. **If any document, comment or habit tells you
the function is frozen or names 970 or 1558 bytes, that document is out of date — say so, do not
obey it.**

Still out of authorisation, and not to be proposed here (record as an observation, saying so): the
lock ACQUIRE path (`acquireOwnerTransferLock`), `release()`, E1 (`ccloop unlock`), the sweep,
`ccloop ls`, and package 1.

## The binding rulings these five commits claim to encode

Human ruling 83 (verbatim, binding — judge compliance, do not re-litigate):

> Every exit other than liveness reclamation fails CLOSED. **The only condition that may delete an
> existing lock is: the contents parse, `holderProcessInstanceId` has the form `pid:<n>`, and that
> process is no longer alive.** Everything else (parse failure; parse success with a missing or
> non-`pid:<n>` holder) returns `false` and does not delete. Staged artifacts are no longer grounds
> for reclaiming.
> **"No longer alive" = today's TWO-STATE `isProcessActive` (human ruling 86)**, not E1's
> three-state `classifyHolderLiveness`. `pid:0` and overflowing pids are NOT in scope.

- **Ruling 4** permits ADDING tests without a further ruling. **Ruling 88** requires that CHANGING
  an existing criterion be (a) named by the human to a specific test, (b) a whole rewrite with no
  relaxation, (c) accompanied by a statement of which ruling it now encodes.
- **Ruling 93** extended the comment authorisation to `tests/unlock/inspectLock.test.ts` and
  `src/unlock/unlockCommand.ts`.
- **Ruling 94** chose to soften the redline's in-function comment rather than add a
  `typeof === "string"` guard.
- **Ruling 95** declined to delete either near-duplicate malformed-lock test.
- **House rule on comments:** nothing is silently overwritten. Original wording stays verbatim; a
  correction is an appended, named `*** ERRATUM (…, human ruling N) … ***`.

## What the implementer claims — treat each as a claim to check

1. **A** closes the coverage hole the previous review raised as Critical: of the two exits ruling 83
   closed, only "parse failure" had a criterion; "parses but the holder is not `pid:<n>`" had
   **zero** — a one-token revert of the guard left all 600 tests green. A is claimed to be
   **additive only** (ruling 4, no existing criterion touched) and to have been proven red before
   green.
2. **C** makes `e22d1ea`'s own commit message true. That commit claimed "every claim kept verbatim";
   in fact it deleted 14 comment lines, **none surviving verbatim**, 5 of them rewritten in place
   with no ERRATUM. C claims to restore what was overwritten.
3. **B** corrects the **six** stale comments the first comment round missed, including a fourth
   verbatim copy of the "unconditional lock stealer" claim in `tests/unlock/inspectLock.test.ts`.
   Claimed: pure addition, **zero deletions**.
4. **Mi-2** records that `parsePid`'s `exec` coerces through `String()`, so a `JSON.parse` result of
   `["pid:999999"]` reaches the liveness check even though the comment says the holder must "have
   the form `pid:<n>`". Claimed **bounded**: the pid must still be dead, so no live lock is
   reclaimable this way.
5. **T2** records that `leaves the lock on disk when malformed staged state names no dead holder` is
   a near-duplicate of `keeps a malformed lock non-recoverable even when staged artifacts are
   present` — byte-identical fixture (**26 lines**, measured), its sole post-hoc assertion verbatim
   one of the other's four, its only unique content a pre-assertion.
6. Across all five: **comment-and-test only**, no production logic changed; the last two are
   **+21/-0 with zero non-comment lines**.

## Landing points

1. **Is A vacuous?** Prove by mutation that it goes red on its own claim and that the failure names
   the cause. Then prove the stronger thing: revert the guard by that one token in a clone and
   confirm A is what catches it. Does A's name describe what it pins? Does it state which ruling it
   encodes (ruling 88(c))? **Did it change any existing criterion** — if so, ruling 4 did not cover
   it and it needed a naming under ruling 88.
2. **Is C's restoration complete and honest?** `e22d1ea` deleted 14 comment lines. Enumerate all 14
   and check each is now recoverable **verbatim** in the tree. Is any "restored" line subtly
   reworded? Does the restored text plus its ERRATUM read as a coherent whole, or does a reader now
   meet two contradictory sentences with no way to tell which is authoritative?
3. **Did B finish the job, and did it damage anything?** The first comment round changed 12 and
   missed 6. Do a **whole-tree sweep of your own** for statements point B falsified — do not trust
   the count of six. ⚠️ The previous session created two splice defects by anchoring
   `str.replace` mid-sentence (one 153-char line; one sentence flung past its ERRATUM). Check every
   touched comment block for a sentence cut mid-way and check the widest comment line per file.
4. **Is the Mi-2 erratum factually right — in both directions?** Verify the coercion claim by
   measurement, not by reading. Then attack the "bounded" hedge: enumerate what `JSON.parse` can
   return and find any input that reaches `safeUnlink` while the holder is **live or
   unattributable**. If the hedge is wrong, that is Critical, not Minor. Also check the reverse: is
   the erratum now *understating* — could the same coercion matter to `parsePid`'s other two callers
   (`unlock`, `sweep`) in a way this comment implies is harmless?
5. **Is the T2 note right?** Re-measure the byte-identical-fixture claim and the verbatim-assertion
   claim yourself. Is "the only unique content is the pre-assertion" true, or does one test cover
   something the other does not? If the note is wrong, it now licenses a future reader to delete the
   wrong test.
6. **Anything vacuous or newly silent.** Look for a test that still passes but now passes for the
   wrong reason, and for an error path that quietly became a less useful answer — this project's
   signature defect.
7. **Comments as specification.** In this package a wrong comment is a defect, not a nit. Check each
   new or restored sentence against what the code actually does.

## Protocol — binding

1. **Read-only on this checkout.** Never move HEAD, the index, or a branch. Never push, merge,
   commit, or delete a branch or worktree.
2. **Do not accept the implementer's self-report.** Re-measure anything you rely on. Every number in
   this brief is the controller's — including the baseline below and the 26-line fixture match.
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

`34 files / 601 tests` passed, **0 skipped**; `TEST_RC=0`; `typecheck` rc=0; `build` rc=0;
`tryRecoverStaleOwnerTransferLock` = **2515 bytes**, signature hit count 1; working tree clean.
⚠️ **The criterion baseline is 601, not the 600 every earlier document names.**
⚠️ **darwin only.** The suite is known red on linux (`5 failed / 593 passed`, measured by a previous
reviewer on an unrelated round); **none of point B has been run on linux**. Do not repeat that claim
more broadly than it was made.

## Out of scope — recorded elsewhere, not yours to re-raise

I-3 (after failing closed, the operator cannot see a permanently stuck lock — merged into human
ruling 85's separate round), `ccloop ls` reporting locks (ruling 85), package 1, the logged open
items (`pid:0` / overflow-pid false-"alive", N-2, M-1, M-3, `foreign` wording), and `9dd044d`
itself, which a previous round already reviewed. Whether E1 "passes" is unruled; do not declare it.
Do not declare point B passed or C-1 closed — those are the human's to rule.

## Deliverable

Write your report to `.superpowers/sdd/2026-08-07-pkg2-data-loss/pointB-cleanup-review.md` (that
directory's `.gitignore` is `*` — it needs `git add -f`; **do not commit it yourself**). Sections:
Strengths / Critical / Important / Minor / Verification performed / Recommendations / Assessment.
Return the same content as your final message.
