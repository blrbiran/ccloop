# Scoped Re-Review — Task S4, Fix Round 1

Range under review: `f49f4b9..b85e86b` (2 commits). Task full range `8ae495f..b85e86b`, read for context only.
Working tree HEAD is `79f2a7b`, a controller bookkeeping commit whose numstat is `90 1
.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` — I verified it touches nothing in `src/`
or `tests/`, so every run below is equivalent to `b85e86b` for the code under review.

All commands ran through `rtk proxy`, from scripts on disk (`rtk proxy zsh <script>`), with full
output tee'd to files and the *files* searched afterwards. No verification run was filtered.
Environment: `ECC_GATEGUARD=off DISABLE_OMC=1`.

## 1. Verdicts (conclusions first)

### Important-1 — **ADDRESSED**

Both no-space spellings that defeated the old regexes now turn the structure test **red on an
assertion**, while `tsc` still exits 0 (i.e. the bypass compiles — the test is what catches it,
which is the point of the finding). My own runs, from a pristine backup, mutating
`src/controller/runLoop.ts` at the `#7` write site:

| case | injected | `tsc` | structure test |
|---|---|---|---|
| `D_nospace_full` | `import{writeRunState as W}from"../persistence/fileStore.js";` + `await W(runDir, state);` | `TSC_EXIT=0` | **`STRUCT_EXIT=1`** |
| `D_ns_nospace` | `import*as rrvns from"../persistence/fileStore.js";` + `await rrvns.writeRunState(runDir, state);` | `TSC_EXIT=0` | **`STRUCT_EXIT=1`** |

Red by assertion, not by exception or timeout, with non-zero counts:

- `D_nospace_full`: `AssertionError: expected [ 'execFile', 'promisify', …(43) ] to not include
  'writeRunState'` at `ownedRunStateWriter.structure.test.ts:113`, 28 ms;
  `Test Files 1 failed (1)` / `Tests 1 failed (1)`.
- `D_ns_nospace`: `AssertionError: expected [ '../persistence/fileStore.js' ] to deeply equal []`
  at `:123`, 42 ms; `Test Files 1 failed (1)` / `Tests 1 failed (1)`.

Baseline before mutation, non-zero count: `✓ … (1 test) 38ms` / `Test Files 1 passed (1)` /
`Tests 1 passed (1)` / `BASE_STRUCT_EXIT=0`. Green-after-restore is the final full suite in §4.

The mechanism is now `ts.createSourceFile(...)` + a walk over top-level `ImportDeclaration`
statements, taking `(element.propertyName ?? element.name).text` for named specifiers — I read the
code, and it is exporting-side names, so aliases are caught under the exported name. Both regexes
are gone from the file: the diff deletes both the `const importClause = /import\s+…/g` and the
`const namespaceImport = /import\s+\*\s+as…/g` declarations, and the only surviving `import\s`
occurrence in the file is 1 hit inside a comment describing the retired regex (sanity: 33 lines in
that file contain `import`; must-miss probe 0).

**The overclaiming sentences were also fixed rather than merely weakened**, which is the stronger of
the two remedies the review demanded.

### New Critical / Important breakage introduced by the fix diff — **none found**

## 2. The two contested Minor claims

### Implementer's claim "Minor-1 (lazy regex swallowing a neighbouring import) is mooted" — **CORRECT**

Verified two ways, not taken on his word: (a) the lazy `([\s\S]*?)` capture no longer exists — the
whole `importClause` regex is deleted and named specifiers come from AST nodes, so there is no
scan that can run past a statement boundary; (b) empirically, my `D_nospace_full` red case reports
operand `…(43)`, the same list length the first reviewer measured for his *correct* red cases,
whereas the case that exposed Minor-1 measured `42`. The list is no longer being eaten.

### Implementer's claim "Minor-3 (namespace check scoped by path substring) is NOT mooted" — **CORRECT; the first reviewer's §8 was wrong on this point**

`ownedRunStateWriter.structure.test.ts:123` still reads

```ts
expect(namespaceImportedModules(source).filter((module) => module.includes("fileStore"))).toEqual([]);
```

Parsing changed how specifiers are *obtained* (exactly, from `statement.moduleSpecifier.text`); it
did not change how they are *filtered*. A namespace import of a barrel whose path lacks `fileStore`
is still uncovered. The first reviewer's recommendation that a `ts.createSourceFile` walk "retires
Important-1, Minor-1 and Minor-3 together" is false for Minor-3, and the implementer is right to
have corrected it in his §F6 instead of quietly inheriting the claim.

The condition stays latent, not live: my unfiltered sweep over all 30 `src/**/*.ts`
(`SWEEP_FILES=30`, must-hit `export function` = 16 files, must-miss `zzq-nonsense-token` = 0 files)
shows every occurrence of `writeRunState` in `src/`, and the only import and the only call are both
in `ownedRunStateWriter.ts` (`:1` and `:167`). The only `export … from` re-exports in `src/` are
`runLoop.ts:47` (`AttemptContext`, a type) and `src/index.ts:1-4`
(`main`/`parseArgs`/`loadContract`/`resumeLoop`/`runLoop`). No barrel re-exports `writeRunState`.

## 3. The things the brief told me to establish with my own hands

**Did the parse catch anything it should not?** No false positive found.

- `FP_comment` (a commented-out `// import { writeRunState } from "…"` line in `runLoop.ts`):
  `TSC_EXIT=0`, `STRUCT_EXIT=0` — stays green, as the assertion's own comment promises
  ("`writeRunState` appearing in prose or in a comment cannot fail it").
- Clean tree: green, and the anti-vacuity anchor `expect(imported).toContain("appendEvent")` holds.
- `TYPEONLY` (`import type { writeRunState } from "…"`, no call): `STRUCT_EXIT=1`. A type-only
  import cannot write anything, so this is *over*-strict. It is **not new** — the retired regex
  carried `(?:type\s+)?` and `.replace(/^type\s+/, "")`, so it counted type imports too — and it
  fails loud rather than green. Recorded, not a finding.
- `NS_BLOCK` (import inside a `namespace` block, an escape the AST walk does not visit because it
  only iterates `sourceFile.statements`): closed by the compiler —
  `src/controller/runLoop.ts(15,39): error TS1147: Import declarations in a namespace cannot
  reference a module.`, `TSC_EXIT=2`. So the top-level-only walk is not a live hole.

**Is the honest-limit paragraph still honest post-fix, or has it drifted optimistic?** It moved in
the *conservative* direction, not the optimistic one: pre-fix it named one open path (direct
`writeFile`); post-fix it names three (direct `writeFile`, dynamic `import()`, third-module
delegation) and the test file names the same three plus the Minor-3 barrel limit. That matches the
first reviewer's measured table (rows 7/9/10 still open). Two nits, neither blocking, both in §6.

**Is the erratum faithful to what it quotes?** Yes, verified against the objects, using
`bash -c 'git show …'` (not zsh):

- The *second* erratum quotes the now-false wording as *"…and a test reads runLoop.ts's source and
  fails if that import specifier reappears"*. At `f49f4b9`, `ownedRunStateWriter.ts` reads
  *"…and a / test reads runLoop.ts's source and fails if that import specifier reappears"*. Verbatim
  match; the elided lead-in is marked with an ellipsis. The old wording is **quoted, not deleted**,
  and the new sentence (ii') is rewritten in place above it — a second named erratum, exactly as the
  implementer says.
- The *first* erratum's two quotations of BASE `runLoop.ts` still stand untouched by this fix and
  still match `8ae495f`: "…goes through here, and `writeRunState` is called from exactly one place
  in this module — the line below." and "The completeness argument is therefore no longer 'I audited
  the call sites and they are covered'; it is 'this module cannot write a run state except through
  this function', which is a property a reader can check with one grep instead of an audit that
  already went wrong once."

**Is `package.json` genuinely untouched?** Yes, over the **full** task range, not just the fix:
`git diff --numstat 8ae495f b85e86b -- package.json` produces **0 lines**. `devDependencies` are
still exactly `@types/node`, `tsx`, `typescript`, `vitest`; `typescript` was already there, so the
`import ts from "typescript"` in the test adds no dependency. No linter, no new toolchain.

**Was any existing test judgment changed anywhere in the task range?** No.
`git diff --numstat 8ae495f b85e86b` for `tests/` is `125 0` and `131 0` — **zero deleted lines**
across the whole task. Within the fix range the structure test is `65 40`, but that file was created
*inside this task* and, decisively, **not one `expect(` line was added or removed by the fix**:
`grep -c "^[-+].*expect(" ` over the `-U0` diff = **0**, against a sanity count of **107** changed
`+`/`-` lines in that same diff and a must-miss probe of 0. The fix changed comments and the two
helper *implementations* only; all five assertions are context lines. `tests/persistence/fileStore.test.ts`
and `tests/controller/leaseLifecycle.integration.test.ts` are not in the range at all (option (c)
not attempted).

## 4. Full-suite / tsc / build on the fixed tree

`RUN` first line verified as this worktree:

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4
…
 Test Files  31 passed (31)
      Tests  520 passed (520)
   Duration  17.77s
TEST_EXIT=0
TSC_EXIT=0
BUILD_EXIT=0
```

Searching the tee'd log: `FAIL` lines = **0**, against a sanity count of 102 `✓` lines. Identical
31 files / 520 tests to the pre-fix figure, so the fix neither added nor removed a test. None of the
two allowed flakes and none of the one on-the-books failure appeared this round; per the standing
ruling I record that as "did not reproduce this round" and nothing more — it is not evidence the
ENOENT `plan.json` failure is harmless, and I did not investigate it.

## 5. Mutations and restoration proof

**5 mutations**, all to `src/controller/runLoop.ts`, each applied by a script from a pristine backup
(`BACKUP_BYTES=67591`) and restored by copying that backup back before the next case. No temporary
module files were created; nothing outside this worktree and the scratchpad was written; nothing was
pushed, merged, committed, or deleted; the main checkout was never touched.

| # | case | restored |
|---|---|---|
| 1 | `D_nospace_full` | ✅ `RESTORED_DIFF_BYTES=0` |
| 2 | `D_ns_nospace` | ✅ `RESTORED_DIFF_BYTES=0` |
| 3 | `FP_comment` | ✅ `RESTORED_DIFF_BYTES=0` |
| 4 | `NS_BLOCK` | ✅ `RESTORED_DIFF_BYTES=0` |
| 5 | `TYPEONLY` | ✅ `RESTORED_DIFF_BYTES=0` |

Three-part proof after the last case, and again after the full suite:

```
GIT_DIFF_RAW_BYTES=0
GIT_DIFF_CACHED_RAW_BYTES=0
GIT_DIFF_RAW_BYTES_AFTER=0        (re-measured after the full suite + tsc + build)
MARKER_RRV_MUT_S4=0               (files under src/ and tests/ containing my marker)
SANITY_HIT_createOwnedRunStateWriter=2
SANITY_MISS_zzq-nonsense-token=0

git status --porcelain (raw):
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/rereview-s4.diff
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/rereview-s4.md
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-s4.md
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-s4.diff
```

The only untracked entries are the review packages and the two review reports.

**One process disclosure of my own**: my first sweep script used an unquoted `--include=*.ts`, which
zsh globbed away — the sweep printed `MUSTHIT_export_function=0` and errored. Because the must-hit
probe was zero I treated the whole sweep as void and re-ran it quoted (`--include='*.ts'`), where
the must-hit probe read 16. No conclusion in this report rests on the broken run. This is exactly
the failure mode rule 5 exists for, and the probe caught it.

## 6. Deferred, out of scope (no verdict requested; nothing here blocks)

1. **Minor-2** (anti-vacuity anchor is the foreign symbol `appendEvent`) — untouched by the fix, as
   instructed. Still stands as the first reviewer described it.
2. **Minor-3** — see §2. The implementer added a comment stating the substring limit; the assertion
   is unchanged. He flagged it himself as "口径补充, not a fix" and offered to have it deleted.
3. **Minor-4** (erratum travelled with the code) — untouched, controller's call.
4. **New, minor, mine — the src-side limit list can read as exhaustive.** The erratum in
   `ownedRunStateWriter.ts` says "Three paths are STILL OPEN"; the Minor-3 barrel case is a fourth
   and is disclosed only in the test file. A reader stopping at the source comment could take three
   as the complete boundary. Non-blocking: the erratum points at the test file, and the barrel does
   not exist today (§2).
5. **New, minor, mine — provenance of "were each measured open".** That phrase is now in `src/`.
   The three paths were measured by the independent reviewer in review round 1, not by the
   implementer in this fix round. The comment does not attribute, so it is not *wrong*; I record it
   because this repository cares about who measured what.
6. **Over-strictness on `import type { writeRunState }`** (§3). Pre-existing behaviour, fails loud.

## 7. Token usage

**I cannot read a harness-measured token number from inside this subagent context, so I am giving
none, and no estimate follows.** The controller should read this re-review's actual usage from the
harness side.

Objective quantities I did measure: 1 full-suite run (17.77 s) plus `tsc --noEmit` and
`npm run build`; 5 additional `tsc` invocations; 6 single-file vitest runs (1 baseline + 5 cases);
5 injected-and-reverted mutations; 2 unfiltered repo sweeps over all 30 `src/**/*.ts`.
