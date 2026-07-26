# SDD ledger — plan: docs/superpowers/plans/2026-07-26-run-lease-and-heartbeat.md

Branch: worktree-l1-run-lease-heartbeat
Baseline before Task 1: fc73d96 (274 tests green, typecheck/build clean)

Task 1: complete (commits fc73d96..90b24f2, review clean — 0 findings)
Task 2: complete (commits 90b24f2..41d5fe3, review clean)
Task 2: minor (deferred): well-formed-record parse test overlaps the legacy-record test
Task 2: minor (deferred): RunLeaseLostError / RunLeaseUnverifiableError have no unit test pinning their stopReason literals (plan-mandated test list)
Task 2: minor (deferred): report says 5 isLeaseFresh tests, diff shows 4 (report inaccuracy only)
Task 3: complete (commits 41d5fe3..f955961, review clean)
Task 3: minor (deferred): comment does not note two same-PID processes starting in the same truncated ms would still collide
Task 3: minor (deferred): "different process -> different id" is only exercised by proxy (legacy-format literal), not literally
Task 4: complete (commits f955961..6807543, review clean)
Task 4: minor (deferred): lock->recover->read->CAS skeleton now duplicated a third time; claimOwnerRecordWithPrecondition could itself call updateOwnerRecordWithPrecondition (brief scoped this task to the write tail only)
Task 4: minor (deferred): "spread persisted not expected" is unfalsifiable by test while sameOwnerRecord compares JSON.stringify; implementation follows the letter, tests cannot pin it
Task 5: complete (commits 6807543..a65f212, review clean; reviewer independently verified the rename is byte-identical)
Task 5: minor (deferred): the live-lease guard's correctness silently depends on an invariant of evaluateOwnershipWithoutLease (takeoverAllowed true only ever paired with OWNER_LOST) that this task neither establishes nor asserts
Task 6: complete (commits a65f212..75b4d32, review clean)
Task 6: minor (deferred): lease_expired_observed detail says "expired at {leaseAffirmedAt}" but that is the affirmation instant, not the expiry instant (affirmedAt + TTL) — misleading to later log consumers
Task 6: minor (deferred): no test for a non-ENOENT, non-syntax read failure (e.g. EACCES); shares the generic rethrow path
Task 7: review found 1 Important (plan-mandated): post-transfer test is vacuous at this layer — no_lease branch is silent, so it passes whether or not the gate is wired
Task 7: human ruling: STRENGTHEN — keep the existing assertions (they pin the lastAffirmedAt keying regression), add a matched second half asserting a same-age LIVE lease held by another process IS refused
Task 7: fix round 1/5 dispatched (resumed implementer ad2358cc2c659c2b3)
Task 7: fix round 1/5 (1 addressed, 0 open — post-transfer test now paired with a same-age live-lease refusal; commits 3cd2cdd..52d52df)
Task 7: complete (commits 75b4d32..52d52df, review clean after 1 fix round)
Task 8: complete (commits 52d52df..05b9cbc, review clean; named risk "timing fix in an existing test" investigated and cleared — gate consumes one Date.now(), fake-timer sequence legitimately needed an extra tick)
Task 8: minor (deferred): explicit Date.now() third arg to checkRunLease is redundant (default param does the same) and the report's rationale for it is factually wrong
Task 9: review found 2 Important — (a) plan-mandated: unguarded appendEvent in concludeLeaseLost can escape as an unhandled rejection, violating "never throws into the control loop"; (b) implementer deviation: throttle timestamp captured before the CAS instead of after
Task 9: reviewer cleared the fake-timer test rewrite — the three rotating writes are still timer-driven, affirmNow() is only a throttled-no-op drain point; the non-rotating-expected trap stays pinned
Task 9: human rulings: (a) FIX — spec wins over the plan's omission, guard it and add a regression test injecting failure into the event-append path; (b) REVERT to the plan's ordering
Task 9: fix round 1/5 dispatched (resumed implementer ad37df051c6b22555)
Task 9: fix round 1/5 (2 addressed, 0 open — appendEvent + onLeaseLost each guarded, stop signal still fires on log-write failure; throttle ordering restored character-for-character to the plan; commits ec58f38..d47fd39)
Task 9: complete (commits 05b9cbc..d47fd39, review clean after 1 fix round)
Task 9: minor (deferred): onLeaseLost callback is now also try/catch-guarded, slightly beyond the finding text — disclosed, consistent with the module's contract
Task 9: minor (deferred): fix report prose claims nowIso is captured post-await, which is impossible for an argument; code is correct, prose is not
Task 10: review found implementation correct on all constraints; 1 Important on the TEST — "never throttled" test cannot fail against the likelier bug (assertHeld consulting the shared lastAffirmAtMs), because the timer never fires in it so that value stays -Infinity
Task 10: controller ruling (no human interrupt needed): STRENGTHEN — spec §12-19 says the test is "written to fail against an implementation that reuses the affirm throttle", and it is one of the human's standing "do not weaken" six; strengthening is the only option consistent with both
Task 10: fix round 1/5 dispatched (resumed implementer ad183256810c70652) — mutation evidence required: add the throttle check to assertHeld, prove the strengthened test fails, remove it
Task 10: fix round 1/5 (1 addressed, 0 open — priming affirm lands at T0, assertHeld calls at +0ms and +100ms, both inside the 10s throttle window; mutation evidence sound in BOTH directions: injected bug fails the new test and passes the old one; commits dda1e68..36c853c)
Task 10: complete (commits d47fd39..36c853c, review clean after 1 fix round)
Task 10: minor (deferred): describe("assertHeld") has no shared afterEach timer reset, so a synchronous throw in one test leaks fake timers into later tests in that block (observed as 3 collateral timeouts during the mutation run)
Task 11: complete (commits 36c853c..548d0f4, review clean; named risks A/B/C all cleared against live source — Date.now() insertion count matches the 3 new consumers exactly, no assertion value touched)
Task 11: minor (deferred): no negative test that a failed gate/CAS prevents startLeaseHeartbeat from being called; correctness rests on code order alone
Task 11: minor (deferred): split value/type imports of leaseHeartbeat in runLoop.ts could be one statement
Task 11: minor (deferred): the "releases the lease when the loop throws" test probably does not exercise a real throw (runLoopFromState converts adapter errors to a failed RunState); the finally-based assertion still holds, but the test is less differentiated than its name — inherited from the plan
Task 12: review found production change correct/minimal/well-placed; 1 Important — the retry-boundary check (Check 2) has ZERO coverage: leaseLoss.lost is still null when it runs, so the stop always comes from Check 1. Deleting Check 2 would not fail any test.
Task 12: controller ruling (no human interrupt): FIX — reachable without a production hook by calling runLoopFromState directly with a caller-held leaseLoss signal flipped inside the adapter's verify; two-sided mutation evidence required (delete only Check 2 -> new test fails, old test still passes)
Task 12: fix round 1/5 dispatched (resumed implementer a8fb9b53b382f93f3)
Task 12: DESIGN-LEVEL FINDING for the humans (not an L1 defect, confirmed by the reviewer against the code): both refresh paths funnel through one shared lastAffirmAtMs throttle gate, so for attempts faster than LEASE_AFFIRM_THROTTLE_MS (10s) the event-driven path degrades to a no-op and detection falls entirely to the 30s interval timer. spec §6 claims the two paths cover each other, specifically that the event path survives an unreliable timer — that redundancy does not hold in the fast-attempt regime. Affects L2/L3, which decide on owner freshness.
Task 12: fix round 1/5 (1 addressed, 0 open — new test reaches Check 2 deterministically via runLoopFromState's 6th param; re-reviewer confirmed stopReason/attemptsUsed are NOT decisive under the mutation (Check 1 catches it on iteration 2 with identical values), so the affirmNowCalls counter is necessary rather than lazy; commits 2c60717..5d51a1c)
Task 12: complete (commits 548d0f4..5d51a1c, review clean after 1 fix round)
Task 13: review (opus) verified all 21 guarded sites, all 5 exclusions, catch-site ordering, non-skippability, adapter cannot forge a lease stop, both beyond-brief judgement calls necessary, risk F benign today, and the reconciliation fixture change a CORRECT accommodation (old fixtures asserted a self-contradiction L1 forbids)
Task 13: 3 Important — (1) assertHeld sets superseded BEFORE throwing, which permanently gates the heartbeat's lease_lost event append, so a guard-concluded supersession can NEVER produce the event spec §8 step 1 requires — unreachable, not deferred; the observed identity lives only in RunLeaseLostError.message, which the stop-reason read discards; (2) post-terminal escape records nothing at all (no stopReason, no event) while the run reports succeeded/exhausted; (3) four re-fixtured reconciliation tests silently changed execution path, green for a different reason, nothing pins it
Task 13: controller ruling (no human interrupt; applies the human's Task 9 precedent that spec wins over a plan omission): FIX all three — emit-site choice left to the implementer with the tradeoff spelled out (assertHeld becomes a writer vs several emit sites in runLoop)
Task 13: fix round 1/5 dispatched (resumed implementer af6b826e3888b7162)
Task 13: minor (deferred): guard count double-counts createAttemptWorkspace (21 sites / 14 statements, not 22); per-attempt I/O estimate ~4x high
Task 13: minor (deferred): plan-phase and verify-phase Claude-call guards are unfenced by any test — deleting either breaks nothing
Task 13: minor (deferred): artifact-write and cleanup kinds are fenced by different tests than the report credits (all three new tests refuse at the execute guard)
Task 13: minor (deferred): isTerminalRunStatus encodes "has no successors" where the branch needs "can transition to cancelled" — equivalent today, diverges if a status gains successors excluding cancelled
Task 13: minor (deferred): task-12 test retains a fake-timer apparatus that no longer gates discovery
Task 13: minor (deferred): persistBoundaryAnalysis's second call site sits minutes downstream of its nearest guard (plan-mandated "and nowhere else"); it is also the write that creates risk F
Task 13: fix round 1/5 (3 addressed, 1 NEW open — commits cfde8b9..807f020). Emit site chosen: inside assertHeld, and it was forced not preferred — `expected` is closure state in startLeaseHeartbeat, so the runLoop-side option could never have produced the required both-sides artifact. Re-review confirmed: both sides on disk with exact-equality assertions, fast path still a pure read, append cannot throw out, lease_unverifiable distinct, runLoop.ts byte-identical.
Task 13: NEW Important from the fix diff — asymmetric exactly-once gate. assertHeld is not in the serializing queue, so it can interleave with an in-flight runAffirm; concludeLeaseLost appends with no !superseded check, so the same run can emit TWO lease_lost events, contradicting the fix's own exactly-once assertion. Unpinned by any test (the guard always concludes before a real timer tick in the suite).
Task 13: fix round 2/5 dispatched (resumed implementer af6b826e3888b7162) — gate must be checked BEFORE concludeLeaseLost sets superseded, or the heartbeat-first path stops emitting; interleaving test + mutation evidence required
Task 13: fix round 2/5 (1 addressed, 0 open — single shared concludeSupersededOnce gate, check before assignment, onLeaseLost deliberately outside it; re-review went further than the implementer's own claim: given the queue serialization onLeaseLost is never redundant, not merely harmless; commits 807f020..ffecc79)
Task 13: complete (commits 5d51a1c..ffecc79, review clean after 2 fix rounds)
Task 13: minor (deferred): the new interleaving test depends on real filesystem timing (one read beating an ~8-round-trip CAS chain) rather than a deterministic hook — sound reasoning, wide margin, but a theoretical flake risk under heavy CI I/O contention
ALL 13 TASKS COMPLETE. Full suite 347/347, typecheck and build clean.

=== FINAL WHOLE-BRANCH REVIEW (opus) — verdict: With fixes; 0 Critical, 4 Important, 5 Minor ===
Confirmed: central safety claim holds (no path grants authority); all six anti-wrong-implementation requirements genuinely pinned; backward compat real (legacy records exercised at 4 levels); regression fence stronger than the spec asked.
Final-1 (Important): OwnerTransferPreconditionError conflates lock-busy with CAS mismatch, so §6's "swallow contention" is unimplementable AND this branch introduced the first periodic contender for the transfer lock — a real owner transfer can now be silently dropped (writeOwnerTransferArtifacts loses the lock, runLoop treats it as "record moved on" and never retries). Reviewer recommends follow-up, not this branch.
Final-2 (Important): self-performed epoch transfer makes this process report ITSELF superseded — persists a FALSE lease_lost event (expected and observed identical) into the evidence stream L2-L4 consume, and leaks worktrees/attempt-1. Root cause is a SPEC defect (§4.4 does not model a running owner transferring to itself). Fix ~10 lines: add adopt(record) to LeaseHeartbeat, call it after persistOwnerTransfer. Dissolves the item15<->item16 coupling.
Final-3 (Important): runAffirm concludes supersession from an UNVALIDATED record (no parseOwnerRecordForLease), the opposite of assertHeld's rule — a wrong-shape record yields undefined epoch != expected -> false supersession. One-line fix.
Final-4 (Important): a superseded process can return succeeded and the CLI exits 0. Spec gap (§8.1 assumes every guard fires before a terminal decision). Reviewer: do NOT rewrite terminal state; amend spec. Fixing Final-2 removes the only path currently reaching it.
Q1 ANSWERED — MY PREMISE WAS WRONG: the throttle is a 10s floor on a shared timestamp, not suppression of one path. Events every 9s with a dead timer still affirm every 18s; neither path starves for more than one window. Detection latency from either path alone is ~interval+throttle = 40s, inside the 90s TTL. No code change needed. Amending the spec to name assertHeld is still worth doing because it is a STRICTLY STRONGER argument (un-throttled, no lock, every call, before every side effect).
Q2 ANSWERED: persistBoundaryAnalysis SHOULD be guarded — it is the largest side effect in the loop (runs recovery-on-read, writes boundary+reconciliation artifacts, can perform a full epoch transfer). Spec omission, not implementation deviation. Layer A is protected by the transfer CAS, but writeBoundaryArtifacts is not: a superseded process still writes reconciliation artifacts into a run it no longer owns. Follow-up.
Deferred minors triaged: items 2, 5, 17 CLOSED (already discharged); 3,4,6,7,11,12,13,18 fine to defer; 1, 9, 8 should be fixed now (all cheap); 10 sits between — 2 of 12 assertHeld sites deletable with the suite green; reviewer's fix: ONE table-driven test parameterised over which assertHeld call throws, fences all 12 at once.

=== FIX WAVE RE-REVIEW (opus) — all 6 addressed, 0 new Critical/Important, Ready to merge: YES ===
Independently verified by the controller: 23 files / 356 tests green, typecheck clean, build clean, tree clean, 23 commits on the branch.
PARKED (Minor residual, ruled non-blocking): adopt-vs-in-flight-affirm window. Between the transfer's finalize and the adopt call there are two awaits (lock release, appendEvent); a heartbeat tick landing there re-reads the finalized record, compares against the not-yet-adopted expected, and concludes a self-named lease_lost. Ruling: this is the ORIGINAL defect surviving in a few-ms window of a 30s cycle instead of on every self-transfer, and it fails toward STOPPING, not toward two executors. Narrowing it (adopt before the appendEvent, or routing the transfer through the heartbeat queue) is a follow-up.
PARKED: guard-site count is 14, not 12 — FIX 6 fences six, so eight remain unfenced. The substantive claim (both money-spending guards fenced) is correct; the count in the finding and both reports was wrong.
PARKED: namesSomeoneElse treats an absent supersededByEpoch as supersession (undefined !== null) while parseOwnerRecordForLease does not validate that field — a legacy record lacking it reads as a takeover. Fail-closed; settled deliberately in 832abdf.
PARKED: nextOwnerRecord in persistBoundaryAnalysis is written and never read. Pre-existing, untouched.
CONFIRMED NON-ISSUE: adopt does not reset the affirm throttle, so leaseAffirmedAt stays null up to 10s after a self-transfer — spec §5.0 explicitly requires the gate to take no position on the post-transfer state, so this is conformant.
TRACKED FOLLOW-UPS (not on this branch): (1) OwnerTransferLockBusyError to split lock-busy from CAS-mismatch — also widens the parked adopt race, pair them; (2) guard persistBoundaryAnalysis itself.
SPEC AMENDMENTS OWED (defects in the frozen spec, not the implementation): (a) §4.4/§8 must model a running owner transferring ownership to ITSELF; (b) §8.1 must name the post-terminal window and say what happens there; (c) §8.1's side-effect list should include persistBoundaryAnalysis; (d) §6's redundancy argument should name assertHeld as the un-throttled detection path — and the controller's earlier claim that the event path is starved was WRONG (the throttle is a shared 10s floor, not path suppression).
