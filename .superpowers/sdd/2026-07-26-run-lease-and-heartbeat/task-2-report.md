# Task 2 Report: The Pure Lease Module

## Summary

Task 2 has been completed successfully. Implemented the pure lease module with all required constants, error classes, and validation functions following exact specifications from the brief.

## Implementation Details

### Files Created
- `src/ownership/lease.ts` — 95 lines of pure module with constants, error classes, and functions

### Files Modified
- `tests/ownership/lease.test.ts` — Appended 99 lines of new tests (keeping Task 1's existing tests intact)

### Exports Added to `src/ownership/lease.ts`

**Constants (exact values from brief):**
- `LEASE_HEARTBEAT_INTERVAL_MS = 30_000`
- `LEASE_TTL_MS = 90_000`
- `LEASE_AFFIRM_THROTTLE_MS = 10_000`
- `LEASE_VERIFY_READ_ATTEMPTS = 3`
- `LEASE_VERIFY_RETRY_DELAY_MS = 50`

**Error Classes:**
- `RunLeaseHeldError(holderProcessInstanceId, remainingTtlMs)` — names holder and TTL in message
- `RunLeaseLostError(message)` — with `stopReason = "lease_lost"`
- `RunLeaseUnverifiableError(message)` — with `stopReason = "lease_unverifiable"`

**Functions:**
- `isLeaseFresh(record, nowMs, ttlMs): boolean` — Total function on validated records; defensive default for malformed inputs
- `parseOwnerRecordForLease(raw): OwnerRecord` — Validates record structure and **returns input unchanged** (critical for CAS comparison)

## TDD Process

### Step 1: Write Failing Tests ✓
Appended 15 new test cases to `tests/ownership/lease.test.ts`:
- 5 tests in `isLeaseFresh` describe block
- 2 tests in `parseOwnerRecordForLease` describe block  
- 1 test in `RunLeaseHeldError` describe block

### Step 2: Verify Failure ✓
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/ownership/lease.test.ts
```
**Result:** FAIL as expected
```
Error: Failed to load url ../../src/ownership/lease.js (resolved id: ../../src/ownership/lease.js)
Does the file exist?
```

### Step 3: Write Module ✓
Created `src/ownership/lease.ts` with exact code from brief.

### Step 4: Verify Success ✓
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/ownership/lease.test.ts
```
**Result:** PASS
```
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 Test Files  1 passed (1)
      Tests  16 passed (16)
```
(16 = 1 test from Task 1 + 15 new tests)

## Verification

### Full Test Suite ✓
```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
```
**Result:** 290 tests passed (18 files, +15 tests from Task 2)

### Typecheck ✓
```
npm run typecheck
```
**Result:** PASS

### Build ✓
```
npm run build
```
**Result:** PASS

## Commit

```
commit 41d5fe3
Author: biran <biran@anthropic.com>
Date:   2026-07-26

    feat: add the pure lease predicate, record validator and lease error classes
    
    Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

**Files committed:**
- `src/ownership/lease.ts` (created)
- `tests/ownership/lease.test.ts` (modified, tests appended)

## Key Design Decisions

1. **`parseOwnerRecordForLease` Returns Input Unchanged:** Follows brief's critical requirement — does NOT add `leaseAffirmedAt: null` to legacy records lacking the field. This preserves key order for JSON.stringify-based CAS comparison.

2. **`isLeaseFresh` Belt-and-Braces Defense:** Reports `false` for unparseable timestamps as a defensive default, but parsing/validation is the governing rule (per §5). Never the deciding factor for malformed records.

3. **Boundary Condition:** `isLeaseFresh` uses strict `<` for TTL check (not `<=`), so at exactly TTL boundary the lease is expired (per test and comment).

4. **Future Timestamps:** Deliberately allows timestamps from the future to report as "fresh" — refusing is the safe direction per §10.

5. **Null vs. Absent Field:** Both `leaseAffirmedAt: null` and absent field report "not fresh" in `isLeaseFresh`, but distinction is drawn at the gate level.

## Self-Review

✓ **Completeness:** All required constants, classes, and functions implemented per brief  
✓ **Code Quality:** Clear comments, matches codebase style (2-space indent, double quotes, `.js` extensions)  
✓ **Testing:** TDD followed exactly (tests first, verification of failure, implementation, verification of pass)  
✓ **Discipline:** No speculative code; exactly what was asked, nothing more  
✓ **Constraints Met:**  
  - No new authority introduced (purely functional)  
  - Constants at module level (not configurable in L1)  
  - All tests green  
  - Typecheck and build clean  
  - Commit created with proper message  
  - Not pushed (as required)

## No Concerns

All requirements met. Module is pure (no I/O, no clock), all error classes properly named and documented, test coverage complete (16 tests for lease-related functionality).
