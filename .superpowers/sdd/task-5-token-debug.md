# Task 5 Token Debug Investigation — A-03 Accounting

## Status
- Result: ROOT_CAUSE_FOUND
- Scope: investigation plus approved minimal fix record. No real Claude/model call.
- Classification: PRODUCT_DEFECT

## Observed Evidence
Source: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/.superpowers/sdd/task-5-report.md`

Observed A-03 persisted values:
- Contract budget override: `100000`
- Plan artifact token usage: `19882`
- Execution artifact token usage: `440874`
- Verifier was skipped / no verifier artifact produced
- Combined visible persisted usage: `460756`

Direct artifact extraction confirmed:
- `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/.validation-runs/contracts/A-03.json` -> `executionPolicy.tokenBudget = 100000`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/.validation-runs/runs/A-03/attempts/1/plan.json` -> `tokenUsage = 19882`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/.validation-runs/runs/A-03/attempts/1/execution.json` -> `tokenUsage = 440874`

## Exact Source Trace
### Envelope to phase-runner accounting
File: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/scripts/claude-phase-runner.mjs`

Token extraction function:
```js
function getTokenUsage(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return undefined;
  }

  const usage = envelope.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const candidates = [usage.input_tokens, usage.output_tokens, usage.inputTokens, usage.outputTokens]
    .filter((value) => typeof value === "number");
  const total = candidates.reduce((sum, value) => sum + value, 0);

  return total > 0 ? total : undefined;
}
```

Envelope handoff:
```js
const envelope = JSON.parse(result.stdout);
const structured = envelope.structured_output;
const tokenUsage = getTokenUsage(envelope);
const response = tokenUsage === undefined ? structured : { ...structured, tokenUsage };
await writeJsonToStdout(response);
```

### Phase-runner output to controller
File: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/src/runtime/claude/subprocessClaudeAdapter.ts`
- `runPhase()` parses stdout JSON from `claude-phase-runner.mjs`
- returned JSON is used directly as plan / execute / verify result, including `tokenUsage`

### Controller budget consumption
File: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/src/controller/runLoop.ts`
- `applyPhaseUsage(state, elapsedMs, tokenUsage)` subtracts `tokenUsage ?? 0` from `tokenBudgetRemaining`
- plan path: `applyPhaseUsage(..., plan.tokenUsage)`
- execute path: `applyPhaseUsage(..., completedExecution.tokenUsage)`
- verify path: `applyPhaseUsage(..., verification.tokenUsage)`

Conclusion from trace:
- There is no later normalization or de-duplication.
- Any double count introduced in `scripts/claude-phase-runner.mjs:getTokenUsage()` flows unchanged into persisted attempt artifacts and directly into budget exhaustion logic.

## Current Test Coverage
Search results show no existing test that exercises usage envelopes with alias combinations (`input_tokens` / `output_tokens` vs `inputTokens` / `outputTokens`).
- Existing runtime Claude tests cover structured output / partial execution behavior.
- They do not cover token usage alias handling.

## Working / Reference Shape
### Local Claude CLI help
`claude --help` exposes JSON output modes (`--output-format json|stream-json`) and structured output (`--json-schema`), but help text does not document token-usage field names.

### Local Claude metadata reference
Local Claude metadata under `/Users/biran/.claude/.claude.json` consistently uses camelCase usage keys such as:
- `inputTokens`
- `outputTokens`
- `cacheCreationInputTokens`
- `cacheReadInputTokens`

Observed result from local metadata scan:
- camelCase present
- snake_case absent in sampled local persisted usage records

This is not definitive for CLI envelope shape, but it is a concrete local reference and it points toward camelCase as a known real shape.

## Synthetic Probe
I reproduced the current `getTokenUsage()` logic deterministically with synthetic envelopes:

- snake only: `{input_tokens: 100, output_tokens: 25}` -> `125`
- camel only: `{inputTokens: 100, outputTokens: 25}` -> `125`
- both aliases with same values: `{input_tokens: 100, output_tokens: 25, inputTokens: 100, outputTokens: 25}` -> `250`
- both aliases with camel zeroed: `{input_tokens: 100, output_tokens: 25, inputTokens: 0, outputTokens: 0}` -> `125`

Interpretation:
- The current function is alias-safe only when one naming convention appears.
- If both snake_case and camelCase aliases coexist with the same numeric values, the function double counts by summing all four fields.

## Could 440874 Still Be Legitimate?
Yes, in principle `440874` could be a legitimate single total if the underlying CLI really reported roughly that many total tokens for execution.

But the evidence is suspicious for a defect because:
1. The accounting code is objectively capable of double counting when both alias families coexist.
2. The local reference shape we found is camelCase-only, which suggests alias normalization should choose one representation rather than sum both.
3. `440874` is even and halves cleanly to `220437`, which is still large but plausibly closer to a single reported total than the doubled value.
4. There is currently no evidence in this repository proving that the real CLI envelope can emit both alias families at once, so the root cause is not “CLI definitely emitted both” — it is that our harness code would overcount if it did.

Therefore the confirmed defect is in the harness accounting logic, even though the historical A-03 value cannot be proven from preserved artifacts alone to be a duplicated envelope rather than a legitimate large total.

## Root-Cause Hypothesis
`/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/scripts/claude-phase-runner.mjs:getTokenUsage()` incorrectly sums both snake_case and camelCase usage aliases from the same `envelope.usage` object. If the Claude CLI envelope includes both representations simultaneously, the harness doubles token accounting before passing `tokenUsage` into the controller. Because the controller consumes that value directly with no normalization step, budget exhaustion and persisted `tokenUsage` become inflated.

## Classification
- Classification: `PRODUCT_DEFECT`
- Why not `CONTRACT_GAP`: the contract budget is clear; the suspected problem is implementation logic in the harness wrapper.
- Why not unresolved: the double-counting behavior of the current function is deterministically confirmed by synthetic probe, and the data-flow trace shows the inflated value would directly affect controller budget handling.

## Exact Failing Regression Test Needed
Add a focused regression around `scripts/claude-phase-runner.mjs` / runtime Claude wrapper behavior.

Minimal test:
1. In `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/tests/runtime/claude/subprocessClaudeAdapter.test.ts`, create a fake Claude binary that prints an envelope like:
```json
{
  "structured_output": {
    "changedFiles": ["src/counter.js"],
    "diffPatch": "diff --git a/src/counter.js b/src/counter.js",
    "commandOutputs": ["ok"],
    "stdoutStderrLog": "ok"
  },
  "usage": {
    "input_tokens": 100,
    "output_tokens": 25,
    "inputTokens": 100,
    "outputTokens": 25
  }
}
```
2. Run the existing phase-runner/subprocess path.
3. Assert returned `tokenUsage` is `125`, not `250`.

This is the minimal failing regression because it directly proves alias de-duplication at the exact wrapper boundary where the bug is introduced, without any model call.

## Summary
- A-03 historical evidence alone does not prove the real CLI emitted both alias families.
- However, the harness implementation is definitely wrong if both aliases coexist, and that wrong value flows straight into persisted artifacts and controller budget exhaustion.
- Result: confirmed harness/product defect in token accounting logic; fix should normalize alias families rather than summing both.

## Defect Fix Record
### Red
- Added actual wrapper-path regression coverage in `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/tests/runtime/claude/subprocessClaudeAdapter.test.ts` for:
  - snake-only envelope => `125`
  - camel-only envelope => `125`
  - duplicate snake+camel aliases => must stay `125`, not `250`
  - mixed aliases (snake input, camel output) => `125`
- Command: `npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Result: FAIL — duplicate alias case returned `tokenUsage: 250` instead of `125`.
- Exact failing evidence:
  ```text
  expected tokenUsage: 125
  received tokenUsage: 250
  ```

### Minimal fix applied
- File: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/scripts/claude-phase-runner.mjs`
- Implemented required semantics exactly:
  - input: choose `usage.input_tokens` when numeric, otherwise `usage.inputTokens`
  - output: choose `usage.output_tokens` when numeric, otherwise `usage.outputTokens`
  - sum chosen input + output only
  - return `undefined` when no numeric values are chosen or total `<= 0`
- No raw usage persistence, cache accounting, refactors, or unrelated changes were added.

### Green
- Command: `npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Result: PASS — `1` test file passed; `18` tests passed; `0` failed.
- Command: `npm test`
- Result: PASS — `13` test files passed; `102` tests passed; `0` failed.
- Command: `npm run typecheck`
- Result: PASS — `tsc --noEmit -p tsconfig.json` completed without errors.
- Command: `npm run build`
- Result: PASS — TypeScript compiled and regenerated `dist/cli.js` without errors.
- Command: `git diff --check`
- Result: PASS — no whitespace or patch-format errors.

### Historical A-03 Caveat
- This fix does **not** overwrite, reinterpret, or reclassify historical A-03 evidence.
- The preserved A-03 artifacts still cannot prove that the real CLI emitted both alias families in that run; they only prove that the old wrapper logic would double count if both were present.

### Non-finite JSON exponent follow-up
- Added two more actual phase-runner-path regressions using raw valid JSON envelopes so `1e400` survives parse as `Infinity`:
  - non-finite snake alias with finite camel fallback + finite output => `125`
  - non-finite snake alias with no finite fallback + finite output => `25`
- Command: `npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Result: FAIL — both new cases returned `tokenUsage: null` because `typeof === "number"` still accepted parsed `Infinity` and JSON serialization converted the resulting non-finite total to `null`.
- Minimal follow-up fix: switched alias selection and candidate filtering from `typeof === "number"` to `Number.isFinite`, while preserving snake-first/camel-fallback semantics and all approved finite behavior.
- Command: `npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Result: PASS — `1` test file passed; `20` tests passed; `0` failed.
- Command: `npm test`
- Result: PASS — `13` test files passed; `104` tests passed; `0` failed.
- Command: `npm run typecheck`
- Result: PASS — `tsc --noEmit -p tsconfig.json` completed without errors.
- Command: `npm run build`
- Result: PASS — TypeScript compiled and regenerated `dist/cli.js` without errors.
- Command: `git diff --check`
- Result: PASS — no whitespace or patch-format errors.
- Historical caveat remains unchanged: A-03 artifacts are preserved and still cannot prove that the real CLI emitted dual aliases; this follow-up only hardens the wrapper against non-finite parsed values at the external JSON boundary.
