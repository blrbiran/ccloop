# Usage Evidence Task 2 Report

## Status
- Status: DONE
- Implementation commit: `550065f84500d8531ace377126629f81e117bf4a`
- Report correction commit: `cfa0299a993ce4528713448c8ad2ab1f3c2ea1b7`

## Modified Files
- `tests/runtime/claude/subprocessClaudeAdapter.test.ts`

## Command And Actual Results
- Command: `npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1 test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Result: PASS. `tests/runtime/claude/subprocessClaudeAdapter.test.ts` passed 27/27 tests, including invalid-type coverage, non-finite fallback, finite-overflow omission, zero-total omission, and partial omission assertions.
- Command: `npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1 run typecheck`
- Result: PASS. `tsc --noEmit -p tsconfig.json` completed successfully.

## Self-Review
- Added deterministic raw-envelope cases for all-invalid usage aliases, the required mixed invalid-type envelope (`input_tokens: "100", output_tokens: 25`), negative-plus-fractional totals, zero-sum omission, and finite `Number.MAX_VALUE` overflow omission.
- Confirmed the existing wrapper implementation already satisfied the brief, so `scripts/claude-phase-runner.mjs` remained unchanged.
- Tightened partial execute assertions so wrapper-returned partial payloads and recovery-generated partial payloads explicitly omit both `usageEvidence` and `tokenUsage`.
- Reviewed the final scoped diff to confirm only `tests/runtime/claude/subprocessClaudeAdapter.test.ts` changed for product/test scope.

## Concerns
- None.

## Reviewer Follow-up Fix (2026-07-18)
- Finding addressed: `tests/runtime/claude/subprocessClaudeAdapter.test.ts` covered `total===0` but lacked an independent `total<0` raw-envelope case.
- Fix: added a dedicated raw-envelope case with `input_tokens:-20` and `output_tokens:10`, asserting finite values are preserved in all four `usageEvidence.fields`, `selectedInputField === "input_tokens"`, `selectedOutputField === "output_tokens"`, `normalizedTotal === null`, and the payload omits `tokenUsage`.
- Verification command: `npm --prefix /Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1 test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Verification result: PASS. Vitest reported `Test Files  1 passed (1)` and `Tests  28 passed (28)` in 9.49s.
- Self-review: scoped diff only changes `tests/runtime/claude/subprocessClaudeAdapter.test.ts` and this report; product code remains unchanged.
- Commit message: `test: cover negative-total usage evidence case`
