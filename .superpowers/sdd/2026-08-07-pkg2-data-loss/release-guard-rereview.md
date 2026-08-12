# Scoped re-review (round 3) — the fix round for rulings 64

Scope: **`4f18190` + `91490b8` only**, base `0a76c79`. Ruling 64 authorised **M-2 / M-4 / M-5 only**;
M-1 and M-3 were ordered untouched. The previous round's conclusions are not reopened.
Third pair of eyes: the implementer wrote `release-guard-fixround-report.md`, the first reviewer wrote
`release-guard-review.md`. **Both are material under test, not evidence.** Every reverse control below
was re-run by me, not re-read.

---

## 0. Verdict (written first)

| Item | Verdict |
|---|---|
| **M-2** | **ADDRESSED.** New criterion red **on an assertion** under two independent mutations. |
| **M-4** | **ADDRESSED** (documentation only — no criterion is possible, and none is claimed). |
| **M-5** | **ADDRESSED.** The reviewer's surviving mutation F is dead, red **on an assertion**. |
| **New breakage / overreach** | **None that violates ruling 64.** M-1 and M-3 are byte-untouched. Three Minor findings (N-1..N-3), one of them a **newly surviving mutation introduced this round**. |
| **M-5 criterion legitimacy** | **Legitimate.** Not always-green, not self-referential. Two-sided: I proved both arms fail, each for its own reason. Its declared scope limit is real and correctly stated. |
| **Closing runs** | test `0`, typecheck `0`, build `0`. `RUN v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard`. **31 files / 538 tests, 0 skipped = 535 baseline + 3.** |
| **Flake** | None. Zero flake in 8 full-suite runs; neither (B) nor (F) appeared. |

**Recommendation: releasable.** No finding below blocks. N-2 is the one a human should consciously
accept rather than skim, because it is the same shape as the defect this round was convened to fix.

---

## 1. What I actually verified, and how

The change is small and fully enumerable — `git diff --numstat 0a76c79 91490b8`:

```
482  0   .superpowers/.../release-guard-fixround-report.md
15   5   .superpowers/.../release-guard-impl-report.md
42  12   src/persistence/fileStore.ts
214  0   tests/persistence/fileStore.test.ts
```

Two source files, two documents. **Nothing else in the repository was touched** — in particular
`validation/v1/lib/evidence.ts` (the M-1 surface) does not appear, so M-1 is byte-untouched by
construction, not by assertion.

`tests/...` is **+214 / −0**: a pure append. **Zero existing assertions were modified or deleted**,
and that is provable from the deletion count alone rather than from reading.

### The behavioural core, stated exactly

The old helper returned `true` iff `(dev && ino)` matched and `false` in every other case including
every `catch`. The new helper returns `"ours"` iff `(dev && ino)` matched, and the call site tests
`verdict !== "ours"`. So:

> `verdict === "ours"` ⟺ old `stillOurs === true`, exactly.

**The delete/skip decision is bit-identical, and the set of situations that emit an event is
unchanged.** Only the `detail` string now varies by branch. This is the single most important fact
for judging overreach, and it is a structural argument, not a measurement.

---

## 2. M-2 — ADDRESSED

The ENOENT branch no longer claims "left in place" when nothing is on disk. Detail is now per-branch
via `SKIPPED_RELEASE_DETAILS`.

**Criterion** (`the owner-transfer lock's release reports a vanished lock as vanished...`), 1 test.
Anti-vacuity is doubled: `removals === 1` **and** `lockPresent === false`, so the fixture proves it
really reached the ENOENT branch rather than passing on some other branch.

**My own mutations, full suite each time:**

| Mutation | Result | Red on |
|---|---|---|
| Revert `gone` detail to the old single sentence | `1 failed / 537 passed`, `EXIT=1` | **AssertionError**, `Received` contains `it was left in place` verbatim |
| Collapse the whole `catch` classification to `return "foreign"` | `1 failed / 537 passed`, `EXIT=1` | **AssertionError**, same diff |

Both kill exactly the new test and nothing else. Not a crash, not a timeout — a real
expected/received string diff. **ADDRESSED.**

The semantic question the implementer raised in §2.1 (should this branch record an event at all)
was correctly resolved: ruling 62's text "including cannot be read" covers it, and the reviewer's
M-2 asked to fix the wording, not to remove the event. He changed wording only. Correct.

---

## 3. M-4 — ADDRESSED (documentation only)

The load-bearing comment at `fileStore.ts:993` now reads `five` and names the fifth path through the
same-prefix sibling `acquireOwnerTransferLockForReconciliation`.

**I re-derived the number independently rather than checking his table.** Five `release()` call
sites, and I read the surrounding lines of each to confirm every one sits inside a `finally`:

| Line (post-fix) | Form |
|---|---|
| 546 | `} finally { await acquisition.lock.release(); }` — the sibling path |
| 1321 | `} finally { await lock.release(); }` |
| 1376 | `} finally { await lock.release(); }` |
| 1397 | `} finally { await lock.release(); }` |
| 1448 | `} finally { await lock.release(); }` |

**Five confirmed.** M-4 is a comment fix, so there is no criterion and cannot be one — I record that
plainly rather than manufacturing a mutation for it. The `git diff` is the whole evidence.

The correction to the earlier report (`release-guard-impl-report.md`) is honest: the original text is
struck through and preserved, marked wrong, and the corrected fact is stated below it. That is the
right way to amend a record.

---

## 4. M-5 — ADDRESSED, and the criterion is legitimate

**This was the cell the brief asked me to press hardest on, so the reasoning is spelled out.**

### 4.1 It kills the target mutation

Mutation F (`onDisk.dev === published.dev && onDisk.ino === published.ino` → `onDisk.ino === published.ino`),
applied by me to the worktree, full suite:

```
× ...release compares the device as well as the inode number > refuses to delete a lock whose
  inode number matches but whose device does not
AssertionError: expected { outcome: 'completed', …(2) } to deeply equal { outcome: 'completed', …(2) }
- Expected            + Received
-   "events": Array [ "owner_transfer_lock_release_skipped" ],    +   "events": Array [],
-   "lockKept": true,                                             +   "lockKept": false,
Tests  1 failed | 537 passed (538)   EXIT=1
```

**Red on the assertion**, and the `Received` is exactly what the test's own comment predicted.
The mutation the first reviewer measured as surviving 535 green tests now dies. **Not always-green.**

### 4.2 Is it self-referential? No — and here is why, in the terms that matter

The worry is that injecting `dev` and then asserting the code notices `dev` proves nothing. Four
structural facts defeat that:

1. **The assertions are on observables, not on the comparison.** The test asserts the lock file is
   still on disk and that `events.jsonl` contains the refusal — end-state facts, not "the expression
   evaluated false".
2. **The mock sits at the OS boundary** (`node:fs/promises`), the standard seam, not inside the unit.
3. **The two sides of the comparison come from different sources.** `published` comes from
   `handle.stat()`, a `FileHandle` method that does **not** route through the module mock; only
   `onDisk` comes from the mocked `stat`. So the asymmetry is genuine — the test is not feeding both
   operands.
4. **The control arm is load-bearing, and I proved it.** `devShift 0` runs the *same* wrapper, the
   *same* clone, the *same* extra call, and expects the lock to be **deleted**. So "the wrapper
   itself causes refusal" and "cloning the Stats object causes refusal" are both excluded.

For (4) I did not take the implementer's word. I mutated the verdict to a constant `"foreign"`
(refuse everything) and confirmed the control arm actually fires:

```
× ...compares the device as well as the inode number > still deletes its own lock when the same
  wrapper leaves the device alone
Test Files 7 failed | 24 passed (31)   Tests 77 failed | 461 passed (538)   EXIT=1
```

77 = the first reviewer's pre-fix 76 plus this new control arm. **Both arms of the pair fail, each
under a different mutation, neither under the other's.** That is a two-sided criterion.

### 4.3 I verified the mock's load-bearing premise myself

The test comment claims `stat` "has exactly one caller in src/". If that were false the narrow
wrapper could miss its target and the test could pass on an unrelated file. Measured:

```
$ grep -rnE "(^|[^.a-zA-Z])stat\(" src/
src/persistence/fileStore.ts:1007:    const onDisk = await stat(lockPath);
```

One caller, and it is the identity check itself. The only other stat-family call anywhere in `src/`
is `lstat` in `src/registry/scanRuns.ts:63`, a different module which the wrapper passes through
untouched. **Premise holds.** The `shifted === 1` anti-vacuity assertion additionally guarantees the
seam fired exactly once, so a future refactor that stopped routing through it would fail loudly
rather than pass vacuously.

### 4.4 The declared scope limit is real, and correctly declared

What the criterion pins: **the comparison** — given an on-disk file whose inode number matches and
whose device does not, `release()` must refuse. What it does **not** pin: that any kernel or mount
can produce that state. It is zero evidence about real cross-device behaviour, and it would not catch
a bug in how the OS reports `dev`.

**I accept the trade-off.** A same-`ino`-different-`dev` collision cannot be staged on one mount, and
a test that silently cannot produce its own precondition is the always-green criterion that is worse
than none. Injecting at the syscall boundary is the honest alternative, and the implementer wrote the
limit into the test comment and the report body rather than a footnote. **ADDRESSED.**

---

## 5. Findings (facts only — dispositions are in §6)

### N-1 — M-2's fix changed the `detail` text of the second-`release()` event that M-3 documents

**Fact.** In the double-`release()` case M-3 describes, `handle.stat()` throws `EBADF`, which now
classifies as `"unverified"` and produces
`".owner-transfer.lock could not be checked against the inode this process published; nothing was deleted"`
instead of the old single sentence.

**Fact.** No code was added for that path. The event is still emitted, still exactly one, still type
`owner_transfer_lock_release_skipped`, and the delete/skip decision is bit-identical (§1). The only
delta is the string.

**Fact.** The old sentence was *also* false in that case — it said the lock "was left in place" when
the first `release()` had already deleted it. The new sentence is true there.

### N-2 — a new surviving mutation was introduced this round: the `unverified` detail is unpinned

**Fact.** Nothing asserts the `unverified` wording. I replaced it with a sentinel string that appears
nowhere in the tests and ran the full suite:

```
unverified: `MUTATED SENTINEL never asserted anywhere`
Test Files  31 passed (31)    Tests  538 passed (538)    EXIT=0
$ grep -rn "could not be checked against" tests/   →   NO TEST REFERENCES IT
```

**Fact.** This is the third bucket, added this round, and it is the only one of the three
`SKIPPED_RELEASE_DETAILS` entries with no criterion behind it (`gone` and `foreign` both die under
mutation). **It is the same shape the implementer's own test comment calls "this repository's
signature root-cause shape": an assertion with no enforcement behind it.**

**Fact on reachability.** The `unverified` branch is reached only when a stat rejects with something
other than `ENOENT` — in practice `EBADF` from a closed handle, i.e. the double-`release()` path that
M-3 established is **unreachable today** (all five call sites are single-`release()` `finally`s, §3).
So this is an uncovered string on an unreachable path, not a reachable defect.

### N-3 — `classifyLockAtRelease`'s `catch` is no longer structurally incapable of throwing

**Fact.** The old body was `catch { return false; }` — literally unable to throw. The new body is:

```ts
} catch (error) {
  return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unverified";
}
```

A property access on `error`. If a rejection value were ever `null` or `undefined`, that raises a
`TypeError` **inside the catch**, which escapes `classifyLockAtRelease`, escapes `release()`, and
escapes the `finally` — violating the `MUST NOT THROW` contract asserted in the load-bearing comment
three lines above it.

**Fact on reachability.** I could not construct it. Node's `fs/promises` always rejects with an
`Error`. Both operands here are `handle.stat()` and `stat()`, both Node built-ins.

**Fact about the prior round's record.** The first reviewer's Q1 concluded both helpers "cannot
possibly reject" because their `catch` blocks were a bare `return false` and an empty block. That
proof was of the **old** helper and no longer holds structurally for the new one — it now holds only
contingently, on the behaviour of Node's rejection values.

### N-4 — the fix-round report cites pre-fix line numbers as current

**Fact.** `release-guard-fixround-report.md` §3.1 presents a grep showing
`546 / 1291 / 1346 / 1367 / 1418`. In the committed state of the same commit the last four are
`1321 / 1376 / 1397 / 1448` (the edit added 30 lines above them). A reviewer following those numbers
lands 30 lines off. 546 is correct.

### N-5 — the implementer's mutation evidence was single-file; mine is full-suite

**Fact.** §4 line 211: "只跑单文件 ⇒ 按纪律 archive 副本足够". His mutation runs exercised
`fileStore.test.ts` only (87 tests), which is why his C2 reports 27 failures where the first reviewer
measured 76 and I measure 77 — different denominators, not a contradiction, and he flagged it.

**Fact.** He avoided the `git archive` false-red trap the brief warns about precisely *because* he
only ran one file. **All five of my mutations were run against the full 538-test suite in this
worktree**, so the coverage claims are now backed by full-suite evidence rather than single-file.

---

## 6. Dispositions (deliberately separate from §5)

> These are my judgements, not part of the findings. The controller has been burned before by
> dispositions read as if they were facts.

| # | Disposition | Reasoning |
|---|---|---|
| **N-1** | **Accept. This is not a violation of "do not touch M-3", and I would rule the same if asked again.** Record in the ledger that M-3's `detail` text changed, so the M-3 entry does not go stale. | M-3's prohibition, per the reviewer's §2, was against *adding defensive code for an unreachable path*. None was added. M-2 cannot be fixed without partitioning the `catch`, and every partition must give the `EBADF` branch *some* sentence. Reusing the `foreign` sentence there would have written a **second** false statement — the exact defect M-2 exists to delete. The implementer flagged this himself in §2.2 rather than hoping nobody looked, which is the behaviour we want. |
| **N-2** | **Record in the ledger; do not add a test this round.** If anyone does pin it later, it needs a fixture that rejects with a non-`ENOENT` error, which is mock-only. | Unreachable path, string-only, zero behaviour risk. But it should be *recorded*, because "we fixed a surviving mutation and shipped a new one of the same shape" is exactly the pattern this project keeps paying for. I am explicitly **not** calling this blocking. |
| **N-3** | **Do not change it.** Record next to N-2. | A null-guard for a rejection Node cannot produce is precisely the speculative defence Rule 2 forbids, and the reviewer already refused that reasoning for M-3; refusing it here too is the consistent call. `(error as ...)?.code` is a one-character fix if a human wants belt-and-braces, but it would ship unpinned, which is N-2 again. |
| **N-4** | **Fix the four numbers when the document is next touched.** Not worth a commit of its own. | Pure documentation; the prose around it is correct. |
| **N-5** | **No action.** Noted so the ledger records that full-suite mutation evidence now exists. | Disclosed by the implementer; my runs supersede it. |

**On release:** none of the five blocks. If the human requires "no unpinned new surface", **N-2** is
the only one that would need work before merge — and pinning it costs one mock-only test on a path
nothing can reach.

---

## 7. Red line — re-verified byte for byte, with a must-hit control

⚠️ Both the controller and the first reviewer have each already burned a probe on the same-prefix
sibling `acquireOwnerTransferLockForReconciliation`. My extractor **asserts its signature line matches
exactly once** and aborts otherwise, so it cannot silently match the sibling — and I extracted the
sibling separately as its own subject.

| Symbol | old sha256[:16] | new sha256[:16] | Bytes | Result |
|---|---|---|---|---|
| `tryRecoverStaleOwnerTransferLock` | `194576bd835e7347` | `194576bd835e7347` | 969 / 969 | **IDENTICAL** |
| `acquireOwnerTransferLockForReconciliation` (the sibling) | `e8e493bd205d68d8` | `e8e493bd205d68d8` | 148 / 148 | **IDENTICAL** |
| `acquireOwnerTransferLock` **minus the `release` closure** | `fee2f68b8ecb3b52` | `fee2f68b8ecb3b52` | 2035 / 2035 | **IDENTICAL** |
| `release` closure alone | `e89bd3a8f4dfe408` | `4888b48ba6296e40` | — | CHANGED — *this is the authorised surface* |

**Must-hit control:** the same extractor, fed a one-token perturbation of
`tryRecoverStaleOwnerTransferLock`, reports CHANGED. The probe can see differences; its silence is
evidence, not blindness.

The whole delta inside `acquireOwnerTransferLock` is four lines, all inside the `release` closure:
the `lockPathStillHoldsPublishedInode` → `classifyLockAtRelease` rename and the
`!stillOurs` → `verdict !== "ours"` test. **The lock-acquisition path proper is byte-identical.**

Existing assertions: **+214 / −0**, zero modified.

---

## 8. Closing runs — this worktree

Run in `/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard`, whole output to disk and
read back, **unfiltered**, working tree clean before the runs.

| Command | Exit code |
|---|---|
| `npx vitest run` | **0** |
| `npm run typecheck` | **0** |
| `npm run build` | **0** |

vitest first `RUN` line, verbatim:

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard
```

⇒ this worktree, not the main checkout.

```
 Test Files  31 passed (31)
      Tests  538 passed (538)
```

**0 skipped. 538 = 535 baseline + 3 new `it()` (M-5 two, M-2 one). Matches the expected count.**

**Flake: none.** 8 full-suite runs this session, zero non-deterministic failures; neither (B) nor (F)
appeared. As the implementer correctly noted, not hitting (B) is not evidence (B) is fixed.

### Mutation restore proof

Five mutations, each applied to the worktree and reverted with `git checkout --`. After **every**
one, and again at the end:

```
git diff = 0 bytes    git diff --cached = 0 bytes    git status --porcelain = empty
```

Each mutation script asserted its anchor occurred **exactly once** before substituting, so a mutation
that silently failed to apply would have aborted rather than producing a false green.

---

## 9. What I did NOT verify

1. **Real cross-device behaviour.** Nobody can, on one mount. The M-5 criterion pins the comparison,
   not the scenario — §4.4. If the human wants the scenario itself covered it needs a two-mount CI
   fixture, and that is a separate piece of work.
2. **Linux.** Everything here ran on darwin 24.6.0. `package.json` declares `darwin` and `linux`. I
   did not verify `dev`/`ino` semantics or `EBADF`-vs-`ENOENT` errno behaviour on Linux, and the
   `"gone"` classification rests on that errno claim.
3. **The N-3 rejection-value claim, exhaustively.** I argue from Node always rejecting with `Error`;
   I did not audit Node's source to prove no path rejects with a non-object.
4. **M-1's reachability analysis.** Out of scope. I confirmed `evidence.ts` is byte-untouched (it is
   absent from the diff) but did not re-derive the first reviewer's `matchesPreExecuteExhaustion`
   reasoning.
5. **The previous round's conclusions.** Per the brief, not reopened. I did not re-run the first
   reviewer's probes 1–7; the byte-identity checks in §7 are my own and independent.
6. **The 482-line fix-round report line by line.** I verified its load-bearing claims — mutation
   results, the count of five, the one-caller premise, the exit codes, the 538 — by re-measuring. I
   did not check every sentence of its prose.

---

## 10. Countable facts (budget)

- Full-suite vitest runs: **8** (1 baseline, 5 mutations, 1 control probe, 1 closing).
- typecheck runs: 2. build runs: 2. (One each discarded — `PIPESTATUS` did not survive the subshell,
  so the exit codes from that attempt were unusable and re-run rather than guessed.)
- Mutations applied and reverted: **5** — F (drop `dev`), drop `ino`, revert `gone` detail, collapse
  `catch` classification, sentinel `unverified` detail. Plus 1 constant-`foreign` control probe.
- Surviving mutations found: **1** (N-2, the `unverified` detail).
- Symbols hashed for the red line: 4, plus 1 must-hit control.
- Restore proofs: 6, all `0 / 0` bytes.
- Files written by me: this report (untracked).
