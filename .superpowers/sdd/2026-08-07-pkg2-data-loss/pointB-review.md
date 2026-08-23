# Point B review — `9dd044d` (the redline change) and `e22d1ea` (the comment round)

Reviewer seat: fresh and independent. Range: exactly `9dd044d` and `e22d1ea`, parent `1bd6f06`.
`61f3f50` / `926d6dd` read as context only.

**The red line is dead and I treated it as such.** `tryRecoverStaleOwnerTransferLock` is **1558
bytes** on `926d6dd` (measured), against **970** on both `86d3bd6` and `1bd6f06` (measured). Every
comment I hit that says the function is frozen is reported below as stale, not obeyed.

Every finding is tagged **[measured]** or **[read-only]**. All mutation work happened in a
`git clone --local` copy; both trees are proven restored at the end.

---

## Strengths

**S-1 — The BUILD_B′ exit table reproduces exactly, on both arms.** [measured]
I drove the real function through its only public entry (`readOwnerRecord` → the EEXIST branch of
`acquireOwnerTransferLock`) with **25 distinct lock-content shapes**, once against `926d6dd` and
once against the same clone with `src/persistence/fileStore.ts` restored to `1bd6f06` (redline back
at 970 bytes, `diff` rc=0 against the blob). Every cell of `pointB-ruling-package-v2.md` §3's
BUILD_B′ column reproduces:

| lock contents | pre-B (`1bd6f06`) | post-B (`926d6dd`) |
|---|---|---|
| `pid:<self>` (alive) | refused | refused |
| `pid:999999` (dead) | **reclaimed** | **reclaimed** ← the live control: the probe can still print STOLEN |
| `not-json\n` + staged artifacts | **reclaimed** | refused |
| `not-json\n`, no staged artifacts | refused | refused |
| `{"acquiredAt":"x"}` (no holder) | **reclaimed** | refused |
| holder `pid:<pid>:<timeOrigin>` strong form | **reclaimed** | refused |
| `pid:0` | refused | refused |
| `pid:99999999999999999999` | refused | refused |
| `""`, `null`, `0`, `[]`, `"pid:1"`, `true` | **reclaimed** | refused |
| holder `123`, `{a:1}`, `true`, `""` | **reclaimed** | refused |
| trailing junk after a valid object | **reclaimed** | refused |
| `{"__proto__":{"holderProcessInstanceId":"pid:999999"}}` | **reclaimed** | refused |

Implementer claim 1 verified independently: both failure-open exits are closed, and `pid:0` /
overflow pid are **identical on both arms** — point B is neither their cause nor their fix, exactly
as the commit message says. The dead-pid row proving STOLEN is still printable on the post-B build
means the refusals above are not false negatives.

**S-2 — `isProcessActive` cannot throw.** [measured]
Landing point 2's concern is unreachable. `process.kill(pid, 0)` probed with
`0, 1, 999999, 2^31-1, 2^31, 2^32-1, 1e20, MAX_SAFE_INTEGER, Infinity, NaN, -1, 1.5`: every throw
is an `Error`/`TypeError` with a readable `.code`, all of them caught inside the function, all
non-`ESRCH` collapsed to `true` (fail closed). No input escapes. So the new bare `catch { return
false; }` only ever swallows `JSON.parse` and the property read on `null`/`undefined`, not a
liveness failure. Anchor, hits=1 in `src/persistence/fileStore.ts`:
`    if (pid === null || isProcessActive(pid)) {`

**S-3 — The removed `pathExists` calls left nothing dead and had no side effect.** [measured]
`pathExists` in `src/persistence/fileStore.ts` still has 2 call sites (the `writeJsonFile` retry and
`recoverInterruptedOwnerTransfer`'s marker probe). `ownerPendingPath`, `transferPendingPath`,
`transactionMarkerPath` each still have 6 references in `src/`. `pathExists` is module-private and
not exported, so no test could have been patching it. It is a `stat`; removing the reads changes no
filesystem state and no ordering that anything else observes.

**S-4 — The escape hatch works end to end. I am the first to run it against a real bad lock.**
[measured] I built the exact stuck scene (owner record + all three staged artifacts + a
`not-json\n` lock), then drove the real `main()` from `src/cli.ts`:

```
--- ccloop unlock <runDir>
refused  lock unreadable: Unexpected token 'o', "not-json\n" is not valid JSON
         to override: ccloop unlock <runDir> --force --expect 60498eba…faf33
  RC=1
  independently computed sha256 of the file's bytes = 60498eba…faf33   (matches)
--- ccloop unlock <runDir> --force --expect 0000…0000
refused  --expect does not match the lock on disk
  RC=1
--- ccloop unlock <runDir> --force --expect 60498eba…faf33
removed  forced past unreadable lock contents
  RC=0
--- readOwnerRecord again
  epoch=2 pid=pid:67890      ← the blocked transfer completed
```

The refusal hands over a working command line, the digest is the digest of the bytes, a wrong
credential is refused, and the run recovers. The implementer's reliance on this hatch is justified.

**S-5 — `e22d1ea` really is comment-only.** [measured] `git show e22d1ea -U0`: **80 added + 14
removed = 94 changed lines across 6 files** (43/7, 3/0, 16/1, 13/4, 3/1, 2/1). Filtering added and
removed lines for anything that is not blank and does not start with `//` yields **0 and 0**.
Claim 5 verified exactly, including the number.

**S-6 — Suite, typecheck and build.** [measured] On the clone (byte-identical to `926d6dd`):
`34 files / 600 tests`, **0 skipped**; the single failure is the allowed flake
`evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the
spawned pid` (timeout), and it passed on a later run. `npm run typecheck` rc=0, `npm run build`
rc=0. The vitest `RUN` line was checked to point at the clone.

**S-7 — The rewrites do tighten, and the new assertion is real.** [measured] `toBe("not-json\n")`
is strictly stronger than the old `toContain`. And the "staged transfer was never finalized"
assertion is not passing for an unrelated reason: with the assertion order swapped so it runs first,
under a mutant that restores the steal it fails with
`promise rejected "ENOENT…" instead of resolving` — the pending file really is consumed by
`finalizePendingOwnerTransfer` when the lock is stolen, so its presence really does witness
"never finalized". Claim 4 verified.

---

## Critical

### C-1 — Half of human ruling 83 shipped with **zero** test coverage, and reverting it silently restores theft of a **live** holder's lock

[measured — the strongest finding in this review]

Ruling 83 names two failure-open exits: *"Everything else (parse failure; **parse success with a
missing or non-`pid:<n>` holder**) returns `false` and does not delete."* The commit closes both.
Only one of them is pinned by anything.

I built two single-hunk mutants of `926d6dd`'s `fileStore.ts` and ran the **full** suite on each:

| mutant | what it reverts | full-suite result |
|---|---|---|
| **M1** | the guard only: `pid === null \|\| isProcessActive(pid)` → `pid !== null && isProcessActive(pid)` | **`34 files / 600 tests` — ALL PASS, rc=0** |
| **M2** | the `catch` only: back to the `hasStagedArtifacts` branch | `2 failed / 598 passed` — exactly the two rewritten tests |

M1 is not a semantic no-op. Probed on the M1 build through the same public entry:

```
M1PROBE|strong form LIVE self       |epoch=2 lockDeleted=true    ← a LIVE holder's lock, deleted
M1PROBE|object with no holder       |epoch=2 lockDeleted=true
M1PROBE|holder pid:<self> alive     |epoch=1 lockDeleted=false
M1PROBE|unparseable not-json        |epoch=1 lockDeleted=false
```

So: a one-token edit inside the redline function restores the exact defect
`tests/persistence/fileStore.test.ts`'s own mutation-C test exists to catch — the strong-form holder
turning the function into an unconditional lock stealer — and **not one of 600 tests notices**.

Human ruling 87 budgeted exactly two test rewrites, and both were spent on the parse-failure exit
(M2 reddens both, M1 reddens neither). Nobody checked that the two named tests covered both exits.
The consequence is that the very guard whose absence this package spent months documenting is now
protected only by the comment above it.

**Constructible scenario.** A future contributor reads the file's own advice — "the deliberately
weak `pid:<pid>` form … stay exactly as they are" — decides the `pid === null ||` half is a
defensive redundancy left over from the rewrite (parsePid "always" returns a pid for a lock this
code wrote), simplifies it back to `&&`, runs `npm test`, sees 600 green, and ships. The next
externally-corrupted or foreign-format lock is deleted out from under a live holder.

**This is a finding, and its disposition is open.** The fix is a third test inside the redline
function's own class — no acquire-path, `release()`, E1 or sweep change needed — but adding a test
beyond ruling 87's two named ones is a human call, which is why I am reporting rather than
proposing. Anchors, hits=1 each in `src/persistence/fileStore.ts`:
`    if (pid === null || isProcessActive(pid)) {` and
`const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;`

---

## Important

### I-1 — The comment round missed six stale sites, in three files it never opened — including a fourth verbatim copy of the reversal it set out to correct

[measured, by full-tree text sweep for `hasStagedArtifacts`, `staged artifacts`, `open point B`,
`lock stealer`, `ruling 50 froze`, `froze byte-for-byte`, then reading each hit]

`e22d1ea`'s own thesis is that a wrong comment in these files is a defect. Six sentences that point
B turned false were left standing. All anchors below are hits=1 in their file.

1. `tests/unlock/inspectLock.test.ts` — **the fourth copy of the "direction reversed" claim**, in
   the same words the commit corrected in three other places:
   `tryRecoverStaleOwnerTransferLock degenerates into an unconditional lock stealer.`
   The commit corrected `parsePid`'s comment, its enforcing test, and `inspectLock.ts`. It missed
   the test file for `inspectLock.ts`, where the identical claim sits in the module header.
2. `tests/unlock/inspectLock.test.ts` — names a deleted variable and a set that is no longer a
   singleton: ``` `{not json` with no staged artifacts is the ONE ``` (…"shape the normal transfer
   path gives up on for good (JSON.parse throws, hasStagedArtifacts is false…)"). Post-B there is no
   `hasStagedArtifacts`, staged artifacts are irrelevant, and the permanently-stranded set is now
   every non-`pid:<n>`-dead-holder shape — dozens of cells, not one.
3. `tests/persistence/fileStore.test.ts` —
   `tryRecoverStaleOwnerTransferLock into the` `` `catch` `` `branch that unlinks a live holder's lock.`
   That branch unlinks nothing now.
4. `tests/persistence/fileStore.test.ts`, inside ERRATUM 1 of the C-1 fixture block —
   "…landed in tryRecoverStaleOwnerTransferLock's `catch` branch, `which never calls` /
   `isProcessActive and unlinks a LIVE holder's lock whenever staged artifacts exist. ***`"
5. `tests/persistence/fileStore.test.ts`, ERRATUM 2 of the same block —
   `the` `` `catch` `` `branch itself, which is open point B and was not touched, and`
   Point B is ruled; the branch **was** touched. This is in the same file, ~640 lines below a
   paragraph the commit *did* correct.
6. `src/unlock/unlockCommand.ts`, module header — the same "the ONE cell" premise as item 2, in
   production code:
   ``a `{not json` lock with no staged artifacts is stranded on disk forever by the``
   …"normal transfer path, and this command refuses that same shape. That intersection is the
   entire reason --force exists." The "with no staged artifacts" qualifier is dead, and the
   intersection is no longer one cell — it is now most of the table, which if anything strengthens
   the case for `--force` and should be said rather than left implied by a false premise.

Items 3–5 are all in `tests/persistence/fileStore.test.ts`, a file `e22d1ea` edited. The round
corrected one comment there and left three others in the same file false.

**Disposition note:** items 1–2 sit in E1's test file and item 6 in E1's production file.
Correcting a comment in either does not change `ccloop unlock`'s behaviour, but E1 is out of this
round's authorisation, so I am recording them rather than proposing edits. Items 3–5 are squarely
inside this round's territory.

### I-2 — The commit message's own method claim is false

[measured] `e22d1ea` says: *"Nothing is silently overwritten. Every claim that was true under human
ruling 50 is kept verbatim and followed by an ERRATUM naming ruling 83."*

**14 comment lines were deleted**, and none of the 14 survives verbatim anywhere in the six files at
`926d6dd` (checked by substring search of each removed line against the post-commit text of all six
files: 14/14 GONE). In three of them the correction is an **in-place rewrite with no ERRATUM marker
at all** and the prior wording preserved nowhere:

- `src/persistence/fileStore.ts`, above `OwnerTransferLockRecord` — was *"which human ruling 50 froze
  and which DELETES what it reads — a command whose whole job is to refuse must not call it."*, now
  `which human ruling 50 froze (a freeze human ruling 83 has since lifted, for point B alone) and`
  (hits=1).
- `tests/sweep/lockPresence.test.ts` — `which human ruling 50 froze when` (hits=1) replaced the
  original clause in place.
- `tests/sweep/sweepRuns.test.ts` —
  `function human ruling 50 froze at the time (changed since, for point B alone, under human`
  (hits=1), likewise.

In two more (`parsePid`'s comment and the mutation-C test header) the deleted sentence is restated
*inside* the new ERRATUM rather than kept verbatim above it — defensible, but not what the commit
says it did.

This matters beyond bookkeeping: `tests/persistence/fileStore.test.ts` states the house rule as
*"this repository does not silently overwrite what it once did"*, and the round that invokes that
rule is the round that broke it. It is also why I did not accept any other self-report in this
commit without re-measuring.

### I-3 — The permanent stall is silent where a caller reads, and actively misdescribed where it throws

[measured] Landing points 4 and 8. Two surfaces, both wrong in the point-B class:

**(a) `readOwnerRecord` returns a stale record with no error whatsoever.** In my end-to-end scene
(staged transfer + `not-json\n` lock), step 1 printed `epoch=1 pid=pid:12345` and **did not throw**.
Under `1bd6f06` the same call returned `epoch=2` — the transfer completed. So post-B the caller
receives the *pre-transfer* owner record, indefinitely, with no signal distinguishing "no transfer
pending" from "a transfer is staged behind a lock that will never clear without a human".

The amplifier is `recoverInterruptedOwnerTransfer`'s bare swallow (hits=1 in
`src/persistence/fileStore.ts`): `    } catch {` / `      // Could not acquire: another process
holds a live lock (OwnerTransferLockBusyError)` … `      return;`. That `catch` is **not** part of
this diff and its comment reasons explicitly from an assumption point B just invalidated — *"the
read must not surface a new failure mode … same as today's 'busy → skip recovery' behaviour"*. That
was sound when "busy" always meant a live holder that would eventually exit. Point B made "busy"
also mean *forever*, and turned a transient swallow into a permanent one. This is the project's
signature defect — an error path quietly becoming a different, less useful answer — and this change
is what made it reachable.

**(b) The one loud surface tells the operator something false.** Measured by catching the real
error off `writeOwnerTransferArtifacts` on the same stuck directory and formatting it exactly as
`resumeLoop` does:

```
resume_denied detail would be: owner-transfer lock busy: OwnerTransferLockBusyError: owner transfer already in progress
```

No transfer is in progress. The message names no holder, no reason, and — critically — no
`ccloop unlock`. `new OwnerTransferLockBusyError("owner transfer already in progress")` has hits=3
in `src/persistence/fileStore.ts`. `ccloop resume` retries the bounded number of times, then denies
with that text; `ccloop sweep` does emit
`note  <path>  owner_transfer_lock_present  a transfer lock is on disk; this sweep does not read it
and makes no claim about whether its holder is alive` [read-only, from source], which is the only
place an operator is pointed at the lock at all — and it is a different command from the one that
failed. (`ccloop ls` is human ruling 85, out of scope; I did not look.)

**Disposition:** the message text lives in `acquireOwnerTransferLock`, which is out of
authorisation. The swallow lives in `recoverInterruptedOwnerTransfer`, also outside the redline
function. I am reporting both, proposing neither.

### I-4 — The two rewritten tests are a duplicate pair

[measured, twice: by containment and by mutation]

Extracting both `it(...)` blocks by name and stripping comments, their bodies differ **only** in the
assertion block; **lines 2–28 of each — the entire fixture and the trigger `readOwnerRecord(runDir)`
— are byte-identical.** Assertions:

| | `keeps a malformed lock non-recoverable even when staged artifacts are present` (hits=1) | `leaves the lock on disk when malformed staged state names no dead holder` (hits=1) |
|---|---|---|
| pre | — | `readFile(lock).resolves.toContain("not-json")` — trivially true, it was just written two lines above |
| post | `epoch===1`, `pid:12345`, `readFile(lock).resolves.toBe("not-json\n")`, pending still contains the reason | `readFile(lock).resolves.toBe("not-json\n")` |

T2's only post-condition is **verbatim one of T1's four**. By containment, no mutation can redden T2
without reddening T1. Confirmed empirically: M2 reddens both, M1 reddens neither, and no other
mutation separates them.

Human ruling 87 authorised two whole rewrites; what landed is one test and a copy of a quarter of
it. The pre-existing sibling `keeps a malformed lock without staged artifacts non-recoverable`
(hits=1) is **not** a duplicate — it enters through `writeOwnerTransferArtifacts` and asserts
`OwnerTransferLockBusyError`, and paired with T1 it now demonstrates that staged artifacts no longer
change the answer, which is precisely ruling 83's point. That pair is good. T2 adds nothing to it.

---

## Minor

**Mi-1 — Neither rewritten test's failure message names the cause.** [measured] Under M2 they report
`AssertionError: expected 2 to be 1` and `promise rejected "Error: ENOENT…" instead of resolving`.
Neither says "the lock was stolen", neither says "ruling 83". This is exactly the standard the same
file holds *itself* to ~2,400 lines away, complaining that three existing tests "report it as
'renameCount 4 instead of 2' … not one of them names the cause". In T1 the epoch assertion fires
first, so the most diagnostic assertion (the lock file) never runs.

**Mi-2 — A holder that is not of the form `pid:<n>` still reaches `safeUnlink`.** [measured] The
cast `as Partial<OwnerTransferLockRecord>` (hits=1) promises `string | undefined`; `JSON.parse`
delivers any JSON value; and `parsePid(processInstanceId: string)` (hits=1) applies
`/^pid:(\d+)$/.exec(...)`, which coerces its argument with `String()`. Measured on `926d6dd`:

```
holder ["pid:999999"]      → RECLAIMED=true
holder [["pid:999999"]]    → RECLAIMED=true
holder ["pid:<self>"]      → RECLAIMED=false   (alive → still refused)
```

**Not a regression** — identical on `1bd6f06` — and **bounded**: the pid must still be dead, so no
live holder's lock is stolen through it. But two things follow. First, the new comment's *"The ONLY
condition that may delete an existing lock is: the contents parse, holderProcessInstanceId has the
form `pid:<n>`"* (hits=1) is measurably not what the code enforces; a doubly-nested array is a lock
nobody can attribute, and the comment right beside it says such a lock "may not be stolen". Second,
`src/unlock/inspectLock.ts` has the same coercion (`parsed.holderProcessInstanceId ?? ""` then
`parsePid(holder)`), so both readers share the gap — recorded as an observation, since E1 is out of
authorisation. Also unchanged and unremarked: `pid:00999999` reclaims (`\d+` accepts leading zeros).

**Mi-3 — `e22d1ea` introduced the only two over-long comment lines in the six files it touched.**
[measured] Before the commit, the widest `//` line across all six files was **103** chars and none
exceeded 110. After: `src/persistence/fileStore.ts` has one at **152** ("…must not call a reader
that deletes at all. Sharing the shape is what keeps the two readers describing one file.") and
`tests/sweep/sweepRuns.test.ts` one at **125**. There is no eslint/prettier/editorconfig in the
repo, so this is convention rather than rule — but it is the mechanical fingerprint of I-2: text
spliced in place without rewrapping the paragraph.

---

## Verification performed

Everything below ran on this machine, no container runtime used, nothing installed into the
repository, no machine configuration touched.

**Read-only on `/Users/biran/code/skills/loop/ccloop` throughout.** No commit, no HEAD move, no
index write, no push, no merge, no branch or worktree deletion. Final state:
`rtk proxy git rev-parse HEAD` = `926d6dd14624b86681e5c84d8f28093044e940a0`;
`rtk proxy git diff` → **0 bytes**; `rtk proxy git diff --cached` → **0 bytes** (both via
`rtk proxy … > file` then `wc -c`, per the rtk-lies warning).

**All mutation in `git clone --local`** at
`…/scratchpad/clone`. The only thing I added to it that is not tracked is a symlink to the main
checkout's `node_modules` (the clone has none; `.gitignore` lists `node_modules/` with a trailing
slash, which does not match a symlink, hence the `?? node_modules` line). Final clone state:
`rtk proxy git diff` → **0 bytes**; `rtk proxy git diff --cached` → **0 bytes**;
`git status --porcelain` → `?? node_modules` only. Every file restore was done with
`cat pristine > target` and verified with `diff` (per the `cp -i` hazard); deletions used
`/bin/rm -f` (per the `rm -i` hazard).

1. **Sizes.** `tryRecoverStaleOwnerTransferLock` = 1558 bytes at `926d6dd`, 970 at both `1bd6f06`
   and `86d3bd6`; signature hit count 1. Brief's baseline confirmed.
2. **Exit enumeration, 25 lock shapes, both arms.** A temporary vitest probe in the clone driving
   the real function through `readOwnerRecord`, run once on `926d6dd` and once with `fileStore.ts`
   restored to `1bd6f06` (redline verified back at 970 bytes). Full before/after table in S-1 and
   Mi-2.
3. **`process.kill` totality**, 12 pid values, plain node script. S-2.
4. **Dead-code check** for `pathExists` and the three removed path fields, by grep over `src/`. S-3.
5. **Full suite on the clone at HEAD**: `34 files / 600 tests`, 0 skipped, one known allowed flake;
   vitest `RUN` line verified to point at the clone. `typecheck` rc=0, `build` rc=0.
6. **Mutant M1** (guard reverted) — full suite: **600/600 pass, rc=0**. Then a behaviour probe on
   the same build proving M1 deletes a live holder's lock. C-1.
7. **Mutant M2** (catch reverted) — full suite: 2 failed / 598 passed, both failures being the two
   rewritten tests, with the messages the implementer reported (`expected 2 to be 1`;
   `ENOENT … instead of resolving`). Claim 3 corroborated via an independent mutant.
8. **Assertion-order experiment** under M2, moving T1's pending-file assertion first, to prove it can
   fire and does measure "never finalized". S-7, Mi-1.
9. **Test-body containment diff** of the two rewritten `it(...)` blocks, extracted by name. I-4.
10. **End-to-end `ccloop unlock`** against a real bad lock via the real `main()` from `src/cli.ts`:
    refusal, digest cross-checked independently, wrong-credential refusal, forced removal, and the
    blocked transfer completing afterwards. S-4. **Nobody in this package had run this before; I am
    the first.**
11. **Operator-visible message** measured by catching the real `OwnerTransferLockBusyError` off
    `writeOwnerTransferArtifacts` and formatting it as `resumeLoop` does. I-3(b).
12. **Comment-only check** on `e22d1ea` by filtering every `+`/`-` line of `git show -U0` for
    non-`//` content: 0 and 0. S-5.
13. **Verbatim-survival check**: each of the 14 removed comment lines searched as a substring across
    the post-commit text of all six files. 14/14 absent. I-2.
14. **Stale-comment sweep** of `src/`, `tests/`, `reference/`, `docs/`, `validation/`, `examples/`,
    `scripts/` for `hasStagedArtifacts`, `staged artifacts`, `open point B`, `point B is unruled`,
    `lock stealer`, `ruling 50 froze`, `froze byte-for-byte`, then reading every hit in `src/` and
    `tests/`. I-1.
15. **Comment line-width** before/after across the six touched files. Mi-3.

**Not measured, and therefore not claimed.** Linux (darwin only, as the brief warns — point B has
still not been run on linux by anyone, including me). Concurrency: I ran no two-real-process probe;
every measurement above is single-process. The full cell-by-cell agreement of the redline function
and `ccloop unlock` — I measured the two cases the `inspectLock.ts` erratum names and no more, which
is exactly the hedge that erratum states, and I found that hedge **honest**.

**Claim-by-claim verdict on the implementer's six self-reports:**

| # | claim | verdict |
|---|---|---|
| 1 | exactly BUILD_B′; both exits closed; `pid:0`/overflow unchanged | **verified** [measured, both arms] |
| 2 | zero judgement cost beyond the two named tests | **true about test count, misleading** — one of ruling 83's two named exits landed with no test at all (C-1) |
| 3 | both rewrites go red on their own new claims; sibling stays green | **verified**, reproduced with an independent mutant |
| 4 | the rewrites tighten; the "never finalized" assertion is real | **verified** |
| 5 | comment round is comment-only, 94 lines / 6 files | **verified exactly** |
| 6 | nothing silently overwritten; true statements kept verbatim + ERRATUM | **false** (I-2), and 6 false statements were left uncorrected (I-1) |

---

## Recommendations

Ordered by what I would not ship without.

1. **(C-1) Pin the second exit.** One test in the redline function's existing class — a lock whose
   contents parse but whose holder is not `pid:<n>` (the strong `pid:<pid>:<timeOrigin>` form is the
   realistic one, since it is the mutation the file already fears), asserting the lock survives and
   the transfer does not finalize. It must fail under M1. This is one `it(...)` in
   `tests/persistence/fileStore.test.ts`, touching no production code. It needs a human to widen
   ruling 87's two-test budget, and should carry a ruling-88 sentence saying so.
2. **(I-4) Spend the second rewrite on something.** Since T2's body is already identical to T1's,
   the cheapest honest repair is to make T2 the test recommendation 1 asks for — same fixture, a
   strong-form holder instead of `not-json\n`, and a name that says which exit it pins. That
   satisfies ruling 87's "two whole rewrites" *and* closes C-1 with no extra test.
3. **(I-1) Finish the comment round** — the six sites listed, by the same kept-verbatim + ERRATUM
   convention. Three are in a file this round already edited; three are in E1's files and need that
   authorisation widened first, or a note saying they were knowingly left.
4. **(I-2) Correct the commit's own record.** Either restore the three in-place rewrites to
   verbatim + ERRATUM, or record in the ledger that the round departed from its stated convention in
   five places. Leaving `e22d1ea`'s message as the account of what it did reproduces the exact defect
   the ledger exists to prevent.
5. **(I-3) Decide, at human level, what an operator sees when a lock is permanently stranded.**
   The change is correct and I am not asking to reopen it — but "fail closed" is only complete when
   the closure is legible. Both surfaces that need it (`recoverInterruptedOwnerTransfer`'s swallow,
   `OwnerTransferLockBusyError`'s text) are outside this round's authorisation, so this is a ruling
   request, not a proposal. The minimum that would help: the busy error naming `ccloop unlock` when
   the refusal came from an unattributable lock rather than a live holder.
6. **(Mi-2) Record the array/coercion gap** as a named open item rather than fixing it here. It is
   pre-existing, bounded, and shared with E1 — but the new comment claims a totality the code does
   not have, and that sentence should either be softened or the code narrowed
   (`typeof parsed.holderProcessInstanceId === "string"` is the one-token version).
7. **(Mi-1, Mi-3)** Reorder T1's assertions so the lock check fires first, and rewrap the two
   over-long comment lines. Cosmetic; bundle with anything above.

---

## Assessment

**The change itself is right, and it is the strongest-verified thing in this package.** Ruling 83's
substance is implemented correctly: I reproduced `pointB-ruling-package-v2.md` §3's BUILD_B′ column
cell for cell against both the pre- and post-change builds, confirmed `pid:0` and overflow pids are
untouched on both arms, proved `isProcessActive` cannot throw so the new `catch` has no hidden
second job, confirmed nothing went dead, and — for the first time in this package — ran the escape
hatch end to end against a real bad lock and watched a blocked transfer complete after it. The two
commits typecheck, build, and leave 600 tests at 0 skipped.

**What is not right is everything around it.** One of the two exits the ruling names is protected by
nothing: a one-token revert inside the redline function restores the deletion of a *live* holder's
lock and the entire suite stays green. That is C-1's defect class returning through the same door it
came in, in a package whose whole subject is that door. The two-test budget was spent twice on the
same exit — the second rewrite is, by measurement, a subset of the first. And the comment round that
was supposed to make the record honest left six false sentences standing, four of them naming a
variable or a branch the change deleted, while its own commit message misdescribes the method it used.

Read together, the pattern is that each artefact here was verified against its *author's* intent and
none against the *ruling's* coverage. The implementer's self-reports are individually accurate — I
checked all six and only the last is wrong — but accurate self-reports about the wrong question are
what let C-1 through.

**Disposition: do not close point B, and do not record C-1 as closed.** Recommendations 1 and 2
together are one test and cost nothing beyond a human widening ruling 87 by zero net tests.
Recommendations 3 and 4 are the comment round finishing its own job. Recommendation 5 is a ruling
request I have no authority to answer. Until 1 is done, the sentence *"both halves are repaired"*
now sitting in `src/persistence/fileStore.ts` is true of the code and false of the guardrails.
