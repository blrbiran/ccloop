# Task 1 Report — Support freezing the A-04 contract with execution-policy overrides

## What I implemented
- Added `ExecutionPolicyOverrides` in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts` for the approved override surface only: `tokenBudget`, `perAttemptTimeoutMs`, `totalRuntimeBudgetMs`, and `partialOutcomeRecoveryWindowMs`.
- Extended `renderScenario(...)` to accept `executionPolicyOverrides` and merge them into the rendered contract while still parsing through `loopContractSchema`.
- Preserved existing scenario semantics: `maxAttempts` is still fixed, Scenario A-E definitions were not changed, and Scenarios C/D still require a positive operator timeout when no override is supplied.
- Added focused tests in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts` covering explicit Scenario A overrides, unchanged defaults for non-overridden fields, and schema rejection of invalid override values.

## What I tested and results
- Focused RED run: failed as expected before implementation because overrides were ignored and `tokenBudget: 0` was not rejected.
- Focused GREEN run: passed after implementation; all contract-rendering and render-contract CLI tests stayed green.
- Full suite run: passed before commit.

## TDD Evidence
### RED
- Command: `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/contracts.test.ts`
- Relevant failing output:
  - `expected ... tokenBudget: 50000 to match ... tokenBudget: 550000`
  - `expected [Function] to throw an error`
- Why expected: the pre-change `renderScenario` path did not accept or merge `executionPolicyOverrides`, so defaults remained in place and schema validation never saw the invalid override.

### GREEN
- Command: `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/contracts.test.ts`
- Relevant passing output: `tests/validation/contracts.test.ts (14 tests)` and `Tests 14 passed (14)`.

## Full-suite verification
- Command: `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test`
- Result: PASS — `Test Files 13 passed (13)` and `Tests 117 passed (117)`.

## Files changed
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts`

## Commit created
- `4c03491 feat: support A-04 contract overrides`

## Self-review findings
- Confirmed only the approved override fields are exposed; `maxAttempts` remains non-overridable.
- Confirmed contract generation still flows through `loopContractSchema`, so invalid override values are rejected instead of being serialized.
- Confirmed Scenario C/D timeout gating still exists for non-overridden calls, and existing A-E rendering assertions remained green.
- Confirmed the commit contains only the two allowed task files; unrelated existing `package-lock.json` modification remains unstaged.

## Issues or concerns
- No code concerns. The worktree still has a pre-existing unstaged change in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/package-lock.json`, but it was not included in the commit.


## Review fix addendum — 2026-07-18

### What I changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts` so Scenario C/D compute `perAttemptTimeoutMs` with override-first semantics: `executionPolicyOverrides.perAttemptTimeoutMs ?? resolveTimeoutMs(id, timeoutMs)`.
- Kept the remaining execution-policy override merge behavior unchanged after the timeout value is derived.
- Added a regression test in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts` proving Scenario C renders successfully when only `executionPolicyOverrides.perAttemptTimeoutMs` is supplied.

### Exact test command(s)
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/contracts.test.ts`

### Relevant output
```text
> ccloop@0.1.0 test
> vitest run --run tests/validation/contracts.test.ts

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval

 ✓ tests/validation/contracts.test.ts (15 tests) 1847ms
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

### Files changed
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts`

### Commit created
- `0bcecd4 fix: honor override-first validation timeouts`

### Concerns
- No code concerns for the fix itself.
- The target worktree still has a pre-existing unstaged modification in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/package-lock.json`; it was not part of this fix commit.


## Second review fix addendum — 2026-07-18

### What I changed
- Updated `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts` to stop spreading raw `executionPolicyOverrides` into `executionPolicy` and instead apply an explicit runtime whitelist for only `tokenBudget`, `perAttemptTimeoutMs`, `totalRuntimeBudgetMs`, and `partialOutcomeRecoveryWindowMs`.
- Preserved override-first timeout behavior for Scenario C/D by deriving `perAttemptTimeoutMs` from the whitelisted overrides before falling back to the operator-supplied timeout.
- Added a regression test in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts` proving unapproved runtime fields (`maxAttempts`, `autonomyLevel`, `worktreeRequired`) are ignored even when passed via `as any`.

### Exact test command(s)
- `npm --prefix "/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval" test -- --run tests/validation/contracts.test.ts`

### Relevant output
```text
> ccloop@0.1.0 test
> vitest run --run tests/validation/contracts.test.ts

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval

 ✓ tests/validation/contracts.test.ts (16 tests) 1929ms
 Test Files  1 passed (1)
      Tests  16 passed (16)
   Duration  2.20s
```

### Files changed
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/validation/v1/lib/scenarios.ts`
- `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/tests/validation/contracts.test.ts`

### Commit created
- `85874b3 fix: whitelist validation runtime overrides`

### Concerns
- The target worktree still has a pre-existing unstaged modification in `/Users/biran/code/skills/loop/ccloop/.worktrees/a04-preflight-approval/package-lock.json`; it was not part of this fix commit.
