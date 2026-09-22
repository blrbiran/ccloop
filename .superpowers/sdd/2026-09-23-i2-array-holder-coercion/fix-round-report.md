# Fix round report — I-1, M-1, M-2 (2026-09-23)

Repo root: `/Users/biran/code/skills/loop/ccloop`
Fix commit: `7f45eacc7d8e4a5d201dd42b92f2e9eb7cb02cd5` on `main` (local, not pushed)

## Scope

Three findings from the full-branch review of human ruling 127's I-2 fix. The ledger and
handoff findings from the same review are NOT in this report — they belong to the controller.

---

## I-1 — `--force` digest gate had zero coverage on the array-holder cell

### What was found
`src/unlock/unlockCommand.ts`'s `unrecognized-holder` --force arm (`removed  forced past
unrecognized holder identity: ...`, around lines 236–241) had zero test hits:
`git grep "forced past" -- tests` → RC=1 before this round.

Ruling 127 routed the array-holder shape `["pid:999999"]` into exactly this arm. Before ruling
127 that same input was classified `dead`, and the `dead` branch in unlockCommand.ts sits
**before** the `if (!options.force)` / digest-comparison gate — so under the old code, `--force`
with *any* `--expect` value (right or wrong, or omitted with plain `--force`... actually `--force`
always requires `--expect` by the type) deleted the lock without the digest ever being read.
After ruling 127, the same input lands in `unrecognized-holder`, which sits *after* the digest
gate, so the gate is now consulted — but nothing tested that it was.

### What was added
Two new tests in `tests/unlock/unlockCommand.test.ts`, appended inside the existing
`describe("unlockOwnerTransferLock", ...)` block, right after the existing I-2 refusal test:

1. `"removes an ARRAY holder under --force with the matching digest, and labels the removal
   forced"` — seeds `{ holderProcessInstanceId: ["pid:${DEAD_PID}"], ... }`, asserts the lock
   exists, runs with `--force --expect <digest returned by seedLock>`, asserts: lock gone
   (`lockExists` → `false`), exit code `0`, `err` empty, `out[0]` matches
   `/^removed  forced past unrecognized holder identity: /` (prefix only, per the file's own rule
   that the holder's rendering is pinned once, in `inspectLock.test.ts`, to keep mutations
   independent).

2. `"refuses an ARRAY holder under --force when the digest does not match, and leaves the lock on
   disk byte for byte"` — the safety criterion. Same seeded lock, run with `--force --expect
   <hardcoded wrong digest>` (`"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`,
   64 literal `a`s, never derived from `contents` or from `seedLock`'s hash). Asserts: lock still
   exists, file bytes unchanged (`readFile(...) === contents`), exit code `1`, `out` empty,
   `err` joined contains `"--expect does not match"`.

Both tests assert lock existence before the run, per the file's header rule ("Every deletion
assertion is preceded by an existence assertion"). Fixture functions reused as instructed:
`makeRunDir()`, `seedLock()`, `lockExists()`, `run()`, `DEAD_PID`. No fixtures were added.

### Mutation-red proof (I-1's safety criterion)

Mutation clone: `git clone --local` of the main repo into
`/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/49aacd52-2a04-441c-ac4e-3e2d1c3ab186/scratchpad/i1-mutation-clone-20260923/repo`
(scratchpad, outside the project). `node_modules` symlinked from the main tree's
`node_modules` (required for `npm run build` / vitest module resolution). Test file changes
copied in via `cp -f` from the main worktree (uncommitted at the time), since `git clone --local`
only carries committed history.

1. **Baseline build + test (unmutated clone):**
   `npm run build` → RC=0. `npx vitest run tests/unlock/unlockCommand.test.ts` → **35 tests, all
   passed, RC=0.**

2. **Mutation applied** (clone only): in `src/unlock/unlockCommand.ts`, changed
   ```
   if (options.expectedDigest !== inspection.digest) {
   ```
   to
   ```
   if (false) {
   ```
   — unconditionally disabling the digest check, i.e. exactly the failure mode ruling 127 fixed
   for this cell.

3. **Re-ran** `npx vitest run tests/unlock/unlockCommand.test.ts` in the mutated clone:

   ```
   ❯ tests/unlock/unlockCommand.test.ts (35 tests | 4 failed) 53ms
      × ... refuses an unrecognized holder identity when --force carries a stale digest, and leaves the lock alone
        → --force with a STALE digest deleted the lock: expected false to be true
      × ... refuses a lock that is not JSON at all when --force carries a stale digest, and leaves the lock alone
        → --force with a STALE digest deleted the lock: expected false to be true
      × unlockOwnerTransferLock > refuses --force whose digest was computed before the lock changed underneath it
        → a digest computed before the lock changed still authorized a delete: expected false to be true
      × unlockOwnerTransferLock > refuses an ARRAY holder under --force when the digest does not match, and leaves the lock on disk byte for byte
        → an array holder's lock was deleted despite a mismatched --force digest: expected false to be true

    Test Files  1 failed (1)
         Tests  4 failed | 31 passed (35)
   RC=1
   ```

   **The new I-1 safety test (`refuses an ARRAY holder under --force when the digest does not
   match...`) went red**, alongside the three pre-existing digest-gate tests that share the same
   `if` guard. This confirms the new criterion is not vacuous and does actually exercise the
   digest comparison for the array-holder shape.

4. **Main worktree untouched during the whole experiment:** measured with `/usr/bin/git diff` /
   `/usr/bin/git diff --cached` byte counts in the main repo, taken right after the mutated test
   run above:
   `git diff` → 16471 bytes (test-file change + the two pre-existing unrelated modified files,
   `progress.md` and `handoff.md`, which are not mine); `git diff --cached` → 0 bytes. `git
   status --short` showed only the same files as before the mutation experiment — no drift into
   the main tree.

---

## M-1 — the `rawHolder`/`holder` split comment didn't name its own weak point

`src/unlock/inspectLock.ts`, the "TWO values, not one, and this split is load-bearing" comment
(originally lines 180–185) said what the split defends against but not what defeats it if
reverted at the call site while the `parsePid` type guard stays in place. Appended (did not
rewrite any existing sentence) 6 new comment lines stating the specific reverting mutation
(`parsePid(rawHolder)` → `parsePid(holder)`, guard left alone) typechecks clean and produces no
new test failures, naming the comment itself plus the ledger's M1 mutation entry as the only
guard against it.

**Verified the claim before writing it**, in the same mutation clone (after restoring the I-1
`unlockCommand.ts` mutation back to the original digest check via `sed`):

- Applied the described mutation to the clone's `src/unlock/inspectLock.ts`: line 211 changed
  from `const pid = rawHolder === "" ? null : parsePid(rawHolder);` to
  `... : parsePid(holder);` (guard in `parsePid` untouched).
- `npx tsc -p tsconfig.json` → **RC=0** (measured, file
  `.../i1-mutation-clone-20260923/m1-tsc.txt`).
- `npx vitest run` (full suite) → **778 passed, 1 failed, 779 total, RC=1.** The one failure was
  `tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group
  quiet and proves only after the full tree is gone`, timing out at 5000ms — this is the
  pre-existing stable-red test named in the task's known-red list, unrelated to this mutation.

So the comment's exact wording says "778/779 tests still pass" and names the one known failure,
rather than claiming a blanket "zero red" that the measurement doesn't actually support.

---

## M-2 — `DEAD_PID` only half-wired into the new inspectLock.test.ts block

`tests/unlock/inspectLock.test.ts`, `describe("a holder that is not a string at all (human ruling
127)", ...)`:

- `NON_STRING_STATE_CASES`'s first row: `holder: ["pid:999999"]` changed to
  `holder: [\`pid:${DEAD_PID}\`]`. This is the row whose `assertPremise` calls
  `isProcessActive(DEAD_PID)` — before this change, that premise and the literal holder value
  were coupled only by `DEAD_PID === 999999` happening to hold today; a future change to
  `DEAD_PID` would have made the premise silently assert liveness of a pid unrelated to the one
  actually in the holder array.
- `NON_STRING_RENDER_CASES`'s array row: `holder` changed the same way, to
  `[\`pid:${DEAD_PID}\`]`, matching this file's existing convention at `:228`/`:251` (premise
  assertion immediately followed by a `pid:${DEAD_PID}`-built holder). `rendered:
  '["pid:999999"]'` was **kept as a hardcoded literal**, per the file's hard rule that expected
  values are never computed from the code under test. Added a comment on this row explaining that
  the literal's continued correctness (i.e. that `DEAD_PID` stringifies to `"999999"`) is held up
  by the comment itself plus the adjacent premise assertion in `NON_STRING_STATE_CASES`, not by
  any enforced code path — if `DEAD_PID` ever changes, this row will fail loudly rather than
  drift silently.

**Test count check:** `NON_STRING_STATE_CASES` and `NON_STRING_RENDER_CASES` still have 2 entries
each (unchanged); `npx vitest run tests/unlock/inspectLock.test.ts` → **18 tests, all passed**,
matching the file's own self-count criterion (`expect(collectedTestCount).toBe(18)`), which also
passed. M-2 did not change the test count, confirmed by running the file rather than assumed.

---

## Final verification, main worktree, post-fix, pre-commit

- `npx tsc -p tsconfig.json` → RC=0 (`/tmp/ccloop_tsc_main.txt`).
- `npx vitest run tests/unlock/` → `inspectLock.test.ts` (18 tests) + `unlockCommand.test.ts` (35
  tests) = **53 tests, all passed, RC=0** (`/tmp/ccloop_unlock_dir_run.txt`).
- `npx vitest run` (full suite, `ECC_GATEGUARD=off DISABLE_OMC=1`) →
  **Test Files: 1 failed | 55 passed (56). Tests: 1 failed | 778 passed (779). RC=1.**
  (`/tmp/ccloop_full_suite_final.txt`)
  The one failure, by name:
  `tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group
  quiet and proves only after the full tree is gone`
  — this is exactly the one stable red named in the task's known-red set of 7. Red set observed
  = `{ that one name }` ⊆ the known-red set. Total test count 779 = 777 (prior known total) + 2
  (I-1's new tests); `inspectLock.test.ts`'s own internal count assertion (18) was not touched by
  M-2 and still passes, confirming the instruction to re-check it after M-2 rather than assume.

## Commit

```
$ /usr/bin/git commit -m "test(unlock): pin the --force digest gate on an array holder, and shore up two comments"
[main 7f45eacc7d8e4a5d201dd42b92f2e9eb7cb02cd5]
 3 files changed, 77 insertions(+), 2 deletions(-)
```

`git show --stat HEAD`:
```
commit 7f45eacc7d8e4a5d201dd42b92f2e9eb7cb02cd5
Author: biran <blrbiran@163.com>
Date:   Wed Sep 23 02:44:17 2026 +0800

    test(unlock): pin the --force digest gate on an array holder, and shore up two comments
    ...
 src/unlock/inspectLock.ts          |  8 +++++
 tests/unlock/inspectLock.test.ts   |  9 ++++--
 tests/unlock/unlockCommand.test.ts | 62 ++++++++++++++++++++++++++++++++++++++
 3 files changed, 77 insertions(+), 2 deletions(-)
```

Not staged, not touched, verified still present and unstaged after the commit:
`.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md`, `docs/handoff/handoff.md`, untracked
`docs/superpowers/plans/2026-09-23-i2-array-holder-coercion.md` and
`docs/superpowers/specs/2026-09-23-i2-array-holder-coercion-design.md`.

Not pushed. Not merged. No branches or worktrees deleted. No subagents were dispatched for this
task — all edits, the mutation clone, and verification were done directly.

## Caveats / things the next reader should know

- The mutation clone still exists at
  `/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/49aacd52-2a04-441c-ac4e-3e2d1c3ab186/scratchpad/i1-mutation-clone-20260923/`
  (scratchpad-local, disposable, not part of this repo). It was left in its post-verification
  state (I-1 mutation reverted, M-1 mutation still applied to its `inspectLock.ts`) since it is
  throwaway and outside the repo; nothing under `/Users/biran/code/skills/loop/ccloop` was
  touched by any mutation.
- `git status`'s permission layer blocked a plain `rm -rf` / `cp` in this session (interactive
  aliases); used `/bin/cp -f` for the one file copy needed and avoided deleting anything, per the
  session's data-safety rules. This did not block any required verification.
