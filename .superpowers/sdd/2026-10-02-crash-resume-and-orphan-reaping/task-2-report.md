# Task 2 report: adapter and usage, never-started books 0

Commit: 72b5f33 `fix(claude): book a never-started claude as 0 spent, in a phase and in a single call` (on top of d2ede88). Not pushed.

## Implementation
- `src/runtime/claude/claudeAgentAdapter.ts`: exported `ClaudeNeverStartedError` (neverStarted = true, spawnError, evidenceDir; message `claude-never-started: <spawnError> (<evidenceDir>)`); `neverStartedOf(outcome)` (exit 0, no signal, stdout is an object with `claudeNeverStarted === true` and string `spawnError`); `throwIfNeverStarted(outcome)` (aborted -> `ClaudePhaseAborted` with `neverStarted: true` assigned, else `ClaudeNeverStartedError`). Called as the first statement after the run in `phase()` and `singleCall()`.
- `src/runtime/types.ts`: `observedTokensOf` returns 0 when `error.neverStarted === true`; ERRATUM block appended to its doc comment, every existing line verbatim.

## Consumer check ("every consumer goes through observedTokensOf")
- `PhaseExecutionError` (src/controller/runLoop.ts:111): `this.tokenUsage = observedTokensOf(error)`; the catch at ~:1852 passes `error.tokenUsage` to `settlePhase`, which books it (`applyPhaseUsage`) and emits `onPhaseSettled` with `tokenUsage`. Verified by the runLoop test (booked 0, budget 999).
- `singleCall` (src/control/singleCall.ts:108,112): both the aborted and the failed branches use `observedTokensOf(error)`. Verified by the adapter-level test plus the existing singleCall tests; ClaudeNeverStartedError is not a SingleCallOutputInvalid so it takes the failed branch.
- Worker (src/control/worker.ts ~:200): reads `observation.tokenUsage` from `onPhaseSettled`, i.e. the runLoop settlement above; no direct read of the error. No consumer bypassed it; no change made there.

## Tests (tests/runtime/claude/claudeNeverStarted.test.ts, 6 cases, real adapter and runner, CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS=10 set/restored)
1. execute with missing claude: ClaudeNeverStartedError, spawnError ENOENT, observed 0.
2. singleCall with missing claude: ClaudeNeverStartedError (not SingleCallOutputInvalid), observed 0.
3. exit after start (script exits 1): not never-started, message claude-exit-error, observed null (Review Focus 5).
4. plan aborted during a 5 s retry wait: ClaudePhaseAborted, observed 0.
5. execute aborted during the retry wait: resolves null (execute's existing abort contract), not the never-started JSON.
6. runLoop with the real adapter for execute (plan stubbed): state failed, stopReason contains claude-never-started, onPhaseSettled execute tokenUsage 0 / completedWithResult false, budget remaining 999. (Used a stub plan rather than a plan-then-delete binary, the brief's allowed variant, but the execute is the real adapter+runner end to end.)

## RED / GREEN
- RED (before implementation): `./node_modules/.bin/vitest run tests/runtime/claude/claudeNeverStarted.test.ts` -> /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t2/red.txt: 5 of 5 failed (execute resolved instead of throwing; observed null instead of 0; ClaudeNeverStartedError import undefined; runLoop stopReason a TypeError). Case 3 was red only through the missing import; it is a regression guard and passes once the class exists.
- GREEN: same command, 6/6 pass (RC=0; typecheck `npx tsc --noEmit -p .` RC=0).
- Focused runs, each alone, RC=0: claudeAgentAdapter.test.ts 24/24, claudeSingleCall.test.ts 9/9, tests/control/singleCall.test.ts 8/8, tests/runtime/phaseTimeoutUsage.test.ts 4/4, tests/control/usage.test.ts 4/4. Outputs: /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t2/g-*.txt. Tree scan for `observedTokensOf|never 0` in tests hit only these files; none pinned.

## Mutations (clone /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t2/t2-mut, committed state; `git diff | wc -c` and `git diff --cached | wc -c` both 0 after each restore)
| M | mutation | red lines |
|---|---|---|
| M2a | drop the observedTokensOf branch | 4 red: "execute with a missing claude..." / "singleCall with a missing claude..." / "an abort during the retry wait throws..." / "runLoop books 0..." all "expected null to be +0" (tokenUsage match for runLoop) |
| M2b | move throwIfNeverStarted in phase() after the after-stop branch (to before the aborted throw) | 1 red: "an abort during the retry wait of execute answers null..." -> "expected { claudeNeverStarted: true, ... } to be null" |
| M2c | drop the call in singleCall() | 1 red: "singleCall with a missing claude..." -> expected SingleCallOutputInvalid to be an instance of ClaudeNeverStartedError |
Outputs: /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t2/m2a.txt, m2b.txt, m2c.txt.

## Files
src/runtime/claude/claudeAgentAdapter.ts, src/runtime/types.ts, tests/runtime/claude/claudeNeverStarted.test.ts (new).

## Existing criteria rewritten
None.

## Concerns
- M2b cannot be shown red through `plan()`: the after-stop branch only runs for execute (afterStop set), so the abort criterion for M2b goes through `execute()`. But execute()'s catch returns null for an aborted execute whose error has observedTokens null, so a never-started abort during execute reaches runLoop as null (unknown), not 0. Spec 3.2 only requires the error to carry neverStarted; I left execute()'s contract unchanged (smallest change) and recorded it as case 5. If a booked 0 is wanted for an aborted never-started execute, execute()'s catch would also keep errors with neverStarted true. Decision for the controller.
- The ClaudePhaseAborted for a never-started abort has observedTokens null; observedTokensOf yields 0 only through the neverStarted marker (as the brief specifies).
- Abort tests use real timing (abort at 1.5 s, retry delay 5 s); a very loaded machine could abort before the first spawn fails (then the runner is stopped earlier and the result is the same never-started answer or a plain abort); not observed flaky in 3 runs.

## Fix round 1 (review: one Important, two follow-ups)
Commit: see git log (second Task 2 commit, "an aborted never-started execute books 0; ...").

Changes
1. execute()'s catch now rethrows an error observed as 0: swallow condition is `!(error instanceof ClaudePhaseAborted && (error.observedTokens !== null || observedTokensOf(error) === 0))`. Old test 5 (resolves null) rewritten whole to the spec behaviour: execute rejects with ClaudePhaseAborted and observedTokensOf 0. Added a runLoop-level case: a handoff abort (options.phaseSignal) during the retry wait of a real never-started execute settles execute with tokenUsage 0. Finding: runLoop routes any thrown error from a phase through runPhaseWithTimeout -> PhaseExecutionError -> observedTokensOf (runLoop.ts:480, :111), so the thrown ClaudePhaseAborted reaches booking with no runLoop change.
2. Tests 4, 5 and the new runLoop case now poll the call's evidence for request.json (20 ms poll, 10 s deadline), then wait 300 ms, then abort.
3. neverStartedOf requires exactly two keys (claudeNeverStarted, spawnError). New test: a claude whose structured output carries those two keys, so the runner's exit-0 answer has them plus tokenUsage/usageEvidence, resolves as a plan result (not never-started).

Evidence (current tree)
- Covering files each alone, RC=0: claudeNeverStarted 8/8, claudeAgentAdapter 24/24, claudeSingleCall 9/9, phaseTimeoutUsage 4/4 (outputs /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t2/f-*.txt); `npx tsc --noEmit -p .` RC=0.
- Mutations (fresh clone /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t2/t2-mut2, restore proof diff and diff --cached both 0 bytes each time):
  - M2d revert the execute catch fix: red "an abort during the retry wait of execute rejects ..." (resolved) and "runLoop books 0 when a handoff aborts ..." (tokenUsage not 0). /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t2/m2d.txt
  - M2e drop the two-key check: red "an exit-0 object with the never-started keys plus usageEvidence is a result" (threw claude-never-started). /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t2/m2e.txt
  - M2b (rerun, against the rewritten test): throwIfNeverStarted moved after the after-stop branch: same two tests red (resolved with the never-started JSON; tokenUsage not 0). /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t2/m2b2.txt
- Concern: M2e's lookalike reaches the adapter through the runner (claude's structured_output containing those keys); a hand-made two-key-plus-usageEvidence stdout is not producible through the fake CLI, but the key-count check is what the test pins.
