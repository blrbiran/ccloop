# Task K1 report (extractFinalObject, phaseFinalAccepts)

Status: DONE_WITH_CONCERNS (concern: pre-existing full-suite baseline reds, below)
Commit: 7c79044 feat(codex): extract the one schema-valid object from a decorated final message

## Implemented
- src/runtime/codex/protocol.ts: appended (63 lines) `phaseFinalAccepts`, `FinalExtraction`, `extractFinalObject`, verbatim from the brief (including `executeEnvelope`).
- tests/runtime/codex/extractFinalObject.test.ts: created verbatim from the brief (111 lines, 31 tests).
- No other file touched. Added with explicit paths only.

## TDD evidence
- RED: `vitest run tests/runtime/codex/extractFinalObject.test.ts` rc=1; collection failure `TypeError: phaseFinalAccepts is not a function` at test file line 17; "Tests no tests" (as the brief predicted). Output: scratchpad ccloop-K1/k1-red.txt.
- GREEN: same file + protocol.test.ts rc=0: 2 files, 69 tests passed (extractFinalObject 31, protocol.test.ts 38 unchanged). k1-green.txt.
- `npm run typecheck` rc=0 (k1-typecheck.txt).
- `vitest run tests/runtime` rc=0: 39 files, 314 tests passed (k1-runtime.txt; RUN line names /Users/biran/code/skills/loop/ccloop-planner).
- All outputs were redirected to files under /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/e34dc963-cc97-4bb3-b662-27fd62c9d359/scratchpad/ccloop-K1/ and read back (the later "sed -n 1,3p / tail -n 8" on k1-runtime.txt was only a convenience view of a rc=0 run; the full file is in the scratchpad).

## Baseline (Step 0, before any change; K4 reference)
counts.txt: `{"total":1212,"passed":1204,"failed":8,"pending":0,"todo":0}` (commit before 7c79044, HEAD at start = worktree branch tip).
status.txt: `?? node_modules` only. `check-known-reds` rc=1: roster 6, failed 8, unexpected 8.
The 8 failures are environmental and pre-existing, unrelated to codex:
- 7 in tests/control/endToEnd.test.ts and claudeEndToEnd.test.ts: `ENOENT chmod dist/cli.js` (the built CLI was absent when the baseline ran; `dist/` exists now).
- 1 in tests/validation/codexWatchdog.test.ts: "matches historical double-space start identities on single-digit days" timed out at 5500 ms (time-of-day/load sensitive).
Details: baseline/failures.txt. K4 should expect total = 1212 + 53 new = 1265 only if those reds are accounted for (build dist first and rerun for a clean baseline).

## Mutation step
K1's Step 5 says mutations are run in K4's copy; none were run here (per instruction, K4 owns the table). Worktree diff/cached were 0 bytes before the code change.

## Self-review
- Diff is append-only to protocol.ts after the old last line; existing lines untouched; no criterion edited.
- Uses only module-private `execution`, `schemas`, `record`, `z`, `CodexPhase` as the brief states; typecheck confirms.
- Not yet wired into CodexAdapter (K2's job).

## Concerns
- The 8 baseline reds above (environmental). Did not run the full suite after the change; only tests/runtime (the brief's scope).

## Fix round 1 (spec 3.2 amended in d07cd2d) - commit bbcac9e
Changes in protocol.ts `extractFinalObject`: unclosed `{` after the brace pass => none; any top-level span failing JSON.parse => none (fence bodies that fail to parse are ignored); every object node of every parsed candidate (iterative stack walk, arrays traversed, no spread pushes) is offered to `accepts`; dedupe by JSON.stringify with recursively sorted keys; a tree that cannot be serialised (throws) => none. Whole-parse first, one parse per candidate, linear passes kept. Counts: `candidates` = distinct parsed candidate roots (so an envelope and its nested result count 1), `valid` = distinct accepted nodes; hidden text forces method none but keeps the honest counts (so evidence is still written for none with candidates > 0).

Test changes (old -> new), extractFinalObject.test.ts, 31 -> 40 tests:
- `accepts the one plan in a fence after prose with an unclosed brace` -> `refuses a fence after prose with an unclosed brace` (none, 1/1).
- `accepts the one plan in a fence inside a brace-wrapped note` -> `refuses a fence inside a brace-wrapped note that is not JSON` (none, 1/1).
- New accept row `accepts the one plan in an answer wrapped in a valid object` (nested walk).
- `performance > finds a fenced plan after 4 MiB ... noise` -> `refuses a fenced plan after 4 MiB ... noise in under 2 s` (none, 1/1). `answers none for a bare plan after the same noise` unchanged.
- New: three probe shapes as must-reject (verify, fenced approval + hidden rejection: unclosed brace, non-JSON wrapper, stray quote in span); nested rejection + fenced approval => none 2/2; nested rejection alone accepted 1/1; same rejection with reversed key order counted once; perf: 130k `{"a":1}` lines + fenced plan accepted (<2 s), 50k distinct objects + bare plan accepted (<2 s).
All other tests unchanged.

Evidence: RED against the old implementation (k1f-red.txt): 10 failed | 30 passed (the 3 probes, nested x2, key order, 2 reversed rows, nested-wrapper accept, 4 MiB refusal). GREEN: focused files rc=0, 78 passed (k1f-green.txt); typecheck rc=0; `vitest run tests/runtime` rc=0, 39 files / 323 tests (k1f-runtime.txt).

Concern for K4: fence collection is now effectively redundant for object bodies (any parseable object fence body is also a balanced span, and unreadable text fails closed), so mutation M2 (drop fence push) can no longer be seen red by any behavioural test; M2 and the "fenced-only" Review Focus 1 need a controller ruling (drop M2 or drop fence collection). Other mutation expectations (M1,M3-M7) remain plausible but were not re-run.

### Fix round 1, part 2: fence collection removed (controller ruling on M2)
Commit: see `git log` subject "refactor(codex): drop fence collection from final-object extraction". The fence pass is deleted; candidates are the top-level balanced spans only (a span that fails JSON.parse still fails closed). Doc comment updated.
Expectation changes (3, all counts of my own round-1 rows; no fenced-accept expectation changed, all fenced samples are still accepted via the brace pass):
- `refuses a fence after prose with an unclosed brace`: none 1/1 -> none 0/0 (the unclosed `{` swallows the fence, so no span exists).
- `refuses a fence inside a brace-wrapped note that is not JSON`: none 1/1 -> none 0/0 (the only span is not JSON).
- `performance > refuses a fenced plan after 4 MiB ... noise`: none 1/1 -> none 0/0.
Verification: focused files rc=0, 78 passed (k1g-green.txt); typecheck rc=0; `vitest run tests/runtime` rc=0, 39 files / 323 tests (k1g-runtime.txt). M2 is dropped per ruling; no other mutation re-run.
