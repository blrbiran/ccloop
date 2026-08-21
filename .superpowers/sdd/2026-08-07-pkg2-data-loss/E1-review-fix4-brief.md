# Review brief — E1 fix round 4 (the ONLY unreviewed part of E1)

Reviewer seat: fresh (6th independent reviewer on E1, first to see this commit). Scoped, not
whole-branch. You are none of the five who came before; do not inherit their conclusions.

## Range

Exactly one commit: `92018a8` — `fix(unlock): make the two catches agree structurally, and pin the
errno per platform`. Its parent is `4da041e`. Two files: `src/unlock/unlockCommand.ts`,
`tests/unlock/unlockCommand.test.ts`. Everything after it is documentation and is NOT under review.

```bash
cd /Users/biran/code/skills/loop/ccloop
rtk proxy git show 92018a8
```

## What E1 is

`ccloop unlock <runDir> [--force --expect <sha256>]` — an operator escape hatch for a stuck
owner-transfer lock. `inspectLock.ts` classifies and never deletes; `unlockCommand.ts` holds the
command's only `unlink`. Standing rules (judge compliance, do not re-litigate): a live pid's lock is
never deleted, `--force` included, and the liveness check precedes the credential check; the
`--force` credential is the sha256 of the lock file's bytes (ruling 73); liveness is three-state by
errno (ruling 74); deletion re-checks WHICH FILE by `(dev, ino)` (ruling 62).

## What this commit claims

The 5th reviewer returned 0 Critical, 0 Important, 4 Minor on the previous round; this commit lands
all four, plus the two probe scripts that reviewer ran by hand become pinned tests.

1. The `stat` catch read `.code` off the caught value unguarded, so a rejection of `null` threw a
   TypeError out of a delete path. Now optional-chained.
2. Both catches take their reason through one new `reasonFrom(error)` helper, so the agreement is
   structural rather than two hand-copies. The helper also wraps `String(error)` in try/catch,
   because `String()` throws on an object with a null prototype.
3. The directory-unlink assertion is now per platform (`/EISDIR/` on linux, `/EPERM/` elsewhere)
   rather than the union of both.
4. A comment paragraph about how the reason is taken no longer sits above the ENOENT branch.

Treat every one of those as a claim to check. The same for the commit message's measurements and
ledger §25.21.

## Landing points

1. **`reasonFrom` (`unlockCommand.ts`).** Does it actually remove the divergence, or does it only
   move it? *** Is the fallback itself total? *** `Object.prototype.toString.call(error)` consults
   `Symbol.toStringTag` — consider a Proxy or a getter that throws. If the fallback can throw, the
   commit's central claim ("even that case stays a value") is false. Measure it.
2. **The optional chaining.** Is the `NodeJS.ErrnoException | null` cast honest for every value that
   can arrive? What about a value whose `code` is an accessor that throws? Is the ENOENT ⇒ `gone`
   classification byte-for-byte unchanged for real `node:fs` errors?
3. **The per-platform assertion.** `process.platform === "linux" ? /EISDIR/ : /EPERM/`. On any
   platform that is neither, the else branch asserts EPERM — is that right, or does it turn the
   round's only real-filesystem errno assertion vacuous somewhere? Is `process.platform` even the
   right discriminator?
4. **The three new tests.** `expect.stringMatching(/\S/)` is a weak matcher — is it too weak to be
   worth having, or is the real claim "the call resolves at all"? Do the tests pin what they say?
   Can their mocks leak? Does `throw null` inside an async mock reach the code under test the way
   the test assumes? Prove by mutation whether each can go red and whether the message names the
   cause.
5. **Comment claims vs code.** This file's comments carry design rulings; the round added several.
   Check each new sentence against what the code actually does — a comment asserting a property the
   code lacks is the exact defect the previous round was fixing.
6. **Anything new and silent.** An error path that quietly becomes a different, less useful answer is
   this project's signature defect. Look for one introduced here.

## Out of scope

- `tryRecoverStaleOwnerTransferLock` in `fileStore.ts` is a **red line**: byte-identical to
  `86d3bd6`'s copy (970 bytes). **Independently verify** it still is and say so; propose nothing for
  it.
- C-1's fail-open exits, points A and B, package 1's fix round 2, and the logged open items
  (`pid:0` / overflow-pid false-"alive" in the red-line function, N-2, M-1, M-3, `foreign` wording)
  are recorded elsewhere and are not yours to re-raise.

## Protocol — binding

1. **Read-only on this checkout.** Never move HEAD, the index, or a branch here. Never push, merge,
   or delete a branch or worktree.
2. **Do not accept the implementer's self-report**, nor the previous reviewers'.
3. **Reading the code is not measuring it.** Label each finding as measured or read-only argument.
4. **Mutation only in a `git clone --local` copy.** *** Restoration is proven by the BYTE COUNTS of
   both `rtk proxy git diff` and `rtk proxy git diff --cached` on the copy — `diff -r` is NOT a
   restoration proof, it cannot see the index *** (`git checkout <sha> -- <path>` also writes the
   index). Verify any file copy landed with `diff`; `cp` has an `-i` alias here and can silently
   decline to overwrite.
5. **Never filter a verification run** (`grep`/`tail`/`head`/`sed` alike; a pipe also steals the exit
   code). Redirect to a file, read the whole file back, check vitest's first `RUN` line. Run tests as
   `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run`.
6. *** **NEW CLAUSE — local machine and network.** *** The previous round's brief was silent on this
   and the reviewer had to improvise; it is now stated. You **MAY** use the machine's container
   runtime (OrbStack; start it if the daemon is down) and pull public images to take a measurement —
   the linux/darwin errno question was settled that way. You **MUST** report every such action in
   your report. You **MUST NOT** install anything into this repository, modify the machine's
   configuration, or touch anything belonging to another running line of work. If a measurement
   needs something beyond that, say what you would have measured and stop.
7. **A bad probe proves nothing** — not absence, not violation. Last round a `timeout 15 docker info`
   returned 127 and was read as "no container runtime"; macOS has no `timeout`, so 127 was the shell
   reporting a missing binary. Check your probes before believing them.
8. Every finding needs a **constructible scenario**, and code references must be **anchored** against
   same-prefix siblings.
9. **A finding and its disposition are two different things.** Report it either way, saying which.
10. Known allowed flakes, by **full test name**, not to be investigated:
    `evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`,
    and `persists phase usage evidence…` (ruling 10).

## Baseline measured on this checkout immediately before dispatch

`34 files / 598 tests` passed, 0 skipped; `typecheck` rc=0; `build` rc=0; red line byte-identical to
`86d3bd6` (970 bytes, `diff` rc=0). Separately: `tests/unlock` was run in `node:22-alpine` against a
fresh `npm ci` — 43 passed (43). **The full 598 has NOT been run on linux**; do not repeat that claim
more broadly than it was made.

## Deliverable

Write your report to `.superpowers/sdd/2026-08-07-pkg2-data-loss/E1-review-fix4.md` (that directory's
`.gitignore` is `*` — it needs `git add -f`; **do not commit it yourself**). Sections: Strengths /
Critical / Important / Minor / Verification performed / Recommendations / Assessment. Return the same
content as your final message.
