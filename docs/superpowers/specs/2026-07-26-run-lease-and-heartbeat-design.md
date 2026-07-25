# Run Lease and Heartbeat Design

> Status: proposed on 2026-07-26
> Scope: make owner freshness mechanically measurable, and give a live owner exclusive execution rights over its run — without granting any new takeover authority.
> Parent design: [`2026-07-22-ownership-and-reconciliation-boundaries-design.md`](2026-07-22-ownership-and-reconciliation-boundaries-design.md) (§5.5 freshness anchor, §7.1 owner-loss condition 1)
> Sibling design: [`2026-07-25-resume-adopt-continuation-design.md`](2026-07-25-resume-adopt-continuation-design.md)

## 1. Goal

The ownership design requires an "owner freshness anchor" (§5.5) and makes "Layer A no longer supports the original owner's authority" the first of three strict owner-loss conditions (§7.1). Today that anchor is a dead field: `lastAffirmedAt` is written twice — once when a run creates its owner record (`src/controller/runLoop.ts`, `buildInitialOwnerRecord`) and once when `resumeLoop` claims one — and is read by nobody. `evaluateOwnership` cannot evaluate freshness at all, so §7.1 condition 1 is currently unimplementable.

This design fills that gap with two coupled mechanics:

1. a **heartbeat** that keeps `lastAffirmedAt` current while a run is executing; and
2. a **lease** that refuses a second process while the first one's heartbeat is still fresh.

## 2. Non-Goals

This design does not:

- introduce a scheduler, daemon, queue, or run registry;
- authorize any takeover, resume, or continuation that is not already authorized today;
- make lease expiry a proof of owner loss;
- change the resume eligibility gate or the reconciliation verdict rules;
- implement cleanup or orphan GC;
- authorize any paid Claude run;
- rewrite accepted historical evidence.

## 3. Position in the frontier decomposition

Unattended multi-run execution was decomposed into five layers, built bottom-up:

| Layer | Content | New authority |
|---|---|---|
| **L1 (this design)** | lease + heartbeat | none |
| L2 | run registry / queue (read-only multi-run index) | none |
| L3 | scheduler (pure decision function over the registry) | none |
| L4 | daemon (executes scheduler decisions unattended) | large |
| L5 | cleanup / orphan GC | deletion |

L1 comes first because every layer above it decides on owner freshness. A scheduler that concludes "this run's owner is dead, resume it" without a measurable freshness signal is guessing, and the ownership design prefers `OWNER_UNDECIDABLE` over speculative automation (§7.3).

L5 corresponds to the third follow-on spec named in the ownership design §17 and remains unwritten.

## 4. Core principles

### 4.1 The lease adds refusals, never authority

A live lease is a reason to **refuse** a second executor. An expired lease is **not** a reason to permit anything. This keeps the lease compatible with §3.5 and §7.2: timeout-shaped signals may raise suspicion, never prove owner loss.

### 4.2 Freshness is Layer A evidence, used only in the deny direction

`leaseFresh === true` is a counter-claim that blocks `OWNER_LOST` and blocks takeover. `leaseFresh === false` or `"unknown"` contributes nothing on its own. Consequently, wiring freshness into `evaluateOwnership` can only make the system more conservative, never less.

### 4.3 One Layer A record, not two

The lease lives in the existing owner record. No second lease file is introduced, because a separate file would create a second source of truth in which "who is running" and "who is the owner" can disagree — a direct violation of §3.1 and §4.1.

### 4.4 Losing the lease means stopping

The only legal way for the owner record to change under a running owner is a formal reconciliation transfer, which supersedes that owner. Since a superseded epoch loses execution authority (§6.3), a run that discovers it can no longer affirm its own lease must stop rather than continue as a second executor.

## 5. Data model

No new persisted artifact and no schema change. The lease is an interpretation of two fields that already exist on the owner record:

- `lastAffirmedAt` — the freshness anchor, now actively refreshed;
- `currentProcessInstanceId` — the lease holder identity.

Constants (module-level, not contract fields — no configurability until a later layer needs it):

- `LEASE_HEARTBEAT_INTERVAL_MS = 30_000`
- `LEASE_TTL_MS = 90_000` (≥ 3× the interval, so two consecutive missed refreshes do not expire a healthy run)
- `LEASE_AFFIRM_THROTTLE_MS = 10_000` (event-driven refreshes closer together than this are skipped)

A lease is **fresh** when `now - Date.parse(lastAffirmedAt) < LEASE_TTL_MS`. An unparseable or absent `lastAffirmedAt` is **not fresh** — which, per §4.1, denies nothing and authorizes nothing.

## 6. Heartbeat writers

Two independent paths refresh the same field through the same code path, because either one alone has a blind spot:

1. **Wall-clock timer** — an interval timer inside the run process, `unref()`ed so it never keeps the process alive. It carries the lease across a single long Claude call, which no phase-boundary signal can do.
2. **Event-driven refresh** — the same affirm call at attempt boundaries and adapter frame boundaries. It survives environments where the timer is unreliable or the timer-carrying work is killed, and it additionally evidences that the loop is making progress rather than merely being alive.

Both call one `affirmNow()`, throttled by `LEASE_AFFIRM_THROTTLE_MS` so the two paths cannot thrash the owner-transfer lock.

The affirm write is a compare-and-swap against the persisted owner record, performed under the existing `acquireOwnerTransferLock` critical section and reusing the existing interrupted-transfer recovery path. Refreshing only advances `lastAffirmedAt`; it never rotates an epoch, never changes `ownerStatus`, and never touches `supersededByEpoch`.

A heartbeat failure that is **not** a precondition failure (lock contention, transient I/O) is swallowed and retried on the next tick. It must never throw into the control loop.

## 7. Acquisition gate

Both `runLoop` and `resumeLoop` check the lease before doing anything else:

- no owner record exists yet (a brand-new run directory) → there is no lease; proceed, and the record `runLoop` already creates establishes the first one;
- an owner record exists, its lease is fresh, **and** `currentProcessInstanceId` is not this process → refuse with a distinct `RunLeaseHeldError` naming the holder and the remaining TTL;
- otherwise → proceed and take the lease. `resumeLoop` takes it inside the owner-record claim it already performs, which already writes `currentProcessInstanceId` and `lastAffirmedAt`; no second write is added.

A refusal performs **zero** state mutation: no run-state write, no owner-record write, no worktree change. This matches the refusal invariant already established for `resumeLoop`.

In `resumeLoop` the lease check runs **before** the eligibility gate and before the owner-record claim, so a live lease refuses earlier and more cheaply than any eligibility reasoning.

The lease gate is an additional refusal, layered on top of — never in place of — the existing eligibility gate and CAS precondition. A run that passes the lease gate still faces both.

## 8. Losing the lease mid-run

If an affirm fails its CAS precondition, the owner record was legitimately replaced, i.e. this process has been superseded. The run then:

1. appends a `lease_lost` event recording the observed and expected owner records;
2. stops at the next phase boundary with `stopReason = "lease_lost"`, launching no further attempt;
3. leaves the newer owner's record untouched.

Both `RunEvent.type` and `RunState.stopReason` are free-form strings today, so neither addition requires a type change. Only a CAS precondition failure triggers this path; transient failures are handled per §6.

Stopping happens at a phase boundary rather than mid-attempt so the run never tears down state a new owner might be reading. This is the only runtime behavior change L1 makes to `runLoop`.

## 9. Freshness inside `evaluateOwnership`

`OwnershipEvaluationInput` gains one field: `leaseFresh: boolean | "unknown"`.

- `true` → the owner has a live counter-claim: the verdict must not be `OWNER_LOST` and `takeoverAllowed` must be `false`;
- `false` / `"unknown"` → every existing verdict path is unchanged, byte for byte.

Existing callers pass `"unknown"` until L3 supplies a measured value. This containment is what makes wiring freshness in now a zero-regression change.

## 10. Clock and failure modes

| Situation | Effect | Why it is safe |
|---|---|---|
| Machine sleeps / suspends | lease looks expired | expiry authorizes nothing; worst case is more suspicion and more refusal |
| Clock skew across machines | lease looks expired or fresh early | fresh-too-long only adds refusals; expired-too-early adds none |
| `SIGKILL` of the run process | last heartbeat remains, then ages out | after TTL the lease stops refusing; takeover still requires full reconciliation |
| Timer starved or killed | event refresh carries the lease | and vice versa — the two paths cover each other |
| Lock contention with a concurrent transfer | affirm retries next tick | affirm is never on the critical path of correctness |

## 11. Interfaces

```ts
// src/ownership/lease.ts (pure)
export const LEASE_HEARTBEAT_INTERVAL_MS: number;
export const LEASE_TTL_MS: number;
export function isLeaseFresh(record: OwnerRecord, nowMs: number, ttlMs: number): boolean;
export class RunLeaseHeldError extends Error {}

// src/persistence/fileStore.ts
export async function affirmOwnerLease(
  runDir: string,
  expected: OwnerRecord,
  nowIso: string,
): Promise<OwnerRecord>; // throws OwnerTransferPreconditionError when superseded

// src/controller/leaseHeartbeat.ts
export function startLeaseHeartbeat(options: {
  runDir: string;
  ownerRecord: OwnerRecord;
  onLeaseLost: (error: unknown) => void;
  now?: () => number;
}): { affirmNow: () => Promise<void>; stop: () => Promise<void> };
```

## 12. Testing requirements

1. **Pure predicate** — boundary values at exactly TTL, unparseable and absent `lastAffirmedAt`, backwards clock.
2. **Heartbeat under fake timers** — refreshes repeatedly across a TTL window; `stop()` ends all writes.
3. **Mutual exclusion** — a second `resume` against a live-lease run is refused, and a full run-directory snapshot is byte-identical before and after the refusal.
4. **Lease loss** — an externally rotated owner record causes the running loop to stop at the next phase boundary with the distinct reason, start no further attempt, and leave the new owner record intact.
5. **Regression fence** — every existing `evaluateOwnership` case is asserted to produce an identical verdict under `leaseFresh: "unknown"`; only `leaseFresh: true` adds new cases, all of which block `OWNER_LOST` or takeover.
6. **Expiry authorizes nothing** — an expired lease alone does not make any previously-denied resume or takeover succeed.

Every test uses `ScriptedAdapter`. No paid Claude call is permitted by this work.

## 13. Success criteria

An implementer can answer all of the following from this document without inventing policy:

- what makes a lease fresh, and what an unparseable anchor means;
- which two writers refresh it, why both exist, and how they avoid thrashing;
- exactly what a live lease refuses, and what an expired lease permits (nothing);
- what a running owner must do when it can no longer affirm its lease;
- how freshness enters `evaluateOwnership` without changing any existing verdict;
- which layer (L2–L5) each deferred concern belongs to.
