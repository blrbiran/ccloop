# Task 4 report — comment-only ERRATUM pass

Read only `.superpowers/sdd/2026-09-23-i2-array-holder-coercion/task-4-brief.md` (not the full plan), per instruction.

## Step 1 — full-tree mechanical scan

Command run exactly as the brief specifies (measured on commit `9f5848b`, the commit this Task produced):

```
cd /Users/biran/code/skills/loop/ccloop
for w in "recorded, not fixed" "array holder" "array-holder" "no-pid-holder" "String()" "999999" "ruling 99" "ruling 94"; do
  echo "### $w"
  /usr/bin/grep -rin "$w" --include="*.ts" --include="*.md" src tests docs .superpowers
done > /tmp/i2-t4-scan.txt 2>&1; echo "RC=$?"
```
`RC=0`, `wc -l /tmp/i2-t4-scan.txt` → **578 lines**. Read back in full (two Read calls, offsets 1 and 298).

`docs/handoff/**` was included in scope this time (path `docs` is recursive) — 0 hits for any of the 8 terms (`grep -c "docs/handoff" /tmp/i2-t4-scan.txt` → 0). Nothing to report or touch there.

### Per-hit judgment

**Four required edits** (all in `src/`, matched brief §Steps 2–5, confirmed by reading the surrounding code before editing):

1. `src/persistence/fileStore.ts` — ERRATUM (Mi-2, HUMAN RULING 94), block ending `... "tidied" away silently. ***` (pre-edit line 1070). → **追**. Appended the brief's verbatim Step-2 text.
2. `src/persistence/fileStore.ts` — ERRATUM (M-2, HUMAN RULING 104), block ending `... putting it back. ***` (pre-edit line 970), immediately above `export function parsePid`. → **追**. Appended the brief's verbatim Step-3 text.
3. `src/persistence/fileStore.ts` — ERRATUM (I-1 of the ruling 106(b) review, HUMAN RULING 108), the **second** ruling-108 block (about the busy-message precedent, citing ruling 94's array-holder disposition), ending `... its array-holder cell. ***` (pre-edit line 1361). → **追**. Appended the brief's verbatim Step-4 text. (Distinguished from the *other* ruling-108 block at pre-edit line 1009–1023, about boolean→struct return semantics — that one is untouched; it is not about the array-holder cell.)
4. `src/unlock/inspectLock.ts` — ERRATUM (point B, HUMAN RULING 83), block ending `... not one shared answer. ***` (pre-edit line 34). → **追**. Appended the brief's verbatim Step-5 text.

**Two adjacent stale-text spots** (brief Step 6, text drafted by me since the brief gave content but not literal wording — kept to the same tag/convention as the other four, `(I-2, HUMAN RULING 127)`, since that is the ruling that authorized this round's ERRATUM pass; the *content* correctly attributes the underlying causes to ruling 106 and to this round's split, not to 127 itself):

5. `src/persistence/fileStore.ts` — ERRATUM (point B, HUMAN RULING 83), block ending `... did not. ***` (pre-edit line 958), containing "Under ruling 83 an unparsed holder **returns false**". Verified: after ruling 106 the function returns `{ kind: "unattributable", ... }`, never a literal `false`. → **追**.
6. `src/unlock/inspectLock.ts` — ERRATUM (I-3, human ruling 100), block ending `... found it. ***` (pre-edit line 49), containing `pid === null || isProcessActive(pid)`. Verified by reading the current `inspectOwnerTransferLock`/`classifyHolderLiveness` bodies: that combined expression no longer exists in this file — `classifyHolderLiveness` does its own `process.kill` and is never combined with `pid === null` in one boolean expression; `isProcessActive` is not called anywhere in `inspectLock.ts` (only named in comments). → **追**.

**Everything else in the scan** (test files, plan/spec/sdd markdown, `toISOString()`/`toString()` false positives from the `"String()"` substring search, other unrelated `HUMAN RULING 83/94/99/104/106/108` blocks not about the array-holder cell) was left alone — out of scope for this Task (comment edits are restricted to the two named source files) and/or not about the disposition this round changed.

### Seventh location?

Checked as a candidate: `src/unlock/unlockCommand.ts` has two of its own ERRATUM blocks (`point B, human ruling 83` and `M-3, human ruling 100`) that also discuss the "stranded set" / fail-closed disposition. Read both in full. Neither mentions the array-holder coercion or cites ruling 94's disposition — they describe the general parsed-vs-unparsed / live-vs-dead split, which ruling 127 does not change (the array holder now correctly lands in the "not a parsed `pid:<n>`" stranded set these paragraphs already describe; if anything ruling 127 makes them *more* accurate, not stale). **No seventh location found.** This is a judgment call, flagged for the controller to double-check if desired — I did not edit `unlockCommand.ts` either way, since it's outside this Task's file list regardless.

## Step 7 — mechanical checks (measured on the working tree just before commit, then re-verified against `9f5848b`)

**Byte scan.** The brief's literal command:
```
LC_ALL=C /usr/bin/grep -c $'\x00\|\x01\|\x02\|\x1f' src/persistence/fileStore.ts src/unlock/inspectLock.ts
```
→ `src/persistence/fileStore.ts:1798`, `src/unlock/inspectLock.ts:222`. These numbers equal each file's exact total line count (`wc -l`: 1798 and 222) — i.e. bash's `$'\x00...'` quoting truncates the argument at the embedded NUL, so grep actually received an **empty pattern**, which matches every line. This is a shell artifact of that specific command, not 1798/222 real hits. Cross-checked two ways: (a) the same command with `\x00` removed (`$'\x01\|\x02\|\x1f'`) → `0` and `0`; (b) a direct Python byte scan of the two files' raw bytes for `0x00,0x01,0x02,0x1f` → `bad_byte_count=0` for both (93965 bytes / 13868 bytes total). **Real result: zero forbidden bytes in both files.**

**Diffstat** (`/usr/bin/git diff --stat -- src`, taken before the add/commit):
```
 src/persistence/fileStore.ts | 34 ++++++++++++++++++++++++++++++++++
 src/unlock/inspectLock.ts    | 18 ++++++++++++++++++
 2 files changed, 52 insertions(+)
```
Only `+`, as expected.

**Deleted-line count** (python filter over `git diff -- src`, lines starting with `-` and not `---`): **0**. `cat /tmp/i2-t4-deleted.txt` was empty.

## Verification

- `export ECC_GATEGUARD=off DISABLE_OMC=1; npm run typecheck` → `TC_RC=0`, clean.
- `./node_modules/.bin/vitest run` (full suite, first pass) → `RC=1`, **Test Files 2 failed | 54 passed (56)**, **Tests 2 failed | 775 passed (777)**. Total test count matches the expected 777.
  - `tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone` — **matches the known stable-red baseline**.
  - `tests/runtime/codex/runCodexPhase.test.ts > Codex phase process > kills a TERM-ignoring process before returning abort` — `expected 'io-error' to be 'aborted'`. **NOT in the named baseline of 6.** This test spawns and kills real processes under a 5s-class deadline; our diff is comment-only in two unrelated files (`fileStore.ts`, `inspectLock.ts`), so there is no code path by which this Task's change could affect it.
  - Reran the two files in isolation (`vitest run tests/runtime/codex/runCodexPhase.test.ts tests/control/stopProof.test.ts`) → `RC=1`, but this time **all 16 tests in `runCodexPhase.test.ts` passed**, including "kills a TERM-ignoring process before returning abort"; only the known `stopProof` red remained. The non-baseline failure did not reproduce.
- **Conclusion, stated plainly rather than smoothed over**: across the two runs performed, the observed red set was `{stopProof (both runs)} ∪ {runCodexPhase TERM-ignoring (run 1 only, non-reproducing)}`. The stable red is confirmed present and named correctly. The one non-baseline failure is very likely the same class of load-sensitive timing flake this round's other 5 named flakes already are (all 5 of those passed in run 1), but it is a **different test name** than any of the 6 named in the baseline, so I am not silently folding it into "red ⊆ 6" — flagging it for the controller rather than asserting it away.

## Commit

```
commit 9f5848bf2da44c492434742a277a4eee0d0952ad
docs(comments): record what ruling 127 changed about the array-holder cell, and what it did not

 src/persistence/fileStore.ts | 34 ++++++++++++++++++++++++++++++++++
 src/unlock/inspectLock.ts    | 18 ++++++++++++++++++
 2 files changed, 52 insertions(+)
```
Only `src/persistence/fileStore.ts` and `src/unlock/inspectLock.ts` were staged and committed. `docs/handoff/handoff.md` (modified in the working tree, not by this Task) and the two untracked `docs/superpowers/*` files were left alone, not added.
