# Task 1 report (Orca session ece96b67 implementer, commit d2ede88)

## Implemented
scripts/claude-phase-runner.mjs: spawnClaude/spawnClaudeOnce (try/catch plus error/spawn listeners before any stdio touch), ClaudeNeverStarted, ENOENT-only retry (3 spawns, CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS default 2000, parsed by readNonNegativeIntEnv), never-started answer `{claudeNeverStarted:true, spawnError}` exit 0 (main catch, before the execute partial branch; handleInterrupt branch for SIGTERM during the wait), globals claudeEverStarted / lastSpawnFailure / parentGone (declared only), delay var stripped in claudeEnv().

## Tests
New: tests/runtime/claude/claudePhaseRunnerNeverStarted.test.ts (5 tests), 5/5 green. Other runner files run alone, all RC=0: claudePhaseRunner 24, Env 8, Failure 2, Stream 6, largePrompt 3, stderrDecoding 1, claudeSingleCall 9 (outputs in /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t1/*.txt).

## TDD
RED: ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run tests/runtime/claude/claudePhaseRunnerNeverStarted.test.ts > /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t1/t1-red.txt (5 of 5 failed: exit 1 / empty stdout). GREEN: same command > /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t1/t1-green.txt RC=0.

## Mutations (clone /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t1/t1-mut, base d2ede88; restore proof git diff | wc -c = 0 and git diff --cached | wc -c = 0 after each)
| M | change | red |
|---|---|---|
| M1a | retry forced false | "after three spawns": expected 65 to be >= 400; "second spawn": expected undefined to deeply equal ['answer.txt'] |
| M1b | handleInterrupt never-started branch -> if (false) | T5b: expected 1 to be +0 |
| M1c | main ClaudeNeverStarted branch -> if (false) | "after three spawns": expected 1 to be +0; EACCES and single-call: Unexpected end of JSON input |

## Files changed
scripts/claude-phase-runner.mjs, tests/runtime/claude/claudePhaseRunnerNeverStarted.test.ts.

## Existing criteria rewritten
None.

## Concerns
- parentGone is never set yet (Task 3), so its branches are untested here.
- Not mutated: the claudeEnv strip of the delay var (no test pins it).
- This report file is not committed (needs git add -f; controller decides).
