# Task 8 Report: Wire the lease gate into `runLoop`

## Summary

Successfully wired the lease gate (`checkRunLease`) into the `runLoop` function at the correct position: **after `initializeRunFiles` and before `writeOwnerRecord`**. This ensures the gate can append an event (since `events.jsonl` now exists after initialization) but checks before establishing the owner record.

## Implementation Details

### Changes Made

**File: `src/controller/runLoop.ts`**

1. Added import for `checkRunLease`:
   ```ts
   import { checkRunLease } from "./leaseGate.js";
   ```

2. Added the gate call in the `runLoop` function between initialization and owner record write:
   ```ts
   export async function runLoop(contract: LoopContract, runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
     const state = transitionRunState(initialState(contract), "planning");
     const ownerRecord = buildInitialOwnerRecord(contract, state);
     await initializeRunFiles(runDir, contract, state);
     // §7: as early as possible, but never before initializeRunFiles — the gate may append an
     // event and events.jsonl does not exist yet. §7.0: ensureFreshRunDir has already thrown
     // on any pre-existing run file, so this call can only ever observe "no owner record";
     // every other branch is reachable through resumeLoop alone.
     await checkRunLease(runDir, ownerRecord.currentProcessInstanceId, Date.now());
     await writeOwnerRecord(runDir, ownerRecord);
     await appendTransitionEvent(runDir, state, "loop_planning", "run initialized and ready to plan");
     return runLoopFromState(contract, runDir, adapter, state);
   }
   ```

**File: `tests/controller/runLoop.integration.test.ts`**

1. Added `successFrame()` helper function to create a successful execution frame
2. Added two tests (before the production change, verified they pass):
   - "throws from ensureFreshRunDir on a second start rather than reaching the lease gate" — validates that a second start fails loudly from `ensureFreshRunDir` with "already contains prior run data" message
   - "appends no event before initializeRunFiles on a brand-new run directory" — validates that no `lease_expired_observed` event is added on fresh starts, and the first event is `loop_planning`
3. Updated the "exhausts the run when adapter-reported token usage exceeds the token budget" test to account for the gate's `Date.now()` call by adding an extra timestamp value (from `[1_000, 1_600]` to `[1_000, 1_000, 1_600]`)

## Test Cycle (Inverted TDD)

### Pre-Change Test Run

**Command:** `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/runLoop.integration.test.ts`

**Result (before production change):**
```
 ✓ tests/controller/runLoop.integration.test.ts (46 tests) 7034ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 919ms

 Test Files  1 passed (1)
      Tests  46 passed (46)
   Start at  12:23:35
   Duration  7.40s
```

**Key verification:** Both new tests PASSED before the production change, confirming they pin existing behavior that must survive the gate insertion.

### Post-Change Test Run

**Command:** `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/runLoop.integration.test.ts`

**Result (after production change and timing fix):**
```
 ✓ tests/controller/runLoop.integration.test.ts (46 tests) 6944ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 735ms

 Test Files  1 passed (1)
      Tests  46 passed (46)
   Start at  12:26:09
   Duration  7.34s
```

**Key result:** All 46 tests pass, including the 2 new tests. The focused test file is clean.

### Full Suite Verification

**Command:** `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`

**Result:**
```
 Test Files  21 passed (21)
      Tests  325 passed (325)
   Start at  12:26:21
   Duration  15.47s
```

**Baseline expectation met:** 21 files / 323 tests green ✓ (actually 325 tests pass now, which includes the 2 new tests)

### TypeCheck and Build

**Commands:**
- `npm run typecheck` — ✓ PASS
- `npm run build` — ✓ PASS

## Design Decisions

### Gate Call Timing

The gate is positioned **immediately after `initializeRunFiles` and before `writeOwnerRecord`** because:

1. **After `initializeRunFiles`**: The gate may append an event to `events.jsonl`. This file does not exist until `initializeRunFiles` creates it, so a gate placed earlier would crash on every fresh start.
2. **Before `writeOwnerRecord`**: The gate's job is to check for lease conflicts before this process establishes its own ownership record. Placing it after `writeOwnerRecord` would be too late.

### No-Op on Fresh Starts

As noted in the brief, `runLoop` is the fresh-start path. Since `initializeRunFiles` begins with `ensureFreshRunDir`, which throws if any prior run file exists, a `runLoop` call can **only ever observe "no owner record"**. The gate immediately returns `{ kind: "no_record" }` without attempting lease verification. Every other branch (expired leases, lease conflicts, held-by-self) is reachable only through `resumeLoop`.

### Date.now() Parameter

The gate is called with `Date.now()` passed explicitly:
```ts
await checkRunLease(runDir, ownerRecord.currentProcessInstanceId, Date.now());
```

This is necessary because:
1. The gate function has a default parameter that calls `Date.now()` if not provided
2. Tests using date spies would have their timestamp sequences shifted by an implicit call
3. Passing the value explicitly ensures the gate's timing doesn't introduce unexpected side effects

### Timing Test Fix

The existing test "exhausts the run when adapter-reported token usage exceeds the token budget" uses a mock `Date.now()` with a specific sequence of timestamps. Adding the gate's `Date.now()` call consumed one timestamp, shifting all subsequent calls. The fix added one extra timestamp value (duplicated the first value) so the test's timing expectations remain accurate.

## No Unreachable Code

The implementation follows the brief's instruction: **"Do not implement anything here for the other branches; they are unreachable from this call site."**

- No handling for `lease_expired` branch
- No handling for `held_by_self` branch
- No handling for `no_lease` branch

The gate runs, observes "no_record" on every fresh start, and passes control to the next step. Only `resumeLoop` exercises other branches.

## Files Changed

1. `src/controller/runLoop.ts` — Added import and gate call
2. `tests/controller/runLoop.integration.test.ts` — Added tests, helper, and timing fix

## Self-Review Findings

✓ **Completeness**: The gate is wired at the correct position with the correct parameters and behavior.

✓ **Quality**: The implementation is minimal and follows the existing code style (two-space indent, double quotes, `.js` extensions).

✓ **Testing**: 
- Pre-change baseline established
- Two new tests verify behavior is preserved
- All existing tests updated for timing compatibility
- Full suite passes

✓ **Documentation**: Comments explain the ordering rationale and why other branches are unreachable.

✓ **Discipline (YAGNI)**: No speculative error handling, no special cases for unreachable branches.

✓ **Pristine Output**: All tests pass, typecheck clean, build clean. No warnings or concerns.

## Concerns

None. The implementation is straightforward, well-tested, and maintains backward compatibility with existing tests.

## Commit

**SHA:** `05b9cbc`  
**Message:** `feat: run the lease gate on a fresh start, between initializeRunFiles and writeOwnerRecord`
