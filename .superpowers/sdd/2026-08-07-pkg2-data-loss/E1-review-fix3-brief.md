# Review brief — E1 fix round 3 (the ONLY unreviewed part of E1)

Reviewer seat: fresh (5th independent reviewer on E1, first to see this round). Scoped, not
whole-branch. You are not any of the four who came before; do not assume their conclusions.

## Range

Exactly one commit: `3cea111` — `fix(unlock): stop one function disagreeing with itself, and make
the assertions bite`. Its parent is `57f3ce9`.

```bash
cd /Users/biran/code/skills/loop/ccloop
rtk proxy git show --stat 3cea111
rtk proxy git show 3cea111
```

Three files: `src/unlock/unlockCommand.ts`, `tests/unlock/unlockCommand.test.ts`,
`tests/unlock/inspectLock.test.ts`. Everything committed after `3cea111` is documentation and is
NOT under review.

## What E1 is

`ccloop unlock <runDir> [--force --expect <sha256>]` — an operator escape hatch for a stuck
owner-transfer lock. `src/unlock/inspectLock.ts` classifies and **never deletes**;
`src/unlock/unlockCommand.ts` holds the command's **only** `unlink`; `src/cli.ts` wires it up.

Standing rules (judge whether the code obeys them; do not re-litigate them):

- A **live** pid's lock is never deleted, `--force` included; the liveness check runs BEFORE the
  credential check, and that refusal deliberately prints no `--force` hint.
- `--force` credential = **sha256 of the lock file's bytes** (human ruling 73).
- Liveness is three-state by errno (human ruling 74): ESRCH ⇒ dead, EPERM ⇒ alive, and `pid:0` or an
  overflowing pid must not be reported as alive.
- Deletion re-checks WHICH FILE by `(dev, ino)`, not by path (human ruling 62 — this repository has
  been bitten by the path-only form).

## Where this round came from

The 4th reviewer looked at fix round 2 and returned 0 Critical, 1 Important, 6 Minor
(`E1-review-fix2.md`). This commit acts on all seven. **Your job is not to re-derive those findings
— it is to judge whether each fix actually does what it claims, and whether the round introduced
anything new.** Treat `E1-review-fix2.md`, this commit's message, and ledger §25.20 as claims to be
checked, never as evidence.

## Landing points

1. **The one production change (`unlockCommand.ts`, the `stat` catch).** A ternary became an early
   return plus `error instanceof Error ? error.message : String(error)`. Is the ENOENT ⇒ `gone`
   behaviour byte-for-byte what it was? Can `String(error)` produce something an operator should not
   see, or something unbounded? Does the `errno` cast still earn its place now that the message is
   taken from `error` rather than from `errno`?
2. **The comment block that was MOVED** (the errno paragraph now documents `export type
   LockRemoval`; the deletion-rationale block now sits on `removeLockIfUnchanged`). It was moved
   programmatically. Verify **no text was dropped, duplicated or reflowed** — compare against
   `57f3ce9`'s copy — and that each block now sits on what it actually describes.
3. **`toMatchObject` replacing two casts.** `toMatchObject` is a PARTIAL match. Did any assertion get
   weaker than the `expect(result.outcome).toBe(...)` + reason pair it replaced? Would a wrong
   `outcome` still fail?
4. **`toMatch(/EPERM|EISDIR/)`.** Is the union honest, or does it let a wrong errno through? The
   commit states the Linux half was NOT measured (no Linux runner here). If you can measure it,
   measure it and say so; if you cannot, say that too rather than reasoning it into a fact.
5. **The two new tests** (`keeps a non-Error rejection readable…`, `puts the unlink's own errno in
   front of the operator too…`). Do they pin what they claim? The second mocks `unlink` — confirm it
   actually reaches the unlink catch rather than passing for some other reason, and that its mock
   cannot leak (this file's `afterEach` discipline exists because a leak once made an innocent test
   fail). Prove by mutation whether each new assertion can go red and whether the failure message
   names the true cause.
6. **The added anti-vacuity guard and the added existence assertion.** Are they the right guards, and
   are they placed where they bite?
7. **Anything new and silent.** This project's signature failure shape is an error path that quietly
   becomes a different, less useful answer. Hunt for one introduced here.

## Out of scope — do not touch, do not report as findings

- `tryRecoverStaleOwnerTransferLock` in `fileStore.ts` is a **red line**: it must stay byte-identical
  to `86d3bd6`'s copy (970 bytes). Please **independently verify** that it still is and say so. Its
  divergence from E1's liveness judgement is deliberate and documented; it is not a defect.
- C-1's two fail-open exits, open points A and B, package 1's fix round 2, and the logged open items
  (`pid:0` / overflow-pid false-"alive" inside the red-line function, N-2, M-1, M-3, `foreign`
  wording) are recorded elsewhere and are not yours to re-raise.

## Protocol — binding

1. **Read-only on this checkout.** Never move HEAD, the index, or a branch here. Never `push`, merge,
   or delete a branch or worktree.
2. **Do not accept the implementer's self-report**, and do not accept the previous reviewer's either.
3. **Mechanical argument from reading is not a measurement.** Where a claim can be measured, measure
   it, and label which of your findings are measured and which are read-only arguments.
4. **Mutation only in a `git clone --local` copy**, never in this checkout. *** Restoration is proven
   by the BYTE COUNTS of both `rtk proxy git diff` and `rtk proxy git diff --cached` on the copy —
   `diff -r` is NOT a restoration proof, because it cannot see the index. *** (Last round's copy came
   back with 24652 bytes staged while `diff -r` reported it clean; note that `git checkout <sha> --
   <path>` also writes to the index.) Verify any file copy landed with `diff` — `cp` has an `-i`
   alias on this machine and can silently decline to overwrite.
5. **Never filter a verification run.** `grep` / `tail` / `head` / `sed` are equally forbidden on
   test, typecheck and build output, and a pipe also steals the exit code. Redirect to a file and
   read the whole file back; check vitest's first `RUN` line names the directory you meant. Run tests
   as `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run`.
6. **A bad probe proves nothing.** A live-process fixture must be spawned within the same bash
   invocation and re-confirmed with `kill -0` at the moment of the assertion.
7. Every finding needs a **constructible scenario**: concrete inputs/state → the wrong outcome.
8. **Anchor code references** so a same-prefix sibling cannot be mistaken for the real one.
9. **A finding and its disposition are two different things.** Report it either way, and say which.
10. Known allowed flakes, matched by **full test name**, do not investigate:
    `evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`,
    and `persists phase usage evidence…` (human ruling 10).

## Baseline measured on this checkout immediately before dispatch

`34 files / 595 tests` passed, 0 skipped; `typecheck` rc=0; `build` rc=0;
`tryRecoverStaleOwnerTransferLock` byte-identical to `86d3bd6` (970 bytes, `diff` rc=0).

## Deliverable

Write your report to `.superpowers/sdd/2026-08-07-pkg2-data-loss/E1-review-fix3.md` (that directory's
`.gitignore` is `*`, so it needs `git add -f` — **do not commit it yourself**, just write it and say
so). Sections: Strengths / Critical / Important / Minor / Verification performed / Recommendations /
Assessment. Return the same content as your final message.
