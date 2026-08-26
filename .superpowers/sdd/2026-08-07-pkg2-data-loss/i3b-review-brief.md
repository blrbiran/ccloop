# Review brief — human ruling 106(b): the I-3(b) round, plus the two commits of ruling 105 that were never reviewed

You are an independent reviewer. You did not write any of this. **Nothing in this brief is
established fact — every number in it is the controller's, and the controller has been wrong before
in exactly this way.** See the warning at the end of this section before you trust a single figure.

⚠️ *** **THE PREVIOUS BRIEF IN THIS PACKAGE MISLED ITS REVIEWER.** *** It told the reviewer not to
compare against an earlier section's figures, claiming they used an irreproducible metric. That
instruction was **false**: the controller had measured with `awk length()`, which counts BYTES on
macOS regardless of `LC_ALL`, and then published an accusation against its own earlier work. The
reviewer inherited the false premise from the brief and only caught half of it. Ledger §38 records
the correction. **Treat this brief the same way: as a set of claims to check, not a set of givens.**

---

## Range

```
BASE_SHA = 979f5f07cd6667e976e16993b0acfad5b72ecbd5
HEAD_SHA = 565aaae   (run `git rev-parse HEAD` yourself; do not trust this short sha if it differs)
```

**Five commits are the SUBJECT of this review** (find them by subject line, never by count):

| | subject line | why in scope |
|---|---|---|
| 1 | `docs(comments): close every site the Minors round left standing (I-1, I-2, I-4, I-5, Mi-1, Mi-2, human ruling 105)` | ruling 105's work, **never independently reviewed** |
| 2 | `test(fileStore): enforce the "one reader" premise the counting test rests on (Mi-3, human ruling 105)` | same |
| 3 | `feat(fileStore): tell the caller WHY a stale transfer lock could not be reclaimed (I-3(b), human rulings 106/107)` | this round |
| 4 | `fix(resumeLoop): report an unattributable transfer lock as itself, not as a CAS failure (I-3(b), human ruling 106)` | this round |
| 5 | `fix(runLoop): keep an unattributable transfer lock contained as a recorded contention (I-3(b), human ruling 106)` | this round |

The other commits in the range are ledger / handoff / spec / plan **documents**. They are context,
**and their factual claims are fair game** — this package has shipped false claims in its own ledger
before. But do not spend the review on prose style.

---

## The binding rulings this round claims to encode

- **Human ruling 106(a)** — opens I-3, and is a **NEW authorisation** for the redline function
  `tryRecoverStaleOwnerTransferLock`. Ruling 50 froze it byte-for-byte; ruling 83 lifted that **only
  for the change ruling 83's own wording describes**. A return-type change is not in that wording,
  so 106(a) is what authorises it. ⚠️ **The authorisation does not extend past the return type and
  the sites that consume it.**
- **Human ruling 107** — names **exactly one** existing criterion the implementer may rewrite:
  `tests/persistence/fileStore.test.ts`, `it("keeps a malformed lock without staged artifacts
  non-recoverable")`. Ruling 88's conditions apply: whole-criterion rewrite, **no relaxation**, and
  the rewrite must say which ruling it encodes.
- **Human ruling 83** (unchanged, and this round claims not to touch it): the ONLY exit that may
  delete an existing lock is "contents parse + `holderProcessInstanceId` is `pid:<n>` + that process
  is not alive". Every other exit fails closed.
- **Human ruling 86**: liveness here is the **two-state** `isProcessActive`, not E1's three-state
  classifier.

---

## What the implementer claims — treat each as a claim to check

1. **Ruling 83's fail-closed semantics are unchanged cell for cell.** No exit gained or lost the
   right to delete a lock. ⚠️ **This is the single most important thing to falsify.** A three-state
   return value touching a fail-closed function is exactly where a new delete path could hide.
2. **`OwnerTransferLockBusyError`'s message text is byte-for-byte unchanged**, on the argument that
   for a live holder "owner transfer already in progress" is TRUE, and was only ever false for an
   unattributable lock.
3. **Exactly one existing criterion was rewritten** (ruling 107's), and the rewrite **strengthens**
   rather than relaxes. Everything else is added, not changed. ⚠️ Check the whole diff for a second
   changed criterion.
4. **The new error class is a SIBLING, not a subclass**, per the doctrine written above
   `OwnerTransferLockBusyError`. Two consumer sites re-decide **by not changing** — the reconciliation
   retry and `persistOwnerTransfer`'s retry — and both carry a comment saying the lost `instanceof`
   match is deliberate. ⚠️ **Are there consumer sites the implementer missed?** The implementer
   claims 5 call sites of `acquireOwnerTransferLock`, of which 3 swallow the error (recorded, not
   fixed). Verify that census yourself.
5. **Two measurements justify the two added branches**, both claimed as observed, not reasoned:
   - without the `resumeLoop` branch, `resume_denied`'s detail read
     `claim CAS failed: OwnerTransferLockUnattributableError: …` — a CAS that was never evaluated;
   - without the `runLoop` branch, the run ended `failed` instead of `exhausted`.
   ⚠️ **Reproduce at least one of these**, or say you did not.
6. **Five mutations each turned their NAMED criterion red** (M1, M2, M3, M4′, M5 — ledger §40).
   ⚠️ The ledger admits the spec's original M4 **proved nothing** (it left the criterion green,
   because the acquire loop's second iteration still threw the busy error). **Check whether any of
   the five surviving mutations has the same hollowness.**
7. **The published-comment discipline was honoured**: the redline function's existing comment block
   is verbatim, with an appended named erratum, and no in-place edit of published text.
8. **The two ruling-105 commits (1 and 2 above) are correct** — that is precisely what was never
   independently checked.

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
5. **Never filter a verification run** (`grep`/`tail`/`head`/`sed` alike; a pipe also steals the exit
   code). Redirect to a file, read the whole file back, check vitest's first `RUN` line points at the
   checkout you meant. Run tests as
   `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run`.
   ⚠️ **rtk's filter layer will lie to you**: it prints `ok` for an empty `git status --porcelain`,
   reports a 0-byte `git diff` as 1 byte, truncates long grep output to `[+N more]`, and errors on
   some regexes. Any restoration proof or byte comparison must go through `rtk proxy git …`
   redirected to a file, then `wc -c`.
6. **Local machine and network.** You **MAY** use this machine's container runtime and pull public
   images to take a measurement. ⚠️ **Measured at dispatch, not assumed: OrbStack's daemon is DOWN**
   (`dial unix /Users/biran/.orbstack/run/docker.sock: connect: no such file or directory`). You may
   start it. You **MUST** report every such action. You **MUST NOT** install anything into this
   repository, modify machine configuration, or touch anything belonging to another running line of
   work.
7. **A bad probe proves nothing** — not absence, not violation. Check your probes before believing
   them. *** This package has now been burned three times: `timeout` not existing on macOS read as
   "no container runtime"; `awk length()` counting bytes read as characters, which produced a false
   published accusation; and a mutation that proved nothing while looking like a proof. ***
8. *** **A MUTATION IS NOT A PROOF UNTIL YOU HAVE SEEN IT GO RED.** *** Applies to your own
   mutations too.
9. Every finding needs a **constructible scenario**, and code references must be **anchored** by
   verbatim block plus a hit count, **never by line number** — line numbers in this package rot fast,
   and they moved again this round.
10. **A finding and its disposition are two different things.** Report it either way, saying which.
11. ⚠️ **KNOWN FLAKES — FOUR, NOT TWO.** Under load these time out at `Test timed out in 5000ms`;
    they are not regressions and are not to be investigated:
    - `run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
    - `persists phase usage evidence…`
    - `runLoop > accounts an execute timeout that rejects after the abort as exhaustion`
    - `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting
      stale run data`
    A red run whose **total duration is ~29s** rather than the usual **17–22s** is the load
    signature. Re-run the single file before concluding anything.

---

## Baseline measured on this checkout immediately before dispatch

- *** **`35 files / 609 tests` passed, 0 skipped** ***; `TEST_RC=0`; `typecheck` rc=0; `build` rc=0;
  duration 20.64s; vitest's `RUN` line pointed at `/Users/biran/code/skills/loop/ccloop`.
- Working tree clean: `git status --porcelain` = **0 bytes**, `git diff` = **0 bytes**,
  `git diff --cached` = **0 bytes**.
- *** **The criterion baseline is 609.** *** 604, 603, 602, 601, 600 are all dead numbers.
- *** **Redline function `tryRecoverStaleOwnerTransferLock` = 4496 bytes.** *** ⚠️ **THE METRIC,
  because omitting it cost the previous session a dead end**: `src/persistence/fileStore.ts`, the
  whole-line range **1001–1075 inclusive, including the trailing newline of line 1075**
  (`sed -n '1001,1075p' … | wc -c`). A brace-matched slice of the same function measures one byte
  less; the difference is that newline and nothing else.
  ⚠️ **The old 3185 baseline is VOID** — ruling 106(a) authorised the change. Signature hit count = 1.
  Return type is now `Promise<StaleOwnerTransferLockOutcome>`.
- ⚠️ **darwin only.** The suite is known red on linux (`5 failed / 593 passed`, measured by a
  previous reviewer on an unrelated round). **None of this round has been run on linux.** Do not
  repeat that claim more broadly than it was made.

---

## Out of scope — recorded elsewhere, not yours to re-raise

- **I-3(a)** — `recoverInterruptedOwnerTransfer`'s bare `catch { return; }`. Recorded, deliberately
  not fixed: it is outside ruling 106's wording. **The new error class is swallowed there too**, so
  this fix does not reach the `readOwnerRecord` path. Naming a NEW consequence of it is in scope;
  re-raising the swallow itself is not.
- **`leaseHeartbeat.ts`'s two swallows** — found and recorded this round, deliberately not fixed,
  same reason. Same rule as above.
- **E1's I-2 cell** (array holder ⇒ `unlockCommand` deletes without `--force`), **`ccloop ls`
  reporting locks** (ruling 85), **package 1**, **linux**, and **every commit at or below
  `979f5f0`**.
- *** **Do not declare point B passed, C-1 closed, or E1 anything** *** — rulings 101/102/103 already
  ruled all three. Re-ruling them is not yours.

---

## Deliverable

Write your report to `.superpowers/sdd/2026-08-07-pkg2-data-loss/i3b-review.md` (that directory's
`.gitignore` is `*` — it needs `git add -f`; **do not commit it yourself**). Sections:
Strengths / Critical / Important / Minor / Verification performed / Recommendations / Assessment.
Return the same content as your final message.
