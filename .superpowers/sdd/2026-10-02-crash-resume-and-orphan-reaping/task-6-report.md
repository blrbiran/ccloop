# Task 6 report — `resume` adopts a killed run

Author: Task 6 implementer (subagent), Orca session ece96b67, 2026-10-02.
Commits (on ccloop `main`, local only, not pushed):
- `188b9cd` feat(resume): adopt a killed run once its owner is confirmed dead and its orphans reaped
- `fdef708` docs(resume): erratum on the published refusal count now that resume refuses before adoption in three more places

## Implementation

`src/controller/adoptCrashedRun.ts` (new)
- `CRASH_ADOPTION_REASON = "owner process confirmed dead by resume"`.
- `isOrcaControlRunDir(runDir)`: `basename(runDir) === "run"` and `dirname(runDir)/control` is a directory.
- `adoptCrashedRun(runDir, ownerRecord, runState, deps?)`: status → boundary (`planning/executing/verifying` ⇒
  `planning/execute/verify`, else refuses); `classifyOwnerProcess(ownerRecord)`; non-`dead` ⇒
  `{ok:false, reason: "no owner transfer and the owner is <verdict>: <reason>"}`; `dead` ⇒
  `applyOwnerEpochTransfer(..., buildProcessInstanceId(), now, CRASH_ADOPTION_REASON)` + reconciliation exactly as
  spec §4.3 step 6, written through `writeOwnerTransferArtifacts` with the step-2 record as CAS expectation (lock/CAS
  errors thrown to the caller), then event `owner_crash_adopted`, detail
  `epoch <prior> -> <new>: <prior id> confirmed dead (<reason>)` plus
  `; replaced a reconciliation record that had no transfer` when one existed.

`src/controller/resumeLoop.ts`
- After the lease gate: Orca guard ⇒ `resume_denied` + `ResumeNotEligibleError("run directory belongs to an Orca control store; Orca recovers it")`.
- In the artifact-read `try`, after `readOwnerRecord`: `reapRunProcesses(runDir)` (an unexpected throw is mapped to a
  refusal too) ⇒ refuse `orphan process groups not reaped: <reason>`; then, iff `owner-transfer.json` is ENOENT and the
  status is resumable, `adoptCrashedRun`; lock/CAS throw ⇒ `lockOrCasDetail(error)`; `{ok:false}` ⇒ its reason;
  success ⇒ owner record re-read (spec C3), and the existing `Promise.all` re-reads transfer/reconciliation/state/contract.
- Module-private sentinel `CrashAdoptionRefused`; the existing catch's new first branch records its detail
  (`resume_denied`) and throws `ResumeNotEligibleError(detail)`.
- The claim step's error→detail mapping extracted into `lockOrCasDetail` (same four strings, same order), used by the
  claim catch and the adoption write. All existing comments kept verbatim and in place.
- ERRATUM appended (commit `fdef708`) after the `onAdopted` comment: the published `stopRequested`/`onAdopted` comments
  enumerate resume's refusals ("all four"); §4.3 adds three more before `resume_adopted`. Conclusions unchanged.

### Decisions (smallest fail-closed reading, flagged for the controller)
1. **Guard placement**: brief puts the Orca guard before the `try` (i.e. before `readOwnerRecord`); spec numbers it
   step 3, after step 2. I followed the brief: refusing before `readOwnerRecord` means resume performs no
   interrupted-transfer recovery (a write) on an Orca run either. Observable result is the same refusal; T9d pins that
   nothing but `events.jsonl` changes and an orphan in the control run is left alive.
2. **No transfer + non-resumable status**: spec says step 6 runs "if and only if … the run status is resumable", and
   "any other read failure keeps today's `cannot read run artifacts`". So resumeLoop only calls `adoptCrashedRun` for a
   resumable status; a terminal run without a transfer (e.g. any run that completed normally) still gets today's
   `cannot read run artifacts: … ENOENT … owner-transfer.json`. `adoptCrashedRun`'s own status check is kept as
   defence in depth (unreachable from resumeLoop).
3. **No retry on the adoption write**: spec says lock/CAS failure ⇒ refuse with the claim mapping. Measured: the T9
   loser gets `owner-transfer lock busy: OwnerTransferLockBusyError: owner transfer already in progress` (5/5 probe
   runs, probe file deleted afterwards). Not retried, unlike the claim step.

## Tests — `tests/controller/resumeCrashAdoption.test.ts` (new, 10)
T6 adopt→succeeded (event order, epoch 3, transfer + reconciliation contents); never-affirmed lease (RF1, basis
`lease not fresh (leaseAffirmedAt null)`); owner alive (this process) refused + snapshot minus events unchanged;
legacy `pid:100` ⇒ `undetermined` + snapshot unchanged; T9 two concurrent resumes ⇒ exactly one fulfilled, one
`owner_crash_adopted`, one `resume_adopted`; T9b replaced reconciliation named in event; T9c transfer run + live
orphan ⇒ reaped, resumed, no `owner_crash_adopted` (R1); T6b killed run + orphan ⇒ reap before adopt before
resume_adopted; T9d Orca control run refused with exact text, events exactly
`[resume_requested, lease_expired_observed, resume_denied]`, orphan untouched; RF3 second resume ⇒
`run status succeeded is not resumable`, still one `owner_crash_adopted`.
Real processes: every child pid registered, group+pid SIGKILL in `afterEach`.

### RED (stub `adoptCrashedRun.ts` exporting only the constant, resumeLoop unchanged)
`ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run tests/controller/resumeCrashAdoption.test.ts > $S/red.txt 2>&1`
⇒ `Tests  10 failed (10)`, RC=1; e.g. T6 `→ cannot read run artifacts: Error: ENOENT … owner-transfer.json`, T9d
`expected 'cannot read run artifacts: Error: ENO…' to be 'run directory belongs to an Orca cont…'`, T9c
`expected true to be false` (orphan alive).

### GREEN (main tree, HEAD 188b9cd content)
Same command ⇒ `Tests  10 passed (10)`, RC=0. T9-only rerun 8× ⇒ RC=0 each.
`npx tsc --noEmit -p .` ⇒ RC=0 (after both commits).

Focused runs alone (main tree, `> $S/ex-<name>.txt`, all read whole, all RC=0):
resumeLoop.integration 20/20, resumeLoop.gate 27/27, cli/agentsResume 5/5, leaseLifecycle.integration 35/35,
cli/cli 37/37, registry/zeroWrite 6/6, persistence/fileStore 97/97, sweep/sweepRuns 19/19,
runLoop.integration 71/71, cli/agentsRun 23/23, ownership/reapRunProcesses 14/14, ownership/ownerLiveness 12/12.

Full suite in clone `$S/t6-mut` at `fdef708` (`npm run build` BUILD_RC=0 first; HOME/XDG_* redirected to `$S/home`,
`TMPDIR=$(mktemp -d /private/tmp/cl-XXXX)`, `ECC_GATEGUARD=off DISABLE_OMC=1`; output `$S/full.txt`, 480 lines —
summary lines extracted with awk, not read line by line): `Test Files 1 failed | 106 passed (107)`,
`Tests 1 failed | 1106 passed (1107)`; the one red is the known stable `tests/control/stopProof.test.ts`
"does not treat leader exit as group quiet…".

`pgrep -fl setInterval` after all runs ⇒ empty (RC=1).

`$S` = `/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t6`.

### Controller checks
- agentsResume (real `run --agents` then `resume --agents`, and `sweep --agents`): 5/5 green, so the reaper did not
  refuse on those call dirs. Evidence is the green run; I did not list the call dirs' files.
- codexFixture (`<dir>/run`, no sibling `control/`): the guard lives only in resumeLoop; codex adapter tests never
  call it, and `isOrcaControlRunDir` needs `control/` to be a directory. All codex test files green in the full suite.

## Mutations (clone `$S/t6-mut`, one test file, `$S/mut-<id>.txt`)
| id | mutation | red lines |
|---|---|---|
| M6a | remove the post-adoption `readOwnerRecord` re-read | 6 failed: T6, RF1, T9b, T6b, RF3 `→ published eligibility has been superseded by a newer owner epoch`; T9 `expected [] to have a length of 1` |
| M6b | replace `reapRunProcesses` with `{ok:true}` | 2 failed: T9c, T6b `expected true to be false` (orphan alive) |
| M6c | `if (false && isOrcaControlRunDir…)` | 1 failed: T9d `expected null to be an instance of ResumeNotEligibleError` |
| M6d | `adoptCrashedRun` skips `classify` (verdict forced `dead`) | 2 failed: owner alive, legacy id `expected null to be an instance of ResumeNotEligibleError` |

Restore proof after each: `git diff | wc -c` = 0 and `git diff --cached | wc -c` = 0 (all four).

## Existing criteria rewritten
None. No existing test changed; every focused file above is green unmodified (the R1 fixtures with a transfer behave
as before; cli.test "prints the refusal reason…" still gets `cannot read run artifacts` from the missing owner record).

## Files
- /Users/biran/code/skills/loop/ccloop/src/controller/adoptCrashedRun.ts (new)
- /Users/biran/code/skills/loop/ccloop/src/controller/resumeLoop.ts
- /Users/biran/code/skills/loop/ccloop/tests/controller/resumeCrashAdoption.test.ts (new)

## Concerns
- Decisions 1–3 above (guard before recovery; terminal no-transfer runs keep today's text; adoption write not retried).
- T9 relies on two in-process resumes sharing one process instance id; the loser has always lost on the adoption
  lock so far. If it ever lost later (eligibility or claim CAS) it still refuses, and the test only asserts the
  exactly-once outcome, not which refusal.
- `reapRunProcesses.ts` untouched.

---

## Fix round 1 (Task 6 implementer, Orca session ece96b67, 2026-10-02)

Commits: `e725675` fix(resume): confirm the owner dead before reaping, and report a lost adoption event as its own
refusal; plus a test-only commit adding the T9 comment (see the git log after `e725675`).

### Changes
1. **Owner check before reaping (controller ruling).** `adoptCrashedRun.ts` split: new export
   `confirmOwnerDead(ownerRecord, deps?) → {ok:true; reason} | {ok:false; reason}` (classify; refusal text unchanged,
   `no owner transfer and the owner is <verdict>: <reason>`); `adoptCrashedRun(runDir, ownerRecord, runState,
   ownerDeadReason)` now only writes (signature changed: 4th arg is the dead reason instead of `deps`; resumeLoop is
   its only caller; `isOrcaControlRunDir` and `CRASH_ADOPTION_REASON` unchanged). resumeLoop order is now: lease gate
   → Orca guard → readOwnerRecord → transfer ENOENT? + status resumable? → `confirmOwnerDead`, refuse without reaping
   → `reapRunProcesses` (every path) → adoption write → owner re-read → today's path. Runs with a transfer: reap, then
   today's path (R1).
2. **Event failure after a committed write.** Only `writeOwnerTransferArtifacts` errors are thrown to resumeLoop's
   `lockOrCasDetail` mapping; an `appendEvent(owner_crash_adopted)` failure returns
   `{ok:false, reason: "adoption committed but its event could not be recorded: <error>"}`, recorded as the refusal.
3. T6's self-comparing `expect(CRASH_ADOPTION_REASON).toBe(...)` and its import removed.
4. New tests: "refuses a no-transfer run whose owner is alive without reaping its registered group" (owner = this
   process, live registered group with matching lstart ⇒ refused, group alive, no `orphan_process_group_reaped`, no
   `owner_crash_adopted`, snapshot minus events unchanged); "reports an event failure after a committed adoption
   write as its own refusal" (direct `adoptCrashedRun` call, `events.jsonl` replaced by a directory ⇒ EISDIR on
   append; reason prefix asserted, transfer epoch 3 on disk).
5. T9 comment: the exactly-once property against a bypassed CAS rests on tests/persistence/fileStore.test.ts.

### Mutations (clone `$S/t6-fix-mut` at `e725675`, one file, `$S/fmut-<id>.txt`, all read whole)
| id | mutation | result |
|---|---|---|
| MF1 | reap block moved back above the transfer/owner check | 1 failed: new "owner alive without reaping" test, `expected false to be true` at `expect(alive(group)).toBe(true)` |
| MF2 | remove the try/catch around the event append | 1 failed: event-failure test, `EISDIR: illegal operation on a directory … events.jsonl` thrown out of adoptCrashedRun |
| MF3 | CAS expectation = `await readOwnerRecord(runDir)` right before the write (precondition bypass) | **green, 12/12** — T9's loser always loses on the transfer lock (no retry on the adoption write), so T9 cannot see a CAS bypass. Recorded as a comment in T9; the precondition is pinned by tests/persistence/fileStore.test.ts ("throws OwnerTransferLockBusyError for a busy lock and OwnerTransferPreconditionError for a CAS mismatch…", "releases the lock after rejecting a stale precondition…"). |

Restore proof after each: `git diff | wc -c` = 0, `git diff --cached | wc -c` = 0.

### Re-runs (main tree, after the T9 comment; `$S/f2-<name>.txt`, RC appended)
`npx tsc --noEmit -p .` RC=0. resumeCrashAdoption 12/12, resumeLoop.integration 20/20, resumeLoop.gate 27/27,
cli/agentsResume 5/5, cli/crashResume 1/1 (Task 7, f589ee3) — all RC=0. `pgrep -fl setInterval` empty (RC=1).
Note: `docs/superpowers/specs/2026-10-02-crash-resume-and-orphan-reaping-design.md` showed as modified in the working
tree before this round; not mine, not touched, not staged.
