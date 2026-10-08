# Task K4 report (full gate, mutations, restore proof)

Written by the K4 executor (Orca session e34dc963 subagent, Claude), 2026-10-08, on fix/codex-planner-output.
Status: DONE. One new commit (a criterion gap found by a mutation): `test(codex): fail closed when a span is too deep to serialise for dedupe` (2328f1e).
All outputs: `$S=/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/e34dc963-cc97-4bb3-b662-27fd62c9d359/scratchpad/ccloop-K4/` (every file redirected and read back whole).
Env for every run: `ECC_GATEGUARD=off DISABLE_OMC=1`. Gate script: `$S/gate.sh <repo> <out>` = `npm run build`, then
`rtk proxy ./node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile.json=<out>/vitest.json`,
`node scripts/check-known-reds.mjs <out>/vitest.json`, `rtk proxy npm run typecheck`, counts from the JSON report; `uptime` before/after vitest.

## 1. Baseline (pre-K1 commit, dist built)
`git clone --local` of the worktree under `$S/baseclone`, checked out at 2bbe8ef (`docs(plan): task-by-task plan for codex phase output hardening`), node_modules linked, `npm run build`, then the gate (`$S/base/`):
build 0, vitest 0, known-reds 0 (roster 6, failed 0), typecheck 0; counts `{"total":1212,"passed":1212,"failed":0,"pending":0,"todo":0}`; status `?? node_modules`; uptime load 1.99 before.
=> K1's 8 baseline reds were environmental: with dist built the base is fully green.

## 2. Gate on the worktree
New tests (measured from the vitest JSON per file, `$S/mutations/M0.json`): extractFinalObject 41 (K1 40 + 1 new in K4), finalExtraction 12 (K2 11 + K3 1), phasePrompts 10 => 63. Expected total 1212 + 63 = 1275. (The brief's "+53" predates K1's fix round, which took K1 from 31 to 40 tests.)

| Run | HEAD | build | vitest | known-reds | typecheck | counts | load (uptime before/after) |
|---|---|---|---|---|---|---|---|
| gate (`$S/gate/`) | 3ed05ce | 0 | 1 | 1 | 0 | 1274 / 1269 passed / 5 failed / 0 pending / 0 todo | 38.97 / 39.19 |
| gate2 (`$S/gate2/`) | 3ed05ce | 0 | 1 | 1 | 0 | 1274 / 1273 / 1 failed / 0 / 0 | 14.60 / 36.97 |
| **gate3 (`$S/gate3/`), final** | **2328f1e** | **0** | **0** | **0 (roster 6, failed 0, unexpected 0)** | **0** | **1275 / 1275 / 0 / 0 / 0** | 7.70 / 23.51 |

RUN line of every worktree vitest.out names `/Users/biran/code/skills/loop/ccloop-planner`; status `?? node_modules` only.

Reds in gate/gate2, all outside the roster, all timing failures under host load 37-39 (47 users); none is in a K1-K3 test file, though `tests/runtime/codex/adapter.test.ts` exercises codexAdapter.ts (changed by K2) and several use the fake codex (K2 added only a `final-text` mode), so each was re-run:
- gate: `parseArgs > returns 0 for the example contract run` (5000 ms timeout), `isolated Codex acceptance harness > outer watchdog kills a previously observed TERM-ignoring detached Codex` (poll 1500 ms), `does not hide cleanup failure behind an aborted execute result`, `Codex phase process > refuses output-limit output` (got timeout), `Codex phase process > labels truncated evidence explicitly` (got timeout).
- gate2: `Codex phase process > returns its own deadline result before the test watchdog` (io-error vs timeout).
Re-runs alone (`$S/rerun/`, `$S/rerun2/`, `$S/rerun3/`, each with uptime files): adapter.test and runCodexPhase.test green alone at load ~30; cli.test and validation/codexAdapter.test red once alone at load ~29-30, then green twice each on the worktree AND twice each on the 2bbe8ef baseline clone, alternating, at load 17-23; runCodexPhase.test green twice on worktree and twice on baseline at load 24-30. Final gate3 fully green. Verdict: load flakes, not regressions. Concern: these six names are not on the known-reds roster; adding them is not mine to decide (roster changes are human rulings).

## 3. Mutations (clone only)
Clone: `git clone --local --branch fix/codex-planner-output` under `$S/mut` (HEAD 3ed05ce, head file cmp with worktree rc 0), node_modules symlinked, `npm run build` rc 0. After the new commit, a fresh clone `$S/mut2` at 2328f1e (head cmp rc 0, build rc 0) for the final run (the gate hook refused a `checkout`+`pull` in the old clone; a fresh clone was used instead, nothing bypassed).
Runner: `$S/run-mutations.mjs` (scratch file, not a repo artifact; the brief marks it scratch). It applies one exact-string replacement (search must match exactly once), runs only the named test files with `--reporter=json`, restores the file and compares byte-for-byte, and requires every named test to be in the failed list. Every search string and every expected name was re-derived from the current code and test files.
Final run: `node run-mutations.mjs $S/mut2 $S/mutations > $S/mutations-run2.txt`, **rc 0**; `$S/mutations/summary.json`; clone status `?? node_modules`, clone `git diff` 0 bytes; load 4.70 before / 8.54 after.

M0 (unmutated, 3 files): 63 tests, 0 failed.

| id | edit (file) | expected red (seen) | observed failed count |
|---|---|---|---|
| M1 | delete whole-JSON `try { return { method: "whole" … } }` line (protocol) | returns a whole JSON answer as is; K2 writes no extraction evidence for a compliant whole answer; K2 decodes a bare array … failing as today | 3 |
| M2 | DROPPED (fence collection removed in befaea8, ruling in progress.md) | — | — |
| M3 | `found.size === 1` -> `>= 1`, take last (protocol) | refuses two different bare plans (+ other order), two different fenced plans, fenced plan and a different bare plan; verify safety: never turns a rejection into approval …, sees a rejection nested …; execute: refuses two different envelopes; K2 refuses a verify answer that carries an approval template …; K2 keeps today's execute error for two different envelopes | 9 |
| M4 | delete the line that enters string state (protocol) | accepts the one plan in an object with a closing brace inside a string | 2 |
| M5 | delete backslash escape line (protocol) | accepts the one plan in an object with escaped quotes around a brace | 1 |
| M6 | quote enters string at depth 0 too (protocol) | accepts the one plan in prose with a stray quote before the object | 1 |
| M7 | `if (accepts(node)) found.set(` -> `found.set(` (protocol) | prose quoting an example object before the real one; refuses a plan with an extra key; refuses a valid answer of another phase; verify: accepts the rejection after a fenced example … | 14 |
| M7a (new, a) | `let hidden = depth > 0;` -> `false` | verify safety: refuses the fenced approval template next to an unclosed brace …; … next to a stray quote inside a brace span … | 2 |
| M7b (new, b) | unparseable span `catch { hidden = true; continue; }` -> `catch { continue; }` | verify safety: refuses the fenced approval template next to a non-JSON wrapper around the rejection | 1 |
| M7c (new, c) | delete `for (const item of Object.values(node)) stack.push(item);` (roots only) | accepts the one plan in an answer wrapped in a valid object; verify: sees a rejection nested …; accepts a rejection nested … when nothing else is valid | 3 |
| M7d (new, d) | sortKeys replacer returns `v` (no key sort) | verify: counts the same rejection with another key order once | 1 |
| M7e (extra) | delete `if (roots.has(rootKey)) continue;` | EQUIVALENT mutant, expected and seen green (roots is a Set, found a Map by sorted key; the line only skips re-walking) | 0 |
| M7f (extra, finding) | serialisation `catch { hidden = true; … }` -> `catch { }` | refuses a plan followed by an object too deep to serialise (NEW test, 2328f1e) | 1 |
| M16 (extra) | execute envelope without `.strict()` | execute: refuses an envelope with an extra key; K2 keeps today's execute error for an envelope with an extra key | 2 |
| M17 (extra) | execute accepts `schemas[phase]` (bare body) instead of the envelope | execute: refuses a bare execution body without the envelope; accepts prose followed by a complete envelope; K2 extracts a complete execution envelope from prose | 7 |
| M8 | delete the `final-extraction.json` write (adapter) | K2: extracts the one plan … records how; keeps today's error text and records the refused candidates …; refuses a verify answer … approval template …; extracts a complete / partial execution envelope from prose | 5 |
| M9 | evidence condition -> `{` (adapter) | K2: writes no extraction evidence for a compliant whole answer; … when no candidate parses; decodes a bare array … | 3 |
| M9b (extra) | condition -> `candidate` only | K2: keeps today's error text and records the refused candidates …; refuses a verify answer … approval template … | 2 |
| M9c (extra) | drop `candidates > 0` | K2: writes no extraction evidence when no candidate parses | 1 |
| M10 | candidate decode skipped for execute (adapter) | K2: extracts a complete / partial execution envelope from prose | 2 |
| M10b (extra) | `const final = outcome.final;` | K2: extracts the one plan …; accepts a verify rejection after a fenced example …; complete / partial envelope | 4 |
| M11 | delete planner read-only line (prompts) | tells the planner the phase is read-only, right after the task line | 1 |
| M12 | planner heading back to `Constraints:` | labels the planner's constraints as binding the execute phase | 1 |
| M13 | delete verifier no-edit line | tells the verifier not to edit files, right after the task line | 1 |
| M14a | drop planner FINAL_MESSAGE_LINE | ends the planner prompt with the final-message line | 1 |
| M14b | drop executor FINAL_MESSAGE_LINE | ends the executor prompt …; codex execute prompt order > puts codex's envelope line after the executor's final-message line | 2 |
| M14c | drop verifier FINAL_MESSAGE_LINE | ends the verifier prompt … | 1 |
| M15a | insert a line before planner line 2 | keeps the first two lines of every prompt | 3 |
| M15b | insert a line before verifier line 2 | keeps the first two lines of every prompt | 3 |

Every mutation: `restored: true`.

### Corrections and findings during the mutation work
- Run 1 (`$S/summary-run1.json`, `$S/mutations-run1.txt`, rc 1, on 3ed05ce): two misses.
  - M7b: I had also listed the stray-quote probe; it stayed green under M7b and is red under M7a (its quote opens a string that never closes, so depth stays > 0). Expectation error on my side, not a criterion gap: M7b's branch is seen red by the non-JSON-wrapper probe. Name moved to M7a; both seen red in run 2.
  - M7e: equivalent mutant (see table); recorded as expected-green, no test possible without timing.
- FINDING (M7f): the fail-closed branch for a span that cannot be serialised (K1 fix round) had no criterion; mutation stayed green on 3ed05ce (`$S/m7f-before.txt`, rc 1, failed 0). TDD: added test `refuses a plan followed by an object too deep to serialise` (plan, then an object nested 100000 levels: JSON.parse is iterative, the key-sorting JSON.stringify throws RangeError; probe `$S/deep-probe.txt`); copied into the clone, M7f red (`$S/m7f-after.txt`, rc 0, failed 1); unmutated file green 41/41 in the worktree (`$S/m7f-green.txt`). Committed 2328f1e (explicit path, new test only, no existing criterion changed). Full mutation run 2 and gate3 were taken after this commit.

## 4. Restore proof
- Before (worktree at 3ed05ce): `rtk proxy git -C $W diff > before.diff`, `rtk proxy git -C $W diff --cached > before.cached`, `wc -c` => 0 and 0 bytes.
- After (worktree at 2328f1e; the only worktree write was the committed test edit): same commands => 0 and 0 bytes; `cmp before.diff after.diff` rc 0, `cmp before.cached after.cached` rc 0; status `?? node_modules`.
- Before deleting the clones: `cmp` of protocol.ts, codexAdapter.ts, prompts.ts, the three test files and fake-codex.mjs between each clone (`mut`, `mut2`) and the worktree: all 14 rc 0 (`$S/restore/clone-cmp.txt`). Clones `mut`, `mut2`, `baseclone` then removed (symlinks unlinked first; the shared ccloop node_modules is intact).
- Note: the worktree's `dist/` was (re)built by `npm run build` (gitignored, not in git status).

## 5. Commits on the branch for this plan (subjects)
K1: `feat(codex): extract the one schema-valid object from a decorated final message`, `fix(codex): fail closed when the final message hides text from the brace matcher`, `refactor(codex): drop fence collection from final-object extraction`; K2: `feat(codex): decode a decorated final message through its one schema-valid object`; K3: `feat(prompts): tell each phase what it must not do and how its final message must look`; K4: `test(codex): fail closed when a span is too deep to serialise for dedupe`.
No push, no merge (ccloop Rule 13). This report file is written, not committed (left to the controller with the rest of the ledger).

## Concerns
1. Six timing reds outside the known-reds roster appeared under host load 37-39; each passed alone and on the baseline at lower load, and the final gate is fully green. The roster is the human's to change.
2. Expected count differs from the brief (+63, not +53): K1's fix round and K4's new test.
3. M7e is an equivalent mutant (performance-only line); left as is.
