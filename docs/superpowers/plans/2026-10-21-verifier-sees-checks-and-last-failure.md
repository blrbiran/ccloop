# Plan — verifier sees checks (A), last failure carried (B), first check failure retried once (R, option (b))

Spec: `docs/superpowers/specs/2026-10-20-verifier-sees-checks-and-last-failure-design.md` (revision 3). Branch
`feat/verifier-sees-checks-and-last-failure` (from the spec branch). Implementer: Orca session `9ec98639`, 2026-10-21.
Criteria rewrites: approved by the human in this session (「这次批准改写所有必要的判据」) — each changed criterion carries a
`Ruling:` line in its commit. Mutations only in `git clone --local` copies (build first). Every run redirected to a file.

Success command (Rule 4): `npm run typecheck && npm run build && vitest run --reporter=json --outputFile=<s>/v.json;
node scripts/check-known-reds.mjs <s>/v.json` → RC 0.

## Task 1 — R (spec §3)
1. Write the §9 R tests in a new file `tests/controller/requiredCheckRetry.test.ts` (rows 1, 3, 5, 6, 9) and the row-7
   recovery assertion next to the existing recovery fixture. See them red for the named reason on the unchanged code
   (row 1, row 9: `failed`/`exhausted`; rows 3, 5, 6, 7: already green — they pin what (b) keeps; their red comes from
   the mutations).
2. Implement §3.1 (`checkFailureRetryable` through `runVerification` → `runRequiredChecks`; caller passes
   `attempt + inheritedAttempts === 1 && recovery === undefined`).
3. Rewrite criteria §8.1 items 2–4 exactly as the spec says (probe-verified).
4. Mutations in a clone: R-off, R-every-attempt, R-run-local, R-in-recovery — each red on its named test(s).

## Task 2 — A (spec §4, §6.1, §7.1)
1. Tests: `tests/runtime/verifierCheckResults.test.ts` — builder placement/byte-identity without the field, bounds
   (10 MiB "é", five checks), runLoop context capture (`printf ok; printf err >&2`), saved-result `checkRunner` path,
   real adapters through the three fakes (prompt recorded). Red first.
2. Implement: `RequiredChecksOutcome.results`, `AttemptContext.requiredCheckResults`, the spread at the verify call,
   `buildVerifierPrompt` block + `tailBytes` helper.
3. Rewrite criterion §8.1 item 1 (independent oracle).
4. Mutations: emit unconditionally; emit never; head instead of tail; drop boundary step; drop `/ n`; drop the spread;
   fill results only on the `execFileAsync` branch.

## Task 3 — B (spec §5, §6.2, §7.2)
1. Tests: builders with/without `lastFailure` (planner, executor, codex null line + wrap line last), excerpt rules,
   runLoop attempt-2 contexts (needs R), allowance continuation (materialize returns evidence; runLoop hook carries it),
   crash resume via `resumeLoop` seeding (match / non-match / missing), adapter wiring × 3 kinds × plan/execute.
2. Implement: `AttemptContext.lastFailure`, `lastRejectionEvidence` in `runLoopFromState` (retry branch, hook, disk
   read), contexts at plan/execute only, `buildPlannerPrompt(contract, lastFailure?)`, three adapters pass it,
   executor block, `materialize.ts` plan branch returns `lastRejectionEvidence` when it is a string array, hook type.
3. Mutations: planner ignores param; keep passed entries; stop setting evidence; pass into verify context; drop from
   materialize; gate on `attempt >= 2`; skip disk read; skip fingerprint comparison; per-kind plan call drops arg (×3);
   executor ignores it.

## Task 4 — Correction (spec appendix)
Append the Correction section to `docs/superpowers/specs/2026-10-18-codex-phase-isolation-design.md`; scan
`src/agents/codexIsolation.ts`'s registration comment for the same claim (append an ERRATUM if it says byte-unchanged).
The handoff sentence is the controller's (the handoff already carries the 更正).

## Task 5 — Gate and land
Full suite + known-reds RC 0; re-run `savedResultRecovery.native.test.ts` alone and compare to the §8.2 baseline;
rebase on `main`; re-run; `merge --ff-only`; remove worktree; `branch -d`.
