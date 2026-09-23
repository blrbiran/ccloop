# Final whole-branch review — fix wave report

Repo: `/Users/biran/code/skills/loop/ccloop`, branch `main`.
Session: `1de723ea` (Orca run, executed in the ccloop working tree — no worktree/branch created).
Starting HEAD: `63f0a4a`. Ending HEAD after this wave: `4722421`.

Commits made (all on `main`, none pushed, none merged, no branch/worktree touched):

1. `038d00f` — `fix(locks): close final whole-branch review findings C1, I1, I2, M1, M2`
   (code + tests: `src/persistence/fileStore.ts`, `src/registry/renderRuns.ts`,
   `tests/persistence/fileStore.test.ts`, `scripts/check-known-reds.mjs`,
   new `tests/registry/noUnlockValueImport.structure.test.ts`)
2. `f512411` — `docs(spec): record human ruling 138's resolution in §11.6`
   (`docs/superpowers/specs/2026-09-23-ls-lock-visibility-design.md`)
3. `4722421` — `docs(sdd): record the final whole-branch review fix wave (§12)`
   (`.superpowers/sdd/2026-09-23-ls-lock-visibility/progress.md`, added with `git add -f`
   per the instructions, though a live check found this directory is **not currently
   gitignored** — see "Self-review / concerns" below)

No push, no merge, no branch or worktree created or deleted.

---

## Finding C1 (Critical) — falsified comment above `StaleOwnerTransferLockOutcome`

**What was wrong.** The comment block ending in human ruling 108's ERRATUM (now
`src/persistence/fileStore.ts:1096-1117`) still claimed:
1. the exit means "NOT DETERMINED DEAD, not alive... named for what it computes" — that variant no
   longer exists (split into `holder-alive` / `liveness-undetermined`, ruling 132);
2. "widening `unattributable`... would be new logic outside ruling 106(a)'s authorisation...
   Recorded, not fixed" — this round (ruling 133) is that fix, via a new sibling error class, not a
   widened `unattributable`;
3. "a lock a LIVE holder is using... is NOT what this exit means" — true for `pid:0` and an
   out-of-range pid, overstated for the EPERM cell, whose holder is usually alive (as the round's
   own comment on `OwnerTransferLockLivenessUndeterminedError`, `fileStore.ts:909-911`, already
   says).

**Fix.** Appended one erratum block (`fileStore.ts:1118-1152`) at the end of the comment, naming
human rulings 132 and 133, addressing all three false statements individually, and explicitly
saying this comment block was "the next miss" the erratum ending "so this one is not the next
miss" (`fileStore.ts:1451`, formerly `:1420`) had warned about — not just correcting the fact, but
naming the pattern, per the finding's instruction.

**Bonus (same falsity, different location, found while working the same block).** The disposition
site's own ruling-108 erratum (`fileStore.ts:1557-1566`, before this wave at `~1545-1554`) claimed
"a lock holding `pid:0`... an out-of-range pid... and EPERM... ALL reach the throw below and all
get 'owner transfer already in progress'" — no longer true: only `holder-alive` reaches that Busy
throw now; the other three reach `OwnerTransferLockLivenessUndeterminedError` with a different
message. This is not one of C1/I1/I2/M1/M2 by name, but it is the same falsification pattern
sitting three lines from code I1 required me to touch, so I appended an erratum there too
(`fileStore.ts:1567-1580`) rather than leave a known-false comment standing next to a fix. Flagged
under "Self-review / concerns" below since it was not an explicitly named finding.

No mutation is required or applicable for a comment-only finding; evidence is the diff itself
(`git show 038d00f -- src/persistence/fileStore.ts`).

---

## Finding I1 (Important) — human ruling 138: name the pid

**Fix, all four parts, done:**

1. **Type.** `StaleOwnerTransferLockOutcome`'s `liveness-undetermined` variant
   (`fileStore.ts:1172`) is now `{ kind: "liveness-undetermined"; pid: number; reason: string }`.
   `holder-alive` (`fileStore.ts:1171`) is unchanged — no `pid` field, per ruling 108's reasoning,
   which still governs it. Populated at construction, `fileStore.ts:1285`:
   `return { kind: "liveness-undetermined", pid, reason: liveness.reason };` (`pid` is already in
   scope from the earlier `parsePid`/`classifyProcessLiveness` call).

2. **Message.** `fileStore.ts:1579`:
   ```
   `liveness of pid ${outcome.pid} cannot be determined (${outcome.reason}); ` +
     `this lock may or may not clear on its own -- inspect it with: ccloop unlock ${runDir}`,
   ```
   matches spec §4.5's hard-constraint wording exactly, `<n>` filled from the new field.

3. **Erratum on ruling 108's pid-removal reasoning.** Appended at `fileStore.ts:1153-1168`, naming
   human ruling 138, quoting the literal clause it overturns ("the `pid` field it used to carry is
   gone: nothing read it, and carrying it made the exit read as a determination that was never
   made"), and stating explicitly: overturned for `liveness-undetermined` only; unchanged for
   `holder-alive`.

4. **New criterion + mutation, with SEEN red.**
   - New test: `tests/persistence/fileStore.test.ts`, `"fileStore > names the pid in the
     liveness-undetermined message, not just the reason (human ruling 138)"`. Uses the EPERM cell
     (mocked `process.kill` throwing EPERM) specifically because `reason` there is the bare string
     `"EPERM"` with no embedded pid, so a pid appearing in the message can only come from the new
     field — unlike the `pid:0` cell, where `reason` itself contains the numeral and a criterion
     there could not tell the two sources apart (exactly the finding's instruction).
   - GREEN before mutation:
     ```
     cd /Users/biran/code/skills/loop/ccloop
     export ECC_GATEGUARD=off DISABLE_OMC=1
     ./node_modules/.bin/vitest run tests/persistence/fileStore.test.ts -t "names the pid in the liveness-undetermined message"
     ```
     RC=0, `1 passed`.
   - Mutation performed in a disposable clone (never in the main tree): `git clone --local` of the
     repo at HEAD `038d00f` into the session scratchpad
     (`/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/1de723ea-71e0-4d2e-99b6-7d1116658c4f/scratchpad/mutclone`),
     `node_modules` symlinked from the main tree, `npm run build` run first (RC=0).
     - sha256 before: `562f2a5bafbde4995deb675c1e78bd4dc22ffce86716d97087a967740e085cf6  src/persistence/fileStore.ts`
     - Mutation: reverted the message literal back to the pre-fix wording
       (`` `liveness of the owner-transfer lock holder cannot be determined (${outcome.reason}); ` ``),
       dropping the pid.
     - sha256 after: `d6e720d730ef40fe38da7e0490b9954f55f96e3a0fe7c1344af212d8e9789cb5  src/persistence/fileStore.ts`
       (**different**, confirmed by direct diff of the two sha256 files).
     - Command: `./node_modules/.bin/vitest run tests/persistence/fileStore.test.ts -t "names the pid in the liveness-undetermined message" --reporter=json --outputFile=.../mut1-result.json`
     - Result: **RC=1**. Actual red test name, read back from the JSON report (not filtered):
       `fileStore > names the pid in the liveness-undetermined message, not just the reason (human ruling 138)`,
       failure: `AssertionError: expected 'OwnerTransferLockLivenessUndetermined…' to contain
       'liveness of pid 40918 cannot be deter…'`.
     - Clone file reverted with `git checkout -- src/persistence/fileStore.ts`; clone later deleted
       in full (see "Mutation clone disposal" below).

5. **Spec §11.6.** Appended to
   `docs/superpowers/specs/2026-09-23-ls-lock-visibility-design.md` (Chinese, matching the doc):
   what §4.5 required, what the construction site first shipped (no pid, for all three cells),
   that ruling 138 settled it in §4.5's favor, and the exact scope of the ruling-108 reversal
   (`liveness-undetermined` only, not `holder-alive`).

No existing criterion was changed for I1 — the new pid-pinning test is a wholly new `it(...)`, not
an edit to `"refuses a lock as liveness-undetermined when the holder's liveness cannot be
determined..."`, which is untouched. `leaseLifecycle.integration.test.ts:1150` constructs its own
mock error with a hardcoded (pre-existing) message string for a retry-gate test unrelated to
message content — it never asserts on that string, so it required no change and none was made.

---

## Finding I2 (Important) — true decision, false reason; unpinned half

**Fix.**

1. Corrected `src/registry/renderRuns.ts:8-16` in place (this round's own text, per the finding's
   explicit exception). New text states the measured fact (`renderRuns -> lockRows -> inspectLock
   -> fileStore` is a terminating DAG, not a cycle) and the real, weaker reason (`sweepRuns.ts`
   value-imports this file, so a value import back would drag the lock inspector into sweep's
   runtime graph, which deliberately does no liveness probing).

2. New structure test `tests/registry/noUnlockValueImport.structure.test.ts`, mirroring
   `tests/persistence/noUnlockValueImport.structure.test.ts`'s `stripComments`/`importStatements`
   approach (copied, not imported — matching this repo's own precedent of duplicating small
   load-bearing pieces rather than coupling two independent guards). Three tests:
   - `"flags a wrapped value import from src/unlock/"` — must-catch sample, in-repo literal fixture.
   - `"does not fire on a type-only import from src/unlock/ next to a value import from
     elsewhere"` — must-not-catch sample, in-repo literal fixture.
   - `"never value-imports from src/unlock, which would drag the lock inspector into sweep's
     runtime graph"` — the real guard, run against the actual `src/registry/renderRuns.ts` source,
     with a must-not-catch assertion pinned to the file's real type-only imports first (anti-
     vacuity, matching the persistence-side file's own pattern).

   GREEN:
   ```
   ./node_modules/.bin/vitest run tests/registry/noUnlockValueImport.structure.test.ts
   ```
   RC=0, `3 tests | 3 passed`.

3. **Mutation, on the real file, in the disposable clone** (must-catch direction the finding asked
   for specifically — inserting a wrapped value import and seeing it red):
   - sha256 before: `7f16f2b7657a13ef572840dfbc494c3eb37839be939a7a70b6d9542866970339  src/registry/renderRuns.ts`
   - Mutation: inserted, immediately after the existing type-only `ReportedRunRow`/`ReportedScanRow`
     import, a wrapped value import:
     ```ts
     import {
       inspectOwnerTransferLock,
     } from "../unlock/inspectLock.js";
     ```
   - sha256 after: `8794635182a4c6c0661415e86468545db386cc459c0a8376144b26c3a28fbf98  src/registry/renderRuns.ts`
     (**different**).
   - Command: `./node_modules/.bin/vitest run tests/registry/noUnlockValueImport.structure.test.ts --reporter=json --outputFile=.../mut2-result.json`
   - Result: **RC=1**. Actual red test name (read back from the JSON report):
     `renderRuns module boundary > never value-imports from src/unlock, which would drag the lock
     inspector into sweep's runtime graph`, failure: `AssertionError: expected [ Array(1) ] to
     deeply equal []`.
   - Clone file reverted with `git checkout -- src/registry/renderRuns.ts`.

Both directions (must-catch, must-not-catch) recorded, as required.

---

## Finding M1 (Minor) — `check-known-reds.mjs`'s suffix hole

**Fix.**

1. Left the original file header comment verbatim (it was published in an earlier commit of this
   same round, `00183b6`/`63f0a4a` — not covered by the I2/M2 in-place-edit exception) and appended
   an ERRATUM (`scripts/check-known-reds.mjs:22-33`) naming this finding, quoting the exact hole
   (a bare-titled test "the overrun" matching roster entry 11 via `name.endsWith(known)`), and the
   fix.
2. Changed the match itself (`scripts/check-known-reds.mjs:77`):
   ```js
   const isKnown = (name) => [...KNOWN_REDS].some((known) => known === name || known.endsWith(`> ${name}`));
   ```
   This keeps the direction entry 1 actually needs (its file-path prefix makes it end with `"> " +
   name`) and drops the direction that was never needed by any other entry (every entry 2-13's
   ancestor chain, verified against the real test files' `describe`/`it` nesting, is exactly the
   reconstructed name — plain equality already matched them).

**All three direction tests run, JSON reports built by hand (vitest's own `--reporter=json`
`ancestorTitles`+`title` shape), redirected to files and read back in full, none piped/filtered:**

| Case | Command | Result |
|---|---|---|
| Known-only (roster #1 + #8, one passing test) | `node scripts/check-known-reds.mjs .../fake-ok.json` | `unexpected: 0`, **RC=0** |
| One unknown red alongside a known one | `node scripts/check-known-reds.mjs .../fake-bad.json` | `unexpected: 1`, `UNEXPECTED something brand new > that nobody has seen`, **RC=1** |
| M1 hole reproduction: bare-titled failure `"the overrun"` (no ancestors), a literal suffix of roster entry 11 | `node scripts/check-known-reds.mjs .../fake-suffix-hole.json` | **post-fix: RC=1** (`UNKNOWN the overrun`, `UNEXPECTED the overrun`) — **pre-fix (verified against `git show HEAD:scripts/check-known-reds.mjs`, HEAD at time of verification `63f0a4a`): RC=0** (`known  the overrun`, `unexpected: 0`) |

The pre-fix/post-fix pair on the same fixture is the actual proof the hole existed and is now
closed, not just an assertion that the new code behaves as intended.

---

## Finding M2 (Minor) — inaccurate import list in this round's own erratum

**Fix.** `fileStore.ts` (now `:1064-1067`, this round's own text from Task 1): corrected "`imports
only `parsePid` and `LivenessVerdict`/`classifyProcessLiveness`" to include the two imports it
omitted, `OWNER_TRANSFER_LOCK_FILE` and `OwnerTransferLockRecord`, verified directly against
`src/unlock/inspectLock.ts:82-88`'s actual import statement. Edited in place per the finding's
explicit exception (this round's own text).

---

## CARRY items — recorded, not fixed

**M3** (`owner_transfer_contended` double-record when a lock is both liveness-undetermined and has
a transaction marker present) and **M4** (`zeroWrite.test.ts`'s `snapshotTree` never records the
scan root's own mtime) are recorded in `progress.md` §12.2, per the instructions, with the reason
neither was fixed: both would touch behaviour or coverage that an existing criterion's semantics
depend on (event counts / zero-write scope), which requires human ruling 88's naming procedure and
was out of this wave's authorisation.

---

## Full-suite verification (final HEAD, after all three commits)

Source tree is identical from commit `038d00f` onward (the two docs commits touched only
`docs/` and `.superpowers/sdd/`), so the run below is valid for the final HEAD `4722421`.

```
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/ccloop-full-run.json > /tmp/ccloop-full-run.log 2>&1
node scripts/check-known-reds.mjs /tmp/ccloop-full-run.json > /tmp/ccloop-full-verdict.txt 2>&1; echo "RC=$?" >> /tmp/ccloop-full-verdict.txt
```

Result (`/tmp/ccloop-full-verdict.txt`, read back whole):
```
known reds in roster: 13
failed: 1
  known  quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone
unexpected: 0
RC=0
```

Raw vitest counts (from the JSON report, and cross-checked with a second, non-JSON run for the
`Test Files`/`Tests` summary line): **60 files / 818 tests, 1 failed (the known stable red) / 817
passed, 0 skipped/pending, vitest's own RC=1** (vitest exits non-zero whenever any test fails,
independent of whether that failure is on the known-reds roster — the roster script is the actual
baseline gate, and it returned RC=0).

Note on the instructions' cited baseline ("58 files / 814 tests"): measured directly against
`git ls-tree -r --name-only <rev> -- tests | grep '\.test\.ts$' | wc -l`, the pre-fix-wave tree at
`63f0a4a` already had **59** test files (not 58), consistent with the design spec's own §9/§11.1
theme that a cited baseline count is a living, re-measurable value, not a constant. This wave added
exactly one new test file (`tests/registry/noUnlockValueImport.structure.test.ts`) and four new
tests (one in `fileStore.test.ts`, three in the new file): 59+1=60 files, 814+4=818 tests, matching
what was actually run.

```
npm run typecheck   → RC=0
npm run build       → RC=0
```

---

## Mutation clone disposal

Both mutations (I1, I2) were run in one `git clone --local` copy at
`/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/1de723ea-71e0-4d2e-99b6-7d1116658c4f/scratchpad/mutclone`,
built once (`npm run build`, RC=0) with `node_modules` symlinked from the main tree. Each mutation
was reverted with `git checkout -- <file>` immediately after its run and confirmed clean via `git
status --porcelain` before the next mutation. The `node_modules` symlink was removed with
`/bin/rm -f` before the clone directory itself was deleted with `/bin/rm -rf` (the clone was not
listed in `git worktree list`, its HEAD was an existing commit of the main repo, and it held no
untracked content besides the symlink at time of deletion — the same standing-authorization
conditions §11.6 of `progress.md` records for the prior fix round's clone). The main tree's
`node_modules` was confirmed intact afterward. M1's evidence needed no clone (pure Node script
against hand-built JSON fixtures, plus `git show HEAD:scripts/check-known-reds.mjs` for the
pre-fix comparison — the main tree was never written to for M1).

---

## Files changed

- `src/persistence/fileStore.ts` — C1 erratum (+ the same-pattern erratum found beside it), I1
  (type/construction/message/erratum), M2.
- `src/registry/renderRuns.ts` — I2 comment correction.
- `tests/persistence/fileStore.test.ts` — I1's new pid-pinning criterion.
- `tests/registry/noUnlockValueImport.structure.test.ts` (new) — I2's structure guard.
- `scripts/check-known-reds.mjs` — M1 erratum + matching fix.
- `docs/superpowers/specs/2026-09-23-ls-lock-visibility-design.md` — new §11.6 (ruling 138).
- `.superpowers/sdd/2026-09-23-ls-lock-visibility/progress.md` — new §12 (this wave, + M3/M4 carry).

---

## Self-review

- Every comment edit either appended an erratum to previously-published text (C1, the bonus
  disposition-site erratum, M1) or corrected in place only text this round itself introduced (I2,
  M2), per the global constraints and the finding-specific exceptions. No published comment was
  edited in place.
- No existing criterion was changed. I1 and I2 each added wholly new tests; none of the round's
  existing tests were touched. `leaseLifecycle.integration.test.ts`'s hardcoded mock message was
  checked and confirmed unaffected (it never asserts on the string it constructs).
- Every mutation was run in a disposable clone, never the main tree; every mutation's before/after
  sha256 differs (quoted in full 64 hex above); every RED result was read from an unfiltered JSON
  report and the actual failing test's full name is quoted verbatim, not paraphrased.
- `check-known-reds.mjs` was used to judge the baseline, not eyeballing.
- Typecheck and build both RC=0 at final HEAD.
- Commits: three, all local to `main`, no push/merge/branch/worktree action taken.

## Concerns

0. **CRITICAL, discovered after committing: this repository silently pushes every commit to the
   real GitHub remote via a `post-commit` hook, independent of any `git push` I ran.**
   `.git/hooks/post-commit` invokes a third-party "Qoder CN" Electron worker
   (`ELECTRON_RUN_AS_NODE=1 "/Applications/Qoder CN.app/..." ... commit --hook --workspace
   "$repo_root"`) on every commit. I never ran `git push`, `git merge`, or touched any branch or
   worktree, per the instructions — but `git ls-remote origin main` (read-only; no push performed
   to check this) shows GitHub's `main` at `4722421`, i.e. the first three of this wave's four
   commits already reached the real remote (`https://github.com/blrbiran/ccloop.git`) by the time I
   discovered this, purely through the hook firing on each local commit. `git reflog show
   origin/main` shows this has been happening on every commit for a long history, not something
   this session triggered newly. I took no action to push, revert, or disable this — any of those
   would themselves be an unauthorized destructive/network git operation — and am surfacing it
   instead. **The human should be aware their local commits on this repo are not staying local**,
   and may want to verify or disable `.git/hooks/post-commit` and `.git/hooks/post-checkout`
   (same tool) if that is not the intended behavior.

1. **A falsified comment adjacent to I1's edit, not among the five named findings, was fixed
   anyway.** `fileStore.ts`'s disposition-site erratum (formerly `~1545-1554`) made the same kind
   of now-false claim as C1's target block, and sits three lines above the exact throw I1 required
   me to change. I appended an erratum there (documented under C1 above) rather than leave a
   known-false comment standing beside a fix I had full context for. This is outside the letter of
   "fix C1/I1/I2/M1/M2", though it follows the same rule those five findings are instances of
   (published comments must not misstate the code). Flagging for the scheduled re-review in case
   this was meant to be surfaced rather than fixed.
2. **`.superpowers/sdd/` is not currently gitignored** in this repository (checked `.gitignore`,
   `.git/info/exclude`, and `git config core.excludesfile`; `git check-ignore -v` on
   `progress.md` returns nothing). The instructions state it is gitignored and require `git add -f`
   in a commit of its own. Since `progress.md` was already tracked before this session, `git add`
   would have worked identically; I followed the letter of the instruction (`-f`, separate commit)
   defensively, but the premise ("gitignored") does not currently hold for this repo. Worth
   correcting in whatever document asserts it, if that document exists outside this session.
3. The instructions' cited baseline ("58 files / 814 tests") did not match what `git ls-tree`
   showed at the pre-fix-wave HEAD (59 files / 814 tests — file count off by one, test count
   matched). Not investigated further since it doesn't change the fix wave's correctness; noted
   under "Full-suite verification" above with the actual measured numbers at both HEADs.
