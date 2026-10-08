# Final-review fix report (spec §7)

Written by the final-fix implementer (Orca session e34dc963 subagent, Claude), 2026-10-08, on fix/codex-planner-output
(worktree /Users/biran/code/skills/loop/ccloop-planner). Base 9527043 (spec §7 commit). Fix commit 252d3ee
`fix(codex): count answer-shaped nodes, extract only verify rejections, and bound the walk`.
All outputs: `$O=/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/e34dc963-cc97-4bb3-b662-27fd62c9d359/scratchpad/ccloop-finalfix/`
(every run redirected to a file and read back whole). Env for every run: `ECC_GATEGUARD=off DISABLE_OMC=1`.
This file is not committed (`.superpowers/sdd/.gitignore` ignores it; the ledger owner force-adds).

Status: DONE.

## 1. Changes (252d3ee)

- `src/runtime/codex/protocol.ts`
  - `phaseAnswerKeys` (plan `summary`/`primaryTargetPaths`, execute `result`, verify `approved`) defined next to
    `phaseFinalAccepts`. `phaseFinalAccepts` now returns a `PhaseAcceptor`: the acceptance function **with the keys
    attached** (`Object.assign(fn, { keys })`).
    Decision (reversible, mine): the brief said "so the adapter can pass both". I attached the keys to the acceptor rather
    than adding a third parameter, because a third parameter would have meant editing every existing
    `extractFinalObject(text, accepts)` call in the K1 test file (Rule 15). The adapter still passes both, as one value.
  - Rule 2: the verify acceptor is `schema ok && approved === false`.
  - Rule 1/3: the new `scanFinalMessage(final, accepts) -> { extraction, hidden }` walks every container of every distinct
    parsed span iteratively with its depth. An object node that has one of the keys is answer-shaped. Each distinct
    answer-shaped node (sorted-key JSON) is recorded with `accepts(node)`; zod runs only there. Recording stops at the
    second distinct answer-shaped node, because the result is `none` from then on (this bounds the serialisation work).
    The result is `candidate` only if nothing is hidden, there is exactly one distinct answer-shaped node, and it is
    accepted. More than 100 000 object nodes, or a depth past 1 000 (arrays count as levels; root = 1), gives
    `hidden = true` and stops the walk ⇒ `none`.
  - Identical span text is walked once (a Set of raw span strings), so repeated identical spans do not use up the node
    budget. `candidates` still counts distinct roots by sorted-key JSON. `valid` counts the accepted nodes among the
    distinct answer-shaped nodes recorded.
  - `extractFinalObject(final, accepts)` keeps its signature and return type. It is `scanFinalMessage(...).extraction`.
    It was kept so that the existing `toEqual` criteria stay unchanged: adding `hidden` to `FinalExtraction` would have
    changed about 15 of them.
  - Rule 5: the dead `if (!record(value)) continue;` guard is gone, and so is the try/catch around serialisation. The
    depth limit now keeps `JSON.stringify` safe.
- `src/runtime/codex/codexAdapter.ts` (rule 4): uses `scanFinalMessage`. `final-extraction.json` is now
  `{method, candidates, valid, hidden, originalBytes}`. It is written when the method is `candidate`, or when it is
  `none` and `candidates > 0 || hidden`.
- `src/runtime/claude/prompts.ts` (rule 5): the verifier line is now
  `This is the verify phase. Do not change the attempt's files; run commands only to check the attempt.`

## 2. Existing tests changed (old → new). Each one is named by spec §7 or by the brief.

| File > test | Old | New | Reason |
|---|---|---|---|
| extractFinalObject > `refuses a plan followed by an object too deep to serialise` (K4, 2328f1e) | 100 000-deep object, depended on the stack size, expected `none 1/1` | **removed**; replaced by 4 explicit limit tests (§3) | brief (M2 of the final review); §7 rule 3 |
| extractFinalObject > verify safety > `sees a rejection nested inside another object, so a fenced approval template cannot win` | `none, candidates 2, valid 2` | `none, candidates 2, valid 1` | rule 2: an approval is no longer accepted, so `valid` drops |
| extractFinalObject > verify safety > `accepts the rejection after a fenced example that is not a verification` | `candidate` (rejection) | renamed `refuses the rejection after a fenced answer-shaped example that is not a valid verification`, expects `none 2/1` | rule 1: `{"approved":"yes"}` is answer-shaped and counts |
| extractFinalObject > verify safety > `never turns a rejection into approval because a schema-valid approval template is also present` | `none 2/2` (both orders) | `none 2/1` (both orders) | rule 2 |
| finalExtraction > `extracts the one plan from decorated prose and records how` | evidence without `hidden` | `hidden: false` added | rule 4 |
| finalExtraction > `keeps today's error text and records the refused candidates before decoding` | evidence without `hidden` | `hidden: false` added | rule 4 |
| finalExtraction > `refuses a verify answer that carries an approval template next to the rejection` | evidence `none 2/2` | `none 2/1, hidden: false` | rules 2 and 4 |
| finalExtraction > `accepts a verify rejection after a fenced example that is not a verification` | verify resolves to the rejection | renamed `refuses a verify rejection after a fenced answer-shaped example that is not a valid verification`: `Error: codex-result-invalid: <call>`, evidence `none 2/1 hidden false` | rule 1 |
| finalExtraction > `extracts a complete / partial execution envelope from prose` (2) | evidence without `hidden` | `hidden: false` added | rule 4 |
| phasePrompts > `VERIFY_NO_EDIT` constant (used by `keeps every existing verifier line in order around the new ones` and `tells the verifier not to edit files, right after the task line`) | `…Do not create, edit or delete files; run…` | `…Do not change the attempt's files; run…` | rule 5 (named as approved in the brief) |

No other existing test changed (diff of the three test files against 2328f1e: only the rows above, plus added tests).

## 3. New tests (+14 in extractFinalObject, +4 in finalExtraction)

extractFinalObject: `reads a plan next to an object nested exactly 1 000 deep`; `refuses a plan next to an object nested
1 001 deep (depth limit)`; `reads a plan next to objects that bring the message to exactly 100 000 object nodes`;
`refuses a plan next to objects that bring the message past 100 000 object nodes (node limit)`; `refuses a
schema-invalid real plan next to a valid example plan`; `runs the acceptance test only on answer-shaped nodes` (counts
acceptance calls: 1 for 3 001 object nodes); verify safety: `accepts a decorated rejection` (asserts `approved === false`),
`refuses a decorated approval`, `refuses a rejection with an extra key on its own (answer-shaped but invalid)`, and the
three flip.mjs samples `never accepts the approval template next to {a rejection with an extra key | a rejection whose
approved is the string "false" | a rejection missing keys}` (each `none 2/0`); performance: `refuses a 16 MiB span of
millions of empty objects in under 3 s (plan | execute)` (the perf2.mjs wide input).
finalExtraction: `accepts a decorated verify rejection`; `refuses a decorated verify approval with today's error text`
(message `Error: codex-result-invalid: <call>`, decode-error.txt `Error: codex-result-invalid`); `refuses a verify
rejection with an extra key next to a fenced approval template`; `records hidden text with zero candidates` (evidence
`none 0/0 hidden true`, mode 0600).

Red before implementation (`$O/red-summary.txt`): 80 tests, 25 failed. Two did not fail: `refuses a rejection with an
extra key on its own` (the old code also gave `none`; kept as a guard) and the boundary positives.
Green after (`$O/green-summary.txt`): 80/80. Measured durations: 16 MiB plan 1079 ms, execute 1231 ms.

Probes rerun against the new dist (`$O/flip-after.txt`, `$O/perf2-after.txt`, `$O/perf-after.txt`, `$O/perf3.txt`):
- flip: all three cases give `none 2/0` (before: `candidate`, approval).
- perf2 wide, 16 MiB: plan 1200 ms, execute 1202 ms, verify 1170 ms (before: 9 597 ms and 75 901 ms); rss about 1.1 GiB.
- perf.mjs, every case: at most 1 421 ms (before: up to 85 873 ms).
- 16 MiB of unparseable `{x}` spans: about 525 ms. 16 MiB of distinct spans: about 290 ms (stops at the node limit).

## 4. Gate (on 252d3ee, `$O/gate/`, script `$O/gate.sh`, a copy of K4's)

| step | rc |
|---|---|
| `npm run build` | 0 |
| `vitest run` (default + json reporter) | 0 |
| `node scripts/check-known-reds.mjs vitest.json` | 0 (roster 6, failed 0, unexpected 0) |
| `npm run typecheck` | 0 |

Counts: total 1292, passed 1292, failed 0, pending 0, todo 0. That is 1275 (K4's gate) − 1 removed + 18 added.
Per file: extractFinalObject 54, finalExtraction 16, phasePrompts 10. The vitest RUN line names
`/Users/biran/code/skills/loop/ccloop-planner`. Status: `?? node_modules` only. Load (uptime): 6.20 before, 28.21 after.
No red outside the roster, so no re-run was needed.

## 5. Mutations (clone `$O/mut`, `git clone --local` at 252d3ee, head cmp-equal to the worktree for all 5 touched src/test files, node_modules symlinked, build rc 0)

Runner: `$O/run-mutations.mjs` (scratch). For each mutation it does one exact-string replacement (the search string must
match exactly once), runs the named files with the json reporter, restores the file and checks it byte for byte, and
requires every expected name to be in the failed list. Run: `$O/mutations-run.txt`, rc 0. Summary in
`$O/mutations/summary.json`. M0 (unmutated, 2 files): 70 tests, 0 failed. Load 15.43 before, 22.24 after.

| id | rule | edit | expected red (all seen) | failed count |
|---|---|---|---|---|
| R1 | 1 answer-shaped counting | drop `shaped.size === 1 &&` | schema-invalid real plan + valid example; verify: refuses the rejection after a fenced answer-shaped example; adapter: same | 6 |
| R2 | 2 verify only approved:false | drop `&& approved === false` | refuses a decorated approval; adapter: refuses a decorated verify approval with today's error text | 8 (the 3 flip samples also red) |
| R3n | 3 node cap | `MAX_NODES = Infinity` | node limit test | 3 (both 16 MiB perf tests also red) |
| R3d | 3 depth cap | `MAX_DEPTH = Infinity` | depth limit test | 1 |
| R3h | 3 limit hides | `{ hidden = true; break scan; }` → `{ break scan; }` | depth limit and node limit tests | 2 |
| R3z | 3 zod only on answer-shaped | call `accepts(node)` on every object node | runs the acceptance test only on answer-shaped nodes | 2 (16 MiB execute perf test also red, at load about 15–22) |
| R3k | 1/3 filter removed (every node answer-shaped) | `keys.some(...)` → `true` | prose quoting an example before the real one; acceptance-call count | 14 |
| R4w | 4 hidden evidence write | `(candidates > 0 \|\| hidden)` → `candidates > 0` | records hidden text with zero candidates | 1 |
| R4f | 4 `hidden` field | `hidden` dropped from the evidence JSON | decorated plan evidence; hidden-text evidence; decorated verify rejection | 9 |
| R5 | 5 verifier line | old wording restored in prompts.ts (separate run, `$O/mutations/R5*.{json,out,txt}`) | phasePrompts: keeps every existing verifier line in order…; tells the verifier not to edit files… | 2 |

The brief asked for the zod-filter mutation to show the perf test red. Under R3z the 16 MiB execute perf test did go red
in this run, but that is a timing result: with the node limit in place, at most 100 000 zod calls run, and R3z costs
about 1.3 s on top of about 1.2 s against a 3 s bound. The deterministic guard for rule 3's zod clause is the
acceptance-call-count test, which is red under both R3z and R3k. Under R3n both perf tests go red.

Rule 9 note: the flip samples are guarded twice. R1 alone leaves them green (the template is not accepted, so `valid` is
0). R2 alone turns them red. They need rule 2, plus the rule 1 rows above.

Clone after the runs: `git status` shows `?? node_modules` only, and `git diff` is 0 bytes (`$O/mut-status.txt`,
`$O/mut-diff-bytes.txt`).

## 6. Restore proof (worktree)

`/usr/bin/git -C <worktree> diff | wc -c` = 0. `/usr/bin/git -C <worktree> diff --cached | wc -c` = 0
(`$O/wt-diff.txt`, `$O/wt-diff-cached.txt`). Status `?? node_modules`. HEAD 252d3ee.
(This report file is untracked and ignored, so it does not appear in either diff.)

## 7. Concerns

- The 3 s bound on the 16 MiB perf tests has about 2.5x headroom (measured 1.1–1.2 s at load around 6). Under very heavy
  host load these tests could time out. If that happens, rerun them alone with `uptime` recorded before treating it as a
  regression.
- `valid` and `candidates` are partial when the walk stops early (at a limit, or after the second distinct answer-shaped
  node). The result is `none` in every such case. The evidence counts are lower bounds there.
- Memory: the 16 MiB wide input still costs about 1.1 GiB rss, because `JSON.parse` of the span builds millions of
  objects before the walk starts. Time is bounded; peak memory is the same order as a whole-text `JSON.parse` of that
  input.
- API: `phaseFinalAccepts` now returns a function with `keys` attached instead of a bare predicate. Its only callers are
  the adapter and the tests.

## Follow-up B1 (controller ruling after the scoped re-review of 252d3ee, 2026-10-08)

Written by the same implementer, 2026-10-08. Outputs: `$O/b1/`.

Defect: an answer-shaped node was serialised (`JSON.stringify(node, sortKeys)`) as soon as it was popped. That happened
before the depth check reached its descendants, and 252d3ee had removed the try/catch. So a plan, verify or execute
answer-shaped node with a child nested 100 000 deep threw `RangeError: Maximum call stack size exceeded`. Through the
adapter that became the error message, and no final-extraction.json was written.

Fix, commit a0adad2 `fix(codex): walk a span completely before serialising its answer-shaped nodes`:
- `protocol.ts`: each span is walked in full first. The walk collects answer-shaped nodes into `found`; it is bounded by
  MAX_NODES, and arrays count toward depth. Only when the span's walk ends without hitting a limit does the
  serialise/dedupe/accept loop run over `found`, stopping at the second distinct node. A hit limit still does
  `hidden = true; break scan`.
- `codexAdapter.ts`: the stale comment at lines 33–34 now states §7: exactly one distinct answer-shaped node, accepted
  (verify: a rejection only).

New criteria (no existing test changed):
- extractFinalObject: `refuses {a plan with a child nested 100 000 deep | a plan with arrays nested 100 000 deep | a
  verify rejection with a child nested 100 000 deep | an execute envelope whose result is nested 100 000 deep} as hidden
  text instead of throwing`. Each asserts that `scanFinalMessage` gives `{extraction: none 0/0, hidden: true}`.
- finalExtraction: `fails a {plan | verify | execute} answer with a child nested 100 000 deep as today and records hidden
  text`. Plan and verify give `Error: codex-result-invalid: <call>`. Execute gives today's JSON.parse error. Evidence is
  `none 0/0 hidden true` in all three.
- Red before the fix: `$O/b1/red-summary.txt`, 77 tests, 7 failed. All 7 are the new tests, failing with RangeError or a
  RangeError message. Green after: `$O/b1/green-summary.txt`, 87/87 across the 3 focused files. The 16 MiB perf tests took
  1223 ms (plan) and 1433 ms (execute).

Gate on a0adad2 (`$O/b1/gate/`):

| step | rc |
|---|---|
| build | 0 |
| vitest | 1 |
| check-known-reds | 0 (roster 6, failed 1, unexpected 0) |
| typecheck | 0 |

Counts: 1299 total, 1298 passed, 1 failed (1292 + 7). The single red is a roster entry: `claude phase runner > waits for
close before interrupting a close-pending successful execute`. It is not in a file this branch touches. Load was 11.91
before and 57.48 after. RUN line: the worktree. Status: `?? node_modules`.

Mutation, in a fresh `git clone --local` at a0adad2 (`$O/b1/mut`; touched files cmp-equal to the worktree; build rc 0):
- Runner: `$O/b1/run-b1.mjs`.
- Edit, "serialise at pop time": `found.push(node);` → `found.push(node), JSON.stringify(node, sortKeys);`.
- Result: rc 1, 7 of 77 failed — exactly the 7 new tests. The file was restored byte-equal (`$O/b1/b1-mutation.txt`).

Rerun of the §7 mutations on a0adad2 (ccloop Rule 17: the code changed):
- Runner: `$O/b1/run-mutations-b1.mjs`. Only R3z's search string changed, to fit the new structure:
  `if (record(node) && accepts.keys` → `if (record(node) && accepts(node) !== undefined && accepts.keys`.
- Result: rc 0. M0 77/0. Expected reds seen for every mutation: R1 6, R2 8, R3n 3, R3d 2, R3h 6, R3z 2, R3k 12, R4w 4,
  R4f 12 (`$O/b1/mutations-run.txt`, read whole). Under R3k the 16 MiB perf tests are now green; its expected names are
  still red.
- Clone after the runs: `?? node_modules`, `git diff` 0 bytes.

Restore proof (worktree): `/usr/bin/git diff | wc -c` = 0, `/usr/bin/git diff --cached | wc -c` = 0. Status `?? node_modules`.
