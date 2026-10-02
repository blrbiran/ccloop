# Final-fix report (crash-resume round), Orca session ece96b67, commit fc47fc5

Status: DONE. One commit: fc47fc5.

## Grep hits for "never 0" / "no owner-transfer => not sweepable" (tree: src, scripts, README.md, tests)
- src/controller/runLoop.ts:104 -- false, ERRATUM appended (I1).
- src/control/singleCall.ts:106 -- false, ERRATUM appended (I1).
- src/sweep/sweepRuns.ts:215-216 -- false, ERRATUM appended (I1).
- src/runtime/claude/claudeAgentAdapter.ts:253 ("null when there is none -- never 0" on the timeout/failed throw) -- false for the never-started path raised just above; ERRATUM appended.
- src/runtime/claude/claudeAgentAdapter.ts:35 (ClaudePhaseAborted, no observation stays null) and :236 (result after a stop) -- still true (never-started is a different error / path); left.
- src/runtime/types.ts:148,159 -- already carry the ERRATUM at :161; left.
- src/runtime/types.ts:190 ("never 0 for null", SingleCallOutputInvalid) -- about a different error; true; left.
- tests/runtime/claude/claudeAgentAdapter.test.ts:312, tests/runtime/phaseTimeoutUsage.test.ts:15, tests/control/singleCall.test.ts:172,199 -- describe streamed/started claude with no observation; true; left.
- tests/sweep/sweepRuns.test.ts:707,733 ("not a candidate") -- about shape-1 runs with a lock/tracked rows in older tests; not asserting that transfer-less runs can never be swept; left.
- README.md:73 -- edited (sweep row). README.md:100-106 -- edited (M3). README §3.4 already describes class (b).
- scripts/: no hits.

## Changes
- M2: execute() catch now `if (abortSignal.aborted && observedTokensOf(error) === null) return null` (class-independent). New test "execute with the signal already aborted and the runner's own never-started answer rejects, observed as 0" in tests/runtime/claude/claudeNeverStarted.test.ts (stubs adapter.run to return a completed outcome carrying the never-started answer, signal pre-aborted; expects ClaudeNeverStartedError, observedTokensOf 0).
- M3: README resume order rewritten: lease, control run, owner-dead check (transfer-less resumable runs; refuses before any reaping), reaping (both paths), adoption write. Ambiguity decided: split the old adoption bullet into the check and the write so each sits where the code does it.
- M4: reapRunProcesses refusals all lead with `<callDir>: ` (Target type carries dir). Tests tightened to assert the prefix (existing reason tests were this round's); walk error already named the directory.
- M5: TERM-honouring child writes a marker in its SIGTERM handler then exits; test asserts the marker.

## Verification (main tree, single files, output to file)
- claudeNeverStarted.test.ts 9/9 pass; reapRunProcesses.test.ts 14/14 pass; `npx tsc --noEmit -p .` RC=0.
- Mutations in clone scratchpad/ff/mut (restore proof diff=0, cached=0 bytes):
  - M2 revert to old condition: new test RED (1 failed, 8 passed).
  - M5 delete the SIGTERM signal call: "TERM honoured" RED (marker absent).
  - M4 drop dir prefix on lstart mismatch: "refuses when the leader's lstart differs" RED (AssertionError on the dir).
- `pgrep -fl "fake-claude-cli|claude-phase-runner|runner-parent|setInterval"`: empty.

## Concerns
- Full suite not run (main-tree rule); only touched files run. No other tests assert reap reason strings (grep).
- README's M3 wording and sweep-row edit are prose, not command-verified.
