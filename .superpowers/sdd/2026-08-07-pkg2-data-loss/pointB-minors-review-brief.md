# Review brief — the eight-Minor round (human ruling 104) and the M-1 disposition reversal

Reviewer seat: **fresh and independent**. You are not the controller and not any prior reviewer on
this package; do not inherit anyone's conclusions, including the implementer's. Scoped, not
whole-branch.

⚠️ **These three commits have never been reviewed by anyone.** They were written by the same
controller whose earlier work the previous independent review audited, and they are that review's
fallout. **None of them is on `origin/main`** — the remote tip is still `83ac585`, so this is a
pre-push review, not an after-the-fact one.

⚠️ **A human asked for this review by name.** Human ruling 100 had closed the "dispatch a review for
each fix round" recursion; that closure is not being reopened by the controller — the human ordered
this round directly. Judge the work, not the decision to review it.

## Range — exactly three commits under review

| Commit | Subject | Under review |
|---|---|---|
| `62a4d49` | `docs(comments): correct the two fileStore.ts claims measurement and ruling 102 overtook (M-2, M-4, human ruling 104)` | **YES** |
| `d905592` | `test(fileStore): give test A the positive observation it lacked, and close three comment Minors (M-4, M-5, M-6, M-7, human ruling 104)` | **YES** |
| `f6fbf01` | `docs(comments): put M-1's correction where a misled reader lands, not only in the ledger (human ruling 104)` | **YES** |
| `0801920`, `713a87e` | ledger `§36`／`§37` | **NO** — read as context; they state the reasoning you are checking |
| `809bb50`, `979f5f0` | the handoff | **NO** — context only |

Parent of the first is `06c6e31`.

```bash
cd /Users/biran/code/skills/loop/ccloop
rtk proxy git show 62a4d49; rtk proxy git show d905592; rtk proxy git show f6fbf01
rtk proxy git log --oneline 06c6e31..HEAD
sed -n '/^36\. /,$p' .superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md   # §36 and §37
```

⚠️ **rtk truncates and mangles some greps** (it prints `[+N more]`, and a regex with parentheses can
error out). For any file read you rely on, use `sed -n 'a,bp'` or `cat`, never a filtered grep.

## ⚠️ THE RED LINE — NOT TOUCHED THIS ROUND, AND ITS BASELINE IS 3185

`tryRecoverStaleOwnerTransferLock` in `src/persistence/fileStore.ts` is **3185 bytes**, signature
hit count **1**, return type `Promise<boolean>`. *** **970, 1558 and 2515 are all DEAD numbers.** ***
Human ruling 83 authorised changing the function; rulings 94/97 authorised comments inside it. **This
round changed it by zero bytes** — verify that rather than believing it. **If any document, comment
or habit tells you the function is frozen or names 970/1558/2515, that document is out of date; say
so, do not obey it.**

Still out of authorisation, and not to be proposed here (record as an observation, saying so): the
lock ACQUIRE path (`acquireOwnerTransferLock`), `release()`, E1 (`ccloop unlock`), the sweep,
`ccloop ls`, and package 1.

## The binding rulings this round claims to encode

- **Human ruling 101** — point B PASSES. **Ruling 102** — C-1 is recorded CLOSED. **Ruling 103** —
  E1 is still unruled. **Ruling 104** — "fix the eight Minors, then record and stop." All four were
  made by the human in this session; the controller announced none of them.
- **Ruling 4** permits ADDING tests without a further ruling. **Ruling 88** requires that CHANGING an
  existing criterion be (a) named by the human to a specific test, (b) a whole rewrite with no
  relaxation, (c) accompanied by a statement of which ruling it now encodes.
- **House rule on comments (rulings 98 and 100 drew the line):** text already in remote history, or
  written in a previous session, is kept **verbatim** and corrected only by an appended, named
  `*** ERRATUM (…, HUMAN RULING N) … ***`. Only a typo written in the *current* session that was
  *never* true may be fixed in place.
- **Ruling 83 (verbatim, binding — judge compliance, do not re-litigate):**
  > Every exit other than liveness reclamation fails CLOSED. **The only condition that may delete an
  > existing lock is: the contents parse, `holderProcessInstanceId` has the form `pid:<n>`, and that
  > process is no longer alive.** … **"No longer alive" = today's TWO-STATE `isProcessActive`
  > (ruling 86)**.

## What the implementer claims — treat each as a claim to check

The round's subject is the **nine Minors** of `…/pointB-cleanup-review.md` (M-3 was already closed by
ruling 100). Read that report first; it is the source of M-1 … M-9.

1. **M-2** — in `src/persistence/fileStore.ts`, `// A separate liveness implementation inside the
   unlock command would be free to / drift into that same failure` sits **after** an ERRATUM that a
   previous reflow flung it behind, so the nearest antecedent of "that same failure" is the erratum's
   unconditional lock **REFUSER**, while the sentence was written about the paragraph's unconditional
   lock **STEALER**. Claimed fix: an appended erratum naming the antecedent; the text is **not moved
   back**. Claimed further: under ruling 83 a second liveness implementation could drift into
   **either** direction, so the stranded sentence is **true where it sits**.
2. **M-4, two sites.** The review named only `tests/persistence/fileStore.test.ts`, where
   `open(lockPath, "wx")` is stated in the **present tense** twenty lines below a note saying that
   with the atomic publish nothing ever calls `open` on the lock path. The controller claims its own
   mandatory full-tree scan found the **same present-tense claim inside `fileStore.ts`'s ERRATUM 1**,
   and that fixing one without the other would be the half-fix this package has paid for twice.
   Claimed measurement: the only `await open` in `fileStore.ts` is `open(stagingPath, "w")`, and
   publication is `link(staging, lockPath)`.
3. **M-5, a new test** — `observes that the redline function actually ran on the strong-holder
   fixture`. Claimed a **PURE ADDITION** under ruling 4: no assertion rewritten, no test renamed, so
   no naming under ruling 88 was needed. Claimed gap: all three post-hoc assertions of the
   neighbouring test (`keeps a lock non-recoverable when its live holder is in the strong instance-id
   form`) are **equally true if `tryRecoverStaleOwnerTransferLock` was never entered at all**.
   Claimed mutation evidence, both directions:
   - EEXIST branch changed to `if (!(await Promise.resolve(false)))` so the redline function is never
     called ⇒ **the old test stays GREEN**, the new one fails with `expected 0 to be greater than 0`.
   - Guard reverted to `pid !== null && isProcessActive(pid)` ⇒ **both red**; the old one on
     `promise rejected "ENOENT …" instead of resolving`, the new one on `expected 2 to be 1`.
   Claimed observation point: `fileStore.ts` performs **exactly one** `readFile` of the lock path,
   the first statement of the redline function, so one such read during `readOwnerRecord` **is** one
   entry into it. Asserted as "at least one" **on purpose**, so the retry bound stays free to change.
4. **M-6** — ruling 95's keep-on-purpose note lived only on the **poorer** of two near-duplicate
   malformed-lock tests; the **richer** one (claimed: three assertions the other lacks) had nothing.
   Claimed fix: a back-reference on the richer one, pointing at ruling 88.
5. **M-7** — claimed: **five** freeze sites in this tree say the ruling 50 freeze was lifted for
   point B alone, and `tests/persistence/fileStore.test.ts` was the **sixth**, whose erratum said only
   that the direction reversed. Claimed fix: the sentence, worded to match the other five.
6. **R-1, not a review finding** — `fileStore.ts`'s ERRATUM 2 said *"(a) C-1 is not recorded as
   closed: this change has not had an independent review."* Ruling 102 closed C-1, so the controller
   claims that sentence became false the moment the human ruled, and that recording the closure in
   the ledger while a production comment denied it would reproduce this package's signature defect.
7. **M-1, and a reversed disposition.** `83ac585`'s message says a splice left a **153-character
   line** in `tests/sweep/sweepRuns.test.ts` reading `...not on that freeze. *** The probe is an
   INJECTED dependency...`. Claimed measurement on that commit's **own parent**: that line was **125
   characters** and contained **no `***`**; the 152-character line (153 with newline) was in
   `src/persistence/fileStore.ts`. Claimed conclusion: **all three figures in the dispute are
   individually correct** — the reviewer's 125 (that comment line), the controller's 137 (widest line
   in that whole file, a line of **code**), and the message's 153 (fileStore.ts) — and what was wrong
   was only the **file** the number was attached to, plus a `***` present in neither.
   §36 first disposed of M-1 as **"ledger only"** because the commit is the remote tip; §37 **reverses
   that**, on the grounds that the very commit in question argued *"A commit message travels with
   `git log`; a note in the ledger does not."* The erratum was placed in **one** file only —
   `sweepRuns.test.ts` — with the stated reason that `fileStore.ts` contains no false statement about
   this, so the "do not half-fix" rule (which is about one claim in two places) does not apply.
8. **M-8 and M-9** changed no code; the review itself said each needs none. **M-3** was closed by
   ruling 100 before this round.
9. Across all three commits: **comment-and-test only**, **zero deletions**, no production logic
   changed, the red line untouched.

## Landing points

1. **Is the new test vacuous, and is its evidence real?** Re-run **both** mutations yourself in a
   clone. The one that matters is the second: make the redline function unreachable and confirm for
   yourself that the OLD test stays green — if it does not, M-5 was not a real gap and the new test
   is buying nothing. Then attack the observation: is `readFile` of the lock path really performed in
   **exactly one place** in `fileStore.ts`? Could the count be incremented by something other than an
   entry into the redline function (a retry, a different reader, the test's own fixture)? Is
   `toBeGreaterThan(0)` the right strength, or does it pass in a world nobody wants?
2. **Mock hygiene, and flake risk.** The new test uses `vi.resetModules()` + `vi.doMock` +
   dynamic import inside the test body, and unmocks in a `finally`. This file already contains other
   dynamic-import tests and a `withLockAttemptCounter` helper doing the same thing. **Can the new
   test leak state into, or take state from, its neighbours** — including under vitest's default
   parallelism? Does it add measurable wall-clock or a new timeout surface? This suite is known to
   flake under load (see the flake list below).
3. **Did anything change an existing criterion?** Ruling 4 covers ADDING. Check the diff for any
   assertion, test name, or `describe` string that was edited rather than added — that would have
   needed a naming under ruling 88 and there was none.
4. **Do the errata say true things?** Each new sentence is a specification claim in this package.
   Check M-2's "could drift into either" against ruling 83's actual behaviour; check M-4's "only
   `await open` is the staging one" by measurement; check M-6's "three assertions the other lacks" by
   counting; check M-7's "five other freeze sites, all carrying the sentence" by a whole-tree sweep
   of your own — **do not trust the number five**.
5. **Was the sweep complete?** This round's own thesis is that the previous ones half-fixed. Do a
   **whole-tree sweep of your own** for (a) any remaining present-tense `open(lockPath, "wx")`, (b)
   any remaining sentence that says C-1 is open or point B unreviewed, (c) any other freeze site, (d)
   any other stranded-antecedent splice. **A site this round missed is the finding most worth having.**
6. **Is M-1's reversal sound, and is one site enough?** Re-measure the 125 / 152 / 137 / 153 figures
   yourself on the right trees. Then judge the placement argument: is `sweepRuns.test.ts` really the
   only place a misled reader lands, or does `fileStore.ts` — the file that actually held the
   152-character line — also need a pointer? Argue it either way, but measure first.
7. **Is putting a ruling into a production comment appropriate at all?** R-1 writes "HUMAN RULING 101
   passed point B; HUMAN RULING 102 recorded C-1 closed" into `src/`. Is that a specification fact
   that belongs next to the code, or ledger content that will rot there? This one is a judgement
   call and the controller wants it challenged.
8. **Anything vacuous or newly silent.** A test that still passes but now passes for the wrong
   reason, or an error path that quietly became a less useful answer — this project's signature
   defect.
9. **Comment width and splices.** ⚠️ A previous session created two splice defects by anchoring
   `str.replace` mid-sentence. This round inserted by line number with a verbatim whole-line
   assertion instead. Check every touched comment block for a sentence cut mid-way, and check the
   widest comment line per file against the baselines below.

## Protocol — binding

1. **Read-only on this checkout.** Never move HEAD, the index, or a branch. Never push, merge,
   commit, or delete a branch or worktree.
2. **Do not accept the implementer's self-report.** Re-measure anything you rely on. Every number in
   this brief is the controller's.
3. **Reading the code is not measuring it.** Label each finding as **measured** or **read-only
   argument**.
4. **Mutation only in a `git clone --local` copy.** *** Restoration is proven by the BYTE COUNTS of
   both `rtk proxy git diff` and `rtk proxy git diff --cached` on the copy — `diff -r` is NOT a
   restoration proof, it cannot see the index. *** ⚠️ **`git clone --local` clones committed state
   only**; to mutate uncommitted work, `cat` the working-tree file across first and verify with
   `diff`. ⚠️ This machine aliases both `cp` and `rm` to their `-i` forms: `cp` can silently decline
   to overwrite, and a plain `rm -rf` will HANG on a confirmation prompt until it times out. Use
   `cat pristine > target` and `/bin/rm -rf`.
5. **Never filter a verification run** (`grep`/`tail`/`head`/`sed` alike; a pipe also steals the exit
   code). Redirect to a file, read the whole file back, check vitest's first `RUN` line points at
   the checkout you meant. Run tests as
   `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run`.
   ⚠️ **rtk's filter layer will lie to you**: it prints `ok` for an empty `git status --porcelain`,
   reports a 0-byte `git diff` as 1 byte, truncates long grep output to `[+N more]`, and errors on
   some regexes. Any restoration proof or byte comparison must go through `rtk proxy git …`
   redirected to a file, then `wc -c`.
6. **Local machine and network.** You **MAY** use this machine's container runtime and pull public
   images to take a measurement. ⚠️ **OrbStack's docker CLI is at `/usr/local/bin/docker` but its
   daemon was DOWN at dispatch** (`unix:///Users/biran/.orbstack/run/docker.sock` refused). You may
   start it. You **MUST** report every such action. You **MUST NOT** install anything into this
   repository, modify the machine's configuration, or touch anything belonging to another running
   line of work. If a measurement needs more than that, say what you would have measured and stop.
7. **A bad probe proves nothing** — not absence, not violation. Check your probes before believing
   them.
8. Every finding needs a **constructible scenario**, and code references must be **anchored** by
   verbatim block plus a hit count, never by line number — line numbers in this package rot fast.
9. **A finding and its disposition are two different things.** Report it either way, saying which.
10. ⚠️ **KNOWN FLAKES — FOUR, NOT TWO.** Under load these time out at `Test timed out in 5000ms`;
    they are not regressions and are not to be investigated:
    - ruling 10's two: `run-scenario CLI > records env names only and tracks descendants rooted at
      the spawned pid`, and `persists phase usage evidence…`
    - *** **NOT on ruling 10's list, measured in ledger §35:** ***
      `runLoop > accounts an execute timeout that rejects after the abort as exhaustion`, and
      `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting
      stale run data`
    A red run whose **total duration is ~29s** rather than the usual **17–20s** is the load signature.
    Re-run the single file before concluding anything.

## Baseline measured on this checkout immediately before dispatch

`34 files / 603 tests` passed, **0 skipped**; `TEST_RC=0`; `typecheck` rc=0; `build` rc=0;
`tryRecoverStaleOwnerTransferLock` = **3185 bytes**, signature hit count 1; working tree clean
(`git status --porcelain` = **0 bytes**, index = **0 bytes**).
⚠️ *** **The criterion baseline is 603.** *** 602, 601 and 600 are all dead numbers.

**Widest comment line, metric pinned this round** — whole file, first non-space characters are `//`,
counted in **characters**: `src/persistence/fileStore.ts` **104**, `tests/persistence/fileStore.test.ts`
**129**, `tests/sweep/sweepRuns.test.ts` **101**. Claimed unchanged before and after.
⚠️ **The figures in ledger §33/§34 use an unstated and irreproducible metric** — do not compare
against them; §36 records why.

⚠️ **darwin only.** The suite is known red on linux (`5 failed / 593 passed`, measured by a previous
reviewer on an unrelated round); **none of point B has been run on linux.** Do not repeat that claim
more broadly than it was made.

## Out of scope — recorded elsewhere, not yours to re-raise

I-3 (after failing closed, the operator cannot see a permanently stuck lock — merged into ruling 85's
separate round, and it needs the redline function's **return type** to change), E1's I-2 cell (array
holder ⇒ `unlockCommand` deletes without `--force`; E1 is outside the authorised surface), `ccloop ls`
reporting locks (ruling 85), package 1, linux, and every commit at or below `06c6e31`.
**Do not declare point B passed or C-1 closed or E1 anything** — 101/102/103 already ruled all three,
and re-ruling them is not yours.

## Deliverable

Write your report to `.superpowers/sdd/2026-08-07-pkg2-data-loss/pointB-minors-review.md` (that
directory's `.gitignore` is `*` — it needs `git add -f`; **do not commit it yourself**). Sections:
Strengths / Critical / Important / Minor / Verification performed / Recommendations / Assessment.
Return the same content as your final message.

---

## *** ERRATUM (added after the review returned, HUMAN RULING 105) — THIS BRIEF MISLED THE REVIEWER ***

The brief above is kept **verbatim**, including the sentence that was wrong, because this
repository records what it once told people rather than quietly correcting it.

The false sentence is in the baseline section:

> ⚠️ **The figures in ledger §33/§34 use an unstated and irreproducible metric** — do not compare
> against them; §36 records why.

**That is false, and the fault is the controller's, not §33's or §34's.** Measured after the review
returned, with a character-counting implementation instead of `awk` (macOS `awk`'s `length()`
counts BYTES regardless of `LC_ALL`, which is what produced the original mistake):

| file | §33／§34 recorded | measured, widest comment line in **characters**, whole file |
|---|---|---|
| `src/persistence/fileStore.ts` | 101 | **101** |
| `tests/persistence/fileStore.test.ts` | 103 | **103** |
| `src/unlock/inspectLock.ts` | 100 | **100** |
| `src/unlock/unlockCommand.ts` | 101 | **101** |
| `tests/unlock/inspectLock.test.ts` | 101 | **101** |

**Five of five.** Sections 33 and 34 used the obvious metric — whole file, widest comment line, in
characters — and it was reproducible the whole time. The controller compared against **byte** counts,
concluded the earlier figures were irreproducible, published that accusation in §36 and in the
handoff, and then wrote it into this brief as an instruction not to check.

Consequences for the report this brief produced:

- Its **I-3** is correct as far as it goes (this round's figures are byte counts wearing a character
  label) but its premise — that §36's pin was introduced for a good reason — came from this brief.
  The deeper fact is that **no new pin was ever needed**.
- Every other finding in that report was reached independently and is unaffected. The controller
  re-measured I-1, I-2, I-4 and I-5 first-hand and confirms all four.

The correction is recorded in ledger §38. §36 and the report are left verbatim.
