# Resume / Adopt Continuation Design

> Status: proposed on 2026-07-25
> Scope: define how an eligible-for-continuation run is reconstructed from persisted state and safely continued under a validated current owner epoch, strictly consuming an already-published takeover eligibility. This design does not perform ownership judgment or takeover.
> Parent design: [`2026-07-22-ownership-and-reconciliation-boundaries-design.md`](2026-07-22-ownership-and-reconciliation-boundaries-design.md) — this is its Section 17.1 follow-on ("Resume / adopt design").
> Related prior design: [`2026-07-21-stop-no-progress-stale-boundaries-design.md`](2026-07-21-stop-no-progress-stale-boundaries-design.md)
> Reference inputs (patterns mined, see §11): `reference/loop-engineering/`, `reference/DoWhiz/DoWhiz_service/`

## 1. Goal

Given a run whose ownership layer has already published a successful owner-epoch transfer (`eligibleForContinuation: true`), reconstruct that run's state from controller-owned persisted artifacts and let the loop continue from the next attempt — or refuse loudly when the eligibility is not present, not current, or not coherent.

This design answers exactly one question left open by the ownership/reconciliation design (its §13, §17.1): *how does an eligible run actually resume under a valid new owner epoch?*

## 2. Non-Goals

This design does **not**:

- perform takeover or ownership judgment — takeover authority remains solely with reconciliation, deny-by-default (unchanged);
- implement scheduler, daemon, queue, or "who triggers resume" policy;
- implement lease, heartbeat, TTL-based staleness, or multi-resumer race arbitration — resume assumes a **single caller** (operator-initiated);
- salvage an interrupted in-flight step (no reconstruction of an interrupted Claude subprocess; `claudeChildExited` remains `NOT_OBSERVABLE`);
- refresh or reset budget;
- clean up superseded/orphaned workspaces beyond the best-effort cleanup of one interrupted attempt (broad orphan GC is the §17.3 cleanup spec);
- rewrite accepted historical evidence or change the `D-01` verdict.

## 3. Relationship to the Ownership / Reconciliation Layer

Resume is a strict **consumer** of the ownership layer, never a producer of ownership truth.

- The only path to continuation eligibility is a reconciliation-granted owner-epoch transfer that already wrote `owner-transfer.json` with `eligibleForContinuation: true` and rotated `owner-record.json` to the new epoch.
- There is **no same-epoch fast path**: an ordinary same-process crash-restart must still obtain eligibility through reconciliation (which rotates the epoch) before resume will act. This keeps a single, uniform, deny-by-default gate.
- `eligible-for-continuation` means "a new valid owner epoch exists and a resume layer may decide whether to continue." This design is that decision layer; it grants nothing new.
- **Eligibility is a standing property of the current owner epoch, not a one-shot token.** It is *re-claimable*: while the epoch published by the transfer is still current and un-superseded, resume may act on it repeatedly — a run that crashes again after being resumed can be resumed again against the *same* transfer, without a fresh reconciliation. A newer reconciliation rotates the epoch and, by the §5.3 fence, retires the old eligibility. This is safe because each resumed attempt consumes attempt/budget, so repeated resumes converge on a terminal state rather than looping forever.

## 4. Entry Model

Surgical, additive; the existing fresh-start `runLoop` semantics are unchanged.

- Add an exported `resumeLoop(runDir, adapter)` and a CLI `resume` subcommand.
- The contract is read back from the persisted `loop-contract.json`; it is **not** re-supplied by the caller. Resuming with a different contract than the one the run was initialized with is out of scope.
- The `while (true)` loop body of the current `runLoop` is extracted into an internal shared function `runLoopFromState(contract, runDir, adapter, state)`:
  - `runLoop` keeps its fresh prologue (`initialState` → `buildInitialOwnerRecord` → `initializeRunFiles` → `writeOwnerRecord`) and then delegates to `runLoopFromState`.
  - `resumeLoop` performs the gate (§5) and claim (§6), reconstructs `state` from disk (§7), and then delegates to the same `runLoopFromState`.
- The extraction **must be behavior-preserving**, guarded by the existing full test suite (currently 243 tests). No control-flow change to the loop body is authorized by this design.

## 5. Eligibility Gate (Strict Consume)

`resumeLoop` reads back `owner-record.json`, `owner-transfer.json`, `reconciliation-record.json`, and `loop-state.json`. Reading `owner-record.json` goes through the existing `readOwnerRecord`, which first runs `recoverInterruptedOwnerTransfer` — a half-written transaction is finalized before the gate reads it.

All of the following must hold; if **any** fails, resume refuses (§9):

1. `owner-transfer.eligibleForContinuation === true`.
2. Reconciliation coherence: `reconciliation-record.eligibleForContinuation === true`, `ownershipVerdict === "OWNER_LOST"`, and `reconciliation-record.newOwnerEpoch === owner-transfer.newOwnerEpoch`.
3. **Supersede fence (R1)**: `owner-record.currentOwnerEpoch === owner-transfer.newOwnerEpoch` **and** `owner-record.supersededByEpoch === null`. Any owner epoch newer than the published transfer, or a set `supersededByEpoch`, means the eligibility has itself been superseded — refuse with that reason. (Borrowed as a strict `newer-wins` fence; see §11.)
4. `owner-record.ownerStatus === "current"`.
5. `loop-state.status` is in the resumable whitelist (§8).

The gate makes **no new ownership decision or write**. The one exception is not a resume action: reading `owner-record.json` via `readOwnerRecord` may finalize an already-staged, interrupted owner-transfer transaction (`recoverInterruptedOwnerTransfer`) — the idempotent completion of a transfer reconciliation already decided, never a fresh judgment. Aside from that recovery, the gate only reads; it mirrors the reconciliation read/verdict/transfer split — resume gates, then claims, but never repairs.

## 6. Claim (Adopt) — Compare-and-Swap Re-Affirmation

Once the gate passes, resume **claims** the run for the current process. This is a process-instance update *within the already-eligible epoch* (allowed by ownership design §6.1: process churn keeps the epoch); it grants no new authority — the epoch rotation that granted authority already happened at transfer time.

The claim writes an `owner-record.json` with:

- `currentProcessInstanceId` = this process (`pid:<pid>`, charset-validated on read);
- `lastAffirmedAt` = now;
- every other field, including `currentOwnerEpoch`, unchanged.

**Last-moment re-verify (R2)**: the claim write is a compare-and-swap against the exact `owner-record` the gate read (reusing the existing `expectedOwnerRecord` precondition pattern from `writeOwnerTransferArtifacts`). If a concurrent transfer changed the persisted owner record between the gate read and the claim, the CAS fails and resume aborts — no lease or heartbeat required. This is the "re-verify ownership immediately before the irreversible action" pattern from the reference frameworks (see §11).

On a successful claim, append the `resume_adopted` audit event (§10) and proceed to §7.

## 7. Continuation Semantics

Resume trusts the persisted `loop-state.json` **verbatim**: `attemptsUsed`, `budgetSnapshot`, and `recentFailures` are taken as-is. Budget carries over per-run, independent of wall-clock (no calendar-day reset).

- The interrupted in-flight attempt is treated as **abandoned**. Resume does not read, salvage, or continue its partial artifacts.
- Continuation re-enters `runLoopFromState` so the loop opens a **fresh next attempt** (`attemptsUsed + 1`) with its own new worktree. Attempt numbering never collides with the abandoned attempt.
- The abandoned attempt's residual worktree, if any, is cleaned **best-effort**: resume locates residual worktrees by scanning `runDir/worktrees/` (resume does not otherwise track the interrupted attempt's path) and cleans them via `cleanupAttemptWorkspaceBestEffort`. Failing to locate or remove a residual worktree is non-fatal and never blocks continuation, and the abandoned worktree's contents are never resumed.
- If persisted budget is already near-zero, resume adds no special case: the loop's existing `consumeAttemptBudget` / `hasBudgetExceeded` terminate the run naturally on the next attempt.

## 8. Resumable Status Whitelist

Resume proceeds only when `loop-state.status` is one of:

- `planning`, `executing`, `verifying`.

All other statuses are refused:

- terminal — `succeeded`, `failed`, `cancelled` — the run is finished;
- `exhausted` — budget is spent; resuming without refreshing budget (out of scope) would re-exhaust immediately;
- `blocked_waiting_human` — the run is explicitly awaiting a human; it is not an automated-continuation candidate.

`queued` is deliberately **excluded**: `initialState` starts a run at `queued`, but `runLoop` transitions to `planning` before the first persisted `loop-state.json` write, so `queued` is never observable on disk for a run that could need resuming. Admitting it would be speculative; if a future change makes `queued` reachable on disk, it can be added then with its own test.

This whitelist also provides natural idempotency: once a resumed run reaches a terminal status, a second `resumeLoop` invocation is refused by this gate.

## 9. Deny-by-Default and Failure Semantics

Resume fails loud and never degrades to a fresh start.

- **Missing or unparseable (R3)**: if any of `owner-record.json`, `owner-transfer.json`, `reconciliation-record.json`, or `loop-state.json` is absent or cannot be parsed, resume refuses. A missing record is never treated as "absent, therefore proceed" (the reference frameworks default fail-open here; ccloop inverts it), and corrupt ownership state is never auto-healed.
- **Gate failure**: any failed §5 condition, or a failed §6 CAS, throws a typed `ResumeNotEligibleError` carrying the specific reason, mutates **no** run state, and appends a `resume_denied` event.
- The CLI `resume` subcommand maps `ResumeNotEligibleError` to a non-zero exit code and prints the reason.
- No silent no-op: every refusal is observable in both the thrown error and the event log.

## 10. Audit Trail

Resume leaves an append-only, structured trail in `events.jsonl` (not free prose):

- `resume_requested` — resume was invoked for this run;
- `resume_denied` — with the specific gate/CAS failure reason;
- `resume_adopted` — with the consumed epoch and the `priorProcessInstanceId → newProcessInstanceId` claim.

This mirrors the reference pattern of emitting a distinct terminal outcome plus a human-readable reason on supersede/decline.

## 11. Borrowed Patterns (Provenance)

Patterns adopted from the reference frameworks, and what was deliberately left:

- **Strict `newer-wins` supersede fence** — DoWhiz `scheduler/executor.rs` epoch fencing (`current > expected`). Adopted as gate condition R1 (§5.3).
- **Last-moment epoch re-verify before the irreversible action** — DoWhiz `scheduler/executor.rs` pre-send re-check. Adopted as the claim-time CAS R2 (§6).
- **Deny-by-default on missing/corrupt ownership state** — inverts DoWhiz's fail-open `None ⇒ proceed`; reinforced by loop-engineering `tools/loop-worktree/src/lock.ts` corrupt-file-refuse and owner charset validation. Adopted as R3 (§9).
- **On-disk epoch record as sole ownership truth; trust persisted counters and start the next attempt fresh** — DoWhiz `thread_state.rs`, loop-engineering append-only ledger (`tools/loop-context`). Already the ccloop model; confirmed, not changed.
- **Reconstruct-from-persisted-context, abandon-on-supersede** — the safe half of DoWhiz `aci_recovery.rs`; its poll-in-flight-container-to-terminal salvage was **left** (contradicts §2's no-salvage rule).
- **Left entirely**: all TTL/lease/expiry auto-reclaim (loop-engineering `lock.ts` sweep, `--wait`), scheduler snapshot/cron, and calendar-day budget reset (loop-engineering `daily-spend.ts`) — these are the scheduler/lease/heartbeat territory this spec scopes out.

## 12. Testing Requirements

Tests must encode *why* each rule matters (intent, not just behavior).

**Gate refusal matrix** — each asserts the specific reason, and that no state was mutated:

- no `owner-transfer.json` / `eligibleForContinuation: false`;
- reconciliation incoherent (wrong verdict, or `newOwnerEpoch` mismatch);
- supersede fence fails (`currentOwnerEpoch` newer than transfer, or `supersededByEpoch` set) — asserting *"resume must refuse a superseded eligibility because takeover authority belongs to reconciliation, not resume"*;
- `ownerStatus !== "current"`;
- non-resumable status — one case each for `succeeded`, `exhausted`, `blocked_waiting_human`;
- missing/unparseable `loop-state.json` or owner artifacts (deny-by-default, not proceed).

**Claim CAS** — a concurrent owner-record change between gate read and claim causes the CAS to fail and resume to abort without continuing.

**Happy path** — a run dir with a coherent published transfer and a non-terminal `loop-state` at `attemptsUsed = N`, driven by a scripted adapter, asserts:

- continuation begins at attempt `N + 1`;
- the run reaches a terminal status;
- the owner record was claimed (`lastAffirmedAt` advanced, `currentProcessInstanceId` = resumer, epoch unchanged);
- a `resume_adopted` event was written.

**Behavior preservation** — the `runLoopFromState` extraction keeps the full existing suite green.

All test and scenario runs use `ECC_GATEGUARD=off DISABLE_OMC=1`. No paid Claude call is required; the scripted adapter exercises the whole path.

## 13. Success Criteria

This design succeeds if a later implementer can, without inventing new policy:

- reconstruct a run and continue it from the next attempt using only persisted controller-owned artifacts;
- state the exact, uniform precondition under which resume acts (a coherent, current, non-superseded published transfer) and refuse everything else loudly;
- explain why resume claims but never grants authority, and why it starts the next attempt fresh rather than salvaging the interrupted one.

## 14. Follow-On (Still Deferred)

Unchanged from the ownership design §17:

- **Scheduler / unattended execution** — when and by whom an eligible run is re-queued or resumed (lease, heartbeat, queue, multi-task coordination live here).
- **Cleanup / orphan handling** — how superseded or lost-owner workspaces and evidence are retained or reclaimed beyond resume's single best-effort attempt cleanup.
