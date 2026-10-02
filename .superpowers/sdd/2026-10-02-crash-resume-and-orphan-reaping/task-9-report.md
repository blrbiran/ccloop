# Task 9 report: R-B (claude's own partial error with changed files goes to verify; the execute prompt names the checks)

Implementer: Task 9 subagent, Orca session ece96b67, 2026-10-02. Base: `a7acbea`. Commit: the one whose subject is
`fix(loop): send claude's own partial error with changed files to verify, and tell execute who runs the checks`
(this report goes in with it).

## Status
DONE. The spec's §5.1, §5.2 and the folded Task 3 item are implemented. T11a-f, T12 and the runner-level criteria are new
and were seen red before the change. Mutations M9a-M9e were all seen red. One existing criterion's fixture was changed
(below, pending human ratification).

## Changes
- `scripts/claude-phase-runner.mjs`
  - `buildPartialExecutionOutcome` adds `partialOrigin: "runner"`. This covers both the failure partial and the interrupt partial.
  - On the execute structured path, `partialOrigin` is deleted from claude's answer before `partialExecutionRuleBroken`.
  - Folded Task 3 item: `if (parentGone) return;` right after the request is read in `main()`. `spawnClaude` also refuses
    its first attempt when `parentGone` is already set: it throws `ClaudeNeverStarted("EPARENTGONE: …")`, and main
    writes nothing for it because `parentGone` is set.
- `src/runtime/types.ts`: `PartialExecutionResult.partialOrigin?: "runner"`. The adapter passes the runner's object
  through unchanged (`claudeAgentAdapter.phase` returns the parsed object), so the field reaches runLoop.
- `src/controller/runLoop.ts`: in the partial branch, the `sendToVerify` block follows the brief verbatim. It runs after
  the partial path-policy human-gate return and appends the `partial_execute_sent_to_verify` event. Otherwise it keeps
  today's terminal path unchanged.
- `src/runtime/claude/prompts.ts`: the three §5.2 lines go after `Success condition`. They also reach codex, because
  `codexAdapter.ts:42` appends to `buildExecutorPrompt`. That is intended (same contract).

## Downstream read (controller note)
- The attempt artifacts are written twice: once at the start of the partial branch and again after verify (or at the
  budget/gate exits). `writeAttemptArtifacts` (`src/persistence/fileStore.ts:1990`) uses only `writeFile`, so the second
  write only overwrites.
- `isPartialExecutionResult` uses: `runLoop.ts` has two. The second is in the outer catch's `PhaseExecutionError` path.
  If verify throws after a sent-to-verify partial, that path re-evaluates the partial path policy. The policy cannot
  have hit (the branch would have returned already), so it is a no-op and the run takes the generic failure handling,
  the same as for a complete execution.
- No `src` reader of `completionStatus` or `failureType` exists outside runLoop's partial branch (grep over `src`).
  `runVerification` and `getVerificationPrimaryTargetPaths` read only `ExecutionArtifacts` fields. The verifier prompt
  (agent verifier) shows the whole execution JSON, partial fields included, which is informative rather than misleading.
- Nothing needed fixing downstream.

## Decisions taken (smallest reasonable thing)
1. **Codex partials.** Codex's `protocol.ts` partial schema is `.strict()` and never carries `partialOrigin`, so a codex
   model's own `error` partial with changed files also goes to verify now. I read this as the same rule for the same
   case: the model's own answer, which is what the codex adapter returns. The spec says "claude's own", so the
   controller may want to note it.
2. **The parent-gone-before-spawn criterion.** It is cheap and observable from outside. I added a fixture option
   `closeWatchFirstMs` to `tests/fixtures/runner-parent.mjs`: the fixture closes its end of fd 3 at once and writes the
   request 400 ms later, inside a 3000 ms grace. The runner then reads a whole request after it has already seen its
   parent gone.
   - Before the change, claude was spawned: `<marker>.argv` existed, red in `red.txt`.
   - After the change, it is not.
   - The two guards cover each other: removing either one alone stays green (M9f1, M9f2). Only removing both is red (M9f).
3. **Prompt line placement.** The new lines go immediately after `Success condition`, before "Never declare final
   success". This follows the brief's literal instruction.

## Existing criteria rewritten
- `tests/control/materialize.test.ts` > "committed continuation materialization > puts the continuation input itself
  into the plan and execute prompts every adapter builds".
  - What changed: the fixture only. Its partial contract (cast `as unknown as LoopContract`) had no `verification`. The
    executor prompt now reads `contract.verification.requiredChecks`, so the test threw "Cannot read properties of
    undefined (reading 'requiredChecks')". This was the full-suite run's only UNEXPECTED red (`full.json`,
    `known-reds.txt`).
  - Old: the fixture contract had no `verification`. New: it has `verification: { requiredChecks: ["true"] }`. Every real
    contract has this field (`src/contract/schema.ts:62`, required, `min(1)`). The expectations are unchanged and
    nothing is loosened.
  - I did not make the product code tolerate a missing `verification`. A contract without it is invalid, and
    `buildVerifierPrompt` already reads the field unguarded.
  - Status: encodes spec 2026-10-02 crash-resume §5.2, pending human ratification.
- No expectation in `runLoop.integration.test.ts` or `claudePhaseRunner.test.ts` changed. Their partial-error criteria are
  all human-gate (denylist) cases, which return before the new block, or `toMatchObject` shapes.

## Tests added
- `tests/controller/partialToVerify.test.ts` (6): T11a-T11f. `ScriptedAdapter`, `verifierType: "command"`. Exact event
  lists, `verify.json` presence or content, and the stop reason.
  - T11b pins `failed` / "verifier rejection with no safe retry path" with `failingCommand: "false"`.
  - T11f pins `exhausted` / the budget reason, `tokenBudgetRemaining 0`, no `execution_finished`, no `verify.json`.
- `tests/runtime/claude/claudePhaseRunnerPartialOrigin.test.ts` (3):
  - the runner's failure partial carries `partialOrigin: "runner"`;
  - claude's own structured partial has `partialOrigin` stripped, with its other partial fields kept;
  - T12: the header comes after `Success condition`, followed by exactly the check lines and the instruction sentence.
- `tests/runtime/claude/claudeParentWatch.test.ts` (+1): "parent gone after the request is read but before the first
  spawn -- no claude spawned" (decision 2).

## Evidence
Scratch: `$S=/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t9`.

**Main tree, single files.** All output went to files and was read back whole.
- RED: `$S/red.txt` RC=1. 7 of the new criteria failed. T11c, T11d and T11e were green before the change: they pin
  behaviour that is unchanged.
- GREEN: `$S/green.txt` RC=0, 19/19.
- Focused reruns, each file alone, all RC=0: `$S/g-*.txt`.

| File | Tests |
|---|---|
| partialToVerify | 6 |
| runLoop.integration | 71 |
| claudePhaseRunner | 24 |
| claudePhaseSchemas | 4 |
| claudeAgentAdapter | 24 |
| claudePhaseRunnerFailure | 2 |
| claudeNeverStarted | 8 |
| claudePhaseRunnerNeverStarted | 5 |
| fakeClaudeCli | 18 |
| tests/runtime/codex/adapter | 4 |
| tests/runtime/codex/protocol | 38 |
| tests/runtime/codex/transport | 2 |
| tests/validation/codexAdapter | 7 |
| tests/validation/contracts | 19 |
| tests/validation/evidence | 29 |
| materialize (after the fixture change, `g-materialize2.txt`) | 15 |

- Typecheck: `npx tsc --noEmit -p .` RC=0 (`$S/tsc.txt`).

**Clone `$S/t9-mut`.** It is a `git clone --local` of `a7acbea` plus this work as two local baseline commits.
- Env: HOME and the four XDG roots in `$S/home`, `TMPDIR=$(mktemp -d /private/tmp/cl-XXXX)`, `ECC_GATEGUARD=off DISABLE_OMC=1`.
- `npm run build` RC=0 (`build.txt`). tsc RC=0 (`clone-tsc.txt`).
- Full suite: 1123 tests (`full2.json`). `check-known-reds` RC=0 (`known-reds2.txt`): the only failure is the known
  `stopProof` red.
- `check-tmp-leak` RC=0 (`tmp-leak.txt`): "1123 tests, 0 entries left".
- The first full run (`full.json`, `known-reds.txt` RC=1) is the one that exposed the materialize fixture.

## Mutations
Driver `$S/mutate.py`, summary `$S/mutate-summary.txt`. After each mutation, `git diff` was 0 bytes and
`git diff --cached` was 0 bytes.

| M | Change | Result | Red line |
|---|---|---|---|
| M9a | `sendToVerify = false` | red (`mut-M9a.txt`) | T11a "expected 'failed' to be 'succeeded'" (also T11b, T11f) |
| M9b | drop the `partialOrigin` condition | red | T11d "expected 'succeeded' to be 'failed'" |
| M9c | drop `changedFiles.length > 0` | red | T11c "expected 'succeeded' to be 'failed'" |
| M9d | drop `partialOrigin` from the runner's partial | red | runner partial: `- "partialOrigin": "runner"` |
| M9d2 | drop the strip of claude's `partialOrigin` | red | strip criterion "expected true to be false" |
| M9e | remove the three prompt lines | red | T12 "expected -1 to be greater than 3" |
| M9f | remove both parentGone guards | red | parent-gone-before-spawn "expected true to be false" (`.argv` exists) |
| M9f1 | remove only the `spawnClaude` guard | green | covered by the `main` return |
| M9f2 | remove only the `main` return | green | covered by the `spawnClaude` guard |

## Concerns
1. M9f1 and M9f2 are green on their own, by construction: each guard backs up the other. Only the pair is pinned.
2. Codex `error` partials with changed files now go to verify too (decision 1).
3. The new parent-watch criterion takes about 3.2 s, because it waits out the grace kill. Its timing is a 400 ms request
   delay inside a 3000 ms grace, so it has a wide margin.
4. Process hygiene: `pgrep -fl "fake-claude-cli|claude-phase-runner|runner-parent"` found nothing, RC=1
   (`$S/pgrep-final.txt`).
