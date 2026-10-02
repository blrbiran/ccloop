# Crash resume, orphan reaping, R-A and R-B — design

Status: revised after one independent review (§11), approved for planning under the human's session authorization
(H8). Written 2026-10-02 by the Orca controller session `ece96b67` (working in this repository by the human's
assignment), on top of the pushed ccloop tip of that day. No hash is recorded here on purpose; cite subject lines.

## 1. Why

Paid real-claude runs found four defects that all live in the runner / adapter / loop-terminal layer:

| | Defect | Evidence |
|---|---|---|
| D1 | A run whose ccloop was SIGKILLed cannot be continued by any CLI path. `resume` and `sweep` only accept a run whose own loop published `owner-transfer.json` at a `stale_candidate` boundary; a killed run has none and is refused with `cannot read run artifacts: ENOENT … owner-transfer.json`. README §3.2 says `resume` takes over an interrupted run. | `.superpowers/sdd/2026-10-01-live-partial-and-resume/progress.md` R1/R2 |
| D2 | The adapter spawns the runner `detached`. When ccloop dies, the runner and claude keep running to the end and keep spending. | same ledger, R1 |
| R-A | claude's binary was being reinstalled at the second execute spawned it (`spawn …/bin/claude ENOENT`). The runner exits 1, the adapter throws `claude-exit-error`, the phase's usage is booked as unknown, and Orca's group can never clear it. | Orca `.superpowers/sdd/2026-10-02-requirement-to-split/progress.md`, section "Paid run", run 1 |
| R-B | Under `--permission-mode acceptEdits` the executor cannot run commands. Asked to make tests pass, claude wrote the file, then answered `completionStatus: partial`, `failureType: error`; the loop ended `failed` with two attempts left, although ccloop's own verify phase runs the required checks. | same Orca section, run 2 |

## 2. Rulings (human, 2026-10-02, verbatim)

| | Question | Answer |
|---|---|---|
| H1 | Fix R-A and R-B in this round too? | "C 三件都修。" |
| H2 | R-B direction | "A＋B：A 兜底，B 减少无谓的 partial。" (A = send claude's own `partial`+`error` with changed files to verify; B = execute prompt says checks are run by the verifier) |
| H3 | R-A scope | "A（推荐）两处都改。" (prove never-started ⇒ usage 0; bounded in-runner retry on `ENOENT` only) |
| H4 | Overall approach | "A" (plain `resume` adopts a killed run itself; no new flag) |
| H5 | `sweep` | "同意B" (sweep also takes killed runs, counted separately in the banner) |
| H6 | Sections 1–3 of the design | "同意" ×3; on section 1 the human asked to account for the per-process fd limit (§7) |
| H7 | Capacity measurement under real claude | "我已同意你做实测。放在哪个轮次你可以自行选择合适的轮次。" |
| H8 | How this session runs | "这一轮执行过程中如果有问题，先按你的建议执行（不要再找我）。执行完在最后阶段报给我审核。" Consequence written down here: the sweep banner wording (§4.4) and every rewrite of an existing criterion are decided by the controller and reported for human ratification at the end, recorded in the ledger as `Ruling (controller, pending human ratification)`. |

## 3. Runner side

### 3.1 The runner watches its parent

- The adapter (`src/runtime/claude/claudeAgentAdapter.ts`) spawns the runner with a fourth stdio entry `"pipe"` on
  fd 3 and sets `CCLOOP_PARENT_WATCH_FD=3`. The adapter never writes to it and destroys it in `finish()` with the
  other three streams.
- Why not stdin: the adapter ends stdin right after writing the request (`claudeAgentAdapter.ts`, `writeRequest`),
  and the runner reads stdin to EOF before it starts claude. stdin EOF carries no information about the parent.
- The runner watches fd 3 only when `CCLOOP_PARENT_WATCH_FD` is set. `claudeEnv()` strips the variable (it is this
  runner's own input, like the three it already strips), so claude and anything claude starts never see it, and
  only an adapter-spawned runner — always `detached`, therefore its group's leader — acts on it.
- Parent gone = `end`, `close` or `error` on fd 3. From that moment:
  1. `parentGone = true`; `process.stdout` and `process.stderr` get no-op `error` listeners (no reader is left; a
     write must not crash the runner before step 4);
  2. a pending spawn retry (§3.2) stops;
  3. claude, if running, gets SIGTERM;
  4. after `PARENT_GONE_GRACE_MS` (5,000; `CCLOOP_PARENT_GONE_GRACE_MS` overrides it for tests) the runner sends
     SIGKILL to its own group (`process.kill(-process.pid, "SIGKILL")`);
  5. **and on every exit path while `parentGone` is true** (a `process.on("exit")` hook, which covers the
     interrupt handler's `process.exit` calls during an abort or timeout flush) the same group SIGKILL runs
     synchronously first. So the group dies even if the runner would otherwise have exited inside the grace window.
- Paths that do not change while the parent lives: normal completion, phase timeout, abort and handoff interruption.
  `finish()` already SIGKILLs the group before destroying the streams.
- EOF reliability: what matters is that no process other than the parent holds the parent's end. Node passes a child
  only the fds named in its `stdio`; later children of the parent do not get the parent's end. (The runner's own end
  may well be inherited by claude, because libuv clears close-on-exec on fds it maps into a child; that does not
  matter, because only the parent's end decides EOF.) Criterion T2 pins the measured behaviour.
- Not covered: codex phases (`src/runtime/codex/runCodexPhase.ts`) spawn codex directly; nothing watches their
  parent. Their orphans are reaped only by §4.2.

### 3.2 R-A: claude never started

- "Never started" is established only by Node's spawn result: either `spawn()` throws synchronously, or the child
  emits `error` before any `spawn` event. Node emits the `error` event for `EACCES`, `EAGAIN`, `EMFILE`, `ENFILE`
  and `ENOENT` and throws synchronously for other codes; for `EMFILE`/`ENFILE` it returns before creating the stdio
  streams. In both shapes no process existed.
- The runner therefore wraps `spawn` in try/catch and attaches its `error` and `spawn` listeners before touching any
  stdio stream (today `child.stdout.setEncoding` runs before `child.on("error")` and would throw on `EMFILE`).
- Retry: only for `ENOENT`, at most `CLAUDE_SPAWN_ATTEMPTS = 3` spawns, `CLAUDE_SPAWN_RETRY_DELAY_MS = 2,000` apart.
  Measured cause on 2026-10-02: the reinstall window was one to two seconds.
- The answer: when the last spawn fails, or any spawn fails with another code, the runner writes
  `{"claudeNeverStarted": true, "spawnError": "<code>: <message>"}` to stdout (awaiting the write callback) and
  exits 0.
- Interrupt during the retry wait (SIGTERM/SIGINT): the interrupt handler, seeing that claude never started in this
  call, writes the same never-started answer instead of building a timeout partial, and exits 0. Main checks
  `interruptHandled` before its own write, so stdout never carries two answers. Parent gone during the wait: no
  answer (no reader), group SIGKILL as §3.1.
- The never-started branch is taken before the execute partial branch in main's catch.
- Adapter: `phase()` checks for `claudeNeverStarted` **before** its after-stop branch (which otherwise returns any
  JSON object printed with exit 0 as the phase result). It throws `ClaudeNeverStartedError`
  (`claude-never-started: <spawnError> (<evidenceDir>)`) carrying `neverStarted: true`. When the call was aborted it
  throws `ClaudePhaseAborted` instead, also carrying `neverStarted: true`. `singleCall()` checks the answer before
  its `outputError` test and throws the same error.
- Usage 0: `observedTokensOf` (`src/runtime/types.ts`) today returns null unless the value is a positive safe
  integer ("never 0"). It gains one branch: an error carrying `neverStarted: true` answers 0. Its published doc
  comment is kept verbatim and gets an appended ERRATUM naming this spec (Rule 16). Every consumer
  (`PhaseExecutionError`, runLoop's abort accounting, `singleCall`'s usage, the worker's usage observation) already
  goes through `observedTokensOf`, so 0 reaches the booked phase usage and Orca's usage observation without other
  changes; criterion T5 measures both ends.
- The run still ends `failed` (H3 kept the terminal decision).

## 4. resume / sweep side

### 4.1 Owner death

New `src/ownership/ownerLiveness.ts`, `classifyOwnerProcess(ownerRecord)` → `dead` | `alive` | `undetermined`, with
a reason string.

- Parse `currentProcessInstanceId` as `pid:<pid>:<startMs>` (`buildProcessInstanceId`). Anything else ⇒
  `undetermined`.
- `classifyProcessLiveness(pid)` (`src/persistence/fileStore.ts`, reused): `dead` ⇒ `dead`; `unknown` ⇒
  `undetermined`; `alive` ⇒ next step.
- Read the holder's start: `/bin/ps -o lstart= -p <pid>` with `TZ=UTC LC_ALL=C`, parsed **explicitly as UTC** to
  whole epoch seconds `S` (never `Date.parse` on the bare string, which reads local time). Failure or empty ⇒
  `undetermined`.
- Reference moment `R` = the latest of `startMs`, `lastAffirmedAt`, `leaseAffirmedAt` present in the record — each
  is a moment the owner is known to have been alive. `S > ceil(R / 1000) + OWNER_START_MARGIN_S` (2) ⇒ the holder
  started after the owner was last known alive ⇒ a different process ⇒ `dead`. Otherwise ⇒ `alive`.
- This only says `dead` when the holder is certainly not the owner. Assumption stated: one host, and no wall-clock
  step larger than the margin plus the owner's age between `R` and the check.

### 4.2 Reaping registered process groups

New `src/ownership/reapRunProcesses.ts`, `reapRunProcesses(runDir)`:

- Consider only call evidence directories with a `process.json` and **no `outcome.json`**, excluding `worktrees/`.
  The adapters write `outcome.json` only after `finish()` has SIGKILLed the group, so a call with an outcome left
  nothing behind. This keeps the reaper away from old, finished calls whose pgid numbers may have been reused.
- `process.json` unreadable or unparseable: if the same directory has no `request.json`, the runner never received a
  prompt (it reads stdin to EOF, and the dead parent's end is closed), so the call is skipped; otherwise refuse.
- Probe each `{pid, pgid, startedAt}`:
  - `kill(-pgid, 0)` ESRCH ⇒ quiet, skip;
  - any other error ⇒ refuse;
  - group present and the leader's `lstart` (same `ps` call as §4.1, compared as the raw string the adapter
    recorded) equals `startedAt` ⇒ ours, reap;
  - group present, leader absent or `lstart` different ⇒ refuse. (The common "runner gone, claude alive" case is
    temporary: claude finishes or dies, the group empties, a later resume passes.)
- Reap = SIGTERM to the group, wait `REAP_GRACE_MS` (5,000), SIGKILL, poll until ESRCH or `REAP_TIMEOUT_MS`
  (15,000) ⇒ refuse on timeout. One `orphan_process_group_reaped` event per reaped group,
  detail `pid <pid> pgid <pgid> phase <phase>`.
- Idempotent; writes nothing but events.

### 4.3 resume, step by step (new steps in bold)

1. `resume_requested`; lease gate. A fresh lease refuses. (unchanged)
2. `readOwnerRecord` (unchanged; still runs interrupted-transfer recovery first).
3. **Orca control run guard: if `basename(runDir) === "run"` and `dirname(runDir)/control` is a directory, refuse with
   `run directory belongs to an Orca control store; Orca recovers it`.** Orca's driver owns such runs' generation
   and budget.
4. **`reapRunProcesses(runDir)`: any refusal ⇒ refuse.**
5. Read `owner-transfer.json`, `reconciliation-record.json`, `loop-state.json`, `loop-contract.json` as today.
6. **If and only if `owner-transfer.json` was absent with ENOENT and the run status is resumable:
   `classifyOwnerProcess(ownerRecord)`; `alive` or `undetermined` ⇒ refuse naming the verdict and reason; `dead` ⇒
   adopt:**
   - write through the existing `writeOwnerTransferArtifacts` with the step-2 record as the CAS expectation:
     transfer = `applyOwnerEpochTransfer(ownerRecord, buildProcessInstanceId(), now, "owner process confirmed dead by resume")`;
     reconciliation: `staleSuspicionBasis` = [`lease not fresh (leaseAffirmedAt <value>)`, the owner verdict's reason],
     `staleConfirmed: true`, `ownershipVerdict: "OWNER_LOST"`, `lastTrustedBoundary` from the status
     (`planning`/`executing`/`verifying` ⇒ `planning`/`execute`/`verify`), `conflictingEvidence: []`,
     `takeoverPermission: {allowed: true, reason: "owner process confirmed dead by resume"}`,
     `priorOwnerEpoch` = current, `newOwnerEpoch` = the transfer's, `eligibleForContinuation: true`;
   - a `reconciliation-record.json` that exists without a transfer (written when an earlier transfer was contended,
     `newOwnerEpoch: null`) is replaced by this write; the `owner_crash_adopted` event names that it replaced one;
   - event `owner_crash_adopted`, detail `epoch <prior> -> <new>: <prior instance id> confirmed dead (<reason>)`;
   - CAS or lock failure ⇒ refuse with the detail mapping the claim step already uses (two racing resumes: exactly
     one CAS succeeds);
   - **then re-read the owner record, transfer and reconciliation**, and use those for step 7. (The step-2 record is
     one epoch behind and would fail both the eligibility check and the claim CAS.)
   Any other read failure keeps today's `cannot read run artifacts: …`.
7. Eligibility (8 criteria), claim CAS, `resume_adopted`, heartbeat, residual worktree cleanup, loop. (unchanged)

The lease value is not used to tell a crash from a deliberate stop: `leaseAffirmedAt: null` is written in many
states (the initial record, after any transfer, after a resume claim, and on a clean release). Owner death (step 4)
is the proof for adoption; the lease gate (step 1) only refuses a fresh lease, as today.

Behaviour change on an existing path, stated: steps 3 and 4 also run for runs that already have a transfer record.
Those still continue on lease expiry (the owner check of step 6 is not applied to them: controller ruling R1, §11),
but now also need every registered unfinished group reaped or quiet, and Orca control runs are refused.

README §3.2 states operator-visible consequences (`registerStopHandlers`, `src/cli.ts`): a single Ctrl-C asks the
loop to stop at its next phase boundary, after which the process releases the lease and exits; a second Ctrl-C
exits at once (`exit 130`) without release. Either way, once the process is gone, `resume` adopts the run if its
status is resumable.

Implementation-time correction (Task 6 review, 2026-10-02, controller ruling under H8): on the adoption path the owner
check of step 6 runs **before** the reap of step 4 — the transfer's absence and the status are read first, the owner is
classified, `alive`/`undetermined` refuses without reaping anything, and only then are groups reaped and the transfer
written. Otherwise a resume that ends up refusing "owner is alive" could already have killed that live owner's calls.
Runs that carry a transfer keep the order above (reap, then today's path).

### 4.4 sweep

- Candidates: (a) unchanged — `owner-transfer.json` observed with `eligibleForContinuation` literally true; (b) new —
  `owner-transfer.json` observed `absent`, `loop-state.json` `status` observed as `planning`, `executing` or
  `verifying`, `owner-record.json` `leaseAffirmedAt` observed as a timestamp older than `LEASE_TTL_MS` before the
  row's `observedAt` (a `null` lease is not a sweep candidate: controller ruling R2, §11), and the run is not an Orca control run (§4.3 step 3). Both classes sorted together
  by path, as today; `--max-runs` is counted at adoption, as today.
- Banner: the existing line is kept byte for byte. When class (b) is non-empty one more line follows:

  ```
  sweep: <K> run(s) under <root> have no owner-transfer.json, a resumable status and an expired lease (observed fields; each is resumed only if its owner is confirmed dead)
  ```

  Wording decided by the controller under H8, reported for ratification. With K = 0 nothing is added.
- Each candidate goes through the same `resumeLoop`; a refusal refuses that run only.

### 4.5 README

§3.2 rewritten for the new `resume` behaviour and refusals; §3.4 gains the second banner line.

## 5. Loop side: R-B

### 5.1 A: claude's own partial with changed files goes to verify

- Only a partial claude itself returned qualifies. The runner marks every partial it builds itself (interrupt
  partials and failure partials from `buildPartialExecutionOutcome`) with `partialOrigin: "runner"`; claude's own
  structured answer never carries it (the runner strips the field from claude's answer if present). The adapter
  carries it into the `ExecutionResult`.
- In `runLoopFromState`'s partial branch, after the path-policy check: `failureType === "error"`, no
  `partialOrigin`, and `changedFiles.length > 0` ⇒ write the attempt artifacts, append
  `partial_execute_sent_to_verify` (detail `failureType error, <n> changed file(s): <failureMessage>`), and **fall
  through to the code a complete execution takes after the partial branch** — the same path-policy result, then the
  budget check (`hasBudgetExceeded`), then verify.
- After verify, today's stop decision applies unchanged. Stated plainly: a failed required check sets
  `safeToRetry: false` and ends the run `failed`; a retryable rejection on attempt 2+ gives
  `blocked_waiting_human`. So the gain is "a correct partial is no longer thrown away", not "the remaining attempts
  are used".
- Unchanged: `timeout` ⇒ `exhausted`; `error` with no changed files ⇒ `failed`; runner-built partials ⇒ today's
  behaviour; path-policy human gate ⇒ `blocked_waiting_human`; the thrown-error branch.

### 5.2 B: the execute prompt names who runs the checks

`buildExecutorPrompt` (`src/runtime/claude/prompts.ts`) gains, after the success condition:

```
Required checks (run by the verifier in this worktree after you finish):
<the contract's requiredChecks list>
If you cannot run a command (for example it needs approval), do not report partial or error for that reason; deliver your changes and say in stdoutStderrLog which commands you could not run.
```

Only a static criterion can pin this. §5.1 is the guarantee; §5.2 only reduces needless partials.

## 6. Criteria

Fake claude only, in a `git clone --local` copy; HOME and the four XDG roots redirected; short real TMPDIR. Every
new branch is paired with the mutation that deletes it, and the mutation must be seen red.

| | Criterion | Guards |
|---|---|---|
| T1 | A parent that started a runner is SIGKILLed: runner and fake claude gone within `PARENT_GONE_GRACE_MS` + margin | §3.1 |
| T2 | Same, while an unrelated long-lived child of the killed parent is alive | §3.1 EOF |
| T2b | Parent SIGKILLed while the runner is flushing an abort partial: the whole group, including a grandchild of fake claude, is gone | §3.1 step 5 |
| T3 | One process runs phases ending each way; `/dev/fd` count unchanged. The plan must show the "do not destroy fd 3" mutation red, or drop this criterion's claim | §7 leak |
| T4 | claude command absent at first spawn, present at the second: phase completes, one paid call | §3.2 retry |
| T5 | claude command absent throughout: run `failed`, booked phase usage 0 (not null), worker usage observation 0; same for a single call | §3.2 usage |
| T5b | SIGTERM during the retry wait: one never-started answer on stdout, usage 0 | §3.2 interrupt |
| T6 | Run SIGKILLed mid-execute; after lease expiry `resume --agents` continues to `succeeded` without seeded files; events show `owner_crash_adopted`, `resume_adopted` | §4.3 |
| T6b | Same, with the runner group deliberately kept alive (parent watch disabled in the fixture): resume reaps it (SIGTERM path and SIGKILL path) and records `orphan_process_group_reaped` | §4.2 |
| T7 | Owner alive / `unknown` / recycled pid (holder started after `R`), including under `TZ=America/Los_Angeles`: refuse, refuse, adopt | §4.1 |
| T8 | Unfinished call with mismatching `lstart`, leader absent, EPERM-like probe error, a group outliving `REAP_TIMEOUT_MS`, unparseable `process.json` with and without `request.json`: refuse ×5, skip ×1; nothing but events written | §4.2 |
| T9 | Two resumes race on one killed run: exactly one adopts | §4.3 step 6 |
| T9b | Reconciliation without transfer: adopted, event names the replacement | §4.3 step 6 |
| T9c | A run with a loop-published transfer and a live unfinished registered group: the group is reaped, then the run resumes (stated behaviour change) | §4.3 step 4 |
| T9d | Orca control run: refused by resume, not a sweep candidate | §4.3 step 3 |
| T10 | sweep over (a), (b) and a refused (b) run: banner lines as §4.4; the refusal does not stop the rest | §4.4 |
| T11 | claude's own `partial`+`error`+changed files: verify runs; checks pass ⇒ `succeeded`; a failing check ⇒ today's stop decision; no changed files ⇒ `failed`; a runner-built partial ⇒ today's path; budget exceeded ⇒ `exhausted` before verify | §5.1 |
| T12 | Executor prompt contains the checks and the instruction | §5.2 |

Existing criteria: the plan names each one a change breaks, after a mechanical tree scan (terms from the changed
sentences: `owner-transfer.json`, `cannot read run artifacts`, `observed eligibleForContinuation=true`,
`completionStatus`, `failureType`, `observedTokensOf`, `never 0`, `claudeEnv`). New coverage is added rather than
rewritten wherever possible; each unavoidable rewrite is recorded in the ledger as pending human ratification
(ruling 88 form: named, whole rewrite, no loosening, ruling recorded).

Gate: typecheck and build RC 0; `check-known-reds` RC 0 (only `stopProof` red); `check-tmp-leak` RC 0;
`agentsControl` and `evidence` reds are rerun alone before being called regressions.

## 7. Capacity

### 7.1 Measured limits (2026-10-02, this machine; `ulimit -Sn`, `ulimit -Hn`, `sysctl`)

| | Value |
|---|---|
| fd soft / hard limit (shell) | 1,048,576 / unlimited |
| `kern.maxfilesperproc` | 122,880 |
| `kern.maxfiles` | 245,760 (11,119 in use at measurement) |
| `kern.maxprocperuid` | 5,333 |
| `kern.maxproc` | 8,000 |

### 7.2 What this round adds and what binds

- Two fds per live runner (the parent's end, the runner's end of the fd-3 socketpair; claude may inherit the
  runner's end, §3.1). Each child already had three stdio pipes.
- One phase at a time per run; Orca starts each run as its own worker (`stdio: "ignore"`, `unref`), so the panel
  holds no fd per task and no single process accumulates fds with parallelism. The per-process limit does not bind.
- The shared limits are system-wide fds and per-user processes. Each task in flight is at least three node
  processes plus claude's tool shells and MCP servers; the per-user process limit is expected to bind first (an
  expectation, not a measurement).
- The real risk added is a leak (a long-lived Orca worker running many phases). T3 guards it if its mutation can
  be shown red.
- At the limit: a failed pipe when the adapter spawns the runner takes today's `spawn-error` path; `EMFILE` when
  the runner spawns claude is "never started", not retried.

### 7.3 Measurement (approved, H7)

- Fake claude: criteria record fds and processes per phase in flight as a lower bound in the ledger.
- Real claude: rides on §9's paid run: while execute is in flight, list the runner's group (`ps -g`) and each
  member's fds (`lsof -p`), raw outputs kept; only measured numbers recorded.
- Orca registers "maximum tasks started at once" as an open item, derived from those numbers against
  `kern.maxprocperuid` and `kern.maxfiles`, with headroom.

## 8. Orca

- Orca's driver uses its own recovery and does not call `ccloop resume`; §4.3 step 3 makes that explicit. No Orca
  change this round.
- When Orca next repins for any reason it gains the parent watch for its workers and R-A's 0 in its usage
  observation.
- Repin only if Orca depends on new behaviour: ccloop commit → human pushes ccloop →
  `node scripts/pin-ccloop.mjs <SHA>` → human pushes Orca.

## 9. Paid acceptance

One paid real-claude run at the end (covered by H7 and H8): `run --agents` on a small task, SIGKILL ccloop during
execute, show runner and claude gone within the grace, record §7.3's numbers just before the kill, wait out the
lease, `resume --agents` to a terminal state. `--max-budget-usd` per call kept low. Spend reported only from
claude's own `total_cost_usd`.

## 10. Out of scope

Changing the terminal decision for a never-started claude (H3); letting the executor run commands (H2); a codex
runner; multi-host ownership; Orca's concurrent-start cap itself (registered, §7.3); making `process.json` writes
atomic (§4.2's `request.json` rule covers the torn-write case).

## 11. Review corrections (independent review, 2026-10-02, same session)

The first draft (commit `docs(spec): design crash resume, orphan reaping, R-A and R-B as one round`) was reviewed
read-only against the code. Accepted and folded in above:

- C1 `observedTokensOf` dropped 0, so R-A's 0 could not arrive; `singleCall` would have reported the answer as
  invalid output ⇒ §3.2 `neverStarted` branch and ordering.
- C2 a bare `lstart` parsed as local time can make a live owner look dead west of UTC ⇒ explicit UTC parse and the
  reference moment `R` (§4.1).
- C3 after resume writes the transfer, the step-2 owner record is one epoch behind ⇒ re-read (§4.3 step 6).
- I1 reaping every historical `process.json` could kill a reused pgid ⇒ only calls without `outcome.json`, exact
  `lstart` match, leader-absent refused (§4.2).
- I2 the runner could exit inside the grace window during a flush ⇒ exit hook and stdout/stderr error listeners
  (§3.1).
- I3 the watch variable leaked into claude's environment; the inheritance sentence was wrong ⇒ stripped,
  reworded (§3.1).
- I4 not every spawn failure is an `error` event; `EMFILE` throws before the listener ⇒ try/catch, listener first
  (§3.2).
- I5 interrupt during the retry wait was unspecified ⇒ §3.2.
- I6 `null` lease is not "released on purpose" ⇒ the lease no longer separates crash from stop (§4.3, §4.4).
- I7 Orca control runs would have become adoptable ⇒ guard (§4.3 step 3).
- I8 R-B caught runner-built partials, could skip the budget check, and overstated retries ⇒ `partialOrigin`,
  fall-through, honest wording (§5.1).
- I9 reconciliation without transfer was undefined ⇒ replace with an event (§4.3 step 6).
- I10 missing criteria ⇒ T2b, T5b, T6b, T9b–T9d, T7 timezone, T11 budget; T3's red is a plan obligation.
- Controller ruling R1 (under H8, pending ratification): the owner check applies only to adoption (step 6), not to
  runs that already carry a transfer. Measured reason: 111 fixture lines across 14 test files seed owner ids of the
  legacy form `pid:<n>` (`grep -rn 'currentProcessInstanceId: "pid:' tests`), which the check classifies
  `undetermined`; applying it to every path would rewrite those criteria, and the lease-only rule for
  loop-published transfers is the established design. Reaping (step 4) still applies to every path.
- Controller ruling R2 (under H8, pending ratification): sweep's class (b) needs an expired lease timestamp; a `null`
  lease is resumed only by an explicit `resume`. Reasons: `null` also covers a single Ctrl-C (a deliberate stop), which
  a one-line batch approval should not revive; and `tests/sweep/sweepRuns.test.ts`'s `runRow` fixture seeds
  non-eligible rows with status `executing` and `leaseAffirmedAt: null`, which existing criteria expect not to be
  candidates.
- Minor: `unknown` not `undetermined`; adapters' `ps` from PATH (the new code uses `/bin/ps`); sweep has no
  truncation; scanner rows always exist (`absent`); `observedAt`; `process.json` torn writes (§4.2 rule).

## 12. Implementation-time corrections (SDD round, 2026-10-02, Orca session ece96b67)

- Controller ruling (under H8, pending ratification): §5.1's rule also covers codex. A codex `error` partial with changed
  files goes to verify, because codex partials are always the model's own answer (no runner builds them, and the codex
  protocol schema is strict, so `partialOrigin` can never appear there). This changes Orca codex workers too.
- §3.1: a runner given `CCLOOP_PARENT_WATCH_FD=3` whose fd 3 is unusable treats that as "parent gone" — deliberate.
- §3.2: the runner also refuses to make its first claude spawn once the parent is gone, and returns right after
  reading the request when the parent died meanwhile (Task 3 review), so no claude is spent after the parent's death.
- §4.2: refusal reasons name the call directory they concern (final review M4). A crash-killed call never gets an
  `outcome.json`; if its pgid is later reused by an unrelated group leader, resume refuses until that process exits.
  Registered, not solved (a tombstone would need the reaper to write more than events).
- §6 T3 guards "no per-phase fd growth", not the fd-3 destroy in `finish()`, which Node closes at child exit anyway
  (the destroy mutation is invisible, measured).

## 13. Human ratification (2026-10-02, Orca session 7fe6d61b)

The human answered "同意" to every ruling marked "pending ratification" in §4.4, §11 and §12. Ratified, unchanged:
R1 (§11), R2 (§11), the sweep second banner line wording (§4.4), and codex `error` partials with changed files going
to verify (§12). The two existing-criterion rulings recorded only in the ledger (Task 3 three-spawns bounds, Task 9
`materialize.test.ts` fixture field) are ratified in the same answer. The "pending ratification" wording above is left
as written; this section supersedes it.
