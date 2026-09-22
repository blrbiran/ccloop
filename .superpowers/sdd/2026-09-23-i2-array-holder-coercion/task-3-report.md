# Task 3 Report — command-layer criterion + Ruling 7-A/B/C hardening

Repo root: `/Users/biran/code/skills/loop/ccloop`
Commit produced: `105af50` (subject: "test(unlock): pin unattributable-holder survival at the command layer, and harden the I-2 non-string-holder criteria")

All verification runs below were done as `命令 > 文件 2>&1; echo "RC=$?"` followed by a full `cat`/`Read` of the file — no `grep`/`tail`/`head`/`sed` filtering of any run's output. `ECC_GATEGUARD=off DISABLE_OMC=1` was exported for every vitest invocation. All verification `git` calls used `/usr/bin/git`.

## 1. Starting state

```
cd /Users/biran/code/skills/loop/ccloop && /usr/bin/git status && /usr/bin/git log --oneline -10
```
RC=0. Branch `main`, 2 ahead of origin, clean except pre-existing (not-mine) `docs/handoff/handoff.md` modified and two untracked `docs/superpowers/*` files. Top of history: `994f662 fix(inspectLock): classify the holder the record actually carries, and render it honestly`, `4279280 fix(fileStore): stop parsePid from reading a pid out of a value that is not a string`.

## 2. Task 3 brief step 1 — new command-layer test

Read `.superpowers/sdd/2026-09-23-i2-array-holder-coercion/task-3-brief.md` (only this file, not the plan). Added the brief's verbatim test
`"refuses an ARRAY holder that String()s into a dead pid, and leaves the lock exactly where it was"` to `tests/unlock/unlockCommand.test.ts`, inserted as the last test inside the outer `describe("unlockOwnerTransferLock", ...)` block, immediately before that describe's closing `});` (the file's last line). Edit verified via a unique 5-line anchor ending in the file's final `});` (only one match — confirmed with `grep -n 'no owner-transfer lock present' tests/unlock/unlockCommand.test.ts`, which returned exactly 2 matches, and the anchor used the full trailing block around line 684 to disambiguate).

## 3. Ruling 7-A/B/C — inspectLock.test.ts

Read the existing `describe("a holder that is not a string at all (human ruling 127)", ...)` block (lines 308–361 before edit) in `tests/unlock/inspectLock.test.ts`. Confirmed `const DEAD_PID = 999999;` already exists at line 45 of that file (brief text calling it absent was stale).

### 7-B (premise relocation) + 7-C (constant reuse)

`NON_STRING_STATE_CASES` got an explicit type annotation `{ name: string; holder: unknown; assertPremise?: () => void }[]`, and the `isProcessActive(999999)` premise — moved verbatim in its comment text, only the identifier changed to `DEAD_PID` — now lives as an `assertPremise` callback on the `"an array wrapping a dead bare pid"` row only. The loop body now does `assertPremise?.();`, so the `"an array wrapping pid:0, ..."` row no longer carries an assertion about pid 999999. The `'["pid:999999"]'` / `"pid:999999"` literals in `NON_STRING_STATE_CASES`/`NON_STRING_RENDER_CASES` were left as hardcoded string literals (not templated from `DEAD_PID`), per the ruling's explicit instruction that expected/matched values stay literal.

### 7-A (file-level collected-test-count criterion)

Chose the "actually count what Vitest collected" route rather than static source-line counting, so the criterion is tied to runtime reality, not text shape. Implementation, added entirely inside the existing describe block (no top-of-file import line touched, to stay inside "本轮新加的那个 describe 块"):

```ts
interface CollectedTask {
  type: string;
  tasks?: CollectedTask[];
}

function countCollectedTests(task: CollectedTask): number {
  if (task.type === "test") {
    return 1;
  }
  return (task.tasks ?? []).reduce((sum, child) => sum + countCollectedTests(child), 0);
}
```

The renamed test `"covers every non-string holder shape this round measured, and is actually consumed"` takes a `context` parameter and asserts:
```ts
expect(NON_STRING_STATE_CASES).toHaveLength(2);
expect(NON_STRING_RENDER_CASES).toHaveLength(2);
const collectedTestCount = countCollectedTests(context.task.file as unknown as CollectedTask);
expect(collectedTestCount).toBe(18);
```
`context.task.file` is Vitest's own collected task tree for the file (the `File` node, populated during the collection phase that completes before any test in the file runs), walked recursively counting `type === "test"` leaves — this is a genuine runtime count, not `grep -c 'it("'` and not a static parse.

## 4. Typecheck

```
npm run typecheck > /tmp/i2-typecheck.txt 2>&1; echo "RC=$?" >> /tmp/i2-typecheck.txt
```
Full readback:
```
> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

RC=0
```

## 5. Both files green (post-edit, main worktree)

```
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/unlock/inspectLock.test.ts tests/unlock/unlockCommand.test.ts > /tmp/i2-t3-both.txt 2>&1
echo "RC=$?" >> /tmp/i2-t3-both.txt
```
Full readback:
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/unlock/inspectLock.test.ts (18 tests) 20ms
 ✓ tests/unlock/unlockCommand.test.ts (33 tests) 46ms

 Test Files  2 passed (2)
      Tests  51 passed (51)
   Start at  01:55:12
   Duration  345ms (transform 114ms, setup 0ms, collect 168ms, tests 66ms, environment 0ms, prepare 102ms)

RC=0
```
**Measured file-level counts** (commit `105af50`, i.e. this run's state): `inspectLock.test.ts` = 18 tests, `unlockCommand.test.ts` = 33 tests — matching Task 3 brief's expected 33 and the ruling text's expected 18 for the changed file.

## 6. Ruling 7-D — clone-local mutation proof

```
mkdir -p <scratchpad>/i2-t3-verify
CLONE=<scratchpad>/i2-t3-verify/ccloop-clone
/usr/bin/git clone --local /Users/biran/code/skills/loop/ccloop "$CLONE" > /tmp/i2-t3-clone.txt 2>&1; echo "RC=$?" >> /tmp/i2-t3-clone.txt
```
RC=0 ("Cloning into ... done.").

Since `git clone --local` only carries committed history and my edits were still uncommitted at that point, the two modified test files were copied into the clone with `/bin/cp -f` (the interactive `cp`/`rm` aliases were bypassed as instructed):
```
/bin/cp -f tests/unlock/inspectLock.test.ts   "$CLONE/tests/unlock/inspectLock.test.ts"
/bin/cp -f tests/unlock/unlockCommand.test.ts "$CLONE/tests/unlock/unlockCommand.test.ts"
```
`/usr/bin/git status` inside the clone confirmed exactly those two files modified, nothing else.

`node_modules` was symlinked into the clone (`ln -s .../ccloop/node_modules node_modules`) rather than reinstalled, then `npm run build` was run inside the clone (RC=0) so `dist/cli.js` exists — required so `tests/control/endToEnd.test.ts` doesn't false-red, though that file wasn't run in the clone (only the two unlock test files were).

**Baseline in the clone (before mutation):**
```
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/unlock/inspectLock.test.ts tests/unlock/unlockCommand.test.ts > /tmp/i2-t3-clonebaseline.txt 2>&1; echo "RC=$?" >> /tmp/i2-t3-clonebaseline.txt
```
Full readback:
```
 RUN  v2.1.9 <clone path>

 ✓ tests/unlock/inspectLock.test.ts (18 tests) 21ms
 ✓ tests/unlock/unlockCommand.test.ts (33 tests) 50ms

 Test Files  2 passed (2)
      Tests  51 passed (51)
   ...
RC=0
```

**Mutation applied (clone only):** deleted the entire
`for (const { name, holder, assertPremise } of NON_STRING_STATE_CASES) { it(\`classifies ...\`, async () => { ... }); }`
block (lines 358–374 of the clone's `tests/unlock/inspectLock.test.ts` before deletion) — the whole generating loop, nothing else. Confirmed via `/usr/bin/git diff -- tests/unlock/inspectLock.test.ts` in the clone (full readback captured in `/tmp/i2-t3-mutation-diff.txt`): the diff shows only the two hunks that (a) restructure `NON_STRING_STATE_CASES`/add the helper/rewrite the "covers..." test (my Task-3 edit itself, present in both baseline and mutated copies since it was copied in already-edited) and (b) the deletion of the `for (const { name, holder, assertPremise } ...)` loop and its `it("classifies ...")` body — no other lines touched.

**Mutated run:**
```
./node_modules/.bin/vitest run tests/unlock/inspectLock.test.ts > /tmp/i2-t3-mutation-run.txt 2>&1; echo "RC=$?" >> /tmp/i2-t3-mutation-run.txt
```
Full readback:
```
 ❯ tests/unlock/inspectLock.test.ts (16 tests | 1 failed) 22ms
   × inspectOwnerTransferLock > a holder that is not a string at all (human ruling 127) > covers every non-string holder shape this round measured, and is actually consumed 4ms
     → expected 16 to be 18 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/unlock/inspectLock.test.ts > inspectOwnerTransferLock > a holder that is not a string at all (human ruling 127) > covers every non-string holder shape this round measured, and is actually consumed
AssertionError: expected 16 to be 18 // Object.is equality

- Expected
+ Received

- 18
+ 16

 ❯ tests/unlock/inspectLock.test.ts:355:34
    353|       expect(NON_STRING_RENDER_CASES).toHaveLength(2);
    354|       const collectedTestCount = countCollectedTests(context.task.file…
    355|       expect(collectedTestCount).toBe(18);
       |                                  ^
    356|     });
    357|

 Test Files  1 failed (1)
      Tests  1 failed | 15 passed (16)
   ...
RC=1
```
**Result: the new file-level criterion goes red (`expected 16 to be 18`) exactly reproducing the controller-measured "16 tests, all green under the old criterion" shape — confirming the new judgement is load-bearing against that mutation.**

Clone cleanup: `/bin/rm -f "$CLONE/node_modules"` (removed the symlink, not the real target) then `/bin/rm -rf "$CLONE"`. Confirmed main worktree untouched by re-running `git diff --stat` in the real repo afterward — it showed only the intended 3 files (`docs/handoff/handoff.md` pre-existing-not-mine, and my two test files), same as before the clone excursion.

## 7. Full suite, main worktree (post-edit, pre-commit)

```
npm test > /tmp/i2-t3-fullsuite.txt 2>&1; echo "RC=$?" >> /tmp/i2-t3-fullsuite.txt
```
Full readback: 777 tests total, 776 passed, 1 failed, RC=1.
The one failure:
```
FAIL  tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone
Error: Test timed out in 5000ms.
```
This is the one name on the pre-declared "stable red" list (⊆ the 6 known names). No other name in the known-6 set fired this run (the 5 load-flakes happened to pass), and **no name outside the known 6 appeared red**. Per the task's judgement rule (red set ⊆ known 6, checked by name), this run is acceptable.

## 8. Commit

```
/usr/bin/git add tests/unlock/unlockCommand.test.ts tests/unlock/inspectLock.test.ts
/usr/bin/git status   # confirmed only these two staged; handoff.md and the two untracked superpowers files excluded
/usr/bin/git commit -m "..."   # RC=0
```
Result: `[main 105af50] test(unlock): pin unattributable-holder survival at the command layer, and harden the I-2 non-string-holder criteria` — `2 files changed, 68 insertions(+), 9 deletions(-)`.

```
/usr/bin/git show --stat HEAD > /tmp/i2-t3-showstat.txt 2>&1; echo "RC=$?" >> /tmp/i2-t3-showstat.txt
```
```
 tests/unlock/inspectLock.test.ts   | 48 +++++++++++++++++++++++++++++++-------
 tests/unlock/unlockCommand.test.ts | 29 +++++++++++++++++++++++
 2 files changed, 68 insertions(+), 9 deletions(-)
RC=0
```

## 9. Final measured counts (commit 105af50)

- `tests/unlock/inspectLock.test.ts`: **18 tests** (measured by `vitest run`, §5 above).
- `tests/unlock/unlockCommand.test.ts`: **33 tests** (measured by `vitest run`, §5 above; matches brief's expected 33 = 32 original + 1 new).
- Full suite: **777 tests**, 776 passed / 1 failed (the one pre-declared stable-red name), RC=1 (§7 above).

## 10. Constraints honored

- No production code touched (only the two test files, per `git show --stat` above).
- No pre-existing comment text altered outside what Rulings 7-A/B/C required; the `isProcessActive(999999)` premise comment was carried verbatim (only its call site moved and the bare identifier became `DEAD_PID`).
- No subagent dispatched at any point in this task.
- No push, merge, or branch/worktree deletion performed. Mutation testing was done in a `git clone --local` copy under the scratchpad directory; the main worktree was never touched during the mutation step, confirmed by `git diff --stat` before/after.
- Every verification run was redirected to a file and read back in full (never piped through grep/tail/head/sed for a pass/fail verdict); reads above are the actual readback content, not summaries typed from memory.
- Only real tool-reported numbers appear above; nothing here is a self-estimate.
