# Independent review — the eight-Minor round (`62a4d49`, `d905592`, `f6fbf01`)

Reviewer seat: fresh and independent. I inherited no conclusion from the controller, the
implementer, or either prior reviewer. Scope: exactly the three commits named, parent `06c6e31`.
`0801920` / `713a87e` (ledger §36/§37) and `809bb50` / `979f5f0` (handoff) read as context only.

Checkout HEAD at review time `979f5f07cd6667e976e16993b0acfad5b72ecbd5`; main worktree read-only
throughout and proven so at the end (`git status --porcelain` **0 bytes**, `git diff` **0 bytes**,
`git diff --cached` **0 bytes**, all via `rtk proxy … > file; wc -c`). All mutation work happened in
a `git clone --local` copy, restored and proven restored by the same byte-count method, then removed
with `/bin/rm -rf`.

Every finding is tagged **[measured]** or **[read-only argument]**. Code is anchored by verbatim
block plus hit count over `src` + `tests`, never by line number. Every number I report names the
metric it was taken under.

---

## Strengths

**S-1. The red line really is untouched, and the round really is additive. [measured]**
`tryRecoverStaleOwnerTransferLock` extracted from `git show <rev>:src/persistence/fileStore.ts` at
`06c6e31`, `62a4d49`, `d905592`, `f6fbf01` and `HEAD`: **3185 bytes** at every one, and
byte-identical (SHA-1 of the function body `996c27f99449…` at all five). Signature hit count **1**,
return type `Promise<boolean>`. `git show --numstat` per commit: `62a4d49` = `22 0
src/persistence/fileStore.ts`; `d905592` = `106 0 tests/persistence/fileStore.test.ts`; `f6fbf01` =
`11 0 tests/sweep/sweepRuns.test.ts`. **+139 / −0 across the round, one file per commit.** Because
deletions are zero, no existing assertion, test name or `describe` string could have been edited in
place — landing point 3 is answered by arithmetic: ruling 4 covers this, and no ruling-88 naming was
owed.

**S-2. M-5 was a real gap, and both mutation results reproduce exactly as claimed. [measured]**
In the clone, with the whole `tests/persistence/fileStore.test.ts` file run unfiltered
(`RUN v2.1.9 …/scratchpad/clone`, redirected to a file and read back whole):

| mutation | old test A (`keeps a lock non-recoverable when its live holder is in the strong instance-id form`) | new test |
|---|---|---|
| redline unreachable — `if (!(await tryRecoverStaleOwnerTransferLock(runDir))) {` → `if (!(await Promise.resolve(false))) {` | **GREEN** | **RED**, `AssertionError: expected 0 to be greater than 0` at the `expect(lockReads).toBeGreaterThan(0)` line |
| ruling 83 guard reverted — `if (pid === null \|\| isProcessActive(pid)) {` → `if (pid !== null && isProcessActive(pid)) {` | **RED**, `promise rejected "Error: ENOENT…" instead of resolving` | **RED**, `expected 2 to be 1` |

Both mutation strings had hit count 1 before replacement. The one that matters is the first: test A
**does** stay green when the function it is about is never entered, so M-5 named a real vacuity and
the new criterion buys something. Clean run of the same file in the clone: `88 passed (88)`,
`TEST_RC=0`.

**S-3. M-4's central measurement is exactly true. [measured]** `src/persistence/fileStore.ts`
contains exactly **one** `open(` call of any kind: `const handle = await open(stagingPath, "w");`
(non-comment `open\w*\(` hit count over the whole file = **1**). Publication is
`await link(stagingPath, lockPath);`, and the `catch` around it is what routes EEXIST. So ERRATUM 3's
"the only `await open` left in this file is that staging one" and "an intruder now meets the link's
EEXIST" are both correct.

**S-4. M-6's three factual claims are all true, including the one nobody would have checked.
[measured]** Richer test `keeps a malformed lock non-recoverable even when staged artifacts are
present` has **4** post-hoc `expect` assertions; poorer test `leaves the lock on disk when malformed
staged state names no dead holder` has **1** pre-assertion and **1** post-hoc assertion, and that
post-hoc assertion (`resolves.toBe("not-json\n")` on the lock path) is verbatim one of the richer
test's four. So "three assertions the other lacks" is exact. I also extracted both fixtures (from
`const runDir` through the lock write, comments and blank lines dropped): **25 lines each, string-
identical** — "BYTE-IDENTICAL fixture" is true, not rhetoric.

**S-5. M-7's "five" survives a sweep of my own, and the brief was right to tell me not to trust it.
[measured]** Whitespace-normalised across `src` + `tests` (joining wrapped `//` continuations before
matching, which a naive line grep gets wrong on `inspectLock.ts`), the sentence *"that freeze has
since been lifted"* has **6** hits at HEAD and **5** at `06c6e31`: `src/persistence/fileStore.ts`,
`src/sweep/lockPresence.ts`, `src/unlock/inspectLock.ts`, `tests/sweep/lockPresence.test.ts`,
`tests/sweep/sweepRuns.test.ts`, plus the new one. The independent cross-check — mentions of the
redline function being *froze/frozen* — returns exactly those same 6 files and no seventh. The
convention was genuinely 5-of-6 and is now 6-of-6.

**S-6. M-1's four disputed figures all reproduce, on the trees the reversal names. [measured]**
`29aa60e` is `83ac585`'s parent (`rev-list --parents -n 1 83ac585` confirms). At `29aa60e`:

| figure | what it actually measures | measured |
|---|---|---|
| **125** | `tests/sweep/sweepRuns.test.ts` L674, **widest comment line in that file, characters** | 125 chars / 128 bytes, and it contains **no `***`** |
| **137** | `tests/sweep/sweepRuns.test.ts` L463, **widest line in the whole file, characters** — a line of **code** | 137 |
| **152 / 153** | `src/persistence/fileStore.ts` L702, **widest comment line in that file, characters**; 153 with newline | 152 / 153 |

And `83ac585`'s message does say `leaving "...not on that freeze. *** The probe is an INJECTED
dependency..." on one 153-character line` about `sweepRuns.test.ts`. The quote is wrong twice — the
`***` is absent, and the real text reads `not on that freeze).` with a closing paren. The erratum's
account is correct.

**S-7. The new test conforms to this file's established seam, and costs nothing measurable.
[measured]** `vi.resetModules()` → `vi.doMock("node:fs/promises", …)` → dynamic import → `finally {
vi.doUnmock; vi.resetModules }` is the shape used **20 other times** in
`tests/persistence/fileStore.test.ts`; the new test is instance 21 and deviates in nothing. There is
no `beforeEach`/`afterEach`/`vi.restoreAllMocks` hook to interfere with, and no `.concurrent` in the
file, so vitest runs these sequentially within the file and gives each file its own module registry
— the state-leak question in landing point 2 has no purchase here. Wall clock: the new test reported
**6–12 ms** in three separate runs; the file as a whole ran `88 passed` in 1446 ms. No new timeout
surface. The mock forwards every call to `actual` and only counts, so it cannot fake a result.

**S-8. The insertion method was sound. [measured]** All five inserted blocks begin and end on whole
comment lines at paragraph boundaries; no sentence anywhere in the diff is cut mid-way. The
`str.replace`-mid-sentence defect the brief warned about did not recur.

**S-9. Baseline re-measured, not taken on trust. [measured]** Clone, unfiltered, redirected:
`Test Files 1 failed | 33 passed (34)`, `Tests 1 failed | 602 passed (603)`, duration **20.61 s**.
**The criterion baseline is 603 — confirmed independently.** The single failure was
`run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`, one of
ruling 10's two; duration was in the 17–20 s band, not the ~29 s load signature. `typecheck` rc=0,
`build` rc=0.

---

## Critical

**None.** No production logic changed (S-1), so no behavioural regression is reachable from these
three commits. The findings below are all about statements — which, in this package, is the point,
but none of them can change what the code does.

---

## Important

### I-1. R-1 is a half-fix. "C-1 is not recorded as closed" survives verbatim in **two** more places — one of them in the very file `62a4d49` edited. [measured]

`62a4d49` corrected exactly one of three occurrences. The other two are untouched:

```
// recorded as closed: both halves are repaired, but this half has not had an independent review. ***
```
HITS[`src/persistence/fileStore.ts`:1] — the closing line of the ruling-83 ERRATUM on
`acquireOwnerTransferLock`, ~640 lines below the one that was fixed, **in the same file the commit
was editing**.

```
// and ruling 83's fail-closed exits. C-1 is still NOT recorded as closed: an independent
```
HITS[`tests/persistence/fileStore.test.ts`:1] — inside ERRATUM 3 of the concurrent-readers block,
**26 lines above the M-4 erratum `d905592` added to that same block**.

This is not a borderline case. It is *one claim in two* — now three — *places*, which is the exact
shape the controller's own rule names ("Fixing the test site and leaving this one would be the
half-fix this repository has already paid for twice", `62a4d49`'s message) and the exact shape §37
uses to justify M-1's reversal. The mandatory full-tree scan was evidently run for `open(lockPath,
"wx")` and not for the C-1 status sentence; a `grep -F 'C-1'` over `src` + `tests` returns 20 hits
and these two are in it.

Constructible scenario: a reader lands on `acquireOwnerTransferLock` — the function whose EEXIST
branch is the whole subject of C-1 — reads "C-1 is not recorded as closed", and concludes the
package's Critical is still open, contradicting ruling 102 and contradicting ERRATUM 3 six hundred
lines above in the same file. Disposition: finding, not disposed.

### I-2. ERRATUM 3 states something false: point B's **first** independent review had a Critical. [measured]

```
//     review" has been overtaken by ruling. Point B had two independent reviews, 0 Critical in
```
HITS[`src/persistence/fileStore.ts`:1].

Measured against the two documents themselves:
`.superpowers/sdd/2026-08-07-pkg2-data-loss/pointB-review.md` ("Point B review — `9dd044d` (the
redline change) and `e22d1ea` (the comment round)") has under `## Critical` a heading
`### C-1 — Half of human ruling 83 shipped with **zero** test coverage, and reverting it silently
restores theft of a **live** holder's lock` — **one Critical, not zero**.
`.superpowers/sdd/2026-08-07-pkg2-data-loss/pointB-cleanup-review.md` has `## Critical` → `**None.**`
— zero. So the true statement is *"two independent reviews; the first found one Critical, which was
fixed before the second, which found none."*

The irony is load-bearing: this sentence is in an erratum whose stated purpose is to stop a
production comment denying something the ledger records, and the ledger (§36's own recital, and the
test-file text at `tests/persistence/fileStore.test.ts` "an independent review of point B found
ruling 83's second exit had shipped with no test") records the Critical that the new sentence denies.
A statement with nothing supporting it, written into `src/`, is what this package exists to remove.
Disposition: finding, not disposed.

### I-3. The metric that was pinned this round to end a measurement dispute is itself mislabelled: every "widest comment line" figure in this round is a **byte** count reported as **characters**. [measured]

§36 pins the metric verbatim: *「全文件、首个非空白字符为 `//` 的行、按【字符】计」* — whole file, first
non-space characters are `//`, counted in **characters**. Measured under exactly that definition, on
the working tree and on `git show 06c6e31:<path>`:

| file | widest comment line, **characters** | widest comment line, **bytes** | reported this round |
|---|---|---|---|
| `src/persistence/fileStore.ts` | **101** | 104 | 104 |
| `tests/persistence/fileStore.test.ts` | **103** | 129 | 129 |
| `tests/sweep/sweepRuns.test.ts` | **99** | 101 | 101 |

Every reported figure matches the byte metric exactly, and in all three files the byte-widest line is
a *different line* from the char-widest one. The `129` case makes it unmistakable: that line is
`//     必需性（例如「若存在则校验，不存在则跳过」）… 缺失即拒绝的 fail-closed 行为必须保留"` — **59
characters, 129 bytes**. Calling it "129 characters" is off by 70. The same substitution runs through
the per-commit figures: `62a4d49`'s "widest line added is 102" is **100 characters / 102 bytes**;
`d905592`'s 100 and `f6fbf01`'s 97 happen to coincide only because those lines are pure ASCII.

The *conclusion* survives — under both metrics the three baselines are identical before and after
(101/103/99 chars, 104/129/101 bytes at `06c6e31` and at `HEAD`), so nothing this round did widened a
comment. But §36 introduced this pin specifically because §33/§34's figures were irreproducible, and
the very first round to use the new pin did not obey it. Disposition: finding, not disposed.

### I-4. The brief's premise "the remote tip is still `83ac585`, so this is a pre-push review" is false. Two of the three commits are **already on `origin/main`**. [measured]

`git ls-remote --heads origin` (network, `https://github.com/blrbiran/ccloop.git`) →
`809bb5023455f2891b1d7d4283abd8a84dddec2e refs/heads/main`. Ancestry against that tip:

| commit | on `origin/main`? |
|---|---|
| `62a4d49` | **yes** |
| `d905592` | **yes** |
| `0801920` (§36) | **yes** |
| `f6fbf01`, `713a87e`, `979f5f0` | no |

Three consequences, in increasing order of importance:

1. This is a **post-push** review of `62a4d49` and `d905592`. Everything I-1, I-2 and I-3 name is
   published.
2. The house rule now binds this round's own text: `62a4d49`'s and `d905592`'s errata are "text
   already in remote history", so I-1's and I-2's corrections must themselves be **appended errata**,
   not in-place edits. Only `f6fbf01`'s erratum is still same-session, unpushed text.
3. **`f6fbf01`'s erratum already contains a claim that has rotted.** It says, in `src`-adjacent test
   code, *"That message cannot be corrected: the commit is the remote tip, and rewriting it would
   void every hash the ledger cites."* `83ac585` is **not** the remote tip any more — it is four
   commits back. The load-bearing half of the reason (rewriting voids every ledger hash and rebases
   the descendants) is still true and is enough on its own; the half that names a moving reference is
   already false. A comment that pins a moving git reference is the same defect class as a comment
   that pins a byte baseline — the thing M-9 checked for and, in this one form, missed.

Also worth recording against §36/§37: both sections end with *「控制器全程未 push」* (the controller
never pushed). `origin/main` is four commits past `83ac585` and includes two of this round's three.
Whether the controller pushed or someone else did, the ledger's closing statement does not match the
remote. Disposition: finding, not disposed.

### I-5. M-4 has a **third** site, in the same file and the same `describe` block `d905592` edited, and it was missed. [measured]

```
// open(lockPath, "wx") gets a genuine EEXIST from the OS, never a zero-length-lock-window read),
```
HITS[`tests/persistence/fileStore.test.ts`:1].

This is the **`describe`-block header** of `recoverInterruptedOwnerTransfer: two concurrent unlocked
readers racing the same marker` — the block whose *inner* comment `d905592` fixed. It is present
tense ("gets"), it is a claim about production ("from the OS"), and production does not do it:
`acquireOwnerTransferLock` stages with `open(stagingPath, "w")` and publishes with `link(stagingPath,
lockPath)` (S-3), so reader B's EEXIST comes from `link(2)`, not from `open(lockPath, "wx")`.

Two things make this the most consequential miss of the round. First, it is the site a reader meets
**first**: the header sits above the `describe`, the corrected comment sits ~120 lines lower inside a
mock factory. Second, the round's own thesis is that previous rounds half-fixed the tree, and the
commit message for `62a4d49` announces "the full-tree scan this repository requires before any
comment round". That scan found the `src` site and missed a site in the file the very next commit
was about to edit. My own sweep of `lockPath, "wx"` over `src` + `tests` returns 10 hits; the three
in `src/persistence/fileStore.ts` at "used to be published in TWO steps" and "as `open(lockPath,
"wx")`'s EEXIST **used to be**" are past tense and fine, and the test-file hit reading "Under the
two-step publish this **reads** … because `open(lockPath, "wx")` returns …" is explicitly
counterfactual and fine. This one is neither. Disposition: finding, not disposed.

---

## Minor

### Mi-1. The M-7 erratum's insertion created a fresh stranded antecedent — the same defect M-2 exists to name. [measured]

In `tests/persistence/fileStore.test.ts` the block now reads: paragraph naming *mutation C* →
`*** ERRATUM (point B, HUMAN RULING 83) — THE DIRECTION REVERSED …* ** (which re-states "when mutation
C was measured") → **the new M-7 erratum, which mentions no mutation at all** →

```
// Three tests DO go red under that mutation today, but they report it as
```
HITS[`tests/persistence/fileStore.test.ts`:1].

Before `d905592`, "that mutation" had the direction erratum as its nearest antecedent and that
erratum names mutation C. After, the nearest block a reader meets is about a *freeze* and names no
mutation, so the referent is two blocks back. That is structurally the M-2 shape, manufactured by the
fix for M-7. It is milder than M-2 — M-2's nearest antecedent was a *different, wrong* referent,
whereas here it is simply absent, so a reader backs up rather than being misled — but under this
round's own standard it is a finding. Appending the M-7 sentence at the **end** of the whole comment
block, after "…learns from a failure message why they must not", would have cost nothing and avoided
it. Disposition: finding, not disposed.

### Mi-2. The M-7 erratum overstates what the other five sites say. [measured]

It asserts: *"Every other freeze site in this tree says the rest of it in so many words: that freeze
has since been lifted, for point B alone, **and the function changed**."* Normalised across wrapped
lines, the trailing clause appears in only **2 of the 5**: `src/persistence/fileStore.ts` ("…for
point B alone, and the function changed") and `src/sweep/lockPresence.ts` ("…for point B alone, and
the function changed"). The other three — `src/unlock/inspectLock.ts`,
`tests/sweep/lockPresence.test.ts`, `tests/sweep/sweepRuns.test.ts` — stop at "for point B alone."
The operative claim ("all carry that sentence", i.e. the freeze-lifted sentence) is true; the
"in so many words … and the function changed" gloss is true of 2 of 5. Small, but this is a package
where a gloss like that is exactly what a later round re-measures and disputes.

### Mi-3. The new test's meaning rests on a premise asserted only in a comment. [read-only argument]

The test's comment states the anti-vacuity premise correctly and I confirmed it (`readFile(lockPath,
…)` appears exactly once in `src/persistence/fileStore.ts`, as the first I/O statement of the redline
function; no other `readFile` in that module takes the lock path). But **nothing enforces it**. Its
own neighbour does better: test A asserts its premise in code
(`expect(strongHolder).not.toMatch(/^pid:\d+$/)`), and the new test copies that line for the *holder
form* premise while leaving the *"exactly one reader"* premise as prose.

Constructible scenario: someone adds a second `readFile` of the lock path to `fileStore.ts` — a
diagnostic, a pre-check in `acquireOwnerTransferLock`, or a retry that re-reads before deciding.
`lockReads` then rises for a reason that has nothing to do with entering the redline function, the
test stays green, and it has quietly stopped being the positive observation it was added to be. That
is this project's signature defect applied to the very fix for it. `toBeGreaterThan(0)` is the right
*strength* — the reasoning about the retry bound is sound and I would not tighten it to `toBe(1)` —
but the premise deserves an enforced form. The cheapest one that does not touch production: have the
mock also count non-lock reads, or count `readFile` calls whose path is the lock path *and* assert
the epoch/lock invariants that pin which branch was taken (already there) — or, simplest, add a
sibling assertion in the same file that fails if `fileStore.ts` grows a second lock-path reader.

### Mi-4. The commit message's framing overstates how much of the mutation the new test uniquely catches. [measured]

Under mutation B (redline unreachable) the file reports **4 failures**, not 1: the new test, plus
`reclaims a lock whose holder is an ARRAY that String()s into pid:<n> -- pinned as measured`,
`reconciles a stale transfer lock with pending artifacts before reading owner-record.json`, and the
concurrent-readers test (timed out at 5000 ms). M-5's specific claim is untouched by this — those
three catch the loss of *reclamation*, none of them observes that **test A's own fixture** entered
the function — but a reader of `d905592`'s message would reasonably infer the mutation was otherwise
invisible, and it was not. Recording it so a later round does not "discover" it as a contradiction.

### Mi-5. M-2's "the sentence is true where it sits" is defensible but strained by its own tail clause. [read-only argument]

The stranded sentence is *"A separate liveness implementation inside the unlock command would be free
to / drift into that same failure, **on the one command whose purpose is to not delete live locks**."*
Under the STEALER reading the tail is the point: stealing is worst precisely on the command that must
never delete a live lock. Under the REFUSER reading — the antecedent a reader now meets — an
unconditional refuser on `ccloop unlock` is a usability stall, and the tail clause reads as a
non-sequitur, since refusing is what that command's purpose *aligns* with. So "could drift into
either" is true of the *direction* of drift under ruling 83, and I do not dispute it; "the sentence
is true where it sits" is true of the first clause and awkward for the second. This does not need
another erratum — the M-2 erratum already names the intended antecedent explicitly, which is the
whole substance of the fix. Recorded so nobody re-derives it as a new finding.

### Mi-6. R-1's judgement call: putting ruling numbers into `src/` bought a correction and a rot surface. [read-only argument]

Landing point 7 asked for this to be challenged, so: the **correction** is right and the **form** is
wrong. A production comment that asserts "C-1 is not recorded as closed" is making a claim about the
repository's bookkeeping, and once the human ruled, that claim was false; leaving it would reproduce
the defect this package exists to remove. That much I agree with entirely.

But the fix answers a bookkeeping claim with more bookkeeping. Within one round, the added sentences
have produced two rot events: I-2 (the "0 Critical in both" figure was wrong on the day it was
written) and I-4.3 (`f6fbf01`'s "the commit is the remote tip" was overtaken within hours). The
lesson the original ERRATUM 2 offers is *don't put review status in a source comment*; R-1 read it as
*keep the review status in the source comment and update it*. A form that keeps the correction and
drops the rot surface: *"ERRATUM 2's (a) states a review-and-ruling status. That status is tracked in
the ledger, not here, and has since changed; this file no longer asserts it."* No count, no ruling
number that a later ruling can overtake, and the false claim is still retired. I would not ask for
`62a4d49` to be rewritten for this — it is pushed — but I would ask the *next* erratum not to add a
new figure.

---

## Verification performed

All of it in a `git clone --local` copy at
`…/scratchpad/clone`, `node_modules` symlinked from the main checkout, `RUN` line confirmed to point
at the clone on every run. Every test run unfiltered and redirected to a file, then read back whole.
Environment `ECC_GATEGUARD=off DISABLE_OMC=1` per project convention.

1. **Baseline, clone, whole suite.** `Test Files 1 failed | 33 passed (34)`, `Tests 1 failed | 602
   passed (603)`, duration **20.61 s**, `TEST_RC=1`. Sole failure: `run-scenario CLI > records env
   names only and tracks descendants rooted at the spawned pid`, `Test timed out in 5000ms` — ruling
   10's named flake. Duration in the 17–20 s band, not the ~29 s load signature. **603 confirmed as
   the criterion baseline.**
2. **`typecheck` rc=0, `build` rc=0** in the clone.
3. **Red line.** Function body extracted by name at `06c6e31`, `62a4d49`, `d905592`, `f6fbf01`,
   `HEAD`: **3185 bytes and byte-identical at all five** (SHA-1 `996c27f99449…`). Signature hit count
   1; return type `Promise<boolean>`. `970 / 1558 / 2515` do not appear in `src` or `tests`.
4. **Mutation B** — `if (!(await tryRecoverStaleOwnerTransferLock(runDir))) {` (hit count 1) →
   `if (!(await Promise.resolve(false))) {`. Whole test file, unfiltered: `4 failed | 84 passed (88)`.
   Test A **green**; new test red, `expected 0 to be greater than 0`. Restored; `rtk proxy git diff`
   **0 bytes**, `rtk proxy git diff --cached` **0 bytes**.
5. **Mutation A** — `if (pid === null || isProcessActive(pid)) {` (hit count 1) →
   `if (pid !== null && isProcessActive(pid)) {`. `2 failed | 86 passed (88)`. Test A red on
   `promise rejected "Error: ENOENT…" instead of resolving`; new test red on `expected 2 to be 1`.
   Restored; both diffs **0 bytes**.
6. **Clean control**, same file, clone, after both restorations: `88 passed (88)`, `TEST_RC=0`,
   new test 6–12 ms.
7. **Whole-tree sweeps** (python, exact substring / normalised-wrap regex — no `rtk` grep, which
   truncates to `[+N more]`):
   - `open(` in `src/persistence/fileStore.ts`, non-comment: **1 hit**, `await open(stagingPath, "w")`.
   - `readFile(` in the same file, non-comment: 9 hits, of which **exactly 1** takes `lockPath`, the
     first I/O statement of the redline function.
   - `lockPath, "wx"` over `src` + `tests`: 10 hits, classified individually (I-5).
   - `C-1` over `src` + `tests`: 20 hits, classified individually (I-1).
   - `independent review`, `open point B`, `unruled` over `src` + `tests`: every remaining historical
     hit already carries an erratum, except the two in I-1.
   - *"that freeze has since been lifted"*, wrap-normalised: 5 at `06c6e31`, 6 at `HEAD`; cross-checked
     against *froze/frozen* mentions of the redline function, which return the same 6 files.
   - Stranded-antecedent heuristic: every comment line that follows an erratum-closing `***`, listed
     and read by hand — 14 candidates in `src` + `tests`, of which one is Mi-1.
8. **Widest comment line**, whole file, first non-space is `//`, computed **both** in characters and
   in bytes, at `06c6e31` and `HEAD`, plus the widest added comment line per commit (I-3).
9. **M-1 figures** measured on `29aa60e` (verified to be `83ac585`'s parent): 125 / 137 / 152 / 153
   as tabulated in S-6, plus the text of `83ac585`'s message.
10. **M-6 counting**: assertion counts and a line-by-line equality check of the two fixtures.
11. **Mock hygiene**: enumerated all `vi.resetModules` / `vi.doMock` / `vi.doUnmock` sites in
    `tests/persistence/fileStore.test.ts` (20 pre-existing pairs, all the same shape) and confirmed
    no `beforeEach` / `afterEach` / `restoreAllMocks` / `.concurrent` anywhere in the file.
12. **Remote state**: `git ls-remote --heads origin` over the network, plus `merge-base --is-ancestor`
    for each commit of the round (I-4). **Reported as required: this was the one network action I
    took.** I did **not** start OrbStack, install anything, or modify machine configuration.
13. **Restoration and read-only proof.** Clone: `git diff` 0 bytes, `git diff --cached` 0 bytes, then
    `/bin/rm -rf`'d. Main checkout at the end: `git status --porcelain` **0 bytes**, `git diff`
    **0 bytes**, `git diff --cached` **0 bytes**, `HEAD` still
    `979f5f07cd6667e976e16993b0acfad5b72ecbd5`. All byte counts taken via `rtk proxy git … > file`
    then `wc -c`, never from rtk's filtered output.

**Not done, and named rather than implied:** I did not run the suite on linux and make no claim about
it; I did not re-run the other three known flakes to characterise them; I did not review `0801920`,
`809bb50`, `713a87e` or `979f5f0` beyond reading them as context; I did not touch E1, the acquire
path, `release()`, the sweep, `ccloop ls`, or package 1; and I make no ruling on point B, C-1 or E1 —
101/102/103 already did.

---

## Recommendations

Ordered by what a reader of this tree is most likely to be misled by. The first three are the
half-fixes; they are the ones this round set out to eliminate and did not.

1. **Close I-1 at both sites, as appended errata.** Both are now in remote history (I-4), so the
   house rule requires appending, not editing. One sentence at each site pointing at ruling 102 is
   enough — and, per Mi-6, it should point at the ruling without importing a new count.
2. **Close I-5.** Append an erratum to the `describe`-block header in
   `tests/persistence/fileStore.test.ts`, worded to match the one `d905592` already put 120 lines
   below it, so a reader who stops at the header gets the same correction as one who reads on.
3. **Correct I-2.** The true sentence is short: two independent reviews, the first found one
   Critical, it was fixed, the second found none. Appended erratum; do not edit in place.
4. **Fix the metric label, not the numbers (I-3).** The figures are right *as byte counts* and the
   before/after conclusion holds under either metric. Either re-state the pin as "bytes" or re-report
   the three baselines as 101 / 103 / 99 characters — but say in the ledger which one changed and
   why, or the next round re-opens the same dispute §36 closed.
5. **Correct the remote-tip premise in `f6fbf01` (I-4.3) — this one can still be fixed in place.**
   `f6fbf01` is unpushed and same-session, so the house rule's narrow in-place exception applies if
   and only if the sentence was never true; it *was* true when written, so an appended clause is the
   safer reading. Either way, drop the moving reference and keep the durable reason: rewriting
   `83ac585` would void every hash the ledger cites.
6. **Amend the ledger's closing line about pushing (I-4).** §36 and §37 both end with 「控制器全程未
   push」 while `origin/main` is four commits past `83ac585`. Whichever is wrong, one of them is.
7. **Give the new test's premise an enforced form (Mi-3)** — cheap, additive, covered by ruling 4.
8. **Prefer end-of-block placement for future errata (Mi-1)**, or make each erratum restate the
   referent it interrupts. Appending in the middle of a comment block is now a demonstrated way to
   create the M-2 defect while fixing another one.
9. **Process, not code:** the "mandatory full-tree scan" caught `open(lockPath, "wx")` and missed
   both `C-1 is not recorded as closed` (three sites) and one further `open(lockPath, "wx")` site in
   the file being edited. The scan is only as good as the list of strings it is run on. Deriving that
   list mechanically — every sentence an erratum corrects, swept verbatim over `src` + `tests` before
   the commit — would have caught I-1 and I-5 automatically.

---

## Assessment

**The work is sound where it is measurable, and incomplete where it claims to be complete.**

Everything I could check by measurement about the *code* holds: the red line is byte-identical across
all three commits, the round is +139/−0 with no existing criterion touched, both mutation results
reproduce exactly, M-5's gap was real and the new criterion catches it while the old one does not,
and the new test conforms to the file's own seam at a cost of milliseconds. M-6's counting, M-7's
"five", M-4's "only `await open` is the staging one", and all four of M-1's disputed figures survive
independent re-measurement on the right trees. The M-1 reversal in §37 is right, and its erratum
lands in the correct file for the reason it gives. The brief told me not to trust the number five and
not to trust the number 603; both are correct.

What does not hold is the round's own headline claim. `62a4d49`'s message says leaving the second
site unfixed "would be the half-fix this repository has already paid for twice" — and the round then
half-fixed two things. `C-1 is not recorded as closed` was corrected in one of three places, with the
other two in the two files the round was editing (I-1). The present-tense `open(lockPath, "wx")` was
corrected in two of three, with the third being the `describe` header of the very block that received
the fix (I-5). Both are exactly the shape the round condemns, and both were reachable by the sweep
the round says it ran.

Three further defects are of the class this package exists to eliminate — a number with nothing
behind it. "0 Critical in both" was false when written (I-2). Every "widest comment line" figure is a
byte count wearing a character label, under a metric pinned this round precisely to stop that (I-3).
And a premise about the remote tip went stale inside a production comment within hours, while the
brief for this very review still asserted it (I-4).

None of it is Critical. No production logic moved, so nothing here can lose data. But the pattern is
worth naming plainly: this round fixed nine findings about false statements and shipped five new
ones, four of them in the same files and one of them in the same comment block. The remedy is not
more errata — it is deriving the sweep list from the sentences being corrected, mechanically, before
the commit rather than after the review.

I make no ruling on point B, C-1 or E1; 101, 102 and 103 already did, and re-ruling them is not mine.
