# Independent review — the point B cleanup round (A, C, B) plus Mi-2 and T2

Reviewer seat: fresh and independent. Scoped to the five commits `29aa60e`, `83ac585`, `5d1349e`,
`862491f`, `3d65e2b`. Ledger commits `6a5a37b` / `b38d07f` / `9a62f31` read as context only.
Checkout HEAD at review time: `9a62f3147dbcbcddc77b74c0b45eaca4106ec755`, working tree clean
(`rtk proxy git status --porcelain` → **0 bytes**; `git diff` → 0; `git diff --cached` → 0).

Every claim below is tagged **[measured]** or **[read-only argument]**. Code is anchored by verbatim
block plus hit count over `src` + `tests`, never by line number.

---

## Strengths

**S-1. A is not vacuous, and it is the *only* thing in the suite that catches the revert.
[measured]**
In a `git clone --local` copy I replaced the guard

```
if (pid === null || isProcessActive(pid)) {          HITS[src/persistence/fileStore.ts:1]
```

with `if (pid !== null && isProcessActive(pid)) {` and ran the whole suite unfiltered. Result:
`Test Files 2 failed | 32 passed (34)`, `Tests 2 failed | 599 passed (601)`, `TEST_RC=1`. The two
failures were A's own test —
`fileStore > keeps a lock non-recoverable when its live holder is in the strong instance-id form` —
and the flake ruling 10 exempts
(`evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the
spawned pid`, timed out at 5000ms; it passed in the clean baseline run). Nothing else moved. That is
simultaneously the proof that A goes red on its own claim **and** the proof that the hole the
previous review measured was real: with A removed the same revert leaves 600 green.

**S-2. A's failure message names the cause. [measured]** Vitest printed
`AssertionError: promise rejected "Error: ENOENT: no such file or directory,… { …(4) }" instead of
resolving`, `Caused by: … open '…/.owner-transfer.lock'`. The lock-file assertion really is first,
and the first thing a reader sees is that the lock is gone. The commit message's quoted wording
matches what the runner actually prints.

**S-3. A's in-code claim "under the reverted guard all three of these fail" is true, and the third
assertion is the one that matters. [measured]** Vitest stops at the first failing assertion, so the
suite run above could not show this. I built a separate probe in the clone with the same fixture and
recorded all three outcomes independently under the reverted guard:
`PROBE_A lock=REJECTED ENOENT epoch=2 pending=REJECTED ENOENT`. So the revert does not merely delete
the lock — it lets the staged transfer be **finalized behind a live holder's back** (epoch 1 → 2,
`.owner-transfer.pending.json` renamed away). A pins the data-loss consequence, not just the unlink.

**S-4. A is a pure addition and it names its ruling. [measured]** `git show --numstat 29aa60e` =
`64 0 tests/persistence/fileStore.test.ts`. Zero deletions, so no existing criterion was touched and
ruling 4 covers it without a ruling-88 naming; it states its ruling anyway
(`// Encodes human ruling 83 (point B) -- specifically the OTHER exit that ruling names, which`,
HITS[tests/persistence/fileStore.test.ts:1]). It also asserts its own premise
(`expect(strongHolder).not.toMatch(/^pid:\d+$/)` and `startsWith(\`pid:${process.pid}:\`)`), which is
what stops a future `buildProcessInstanceId()` change from silently converting it into a liveness
test.

**S-5. C's restoration claim is exactly, arithmetically true. [measured]** I extracted the 14 lines
`e22d1ea` removed (`git show -U0 e22d1ea` → `-` lines, minus the `---` header) and searched each as a
fixed substring across `src` + `tests`. **12 of 14 return exactly one hit.** The other two are
genuine line-wrap splits with both halves present verbatim:
`// lock stealer. A separate liveness implementation inside the unlock command would be free to`
is now `// lock stealer.` plus
`// A separate liveness implementation inside the unlock command would be free to`; and
`// safeUnlink. Three tests DO go red under that mutation today, but they report it as` is now
`// safeUnlink.` plus `// Three tests DO go red under that mutation today, but they report it as`.
The implementer's "12 of 14 verbatim, 2 proven splits" is precisely what I measure.

**S-6. Mi-3 (widest comment line) is exactly as claimed. [measured]** Character-count (not byte-count)
maximum over the six files `e22d1ea` touched: `e22d1ea^` = **103**, `e22d1ea` = **152**, HEAD = **103**.
Per-file HEAD maxima: fileStore.ts 101, lockPresence.ts 101, inspectLock.ts 100, unlockCommand.ts 101,
fileStore.test.ts 103, lockPresence.test.ts 100, sweepRuns.test.ts 99, inspectLock.test.ts 101. **No new
splice defect of the 150-char kind exists anywhere in the touched set.**

**S-7. T2's measurements are right, all three of them. [measured]** The two fixtures (from
`const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));` through
`await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");`) are **26 lines / 1171 bytes
each and `diff` reports them identical**. The post-hoc assertion
`await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).resolves.toBe("not-json\n");`
occurs **exactly twice** in the file, once in each test — so it is verbatim one of the other's four.
And "the only unique content is the pre-assertion" holds: the annotated test is a strict subset of
its sibling (it drops the epoch, holder and pending-file assertions and discards `readOwnerRecord`'s
return) plus the one pre-assertion. The third malformed-lock test,
`keeps a malformed lock without staged artifacts non-recoverable`, exercises
`writeOwnerTransferArtifacts` → `OwnerTransferLockBusyError` and is correctly excluded from the note.

**S-8. Mi-2's coercion claim is right, and I proved it by running the code, not by reading it.
[measured]** Node probe:
`{"holderProcessInstanceId":["pid:999999"]}` → `pid=999999`; `[["pid:999999"]]` → `pid=999999`;
`{"a":1}` → `null`; `999999` → `null`; `[]` → `null`; `["pid:999999",""]` → `null`;
`{"toString":"x"}` → `TypeError: Cannot convert object to primitive value` (swallowed by the
function's own `catch { return false; }`, i.e. fails closed). Then, end-to-end in the clone against
the real `readOwnerRecord`: with a dead pid (`isProcessActive(999999) === false`, asserted as a
premise) and an **array** holder, the lock **is deleted**; with an object holder it survives. Mi-2
describes a real, reachable widening.

**S-9. The "bounded" hedge survives the attack. [measured + read-only argument]** Reaching
`await safeUnlink(lockPath);` (HITS[src/persistence/fileStore.ts:2], the redline's is the second)
requires `JSON.parse` to succeed, `holderProcessInstanceId` to be truthy, `parsePid` to return
non-null, and `isProcessActive` to return false. The coercion changes only *which values reach*
`parsePid`; it does not bypass the liveness gate, because the gate runs on the coerced pid. I found
no JSON value that reaches `safeUnlink` with a **live** pid. So "no LIVE lock becomes reclaimable
this way" is correct as written, and Mi-2 is correctly not a Critical.

**S-10. The house rule was obeyed, mechanically. [measured]** `git show -U0` on `83ac585`, `5d1349e`,
`862491f`, `3d65e2b`, stripped of `+++`/`---`, contains **zero** added-or-removed lines that are not
`//` comments. Numstat: C `37/23`, B `35/0`, Mi-2 `11/0`, T2 `10/0` — B, Mi-2 and T2 are literally
pure additions, and the brief's "+21/-0 for the last two" is exact. Every restored paragraph I read
(`OwnerTransferLockRecord` export, the `parsePid` block, `lockPresence.test.ts`,
`sweepRuns.test.ts`, C-1's `WHAT IS DELIBERATELY UNCHANGED`) is a whole paragraph followed by a
marked ERRATUM, with no sentence cut mid-way.

**S-11. The baseline is what the brief says. [measured]** `34 passed (34)` files, `601 passed (601)`
tests, **0 skipped**, `TEST_RC=0`, vitest's first line `RUN v2.1.9 /Users/biran/code/skills/loop/ccloop`.
`typecheck` rc=0, `build` rc=0 (both run in the clone, so the checkout stayed read-only).
`tryRecoverStaleOwnerTransferLock` extracted from signature to closing brace = **2515 bytes / 48
lines**, signature hit count **1**. The "601, not 600" correction is right.

---

## Critical

**None.** The one candidate the brief flagged in advance — "if the Mi-2 hedge is wrong, that is
Critical" — I attacked and could not break (S-9). No production logic changed in any of the five
commits (S-10), so no behavioural regression is possible from them.

---

## Important

### I-1. Mi-2's erratum states a fact about the codebase that is false, and it is load-bearing in the erratum's own argument. [measured]

Anchor (HITS[src/persistence/fileStore.ts:1]):

```
  // ruling 83's authorisation — and parsePid has two other callers (unlock, sweep). ***
```

Measured: `parsePid` has **exactly one** other caller in production, not two.
`grep -rn parsePid src tests` yields exactly one call site outside the redline function —
`const pid = holder === "" ? null : parsePid(holder);` (HITS[src/unlock/inspectLock.ts:1]) — and
exactly one import, `src/unlock/inspectLock.ts:44`. **The sweep has no `parsePid` caller at all, and
by design cannot have one**: board C-a chose presence-only precisely so the sweep never reads or
parses this file, which the same tree states three times
(`// allowed to do — ask whether the file EXISTS. It must not read the file, must not parse it, must`,
HITS[tests/sweep/lockPresence.test.ts:1]).

Why it matters rather than being a typo: the sentence is the *second half of the reason given for not
fixing the coercion*. "A `typeof === "string"` guard is NEW LOGIC in this function — outside ruling
83's authorisation — **and** parsePid has two other callers" is a blast-radius argument. The real
blast radius is one caller, and that caller (`inspectLock`) is the one place where a `typeof` guard
would arguably be *wanted* (see I-2). A future human weighing ruling 94 again would be weighing a
number that is wrong.

Constructible scenario: a reader acting on this comment goes looking for the sweep's `parsePid` call
to assess the risk of hardening it, finds none, and either concludes the comment is stale in some
unknown other way or re-derives the analysis from scratch.

Disposition: **finding, not disposed.** Under ruling 94's own grant the fix is one word inside an
already-authorised comment. I do not propose the `typeof` guard — that remains out of authorisation.

### I-2. Mi-2 says "shared with E1" and stops there; measured, the E1 consequence is a category change, not a shared quirk. [measured — recorded as an observation, not a proposal]

Anchor (HITS[src/persistence/fileStore.ts:1]):
`// way. Pre-existing (parsePid predates point B) and shared with E1. Left as measured rather`

Measured in the clone against the real `inspectOwnerTransferLock`: a lock whose
`holderProcessInstanceId` is `["pid:999999"]` (dead pid) is reported as
**`state: "dead"`**, not `state: "unrecognized-holder"`. Tracing that into the acting half
(`if (inspection.state === "dead") {`, HITS[src/unlock/unlockCommand.ts:1]) the command calls
`removeLockIfUnchanged` and **deletes the lock with no `--force` and no `--expect` digest**.

So on the E1 path the same coercion does not merely "also happen" — it moves a lock from the cell
ruling 72 designed to refuse (unattributable holder → fail closed, `--force` required) into the cell
that deletes unattended. The bound is the same one Mi-2 names (the pid must be dead), and no live
holder is at risk, so this is not Critical. But "shared with E1" reads as *the same harmless thing
happens over there*, and what actually happens over there is the loss of the fail-closed answer for
that input. That is the erratum **understating**, which is exactly the reverse-direction check the
brief asked for.

⚠️ `ccloop unlock` (E1) is outside this round's authorisation. I record this as an **observation**
only, propose no change to E1, and do not say whether E1 passes.

Constructible scenario: an operator finds `.owner-transfer.lock` containing
`{"holderProcessInstanceId":["pid:4242"],"acquiredAt":"…"}` (externally corrupted, or written by a
future/foreign tool that JSON-encodes the holder as a list). pid 4242 is not running.
`ccloop unlock <runDir>` prints `removed …` and deletes it. The design says that cell should print
`refused` plus a `--force --expect <digest>` line.

### I-3. B's "six" is at least eight — and two of the misses are in files B itself edited. [measured]

The brief said not to trust the count of six, so I swept the whole tree myself for statements point B
falsified (`stealer|steal`, `froze|freeze|frozen`, `hasStagedArtifacts`, `pid !== null &&`,
`fall(s|en) through`, `skip*` near guard/liveness/pid, `staged artifact`, every reference to
`tryRecoverStaleOwnerTransferLock`). Everything B and C annotated checks out. Two statements do not:

**(a) `tests/unlock/inspectLock.test.ts` — flatly false, and the test *name* carries it.**

```
  it("answers unrecognized-holder for the strong identity form, rather than skipping the liveness guard", async () => {
```
HITS[tests/unlock/inspectLock.test.ts:1], with body comment
```
    // redline function that null SKIPS the liveness check and falls through to the unlink. Here it
```
HITS[tests/unlock/inspectLock.test.ts:1].

Under `if (pid === null || isProcessActive(pid)) {` a null pid **returns false and never reaches
`safeUnlink`**. It does not "fall through to the unlink". This is the same reversed-direction claim
B's own commit message calls "the worst of the six" — and B corrected it in **the header of this very
file** (`*** ERRATUM (point B, HUMAN RULING 83) — THE DIRECTION REVERSED. The paragraph above is kept`,
HITS[tests/unlock/inspectLock.test.ts:1]) while leaving this copy, 78 lines below, untouched. The
file now says REFUSER at the top and STEALER-by-implication in the middle, which is the exact
half-corrected state B's message says is worse than uncorrected. `tests/unlock/inspectLock.test.ts`
was inside ruling 93's widened authorisation, so nothing blocked fixing it.

**(b) `src/unlock/inspectLock.ts` — stale, in the production file.**

```
// which skips the liveness guard entirely. Hence fileStore's own parsePid/isProcessActive here,
```
HITS[src/unlock/inspectLock.ts:1].

Under a narrow reading ("`isProcessActive` is not called") this survives on a short-circuit
technicality. Under the reading its context invites — the same mutation-C story the file's other two
blocks were given errata for — it points at the pre-ruling-83 failure. This file's other two
paragraphs each carry an ERRATUM; this third one, three lines above the `parsePid` import, does not.

Constructible scenario: a reader hardening `inspectLock` reads (b), then (a), and concludes the
redline function still deletes on an unparsed holder — the belief B's round exists to remove — and
either "fixes" a bug that no longer exists or leaves a real one alone on the strength of a stale
premise.

Disposition: **finding, not disposed.** Both sites are inside the ruling 91/93 comment authorisation.
Neither requires touching an assertion; (a)'s test name would need a ruling-88 naming if renamed, so
the appended-ERRATUM route is the one that fits the house rule.

---

## Minor

**M-1. C's commit message misattributes its own measurement. [measured]** It says
`tests/sweep/sweepRuns.test.ts` was left "on one 153-character line" and quotes
`"...not on that freeze. *** The probe is an INJECTED dependency..."`. Measured at `29aa60e`: that
sweepRuns line is **125 characters** and contains no `***` — the actual text is
`// ruling 83 — presence-only rests on §7.2, not on that freeze). The probe is an INJECTED dependency, the same shape \`scan\``.
The 152-character line (153 with its newline) was in **`src/persistence/fileStore.ts`**:
`// command whose whole job is to refuse must not call a reader that deletes at all. Sharing the shape is what keeps the two readers describing one file.`
C fixed **both** defects; only the message's bookkeeping is wrong. In a commit whose entire purpose is
that a commit message must be true, an unverified number in that message is worth naming.

**M-2. C restored the paragraph but left `e22d1ea`'s orphaned sentence where it fell. [measured]**
`// A separate liveness implementation inside the unlock command would be free to`
(HITS[src/persistence/fileStore.ts:1]) now sits **after** the ERRATUM, separated from the antecedent
of "that same failure". Before `e22d1ea` it was the second half of the same wrapped line as
`// lock stealer.`; `e22d1ea` flung it past the erratum, and C restored the paragraph text without
moving it back. The nearest antecedent a reader now meets is the erratum's REFUSER, not the
paragraph's STEALER. Not false — a second liveness implementation could drift into either — but this
is the second of the two splice shapes the brief named, and C fixed only the sweepRuns one.
Disposition: finding, not disposed.

**M-3. Two errata describe the "permanently stranded" set in a way that sweeps in live-holder locks.
[read-only argument]**
```
// — it is every lock that is not a parsed `pid:<n>` whose process is dead. The intersection with
```
HITS[src/unlock/unlockCommand.ts:1], and the parallel sentence
`// every lock that is not a parsed \`pid:<n>\` whose process is dead. The intersection this test`
HITS[tests/unlock/inspectLock.test.ts:1].

Read literally, a lock held by a **live** `pid:<n>` is "not a parsed `pid:<n>` whose process is
dead", so it joins the set the surrounding paragraph calls "stranded on disk forever". It is not: it
clears the moment the holder exits. The erratum then says the intersection with what the command
refuses "makes `--force` load-bearing for more of the table" — but for that cell `--force` is
explicitly unavailable, as the same file says twenty lines below
(`A LIVE HOLDER IS NEVER REMOVED, --force INCLUDED`). Constructible scenario: an operator reads the
erratum, believes `--force` is their route out of a live-holder refusal, and pastes the command;
they get refused a second time. A qualifier — "not reclaimable by the automated path *and* whose
holder is not a live pid" — closes it.

**M-4. A false comment in `fileStore.test.ts` survived B's pass over that exact file. [measured]**
```
              // which runs exactly when its own open(lockPath, "wx") lost the EEXIST race -- i.e.
```
HITS[tests/persistence/fileStore.test.ts:1]. Measured: `open(lockPath, "wx")` does not exist in
production — `grep -F '"wx"' src` returns only comment lines, and the only `open(` call in
`fileStore.ts` is `const handle = await open(stagingPath, "w");`. The same file contradicts it 21
lines above: `// atomic publish, nothing ever calls \`open\` on the lock path`. This was falsified by
ruling 50, not by point B, so it is **outside** B's stated brief — but B added ERRATUM 3 inside this
same comment block and did not notice it. Disposition: finding, out of B's scope, recorded.

**M-5. A has no positive observation that the code under test ran. [read-only argument]** All three
of A's assertions describe a world where *nothing happened* (lock byte-identical, epoch still 1,
pending file still there). That state is indistinguishable from
`tryRecoverStaleOwnerTransferLock` never having been invoked at all. The mutation I ran (S-1/S-3) is
what proves it is invoked — but that evidence lives in a commit message, not in the suite. This file
already owns the counter-pattern: `withLockAttemptCounter` and the
`// Anti-vacuity, and load-bearing:` block exist precisely to stop a test passing while observing
nothing. A single `expect(attempts()).toBe(...)`-style positive control, or an assertion that
`readOwnerRecord` did enter the busy/retry path, would make A self-evidencing. Ruling 4 permits
adding it. Disposition: finding, not disposed; A is correct as it stands.

**M-6. T2's note is attached to the poorer of the two tests only. [read-only argument]** The ERRATUM
lives on `leaves the lock on disk when malformed staged state names no dead holder`, the strict
subset. A reader who arrives at the richer sibling
(`keeps a malformed lock non-recoverable even when staged artifacts are present`) sees nothing, and
that is the test whose deletion would cost real coverage (three assertions the other lacks). The
note's stated purpose — "so the next reader does not rediscover the redundancy and quietly drop a
passing criterion" — is only half-served. A one-line pointer on the sibling would close it.

**M-7. One kept-verbatim freeze claim got a direction erratum but never a freeze erratum. [measured]**
`// turns tryRecoverStaleOwnerTransferLock, the function human ruling 50 froze byte-for-byte, into an`
(HITS[tests/persistence/fileStore.test.ts:1]). Its erratum corrects the guard's direction and never
says the freeze was lifted. Every other freeze site in the tree — `fileStore.ts:700`,
`lockPresence.ts:10`, `inspectLock.ts:10`, `lockPresence.test.ts:5`, `sweepRuns.test.ts:673` — got
that sentence explicitly. Cosmetic inconsistency in an otherwise uniform convention.

**M-8. Observation, orthogonal to these commits: the hedge's real residual is pid-namespace, not
coercion. [read-only argument]** `isProcessActive` asks *this* kernel about a pid. A holder that is
alive in another pid namespace (a container writing to a shared run directory) reads as dead here
and its lock is reclaimable — a genuine live-holder reclamation, unreachable through the coercion and
predating point B entirely. Named only so a future reader does not mistake Mi-2's "no LIVE lock
becomes reclaimable this way" for a claim about all paths; the words "this way" are doing correct
work.

**M-9. Observation: no live source comment names a stale byte baseline. [measured]** `970` / `1558`
appear only in the SDD review documents under `.superpowers/sdd/2026-08-07-pkg2-data-loss/`
(`E1-review-fix2/3/4`, `pointB-review*`), which are dated artifacts. Nothing in `src` or `tests` tells
a reader the function is frozen at a number. Consistent with the brief's warning; nothing to fix in
code.

---

## Verification performed

All mutation work was done in `git clone --local` copies under the session scratchpad. The reviewed
checkout was never written to: HEAD stayed at `9a62f31` throughout, and at the end
`rtk proxy git -C /Users/biran/code/skills/loop/ccloop status --porcelain` = **0 bytes**,
`git diff` = **0 bytes**, `git diff --cached` = **0 bytes**.

1. **Baseline, unfiltered.** `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run` redirected
   to a file and read back in full (167 lines). First line `RUN v2.1.9
   /Users/biran/code/skills/loop/ccloop`. `Test Files 34 passed (34)`, `Tests 601 passed (601)`, no
   `skipped` line, `TEST_RC=0`.
2. **Redline size.** `awk` extraction from the signature line to the first column-0 `}`:
   **2515 bytes / 48 lines**; `grep -c '^async function tryRecoverStaleOwnerTransferLock'` = **1**.
   The brief's number reproduced independently.
3. **Guard-revert mutation (clone `c1`, HEAD `9a62f31`).** Full suite, unfiltered, first line
   `RUN v2.1.9 …/scratchpad/clones/c1`. `Tests 2 failed | 599 passed (601)`, `TEST_RC=1`; failures =
   A's test + the ruling-10 flake. Failure text captured verbatim.
4. **A's three-assertion probe (clone).** Separate test file, same fixture, all three outcomes
   recorded independently: `lock=REJECTED ENOENT epoch=2 pending=REJECTED ENOENT`.
5. **Mi-2 coercion, pure semantics.** `node` script over 11 JSON shapes; results in S-8.
6. **Mi-2 coercion, end to end (clone).** 4 tests, all passing: `isProcessActive(999999) === false`;
   array holder → lock deleted by `readOwnerRecord`; object holder → lock survives; `inspectLock`
   reports `state: "dead"` for the array holder.
7. **Restoration proofs.** After each mutation, `cat pristine > target` / `/bin/rm -f` (never the
   `-i` aliases), then in the clone: `rtk proxy git diff > f; wc -c f` → **0**, and
   `rtk proxy git diff --cached > f; wc -c f` → **0**, three separate times (after 3, after 6, after
   the build). `git status --porcelain` in the clone showed only `?? node_modules`, which is the
   symlink I created to the checkout's `node_modules` so vitest could resolve — my scaffolding, not a
   repo change. (It shows as untracked in the clone and not in the checkout because `.gitignore` line
   23 is `node_modules/`, whose trailing slash does not match a symlink.)
8. **typecheck / build.** Both run **in the clone**, not the checkout: `TYPECHECK_RC=0`,
   `BUILD_RC=0`. `dist/` removed with `/bin/rm -rf`, restoration re-proved by the same byte counts.
9. **Diff shape.** `git show --numstat` for all five; `git show -U0` filtered for non-`//` changed
   lines on the four comment commits → empty for each.
10. **C's 14 lines.** Extracted mechanically from `git show -U0 e22d1ea`, each searched as a fixed
    substring across `src` + `tests`; 12 single hits, 2 split halves located by hand.
11. **Width.** Character-count (`perl -CSD`, not byte-count `awk`, which inflates `—` and `§`) over
    the six touched files at `e22d1ea^`, `e22d1ea`, `29aa60e` and HEAD; per-file maxima at HEAD.
12. **T2's fixtures.** 26-line ranges extracted from both tests, `wc -c` = 1171 each, `diff` clean;
    the shared assertion counted with `grep -c -F` = 2.
13. **Tree sweep for point-B-falsified statements.** `stealer|steal`, `fro(ze|zen)|freeze`,
    `hasStagedArtifacts`, `pid !== null &&`, `fall(s)? through|fell through`, `skip*` + guard/liveness/pid,
    `staged artifact`, every `tryRecoverStaleOwnerTransferLock` reference, every `parsePid` reference,
    all `point B` mentions — each hit read in context.
14. **`open(lockPath,"wx")` absence.** `grep -F '"wx"' src` → comment lines only; `grep -F 'open(' src/persistence/fileStore.ts`
    → the only call is `open(stagingPath, "w")`.
15. **Ruling 83's commit did not touch `parsePid`.** `git show 9dd044d -- src/persistence/fileStore.ts`
    filtered for `parsePid` on `+`/`-` lines → empty. Mi-2's "parsePid predates point B" confirmed.
16. **Coverage gap for the coercion.** No test anywhere sets `holderProcessInstanceId` to a non-string
    (`grep -rnE 'holderProcessInstanceId: *\[' tests` → empty).

Not measured, and I say so rather than implying otherwise: **linux**. Everything above is darwin
(`Darwin 24.6.0`). I did not start a container runtime; nothing in these five commits is
platform-sensitive (no production logic changed), so a linux run would add nothing about *these*
commits — but the brief's standing note holds and I have not widened it.

---

## Recommendations

Ordered by value. None of these are dispositions — the human rules.

1. **Correct I-1 in place.** `parsePid has two other callers (unlock, sweep)` → one other caller
   (`src/unlock/inspectLock.ts`); the sweep has none by design (board C-a, presence-only). Ruling 94
   already authorises this comment; this is a factual repair inside it, and the house rule's appended
   `*** ERRATUM (…) ***` form applies if the original wording is to be preserved.
2. **Say what I-2 measured, in Mi-2's own erratum.** Replace the bare "shared with E1" with what
   sharing costs there: on `inspectOwnerTransferLock` the same coercion returns `dead` instead of
   `unrecognized-holder`, so `unlockCommand`'s `dead` branch deletes without `--force`. State it as a
   measurement and leave the decision to the human — E1 is out of authorisation and I propose no code
   change to it.
3. **Finish B's job (I-3).** Append errata to the two remaining sites —
   `tests/unlock/inspectLock.test.ts`'s mutation-C body comment (and note the test name still encodes
   the old direction; renaming it needs a ruling-88 naming, an erratum does not) and
   `src/unlock/inspectLock.ts`'s `which skips the liveness guard entirely` sentence. Both files are
   already inside the ruling 91/93 authorisation.
4. **Add the missing criterion for the coercion.** No test pins that `["pid:<dead>"]` reaches
   `safeUnlink`, so nothing would go red if someone "tidied" `parsePid` into
   `typeof x === "string" && …` or the reverse. Ruling 4 permits adding it without a further ruling,
   and it would convert Mi-2 from a note into an enforced fact. It should assert the current
   behaviour, not the desired one, and say so.
5. **Tighten M-3's set description** with a "and whose holder is not a live pid" qualifier at both
   sites, so the erratum stops promising `--force` for a cell the same file refuses it on.
6. **M-5:** consider a positive control in A, so its green is evidence rather than absence.
7. **M-6:** a one-line back-reference on the richer near-duplicate.
8. **M-1, M-2, M-4, M-7:** bookkeeping. Worth a single sweep, not a round each.

---

## Assessment

These five commits are, on the evidence I gathered, **substantially better than the round they were
cleaning up after**. Every headline claim I could check by measurement held: A goes red on exactly
its own claim and is the only test in 601 that does (S-1), its failure message names the cause (S-2),
and the revert it catches silently finalizes a transfer behind a live holder (S-3). C's restoration
is exact to the line — 12 verbatim, 2 provable wrap splits, width back to the pre-`e22d1ea` figure
(S-5, S-6). T2's three measurements are all reproducible (S-7). Mi-2 found a real widening of ruling
83's "ONLY condition" and its bounded hedge survived a deliberate attack (S-8, S-9). All four comment
commits are mechanically comment-only, and three of them have zero deletions (S-10). Nothing is
vacuous; nothing became newly silent; no production logic moved.

What I found is a **consistent pattern rather than isolated slips: the round's own bookkeeping is
less rigorous than its work.** Mi-2 states a checkable fact about the codebase that is wrong
(I-1) and understates the E1 consequence it does mention (I-2). B claims a full-tree sweep found the
remaining stale comments, and I found two more with the same method — one of them flatly false, in a
test name, in a file B edited (I-3). C's commit message misattributes its own measurement (M-1) and
leaves the second splice defect where it fell (M-2). In a package whose thesis is *an integrity claim
with nothing enforcing it is the defect*, these belong on the record: they are the same defect shape
at one remove, in the messages and errata rather than in the code.

None of it rises to Critical, and none of it costs data. The one path with a real behavioural edge —
the coercion reaching `ccloop unlock`'s unforced-delete branch — is bounded by a dead-pid gate, needs
an externally forged lock, and sits in a component this round has no authorisation over.

I do not declare point B passed, do not declare C-1 closed, and do not say whether E1 passes; those
are the human's to rule. My recommendation is that **I-1, I-2 and I-3 be closed before this round is
considered finished**, since all three are comment repairs inside authorisations that already exist
and all three concern statements a future reader would act on.
