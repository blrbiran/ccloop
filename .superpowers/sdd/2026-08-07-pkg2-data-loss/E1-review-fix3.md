# E1 — fix round 3 review (5th independent reviewer, first to see `3cea111`)

Range: exactly one commit, `3cea111` (parent `57f3ce9`), three files. Everything after it is
documentation and was read only as a *claim* (`E1-review-fix2.md`, the commit message, ledger
§25.20), never as evidence.

Verdict up front: **0 Critical, 0 Important, 4 Minor.** All seven landing points check out, six of
them by measurement rather than by reading. One claim the commit explicitly marked NOT MEASURED
(the Linux `EISDIR` half) **I was able to measure, and it holds** — see Verification.

---

## Strengths

Specific things this round did that I would not want changed:

1. **The one production change is genuinely the smallest thing that fixes the stated defect.**
   `src/unlock/unlockCommand.ts:80-84` turns a ternary into an early return plus the same
   `error instanceof Error ? error.message : String(error)` the unlink catch at
   `src/unlock/unlockCommand.ts:97` already used. The ENOENT ⇒ `gone` behaviour is unchanged — same
   predicate, same returned object — and I proved by mutation that the `gone` path is still pinned
   *exactly* (`toEqual`, not a partial match): disabling the branch turns exactly one test red with
   `expected { outcome: 'unremovable', … } to deeply equal { outcome: 'gone' }`.

2. **The comment move is provably lossless.** I compared `57f3ce9`'s file against `3cea111`'s with a
   *movement-blind* line-multiset diff (`diff <(sort old) <(sort new)`). The result is exactly:
   1 line removed (the old ternary) and 10 added (6 new comment lines + the 3 lines of the early
   return + the new return). **Zero comment lines dropped, duplicated, or reflowed.** Both blocks
   now sit on what they describe: the errno paragraph on `export type LockRemoval`
   (`unlockCommand.ts:43-51`), the human-ruling-62 / residual-window rationale on
   `removeLockIfUnchanged` (`unlockCommand.ts:53-68`). This is the right fix for N-2 and it was done
   without collateral.

3. **`toMatchObject` did NOT weaken anything, and I measured that rather than arguing it.** Mutating
   the stat catch to return the *wrong discriminant* while keeping a correct reason
   (`{ outcome: "changed", reason: … }`) turns **3** tests red, including both converted assertions,
   each printing the object (`- "outcome": "unremovable" / + "outcome": "changed"`). That is strictly
   more informative than the `expect(result.outcome).toBe(...)` + cast pair it replaced, which is
   what N-3 asked for.

4. **The new operator-facing unlink test really does reach the unlink catch.** Blanking that catch's
   reason (`reason: ""`) turns exactly 2 tests red — the unit one at `tests/unlock/unlockCommand.test.ts:142`
   and the new output one at `tests/unlock/unlockCommand.test.ts:248` — and the second fails printing
   the operator's actual line, `refused  the lock could not be removed: ` with nothing after the
   colon. That is the failure naming the true cause, and it is direct evidence the test is not
   passing for some unrelated reason. The coverage asymmetry the commit claims to close is closed.

5. **The added existence assertions bite.** Under the "delete before the guard" mutation the three
   `lockExists(...)` assertions at `tests/unlock/unlockCommand.test.ts:163`, `:188` and the newly
   added `:217` all go red with their own messages, including the exact
   `the lock was deleted despite the removal having failed` the commit quotes. 11 red total,
   reproducing the commit's M-C count.

6. **Mock hygiene holds.** Both new tests live inside the describe whose `afterEach`
   (`tests/unlock/unlockCommand.test.ts:70-73`) does `vi.resetModules(); vi.doUnmock("node:fs/promises")`,
   so an aborted body cannot leak the mock — the discipline `9868f4c` introduced. I additionally ran
   `tests/unlock` three times with `--sequence.shuffle=true`: 40/40 green each time. `lockExists`
   works even inside the fs-mocked tests because the test file's own `stat` binding
   (`tests/unlock/unlockCommand.test.ts:19`) was resolved before `vi.doMock` ran, so the existence
   assertions read the real filesystem — they are not tautologies against the mock.

7. **The commit is honest about what it did not measure**, and names the unproven guard (N-4) as
   structural rather than dressing it up. That is the behaviour this project has been asking for.

8. **The red line is intact.** `tryRecoverStaleOwnerTransferLock` is byte-identical to `86d3bd6`:
   970 bytes both sides, `diff` rc=0. Verified independently, not taken from the ledger.

---

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

None.

### Minor (Nice to Have)

#### N3-1 — the stat catch still disagrees with the unlink catch about `null`/`undefined`, which is the exact thing this commit set out to end

**Anchor:** `src/unlock/unlockCommand.ts:80` — `const errno = error as NodeJS.ErrnoException;`
immediately followed by `if (errno.code === "ENOENT") {` at `:81`. (Not the sibling catch at
`:93-98`, which has no such dereference.)

**What is wrong.** The commit's stated principle, written into the code at
`src/unlock/unlockCommand.ts:78-79` — *"One function must not disagree with itself about whether the
value it caught can be trusted"* — is delivered for the **reason** but not for the **`code` read**.
The reason is now taken identically in both catches; the stat catch still dereferences the caught
value unguarded one line earlier. A rejection of `null` or `undefined` therefore throws a TypeError
out of `removeLockIfUnchanged` in the stat catch, while the unlink catch handles the same value
cleanly.

**Measured** (probe in the clone, mocking `node:fs/promises`):

| thrown value | stat catch | unlink catch |
|---|---|---|
| `null` | **THREW** `TypeError: Cannot read properties of null (reading 'code')` | `RESOLVED {"outcome":"unremovable","reason":"null"}` |
| `undefined` | **THREW** `TypeError: Cannot read properties of undefined (reading 'code')` | (same shape) |

**Why it matters.** `unlockCommand.ts:94-96` writes down the exact hazard: *"a rejection escaping a
delete path would be reported as 'the command crashed' rather than 'the lock is still there'"*. The
stat catch still has that escape, and the comment three lines above it now asserts the opposite.
A comment that claims a property the code next to it does not have is the failure mode this file has
been fixing all round.

**Constructible scenario.** `stat` rejects with `null` (only constructible through a mock or a
future non-`node:fs` stat implementation — `node:fs/promises` always rejects with an `Error`, so this
is not reachable in production today). The command exits with an unhandled rejection instead of
`refused  the lock could not be removed: null` + `nothing was deleted`.

**Verification:** measured (probe test, clone, restored). **Disposition:** report + defer is
defensible given zero production reachability; I am reporting it because the commit's own comment
claims the property.

**Fix (one line, keeps the cast's job):**
```ts
if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
  return { outcome: "gone" };
}
```
which lets the `errno` local go away entirely, since `.code` was its only remaining use.

#### N3-2 — `String(error)` introduces a *new* throw-from-the-catch on a null-prototype rejection, and an unbounded operator line

**Anchor:** `src/unlock/unlockCommand.ts:84` —
`return { outcome: "unremovable", reason: error instanceof Error ? error.message : String(error) };`
(the **stat** catch; the identical line at `:97` is the pre-existing unlink one).

**What is wrong.** Before this commit the stat catch read `errno.message`, which on an exotic
rejection yielded `undefined` — the bad answer the commit correctly removes. After, `String(error)`
is called on the same values, and `String()` is not total: it throws on an object with a null
prototype and on a symbol-ish input path. Measured:

| thrown value | before (`errno.message`) | after (`String(error)`) |
|---|---|---|
| `Object.create(null)` | `reason: undefined` (contained) | **THREW** `TypeError: Cannot convert object to primitive value` |
| `Symbol("nope")` | `undefined` | `reason: "Symbol(nope)"` (fine) |
| `{ code: "EACCES" }` | `undefined` | `reason: "[object Object]"` (uninformative but contained) |
| `"X".repeat(10000)` | `undefined` | the whole 10 000 chars land on one stderr line |

So for one exotic input the round trades *a bad contained answer* for *an escaping rejection* — a
strictly different failure shape, in the direction the file's own comment forbids. The unlink catch
has carried this hazard since before the commit, so this is a **pre-existing shape newly extended**
to the stat catch, not an invention of this round.

**Why it matters.** Same as N3-1: this is a delete path whose whole design contract is "turn the
failure into a value, never let it escape". Also, `reportFailedRemoval`
(`src/unlock/unlockCommand.ts:202`) interpolates `removal.reason` straight into one stderr line, so
an unbounded or multi-line reason breaks the two-line output shape the tests pin by `err[0]`.

**Constructible scenario.** `stat` rejects with `Object.create(null)`. Not reachable via
`node:fs/promises` (always an `Error`). Reachable only through a mock or a substituted fs.

**Verification:** measured (same probe). **Disposition:** defer is reasonable; if it is fixed, fix
both catches together, since splitting them re-creates exactly the disagreement this commit removed.

**Fix, if taken:** a shared helper used by both catches, e.g.
```ts
function reasonFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  try { return String(error); } catch { return Object.prototype.toString.call(error); }
}
```
A helper is also the structural answer to "one function must not disagree with itself" — right now
the agreement is two copies of one expression, which the next edit can silently break.

#### N3-3 — `/EPERM|EISDIR/` is honest, but it is now *measurably* replaceable with something stronger

**Anchor:** `tests/unlock/unlockCommand.test.ts:142` —
`expect(result).toMatchObject({ outcome: "unremovable", reason: expect.stringMatching(/EPERM|EISDIR/) });`

**What is wrong.** Nothing is wrong today: the union is correct on both declared platforms, and it
is not a hole a wrong errno slips through in practice (a wrong errno's message contains neither
token — I confirmed this by mutation: blanking the reason turns this very assertion red). But the
union accepts the *other* platform's value, so a real platform regression (Linux starting to answer
`EPERM`, or a Node change) passes silently. The commit accepted that because the Linux half was
unmeasured. **It is no longer unmeasured** — see Verification: I measured `EISDIR` on Linux and
`EPERM` on darwin. With both halves measured, the assertion can be pinned per platform:

```ts
reason: expect.stringMatching(process.platform === "linux" ? /EISDIR/ : /EPERM/)
```

**Why it matters.** This is the round's *only* assertion that reads an errno a real filesystem
produced — the comment at `tests/unlock/unlockCommand.test.ts:140-141` says exactly that. It is the
one place where tightening buys real signal.

**Verification:** measured (both platforms, see Verification). **Disposition:** genuinely optional;
the union is not a defect, it is now merely weaker than the evidence available.

#### N3-4 — the new comment paragraph sits above a branch it does not describe

**Anchor:** `src/unlock/unlockCommand.ts:75-79` — the `//` blank line plus *"The reason is taken the
same way the unlink catch below takes it…"*, which is placed **above** the ENOENT early return at
`:81-83` and describes only the return at `:84`.

**What is wrong.** This is the same shape as N-2, which this commit fixed one screen higher: a
paragraph documenting X placed on Y. A reader hitting `:81` has just been told about reason-taking,
which that branch does not do. Moving the paragraph to sit directly above `:84` (or dropping it into
the return's line) restores the invariant the commit just asserted for `LockRemoval`.

**Why it matters.** Small, but N-2 was raised precisely because this file's comments carry the
design rulings; a misplaced one is how a future edit gets the wrong idea about which branch is
load-bearing.

**Verification:** read-only argument. **Disposition:** cosmetic, defer freely.

---

### Considered and found NOT to be defects

Recorded so the next reviewer does not spend the same time:

- **The anti-vacuity guard at `tests/unlock/inspectLock.test.ts:216`.**
  `expect(() => process.kill(DEAD_PID, 0)).toThrow()` accepts `EPERM` as well as `ESRCH`, so on Linux
  (where `pid_max` is 4194304 and 999999 can be a live pid owned by another user) it can pass while
  the pid is *alive*. That would be a hole — except the assertion it guards
  (`tests/unlock/inspectLock.test.ts:239`, `toMatchObject({ state: "dead", … })`) fails loudly in
  exactly that case, because `isProcessActive` reads `EPERM` as alive (human ruling 74). So the guard
  is belt-and-braces, not the only thing standing between the test and a false pass, and it matches
  the file's convention at `:51` and `:193` (Rule 11). Read-only argument; not raised as a finding.
- **`makeRunDir()` substitution** at `tests/unlock/inspectLock.test.ts:212` is byte-equivalent to the
  inline `mkdtemp(join(tmpdir(), "ccloop-unlock-"))` it replaced (`inspectLock.test.ts:27-29`), so it
  is pure de-duplication with no behavioural change. `mkdtemp`/`tmpdir` are still used by the helper,
  so no dangling import; typecheck rc=0 confirms.
- **Test-count claim** "593 + 2": the two files go from 20+13 to 22+13 literal `it(` blocks
  (+2), and the suite goes to 595. Consistent.
- **Commit message claim that fix round 2 introduced the platform dependency**: verified —
  `git log -S'toContain("EPERM")'` names only `7ff04a8` and `3cea111`, and `3f6a61c`'s version of that
  test asserted the portable `toBe("unremovable")`.
- **Nothing new and silent (landing point 7).** The only production edit is the stat catch. ENOENT ⇒
  `gone` is untouched (mutation-proven). `changed`, `removed` and `reportFailedRemoval` are
  byte-untouched. The one behavioural delta is `reason: undefined` → a readable string, which is
  strictly *less* silent. The two residues I found (N3-1, N3-2) are loud failures (thrown TypeErrors),
  not quiet wrong answers — they are the opposite of this project's signature defect, and both are
  unreachable through `node:fs`.

### One correction to the record (not a finding against the commit)

Ledger §25.20 states *"本机无可用容器运行时（`docker` 有二进制、`docker info` rc=127）"* and the commit
message states the Linux half is NOT MEASURED. **The machine does have a usable container runtime** —
`/usr/local/bin/docker` is OrbStack's CLI and `docker info` failed only because the daemon was not
running. Starting it (`open -a OrbStack`, up in ~6s) made the measurement available, and I took it.
The commit and ledger were honest about not having measured it; the environmental premise ("no runner
available") was simply wrong, and the next round should not inherit it.

### One precision note on the commit's own red proof

The commit and ledger describe M-C as *"把 unlink 提到身份守卫之前"* / "delete before the identity
guard", claiming 11 red including `the lock was deleted despite the removal having failed`.
I ran **both** readings:

- unlink inserted **between the stat block and the dev/ino guard** → **10 red**, and the newly added
  assertion at `tests/unlock/unlockCommand.test.ts:217` does **not** fire (the stat is mocked to throw
  in that test, so the inserted unlink is never reached).
- unlink inserted **before the stat**, i.e. delete-then-check outright → **11 red**, including
  `:217` with exactly the quoted message.

So the claim reproduces, under the second reading. The wording "before the identity guard" is looser
than what was actually mutated; the number and the message are accurate. No action needed beyond
knowing which mutation the "11" refers to.

---

## Verification performed

All mutation work in a `git clone --local` copy at
`/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/ef286d9b-…/scratchpad/clone`
(node_modules symlinked from the checkout). The checkout was never written to: `git status --porcelain`
empty at start and at end, HEAD `4da041e` throughout, no push/merge/branch/worktree operation.

**Red line, independently verified (not taken from the ledger):**
```
git show 86d3bd6:src/persistence/fileStore.ts | awk '/^(export )?(async )?function tryRecoverStaleOwnerTransferLock/,/^}/'  -> 970 bytes
awk (same) on the working copy of src/persistence/fileStore.ts                                                              -> 970 bytes
diff redline_old.txt redline_new.txt   ->  diff-rc=0
```
`tryRecoverStaleOwnerTransferLock` is byte-identical to `86d3bd6`.

**Comment-move proof (movement-blind multiset diff of `57f3ce9` vs `3cea111`):**
```
diff <(sort old.ts) <(sort new.ts)
33a34 >       return { outcome: "gone" };
35a37,38 >     }   >     //
37a41 >     // itself about whether the value it caught can be trusted.
39a44,45 >     // that is not an Error has no `.message`, and "could not be removed: undefined" is the
         >     // The reason is taken the same way the unlink catch below takes it, deliberately: a rejection
40a47 >     // uninformative answer this command exists to prevent. One function must not disagree with
43a51 >     if (errno.code === "ENOENT") {
49a58 >     return { outcome: "unremovable", reason: error instanceof Error ? error.message : String(error) };
58d66 <     return errno.code === "ENOENT" ? { outcome: "gone" } : { outcome: "unremovable", reason: errno.message };
```
Exactly 1 removal (the old ternary), 10 additions. No comment line lost, duplicated or reflowed.

**Platform errno measurement (landing point 4 — the half the commit could not measure):**
```
darwin (this machine):
  node -e "mkdir /tmp/probe-dir-darwin; unlink it"
  -> platform= darwin code= EPERM message= "EPERM: operation not permitted, unlink '/tmp/probe-dir-darwin'"
  man 2 unlink confirms: [EPERM] The named file is a directory and the effective user …

linux (docker run --rm node:22-alpine, OrbStack, amd64):
  -> platform= linux code= EISDIR message= "EISDIR: illegal operation on a directory, unlink '/tmp/probe-dir'"
```
Both halves of `/EPERM|EISDIR/` are now MEASURED. The union is honest.

**Baseline in the clone (unfiltered, whole file read back; `RUN` line names the clone):**
```
RUN v2.1.9 …/scratchpad/clone
Test Files  1 failed | 33 passed (34)
     Tests  1 failed | 594 passed (595)
```
The single failure is the named allowed flake, matched by full name:
`tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
(protocol item 10 — not investigated). Scoped baseline `tests/unlock`: **40 passed (40)**, rc=0.

**Mutations (each preceded by a restore proven at 0/0 bytes):**

| id | mutation | result |
|---|---|---|
| M1 | stat catch reverted to `reason: errno.message` | **1 red** — `keeps a non-Error rejection readable…`, printing `- "reason": StringContaining "rejected with a string" / + "reason": undefined` |
| M2 | unlink catch `reason: ""` | **2 red** — unit `:142` (`+ "reason": ""`) **and** the new operator test `:248` (`+ refused  the lock could not be removed: `) |
| M3 | ENOENT branch disabled | **1 red** — `reports gone rather than throwing…`, `expected { outcome: 'unremovable', … } to deeply equal { outcome: 'gone' }` |
| M4 | stat catch returns `outcome: "changed"` with a correct reason | **3 red** — both `toMatchObject` sites and the operator test; wrong discriminant is caught, no weakening |
| M5a | `await unlink(lockPath)` between the stat block and the dev/ino guard | **10 red**; `:217` does not fire |
| M5b | `await unlink(lockPath).catch(()=>{})` at the top of `removeLockIfUnchanged` | **11 red**, including `:163`, `:188` and `:217` (`the lock was deleted despite the removal having failed`) — reproduces the commit's M-C |

**Probes (temporary untracked test files, deleted afterwards):**
```
PROBE[null]                  -> THREW TypeError: Cannot read properties of null (reading 'code')
PROBE[undefined]             -> THREW TypeError: Cannot read properties of undefined (reading 'code')
PROBE[null-prototype object] -> THREW TypeError: Cannot convert object to primitive value
PROBE[symbol]                -> RESOLVED {"outcome":"unremovable","reason":"Symbol(nope)"}
PROBE[plain object]          -> RESOLVED {"outcome":"unremovable","reason":"[object Object]"}
PROBE[10k string]            -> RESOLVED {"outcome":"unremovable","reason":"XXXX…"} (10000 chars)
PROBE2[null]  (unlink catch) -> RESOLVED {"outcome":"unremovable","reason":"null"}
PROBE2[null-prototype object](unlink catch) -> THREW TypeError: Cannot convert object to primitive value
```

**Order-independence / mock-leak check:** `tests/unlock --sequence.shuffle=true` × 3 → 40/40 green
each run, rc=0.

**Final state of the clone, after every mutation and probe was undone:**
```
git diff        | wc -c  ->        0
git diff --cached | wc -c ->       0
git status --porcelain  ->  ?? node_modules      (my symlink; dist/ is gitignored)
```
Restoration proven by the BYTE COUNTS of both diffs, per protocol item 4. `diff -r` was not relied on.

**Final green run on the restored clone (unfiltered, whole file read back):**
```
npm run typecheck  -> rc=0
npm run build      -> rc=0
npm test -- --run  -> rc=0 ;  Test Files 34 passed (34) ; Tests 595 passed (595)
```
(the allowed flake did not recur on this run). All runs with `ECC_GATEGUARD=off DISABLE_OMC=1`.

**Checkout untouched:** `git status --porcelain` empty, HEAD still `4da041e`.

---

## Recommendations

1. **Take N3-1** (`(error as NodeJS.ErrnoException | null)?.code`). One line, removes the last place
   where the function disagrees with itself, and lets the now-single-purpose `errno` local disappear.
2. **If N3-2 is taken, take it for both catches at once** via a shared `reasonFrom(error)` helper.
   Two hand-copies of one expression is how the original divergence happened; a helper makes the
   agreement structural instead of a convention. If it is not taken, that is defensible — record it
   as a known residue rather than leaving it implied by a comment that claims otherwise.
3. **Tighten `/EPERM|EISDIR/` to a platform-conditional matcher** now that both halves are measured,
   and update the comment at `tests/unlock/unlockCommand.test.ts:137-141` to say *measured on both*
   rather than *documented for linux*.
4. **Correct the environmental premise in the record**: a container runtime IS available on this
   machine (OrbStack; the daemon just needs starting). Future rounds should not carry
   "no Linux runner here" forward as a fact.
5. **Do not re-mutate M-C blind next round** — note in the ledger that the 11-red figure corresponds
   to *delete-before-the-stat*, not *delete-between-the-stat-and-the-guard* (10 red).
6. None of the above blocks the merge. If the coordinator wants a fix round 4, it is a 3-line round
   and should not need its own review; if it does not, items 1-3 are safe to carry as logged residue.

---

## Assessment

**Ready to merge? Yes.**

The single production change is behaviour-preserving on the ENOENT path (mutation-proven), strictly
improves the non-ENOENT path, and is pinned by a test that goes red with the exact word the defect
produced. The comment move is provably lossless by a movement-blind multiset diff, the assertion
conversions are measurably stronger rather than weaker, the new tests both reach the code they claim
and fail naming the true cause, the added guards bite, and the mocks cannot leak. Nothing silent was
introduced: the four Minors are all unreachable-through-`node:fs` residues that fail loudly if they
ever fire, and three of them are comment/assertion polish rather than behaviour. The red line is
byte-identical to `86d3bd6`, and the suite, typecheck and build are green.
