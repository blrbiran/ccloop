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
- rewrite accepted historical evidence;
- **mutually exclude two different runs that target the same repository.** The lease is keyed to a run. Cross-run collision on shared paths is a real hazard and is deliberately left to L2/L4 — see §8.2.

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

Two mechanisms noted here so they are not lost, both belonging to L2/L3 rather than L1:

- an **attempt cap on re-leasing**, so a repeatedly failing run cannot be leased and retried forever. DoWhiz guards its queue with `attempts < max_attempts` and increments `attempts` on every claim (`reference/DoWhiz/DoWhiz_service/scheduler_module/src/ingestion_queue.rs:319`, `:355`);
- **cross-run path exclusion**, per §8.2.

## 4. Core principles

### 4.1 The lease adds refusals, never authority

A live lease is a reason to **refuse** a second executor. An expired lease is **not** a reason to permit anything — and equally not a reason to refuse anything (§7). Expiry is an observation, not a decision. This keeps the lease compatible with §3.5 and §7.2 of the ownership design: timeout-shaped signals may raise suspicion, never prove owner loss.

### 4.2 Freshness is Layer A evidence, used only in the deny direction

`leaseFresh === true` is a counter-claim that blocks `OWNER_LOST` and blocks takeover. `leaseFresh === false` or `"unknown"` contributes nothing on its own. Consequently, wiring freshness into `evaluateOwnership` can only make the system more conservative, never less.

### 4.3 One Layer A record, not two

The lease lives in the existing owner record. No second lease file is introduced, because a separate file would create a second source of truth in which "who is running" and "who is the owner" can disagree — a direct violation of §3.1 and §4.1 of the ownership design.

### 4.4 Losing the lease means stopping

The only legal way for the owner record to change under a running owner is a formal reconciliation transfer, which supersedes that owner. Since a superseded epoch loses execution authority (§6.3), a run that discovers it can no longer affirm its own lease must stop rather than continue as a second executor.

## 5. Data model

No new persisted artifact, but the owner record gains one field. Three fields matter:

- `lastAffirmedAt` — the ownership design's freshness anchor (§5.5), now actually refreshed. Every writer of the record sets it, as today;
- `leaseAffirmedAt: string | null` — **new**. Set *only* by the heartbeat of a process that is executing the run. `null` means "no live process has affirmed this lease";
- `currentProcessInstanceId` — the lease holder identity.

### 5.0 Why a second timestamp, and why it is not a second source of truth

`lastAffirmedAt` is written by three things that are not heartbeats: the initial record (`state.lastTransitionAt`, `src/controller/runLoop.ts:573`), an owner transfer, and a resume claim. Reading it as "a live process is executing" is therefore wrong, and reading it that way produces a concrete regression: immediately after a reconciliation transfer the record is seconds old and names the transfer's `newProcessInstanceId`, so a lease gate keyed on `lastAffirmedAt` would refuse the very resume that transfer authorized, for a full TTL. That is the common "reconcile, then resume" ordering.

Splitting the two meanings fixes it at the root:

| Field | Answers | Written by |
|---|---|---|
| `lastAffirmedAt` | when was ownership last asserted in writing | initial create, transfer, claim, and the heartbeat |
| `leaseAffirmedAt` | when did a *running* process last prove it is alive | the heartbeat only |

This does not violate §4.3. There is still exactly one record and one authority; what is removed is a single field carrying two different questions' answers. Every non-heartbeat writer sets `leaseAffirmedAt` to `null`, which is what makes the post-transfer state read correctly as "owned, but nobody is running it".

Records written before this change have no `leaseAffirmedAt`. A missing field reads as `null` — no lease — which is the safe direction and needs no migration.

Constants (module-level, not contract fields — no configurability until a later layer needs it):

- `LEASE_HEARTBEAT_INTERVAL_MS = 30_000`
- `LEASE_TTL_MS = 90_000` (≥ 3× the interval, so two consecutive missed refreshes do not expire a healthy run)
- `LEASE_AFFIRM_THROTTLE_MS = 10_000` (event-driven refreshes closer together than this are skipped)

A lease is **fresh** when `leaseAffirmedAt` is non-null and `now - Date.parse(leaseAffirmedAt) < LEASE_TTL_MS`. A `null` `leaseAffirmedAt` is not an expired lease — it is **no lease at all**, and carries no observation to record.

`isLeaseFresh` is a **total function on a validated record**: the gate validates the record first (§7) and refuses a malformed one outright, so an unparseable `leaseAffirmedAt` never reaches the predicate in production. The predicate still answers "not fresh" for such input as a defensive default, and §12.1 pins that, but this is a belt-and-braces answer — it is *not* the rule that governs malformed records. That rule is §7's: malformed means refused, not "no lease here". Keeping the two straight matters, because "not fresh" and "refused" lead to opposite outcomes.

### 5.1 Process instance identity must not be reusable

The lease holder is identified by `currentProcessInstanceId`, today `pid:${process.pid}` (`src/controller/runLoop.ts:573`, `src/controller/resumeLoop.ts:111`). Operating systems recycle PIDs, so an unrelated later process can be handed the same number. It would then meet a still-fresh lease reading `pid:4242`, match it as "held by me", and proceed — defeating the one guarantee L1 offers.

L1 therefore extends the identity with a component that is not reusable within a TTL: `pid:<pid>:<processStartMs>`, where `processStartMs` is this process's start time in epoch milliseconds.

The field stays opaque and is only ever compared for string equality, so this is behavior-compatible with records written in the old format: an old-format record can never equal a new-format identity, so it can never be mistaken for "held by me". Such a record also predates `leaseAffirmedAt`, so it reads as carrying no lease at all and takes §7's no-lease branch rather than the fresh-or-expired ones. Either way the identity mismatch can only add refusals, never permissions. Historical artifacts are not rewritten.

## 6. Heartbeat writers

Two independent paths refresh the same field through the same code path, because either one alone has a blind spot:

1. **Wall-clock timer** — an interval timer inside the run process, `unref()`ed so it never keeps the process alive. It carries the lease across a single long Claude call, which no phase-boundary signal can do.
2. **Event-driven refresh** — the same affirm call at attempt boundaries and adapter frame boundaries. It survives environments where the timer is unreliable or the timer-carrying work is killed, and it additionally evidences that the loop is making progress rather than merely being alive.

Both call one `affirmNow()`, throttled by `LEASE_AFFIRM_THROTTLE_MS` so the two paths cannot thrash the owner-transfer lock.

The affirm write is a compare-and-swap against the persisted owner record, performed under the existing `acquireOwnerTransferLock` critical section and reusing the existing interrupted-transfer recovery path. Refreshing advances `leaseAffirmedAt` and, so that the ownership design's named anchor stops being dead (§1), `lastAffirmedAt` alongside it. It never rotates an epoch, never changes `ownerStatus`, and never touches `supersededByEpoch`. The heartbeat is the **only** writer of `leaseAffirmedAt` to a non-null value; every other writer of the record sets it to `null` (§5.0).

One consequence of reusing that path is worth stating, because it looks like a bug to anyone who meets it cold: since every affirm runs `recoverInterruptedOwnerTransfer` under the lock, a heartbeat can itself finalize a transfer that was interrupted mid-flight — including the transfer that supersedes it. The process then fails its own CAS on the very next step and stops per §8. That sequence is correct, not a race: finalizing a durably-staged transfer is the recovery behavior the existing code already guarantees on any locked path, and the loser stopping is exactly the intended outcome.

A heartbeat failure that is **not** a precondition failure (lock contention, transient I/O) is swallowed and retried on the next tick. It must never throw into the control loop.

### 6.0 Lifecycle

The heartbeat starts immediately after the gate has admitted this process and the owner record naming it is on disk — in `runLoop` after `writeOwnerRecord`, in `resumeLoop` after the CAS claim — and never before, so it can never affirm a lease this process does not hold.

`stop()` must run on **every** exit path: normal completion, stop-boundary exit, and any thrown error. The implementation wraps the loop body in `try/finally` for exactly this reason. `unref()` prevents the timer from holding the process open; it does **not** substitute for `stop()`, because a run can end long before its process does.

**`stop()` also releases the lease**, and this half is not optional. Cancelling the timer leaves `leaseAffirmedAt` frozen at its last value, so for up to one TTL a run that has already finished still reads as "somebody is running this" and refuses the next legitimate process. `stop()` therefore performs one final CAS setting `leaseAffirmedAt` back to `null` — the run is still owned, just no longer running, which is precisely the state §5.0 introduced the field to express.

The release is best-effort. If the CAS fails or the write errors, `stop()` swallows it and the lease simply ages out; a process that was killed never gets to release at all, which is the case the TTL exists for. Graceful exit releases immediately; everything else waits out the TTL.

### 6.1 The expected record rotates on every successful affirm

Each successful affirm changes `lastAffirmedAt`, so the record the heartbeat compared against is stale the moment it succeeds. The handle therefore replaces its expected record with the one `affirmOwnerLease` returns, every time. A heartbeat that keeps comparing against its start-of-run record would fail its own second CAS roughly one interval in, and — under the naive reading of §8 — would stop a perfectly healthy run.

This also fixes the criterion for §8. A failed CAS is **not** by itself proof of supersession; it only means the persisted record is not the one this process last wrote. Supersession is concluded only after re-reading the record and finding that it no longer names this process at this epoch (`currentOwnerEpoch` changed, `supersededByEpoch` set, or `currentProcessInstanceId` is someone else). Anything else — including a record that differs for reasons this process cannot explain — is a transient failure per the paragraph above, retried on the next tick.

## 7. Acquisition gate

The gate runs as early as possible, with one ordering constraint: it must not precede `initializeRunFiles`, because it may need to append an event and the events file does not exist before that call. In `runLoop` the current order is `buildInitialOwnerRecord` → `initializeRunFiles` → `writeOwnerRecord` (`src/controller/runLoop.ts:732-734`), so the gate belongs between the second and third of those. In `resumeLoop` the run directory already exists, so the gate goes immediately after the opening `resume_requested` event (`src/controller/resumeLoop.ts:83`) and before every read the eligibility gate performs.

### 7.0 Only `resumeLoop` reaches the interesting branches

`initializeRunFiles` begins with `ensureFreshRunDir`, which throws if `loop-contract.json`, `loop-state.json`, or `events.jsonl` already exists — V1 refuses to reinitialize an existing automated run (`src/persistence/fileStore.ts:48-61`, `:72-78`). A `runLoop` start therefore always operates on a directory that has just been created empty, so the gate placed after it can only ever observe "no owner record".

The consequence is worth stating so nobody implements unreachable code: in `runLoop` the gate is a single ENOENT check and nothing more. Every other branch below — a live lease held by someone else, an expired lease, a malformed record — is reachable **only** through `resumeLoop`. The gate is described once, for both call sites, but only one of them exercises it.

The gate reads the owner record **raw** — no `recoverInterruptedOwnerTransfer`, see the refusal-purity note below — and branches:

- the owner-record file does not exist (`ENOENT`, and only `ENOENT`) → a brand-new run directory, so there is no lease; proceed, and the record `runLoop` already creates establishes the first one. Any other read failure — malformed JSON, unreadable file, a record missing required fields — is **refused**, never treated as "no lease". `readOwnerRecordRaw` is a bare `JSON.parse` plus a type assertion (`src/persistence/fileStore.ts:371-373`), so it accepts a structurally invalid record silently; the gate must therefore validate the fields it depends on itself. `currentProcessInstanceId` and `currentOwnerEpoch` must be present and well-formed or the record is refused. `leaseAffirmedAt` is the exception: **absent means `null`** — an older record predating this design, carrying no lease (§5.0) — while a value that is present but neither a string nor `null` is malformed and refused;
- an owner record exists but `leaseAffirmedAt` is `null` → nobody is running this run. There is no lease, so the gate takes no position and records nothing. **This is the post-transfer state**: a run that reconciliation has just handed to a new owner is owned but not running, and its resume must not be refused (§5.0);
- an owner record exists, its lease is fresh, **and** `currentProcessInstanceId` is not this process → refuse with a distinct `RunLeaseHeldError` naming the holder and the remaining TTL;
- the lease is expired → **L1 takes no position**. Expiry neither permits nor refuses: control passes unchanged to the gates that already exist (for `resumeLoop`, the published-transfer eligibility gate; for `runLoop`, whatever it does today). L1 only appends a `lease_expired_observed` event so the expiry is visible to later layers instead of being silently swallowed;
- the lease is fresh and held by this process → proceed. `resumeLoop` takes the lease inside the owner-record claim it already performs, which already writes `currentProcessInstanceId` and `lastAffirmedAt`; no second write is added.

Making expiry *permit* anything would mean an unproven owner loss had authorized a de-facto takeover, contradicting §4.1 and the ownership design §7.2. Making expiry *refuse* would be equally wrong: after a reconciliation transfer, the new owner's record ages normally, so a legitimate resume hours later always meets an expired lease and must not be blocked by it.

`loop-worktree` (`reference/loop-engineering/tools/loop-worktree/README.md:96-99`) reaches the same conclusion from the other direction: an orphaned lock is *reported* by `locks --sweep` and deleted only under `--force`, never reclaimed automatically. The `lease_expired_observed` event is ccloop's equivalent of that report.

### 7.1 What "refusal changes nothing" actually means

A refusal introduces **no new** state mutation: no run-state write, no owner-record write, no worktree change. Two pre-existing behaviors are explicitly outside that claim, and stating them is the point of this subsection:

- **Events are appended.** `resumeLoop` already appends `resume_requested` before it reads anything (`src/controller/resumeLoop.ts:83`) and `resume_denied` on every refusal, and this design adds `lease_expired_observed`. A refused run directory is therefore never byte-identical to its prior state; only its non-event contents are.
- **Reading the owner record through `readOwnerRecord` is not side-effect-free.** It first runs `recoverInterruptedOwnerTransfer`, which may finalize a pending transfer or clean up staging files — both writes (`src/persistence/fileStore.ts:537-556`). The lease gate therefore uses the raw read, so that a refusal never triggers crash recovery as a side effect. Recovery remains where it already is: on the paths that go on to claim or transfer.

In `resumeLoop` the lease check runs **before** the eligibility gate and before the owner-record claim, so a live lease refuses earlier and more cheaply than any eligibility reasoning.

The lease gate is an additional refusal, layered on top of — never in place of — the existing eligibility gate and CAS precondition. A run that passes the lease gate still faces both.

## 8. Losing the lease mid-run

When an affirm fails its CAS precondition, the heartbeat re-reads the record and applies the §6.1 criterion. Only if the record no longer names this process at this epoch is the process superseded. The run then:

1. appends a `lease_lost` event recording the observed and expected owner records;
2. stops at the next phase boundary with `stopReason = "lease_lost"`, launching no further attempt;
3. leaves the newer owner's record untouched.

Both `RunEvent.type` and `RunState.stopReason` are free-form strings today, so neither addition requires a type change. Only a confirmed supersession triggers this path; a bare CAS failure does not (§6.1), and transient failures are handled per §6.

Stopping happens at a phase boundary rather than mid-attempt so the run never tears down state a new owner might be reading. This is the only runtime behavior change L1 makes to `runLoop`.

### 8.1 Re-check before every side effect

A phase boundary can be minutes wide, so the lease is additionally re-checked immediately before each side-effecting step — launching a Claude call, writing attempt artifacts, and mutating or removing a worktree. This narrows the window in which a superseded owner can still act from one phase to one side effect.

DoWhiz applies the same shape to its `thread_epoch`, re-checking it before each outbound action rather than only at claim time (`reference/DoWhiz/DoWhiz_service/scheduler_module/src/scheduler/actions.rs:797`, `:857`).

Its default must be inverted. `thread_epoch_matches` fails **open** in two places — a task without an epoch proceeds, and an unreadable state file proceeds (`actions.rs:402-412`). ccloop's re-check fails **closed**: if the owner record cannot be read, or cannot be confirmed to still name this process at the current epoch, the side effect does not happen. Borrow the shape, invert the default.

What happens after a blocked side effect is fixed, not left to the implementer:

- the side effect is skipped, and the current attempt is **abandoned in place** — no further side effect of that attempt is attempted, including its worktree cleanup;
- the run stops at the next phase boundary, with the stop reason determined by the table below — `lease_lost` only when supersession has actually been concluded, `lease_unverifiable` otherwise;
- no new attempt starts either way.

Abandoning rather than unwinding is deliberate. Cleanup is itself a side effect on a worktree the new owner may already be reading, and this process has just lost the authority to touch it. The residual worktree is left for the new owner, whose resume path already performs best-effort cleanup of residual worktrees before continuing (`src/controller/resumeLoop.ts`, `cleanupResidualWorktrees`).

A re-check has three outcomes, and only the first two abandon the attempt:

| Outcome | Side effect | Attempt | Stop reason |
|---|---|---|---|
| Record reads cleanly and names someone else at this epoch | skipped | abandoned | `lease_lost` |
| Record cannot be read or validated, after a bounded retry | skipped | abandoned | `lease_unverifiable` |
| Transient failure that clears within the retry budget | proceeds | continues | — |

Row one is the same criterion the heartbeat applies in §6.1 — a clean read showing a different epoch, a set `supersededByEpoch`, or a different process instance — evaluated by whichever mechanism observes it first. The re-check is not a second, weaker way to conclude supersession; it applies the identical test, and either mechanism reaching that conclusion is sufficient.

`assertHeld` reads the persisted record **every time it is called**. It is not subject to `LEASE_AFFIRM_THROTTLE_MS`, and it caches nothing — a throttled or cached re-check would silently degrade "fail closed before every side effect" into "fail closed at most once per throttle window", which is not the same guarantee. The throttle exists to keep the two *writers* of §6 from thrashing the lock; `assertHeld` is a raw read (§7.1) and takes no lock, so nothing is saved by skipping it.

Row two is what "fail closed" buys: an unverifiable lease stops the run rather than letting it act unverified, and it deliberately does **not** claim supersession — hence the separate reason. No owner record is written on either abandoning path.

### 8.2 What this does not protect

The lease is keyed to a run, so it serializes executors of the *same* run only. Two different runs targeting the same repository are not mutually excluded by L1 — see §2.

`loop-worktree` keys its advisory lock on path globs precisely so that it also catches cross-task collisions (`reference/loop-engineering/tools/loop-worktree/README.md:85`). Adopting anything of that shape belongs to L2 or L4, once more than one run can be in flight at a time.

## 9. Freshness inside `evaluateOwnership`

`OwnershipEvaluationInput` gains one **required** field: `leaseFresh: boolean | "unknown"`.

Required, not optional-with-a-default. An optional field would make "I forgot to pass it" indistinguishable from "I looked and could not tell", and that distinction is the whole content of §4.2. The cost is real and belongs in the implementation plan: every existing construction site and test fixture must be updated to pass `"unknown"` explicitly before this compiles.

Its value is derived from `leaseAffirmedAt`, never from `lastAffirmedAt` — the same distinction §5.0 draws, for the same reason: only the former means "somebody is actually running this".

- `true` → the owner has a live counter-claim: the verdict must not be `OWNER_LOST` and `takeoverAllowed` must be `false`;
- `false` / `"unknown"` → every existing verdict path is unchanged, byte for byte.

Existing callers pass `"unknown"` until L3 supplies a measured value. This containment is what makes wiring freshness in now a zero-regression change.

### 9.1 This field has no production supplier in L1 — deliberately

Stated plainly, because it is the same shape of defect §1 diagnoses in `lastAffirmedAt`, merely inverted: that field was written and never read; this one is read and, within L1, never supplied with a real value. Every L1 caller passes `"unknown"`, so §7.1 condition 1 of the ownership design becomes *evaluable* here but is not yet *evaluated*.

The alternative was considered and rejected. Reconciliation already holds the owner record when it calls `evaluateOwnership`, so computing real freshness there costs nothing — but it would change live verdicts (strictly toward refusal) in the same change that introduces the mechanism, forfeiting the regression fence in §12. Freshness is measurable evidence; deciding *with* it is L3's job, and L3 is where the first real supplier appears.

The honest summary: L1 ships plumbing, and the test suite must pin it as plumbing (the regression fence in §12) rather than pretend it changes behavior.

## 10. Clock and failure modes

| Situation | Effect | Why it is safe |
|---|---|---|
| Machine sleeps / suspends | lease looks expired | expiry authorizes nothing; worst case is more suspicion and more refusal |
| Clock skew across machines | lease looks expired or fresh early | fresh-too-long only adds refusals; expired-too-early **degrades mutual exclusion** — see §10.1 |
| Graceful exit (normal, stop-boundary, or throw) | `stop()` clears `leaseAffirmedAt` to `null` | the next process sees no lease immediately, not after a TTL (§6.0) |
| `SIGKILL` of the run process | no release happens; last heartbeat ages out | this is the case the TTL exists for; after it the lease stops refusing, and takeover still requires full reconciliation |
| Timer starved or killed | event refresh carries the lease | and vice versa — the two paths cover each other |
| Lock contention with a concurrent transfer | affirm retries next tick | affirm is never on the critical path of correctness |

### 10.1 The lease is not the hard guarantee

The row above understates one case, so it is stated in full here. If the holder's clock runs more than a TTL behind the checker's, the checker always sees an expired lease, never refuses, and mutual exclusion — L1's only promise — silently stops working.

That is survivable because the lease is not what ultimately prevents two executors. It is a cheap, early, best-effort refusal. The clock-independent guarantee is:

- **whichever process no longer holds the record discovers this at its next affirm and stops** (§6.1, §8). This holds on every path.

A weaker statement is often assumed here and is **false**, so it is written out: it is *not* true that the owner record is always claimed by CAS. `resumeLoop` claims by CAS, but a fresh `runLoop` start writes the record unconditionally — `writeOwnerRecord` is a plain overwrite with no precondition (`src/persistence/fileStore.ts:379-381`), called at `src/controller/runLoop.ts:734`.

What normally stops a second `runLoop` on the same directory is not that write but `ensureFreshRunDir`, which throws once the first run's files exist (§7.0). That check is a test-then-write sequence, not an atomic create, so a narrow TOCTOU window remains: if two starts both pass the existence check before either writes, both proceed, and the second `writeOwnerRecord` silently overwrites the first.

The window is milliseconds wide and the common case fails loudly, but "narrow" is not "closed". What contains it is the heartbeat: within one interval the loser's affirm fails, it re-reads, finds an identity that is not its own, and stops. So on the fresh-start path exclusion is best-effort and the single hard guarantee is the heartbeat. Closing the window properly (an atomic exclusive create) is a real improvement, deliberately **not** in L1's scope, and noted here so a later layer picks it up knowingly rather than discovering it.

An implementer must not "strengthen" the lease into something the rest of the system relies on for correctness.

### 10.2 Why this is not a visibility timeout

The common queue-lease pattern makes expiry self-healing: DoWhiz's ingestion queue reclaims any row whose `status = 'processing' AND locked_at < now() - lease_secs` and hands it to another worker (`reference/DoWhiz/DoWhiz_service/scheduler_module/src/ingestion_queue.rs:314-316`). Expiry there *is* authorization to take over.

That is sound for idempotent message delivery and wrong for ccloop, where one attempt mutates a repository, spends money, and cannot be replayed harmlessly. It is exactly what the ownership design §7.2 rules out. This subsection exists so a future implementer who recognizes the familiar pattern does not "fix" ccloop back into it.

## 11. Interfaces

```ts
// src/ownership/lease.ts (pure)
export const LEASE_HEARTBEAT_INTERVAL_MS: number;
export const LEASE_TTL_MS: number;
export function isLeaseFresh(record: OwnerRecord, nowMs: number, ttlMs: number): boolean;
// §7: validates the fields the gate depends on; a structurally invalid record is a
// refusal, never a "no lease here".
export function parseOwnerRecordForLease(raw: unknown): OwnerRecord;
export class RunLeaseHeldError extends Error {}
export class RunLeaseUnverifiableError extends Error {}

// src/persistence/fileStore.ts
// Raw read for the gate: no recoverInterruptedOwnerTransfer, so a refusal cannot
// trigger crash recovery as a side effect (§7.1).
export async function readOwnerRecordWithoutRecovery(runDir: string): Promise<OwnerRecord>;
// Returns the record it just wrote — the caller MUST adopt it as its next expected
// record (§6.1). Throws OwnerTransferPreconditionError on CAS mismatch, which by
// itself does not mean superseded.
export async function affirmOwnerLease(
  runDir: string,
  expected: OwnerRecord,
  nowIso: string,
): Promise<OwnerRecord>;

// src/controller/leaseHeartbeat.ts
export function startLeaseHeartbeat(options: {
  runDir: string;
  ownerRecord: OwnerRecord;
  onLeaseLost: (error: unknown) => void;
  now?: () => number;
}): {
  affirmNow: () => Promise<void>;
  // §8.1 pre-side-effect re-check; rejects when the record cannot be read or no
  // longer names this process at this epoch — fail-closed, unlike DoWhiz's fail-open
  // thread_epoch_matches.
  assertHeld: () => Promise<void>;
  stop: () => Promise<void>;
};
```

## 12. Testing requirements

1. **Pure predicate** — boundary values at exactly TTL, backwards clock, a `null` `leaseAffirmedAt` (no lease, not an expired one), and the defensive "not fresh" answer for an unparseable `leaseAffirmedAt`. The last case pins §5's belt-and-braces default only; the *governing* rule for malformed records is refusal, covered by the "corrupt record is refused" requirement below.
2. **Recycled PID is not mistaken for self** — a fresh lease held by `pid:4242:<earlier start>` does not match a checking process that is also PID 4242 but started later; the gate refuses (§5.1). A record in the legacy `pid:4242` format likewise never matches.
3. **Second `runLoop` on an occupied directory fails loudly** — it throws from `ensureFreshRunDir` rather than reaching the lease gate at all (§7.0). The TOCTOU window of §10.1 is documented but not simulated: no test may assert that two concurrent starts both proceed, because the ordinary outcome is the throw.
4. **Heartbeat under fake timers** — refreshes repeatedly across a TTL window; `stop()` ends all writes.
5. **The heartbeat survives its own writes** — at least three consecutive affirms succeed with no external interference, proving the expected record rotates per §6.1. Written to fail against the naive implementation, which stops the run one interval in.
6. **Mutual exclusion** — a second `resume` against a live-lease run is refused, and the run directory is unchanged **except for appended events** (§7.1): owner record, run state, and worktrees compare byte-identical, and no interrupted-transfer recovery ran.
7. **Corrupt record is refused, not mistaken for absent** — separate cases for a missing file (proceeds), malformed JSON, and a structurally valid JSON object missing `currentProcessInstanceId` or carrying a non-string `leaseAffirmedAt` (both refused). The third case is the one `readOwnerRecordRaw` accepts silently.
8. **Lease loss** — an externally rotated owner record causes the running loop to stop at the next phase boundary with `stopReason = "lease_lost"`, start no further attempt, and leave the new owner record intact. The rotation is performed by the test writing the file directly; no production path rotates a record this way, and the test must not be read as evidence that one exists.
9. **Blocked side effect abandons rather than unwinds** — after a re-check fails, the attempt performs no further side effect *including worktree cleanup*, and the residual worktree survives for the next owner (§8.1). An unverifiable-but-not-superseded record stops with `stopReason = "lease_unverifiable"` and writes no owner record.
10. **Regression fence** — every existing `evaluateOwnership` case is asserted to produce an identical verdict under `leaseFresh: "unknown"`; only `leaseFresh: true` adds new cases, all of which block `OWNER_LOST` or takeover. Per §9.1 no production caller supplies `true` in L1, so this fence is what keeps the field honest until L3.
11. **Expiry authorizes nothing** — an expired lease alone does not make any previously-denied resume or takeover succeed.
12. **Expiry refuses nothing** — a resume that is legitimately eligible (published transfer, matching epoch) still succeeds when the owner record's lease has aged out, and a resume that is ineligible is refused with the *eligibility* reason, never a lease reason. A `lease_expired_observed` event is present in both cases.
13. **Fail-closed re-check** — when the owner record is unreadable or names a different process, the next side effect (Claude call, artifact write, worktree mutation) does not happen. Asserted per side-effect kind, not once generically.
14. **Gate ordering** — a `runLoop` start against a brand-new run directory does not attempt to append an event before `initializeRunFiles` (§7).
15. **A resume immediately after a transfer is not refused** — with the owner record freshly written by an owner transfer (seconds old, naming the transfer's `newProcessInstanceId`, `leaseAffirmedAt: null`), a resuming process with a different identity proceeds. This is the regression the single-timestamp design would have caused (§5.0); it must be asserted at a lease age well *inside* the TTL, since the existing expiry test only covers the aged-out case.
16. **Only the heartbeat writes `leaseAffirmedAt`** — after an initial `runLoop` record write, an owner transfer, and a resume claim, the field is `null` in all three; it becomes non-null only once the heartbeat has run. A record persisted without the field at all reads as `null`.
17. **A finished run releases its lease** — after the loop returns, and separately after it throws, `leaseAffirmedAt` is back to `null` and a subsequent legitimate `resume` proceeds *immediately*, not after a TTL. Asserted while the last heartbeat is still well inside the TTL, so an implementation that only cancels the timer fails it (§6.0).
18. **A killed run does not release, and that is fine** — with `stop()` never called, the lease stays fresh until the TTL elapses and refuses in the meantime; after it, the gate takes no position and the existing eligibility rules decide.
19. **`assertHeld` is never throttled** — two side effects less than `LEASE_AFFIRM_THROTTLE_MS` apart each read the record, and a record rotated between them blocks the second (§8.1). Written to fail against an implementation that reuses the affirm throttle.

Every test uses `ScriptedAdapter`. No paid Claude call is permitted by this work.

## 13. Success criteria

An implementer can answer all of the following from this document without inventing policy:

- what makes a lease fresh, what `null` means, and how that differs from expired;
- which writers refresh it, why both exist, and how they avoid thrashing;
- who releases a lease, when release is immediate, and when it can only age out;
- exactly what a live lease refuses, and what an expired lease permits (nothing);
- what a running owner must do when it can no longer affirm its lease;
- how freshness enters `evaluateOwnership` without changing any existing verdict;
- why expiry is neither permission nor refusal, and what is recorded when it is observed;
- why a failed CAS is not by itself proof of supersession, and what is;
- what a refusal may still change on disk, and why the gate reads raw;
- what happens to the attempt, the worktree, and the stop reason when a pre-side-effect re-check fails;
- which layer (L2–L5) each deferred concern belongs to.
