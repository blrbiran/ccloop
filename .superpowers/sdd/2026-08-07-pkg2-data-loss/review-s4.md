# Review — Package 2, Task S4 (independent reviewer)

Range under review: `8ae495f..f49f4b9` (branch `feat/pkg2-s4`)

<!-- SKELETON LANDED FIRST; sections filled in below, conclusions first. -->

## 1. Verdicts

**Spec compliance: ✅**
Both halves of the brief were delivered, and nothing beyond them. The change surface over
`8ae495f..f49f4b9` is exactly five files, one of which is the implementer's own report:

```
361	0	.superpowers/sdd/2026-08-07-pkg2-data-loss/task-s4-report.md
156	0	src/controller/ownedRunStateWriter.ts
6	129	src/controller/runLoop.ts
100	0	tests/controller/ownedRunStateWriter.structure.test.ts
131	0	tests/controller/runLoop.integration.test.ts
```

Zero deleted lines in `tests/`; zero `expect(` lines removed anywhere in the range; `package.json`
not in the range at all (`PKG_JSON_IN_RANGE=0`). No linter, no new devDependency, no spec touched,
option (c) not attempted. `runLoop.ts` no longer imports `writeRunState` (verified by reading the
file, not by trusting the report). The move is byte-faithful: comparing BASE `runLoop.ts`'s moved
region against the new module, after stripping pure-comment and blank lines and normalising the
added `export ` keywords, gives `BASE_CODE_LINES=57 / NEW_CODE_LINES=57 /
IDENTICAL_AFTER_COMMENT_STRIP= True`. The named erratum quotes both originals verbatim — I diffed
the quotations against `git show 8ae495f:src/controller/runLoop.ts` and they match.

**Quality: NOT APPROVED** — one Important finding must be addressed first.

The delivered code is correct and the tests are genuinely non-vacuous; I reproduced every mutation
claim in the report and all of them held. What blocks approval is not the code, it is a
**load-bearing completeness claim written into source that is false as written** — the same defect
class (F-1) that this whole package exists to fix. `ownedRunStateWriter.ts`'s erratum states the
new argument as *"a test reads runLoop.ts's source and fails if that import specifier reappears."*
It does not. Deleting one space character defeats it, and defeats the namespace half of it too.
See Important-1.

Findings: **0 Critical, 1 Important, 4 Minor.**

Mutations made by me: **12**, all proven restored (§6).

## 2. Findings

Anchors are by symbol name. Every finding carries a constructible scenario I actually ran.

---

### Important-1 — the new enforcement mechanism is whitespace-sensitive in exactly the way the old `grep` probe was, and both spellings of the check fall to it

**Symbols**: `importedNames` and `namespaceImportedModules` in
`tests/controller/ownedRunStateWriter.structure.test.ts`; the `ERRATUM` comment block above
`createOwnedRunStateWriter` in `src/controller/ownedRunStateWriter.ts`.

**Root cause.** `importedNames` matches `/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["'][^"']+["']/g`
and `namespaceImportedModules` matches `/import\s+\*\s+as\s+\w+\s+from\s+["']([^"']+)["']/g`. Both
require **at least one whitespace character immediately after the `import` keyword**. In JavaScript
and TypeScript that whitespace is optional before `{` and before `*`. An import written without it
is invisible to both regexes, so the import statement is not merely mis-parsed — it is not seen at
all, and the assertion list it should have contributed to is silently short.

**Constructible scenario A (named import).** Add one line to `runLoop.ts` immediately after the
existing `fileStore` import block:

```ts
import{writeRunState as W}from"../persistence/fileStore.js";
```

and change the terminal write inside the retry-cleanup `catch` (the `#7` site, the statement
following `appendTransitionEvent(runDir, state, "attempt_failed", String(error))`) from
`await writeOwnedRunState(runDir, state)` to `await W(runDir, state)`.

Measured outcome (case `D_nospace_full`, logs `case-D_nospace_full-{tsc,struct,n7}.log`):

```
TSC_EXIT[D_nospace_full]=0
 ✓ tests/controller/ownedRunStateWriter.structure.test.ts (1 test) 3ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
STRUCT_EXIT[D_nospace_full]=0
```

The guard is bypassed, the compiler is happy, and **the structure test is green**. The only thing
that catches it is the new `#7` behavioural regression (`N7_EXIT=1`) — i.e. the one write site that
happens to have a named test. The other eight write sites would be bypassed silently.

**Constructible scenario B (namespace import).** The namespace assertion — which the implementer
added specifically to close the hole he found himself (his report §8, defect 1) — falls to the same
single deleted space:

```ts
import*as ns from "../persistence/fileStore.js";
// … await ns.writeRunState(runDir, state);
```

Measured outcome (case `D_ns_nospace`):

```
TSC_EXIT[D_ns_nospace]=0
 ✓ tests/controller/ownedRunStateWriter.structure.test.ts (1 test) 3ms
STRUCT_EXIT[D_ns_nospace]=0
```

For contrast, the spaced forms of both are caught — `B_alias` and `B_namespace` both went red on
assertions (`STRUCT_EXIT=1`), so the test is not broken in general. It is broken for one specific,
cheap rewrite.

**Why this is Important and not Minor.** The bar this repository set for D-1 is explicitly
formatting-insensitivity: the acceptance probe that S4 exists to replace was defeated by, among
others, *a double space*. A mechanism that is defeated by *a deleted space* has not cleared that
bar, it has moved the same weakness from the call site to the import statement. There is no
formatter or linter in the repo (devDependencies are exactly `@types/node`, `tsx`, `typescript`,
`vitest`) to normalise the spelling away, so nothing else closes it.

**Why it is not Critical.** No production behaviour is wrong. The landed tree has no such import,
`tsc`/build/full suite are green, and the structural improvement (the writer genuinely lives
outside `runLoop.ts` now) stands on its own.

**What must change.** Either fix the check or stop overclaiming for it — the second is mandatory
either way, because the sentence is in *source*, where the next reader will rely on it:

- The claim in `ownedRunStateWriter.ts`'s erratum, *"a test reads runLoop.ts's source and fails if
  that import specifier reappears"*, and the parallel claim in
  `ownedRunStateWriter.structure.test.ts`'s header comment, *"runLoop.ts cannot call writeRunState
  — however it spells the call — without first importing the name. This test fails when that import
  comes back"*, are false as written and must state the whitespace precondition if they are kept.
- The cheap real fix needs **no new toolchain**: `typescript` is already a devDependency, so
  `ts.createSourceFile(...)` plus a walk over `ImportDeclaration` nodes gives an exact import list
  and retires the regex entirely. That is within the brief's "no linter / no new toolchain"
  constraint, since it adds no dependency. Minimally, `/import\s*(?=[{*])/` would close both
  spellings without a parser.

---

### Minor-1 — the `importedNames` regex silently swallows a neighbouring import when a statement does not match

**Symbol**: `importedNames`.

The capture group `([\s\S]*?)` is lazy but unbounded, so when an import statement's own
` from "…"` does not match, the scan runs on into the *next* import statement and consumes it.

**Constructible scenario** (case `B_nospacefrom`): add
`import { writeRunState as W } from"../persistence/fileStore.js";` (space after `import`, none
after `from`). The test does go red — but look at the operand it went red on:

```
AssertionError: expected [ 'execFile', 'promisify', …(42) ] to not include 'writeRunState'
```

`42`, where every other red case reported `43`. One legitimate import (`evaluatePathPolicy`) was
eaten by the lazy match. It caught the mutation by luck, on a name list that was already wrong.
The same mechanism means a future formatting change can silently drop names from the list the
assertions are made against — the assertion would then be true of a list that is not the module's
import list. Same fix as Important-1 (parse instead of regex).

---

### Minor-2 — the anti-vacuity anchor is a foreign symbol, so a legitimate refactor turns the guard test red for an unrelated reason

**Symbol**: `expect(imported).toContain("appendEvent")` in
`ownedRunStateWriter.structure.test.ts`.

The must-hit probe is `appendEvent`, an unrelated `fileStore` import of `runLoop.ts`. Constructible
scenario: a future change stops `runLoop.ts` from appending events directly (entirely plausible —
`appendTransitionEvent` already wraps most of that) and removes the import. The chokepoint test
then fails with "expected […] to contain 'appendEvent'", pointing a maintainer at a run-state
ownership test for a reason that has nothing to do with ownership. The failure is loud, so the harm
is confusion rather than a false green — hence Minor. An anchor that cannot disappear for unrelated
reasons (e.g. asserting the parse finds `createOwnedRunStateWriter`, whose presence *is* the
invariant) would be sturdier.

---

### Minor-3 — the namespace check is scoped by path substring, so it only covers specifiers containing `fileStore`

**Symbol**: `namespaceImportedModules(source).filter((module) => module.includes("fileStore"))`.

A namespace import of any module that re-exports `writeRunState` under a different path — a barrel
such as `src/index.ts`, or a future `src/persistence/index.ts` — is not covered. I confirmed no such
barrel currently re-exports it (§4, surface sweep over all 30 `src/**/*.ts`), so this is latent, not
live. Worth a sentence in the test comment, which today reads as though the namespace spelling is
closed outright.

---

### Minor-4 — the erratum's rewritten paragraph travelled with the code, leaving nothing at the original site

The two corrected sentences now live only in `ownedRunStateWriter.ts`. A reader arriving at the
place in `runLoop.ts` where the guard used to be gets the one-line pointer above
`persistTerminalState` ("…which task S4 in turn moved out of this module into
./ownedRunStateWriter.ts — see the erratum there"), which is honest and sufficient to navigate. I
record this only because the brief located the two sentences by `runLoop.ts` line number and a
reader checking that location will find neither the original nor the erratum. No action needed in
my view; flagged so the controller can rule if it disagrees.

---

### Not findings — three things I checked and cleared

- **Report §2 rows #2/#4/#5/#6 were labelled "挡住" on argument only.** I ran all four. All four
  produce `TS2304` and `TSC_EXIT=2`. The implementer's conclusion was right; the gap was only in
  evidence, and it is now closed (§3).
- **Report §2 rows #9/#10 were labelled "未验/仍然敞开".** I ran both. Both are indeed still open
  structurally, and both are caught behaviourally at site `#7`. The report understated nothing.
- **Report §8 defect 2** (the implementer used `| tail -20` once on a verification run, a stated
  discipline breach) is self-disclosed and the affected conclusion is one I independently re-derived
  from an unfiltered run of my own. Nothing to add.

## 3. The 7-shape table: independent re-verification

The implementer ran **one** of the seven and argued the rest. I ran all seven, plus the three extra
shapes he raised, plus two whitespace variants he did not consider. Every row below is a real run
with a real exit code, not an argument.

**Method.** The mechanism has two independent stages and they must be tested separately, because
each shape has two forms:
- **Stage A — the compiler.** With no import of `writeRunState` in `runLoop.ts`, does `tsc` reject
  the call? (`npm run build` and `npm run typecheck` both run `tsc -p tsconfig.json`.)
- **Stage B — the structure test.** With the import added back in some spelling, does
  `ownedRunStateWriter.structure.test.ts` go red?

A shape is blocked only if *both* stages hold. That decomposition is what exposes Important-1: some
import spellings pass stage B *and* stage A simultaneously.

Every mutation was applied at the `#7` write site (the statement after
`appendTransitionEvent(runDir, state, "attempt_failed", String(error))` inside the retry-cleanup
`catch`) by a scripted driver, then reverted, with `git diff` proven empty after each case.

### Stage A — the six call shapes, no import present

| # | shape as applied | `tsc` result | exit |
|---|---|---|---|
| 1 | `void writeRunState(runDir, state);` | `runLoop.ts(1476,16): error TS2304: Cannot find name 'writeRunState'.` | `TSC_EXIT=2` |
| 2 | `return writeRunState(runDir, state).then(() => state);` | `runLoop.ts(1476,18): error TS2304: Cannot find name 'writeRunState'.` | `TSC_EXIT=2` |
| 4 | `await  writeRunState(runDir, state);` (double space) | `runLoop.ts(1476,18): error TS2304: Cannot find name 'writeRunState'.` | `TSC_EXIT=2` |
| 5 | `await` ⏎ `writeRunState(runDir, state);` | `runLoop.ts(1477,13): error TS2304: Cannot find name 'writeRunState'.` | `TSC_EXIT=2` |
| 6 | `await Promise.all([writeRunState(runDir, state)]);` | `runLoop.ts(1476,30): error TS2304: Cannot find name 'writeRunState'.` | `TSC_EXIT=2` |

Shape 3 (aliased import) has no no-import form and lives entirely in stage B.
**Stage A verdict: all five call shapes are genuinely blocked, empirically, not by argument.**
This is the part of the report that was unverified and it holds up completely.

### Stage B — the import spellings

| case | import as applied | structure test | `tsc` | verdict |
|---|---|---|---|---|
| `B_plain` | `import { writeRunState } from "…/fileStore.js";` | **RED** on `expect(imported).not.toContain("writeRunState")` | — | blocked |
| `B_alias` | `import { writeRunState as W } from "…/fileStore.js";` | **RED**, same assertion (`…(43)] to not include 'writeRunState'`) | — | blocked — confirms the check is by import specifier, not local binding |
| `B_namespace` | `import * as ns from "…/fileStore.js";` | **RED** on `namespaceImportedModules(...)` → `expected [ '../persistence/fileStore.js' ] to deeply equal []` | — | blocked |
| `B_nospacefrom` | `import { writeRunState as W } from"…/fileStore.js";` | **RED**, but on a corrupted name list (see Minor-1) | `0` | blocked by luck |
| `D_nospace_full` | `import{writeRunState as W}from"…/fileStore.js";` | ✅ **GREEN — `STRUCT_EXIT=0`** | `0` | *** **NOT BLOCKED** *** |
| `D_ns_nospace` | `import*as ns from "…/fileStore.js";` | ✅ **GREEN — `STRUCT_EXIT=0`** | `0` | *** **NOT BLOCKED** *** |

### Consolidated 10-shape table (correcting the implementer's)

| # | shape | implementer's claim | **my measured result** |
|---|---|---|---|
| 1 | `void writeRunState(…)` | blocked (ran) | **blocked**, confirmed |
| 2 | `return writeRunState(…)` | blocked (argued) | **blocked**, now run: `TS2304` |
| 3 | aliased import + `await w(…)` | blocked (ran) | **blocked**, confirmed |
| 4 | `await  writeRunState(` double space | blocked (argued) | **blocked**, now run: `TS2304` |
| 5 | newline after `await` | blocked (argued) | **blocked**, now run: `TS2304` |
| 6 | `Promise.all([writeRunState(…)])` | blocked (argued) | **blocked**, now run: `TS2304` |
| 7 | direct `writeFile(join(runDir,"loop-state.json"), …)` | **still open** (ran) | **still open**, confirmed: `STRUCT_EXIT=0`, `TSC_EXIT=0` |
| 8 | `import * as ns` + `ns.writeRunState(…)` | now blocked (ran) | **blocked in the spaced form only** — `import*as` form is **still open** |
| 9 | dynamic `await import("…/fileStore.js")` | still open (argued, unverified) | **still open**, now run: `STRUCT_EXIT=0`, `TSC_EXIT=0` |
| 10 | third module imports it, `runLoop.ts` calls that | still open (argued, unverified) | **still open**, now run: `STRUCT_EXIT=0`, `TSC_EXIT=0` |
| 11 | `import{writeRunState as W}from"…"` — **new, not in either list** | not considered | *** **still open** *** — `STRUCT_EXIT=0`, `TSC_EXIT=0` |

**Bottom line on D-1.** The debt genuinely moved from "a completeness assertion with no enforcement
mechanism at all" to "an enforcement mechanism with a stated boundary". That is real progress and
the implementer's honesty about #7/#9/#10 is exactly right. But the boundary is **wider than the
report states**: it is not only "anything that does not go through the name `writeRunState`" — it
also includes "anything that goes through that name in an import written without whitespace after
the `import` keyword". Two of the eleven shapes I ran defeat the mechanism *while using the name*,
which is the case the mechanism was built to cover.

**One reassuring counterweight, measured.** For all four structurally-open shapes (#7, #9, #10, #11)
the new `#7` behavioural regression went red on `expect(persisted.status).toBe("planning")` — an
`AssertionError`, at 347 / 344 / 378 / 393 ms against a 5000 ms timeout. So at that one write site
the protection is behavioural and shape-independent. The gap is that the other eight write sites
have no such test.

## 4. Spec compliance detail

### Half 1 — D-1, option (a)

| brief requirement | status | how I checked |
|---|---|---|
| writer moved out of `runLoop.ts` | ✅ | `createOwnedRunStateWriter` / `OwnedRunStateWriter` / `observeOwnership` / `OwnershipObservation` all now in `src/controller/ownedRunStateWriter.ts` |
| `runLoop.ts` no longer imports `writeRunState` | ✅ | read the import header; the only remaining occurrences of the string in `runLoop.ts` are three comments (lines 23, 1101, 1520) |
| only the minimal necessary set moved | ✅ | `readOwnerRecordWithoutRecovery` and `parseOwnerRecordForLease` also dropped from `runLoop.ts`'s imports; `tsc` exit 0 proves no remaining use — nothing else was relocated |
| behaviour verbatim unchanged | ✅ | 57 code lines vs 57, `IDENTICAL_AFTER_COMMENT_STRIP= True` (my own re-derivation, not the implementer's) |
| source-reading test, by import specifier not local binding | ✅ (with Important-1) | `B_alias` proves specifier-based: aliased import goes red |

**Independent re-verification of the controller's stated facts** (the brief said to re-hit them
myself). Sweep over all 30 `src/**/*.ts`, unfiltered, must-hit probe `export function` = 27 hits,
must-miss probe `zzq-nonsense-token` = 0:

- `writeRunState` is defined at `src/persistence/fileStore.ts` and, across all of `src/`, is
  **called exactly once**: `ownedRunStateWriter.ts:153`. The hits in `resumeLoop.ts:101` and
  `registry/observeFields.ts:9` are comments — confirmed by reading them, as the brief said.
- The only writers of `loop-state.json` in `src/` are `fileStore.ts:77` (`initializeRunFiles`) and
  `fileStore.ts:82` (`writeRunState`). No module writes the path directly.

So the coverage fact D-1 rests on is true of the tree as it stands. Important-1 is about how easily
it can stop being true without anything going red.

### Half 2 — the thinnest cell `#7`

The brief located the site at BASE `runLoop.ts:1594-1608`; after the writer moved out it is at
`runLoop.ts:1471-1485`, and the sequence matches the brief exactly: `cleanupAttemptWorkspace` throws
→ `transitionRunState(state, "failed", …)` → `appendTransitionEvent(…, "attempt_failed", …)` →
`await writeOwnedRunState(runDir, state)` → `heartbeat.assertHeld()` →
`cleanupAttemptWorkspaceBestEffort(…, "cleanup after retry cleanup failure")` → `return state`.

The new test `refuses to write the terminal failed status of a retry-cleanup failure into a run a
different owner holds` encodes the brief's criterion precisely:

- `expect(persisted.status).toBe("planning")` — the on-disk state is **not** rewritten to `failed`,
  which is the unresumable-data-loss body itself;
- a byte comparison against the pre-run file contents, as a second independent observable;
- `expect(await readEventTypes(runDir)).toContain("terminal_write_abandoned")` — the required event;
- and it proves unresumability through the *production* gate `evaluateResumeEligibility`, with a
  control that feeds the same gate `status: "failed"` and gets
  `{ ok: false, reason: "run status failed is not resumable" }`.

It reaches the site deliberately: verification rejects with `safeToRetry: true` so the decision is
`retryable`, and `cleanupAttemptWorkspace` is mocked to throw. That is the only route to this write,
and it is not the outer catch's failure branch (which the pre-existing F-1 test covers).

**Hard requirement — red by assertion, not by exception or timeout: ✅ satisfied.** Four independent
mutations (§3) all produced `AssertionError: expected 'failed' to be 'planning' // Object.is
equality` at `runLoop.integration.test.ts:1557`, in 347–393 ms against a 5000 ms timeout. No
`Promise.all` ENOENT, no timeout, no thrown error.

### Hard boundaries

| boundary | status |
|---|---|
| no existing test judgment changed | ✅ `tests/` numstat is `100 0` and `131 0` — **zero deleted lines**; no `expect(` line removed anywhere in the range |
| option (c) not attempted | ✅ `tests/persistence/fileStore.test.ts` and `leaseLifecycle.integration.test.ts` untouched |
| no linter / new toolchain | ✅ `package.json` not in the range (`PKG_JSON_IN_RANGE=0`); devDependencies still exactly 4 |
| the 4th judgment / pending points A,B,C / specs / package 1 / `progress.md` | ✅ none in the change surface |
| no push, merge, branch delete | ✅ 3 local commits on `feat/pkg2-s4`, nothing else |
| named erratum, originals quoted verbatim | ✅ verified against `git show 8ae495f:…` — see §5 |

## 5. Test suite evidence

All runs went through `rtk proxy`, from a script on disk (`rtk proxy zsh <script>`), tee'd in full.
**No run was filtered — no `grep`, no `tail`, no `head` on any verification output.** Environment:
`ECC_GATEGUARD=off DISABLE_OMC=1`.

### Full suite + tsc + build, on HEAD `f49f4b9`

`RUN` first line verified as this worktree, not the repo root:

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4
…
 Test Files  31 passed (31)
      Tests  520 passed (520)
   Duration  16.92s
TEST_EXIT=0
TSC_EXIT=0
BUILD_EXIT=0
```

I read the entire unfiltered log. **Zero `FAIL` lines.** This independently reproduces the
implementer's 31/520 figure and the +1 file / +2 tests delta against the stated 30/518 baseline.

### The allowed-flake list and the on-the-books failure

All three named tests **passed** in my run:
- `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks
  descendants rooted at the spawned pid` — passed, 2811 ms;
- `continues normally when execute returns a complete result during the recovery window` — passed;
- `tests/controller/runLoop.integration.test.ts > runLoop > persists phase usage evidence from the
  subprocess adapter without recomputing controller totals` — passed, 789 ms.

Per the standing ruling I record this as **"did not reproduce this round"** and nothing more. It is
not evidence that the third one is harmless; its root cause is still empty and I did not
investigate it, as instructed. No other failure appeared, so there is no new defect from the suite.

### Anti-vacuity: green / red / green on both new tests

Non-zero counts throughout — no `0 matched` empty runs.

**Structure test** `runLoop.ts run-state write chokepoint > does not import writeRunState, …`

| step | result |
|---|---|
| green before | `✓ (1 test) 3ms` / `Test Files 1 passed (1)` / `Tests 1 passed (1)` / `STRUCT_EXIT=0` |
| **red after** (`B_alias`: aliased import restored) | `AssertionError: expected [ 'execFile', 'promisify', …(43) ] to not include 'writeRunState'` at `:92`, 5 ms / `STRUCT_EXIT=1` |
| green after restore | re-run in the `GREEN` case and again in the final full suite: `1 passed` / exit 0 |

Red on `expect(imported).not.toContain("writeRunState")` — an assertion, 5 ms, not a timeout and
not a thrown error.

**`#7` regression** `runLoop > refuses to write the terminal failed status of a retry-cleanup
failure into a run a different owner holds`

| step | result |
|---|---|
| green before | `✓ tests/controller/runLoop.integration.test.ts (59 tests \| 58 skipped) 289ms` / `Test Files 1 passed \| 30 skipped (31)` / `Tests 1 passed \| 519 skipped (520)` / `N7_EXIT=0` |
| **red after** (four separate mutations: direct `writeFile`, dynamic `import()`, third module, no-space import) | `AssertionError: expected 'failed' to be 'planning' // Object.is equality` at `runLoop.integration.test.ts:1557`, `Tests 1 failed \| 519 skipped (520)`, `N7_EXIT=1`, 347–393 ms |
| green after restore | final full suite, 520 passed, exit 0 |

`1 passed | 519 skipped (520)` is a non-zero count: the `-t` selector really matched.

### Erratum fidelity — originals from BASE, quoted verbatim

`git show 8ae495f:src/controller/runLoop.ts` (via `bash -c`, not zsh) gives the originals:

> …goes through here, and `writeRunState` is called from exactly one place in this module — the
> line below.

> The completeness argument is therefore no longer "I audited the call sites and they are covered";
> it is "this module cannot write a run state except through this function", which is a property a
> reader can check with one grep instead of an audit that already went wrong once.

Both appear verbatim inside the `*** ERRATUM, task S4 (package 2, debt D-1) — this paragraph is a
NAMED rewrite, not a silent edit.` block in `ownedRunStateWriter.ts` (only the nested double quotes
were changed to single quotes so they can sit inside the comment). The rewrite is labelled, the
reason is given, nothing was silently deleted, and the honest limit about direct `writeFile` is
stated in source rather than only in the report. **This requirement is met.** The second changed
comment sentence (above `persistTerminalState`, "the guard has moved to createOwnedRunStateWriter
above") is also disclosed by name in the implementer's §3 and §8. My only reservation is that the
*rewritten* sentence overclaims — that is Important-1, not an erratum-fidelity failure.

## 6. Mutation ledger and restoration proof

**12 mutations**, all to `src/controller/runLoop.ts`, plus one temporary extra file
(`src/controller/revThirdPartyWriter.ts`) for the third-module case. Each was applied by a driver
script from a pristine backup, exercised, and reverted from that same backup before the next one.

| # | case | mutation | restored |
|---|---|---|---|
| 1 | `A1_void` | `void writeRunState(…)`, no import | ✅ |
| 2 | `A2_return` | `return writeRunState(…).then(…)`, no import | ✅ |
| 3 | `A4_doublespace` | `await  writeRunState(…)`, no import | ✅ |
| 4 | `A5_newline` | newline after `await`, no import | ✅ |
| 5 | `A6_promiseall` | `Promise.all([writeRunState(…)])`, no import | ✅ |
| 6 | `B_plain` | plain named import + `void` call | ✅ |
| 7 | `B_alias` | aliased import + aliased call | ✅ |
| 8 | `B_nospace` | `import{… as W}from"…"` + aliased call | ✅ |
| 9 | `B_nospacefrom` | `… } from"…"` + aliased call | ✅ |
| 10 | `B_namespace` | `import * as ns` + `ns.writeRunState(…)` | ✅ |
| 11 | `C_dynimport` / `C_thirdmodule` / `C_writefile` | dynamic `import()`; third module (+1 temp file); direct `writeFile(join(runDir,"loop-state.json"),…)` | ✅ |
| 12 | `D_nospace_full` / `D_ns_nospace` | the two whitespace variants, run against tsc + structure test + `#7` | ✅ |

(Rows 11 and 12 each bundle the cases run in one scripted pass; 12 distinct mutated trees in total.)

**Restoration proof, three parts as required:**

```
GIT_DIFF_RAW_BYTES=0
GIT_DIFF_CACHED_RAW_BYTES=0
DIFF_VS_HEAD_BYTES=0        (git diff HEAD -- src tests)
REV_THIRD_EXISTS=NO

git status --porcelain (raw):
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-s4.diff
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-s4.md
```

The only two untracked entries are the review package I was given and this report.

**Mutation markers, all zero across `src/` and `tests/`:**

```
MARKER[MUTANT_REV_W]=0   MARKER[revThirdPartyWrite]=0   MARKER[revFileStoreNs]=0
MARKER[revWF]=0          MARKER[revJoin]=0              MARKER[revMod]=0
MARKER[MUTANT_S4]=0      MARKER[MUTANT_NS]=0
```

(The last two are the *implementer's* markers, also at zero — his restorations hold too.)

**Sanity probes proving that zero-count is a real zero and not a dead search:**

```
SANITY_HIT[createOwnedRunStateWriter]=5
SANITY_HIT[writeOwnedRunState]=26
SANITY_MISS[zzq-nonsense-token]=0
```

Additionally, every individual case printed `GITDIFF_RAW_BYTES[<case>]=0` and
`UNTRACKED_SRC[<case>]=0` immediately after its own restore, so no mutation ever survived into the
next case. Nothing was written outside this worktree and the scratchpad; the main checkout at
`/Users/biran/code/skills/loop/ccloop` was never touched; nothing was pushed, merged, committed or
deleted.

## 7. Token usage

*** **I cannot read a real harness-measured number from inside this subagent context, so I am
giving none.** *** No estimate follows, per the standing rule that this repository stopped accepting
self-reported estimates after one was off by 2.5–3.3×. The controller should read this task's actual
usage from the harness side.

Objective non-token quantities I did measure: **1** full-suite run (16.92 s wall) plus `tsc` and
`npm run build`; **14** additional `tsc` invocations across the mutation matrix; **11** single-test
vitest runs; **12** injected-and-reverted mutations; **1** repo-wide unfiltered search sweep over
all 30 `src/**/*.ts` files.

---

## 8. What the next actor should do

1. **Address Important-1.** Minimum acceptable: correct the two overclaiming sentences (in
   `ownedRunStateWriter.ts`'s erratum and in `ownedRunStateWriter.structure.test.ts`'s header) so
   they state the whitespace precondition — this repository does not tolerate a completeness claim
   in source that is false as written, which is the whole F-1 lesson. Better: replace the two
   regexes with a `ts.createSourceFile` walk (the `typescript` devDependency already exists, so this
   introduces no toolchain), which retires Important-1, Minor-1 and Minor-3 together.
2. Minor-2 and Minor-4 are judgment calls for the controller; neither blocks.
3. **Do not** take my review as authority to merge, push, or open anything.
4. The implementer's report is accurate everywhere I checked it except the mechanism-B claim
   ("adding the import back turns the structure test red"), which is false for one import spelling.
   His four "unverified" labels were all conservative in the right direction — every one of them
   came out the way he predicted.
