# Run Lease and Heartbeat (L1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make owner freshness mechanically measurable — a running process refreshes a lease on its own owner record, a live lease refuses a second executor, and a process that can no longer affirm its lease stops — without granting any new authority.

**Architecture:** One new pure module (`src/ownership/lease.ts`) holds the constants, the freshness predicate, the record validator and the error classes. Three new `fileStore` functions give the gate a recovery-free raw read and give the heartbeat a compare-and-swap affirm and release. One new controller module (`src/controller/leaseHeartbeat.ts`) owns the wall-clock timer, the throttled `affirmNow`, the un-throttled fail-closed `assertHeld`, and a `stop()` that releases the lease. A small gate module (`src/controller/leaseGate.ts`) is called from both `runLoop` and `resumeLoop` before either claims anything. Freshness enters `evaluateOwnership` as a required input that, in L1, every production caller sets to `"unknown"`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥ 20 built-ins only, Vitest, `ScriptedAdapter` for every loop-level test.

**Source of truth:** `docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`. Section references (§) below point into it. The spec is frozen; if this plan and the spec disagree, the spec wins — stop and report the disagreement rather than picking one.

## Global Constants

Copied verbatim from spec §5. Module-level constants in `src/ownership/lease.ts`, **not** contract fields — no configurability in L1.

- `LEASE_HEARTBEAT_INTERVAL_MS = 30_000`
- `LEASE_TTL_MS = 90_000`
- `LEASE_AFFIRM_THROTTLE_MS = 10_000`
- `LEASE_VERIFY_READ_ATTEMPTS = 3` — bounded retry for `assertHeld` (§8.1 "after a bounded retry")
- `LEASE_VERIFY_RETRY_DELAY_MS = 50`

## Global Constraints

Every task's requirements implicitly include this section.

1. **Test command:** `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`. Single file: append the path. Single test: append `-t "<name>"`.
2. **Baseline:** 17 files / 274 tests green, `npm run typecheck` and `npm run build` clean. Any task that leaves the suite red is not done.
3. **No paid Claude calls.** Every loop-level test uses `ScriptedAdapter`. If a task seems to need a real Claude call, stop and report — it does not.
4. **L1 introduces no new authority** (§2, §4.1). A live lease may only *refuse*. An expired lease neither permits nor refuses. If you find yourself writing a code path where lease state makes something succeed that would otherwise fail, you have misread the spec — stop.
5. **Refusals write no new state** beyond appended events (§7.1). No owner-record write, no run-state write, no worktree change on any refusal path.
6. **The heartbeat is the only writer of a non-null `leaseAffirmedAt`** (§5.0, §6). Every other writer of the owner record writes `null`.
7. **Do not change the owner-transfer *lock* record format.** `acquireOwnerTransferLock` writes `holderProcessInstanceId: "pid:<pid>"` (`src/persistence/fileStore.ts:474`) and `parsePid` (`:408`) parses exactly `/^pid:(\d+)$/` to decide whether a lock holder is still alive. Task 3 changes the **owner record's** `currentProcessInstanceId` format only. If the lock record's format changes, `parsePid` returns `null`, `tryRecoverStaleOwnerTransferLock` falls through to `safeUnlink(lockPath)` and starts stealing *live* locks. These two identity strings are deliberately different things.
8. **Commit after every task**, with the task's tests green. Do not push (the human pushes).
9. Match existing style: two-space indent, double quotes, `.js` extensions on relative imports, `export async function`, no default exports.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/ownership/lease.ts` | Pure: constants, `isLeaseFresh`, `parseOwnerRecordForLease`, lease error classes. No I/O, no clock. |
| `src/runtime/processIdentity.ts` | `buildProcessInstanceId()` — the non-reusable identity of §5.1. Separate from `lease.ts` so `lease.ts` stays pure. |
| `src/controller/leaseGate.ts` | The acquisition gate of §7, shared by both call sites. Raw read, validate, branch, append `lease_expired_observed`. |
| `src/controller/leaseHeartbeat.ts` | `startLeaseHeartbeat` — timer, `affirmNow`, `assertHeld`, `stop`. |
| `tests/ownership/lease.test.ts` | Pure predicate + validator. |
| `tests/controller/leaseGate.test.ts` | Gate branches, corrupt-record refusal, recycled PID. |
| `tests/controller/leaseHeartbeat.test.ts` | Fake-timer heartbeat, record rotation, release, `assertHeld` throttling. |
| `tests/controller/leaseLifecycle.integration.test.ts` | Loop-level: release on exit, lease loss, blocked side effects. |

**Modified:**

| File | Change |
|---|---|
| `src/runtime/types.ts:82-90` | `OwnerRecord` gains `leaseAffirmedAt: string \| null`. |
| `src/state/types.ts:57-65` | `OwnershipEvaluationInput` gains required `leaseFresh: boolean \| "unknown"`. |
| `src/ownership/ownerController.ts` | Transfer writes `leaseAffirmedAt: null`; `evaluateOwnership` applies the live-lease counter-claim. |
| `src/persistence/fileStore.ts` | Three new exports: `readOwnerRecordWithoutRecovery`, `affirmOwnerLease`, `releaseOwnerLease`. |
| `src/controller/runLoop.ts` | Initial record writes `null`; gate; heartbeat lifecycle; lease-lost stop; `assertHeld` before side effects. |
| `src/controller/resumeLoop.ts` | Gate before every read; claim writes `null`; heartbeat lifecycle. |
| `tests/ownership/ownerController.test.ts` | `leaseFresh: "unknown"` in the fixture + new live-lease cases. |
| `tests/controller/resumeLoop.integration.test.ts:97` | Identity assertion updated for the new format. |

---

## Task 1: The `leaseAffirmedAt` field, written `null` by everyone

**Files:**
- Modify: `src/runtime/types.ts:82-90`
- Modify: `src/controller/runLoop.ts:569-579` (`buildInitialOwnerRecord`)
- Modify: `src/controller/resumeLoop.ts:109-113` (the claim record)
- Modify: `src/ownership/ownerController.ts:146-153` (`applyOwnerEpochTransfer`)
- Test: `tests/ownership/lease.test.ts` (new file, first block)
- Test: `tests/controller/resumeLoop.integration.test.ts` (add one assertion)

**Interfaces:**
- Consumes: nothing.
- Produces: `OwnerRecord.leaseAffirmedAt: string | null` — every later task reads or writes it.

**Why:** §5.0. `lastAffirmedAt` is written by three non-heartbeat writers, so it cannot answer "is a process running". A second field, written non-null *only* by the heartbeat, can. Records written before this change have no field at all; absent reads as `null` (no lease) and needs no migration.

- [ ] **Step 1: Write the failing test**

Create `tests/ownership/lease.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyOwnerEpochTransfer } from "../../src/ownership/ownerController.js";
import type { OwnerRecord } from "../../src/runtime/types.js";

function ownerRecord(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1:t0",
    currentOwnerEpoch: 1,
    currentProcessInstanceId: "pid:100:1000",
    lastAffirmedAt: "2026-07-26T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
    ...overrides,
  };
}

describe("leaseAffirmedAt is written only by the heartbeat", () => {
  // §5.0: an owner transfer hands the run to a new owner who is NOT yet running it.
  // If the transfer carried the prior lease forward, the new owner's own resume would
  // meet a fresh lease naming someone else and be refused for a full TTL.
  it("an owner transfer clears the lease rather than carrying it forward", () => {
    const prior = ownerRecord({ leaseAffirmedAt: "2026-07-26T10:00:00.000Z" });

    const { nextOwnerRecord } = applyOwnerEpochTransfer(
      prior,
      "pid:200:2000",
      "2026-07-26T10:00:05.000Z",
      "owner lost after reconciliation",
    );

    expect(nextOwnerRecord.leaseAffirmedAt).toBeNull();
    expect(nextOwnerRecord.currentProcessInstanceId).toBe("pid:200:2000");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/ownership/lease.test.ts`
Expected: FAIL — `leaseAffirmedAt` does not exist on type `OwnerRecord` (and the assertion receives `undefined`).

- [ ] **Step 3: Add the field to the type**

In `src/runtime/types.ts`, inside `OwnerRecord`, after `supersededByEpoch`:

```ts
export type OwnerRecord = {
  runId: string;
  logicalSessionId: string;
  currentOwnerEpoch: number;
  currentProcessInstanceId: string;
  lastAffirmedAt: string;
  ownerStatus: OwnerStatus;
  supersededByEpoch: number | null;
  // §5.0: written non-null ONLY by the lease heartbeat. `null` means "owned, but no
  // process is running it". Records written before this design omit the field; readers
  // treat absent as null.
  leaseAffirmedAt: string | null;
};
```

- [ ] **Step 4: Make all three non-heartbeat writers write `null`**

`src/ownership/ownerController.ts`, inside `applyOwnerEpochTransfer`'s `nextOwnerRecord`, after `supersededByEpoch: null,`:

```ts
      supersededByEpoch: null,
      leaseAffirmedAt: null,
```

`src/controller/runLoop.ts`, inside `buildInitialOwnerRecord`, after `supersededByEpoch: null,`:

```ts
    supersededByEpoch: null,
    leaseAffirmedAt: null,
```

`src/controller/resumeLoop.ts`, the claim record:

```ts
  const nextOwnerRecord = {
    ...ownerRecord,
    currentProcessInstanceId: `pid:${process.pid}`,
    lastAffirmedAt: new Date().toISOString(),
    leaseAffirmedAt: null,
  };
```

- [ ] **Step 5: Run the new test and the full suite**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`
Expected: PASS, 275 tests. Then `npm run typecheck` — any construction site of `OwnerRecord` that does not set the field is a compile error; fix each by adding `leaseAffirmedAt: null`. Test fixtures that write owner records as raw JSON (e.g. `seedEligibleRun` in `tests/controller/resumeLoop.integration.test.ts`) are **not** compile errors and must be left alone — they are the legacy-record case and Task 6 depends on them staying field-less.

- [ ] **Step 6: Pin the claim path too**

In `tests/controller/resumeLoop.integration.test.ts`, in the first test ("resumes an eligible run…"), after the existing owner assertions:

```ts
    // §5.0/§16: a resume CLAIM is not a heartbeat. It says "I own this", not "I am running
    // it right now" — only the heartbeat may write a non-null lease.
    expect(owner.leaseAffirmedAt).toBeNull();
```

Note this assertion is temporarily *stricter* than the end state: once Task 11 starts a heartbeat inside `resumeLoop`, the run will have affirmed and released by the time the loop returns, so the field is `null` again for a different reason. Both readings are correct and the assertion stands.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/types.ts src/ownership/ownerController.ts src/controller/runLoop.ts src/controller/resumeLoop.ts tests/ownership/lease.test.ts tests/controller/resumeLoop.integration.test.ts
git commit -m "feat: add leaseAffirmedAt to the owner record, written null by every non-heartbeat writer"
```

---

## Task 2: The pure lease module

**Files:**
- Create: `src/ownership/lease.ts`
- Test: `tests/ownership/lease.test.ts` (extend)

**Interfaces:**
- Consumes: `OwnerRecord` from Task 1.
- Produces:
  - `LEASE_HEARTBEAT_INTERVAL_MS`, `LEASE_TTL_MS`, `LEASE_AFFIRM_THROTTLE_MS`, `LEASE_VERIFY_READ_ATTEMPTS`, `LEASE_VERIFY_RETRY_DELAY_MS: number`
  - `isLeaseFresh(record: OwnerRecord, nowMs: number, ttlMs: number): boolean`
  - `parseOwnerRecordForLease(raw: unknown): OwnerRecord` — throws `Error` on a structurally invalid record
  - `class RunLeaseHeldError extends Error` with `holderProcessInstanceId: string`, `remainingTtlMs: number`
  - `class RunLeaseLostError extends Error` with `stopReason = "lease_lost"`
  - `class RunLeaseUnverifiableError extends Error` with `stopReason = "lease_unverifiable"`

**Note on §11:** the spec lists `RunLeaseHeldError` and `RunLeaseUnverifiableError`. `RunLeaseLostError` is a deliberate small addition: §8 needs `lease_lost` to be distinguishable from `lease_unverifiable` at the catch site, and §8.1's table gives them different stop reasons. Adding it changes no behavior the spec describes.

**Why the validator lives here:** §7 requires the gate to validate the fields it depends on, because `readOwnerRecordRaw` is a bare `JSON.parse` plus a cast (`src/persistence/fileStore.ts:371-373`) and accepts a structurally invalid record silently. §5 keeps the two rules apart: malformed ⇒ **refused**; `isLeaseFresh`'s `false` for garbage input is only a defensive default, never the governing rule.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ownership/lease.test.ts` (the `ownerRecord` helper from Task 1 is reused):

```ts
import {
  isLeaseFresh,
  LEASE_TTL_MS,
  parseOwnerRecordForLease,
  RunLeaseHeldError,
} from "../../src/ownership/lease.js";

describe("isLeaseFresh", () => {
  const affirmedAt = "2026-07-26T10:00:00.000Z";
  const affirmedAtMs = Date.parse(affirmedAt);

  it("is fresh strictly inside the TTL and not fresh at exactly the TTL", () => {
    const record = ownerRecord({ leaseAffirmedAt: affirmedAt });

    expect(isLeaseFresh(record, affirmedAtMs + LEASE_TTL_MS - 1, LEASE_TTL_MS)).toBe(true);
    // The boundary is `<`, not `<=`: at exactly the TTL the lease has expired. Pinned
    // because an off-by-one here is the difference between refusing and not refusing.
    expect(isLeaseFresh(record, affirmedAtMs + LEASE_TTL_MS, LEASE_TTL_MS)).toBe(false);
  });

  // §10: a lease that reads fresh for too long only adds refusals, which is the safe
  // direction. So a timestamp from the future is fresh, deliberately, and not an error.
  it("treats a lease affirmed in the future as fresh (refusing is the safe direction)", () => {
    const record = ownerRecord({ leaseAffirmedAt: affirmedAt });
    expect(isLeaseFresh(record, affirmedAtMs - 60_000, LEASE_TTL_MS)).toBe(true);
  });

  // §5: null is NOT an expired lease — it is no lease at all. Both answer "not fresh"
  // here, but the gate branches on them differently, so the distinction is drawn there.
  it("reports not-fresh for a null lease and for an absent field", () => {
    expect(isLeaseFresh(ownerRecord({ leaseAffirmedAt: null }), affirmedAtMs, LEASE_TTL_MS)).toBe(false);

    const legacy = ownerRecord();
    delete (legacy as { leaseAffirmedAt?: unknown }).leaseAffirmedAt;
    expect(isLeaseFresh(legacy, affirmedAtMs, LEASE_TTL_MS)).toBe(false);
  });

  // §5: belt-and-braces only. The governing rule for a malformed record is refusal, and
  // that is parseOwnerRecordForLease's job — this predicate must never be the thing that
  // decides a corrupt record is safe.
  it("defensively reports not-fresh for an unparseable timestamp", () => {
    const record = ownerRecord({ leaseAffirmedAt: "not-a-timestamp" });
    expect(isLeaseFresh(record, affirmedAtMs, LEASE_TTL_MS)).toBe(false);
  });
});

describe("parseOwnerRecordForLease", () => {
  it("accepts a well-formed record unchanged, preserving key order for CAS comparison", () => {
    const record = ownerRecord({ leaseAffirmedAt: "2026-07-26T10:00:00.000Z" });
    const parsed = parseOwnerRecordForLease(JSON.parse(JSON.stringify(record)));

    expect(JSON.stringify(parsed)).toBe(JSON.stringify(record));
  });

  it("accepts a legacy record with no leaseAffirmedAt field and does not add one", () => {
    const legacy = ownerRecord();
    delete (legacy as { leaseAffirmedAt?: unknown }).leaseAffirmedAt;

    const parsed = parseOwnerRecordForLease(JSON.parse(JSON.stringify(legacy)));

    // Adding the key would change the JSON and break every later CAS against this record.
    expect("leaseAffirmedAt" in parsed).toBe(false);
  });

  // §7: these are exactly the shapes readOwnerRecordRaw accepts silently. Each must be a
  // refusal, never "no lease here".
  it.each([
    ["not an object", 42],
    ["null", null],
    ["an array", []],
    ["a missing currentProcessInstanceId", { currentOwnerEpoch: 1 }],
    ["an empty currentProcessInstanceId", { currentProcessInstanceId: "", currentOwnerEpoch: 1 }],
    ["a missing currentOwnerEpoch", { currentProcessInstanceId: "pid:1:1" }],
    ["a non-integer currentOwnerEpoch", { currentProcessInstanceId: "pid:1:1", currentOwnerEpoch: 1.5 }],
    ["a non-string, non-null leaseAffirmedAt", { currentProcessInstanceId: "pid:1:1", currentOwnerEpoch: 1, leaseAffirmedAt: 12345 }],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseOwnerRecordForLease(raw)).toThrow(/owner record is structurally invalid/);
  });
});

describe("RunLeaseHeldError", () => {
  // The CLI prints error.message for `instanceof Error` (src/cli.ts), so an operator's
  // only view of WHY a resume was refused is this string.
  it("names the holder and the remaining TTL in its message", () => {
    const error = new RunLeaseHeldError("pid:4242:1700000000000", 45_000);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RunLeaseHeldError");
    expect(error.message).toContain("pid:4242:1700000000000");
    expect(error.message).toContain("45000");
    expect(error.holderProcessInstanceId).toBe("pid:4242:1700000000000");
    expect(error.remainingTtlMs).toBe(45_000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/ownership/lease.test.ts`
Expected: FAIL — cannot resolve `../../src/ownership/lease.js`.

- [ ] **Step 3: Write the module**

Create `src/ownership/lease.ts`:

```ts
import type { OwnerRecord } from "../runtime/types.js";

export const LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
// >= 3x the interval, so two consecutive missed refreshes do not expire a healthy run.
export const LEASE_TTL_MS = 90_000;
export const LEASE_AFFIRM_THROTTLE_MS = 10_000;
export const LEASE_VERIFY_READ_ATTEMPTS = 3;
export const LEASE_VERIFY_RETRY_DELAY_MS = 50;

export class RunLeaseHeldError extends Error {
  constructor(
    readonly holderProcessInstanceId: string,
    readonly remainingTtlMs: number,
  ) {
    super(`run lease is held by ${holderProcessInstanceId} for another ${remainingTtlMs}ms`);
    this.name = "RunLeaseHeldError";
  }
}

export class RunLeaseLostError extends Error {
  readonly stopReason = "lease_lost";

  constructor(message: string) {
    super(message);
    this.name = "RunLeaseLostError";
  }
}

export class RunLeaseUnverifiableError extends Error {
  readonly stopReason = "lease_unverifiable";

  constructor(message: string) {
    super(message);
    this.name = "RunLeaseUnverifiableError";
  }
}

// §5: a total function on a validated record. `null`, an absent field and an unparseable
// timestamp all answer "not fresh" — but only as a defensive default. The rule that
// governs a malformed record is parseOwnerRecordForLease's refusal, not this `false`.
export function isLeaseFresh(record: OwnerRecord, nowMs: number, ttlMs: number): boolean {
  const affirmedAt = record.leaseAffirmedAt;

  if (typeof affirmedAt !== "string") {
    return false;
  }

  const affirmedAtMs = Date.parse(affirmedAt);

  if (Number.isNaN(affirmedAtMs)) {
    return false;
  }

  return nowMs - affirmedAtMs < ttlMs;
}

// §7: readOwnerRecordRaw is a bare JSON.parse plus a cast, so it accepts a structurally
// invalid record silently. The gate validates the fields it depends on itself, and a
// failure here is a REFUSAL, never "no lease here".
//
// Returns the input object unchanged. It must not normalize an absent leaseAffirmedAt
// into an explicit null: the returned record is used as the `expected` side of a CAS that
// compares JSON.stringify output, and adding a key would make every such CAS fail.
export function parseOwnerRecordForLease(raw: unknown): OwnerRecord {
  const invalid = (detail: string): never => {
    throw new Error(`owner record is structurally invalid: ${detail}`);
  };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalid("not a JSON object");
  }

  const record = raw as Partial<OwnerRecord>;

  if (typeof record.currentProcessInstanceId !== "string" || record.currentProcessInstanceId === "") {
    return invalid("currentProcessInstanceId is missing or not a non-empty string");
  }

  if (typeof record.currentOwnerEpoch !== "number" || !Number.isInteger(record.currentOwnerEpoch)) {
    return invalid("currentOwnerEpoch is missing or not an integer");
  }

  // §7: absent means null — a record predating this design, carrying no lease. Present
  // but neither a string nor null is malformed.
  if (
    "leaseAffirmedAt" in record
    && record.leaseAffirmedAt !== null
    && typeof record.leaseAffirmedAt !== "string"
  ) {
    return invalid("leaseAffirmedAt is neither a string nor null");
  }

  return raw as OwnerRecord;
}
```

- [ ] **Step 4: Run the tests**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/ownership/lease.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ownership/lease.ts tests/ownership/lease.test.ts
git commit -m "feat: add the pure lease predicate, record validator and lease error classes"
```

---

## Task 3: A process identity that cannot be recycled

**Files:**
- Create: `src/runtime/processIdentity.ts`
- Modify: `src/controller/runLoop.ts:574`, `:675` and `src/controller/resumeLoop.ts:111`, `:124`
- Test: `tests/runtime/processIdentity.test.ts` (new)
- Test: `tests/controller/resumeLoop.integration.test.ts:97` (update)

**Interfaces:**
- Produces: `buildProcessInstanceId(): string` returning `pid:<pid>:<processStartMs>`.

**Why:** §5.1. Operating systems recycle PIDs. A later, unrelated process handed PID 4242 would meet a still-fresh lease reading `pid:4242`, match it as "held by me", and proceed — defeating the one guarantee L1 offers.

**Do not touch** the owner-transfer lock record (Global Constraint 7).

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/processIdentity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildProcessInstanceId } from "../../src/runtime/processIdentity.js";

describe("buildProcessInstanceId", () => {
  it("is pid:<pid>:<processStartMs> and is stable within a process", () => {
    const id = buildProcessInstanceId();

    expect(id).toMatch(/^pid:\d+:\d+$/);
    expect(id.startsWith(`pid:${process.pid}:`)).toBe(true);
    expect(buildProcessInstanceId()).toBe(id);
  });

  // §5.1: the whole point of the third component. A recycled PID produces a DIFFERENT
  // identity, so a stale record can never be mistaken for "held by me". Compared only for
  // string equality, so the legacy `pid:<pid>` format also never matches.
  it("never equals the same pid with a different start time, nor the legacy format", () => {
    const id = buildProcessInstanceId();

    expect(id).not.toBe(`pid:${process.pid}`);
    expect(id).not.toBe(`pid:${process.pid}:0`);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/runtime/processIdentity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `src/runtime/processIdentity.ts`:

```ts
import { performance } from "node:perf_hooks";

// §5.1: PIDs are recycled, so `pid:<pid>` alone can be handed to an unrelated later
// process which would then match a stale lease as "held by me". performance.timeOrigin is
// this process's start time in epoch milliseconds, which no concurrent process with the
// same PID can share. The value is opaque and only ever compared for string equality.
const PROCESS_INSTANCE_ID = `pid:${process.pid}:${Math.trunc(performance.timeOrigin)}`;

export function buildProcessInstanceId(): string {
  return PROCESS_INSTANCE_ID;
}
```

- [ ] **Step 4: Use it at all four owner-identity sites**

`src/controller/runLoop.ts` — add the import alongside the existing runtime imports, then:

```ts
    currentProcessInstanceId: buildProcessInstanceId(),
```

in `buildInitialOwnerRecord`, and in `persistBoundaryAnalysis`'s transfer call replace the `` `pid:${process.pid}` `` argument:

```ts
      const transfer = await persistOwnerTransfer(
        runDir,
        ownerRecord,
        buildProcessInstanceId(),
        new Date().toISOString(),
        "owner lost after reconciliation",
      );
```

`src/controller/resumeLoop.ts` — the claim record and the `resume_adopted` detail:

```ts
  const nextOwnerRecord = {
    ...ownerRecord,
    currentProcessInstanceId: buildProcessInstanceId(),
    lastAffirmedAt: new Date().toISOString(),
    leaseAffirmedAt: null,
  };
```

```ts
    detail: `epoch ${ownerRecord.currentOwnerEpoch}: ${ownerTransfer.priorProcessInstanceId} -> ${buildProcessInstanceId()}`,
```

- [ ] **Step 5: Update the one assertion that pins the old format**

`tests/controller/resumeLoop.integration.test.ts`, in the first test:

```ts
    expect(owner.currentProcessInstanceId).toBe(buildProcessInstanceId()); // claimed
```

with `import { buildProcessInstanceId } from "../../src/runtime/processIdentity.js";` at the top.

- [ ] **Step 6: Run the full suite**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`
Expected: PASS. If any other test asserts `` `pid:${process.pid}` `` against an **owner record**, update it the same way. If a test asserts it against the **owner-transfer lock file**, that is the format that must NOT change — leave it.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/processIdentity.ts src/controller/runLoop.ts src/controller/resumeLoop.ts tests/runtime/processIdentity.test.ts tests/controller/resumeLoop.integration.test.ts
git commit -m "feat: make the owner-record process identity non-reusable within a TTL"
```

---

## Task 4: `fileStore` — raw read, CAS affirm, CAS release

**Files:**
- Modify: `src/persistence/fileStore.ts` (add three exports near `claimOwnerRecordWithPrecondition`)
- Test: `tests/persistence/leaseStore.test.ts` (new)

**Interfaces:**
- Consumes: `OwnerRecord` (Task 1).
- Produces:
  - `readOwnerRecordWithoutRecovery(runDir: string): Promise<OwnerRecord>`
  - `affirmOwnerLease(runDir: string, expected: OwnerRecord, nowIso: string): Promise<OwnerRecord>` — returns the record it wrote; throws `OwnerTransferPreconditionError` on CAS mismatch
  - `releaseOwnerLease(runDir: string, expected: OwnerRecord): Promise<void>` — throws on CAS mismatch; the caller swallows

**Why:** §6 (affirm under the existing transfer lock, reusing the interrupted-transfer recovery path), §6.0 (release writes `null`, best-effort by contract), §7.1 (the gate's read must not trigger crash recovery as a side effect — `readOwnerRecord` calls `recoverInterruptedOwnerTransfer` first, which writes).

- [ ] **Step 1: Write the failing tests**

Create `tests/persistence/leaseStore.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  affirmOwnerLease,
  OwnerTransferPreconditionError,
  readOwnerRecordWithoutRecovery,
  releaseOwnerLease,
} from "../../src/persistence/fileStore.js";
import type { OwnerRecord } from "../../src/runtime/types.js";

function record(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1:t0",
    currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:100:1000",
    lastAffirmedAt: "2026-07-26T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
    ...overrides,
  };
}

async function seed(owner: OwnerRecord): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-lease-"));
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify(owner, null, 2));
  return runDir;
}

async function readOwner(runDir: string): Promise<OwnerRecord> {
  return JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as OwnerRecord;
}

describe("affirmOwnerLease", () => {
  it("advances both timestamps and returns exactly the record it persisted", async () => {
    const runDir = await seed(record());

    const written = await affirmOwnerLease(runDir, record(), "2026-07-26T10:00:30.000Z");

    expect(written.leaseAffirmedAt).toBe("2026-07-26T10:00:30.000Z");
    // §6: the ownership design's named freshness anchor stops being dead.
    expect(written.lastAffirmedAt).toBe("2026-07-26T10:00:30.000Z");
    expect(await readOwner(runDir)).toEqual(written);
  });

  it("leaves epoch, status and supersession untouched", async () => {
    const runDir = await seed(record());

    const written = await affirmOwnerLease(runDir, record(), "2026-07-26T10:00:30.000Z");

    expect(written.currentOwnerEpoch).toBe(2);
    expect(written.ownerStatus).toBe("current");
    expect(written.supersededByEpoch).toBeNull();
    expect(written.currentProcessInstanceId).toBe("pid:100:1000");
  });

  // §6.1: the returned record is the caller's next `expected`. If the returned record did
  // not compare equal to what is on disk, the very next affirm would fail its own CAS.
  it("supports three consecutive affirms when each adopts the returned record", async () => {
    const runDir = await seed(record());

    let expected = record();
    for (const at of ["10:00:30", "10:01:00", "10:01:30"]) {
      expected = await affirmOwnerLease(runDir, expected, `2026-07-26T${at}.000Z`);
    }

    expect(expected.leaseAffirmedAt).toBe("2026-07-26T10:01:30.000Z");
  });

  it("throws OwnerTransferPreconditionError when the persisted record has moved on", async () => {
    const runDir = await seed(record({ currentOwnerEpoch: 3 }));

    await expect(affirmOwnerLease(runDir, record(), "2026-07-26T10:00:30.000Z")).rejects.toBeInstanceOf(
      OwnerTransferPreconditionError,
    );
  });

  it("affirms a legacy record that has no leaseAffirmedAt field", async () => {
    const legacy = record();
    delete (legacy as { leaseAffirmedAt?: unknown }).leaseAffirmedAt;
    const runDir = await seed(legacy as OwnerRecord);

    const written = await affirmOwnerLease(runDir, legacy as OwnerRecord, "2026-07-26T10:00:30.000Z");

    expect(written.leaseAffirmedAt).toBe("2026-07-26T10:00:30.000Z");
  });
});

describe("releaseOwnerLease", () => {
  it("clears only leaseAffirmedAt", async () => {
    const runDir = await seed(record({ leaseAffirmedAt: "2026-07-26T10:00:30.000Z" }));

    await releaseOwnerLease(runDir, record({ leaseAffirmedAt: "2026-07-26T10:00:30.000Z" }));

    const persisted = await readOwner(runDir);
    expect(persisted.leaseAffirmedAt).toBeNull();
    expect(persisted.lastAffirmedAt).toBe("2026-07-26T10:00:00.000Z");
    expect(persisted.currentOwnerEpoch).toBe(2);
  });

  // §6.0: on the lease_lost path the record already belongs to the new owner. The release
  // must fail its CAS rather than unconditionally clearing a lease the new owner has
  // already begun affirming.
  it("refuses to clear a lease on a record this process no longer owns", async () => {
    const newOwner = record({
      currentOwnerEpoch: 3,
      currentProcessInstanceId: "pid:999:9000",
      leaseAffirmedAt: "2026-07-26T10:05:00.000Z",
    });
    const runDir = await seed(newOwner);

    await expect(
      releaseOwnerLease(runDir, record({ leaseAffirmedAt: "2026-07-26T10:00:30.000Z" })),
    ).rejects.toBeInstanceOf(OwnerTransferPreconditionError);

    expect((await readOwner(runDir)).leaseAffirmedAt).toBe("2026-07-26T10:05:00.000Z");
  });
});

describe("readOwnerRecordWithoutRecovery", () => {
  // §7.1: readOwnerRecord runs recoverInterruptedOwnerTransfer first, which finalizes
  // pending transfers and deletes staging files — both writes. A refusal must never
  // trigger crash recovery as a side effect, so the gate uses this read instead.
  it("does not finalize a staged transfer the way readOwnerRecord would", async () => {
    const runDir = await seed(record());
    const staged = record({ currentOwnerEpoch: 3, currentProcessInstanceId: "pid:999:9000" });
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(staged, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.pending.json"),
      JSON.stringify({ priorOwnerEpoch: 2, newOwnerEpoch: 3, priorProcessInstanceId: "pid:100:1000", newProcessInstanceId: "pid:999:9000", transferredAt: "2026-07-26T10:00:10.000Z", reason: "t", eligibleForContinuation: true }, null, 2),
    );
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: "2026-07-26T10:00:10.000Z", finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );

    const read = await readOwnerRecordWithoutRecovery(runDir);

    expect(read.currentOwnerEpoch).toBe(2);
    expect((await readOwner(runDir)).currentOwnerEpoch).toBe(2);
  });

  it("propagates ENOENT when there is no owner record", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-lease-"));

    await expect(readOwnerRecordWithoutRecovery(runDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/persistence/leaseStore.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement, directly after `claimOwnerRecordWithPrecondition`**

```ts
// §7.1: the gate's read. readOwnerRecord runs recoverInterruptedOwnerTransfer first, which
// may finalize a pending transfer or delete staging files — both writes. A refusal must
// not trigger crash recovery as a side effect, so the gate reads raw. Recovery stays where
// it already is: on the paths that go on to claim or transfer.
export async function readOwnerRecordWithoutRecovery(runDir: string): Promise<OwnerRecord> {
  return readOwnerRecordRaw(runDir);
}

async function writeOwnerRecordAtomically(runDir: string, ownerRecord: OwnerRecord): Promise<void> {
  const { ownerPath, ownerTempPath } = getOwnerTransferPaths(runDir);
  await safeUnlink(ownerTempPath);
  await writeJsonFile(ownerTempPath, ownerRecord);
  await rename(ownerTempPath, ownerPath);
}

async function updateOwnerRecordWithPrecondition(
  runDir: string,
  expectedOwnerRecord: OwnerRecord,
  buildNext: (persisted: OwnerRecord) => OwnerRecord,
  mismatchMessage: string,
): Promise<OwnerRecord> {
  const lock = await acquireOwnerTransferLock(runDir);

  try {
    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
    const persistedOwnerRecord = await readOwnerRecordRaw(runDir);

    if (!sameOwnerRecord(persistedOwnerRecord, expectedOwnerRecord)) {
      throw new OwnerTransferPreconditionError(mismatchMessage);
    }

    const nextOwnerRecord = buildNext(persistedOwnerRecord);
    await writeOwnerRecordAtomically(runDir, nextOwnerRecord);
    return nextOwnerRecord;
  } finally {
    await lock.release();
  }
}

// §6: the heartbeat's write. Advances leaseAffirmedAt and, so the ownership design's named
// freshness anchor stops being dead, lastAffirmedAt alongside it. Never rotates an epoch,
// never changes ownerStatus, never touches supersededByEpoch.
//
// Returns the record it just wrote: the caller MUST adopt it as its next expected record
// (§6.1), because this write makes the caller's previous expectation stale immediately.
export async function affirmOwnerLease(
  runDir: string,
  expected: OwnerRecord,
  nowIso: string,
): Promise<OwnerRecord> {
  return updateOwnerRecordWithPrecondition(
    runDir,
    expected,
    (persisted) => ({ ...persisted, lastAffirmedAt: nowIso, leaseAffirmedAt: nowIso }),
    "persisted owner record changed before the lease could be affirmed",
  );
}

// §6.0: release. CAS leaseAffirmedAt back to null, leaving every other field alone — the
// run is still owned, just no longer running. Kept separate from affirmOwnerLease because
// that name would lie about writing null.
//
// Best-effort by contract: it throws on a CAS mismatch and the caller swallows that, so a
// superseded process cannot clear the lease of the owner that replaced it.
export async function releaseOwnerLease(runDir: string, expected: OwnerRecord): Promise<void> {
  await updateOwnerRecordWithPrecondition(
    runDir,
    expected,
    (persisted) => ({ ...persisted, leaseAffirmedAt: null }),
    "persisted owner record changed before the lease could be released",
  );
}
```

Then rewrite the tail of `claimOwnerRecordWithPrecondition` to use the shared helper, keeping its message verbatim:

```ts
    const { ownerPath, ownerTempPath } = getOwnerTransferPaths(runDir);
    await safeUnlink(ownerTempPath);
    await writeJsonFile(ownerTempPath, nextOwnerRecord);
    await rename(ownerTempPath, ownerPath);
```

becomes

```ts
    await writeOwnerRecordAtomically(runDir, nextOwnerRecord);
```

- [ ] **Step 4: Run the tests**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/persistence/leaseStore.test.ts tests/persistence/fileStore.test.ts`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/persistence/fileStore.ts tests/persistence/leaseStore.test.ts
git commit -m "feat: add recovery-free owner-record read plus CAS lease affirm and release"
```

---

## Task 5: `leaseFresh` becomes a required input to `evaluateOwnership`

**Files:**
- Modify: `src/state/types.ts:57-65`
- Modify: `src/ownership/ownerController.ts:18` (wrap the existing body)
- Modify: `src/controller/runLoop.ts:653-661` (pass `"unknown"`)
- Test: `tests/ownership/ownerController.test.ts`

**Interfaces:**
- Produces: `OwnershipEvaluationInput.leaseFresh: boolean | "unknown"` (required).

**Why:** §9. Required, not optional-with-a-default: an optional field would make "I forgot to pass it" indistinguishable from "I looked and could not tell", and that distinction is the whole content of §4.2. §9.1: in L1 no production caller supplies `true` — the field is read but never really supplied, deliberately, and the regression fence below is what keeps it honest until L3.

**Structural guarantee:** the existing verdict logic is renamed, untouched, into a private function, and the live-lease rule is applied *after* it. That makes "byte-for-byte unchanged when `leaseFresh !== true`" a property of the code shape, not of a reviewer's diligence.

- [ ] **Step 1: Write the failing tests**

In `tests/ownership/ownerController.test.ts`, add `leaseFresh: "unknown" as const,` to `baseInput`, then append inside the `describe`:

```ts
  // §9.1 regression fence. In L1 no production caller ever passes `true`, so without this
  // the field could silently rot. Every existing case must be identical under "unknown"
  // AND under false — anything else means freshness leaked into a verdict path.
  it.each([false, "unknown"] as const)("changes no verdict when leaseFresh is %s", (leaseFresh) => {
    const cases = [
      baseInput,
      { ...baseInput, persistedOwnerStillSupported: true },
      { ...baseInput, ownerRecord: { ...baseInput.ownerRecord, ownerStatus: "lost" as const } },
      { ...baseInput, ownerRecord: { ...baseInput.ownerRecord, ownerStatus: "unknown" as const } },
      { ...baseInput, ownerRecord: { ...baseInput.ownerRecord, supersededByEpoch: 2 } },
      { ...baseInput, knownSupersedingEpoch: 3 },
      { ...baseInput, currentProcessStillTrusted: true, persistedOwnerStillSupported: true },
      { ...baseInput, lastTrustedBoundary: "unknown" as const },
      { ...baseInput, boundaryAnalysis: { ...baseInput.boundaryAnalysis, status: "healthy" as const } },
    ];

    for (const input of cases) {
      expect(evaluateOwnership({ ...input, leaseFresh })).toEqual(
        evaluateOwnership({ ...input, leaseFresh: "unknown" }),
      );
    }
  });

  // §4.2: a live lease is a counter-claim. It may only push toward refusal.
  it("blocks OWNER_LOST and takeover when the lease is fresh", () => {
    const withoutLease = evaluateOwnership(baseInput);
    expect(withoutLease.verdict).toBe("OWNER_LOST");
    expect(withoutLease.takeoverAllowed).toBe(true);

    const withLease = evaluateOwnership({ ...baseInput, leaseFresh: true });

    expect(withLease.verdict).toBe("OWNER_UNDECIDABLE");
    expect(withLease.takeoverAllowed).toBe(false);
    expect(withLease.reasons.join(" ")).toContain("live run lease");
  });

  it("blocks OWNER_LOST via the persisted-owner-lost path too when the lease is fresh", () => {
    const input = {
      ...baseInput,
      ownerRecord: { ...baseInput.ownerRecord, ownerStatus: "lost" as const },
    };
    expect(evaluateOwnership(input).verdict).toBe("OWNER_LOST");

    expect(evaluateOwnership({ ...input, leaseFresh: true }).verdict).toBe("OWNER_UNDECIDABLE");
  });

  // A fresh lease must not turn a refusal into a permission — it only ever adds refusals.
  it("never upgrades a verdict: OWNER_SUPERSEDED stays superseded under a fresh lease", () => {
    const input = {
      ...baseInput,
      ownerRecord: { ...baseInput.ownerRecord, supersededByEpoch: 2 },
    };

    expect(evaluateOwnership({ ...input, leaseFresh: true })).toEqual(evaluateOwnership(input));
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/ownership/ownerController.test.ts`
Expected: FAIL — `leaseFresh` is not a known property (typecheck) and the fresh-lease cases return `OWNER_LOST`.

- [ ] **Step 3: Add the required field**

`src/state/types.ts`:

```ts
export type OwnershipEvaluationInput = {
  ownerRecord: OwnerRecord;
  persistedOwnerStillSupported: boolean;
  boundaryAnalysis: RunBoundaryAnalysis;
  currentProcessStillTrusted: boolean;
  supportingContinuityEvidence: string[];
  knownSupersedingEpoch: number | null;
  lastTrustedBoundary: LastTrustedBoundary;
  // §9: REQUIRED on purpose. Optional-with-a-default would make "I forgot to pass it"
  // indistinguishable from "I looked and could not tell", and that distinction is the
  // whole content of §4.2. Derived from leaseAffirmedAt, never from lastAffirmedAt.
  leaseFresh: boolean | "unknown";
};
```

- [ ] **Step 4: Wrap the verdict logic**

In `src/ownership/ownerController.ts`, rename the current exported `evaluateOwnership` to a private `evaluateOwnershipWithoutLease` (body unchanged, not one character), and add:

```ts
// §4.2: freshness is Layer A evidence used ONLY in the deny direction. `true` is a live
// counter-claim that blocks OWNER_LOST and blocks takeover; `false` and "unknown"
// contribute nothing. Applying it after the existing logic — rather than inside it — is
// what makes "no existing verdict changes" a property of the code shape.
export function evaluateOwnership(input: OwnershipEvaluationInput): OwnershipEvaluation {
  const evaluation = evaluateOwnershipWithoutLease(input);

  if (input.leaseFresh !== true) {
    return evaluation;
  }

  if (evaluation.verdict !== "OWNER_LOST" && !evaluation.takeoverAllowed) {
    return evaluation;
  }

  return {
    ...evaluation,
    verdict: "OWNER_UNDECIDABLE",
    reasons: [...evaluation.reasons, "a live run lease contradicts owner loss"],
    takeoverAllowed: false,
  };
}
```

- [ ] **Step 5: Update the one production construction site**

`src/controller/runLoop.ts`, inside `evaluateOwnershipFor`:

```ts
    return evaluateOwnership({
      ownerRecord: persistedOwnerRecord,
      persistedOwnerStillSupported,
      boundaryAnalysis,
      currentProcessStillTrusted: boundaryEvidence.currentProcessStillTrusted,
      supportingContinuityEvidence,
      knownSupersedingEpoch: null,
      lastTrustedBoundary: boundaryEvidence.lastTrustedBoundary,
      // §9.1: no production supplier in L1 — deliberately. L3 is where the first real
      // measured value appears.
      leaseFresh: "unknown",
    });
```

- [ ] **Step 6: Fix every remaining construction site the compiler finds**

Run: `npm run typecheck`. Add `leaseFresh: "unknown"` to each reported site. Do **not** invent a computed value anywhere — §9.1 forbids a real supplier in L1.

- [ ] **Step 7: Run the full suite**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/state/types.ts src/ownership/ownerController.ts src/controller/runLoop.ts tests/ownership/ownerController.test.ts
git commit -m "feat: make leaseFresh a required ownership-evaluation input, used only to refuse"
```

---

## Task 6: The acquisition gate

**Files:**
- Create: `src/controller/leaseGate.ts`
- Test: `tests/controller/leaseGate.test.ts` (new)

**Interfaces:**
- Consumes: `isLeaseFresh`, `parseOwnerRecordForLease`, `RunLeaseHeldError`, `LEASE_TTL_MS` (Task 2); `readOwnerRecordWithoutRecovery` (Task 4); `appendEvent`.
- Produces:

```ts
export type LeaseGateOutcome =
  | { kind: "no_record" }
  | { kind: "no_lease"; ownerRecord: OwnerRecord }
  | { kind: "held_by_self"; ownerRecord: OwnerRecord }
  | { kind: "expired"; ownerRecord: OwnerRecord };

export async function checkRunLease(
  runDir: string,
  selfProcessInstanceId: string,
  nowMs?: number,
): Promise<LeaseGateOutcome>;
```

**Why:** §7. The five branches, in order. The two hard rules an implementer gets wrong: **only `ENOENT` means "no lease"** (everything else is a refusal), and **expiry takes no position at all** — it neither permits nor refuses, it only records an observation.

- [ ] **Step 1: Write the failing tests**

Create `tests/controller/leaseGate.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRunLease } from "../../src/controller/leaseGate.js";
import { LEASE_TTL_MS, RunLeaseHeldError } from "../../src/ownership/lease.js";
import type { OwnerRecord } from "../../src/runtime/types.js";

const NOW = Date.parse("2026-07-26T10:00:00.000Z");
const SELF = "pid:4242:2000";

function record(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1:t0",
    currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:100:1000",
    lastAffirmedAt: "2026-07-26T09:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
    ...overrides,
  };
}

async function seed(owner: unknown | undefined): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-gate-"));
  await writeFile(join(runDir, "events.jsonl"), "");
  if (owner !== undefined) {
    await writeFile(join(runDir, "owner-record.json"), typeof owner === "string" ? owner : JSON.stringify(owner, null, 2));
  }
  return runDir;
}

async function eventTypes(runDir: string): Promise<string[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line).type as string);
}

describe("checkRunLease", () => {
  it("reports no_record and appends nothing when the file does not exist", async () => {
    const runDir = await seed(undefined);

    expect(await checkRunLease(runDir, SELF, NOW)).toEqual({ kind: "no_record" });
    expect(await eventTypes(runDir)).toEqual([]);
  });

  // §7 / §5.0: this is the post-transfer state. A run reconciliation has just handed to a
  // new owner is OWNED but NOT RUNNING, and its resume must not be refused.
  it("reports no_lease and takes no position when leaseAffirmedAt is null", async () => {
    const runDir = await seed(record({ leaseAffirmedAt: null }));

    expect(await checkRunLease(runDir, SELF, NOW)).toMatchObject({ kind: "no_lease" });
    expect(await eventTypes(runDir)).toEqual([]);
  });

  it("reports no_lease for a legacy record with no leaseAffirmedAt field at all", async () => {
    const legacy = record();
    delete (legacy as { leaseAffirmedAt?: unknown }).leaseAffirmedAt;
    const runDir = await seed(legacy);

    expect(await checkRunLease(runDir, SELF, NOW)).toMatchObject({ kind: "no_lease" });
  });

  it("refuses with RunLeaseHeldError naming the holder and remaining TTL", async () => {
    const runDir = await seed(
      record({ leaseAffirmedAt: new Date(NOW - 30_000).toISOString(), currentProcessInstanceId: "pid:100:1000" }),
    );

    await expect(checkRunLease(runDir, SELF, NOW)).rejects.toBeInstanceOf(RunLeaseHeldError);
    await expect(checkRunLease(runDir, SELF, NOW)).rejects.toMatchObject({
      holderProcessInstanceId: "pid:100:1000",
      remainingTtlMs: LEASE_TTL_MS - 30_000,
    });
  });

  // §5.1: the recycled-PID case. Same PID, earlier start time — NOT this process. An
  // implementation that compares only the pid segment lets an unrelated later process
  // walk straight through a live lease, defeating L1's single guarantee.
  it("refuses a fresh lease held by the same PID with an earlier start time", async () => {
    const runDir = await seed(
      record({ currentProcessInstanceId: "pid:4242:1000", leaseAffirmedAt: new Date(NOW - 1_000).toISOString() }),
    );

    await expect(checkRunLease(runDir, "pid:4242:2000", NOW)).rejects.toBeInstanceOf(RunLeaseHeldError);
  });

  it("refuses a fresh lease recorded in the legacy pid-only format", async () => {
    const runDir = await seed(
      record({ currentProcessInstanceId: "pid:4242", leaseAffirmedAt: new Date(NOW - 1_000).toISOString() }),
    );

    await expect(checkRunLease(runDir, "pid:4242:2000", NOW)).rejects.toBeInstanceOf(RunLeaseHeldError);
  });

  it("proceeds when the fresh lease is this process's own", async () => {
    const runDir = await seed(
      record({ currentProcessInstanceId: SELF, leaseAffirmedAt: new Date(NOW - 1_000).toISOString() }),
    );

    expect(await checkRunLease(runDir, SELF, NOW)).toMatchObject({ kind: "held_by_self" });
    expect(await eventTypes(runDir)).toEqual([]);
  });

  // §7: expiry authorizes nothing AND refuses nothing. It is an observation, recorded so
  // later layers can see it, and control passes unchanged to the gates that already exist.
  it("takes no position on an expired lease and records the observation", async () => {
    const runDir = await seed(
      record({ leaseAffirmedAt: new Date(NOW - LEASE_TTL_MS - 1).toISOString() }),
    );

    expect(await checkRunLease(runDir, SELF, NOW)).toMatchObject({ kind: "expired" });
    expect(await eventTypes(runDir)).toEqual(["lease_expired_observed"]);
  });

  // §7: only ENOENT means "no lease". Everything else is a refusal — including the shapes
  // readOwnerRecordRaw would have accepted silently.
  it.each([
    ["malformed JSON", "{ not json"],
    ["a record missing currentProcessInstanceId", { currentOwnerEpoch: 2, leaseAffirmedAt: null }],
    ["a record with a non-string leaseAffirmedAt", { currentProcessInstanceId: "pid:1:1", currentOwnerEpoch: 2, leaseAffirmedAt: 12345 }],
  ])("refuses %s rather than treating it as absent", async (_label, owner) => {
    const runDir = await seed(owner);

    await expect(checkRunLease(runDir, SELF, NOW)).rejects.toThrow();
    await expect(checkRunLease(runDir, SELF, NOW)).rejects.not.toBeInstanceOf(RunLeaseHeldError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseGate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the gate**

Create `src/controller/leaseGate.ts`:

```ts
import { isLeaseFresh, LEASE_TTL_MS, parseOwnerRecordForLease, RunLeaseHeldError } from "../ownership/lease.js";
import { appendEvent, readOwnerRecordWithoutRecovery } from "../persistence/fileStore.js";
import type { OwnerRecord } from "../runtime/types.js";

export type LeaseGateOutcome =
  | { kind: "no_record" }
  | { kind: "no_lease"; ownerRecord: OwnerRecord }
  | { kind: "held_by_self"; ownerRecord: OwnerRecord }
  | { kind: "expired"; ownerRecord: OwnerRecord };

// §7. Runs as early as possible, but never before initializeRunFiles, because it may append
// an event and events.jsonl does not exist before that call.
//
// Reads RAW (§7.1): readOwnerRecord would run recoverInterruptedOwnerTransfer first, so a
// refusal would trigger crash recovery as a side effect.
export async function checkRunLease(
  runDir: string,
  selfProcessInstanceId: string,
  nowMs: number = Date.now(),
): Promise<LeaseGateOutcome> {
  let raw: unknown;

  try {
    raw = await readOwnerRecordWithoutRecovery(runDir);
  } catch (error) {
    // ONLY ENOENT means "brand-new run directory, so there is no lease". Every other read
    // failure — unreadable file, malformed JSON — is a refusal, never "no lease here".
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "no_record" };
    }

    throw error;
  }

  const ownerRecord = parseOwnerRecordForLease(raw);
  const leaseAffirmedAt = ownerRecord.leaseAffirmedAt ?? null;

  if (leaseAffirmedAt === null) {
    // §5.0: owned, but nobody is running it. This is the post-transfer state, and the
    // gate must take no position on it.
    return { kind: "no_lease", ownerRecord };
  }

  if (!isLeaseFresh(ownerRecord, nowMs, LEASE_TTL_MS)) {
    // §7: expiry neither permits nor refuses. Record the observation so later layers can
    // see it instead of it being silently swallowed, then pass control on unchanged.
    await appendEvent(runDir, {
      type: "lease_expired_observed",
      at: new Date(nowMs).toISOString(),
      detail: `lease held by ${ownerRecord.currentProcessInstanceId} expired at ${leaseAffirmedAt}`,
    });
    return { kind: "expired", ownerRecord };
  }

  // §5.1: opaque, compared only for string equality. A legacy `pid:<pid>` record and a
  // recycled PID with a different start time both fail this comparison, which can only
  // add refusals.
  if (ownerRecord.currentProcessInstanceId !== selfProcessInstanceId) {
    const remainingTtlMs = LEASE_TTL_MS - (nowMs - Date.parse(leaseAffirmedAt));
    throw new RunLeaseHeldError(ownerRecord.currentProcessInstanceId, remainingTtlMs);
  }

  return { kind: "held_by_self", ownerRecord };
}
```

- [ ] **Step 4: Run the tests**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseGate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller/leaseGate.ts tests/controller/leaseGate.test.ts
git commit -m "feat: add the run-lease acquisition gate"
```

---

## Task 7: Wire the gate into `resumeLoop`

**Files:**
- Modify: `src/controller/resumeLoop.ts:82-107`
- Test: `tests/controller/resumeLoop.integration.test.ts` (append cases)

**Interfaces:**
- Consumes: `checkRunLease` (Task 6), `buildProcessInstanceId` (Task 3).
- Produces: no new export; `resumeLoop` may now reject with `RunLeaseHeldError`.

**Why:** §7 places the gate immediately after the opening `resume_requested` event and **before every read the eligibility gate performs**, so a live lease refuses earlier and more cheaply than any eligibility reasoning. §7.0: this is the only call site that reaches the interesting branches.

- [ ] **Step 1: Write the failing tests**

Append to `tests/controller/resumeLoop.integration.test.ts` (helpers `seedEligibleRun`, `createRepo`, `createContract`, `successFrame`, `readEventTypes` already exist):

```ts
  async function setLease(runDir: string, leaseAffirmedAt: string | null, holder?: string) {
    const path = join(runDir, "owner-record.json");
    const owner = JSON.parse(await readFile(path, "utf8"));
    owner.leaseAffirmedAt = leaseAffirmedAt;
    if (holder !== undefined) {
      owner.currentProcessInstanceId = holder;
    }
    await writeFile(path, JSON.stringify(owner, null, 2));
  }

  // §7.1: a refusal introduces no new state mutation. Events are the stated exception —
  // and the ONLY one. This is what "the lease adds refusals, never authority" buys.
  it("refuses a resume against a live lease and mutates nothing but events", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    await setLease(runDir, new Date().toISOString(), "pid:999:9000");

    const ownerBefore = await readFile(join(runDir, "owner-record.json"), "utf8");
    const stateBefore = await readFile(join(runDir, "loop-state.json"), "utf8");

    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(
      RunLeaseHeldError,
    );

    expect(await readFile(join(runDir, "owner-record.json"), "utf8")).toBe(ownerBefore);
    expect(await readFile(join(runDir, "loop-state.json"), "utf8")).toBe(stateBefore);
    expect(await readEventTypes(runDir)).toEqual(["resume_requested", "resume_denied"]);
    // No interrupted-transfer recovery may run on a refusal path (§7.1).
    await expect(access(join(runDir, "owner-transfer.json"))).resolves.toBeUndefined();
  });

  // §5.0's headline regression: with a single timestamp, the record an owner transfer just
  // wrote is seconds old and names the new owner, so a lease gate keyed on lastAffirmedAt
  // would refuse the very resume the transfer authorized, for a full TTL. Asserted WELL
  // INSIDE the TTL — the expiry test below only covers the aged-out case.
  it("does not refuse a resume immediately after an owner transfer", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    await setLease(runDir, null, "pid:100:1000"); // freshly transferred: owned, not running

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    owner.lastAffirmedAt = new Date().toISOString(); // seconds old, as a transfer leaves it
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(owner, null, 2));

    const finalState = await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    expect(finalState.status).toBe("succeeded");
    expect(await readEventTypes(runDir)).not.toContain("lease_expired_observed");
  });

  // §7: expiry refuses nothing. An eligible resume still succeeds; the observation is
  // recorded either way.
  it("lets an eligible resume through an expired lease and records the observation", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    await setLease(runDir, new Date(Date.now() - LEASE_TTL_MS - 1_000).toISOString(), "pid:999:9000");

    const finalState = await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    expect(finalState.status).toBe("succeeded");
    expect(await readEventTypes(runDir)).toContain("lease_expired_observed");
  });

  // §7: and expiry authorizes nothing. An INELIGIBLE resume is still refused, and refused
  // with the eligibility reason — never a lease reason.
  it("refuses an ineligible resume with the eligibility reason even when the lease has expired", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    await setLease(runDir, new Date(Date.now() - LEASE_TTL_MS - 1_000).toISOString(), "pid:999:9000");

    const state = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
    state.status = "succeeded";
    await writeFile(join(runDir, "loop-state.json"), JSON.stringify(state, null, 2));

    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(
      ResumeNotEligibleError,
    );
    expect(await readEventTypes(runDir)).toContain("lease_expired_observed");
  });

  // §10 / requirement 18: a killed run never releases. Its lease refuses until the TTL
  // elapses, and after that the gate takes no position and the ordinary rules decide.
  it("refuses while a killed run's lease is still fresh and stops refusing after the TTL", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    await setLease(runDir, new Date(Date.now() - LEASE_TTL_MS + 5_000).toISOString(), "pid:999:9000");
    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(
      RunLeaseHeldError,
    );

    await setLease(runDir, new Date(Date.now() - LEASE_TTL_MS - 1).toISOString(), "pid:999:9000");
    expect((await resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).status).toBe("succeeded");
  });
```

Add the imports this needs: `RunLeaseHeldError`, `LEASE_TTL_MS` from `../../src/ownership/lease.js`.

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/resumeLoop.integration.test.ts`
Expected: FAIL — no refusal happens; the live-lease resume succeeds.

- [ ] **Step 3: Insert the gate**

`src/controller/resumeLoop.ts`, immediately after the `resume_requested` event and before the `Promise.all`:

```ts
export async function resumeLoop(runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
  await appendEvent(runDir, { type: "resume_requested", at: new Date().toISOString(), detail: runDir });

  // §7: the lease check runs BEFORE the eligibility gate and before the owner-record
  // claim, so a live lease refuses earlier and more cheaply than any eligibility
  // reasoning. It is an ADDITIONAL refusal layered on top of — never in place of — the
  // eligibility gate and the CAS precondition below.
  try {
    await checkRunLease(runDir, buildProcessInstanceId());
  } catch (error) {
    await appendEvent(runDir, {
      type: "resume_denied",
      at: new Date().toISOString(),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
```

with `import { checkRunLease } from "./leaseGate.js";` and `import { buildProcessInstanceId } from "../runtime/processIdentity.js";`.

- [ ] **Step 4: Run the file, then the full suite**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller/resumeLoop.ts tests/controller/resumeLoop.integration.test.ts
git commit -m "feat: refuse a resume against a live run lease before any eligibility reasoning"
```

---

## Task 8: Wire the gate into `runLoop`

**Files:**
- Modify: `src/controller/runLoop.ts:730-737`
- Test: `tests/controller/leaseGate.test.ts` (append a loop-level block) or `tests/controller/runLoop.integration.test.ts`

**Interfaces:**
- Consumes: `checkRunLease` (Task 6).

**Why:** §7 fixes the position — after `initializeRunFiles` (because the gate may append an event and `events.jsonl` does not exist before it) and before `writeOwnerRecord`. §7.0: because `ensureFreshRunDir` throws on any pre-existing run file, this call site can only ever observe "no owner record". Do not implement anything here for the other branches — they are unreachable from `runLoop`.

- [ ] **Step 1: Write the failing test**

Append to `tests/controller/runLoop.integration.test.ts` (reuse its existing repo/contract helpers):

```ts
  // §7.0 + requirement 3: a second start on an occupied directory fails LOUDLY from
  // ensureFreshRunDir and never reaches the lease gate. The §10.1 TOCTOU window is
  // documented, not simulated — no test may assert that two concurrent starts both proceed.
  it("throws from ensureFreshRunDir on a second start rather than reaching the lease gate", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await runLoop(contract, runDir, new ScriptedAdapter([successFrame()]));

    await expect(runLoop(contract, runDir, new ScriptedAdapter([successFrame()]))).rejects.toThrow(
      /already contains prior run data/,
    );
  });

  // §7 ordering: the gate may append an event, and events.jsonl does not exist before
  // initializeRunFiles. A gate placed one line earlier would crash every fresh start.
  it("appends no event before initializeRunFiles on a brand-new run directory", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await runLoop(contract, runDir, new ScriptedAdapter([successFrame()]));

    const types = await readEventTypes(runDir);
    expect(types[0]).toBe("loop_planning");
    expect(types).not.toContain("lease_expired_observed");
  });
```

- [ ] **Step 2: Run to verify the second test's premise**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/runLoop.integration.test.ts`
Expected: both PASS *before* the change (they pin behavior that must survive it). Record that they pass — the point of this task is that they still pass after Step 3. If the first one fails today, stop: `ensureFreshRunDir` is not doing what §7.0 assumes and the plan needs revisiting.

- [ ] **Step 3: Insert the gate**

```ts
export async function runLoop(contract: LoopContract, runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
  const state = transitionRunState(initialState(contract), "planning");
  const ownerRecord = buildInitialOwnerRecord(contract, state);
  await initializeRunFiles(runDir, contract, state);
  // §7: as early as possible, but never before initializeRunFiles — the gate may append an
  // event and events.jsonl does not exist yet. §7.0: ensureFreshRunDir has already thrown
  // on any pre-existing run file, so this call can only ever observe "no owner record";
  // every other branch is reachable through resumeLoop alone.
  await checkRunLease(runDir, ownerRecord.currentProcessInstanceId);
  await writeOwnerRecord(runDir, ownerRecord);
  await appendTransitionEvent(runDir, state, "loop_planning", "run initialized and ready to plan");
  return runLoopFromState(contract, runDir, adapter, state);
}
```

- [ ] **Step 4: Re-run**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller/runLoop.ts tests/controller/runLoop.integration.test.ts
git commit -m "feat: run the lease gate on a fresh start, between initializeRunFiles and writeOwnerRecord"
```

---

## Task 9: The heartbeat — timer, throttled affirm, record rotation, releasing stop

**Files:**
- Create: `src/controller/leaseHeartbeat.ts`
- Test: `tests/controller/leaseHeartbeat.test.ts` (new)

**Interfaces:**
- Consumes: `affirmOwnerLease`, `releaseOwnerLease`, `readOwnerRecordWithoutRecovery`, `appendEvent`, `OwnerTransferPreconditionError` (Task 4); lease constants and errors (Task 2).
- Produces:

```ts
export type LeaseHeartbeat = {
  affirmNow: () => Promise<void>;
  assertHeld: () => Promise<void>;   // Task 10 fills this in
  stop: () => Promise<void>;
};

export function startLeaseHeartbeat(options: {
  runDir: string;
  ownerRecord: OwnerRecord;
  onLeaseLost: (error: unknown) => void;
  now?: () => number;
}): LeaseHeartbeat;
```

**Why:** §6 (two writers, one throttled `affirmNow`), §6.0 (start only after the record naming this process is on disk; `stop()` on every exit path and it releases), §6.1 (rotate the expected record on every success; a failed CAS is not by itself supersession).

**Three traps this task exists to avoid:**
1. Not rotating the expected record → the second affirm fails its own CAS and, under a naive §8 reading, stops a healthy run one interval in.
2. Treating a bare CAS failure as supersession → same outcome, different route.
3. `stop()` only cancelling the timer → the finished run's lease stays frozen and refuses the next legitimate process for a full TTL.

- [ ] **Step 1: Write the failing tests**

Create `tests/controller/leaseHeartbeat.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLeaseHeartbeat } from "../../src/controller/leaseHeartbeat.js";
import { LEASE_HEARTBEAT_INTERVAL_MS, LEASE_TTL_MS } from "../../src/ownership/lease.js";
import type { OwnerRecord } from "../../src/runtime/types.js";

const SELF = "pid:4242:2000";

function record(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    runId: "task-1",
    logicalSessionId: "task-1:t0",
    currentOwnerEpoch: 2,
    currentProcessInstanceId: SELF,
    lastAffirmedAt: "2026-07-26T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
    ...overrides,
  };
}

async function seed(owner: OwnerRecord): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-hb-"));
  await writeFile(join(runDir, "events.jsonl"), "");
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify(owner, null, 2));
  return runDir;
}

async function readOwner(runDir: string): Promise<OwnerRecord> {
  return JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as OwnerRecord;
}

describe("startLeaseHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-07-26T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // §6.1, written to fail against the naive implementation that keeps comparing against
  // its start-of-run record: that one fails its own second CAS roughly one interval in and
  // stops a perfectly healthy run.
  it("keeps affirming across a TTL window with no external interference", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
      seen.push((await readOwner(runDir)).leaseAffirmedAt as string);
    }

    expect(new Set(seen).size).toBe(3); // three distinct, advancing affirmations
    expect(Date.parse(seen[2]) - Date.parse(seen[0])).toBe(2 * LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.stop();
  });

  // §6: both writers funnel through one throttled affirmNow so they cannot thrash the
  // owner-transfer lock.
  it("throttles event-driven affirms that arrive inside the throttle window", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await heartbeat.affirmNow();
    const first = (await readOwner(runDir)).leaseAffirmedAt;

    await vi.advanceTimersByTimeAsync(1_000);
    await heartbeat.affirmNow();

    expect((await readOwner(runDir)).leaseAffirmedAt).toBe(first);
    await heartbeat.stop();
  });

  // §6.0. Written to fail against an implementation that only cancels the timer: that one
  // leaves leaseAffirmedAt frozen and refuses the next legitimate process for a full TTL.
  // Asserted while the last heartbeat is still well inside the TTL.
  it("releases the lease on stop, not merely cancelling the timer", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await heartbeat.affirmNow();
    expect((await readOwner(runDir)).leaseAffirmedAt).not.toBeNull();

    await heartbeat.stop();

    expect((await readOwner(runDir)).leaseAffirmedAt).toBeNull();
    expect(Date.now() - Date.parse(record().lastAffirmedAt)).toBeLessThan(LEASE_TTL_MS);
  });

  // Requirement 4: assert the absence of AFFIRMS, not the absence of writes — stop() is
  // required to make exactly one write, the release.
  it("performs no further affirm after stop", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.stop();

    await vi.advanceTimersByTimeAsync(5 * LEASE_HEARTBEAT_INTERVAL_MS);

    expect((await readOwner(runDir)).leaseAffirmedAt).toBeNull();
  });

  // §6.0: on the lease_lost path the record belongs to the new owner. The release must
  // fail its CAS and be swallowed — never an unconditional write that could clear a lease
  // the new owner has already begun affirming.
  it("swallows a failed release and leaves the new owner's lease intact", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });
    await heartbeat.affirmNow();

    const newOwner = record({
      currentOwnerEpoch: 3,
      currentProcessInstanceId: "pid:999:9000",
      leaseAffirmedAt: "2026-07-26T10:05:00.000Z",
    });
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(newOwner, null, 2));

    await expect(heartbeat.stop()).resolves.toBeUndefined();

    expect((await readOwner(runDir)).leaseAffirmedAt).toBe("2026-07-26T10:05:00.000Z");
  });

  // §6.1: a failed CAS is NOT by itself proof of supersession. Only a re-read showing the
  // record no longer names this process at this epoch concludes it.
  it("reports lease loss only after a re-read confirms a different owner", async () => {
    const runDir = await seed(record());
    const lost: unknown[] = [];
    const heartbeat = startLeaseHeartbeat({
      runDir,
      ownerRecord: record(),
      onLeaseLost: (error) => lost.push(error),
    });

    // A record that differs but still names this process at this epoch: transient.
    await writeFile(
      join(runDir, "owner-record.json"),
      JSON.stringify(record({ lastAffirmedAt: "2026-07-26T10:00:05.000Z" }), null, 2),
    );
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    expect(lost).toHaveLength(0);

    // Now a genuine rotation.
    await writeFile(
      join(runDir, "owner-record.json"),
      JSON.stringify(record({ currentOwnerEpoch: 3, currentProcessInstanceId: "pid:999:9000" }), null, 2),
    );
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);

    expect(lost).toHaveLength(1);
    const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
    expect(raw).toContain("lease_lost");
    await heartbeat.stop();
  });

  it("never throws into the caller when a heartbeat write fails", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await writeFile(join(runDir, "owner-record.json"), "{ not json");

    await expect(heartbeat.affirmNow()).resolves.toBeUndefined();
    await expect(vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS)).resolves.toBeUndefined();
    await heartbeat.stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module (`assertHeld` is a stub until Task 10)**

Create `src/controller/leaseHeartbeat.ts`:

```ts
import {
  LEASE_AFFIRM_THROTTLE_MS,
  LEASE_HEARTBEAT_INTERVAL_MS,
  RunLeaseLostError,
} from "../ownership/lease.js";
import {
  affirmOwnerLease,
  appendEvent,
  OwnerTransferPreconditionError,
  readOwnerRecordWithoutRecovery,
  releaseOwnerLease,
} from "../persistence/fileStore.js";
import type { OwnerRecord } from "../runtime/types.js";

export type LeaseHeartbeat = {
  affirmNow: () => Promise<void>;
  assertHeld: () => Promise<void>;
  stop: () => Promise<void>;
};

export function startLeaseHeartbeat(options: {
  runDir: string;
  ownerRecord: OwnerRecord;
  onLeaseLost: (error: unknown) => void;
  now?: () => number;
}): LeaseHeartbeat {
  const now = options.now ?? (() => Date.now());
  // §6.1: each successful affirm changes the record, so the one we compared against is
  // stale the moment it succeeds. We adopt what affirmOwnerLease returns, every time.
  let expected = options.ownerRecord;
  let lastAffirmAtMs = Number.NEGATIVE_INFINITY;
  let stopped = false;
  let superseded = false;
  // Both writers of §6 funnel through here, so serialize them: the throttle alone does not
  // stop two calls in the same tick from racing the owner-transfer lock.
  let queue: Promise<void> = Promise.resolve();

  // §6.1 / §8: the ONE criterion for supersession, shared with assertHeld. A record that
  // differs for reasons this process cannot explain is a transient failure, not proof.
  const namesSomeoneElse = (persisted: OwnerRecord): boolean =>
    persisted.currentOwnerEpoch !== expected.currentOwnerEpoch
    || persisted.supersededByEpoch !== null
    || persisted.currentProcessInstanceId !== expected.currentProcessInstanceId;

  const concludeLeaseLost = async (persisted: OwnerRecord): Promise<void> => {
    superseded = true;
    await appendEvent(options.runDir, {
      type: "lease_lost",
      at: new Date(now()).toISOString(),
      detail: `expected ${expected.currentProcessInstanceId} at epoch ${expected.currentOwnerEpoch}, observed ${persisted.currentProcessInstanceId} at epoch ${persisted.currentOwnerEpoch}`,
    });
    options.onLeaseLost(
      new RunLeaseLostError(
        `run lease lost: owner record now names ${persisted.currentProcessInstanceId} at epoch ${persisted.currentOwnerEpoch}`,
      ),
    );
  };

  const runAffirm = async (): Promise<void> => {
    if (stopped || superseded) {
      return;
    }

    if (now() - lastAffirmAtMs < LEASE_AFFIRM_THROTTLE_MS) {
      return;
    }

    try {
      expected = await affirmOwnerLease(options.runDir, expected, new Date(now()).toISOString());
      lastAffirmAtMs = now();
    } catch (error) {
      // §6: a failure that is not a precondition failure — lock contention, transient I/O —
      // is swallowed and retried on the next tick. It must never throw into the control loop.
      if (!(error instanceof OwnerTransferPreconditionError)) {
        return;
      }

      let persisted: OwnerRecord;
      try {
        persisted = await readOwnerRecordWithoutRecovery(options.runDir);
      } catch {
        return; // cannot re-read: transient, retry next tick. Not proof of anything.
      }

      if (!namesSomeoneElse(persisted)) {
        return;
      }

      await concludeLeaseLost(persisted);
    }
  };

  const affirmNow = (): Promise<void> => {
    queue = queue.then(runAffirm, runAffirm);
    return queue;
  };

  const timer = setInterval(() => {
    void affirmNow();
  }, LEASE_HEARTBEAT_INTERVAL_MS);

  // §6.0: so the timer never keeps the process alive. This does NOT substitute for stop() —
  // a run can end long before its process does. Guarded because fake-timer implementations
  // do not always provide unref.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    clearInterval(timer);
    await queue.catch(() => {});

    // §6.0: cancelling the timer is only half. Without this release, a run that has already
    // finished still reads as "somebody is running this" for up to one TTL and refuses the
    // next legitimate process. Best-effort: on the lease_lost path the CAS cannot match and
    // the write is swallowed, which is exactly right — a superseded process must not touch
    // the new owner's record.
    try {
      await releaseOwnerLease(options.runDir, expected);
    } catch {
      // Swallowed by contract: the lease simply ages out.
    }
  };

  const assertHeld = async (): Promise<void> => {
    // Filled in by Task 10.
  };

  return { affirmNow, assertHeld, stop };
}
```

- [ ] **Step 4: Run the tests**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller/leaseHeartbeat.ts tests/controller/leaseHeartbeat.test.ts
git commit -m "feat: add the lease heartbeat with record rotation and a releasing stop"
```

---

## Task 10: `assertHeld` — un-throttled, fail-closed

**Files:**
- Modify: `src/controller/leaseHeartbeat.ts`
- Test: `tests/controller/leaseHeartbeat.test.ts` (append)

**Interfaces:**
- Produces: `assertHeld(): Promise<void>` — resolves when the record still names this process at this epoch; rejects with `RunLeaseLostError` on a clean read naming someone else, or `RunLeaseUnverifiableError` when the record cannot be read or validated after a bounded retry.

**Why:** §8.1. Borrow DoWhiz's per-side-effect epoch re-check and **invert its default**: `thread_epoch_matches` fails *open* in two places (a task without an epoch proceeds; an unreadable state file proceeds). ccloop's re-check fails *closed*. And §8.1's closing paragraph: `assertHeld` reads the record **every time it is called** — it is not subject to `LEASE_AFFIRM_THROTTLE_MS` and caches nothing, because a throttled re-check silently degrades "fail closed before every side effect" into "fail closed at most once per throttle window".

- [ ] **Step 1: Write the failing tests**

Append to `tests/controller/leaseHeartbeat.test.ts`:

```ts
describe("assertHeld", () => {
  // §8.1, written to fail against an implementation that reuses the affirm throttle: two
  // side effects less than LEASE_AFFIRM_THROTTLE_MS apart must EACH read the record.
  it("is never throttled: a record rotated between two close side effects blocks the second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-07-26T10:00:00.000Z"));
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await expect(heartbeat.assertHeld()).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(100); // far inside LEASE_AFFIRM_THROTTLE_MS
    await writeFile(
      join(runDir, "owner-record.json"),
      JSON.stringify(record({ currentOwnerEpoch: 3, currentProcessInstanceId: "pid:999:9000" }), null, 2),
    );

    await expect(heartbeat.assertHeld()).rejects.toMatchObject({ stopReason: "lease_lost" });
    await heartbeat.stop();
    vi.useRealTimers();
  });

  // §8.1 row two: fail CLOSED. An unverifiable lease stops the run rather than letting it
  // act unverified — and deliberately does NOT claim supersession, hence the other reason.
  it("rejects as unverifiable — not as lost — when the record cannot be read", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await writeFile(join(runDir, "owner-record.json"), "{ not json");

    await expect(heartbeat.assertHeld()).rejects.toMatchObject({ stopReason: "lease_unverifiable" });
    await heartbeat.stop();
  });

  it("rejects as unverifiable when the record is structurally invalid", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await writeFile(join(runDir, "owner-record.json"), JSON.stringify({ currentOwnerEpoch: 2 }, null, 2));

    await expect(heartbeat.assertHeld()).rejects.toMatchObject({ stopReason: "lease_unverifiable" });
    await heartbeat.stop();
  });

  // §8.1 row three: a transient failure that clears within the retry budget proceeds.
  it("proceeds when a transient read failure clears within the retry budget", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

    await writeFile(join(runDir, "owner-record.json"), "{ not json");
    setTimeout(() => {
      void writeFile(join(runDir, "owner-record.json"), JSON.stringify(record(), null, 2));
    }, 10);

    await expect(heartbeat.assertHeld()).resolves.toBeUndefined();
    await heartbeat.stop();
  });
});
```

The last test uses real timers (the surrounding `beforeEach` installs fake timers only inside the first `describe`); keep this `describe` outside that one, or call `vi.useRealTimers()` in its own `beforeEach`.

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts -t "assertHeld"`
Expected: FAIL — the stub resolves unconditionally.

- [ ] **Step 3: Implement**

Replace the stub in `src/controller/leaseHeartbeat.ts` (adding `LEASE_VERIFY_READ_ATTEMPTS`, `LEASE_VERIFY_RETRY_DELAY_MS`, `parseOwnerRecordForLease` and `RunLeaseUnverifiableError` to the imports):

```ts
  const delay = (ms: number): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

  // §8.1: re-checked immediately before EVERY side effect, narrowing the window in which a
  // superseded owner can still act from one phase to one side effect.
  //
  // Reads the persisted record every time it is called: NOT subject to the affirm throttle
  // and caching nothing, because a throttled re-check degrades "fail closed before every
  // side effect" into "fail closed at most once per throttle window". The throttle exists
  // to keep the two WRITERS of §6 from thrashing the lock; this is a raw read and takes no
  // lock, so nothing is saved by skipping it.
  //
  // Fails CLOSED, unlike DoWhiz's thread_epoch_matches which proceeds on an unreadable
  // state file. Borrow the shape, invert the default.
  const assertHeld = async (): Promise<void> => {
    let lastError: unknown;

    for (let attempt = 0; attempt < LEASE_VERIFY_READ_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await delay(LEASE_VERIFY_RETRY_DELAY_MS);
      }

      let persisted: OwnerRecord;
      try {
        persisted = parseOwnerRecordForLease(await readOwnerRecordWithoutRecovery(options.runDir));
      } catch (error) {
        lastError = error;
        continue;
      }

      if (namesSomeoneElse(persisted)) {
        // The same criterion the heartbeat applies in §6.1, evaluated by whichever
        // mechanism observes it first — not a second, weaker test.
        superseded = true;
        throw new RunLeaseLostError(
          `run lease lost: owner record now names ${persisted.currentProcessInstanceId} at epoch ${persisted.currentOwnerEpoch}`,
        );
      }

      return;
    }

    throw new RunLeaseUnverifiableError(
      `run lease could not be verified after ${LEASE_VERIFY_READ_ATTEMPTS} attempts: ${String(lastError)}`,
    );
  };
```

- [ ] **Step 4: Run the tests**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseHeartbeat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller/leaseHeartbeat.ts tests/controller/leaseHeartbeat.test.ts
git commit -m "feat: add the un-throttled, fail-closed pre-side-effect lease re-check"
```

---

## Task 11: Heartbeat lifecycle in both controllers

**Files:**
- Modify: `src/controller/runLoop.ts` (`runLoop`, `runLoopFromState` signature)
- Modify: `src/controller/resumeLoop.ts`
- Test: `tests/controller/leaseLifecycle.integration.test.ts` (new)

**Interfaces:**
- Produces: `runLoopFromState(contract, runDir, adapter, initialLoopState, heartbeat?: LeaseHeartbeat)` — the fifth parameter is optional and defaults to an inert heartbeat, so existing direct callers keep compiling and behave exactly as today.

**Why:** §6.0. The heartbeat starts immediately after the gate has admitted this process **and the owner record naming it is on disk** — in `runLoop` after `writeOwnerRecord`, in `resumeLoop` after the CAS claim — and never before, so it can never affirm a lease this process does not hold. `stop()` runs on **every** exit path: normal completion, stop-boundary exit, and any thrown error. That is what the `try/finally` is for.

- [ ] **Step 1: Write the failing tests**

Create `tests/controller/leaseLifecycle.integration.test.ts` with the same `createRepo` / `createContract` / `seedEligibleRun` / `successFrame` / `readEventTypes` helpers used by `tests/controller/resumeLoop.integration.test.ts` (copy all five; the existing files each keep their own copy — match that convention rather than extracting a shared helper module), plus:

```ts
  // §6.0 + requirement 17, written to fail against an implementation whose stop() only
  // cancels the timer. Asserted while the last heartbeat is still WELL INSIDE the TTL, so
  // "it aged out" cannot be mistaken for "it was released".
  it("releases the lease when the loop returns, so the next resume proceeds immediately", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const finalState = await runLoop(contract, runDir, new ScriptedAdapter([successFrame()]));
    expect(finalState.status).toBe("succeeded");

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.leaseAffirmedAt).toBeNull();
    // The run just finished: any lease it held would still be fresh.
    expect(Date.now() - Date.parse(owner.lastAffirmedAt)).toBeLessThan(LEASE_TTL_MS);
  });

  it("releases the lease when the loop throws", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const throwingAdapter = {
      plan: () => Promise.reject(new Error("boom")),
      execute: () => Promise.reject(new Error("boom")),
      verify: () => Promise.reject(new Error("boom")),
    };

    await runLoop(contract, runDir, throwingAdapter as never).catch(() => {});

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.leaseAffirmedAt).toBeNull();
  });

  // §6.0 for the other call site.
  it("releases the lease after a resume completes", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.leaseAffirmedAt).toBeNull();
  });
```

Note: `runLoop` in the throwing case returns a failed `RunState` rather than rejecting (see its outer `catch`), hence the defensive `.catch()`; the assertion is about the record either way.

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts`
Expected: FAIL for the wrong reason at first (`leaseAffirmedAt` is already `null` because nothing ever affirms). Before proceeding, temporarily add an `await heartbeat.affirmNow()` at the top of `runLoopFromState` in Step 3 so the field genuinely becomes non-null mid-run — otherwise this test cannot distinguish "released" from "never taken". Keep that affirm: it is the §6 event-driven refresh at an attempt boundary and is required by Task 13 anyway.

- [ ] **Step 3: Wire `runLoop`**

```ts
export async function runLoop(contract: LoopContract, runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
  const state = transitionRunState(initialState(contract), "planning");
  const ownerRecord = buildInitialOwnerRecord(contract, state);
  await initializeRunFiles(runDir, contract, state);
  await checkRunLease(runDir, ownerRecord.currentProcessInstanceId);
  await writeOwnerRecord(runDir, ownerRecord);
  await appendTransitionEvent(runDir, state, "loop_planning", "run initialized and ready to plan");

  // §6.0: started only now — after the gate admitted this process AND the record naming it
  // is on disk — so it can never affirm a lease this process does not hold.
  const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord, onLeaseLost: () => {} });

  try {
    return await runLoopFromState(contract, runDir, adapter, state, heartbeat);
  } finally {
    // §6.0: every exit path — normal completion, stop-boundary exit, and any throw.
    await heartbeat.stop();
  }
}
```

- [ ] **Step 4: Thread the heartbeat through `runLoopFromState`**

```ts
const INERT_LEASE_HEARTBEAT: LeaseHeartbeat = {
  affirmNow: async () => {},
  assertHeld: async () => {},
  stop: async () => {},
};

export async function runLoopFromState(
  contract: LoopContract,
  runDir: string,
  adapter: RuntimeAdapter,
  initialLoopState: RunState,
  heartbeat: LeaseHeartbeat = INERT_LEASE_HEARTBEAT,
): Promise<RunState> {
  let state = initialLoopState;
  while (true) {
    await writeRunState(runDir, state);
    // §6: the event-driven refresh. It survives environments where the timer is unreliable
    // and additionally evidences that the loop is making progress rather than merely alive.
    await heartbeat.affirmNow();
    const attempt = state.attemptsUsed + 1;
```

- [ ] **Step 5: Wire `resumeLoop`**

After the `resume_adopted` event (the CAS claim has succeeded, so the record on disk names this process):

```ts
  const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: nextOwnerRecord, onLeaseLost: () => {} });

  try {
    await cleanupResidualWorktrees(contract.context.repoPath, runDir);

    const resumedState: RunState = /* unchanged */;

    return await runLoopFromState(contract, runDir, adapter, resumedState, heartbeat);
  } finally {
    await heartbeat.stop();
  }
```

`nextOwnerRecord` is exactly what `claimOwnerRecordWithPrecondition` wrote, so it is the correct starting `expected` for the CAS chain.

- [ ] **Step 6: Run the full suite**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/controller/runLoop.ts src/controller/resumeLoop.ts tests/controller/leaseLifecycle.integration.test.ts
git commit -m "feat: start the lease heartbeat once the record is on disk and stop it on every exit path"
```

---

## Task 12: Stop at the next phase boundary when the lease is lost

**Files:**
- Modify: `src/controller/runLoop.ts` (`runLoopFromState`, plus the `onLeaseLost` callbacks in `runLoop`/`resumeLoop`)
- Test: `tests/controller/leaseLifecycle.integration.test.ts` (append)

**Interfaces:**
- Consumes: `RunLeaseLostError` (Task 2), the heartbeat's `onLeaseLost` (Task 9).

**Why:** §4.4 and §8. A superseded epoch loses execution authority, so a run that discovers it can no longer affirm its own lease must stop rather than continue as a second executor. Stopping happens at a **phase boundary** rather than mid-attempt so the run never tears down state a new owner might be reading. This is the only runtime behavior change L1 makes to `runLoop`.

- [ ] **Step 1: Write the failing test**

Append to `tests/controller/leaseLifecycle.integration.test.ts`:

```ts
  // §8. The rotation is performed by the test writing the file directly. No production path
  // rotates a record this way, and this test must not be read as evidence that one exists.
  it("stops at the next phase boundary with stopReason lease_lost and leaves the new record intact", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    // A rejecting-then-retrying script gives the loop a second attempt to reach.
    const adapter = new ScriptedAdapter([rejectFrame(), successFrame()]);

    const rotated = {
      runId: "task-1",
      logicalSessionId: "task-1:t0",
      currentOwnerEpoch: 99,
      currentProcessInstanceId: "pid:999:9000",
      lastAffirmedAt: new Date().toISOString(),
      ownerStatus: "current",
      supersededByEpoch: null,
      leaseAffirmedAt: new Date().toISOString(),
    };

    const rotateAfterFirstAttempt = new Proxy(adapter, {
      get(target, prop, receiver) {
        if (prop !== "verify") {
          return Reflect.get(target, prop, receiver);
        }
        return async (...args: unknown[]) => {
          const result = await (Reflect.get(target, prop, receiver) as (...a: unknown[]) => Promise<unknown>)(...args);
          await writeFile(join(runDir, "owner-record.json"), JSON.stringify(rotated, null, 2));
          return result;
        };
      },
    });

    const finalState = await runLoop(contract, runDir, rotateAfterFirstAttempt as never);

    expect(finalState.stopReason).toBe("lease_lost");
    expect(finalState.attemptsUsed).toBe(1); // no further attempt started
    expect(await readEventTypes(runDir)).toContain("lease_lost");

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.currentOwnerEpoch).toBe(99); // the new owner's record is untouched
    expect(owner.currentProcessInstanceId).toBe("pid:999:9000");
    expect(owner.leaseAffirmedAt).toBe(rotated.leaseAffirmedAt);
  });
```

`rejectFrame()` is `successFrame()` with `verification.approved: false`, `rejectCategory: "tests fail"`, `safeToRetry: true` — copy the shape from the existing integration tests' rejecting frames.

If the `Proxy` shape proves awkward against `ScriptedAdapter`, an equally valid and simpler mechanism is a tiny hand-written adapter object implementing `plan`/`execute`/`verify` that rotates the record inside `verify`. Either is fine; do not add a production hook to make the test easier.

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts -t "lease_lost"`
Expected: FAIL — the loop starts attempt 2 and finishes normally.

- [ ] **Step 3: Record the loss and stop at the boundary**

In `src/controller/runLoop.ts`, give the caller a place to record the loss and check it at the top of each loop iteration:

```ts
export type LeaseLossSignal = { lost: RunLeaseLostError | null };

export function createLeaseLossSignal(): LeaseLossSignal {
  return { lost: null };
}
```

In `runLoopFromState`, add a sixth parameter `leaseLoss: LeaseLossSignal = { lost: null }` and, immediately after the `heartbeat.affirmNow()` added in Task 11:

```ts
    // §8: stop at a phase boundary rather than mid-attempt, so the run never tears down
    // state a new owner might be reading. Launch no further attempt.
    if (leaseLoss.lost !== null) {
      return await persistTerminalState(runDir, state, "cancelled", "lease_lost");
    }
```

and the same check immediately after the verify phase completes, before the retry `continue` (a phase boundary that can be minutes away from the top of the loop):

```ts
      if (leaseLoss.lost !== null) {
        return await persistTerminalState(runDir, state, "cancelled", "lease_lost");
      }
```

In `runLoop` and `resumeLoop`, replace the placeholder callback:

```ts
  const leaseLoss = createLeaseLossSignal();
  const heartbeat = startLeaseHeartbeat({
    runDir,
    ownerRecord,
    onLeaseLost: (error) => {
      leaseLoss.lost = error as RunLeaseLostError;
    },
  });
```

and pass `leaseLoss` as the sixth argument to `runLoopFromState`.

`persistTerminalState` calls `transitionRunState(state, "cancelled", "lease_lost")`, which sets `stopReason` to the reason and is a legal transition from `planning`, `executing` and `verifying` (`src/state/stateMachine.ts:5-7`). No owner record is written on this path.

- [ ] **Step 4: Run the tests**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller/runLoop.ts src/controller/resumeLoop.ts tests/controller/leaseLifecycle.integration.test.ts
git commit -m "feat: stop the run at the next phase boundary when its lease is lost"
```

---

## Task 13: Re-check before every side effect; abandon in place

**Files:**
- Modify: `src/controller/runLoop.ts`
- Test: `tests/controller/leaseLifecycle.integration.test.ts` (append)

**Interfaces:**
- Consumes: `heartbeat.assertHeld` (Task 10), `RunLeaseLostError` / `RunLeaseUnverifiableError` (Task 2).

**Why:** §8.1. A phase boundary can be minutes wide, so the lease is re-checked immediately before each side-effecting step — launching a Claude call, writing attempt artifacts, and mutating or removing a worktree. What happens afterwards is fixed, not left to the implementer: the side effect is skipped, the attempt is **abandoned in place** (no further side effect of that attempt, *including its worktree cleanup*), the run stops at the next phase boundary, and no new attempt starts. Abandoning rather than unwinding is deliberate: cleanup is itself a side effect on a worktree the new owner may already be reading, and the resume path already performs best-effort cleanup of residual worktrees.

- [ ] **Step 1: Write the failing tests**

Append to `tests/controller/leaseLifecycle.integration.test.ts`:

```ts
  // §8.1 requirement 13: asserted per side-effect KIND, not once generically. Rotating from
  // INSIDE the plan phase makes the ordering deterministic — no timer race — and the next
  // Claude call (execute) is the side effect that must not happen.
  function rotateOwnerRecord(runDir: string): Promise<void> {
    const at = new Date().toISOString();
    return writeFile(join(runDir, "owner-record.json"), JSON.stringify({
      runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 99,
      currentProcessInstanceId: "pid:999:9000", lastAffirmedAt: at,
      ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: at,
    }, null, 2));
  }

  it("does not launch the next Claude call when the record names a different process", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    let executeCalls = 0;
    const adapter = {
      plan: async () => {
        await rotateOwnerRecord(runDir);
        return { summary: "s", primaryTargetPaths: ["src/index.ts"] };
      },
      execute: async () => {
        executeCalls += 1;
        throw new Error("execute must not run");
      },
      verify: async () => { throw new Error("verify must not run"); },
    };

    const finalState = await runLoop(contract, runDir, adapter as never);

    expect(executeCalls).toBe(0);
    expect(finalState.stopReason).toBe("lease_lost");
  });

  // §8.1: abandoned in place — no further side effect of the attempt, INCLUDING its
  // worktree cleanup. The residual worktree survives for the next owner, whose resume path
  // already cleans up residual worktrees before continuing.
  it("leaves the attempt worktree in place rather than unwinding it", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const adapter = {
      plan: async () => {
        await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
          runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 99,
          currentProcessInstanceId: "pid:999:9000", lastAffirmedAt: new Date().toISOString(),
          ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: new Date().toISOString(),
        }, null, 2));
        return { summary: "s", primaryTargetPaths: ["src/index.ts"] };
      },
      execute: async () => { throw new Error("execute must not run"); },
      verify: async () => { throw new Error("verify must not run"); },
    };

    const finalState = await runLoop(contract, runDir, adapter as never);

    expect(finalState.stopReason).toBe("lease_lost");
    await expect(readdir(join(runDir, "worktrees"))).resolves.not.toHaveLength(0);
  });

  // §8.1 row two: unverifiable stops the run, does NOT claim supersession, and writes no
  // owner record.
  it("stops with lease_unverifiable and writes no owner record when the record is corrupt", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    const adapter = {
      plan: async () => {
        await writeFile(join(runDir, "owner-record.json"), "{ not json");
        return { summary: "s", primaryTargetPaths: ["src/index.ts"] };
      },
      execute: async () => { throw new Error("execute must not run"); },
      verify: async () => { throw new Error("verify must not run"); },
    };

    const finalState = await runLoop(contract, runDir, adapter as never);

    expect(finalState.stopReason).toBe("lease_unverifiable");
    expect(await readFile(join(runDir, "owner-record.json"), "utf8")).toBe("{ not json");
    expect(await readEventTypes(runDir)).not.toContain("lease_lost");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/leaseLifecycle.integration.test.ts`
Expected: FAIL — phases run, worktrees are cleaned up, stop reasons are wrong.

- [ ] **Step 3: Guard every side effect**

In `runLoopFromState`, add `await heartbeat.assertHeld();` immediately before each of these, and nowhere else:

1. **Claude calls** — before each of the three `runPhaseWithTimeout(...)` invocations wrapping `adapter.plan`, `adapter.execute` and `runVerification`.
2. **Attempt-artifact writes** — at the top of `writeCompletedAttemptArtifacts` is wrong (it is also called on paths that already abandoned); instead guard the four direct `writeAttemptArtifacts` / `writeCompletedAttemptArtifacts` call sites inside the attempt body. Add a local helper to keep it readable:

```ts
    const guardedWriteArtifacts = async (
      write: () => Promise<void>,
    ): Promise<void> => {
      await heartbeat.assertHeld();
      await write();
    };
```

3. **Worktree mutation and removal** — before `createAttemptWorkspace(...)` and before each `cleanupAttemptWorkspace` / `cleanupAttemptWorkspaceBestEffort` / `cleanupAttemptWorkspaceWithStatus` call inside the attempt body.

- [ ] **Step 4: Abandon in place at the catch site**

At the very top of `runLoopFromState`'s existing `catch (error)` block, before anything else:

```ts
    } catch (error) {
      // §8.1: the side effect was skipped and the attempt is abandoned IN PLACE. No further
      // side effect of this attempt is attempted, including its worktree cleanup — cleanup
      // is itself a side effect on a worktree the new owner may already be reading, and
      // this process has just lost the authority to touch it. The residual worktree is left
      // for the new owner, whose resume path already cleans up residual worktrees.
      if (error instanceof RunLeaseLostError || error instanceof RunLeaseUnverifiableError) {
        return await persistTerminalState(runDir, state, "cancelled", error.stopReason);
      }

      const failureReason = error instanceof PhaseExecutionError ? error.message : String(error);
```

Because `stop()` still runs from `runLoop`'s `finally`, the release is attempted and — on the `lease_lost` path — correctly fails its CAS and is swallowed.

- [ ] **Step 5: Run the full suite**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run && npm run typecheck && npm run build`
Expected: all green. If an existing `runLoop` integration test now fails because `assertHeld` cannot read an owner record, check whether that test drives `runLoopFromState` directly — those callers get the inert heartbeat and must be unaffected. If instead it drives `runLoop` on a directory whose owner record it deletes mid-run, the new failure is correct behavior and the test's expectation needs updating; say so explicitly in the commit message rather than weakening the guard.

- [ ] **Step 6: Commit**

```bash
git add src/controller/runLoop.ts tests/controller/leaseLifecycle.integration.test.ts
git commit -m "feat: re-check the lease before every side effect and abandon the attempt in place"
```

---

## Appendix: spec §12 coverage map

Every one of the spec's 19 testing requirements, and where it is discharged. The six marked ★ are the ones written specifically to fail against a plausible wrong implementation — do not weaken them.

| §12 | Requirement | Task | Test |
|---|---|---|---|
| 1 | Pure predicate, boundaries, null, unparseable | 2 | `isLeaseFresh` block |
| 2 ★ | Recycled PID not mistaken for self | 3, 6 | identity test + gate "same PID, earlier start" |
| 3 | Second `runLoop` fails loudly at `ensureFreshRunDir` | 8 | "throws from ensureFreshRunDir" |
| 4 | Heartbeat under fake timers; no affirm after stop | 9 | "performs no further affirm after stop" |
| 5 ★ | Heartbeat survives its own writes (≥3 affirms) | 9 | "keeps affirming across a TTL window" |
| 6 | Mutual exclusion; unchanged except events; no recovery | 7 | "mutates nothing but events" |
| 7 ★ | Corrupt record refused, not treated as absent | 2, 6 | validator table + gate refusal table |
| 8 | Lease loss stops at phase boundary, record intact | 12 | "stops at the next phase boundary" |
| 9 | Blocked side effect abandons rather than unwinds | 13 | "leaves the attempt worktree in place" + unverifiable case |
| 10 | Regression fence on `evaluateOwnership` | 5 | "changes no verdict when leaseFresh is …" |
| 11 | Expiry authorizes nothing | 7 | "refuses an ineligible resume … even when the lease has expired" |
| 12 | Expiry refuses nothing | 7 | "lets an eligible resume through an expired lease" |
| 13 | Fail-closed re-check, per side-effect kind | 13 | three per-kind tests |
| 14 | No event before `initializeRunFiles` | 8 | "appends no event before initializeRunFiles" |
| 15 ★ | Resume immediately after transfer is not refused | 7 | "does not refuse a resume immediately after an owner transfer" |
| 16 | Only the heartbeat writes `leaseAffirmedAt` | 1 | transfer/claim/initial-record assertions |
| 17 ★ | A finished run releases its lease (return and throw) | 9, 11 | "releases the lease on stop" + both lifecycle tests |
| 18 | A killed run does not release, and that is fine | 7 | "refuses while … fresh and stops refusing after the TTL" |
| 19 ★ | `assertHeld` is never throttled | 10 | "is never throttled: … blocks the second" |

## Appendix: what this plan deliberately does not do

- **No real freshness supplier.** §9.1: every L1 caller passes `leaseFresh: "unknown"`. Computing a real value inside reconciliation is cheap and tempting; it would change live verdicts in the same change that introduces the mechanism and forfeit the regression fence. That is L3's job.
- **No atomic exclusive create.** §10.1's TOCTOU window between `ensureFreshRunDir` and `writeOwnerRecord` stays open. What contains it is the heartbeat: within one interval the loser's affirm fails, it re-reads, finds an identity that is not its own, and stops. Closing the window properly is a real improvement and belongs to a later layer.
- **No cross-run path exclusion.** §2, §8.2: the lease is keyed to a run and serializes executors of the *same* run only. Two different runs targeting the same repository are not mutually excluded. L2/L4.
- **No attempt cap on re-leasing, no registry, no scheduler, no daemon, no orphan GC.** §3.
- **Do not "strengthen" the lease** into something the rest of the system relies on for correctness (§10.1), and do not "fix" it into a visibility timeout where expiry authorizes takeover (§10.2).
