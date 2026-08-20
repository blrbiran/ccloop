# Review brief — E1 fix round 2 (the ONLY unreviewed part of E1)

Reviewer seat: fresh (4th independent reviewer on E1). Scoped, not whole-branch.

## Range

Base `e6898a7` … Head `9868f4c` — exactly two commits:

- `7ff04a8 fix(unlock): stop a failing close from masking a good read, and keep the errno`
- `9868f4c test(unlock): move fs mock cleanup into afterEach so a failure cannot leak it`

Everything after `9868f4c` on `main` is documentation and is NOT under review.

## What E1 is

`ccloop unlock <runDir> [--force --expect <sha256>]` — an operator escape hatch for a stuck
owner-transfer lock. Three files carry it:

- `src/unlock/inspectLock.ts` — classifies a lock, **never deletes**.
- `src/unlock/unlockCommand.ts` — holds the command's **only** `unlink`.
- `src/cli.ts` — wiring. `src/persistence/fileStore.ts` gained three `export`s only (zero behaviour).

Standing rules E1 was built under (do not re-litigate them; judge whether the code obeys them):

- A **live** pid's lock is never deleted, `--force` included. The liveness check runs BEFORE the
  credential check, and that refusal deliberately does NOT print a `--force` hint.
- `--force` credential = **sha256 of the lock file's bytes** (human ruling 73), because the one
  permanently-stuck cell cannot yield a holder id.
- Liveness is three-state by errno (human ruling 74): ESRCH ⇒ dead; EPERM ⇒ alive (someone else's);
  a `pid:0` or an overflowing pid must NOT be reported as alive.
- Deletion must re-check WHICH FILE it is about to delete, by `(dev, ino)`, not by path
  (human ruling 62 — this repository has actually been bitten by the path-only form).

## What round 2 changed, and the landing points to review

**1. `inspectLock.ts` — the descriptor close.** The `await handle.close()` sat in a `finally`
   nested inside the try whose `catch` produces `file-unreadable`; a failing close therefore
   turned a perfectly good read into `file-unreadable`, which is the one state with **no digest**
   and therefore **no `--force` route**. It is now `await handle.close().catch(() => {})`.
   Review: does swallowing it create a NEW silence that matters? Is there any path where the close
   failure is the only signal of a real problem (e.g. a truncated/partial read the code then trusts)?

**2. `unlockCommand.ts` — `removeLockIfUnchanged` return contract.** It used to collapse EACCES /
   EPERM / EIO into the bare word `"unremovable"`; it now returns an object carrying a `reason`
   that is plumbed to the operator-facing output. Review: **every** call site updated? Any place
   that now truthiness-tests an object that used to be a string, or string-compares a value that
   is now an object? Does the reason reach the output on every branch that can produce it, and can
   the reason text leak anything it should not? Does the exit code still mean what it meant?

**3. `unlockCommand.test.ts` — mock cleanup moved into `afterEach`.** The trailing
   `vi.resetModules()` / `doUnmock` never ran when an assertion above it threw, so an `fs` mock
   leaked into later tests and made an innocent test fail. Review: does the `afterEach` actually
   cover **every** `vi.doMock` in the file? Are there other cleanups still written at the end of a
   test body — in these two test files or in `inspectLock.test.ts` — with the same defect?

**4. Do the new tests bite?** The round added 3 tests. Assume nothing: prove by mutation whether
   each new assertion can go red, and whether the failure message names the real cause. An
   assertion with no enforcement behind it is this repository's signature root-cause shape.

## Out of scope — do not touch, do not report as findings

- `tryRecoverStaleOwnerTransferLock` in `fileStore.ts` is a **red line**: it must be byte-identical
  to commit `86d3bd6`'s copy (970 bytes). Please **independently verify** that it still is, and say
  so in your report. Do not propose changes to it. Its divergence from E1's liveness judgement is
  deliberate and documented at the top of `unlockCommand.ts`; it is not a defect.
- C-1's two fail-open exits, open points A and B, package 1's fix round 2, and the known open items
  (`pid:0` / overflow pid false-"alive" inside the red-line function, N-2, M-1, M-3, `foreign`
  wording) are all logged elsewhere and are NOT yours to re-raise.

## Protocol — binding

1. **Read-only on this checkout.** Never move HEAD, the index, or a branch here. Never `push`.
   Never merge, never delete a branch or worktree.
2. **Do not accept the implementer's self-report.** The commit messages, `E1-review-scoped-fix.md`
   and `progress.md` §25.17 all state what was fixed; treat every one of those statements as a
   claim to be checked, not as evidence.
3. **Mechanical argument from reading the code is not a measurement.** Where a claim can be
   measured, measure it.
4. **Mutation is allowed, but only in a `git clone --local` copy**, and you must prove restoration
   afterwards: `rtk proxy git diff` and `rtk proxy git diff --cached` both **0 bytes** (rtk's filter
   layer misreports 0 bytes as 1 — take raw bytes through `rtk proxy`). Never mutate the main
   checkout. Verify a copy actually landed with `diff` — `cp` has an `-i` alias on this machine and
   silently declines to overwrite.
5. **Never filter a verification run.** `grep` / `tail` / `head` / `sed` are equally forbidden on
   test, typecheck and build output — a pipe also steals the exit code (`tsc … | tail -3` then `$?`
   gives you tail's rc). Redirect to a file and read the whole file back. Check vitest's first
   `RUN` line names the directory you meant.
   Run tests as: `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run`.
6. **A bad probe proves nothing** — neither absence nor violation. If you build a live-process
   fixture, spawn it **within the same bash invocation** and re-confirm with `kill -0` **at the
   moment of the assertion**. Do not reuse a pid from an earlier call.
7. Every finding needs a **constructible scenario**: concrete inputs/state → the wrong outcome.
8. **Anchor code references so a same-prefix sibling cannot be confused for the real one** — quote
   enough surrounding text to be unambiguous, and give file:line.
9. **A finding and what to do about it are two different things.** Report the finding even when you
   think it should be deferred, and say which is which.
10. Known allowed flakes, matched by **full test name**, do not investigate:
    `evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
    (5000ms timeout under parallel load), and `persists phase usage evidence…` (logged under human
    ruling 10).

## Baseline measured on this checkout immediately before dispatch

`34 files / 593 tests` passed, 0 skipped; `typecheck` rc=0; `build` rc=0;
`tryRecoverStaleOwnerTransferLock` byte-identical to `86d3bd6` (970 bytes, `diff` rc=0).

## Deliverable

Write your report to
`.superpowers/sdd/2026-08-07-pkg2-data-loss/E1-review-fix2.md`
(that directory's `.gitignore` is `*`, so the file must be added with `git add -f` — **do not commit
it yourself**, just write it and say so). Use: Strengths / Critical / Important / Minor /
Recommendations / Assessment. Then return the same content as your final message.
