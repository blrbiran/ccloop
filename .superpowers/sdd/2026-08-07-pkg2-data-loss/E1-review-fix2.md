# E1 fix round 2 — independent review (4th reviewer, first to see this round)

Range reviewed: `e6898a7..9868f4c` (`7ff04a8`, `9868f4c`). Documentation after `9868f4c` not reviewed.
Reviewed alone, in two passes over the diff (production first, tests second), then a mutation pass.
No subagents were dispatched.

## Strengths

**The close() fix is the right fix, and it fixes more than it claims.** `src/unlock/inspectLock.ts:123`
(`await handle.close().catch(() => {});`, the one inside the `finally` at line 114, not any other
`close` in the tree) removes two distinct masking behaviours, not one. The one the commit message
names: a close failure after a good read used to become `file-unreadable`, the single state with no
digest and therefore no `--force` route. The one it does not name but also gets: when `handle.stat()`
or `handle.readFile()` *did* throw, a `finally` that awaited a throwing `close()` replaced the real
errno with the close errno, so `file-unreadable`'s `reason` named the wrong failure. Both are gone.

**The swallow is safe here, and I checked rather than assumed.** `inspectOwnerTransferLock` has
exactly one production caller — `unlockOwnerTransferLock` at `src/unlock/unlockCommand.ts:104`,
reached once per `ccloop unlock` invocation from `src/cli.ts:284` (grep over `src` and `tests`
returned no other). So the worst case of the swallow is one leaked descriptor in a process that is
about to exit. And a close failure on a **read-only** descriptor is not an integrity signal: unlike a
write descriptor, there is no deferred write-back error to surface, and `handle.readFile()` throws
rather than returning a short buffer, so there is no "truncated read the code then trusts" path. The
brief's question 1 gets a clean no.

**Every call site of the changed contract was updated, and there is no truthiness test anywhere.**
Grep over `src`/`tests` finds exactly two call sites (`unlockCommand.ts:126` and `:157`), both using
`removal.outcome !== "removed"`, never `if (removal)`. `reportFailedRemoval`'s parameter is
`Exclude<LockRemoval, { outcome: "removed" }>`, which is a genuinely better signature than the old
three-string union: it makes the "removed" case unrepresentable at the reporting boundary rather than
merely unlikely. Both `unremovable` branches route through the same reporter, so the reason reaches
the operator on **every** branch that can produce it. Exit codes are byte-for-byte what they were:
`gone` → stdout + 0, `changed` → stderr + 1, `unremovable` → stderr + 1.

**The reason text does not leak anything.** `errno.message` from `node:fs` carries the absolute lock
path. The operator supplied `runDir` themselves, `forceLine` at `unlockCommand.ts:99` already echoes
it back, and `unlockCommand.ts:112` already interpolates an unfiltered `inspection.reason` the same
way. Consistent, and nothing new is exposed.

**The `afterEach` fix is real, and I measured the damage it prevents rather than taking the commit
message's word for it.** See mutation M3 below: with the cleanup written back where it used to live
(end of the test body), one production mutation produces **three** failures, the third of which
points at innocent code in a different `describe`. With the `afterEach` at
`tests/unlock/unlockCommand.test.ts:70-73`, the same mutation produces exactly **two**, both real.
That is the defect the commit claims, reproduced and then shown fixed.

**The `afterEach` covers every `doMock` in scope.** `unlockCommand.test.ts` has two mocking
`describe`s: the one at line 65 (`afterEach` unmocks `node:fs/promises`; both its `doMock`s at :147
and :168 target `node:fs/promises`) and the one at line 191 (`afterEach` unmocks
`../../src/unlock/inspectLock.js`; its single `doMock` at :212 targets it). `inspectLock.test.ts`'s
sole `doMock` (:218) sits inside a `describe` with its own `afterEach` (:200-203). No cleanup remains
at the end of a test body in either file. The brief's question 3 gets a clean yes.

**All three new tests bite, and two of the three name the true cause in the failure text.** Measured,
not argued — M1, M2a, M2b below.

**The red line is intact.** `tryRecoverStaleOwnerTransferLock` is byte-identical to `86d3bd6`'s copy:
970 bytes each, `diff` rc=0. Extraction and comparison were done independently from the commit
messages (details in Verification performed).

## Issues

### Critical (Must Fix)

None. Nothing in this diff can delete a lock that the previous round would not have deleted, nothing
loses an error that the previous round kept, and no new silent failure was introduced on a path a
real filesystem can reach.

### Important (Should Fix)

#### I-1. `tests/unlock/unlockCommand.test.ts:137` — the round's only real-errno assertion is macOS-only, and goes red on Linux

The assertion is `expect((result as { reason: string }).reason).toContain("EPERM");`, inside
`it("reports unremovable rather than throwing when the name holds something unlink cannot take")` at
line 121 — the test that `mkdir`s a directory at the lock's name (line 128) and then lets
`removeLockIfUnchanged`'s `unlink` fail on it. (Anchoring: this is the `toContain("EPERM")` at :137,
not the `toContain("EACCES")` at :158 or :187, which are asserted against a hand-made mock error.)

**What is wrong.** `unlink(2)` on a directory returns a different errno per platform. POSIX permits
`EPERM`; Linux has returned `EISDIR` since 2.1.132 and documents it as its non-POSIX value. macOS
returns `EPERM`. So `reason` is `"EPERM: operation not permitted, unlink '…'"` here and
`"EISDIR: illegal operation on a directory, unlink '…'"` on Linux, and `toContain("EPERM")` fails
there. `package.json` declares `"os": ["darwin", "linux"]`, so Linux is a supported platform.

**Why it matters.** This diff introduced the platform dependency: the line it replaced was
`expect(await removeLockIfUnchanged(...)).toBe("unremovable")`, which was portable. And this is the
*only* new assertion in the round that exercises an errno a real filesystem produced — the two
`EACCES` assertions at :158 and :187 assert against the literal string
`"EACCES: permission denied, stat"` that the test's own `vi.doMock` throws, so they prove the
plumbing carries a string and nothing about real errno text. On Linux you therefore lose the round's
only real-errno coverage *and* gain a red test, which someone then has to triage.

**Constructible scenario.** On any Linux host: `npm test -- --run`. `mkdir` creates the directory at
the lock path, `stat` matches its own `(dev, ino)`, `unlink` rejects with
`EISDIR: illegal operation on a directory, unlink '/tmp/ccloop-unlock-cmd-XXXX/owner-transfer.lock'`,
`reason` is that string, and `toContain("EPERM")` fails. Production behaviour is correct on both
platforms; only the assertion is wrong.

**How verified.** Mixed, and I am explicit about which half is which. *Measured on this machine:* I
ran a standalone Node probe (`mkdtemp` → `mkdir` → `unlink`) and got
`code= EPERM / message= EPERM: operation not permitted, unlink '…' / platform= darwin`, confirming
the assertion passes here and that `reason` is the verbatim errno string with no reformatting.
*Read-only argument, not measured:* the Linux value. I have no Linux runner in this environment, so
the `EISDIR` half rests on the documented Linux `unlink(2)` behaviour — and, notably, on this test
file's own comment at line 123, which already states that a directory at that name is refused
"earlier with EISDIR". I flag the unmeasured half rather than presenting it as a measurement.

**How to fix.** One line: `expect((result as { reason: string }).reason).toMatch(/EPERM|EISDIR/);`
with a comment naming why both are correct. Better still, add one portable assertion that a *real*
errno survives — e.g. `chmod 0o500` the run directory so `unlink` fails `EACCES` on both platforms —
so that the round keeps real-errno coverage everywhere instead of only on darwin.

**Disposition.** I report it as Important because it is a portability regression this round
introduced and the fix costs one line. I would accept deferring it: there is no `.github/workflows`
in this repository, so nothing runs Linux today, and the failure mode is a loud red test rather than
a silently wrong answer. Finding and disposition are separate; the finding stands either way.

### Minor (Nice to Have)

#### N-1. `src/unlock/unlockCommand.ts:76` — the stat catch trusts `.message`, while the unlink catch 13 lines below does not

Line 76 is
`return errno.code === "ENOENT" ? { outcome: "gone" } : { outcome: "unremovable", reason: errno.message };`
inside the `catch` guarding `await stat(lockPath)` (line 71). Line 89, in the same function's `unlink`
catch, is `reason: error instanceof Error ? error.message : String(error)`. The same round wrote both
and used the defensive form in only one.

**Why it matters (mildly).** A non-`Error` rejection gives `errno.code === undefined` (so it is
classified `unremovable`, which is right) and `errno.message === undefined`, and the operator then
reads `refused  the lock could not be removed: undefined` — this project's own definition of a less
useful answer. **Constructible scenario:** only through a mocked or monkey-patched
`node:fs/promises` whose `stat` rejects with a string; `node:fs` itself always rejects with an
`Error`, so there is no real-filesystem path. **Verified** by reading both catches — a read-only
argument, deliberately not dressed up as a measurement, because the scenario is not constructible
against a real fs. **Fix:** make line 76 use the same `error instanceof Error ? … : String(error)`
form as line 89, so the two catches in one function stop disagreeing.

#### N-2. `src/unlock/unlockCommand.ts:43-61` — the new paragraph was appended to the wrong comment block

The block that begins at line 43 with "The deletion re-checks WHICH FILE the name holds…" documents
`removeLockIfUnchanged`. This round appended the new "The errno is carried, not collapsed…" paragraph
to the *end* of that block (lines 58-61), with no blank line separating them, and then declared
`export type LockRemoval` at line 62 between the block and the function it describes. The result: the
human-ruling-62 rationale, the `(dev, ino)` technique, and the "WHAT THIS DOES NOT DO" residual-window
note now read as documentation of a four-member union type. In a codebase where the comments are
this deliberately load-bearing, that costs something. **Verified** by reading the file — read-only
argument. **Fix:** move lines 58-61 to sit above `export type LockRemoval` as their own block, and
leave lines 43-57 attached to `export async function removeLockIfUnchanged` at line 68.

#### N-3. `tests/unlock/unlockCommand.test.ts:137` and `:158` — the cast throws away the discriminant that was just created

Both read `(result as { reason: string }).reason` rather than narrowing on `result.outcome`. The
whole point of turning the return into a discriminated union was that narrowing now works.

**Measured (mutation M4).** I renamed the payload field `reason` → `detail` throughout
`unlockCommand.ts` — the shape a refactor would take. Good news first: `tsc --noEmit` catches it,
rc=2, `TS2352` at both :137 and :158 ("Conversion of type 'LockRemoval' to type '{ reason: string; }'
may be a mistake"), so the cast is not the unchecked hole it looks like. The cost is the *runtime*
message. Both tests fail with
`the given combination of arguments (undefined and string) is invalid for this assertion` — an
assertion-API complaint that names nothing about locks, errnos, or removal. Compare M2a's message on
the same tests, `expected '' to contain 'EACCES'`, which points straight at the defect. **Fix:**
`expect(result).toMatchObject({ outcome: "unremovable", reason: expect.stringContaining("EPERM") })`,
or narrow with `if (result.outcome !== "unremovable") throw new Error(...)` first. Either keeps the
compile-time check and restores a failure message that names the cause.

#### N-4. `tests/unlock/inspectLock.test.ts:205-236` — the new test drops this file's own anti-vacuity guard and re-implements `makeRunDir`

The new `it("still reports the real state when the descriptor fails to close")` writes a
`pid:${DEAD_PID}` lock and asserts `{ state: "dead" }`, but omits
`expect(() => process.kill(DEAD_PID, 0)).toThrow()` — the guard this same file applies at line 51 and
again at line 193, and whose comment at lines 49-50 explains exactly why it is there. It also inlines
`await mkdtemp(join(tmpdir(), "ccloop-unlock-"))` at line 212 instead of calling the file's
`makeRunDir()` (line 27), which is character-for-character the same call.

**Why it matters (mildly).** If pid 999999 were ever live on the host, this test goes red for a
reason that has nothing to do with `close()` — a false red, not a false pass, so the risk is triage
cost rather than lost coverage. The inline `mkdtemp` is pure inconsistency (project rule 11).
**Verified** by reading — read-only argument. **Fix:** add the one `expect(...).toThrow()` line and
call `makeRunDir()`.

#### N-5. `tests/unlock/unlockCommand.test.ts:162-188` — the operator-facing test does not check that the lock survived

`it("puts the reason in front of the operator, not just in the return value")` asserts `code === 1`
and that stderr contains `EACCES`, but never asserts `lockExists(runDir)`. Its sibling at :140 does,
at :159, with the message "a lock was deleted despite the guard stat failing". This file's own header
(lines 14-16) states the rule: "Every deletion assertion is preceded by an existence assertion."
**Constructible scenario:** a future edit that let the `unremovable` branch fall through to the
`unlink` instead of returning — the return value and exit code would be unchanged for this test, the
stderr line would still contain `EACCES`, and the test would pass while the lock was deleted.
**Verified** by reading — read-only argument. **Fix:** add
`expect(await lockExists(runDir), "the lock was deleted despite the removal failing").toBe(true);`

#### N-6. No output-level coverage for the *unlink* catch's reason — only for the *stat* catch's

**Measured (mutation M2b).** Blanking the reason at `unlockCommand.ts:89` (the `unlink` catch) turns
exactly one test red — the unit test at :137 — and no output test. Blanking it at :76 (the `stat`
catch) turns two red, one of them the output test. So the `unlink`-originated reason is pinned only
at the return value, never at the operator's screen. Risk is genuinely low: both branches feed the
same `reportFailedRemoval`, and M2a proves that reporter is pinned. Recording it as a coverage
asymmetry, not asking for a new test.

## Verification performed

Every command below was run unfiltered — no `grep`, `tail`, `head` or `sed` on any test, typecheck or
build output. Verification runs were redirected to a file and the whole file read back.

**Baseline, on the main checkout at `57f3ce9` (`src`/`tests` proven identical to `9868f4c` by
`git diff --stat 9868f4c..57f3ce9 -- src tests`, which printed nothing):**

- `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm run typecheck` → **rc=0**, no diagnostics.
- `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm run build` → **rc=0**.
- `ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run` → **rc=0**.
  First line: `RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop` — the directory I meant.
  `Test Files  34 passed (34)` / `Tests  593 passed (593)`, **0 skipped**, duration 16.06s.
  `tests/unlock/unlockCommand.test.ts (25 tests)`, `tests/unlock/inspectLock.test.ts (13 tests)`.
  Matches the brief's stated baseline exactly. No allowed flake fired.

**Red-line byte comparison, done independently of any self-report.** I extracted
`tryRecoverStaleOwnerTransferLock` from `git show 86d3bd6:src/persistence/fileStore.ts` and from
`git show 9868f4c:src/persistence/fileStore.ts` with the same `awk` range (function signature line
through the first column-0 `}`), then compared:

```
     970  fn_old.ts        (86d3bd6)
     970  fn_head.ts       (9868f4c)
diff fn_old.ts fn_head.ts  → DIFF_RC=0
```

**970 bytes each, byte-identical, `diff` rc=0.** The red line holds. Its body is the same
`readFile` → ENOENT-means-true → `parsePid`/`isProcessActive` → `hasStagedArtifacts` →
`safeUnlink` shape as on `86d3bd6`; nothing in this round touched it.

**Mutation experiments.** All performed in `git clone --local` copy at
`…/scratchpad/clone`, with `node_modules` symlinked to the main checkout's. The clone's `src` and
`tests` were proven identical to the main checkout by `diff -r` before the first mutation. The main
checkout was never mutated.

- **M1 — revert the close fix.** `await handle.close().catch(() => {})` → `await handle.close()` in
  `inspectLock.ts:123`. `npx vitest run tests/unlock` → rc=1, `Tests  1 failed | 37 passed (38)`.
  The single failure is the round's new test:
  `× a failing close() must not overwrite a read that already succeeded > still reports the real state when the descriptor fails to close`
  → `expected { state: 'file-unreadable', …(1) } to match object { state: 'dead', holder: 'pid:999999' }`.
  **Bites, and the message names the true cause** — it shows the exact substitution the fix exists to
  prevent. No other test noticed, which is also correct: nothing else covers this.

- **M2a — drop the errno from the `stat` catch** (`reason: errno.message` → `reason: ""`).
  rc=1, `Tests  2 failed | 36 passed (38)`:
  `× keeps the errno when the stat that guards the delete fails…` → `expected '' to contain 'EACCES'`;
  `× puts the reason in front of the operator…` → received
  `refused  the lock could not be removed: ` / `         nothing was deleted`, expected to contain
  `EACCES`. **Both bite, both messages name the cause,** and the second shows the operator-facing
  line the fix produces. Exactly two failures, no collateral — the `afterEach` held.

- **M2b — drop the errno from the `unlink` catch** (line 89 → `reason: ""`). rc=1,
  `Tests  1 failed | 37 passed (38)`: `× reports unremovable rather than throwing…` →
  `expected '' to contain 'EPERM'`. Bites. This is the measurement behind N-6.

- **M3 — reproduce the pre-fix cleanup leak.** Removed the `afterEach` at
  `unlockCommand.test.ts:70-73`, wrote `vi.resetModules(); vi.doUnmock("node:fs/promises");` back at
  the end of both mocking test bodies (where it lived before `9868f4c`), and re-applied M2a. rc=1,
  `Tests  3 failed | 35 passed (38)`. The two real failures, plus:
  `× the dead-holder path refuses once the file underneath it has been replaced > does not delete a lock that is no longer the file the inspection read`
  → `expected 'refused  the lock could not be removed: ' to contain 'changed on disk'`.
  That third test is in a **different `describe`**, mocks a different module, and is innocent: the
  leaked `fs` `stat` mock reached it. Under M2a with the `afterEach` in place the same production
  mutation produced **two** failures. **The commit's claim is true and now measured: one real failure
  used to become two, and the second pointed at innocent code.**

- **M4 — rename the payload field `reason` → `detail`.** `tsc --noEmit` rc=2 with `TS2352` at
  `unlockCommand.test.ts:137` and `:158` (the casts *are* type-checked — good). `vitest run
  tests/unlock` rc=1, `Tests  2 failed | 36 passed (38)`, both with
  `the given combination of arguments (undefined and string) is invalid for this assertion`. This is
  the measurement behind N-3.

**Restoration proof.** The clone was restored with `git checkout -- src tests` and re-verified by
`diff -r` against the main checkout (`CLONE_RESTORED_TO_MAIN`). On the main checkout, taking raw
bytes through `rtk proxy` as the brief requires:

```
rtk proxy git diff          → 0 bytes
rtk proxy git diff --cached → 0 bytes
rtk proxy git status --short → (no output)
rtk proxy git rev-parse HEAD → 57f3ce94bf32e5a3c5bbb1a5865c5f0e46c73337
```

**Both 0 bytes**, working tree clean, HEAD unmoved. No branch, index, or ref in the main checkout was
touched; nothing was committed, merged, or pushed. The one thing this review wrote into the
repository is this report, at `.superpowers/sdd/2026-08-07-pkg2-data-loss/E1-review-fix2.md`, in a
directory gitignored with `*` — **not committed**; the coordinator must `git add -f` it. (`npm run
build` wrote `dist/`, which `.gitignore` covers — hence the clean `git status`.)

**Two spot-measurements outside the suite:** the `unlink`-on-a-directory errno probe reported under
I-1 (`code= EPERM`, `platform= darwin`), and a grep of `src`/`tests` for `removeLockIfUnchanged`,
`LockRemoval`, `unremovable`, `reportFailedRemoval` and `inspectOwnerTransferLock` to enumerate call
sites, which found the two call sites and the one production caller reported under Strengths.

## Recommendations

1. Fix I-1 with `toMatch(/EPERM|EISDIR/)`, and consider adding one portable real-errno case (a
   `chmod 0o500` run directory yields `EACCES` on both platforms) so the round's real-errno coverage
   does not live on a single OS.
2. Fix N-1 — one function should not disagree with itself about whether a caught value is an `Error`.
3. Fix N-2 while the context is fresh; a misfiled comment block in this codebase is a real loss.
4. N-3 and N-5 are one line each and both improve what a future failure tells the reader. N-4 is
   two lines. All optional.
5. Not a finding, recorded because a later reader will wonder: `await handle.close().catch(() => {})`
   catches only a *rejected promise*, not a synchronous throw from `close()`. `FileHandle.close()`
   returns a promise, so no real-fs path reaches that, and I could not construct one — but a test
   double written as `close: () => { throw … }` (rather than `async () => { throw … }`) would slip
   past the fix. If anyone ever writes such a double, wrap the call in `try/catch` instead. I raise
   it as a note, not a finding, precisely because the scenario is not constructible against real fs.

## Assessment

**Ready to merge? Yes.**

Both defects this round set out to fix are genuinely fixed, and I proved it by mutation rather than
by reading the commit messages: reverting the `close()` catch turns exactly the new inspection test
red with a message naming the exact `dead` → `file-unreadable` substitution, and blanking either
errno turns the right tests red at both the return value and the operator's screen. The `afterEach`
change is not cosmetic — restoring the old cleanup placement reproduces the leak, one real failure
becoming three with the extra one accusing innocent code. The type change is fully propagated across
both call sites with no truthiness test anywhere, exit codes are unchanged, the red-line function is
byte-identical to `86d3bd6` at 970 bytes, and the full suite is 34 files / 593 tests / 0 skipped at
rc=0 with typecheck and build both clean. The one Important finding (I-1) is a test-only portability
regression on a platform nothing currently runs, fixable in one line and safe to land as a follow-up.
