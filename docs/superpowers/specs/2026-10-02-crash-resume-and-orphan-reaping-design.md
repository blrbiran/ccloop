# Crash resume, orphan reaping, R-A and R-B — design

Status: draft for human review. Written 2026-10-02 by the Orca controller session `ece96b67` (working in this
repository by the human's assignment), on top of the commit whose subject line is
`docs(handoff): N1 paid run went from requirement to export under real claude, …` in Orca and the pushed ccloop tip
of the same day. No hash is recorded here on purpose; cite subject lines.

## 1. Why

Paid real-claude runs found four defects that all live in the runner / adapter / loop-terminal layer:

| | Defect | Evidence |
|---|---|---|
| D1 | A run whose ccloop was SIGKILLed cannot be continued by any CLI path. `resume` and `sweep` only accept a run whose own loop published `owner-transfer.json` at a `stale_candidate` boundary; a killed run has none and is refused with `cannot read run artifacts: ENOENT … owner-transfer.json`. README §3.2 says `resume` takes over an interrupted run. | `.superpowers/sdd/2026-10-01-live-partial-and-resume/progress.md` R1/R2 |
| D2 | The adapter spawns the runner `detached`. When ccloop dies, the runner and claude keep running to the end and keep spending. | same ledger, R1 |
| R-A | claude's binary was being reinstalled at the second execute spawned it (`spawn …/bin/claude ENOENT`). The runner exits 1, the adapter throws `claude-exit-error` with `observedTokens: null`, the phase's usage is booked as unknown, and Orca's group can never clear it. | Orca `.superpowers/sdd/2026-10-02-requirement-to-split/progress.md`, section "Paid run", run 1 |
| R-B | Under `--permission-mode acceptEdits` the executor cannot run commands. Asked to make tests pass, claude wrote the file, then answered `completionStatus: partial`, `failureType: error`; the loop ended `failed` with two attempts left, although ccloop's own verify phase runs the required checks. | same Orca section, run 2 |

## 2. Rulings taken in the design conversation (human, 2026-10-02, verbatim)

| | Question | Answer |
|---|---|---|
| H1 | Fix R-A and R-B in this round too? | "C 三件都修。" |
| H2 | R-B direction | "A＋B：A 兜底，B 减少无谓的 partial。" (A = send a self-reported `partial`+`error` with changed files to verify; B = execute prompt says checks are run by the verifier) |
| H3 | R-A scope | "A（推荐）两处都改。" (prove never-started ⇒ usage 0; bounded in-runner retry on `ENOENT` only) |
| H4 | Overall approach | "A" (plain `resume` adopts a killed run itself; no new flag) |
| H5 | `sweep` | "同意B" (sweep also takes killed runs, counted separately in the banner; banner wording reviewed by the human verbatim) |
| H6 | Sections 1–3 of the design | "同意" ×3; on section 1 the human asked to account for the per-process fd limit (§7) |
| H7 | Capacity measurement under real claude | "我已同意你做实测。放在哪个轮次你可以自行选择合适的轮次。" (§7.3) |

## 3. Runner side

### 3.1 The runner watches its parent

- The adapter (`src/runtime/claude/claudeAgentAdapter.ts`) spawns the runner with a fourth stdio entry, a pipe on
  fd 3, and sets `CCLOOP_PARENT_WATCH_FD=3` in its environment. The adapter keeps the write end, never writes to it,
  and destroys it in `finish()` together with stdin/stdout/stderr.
- Why not stdin: the adapter already ends stdin right after writing the request (`child.stdin.end(...)`), and the
  runner reads stdin to EOF before it starts claude. stdin EOF therefore carries no information about the parent.
- The runner watches fd 3 only when `CCLOOP_PARENT_WATCH_FD` is set, so every existing criterion that starts the
  runner directly is unaffected.
- On EOF or error on fd 3 ("parent gone"):
  1. mark the interrupt as handled, so no other path writes to stdout or stderr (there is no reader);
  2. stop retrying a spawn (§3.2) if one is pending;
  3. send SIGTERM to claude if it is running;
  4. after `PARENT_GONE_GRACE_MS` (new constant, 5,000; overridable by `CCLOOP_PARENT_GONE_GRACE_MS` for tests),
     send SIGKILL to the runner's own process group (`process.kill(-process.pid, "SIGKILL")`), which ends the
     runner, claude, and anything claude started (tool shells, MCP servers) that stayed in the group. The runner is
     the group leader because the adapter spawns it `detached`; the runner does this only when
     `CCLOOP_PARENT_WATCH_FD` is set, which only the adapter does.
- Paths that do not change: normal completion, phase timeout, abort and handoff interruption. `finish()` already
  SIGKILLs the group before destroying the streams.
- Why EOF is reliable: libuv creates the pipe with `O_CLOEXEC`, and Node passes a child only the fds listed in its
  `stdio`. A child the parent starts later does not inherit the write end; claude, started by the runner with three
  stdio pipes, does not inherit fd 3. This is a measured claim, not an inferred one: criterion T2 (§6) pins it.
- Not covered: a codex phase (`src/runtime/codex/runCodexPhase.ts`) spawns codex directly with no runner of ours in
  between, so nothing watches its parent. Its orphans are reaped only by §4.2.

### 3.2 R-A: claude never started

- The only evidence used is Node's own event order: when the runner spawns claude, an `error` event that arrives
  before any `spawn` event means the process never existed. This holds for `ENOENT`, `EACCES`, `EMFILE`, and every
  other spawn failure.
- Retry: only when `error.code === "ENOENT"`. At most `CLAUDE_SPAWN_ATTEMPTS = 3` spawns in total,
  `CLAUDE_SPAWN_RETRY_DELAY_MS = 2,000` apart. A SIGTERM / SIGINT or "parent gone" during the wait stops the retry.
  Cause measured on 2026-10-02: the reinstall window was one to two seconds.
- When the last spawn still fails, or for any other spawn failure, the runner writes the dedicated answer
  `{"claudeNeverStarted": true, "spawnError": "<code>: <message>"}` to stdout (waiting for the write callback, as
  every runner write already does) and exits 0.
- This branch is taken before the execute partial branch in the runner's `main` catch. Otherwise
  `buildPartialExecutionOutcome` could wrap a never-started call as an `error` partial.
- The adapter recognises the answer in `phase()` (and in the single-call path) and throws
  `claude-never-started: <spawnError> (<evidenceDir>)` with `observedTokens: 0`. `PhaseExecutionError` then carries
  `tokenUsage: 0`, `settlePhase` books 0, and the control worker reports 0 to Orca instead of null.
- The run still ends `failed` (H3 chose not to change the loop's terminal decision for this case).
- Why 0 is not an estimate: the definition of `observedTokens` (`src/runtime/types.ts`) forbids 0 for "not
  observed". Here 0 is observed: no process existed, so nothing could have been spent. The new answer is the only
  path that produces it.

## 4. resume / sweep side

### 4.1 Owner death

New module `src/ownership/ownerLiveness.ts`, one exported function `classifyOwnerProcess(processInstanceId)`
returning `dead`, `alive` or `undetermined` with a reason.

- Parse `pid:<pid>:<startMs>` (the form `buildProcessInstanceId` writes). Anything else ⇒ `undetermined`.
- `classifyProcessLiveness(pid)` from `src/persistence/fileStore.ts` (reused, not copied):
  `dead` ⇒ `dead`; `undetermined` (EPERM, pid 0, out of range) ⇒ `undetermined`.
- `alive` ⇒ read the current holder's start with `/bin/ps -o lstart= -p <pid>` under `TZ=UTC LC_ALL=C` (the form
  `stopProof` and the adapters already use), parse it to whole epoch seconds `S`.
  `S > floor(startMs / 1000)` ⇒ the pid was recycled after the owner started ⇒ `dead`. Anything else, including a
  failed or empty `ps` ⇒ `alive` or `undetermined` respectively. The rule only says `dead` when the holder is
  certainly a different process; it errs towards refusing.
- Assumption stated, not solved: one host. The lock-holder logic already assumes the same.

### 4.2 Reaping registered process groups

New module `src/ownership/reapRunProcesses.ts`, `reapRunProcesses(runDir)`:

- Find every `process.json` under `runDir`, excluding `worktrees/`. Each has `{pid, pgid, startedAt, phase}`; a file
  that cannot be read or parsed ⇒ refuse ("undetermined").
- Probe each group with the rule of `stopProof.defaultProbe`:
  - `kill(-pgid, 0)` gives ESRCH ⇒ quiet, skip;
  - any other error ⇒ refuse;
  - group present, leader's `lstart` equals `startedAt` ⇒ ours, reap;
  - group present, leader absent (`ps` finds no pid) ⇒ descendants of ours, reap;
  - leader present with a different `lstart` ⇒ refuse.
- Reap = SIGTERM to the group, wait `REAP_GRACE_MS` (5,000), SIGKILL, then poll until ESRCH or
  `REAP_TIMEOUT_MS` (15,000) ⇒ refuse on timeout.
- One `orphan_process_group_reaped` event per reaped group, detail `pid <pid> pgid <pgid> phase <phase>`.
- It writes nothing else and is idempotent: two racing resumes may both run it; the second finds nothing to reap.

### 4.3 resume, step by step (new steps in bold)

1. `resume_requested`; lease gate. A fresh lease refuses. (unchanged)
2. `readOwnerRecord` (unchanged, still runs interrupted-transfer recovery first).
3. **`classifyOwnerProcess(ownerRecord.currentProcessInstanceId)`: `alive` or `undetermined` ⇒ `resume_denied`,
   `ResumeNotEligibleError` naming the verdict and reason.**
4. **`reapRunProcesses(runDir)`: any refusal ⇒ `resume_denied`, nothing written but the events.**
5. Read `owner-transfer.json`, `reconciliation-record.json`, `loop-state.json`, `loop-contract.json` as today.
   **If and only if `owner-transfer.json` (and with it `reconciliation-record.json`) is absent with ENOENT, the
   run status is resumable, and the owner record's `leaseAffirmedAt` is a timestamp older than `LEASE_TTL_MS`
   (expired, not released), write them through the existing `writeOwnerTransferArtifacts`** with the step-2 record
   as the CAS expectation. A `null` lease means the owner released it on purpose (a stop or handoff boundary), which
   is not a crash: refuse with `no owner transfer and the lease was released, not expired: not a crashed run`.
   The write:
   - transfer from `applyOwnerEpochTransfer(ownerRecord, buildProcessInstanceId(), now, "owner process confirmed dead by resume")`;
   - reconciliation: `staleSuspicionBasis` = [the lease's `leaseAffirmedAt` and the step-3 verdict text],
     `staleConfirmed: true`, `ownershipVerdict: "OWNER_LOST"`, `lastTrustedBoundary` from the run status
     (`planning`/`executing`/`verifying` ⇒ `planning`/`execute`/`verify`), `conflictingEvidence: []`,
     `takeoverPermission: {allowed: true, reason: "owner process confirmed dead by resume"}`,
     `priorOwnerEpoch` = current, `newOwnerEpoch` = the transfer's, `eligibleForContinuation: true`;
   - event `owner_crash_adopted`, detail `epoch <prior> -> <new>: <prior instance id> confirmed dead (<reason>)`;
   - a CAS or lock failure ⇒ `resume_denied` with the same detail mapping the claim step already uses. Two racing
     resumes: exactly one CAS succeeds.
   Any other read failure keeps today's `cannot read run artifacts: …` refusal.
6. Eligibility (8 criteria), claim CAS, `resume_adopted`, heartbeat, residual worktree cleanup, loop. (unchanged)

Behaviour change on an existing path, stated for the human: steps 3 and 4 also run for runs that already have a
transfer record. Today those continue on lease expiry alone; after this change they also need the owner confirmed
dead and every registered group reaped or quiet, and are refused when either cannot be determined.

### 4.4 sweep

- Candidates become two classes:
  - (a) unchanged: `owner-transfer.json` observed with `eligibleForContinuation` literally true;
  - (b) new: no `owner-transfer.json` row, `loop-state.json` status observed as `planning`, `executing` or
    `verifying`, and `owner-record.json` `leaseAffirmedAt` observed as a timestamp older than `LEASE_TTL_MS` at
    scan time. A `null` (released) lease is not a candidate, for the reason given in §4.3 step 5.
  Both sorted together by path, then truncated to `--max-runs`, as today.
- Banner: the existing line is kept byte for byte (it counts class (a) only, and `will attempt at most N` stays
  true of the union). When class (b) is non-empty, one more line follows it:

  ```
  sweep: <K> run(s) under <root> have no owner-transfer.json, a resumable status and an expired lease (observed fields; each is resumed only if its owner is confirmed dead), counted within the same at most <N>
  ```

  **This wording is for the human to approve verbatim (H5).** With K = 0 nothing is added, so every existing
  banner criterion keeps reading what it reads.
- Each candidate goes through the same `resumeLoop`; a refusal refuses that run only, as today.
- The `note … owner_transfer_lock_present` lines are unchanged.

### 4.5 README

§3.2 is rewritten to say what `resume` now does for a killed run (owner confirmed dead, groups reaped, transfer
written by resume) and what it refuses. §3.4 gains the second banner line.

## 5. Loop side: R-B

### 5.1 A: a partial with changed files goes to verify

In `runLoopFromState`'s `isPartialExecutionResult(completedExecution)` branch (`src/controller/runLoop.ts`), after the
path-policy check and before the terminal decision:

- `failureType === "error"` and `changedFiles.length > 0` ⇒ write the attempt artifacts as today, append
  `partial_execute_sent_to_verify` (detail `failureType error, <n> changed file(s): <failureMessage>`), and continue
  into the same verify step a complete execution takes. Verify passes ⇒ today's success path. Verify fails ⇒
  today's verify-failure path (attempt spent; next attempt or today's terminal rule).
- Unchanged: `failureType === "timeout"` ⇒ `exhausted`; `error` with no changed files ⇒ `failed`; a path-policy
  human gate ⇒ `blocked_waiting_human`; the thrown-error branch (`PhaseExecutionError`, no result from the runner).
- Why this is safe: the verify phase runs `requiredChecks` in the worktree and the verifier judges the result, so a
  partial that really broke something is rejected there. Nothing new is trusted from the model.

### 5.2 B: the execute prompt names who runs the checks

`buildExecutorPrompt` (`src/runtime/claude/prompts.ts`) gains, after the success condition:

```
Required checks (run by the verifier in this worktree after you finish):
<the contract's requiredChecks list>
If you cannot run a command (for example it needs approval), do not report partial or error for that reason; deliver your changes and say in stdoutStderrLog which commands you could not run.
```

Honest statement: only a static criterion can pin this (the prompt contains the text). Whether real claude follows
it has no cheap verification; §5.1 is the guarantee, §5.2 only reduces needless partials.

## 6. Criteria

All under fake claude, only in a `git clone --local` copy, HOME and the four XDG roots redirected, a short real
TMPDIR. Each new branch is paired with the mutation that deletes that branch, and the mutation must be seen red.

| | Criterion | Guards |
|---|---|---|
| T1 | A fake ccloop process that started a runner is SIGKILLed; the runner and fake claude are gone within `PARENT_GONE_GRACE_MS` plus a margin | §3.1 |
| T2 | Same, while an unrelated long-lived child of the killed parent is still alive | §3.1 EOF reliability |
| T3 | In one process, phases ending in each way (complete, timeout, abort, spawn-error, io-error) leave the `/dev/fd` count unchanged | §7 fd leak |
| T4 | claude's command absent at the first spawn and present at the second: the phase completes, one paid call | §3.2 retry |
| T5 | claude's command absent throughout: the run ends `failed`, the phase's booked usage is 0, not null; the control usage observation carries 0 | §3.2 usage |
| T6 | A run SIGKILLed mid-execute, after its lease expires, is continued by `resume --agents` to `succeeded` without seeded files; events show `owner_crash_adopted` and `resume_adopted` | §4.3 |
| T7 | Owner alive / `undetermined` / recycled pid: refuse, refuse, adopt; a released (`null`) lease with no transfer: refused as not crashed, and not a sweep candidate | §4.1, §4.3 step 5 |
| T8 | A registered group with a mismatching `lstart`, an unreadable `process.json`, a group that outlives `REAP_TIMEOUT_MS`: each refused, and nothing but events written | §4.2 |
| T9 | Two resumes race on one killed run: exactly one adopts | §4.3 step 5 |
| T10 | sweep over (a), (b) and a refused (b) run: banner lines as §4.4, the refused run does not stop the rest | §4.4 |
| T11 | `partial`+`error`+changed files: goes to verify; verify passes ⇒ `succeeded`; verify fails ⇒ next attempt; no changed files ⇒ `failed` | §5.1 |
| T12 | The executor prompt contains the required checks and the instruction | §5.2 |

Existing criteria: the run-without-transfer refusal, the partial-error terminal, sweep candidacy and the
`zeroWrite` sweep proofs are pinned by existing tests. The plan names each one after a mechanical tree scan (scan
terms derived from the changed sentences: `owner-transfer.json`, `cannot read run artifacts`,
`observed eligibleForContinuation=true`, `completionStatus: "partial"`, `failureType: "error"`). **Each rewrite
needs the human to name that test under ruling 88 (named, whole rewrite, no loosening, ruling recorded).** New
coverage is added rather than rewritten wherever possible.

Gate: typecheck and build RC 0; `node scripts/check-known-reds.mjs` RC 0 (only `stopProof` red);
`node scripts/check-tmp-leak.mjs` RC 0. `agentsControl` and `evidence` are known load flakes: rerun the file
alone before calling either a regression.

## 7. Capacity

### 7.1 Measured limits (2026-10-02, this machine, `ulimit -Sn`, `ulimit -Hn`, `sysctl`)

| | Value |
|---|---|
| fd soft / hard limit (shell) | 1,048,576 / unlimited |
| `kern.maxfilesperproc` | 122,880 |
| `kern.maxfiles` | 245,760 (11,119 in use at measurement) |
| `kern.maxprocperuid` | 5,333 |
| `kern.maxproc` | 8,000 |

### 7.2 What this round adds and what binds

- This round adds two fds per live runner: the write end in the parent (Node closes the read end in the parent after
  the spawn) and the read end in the runner. Each child already used three stdio pipes.
- A ccloop run runs one phase at a time; Orca starts each run as its own worker (`stdio: "ignore"`, `unref`, in
  `src/control/workerLauncher.ts`), so the panel holds no fd per task and no single process accumulates fds with the
  number of parallel tasks. The per-process limit is not the binding one.
- The shared limits are system-wide fds and per-user processes. Every task in flight is at least three node
  processes (worker, runner, claude), plus claude's tool shells and MCP servers. The per-user process limit is
  expected to bind first; this is an expectation, not a measurement.
- The real risk this round adds is a leak, not the count: a long-lived Orca worker runs many phases, and a missed
  close of the write end leaks one fd per phase until `EMFILE`. T3 guards it.
- At the limit: a failed pipe creation when the adapter spawns the runner takes today's `spawn-error` path; an
  `EMFILE` when the runner spawns claude is "never started" (§3.2), not retried.

### 7.3 Measurement (approved, H7)

- Under fake claude, this round's criteria record fds and processes per phase in flight, as a lower bound, in the
  ledger.
- Under real claude, the measurement rides on this round's paid acceptance run (§9): while an execute is in flight,
  count the processes in the runner's group and the fds of each (`lsof -p`), once per process. Both raw outputs are
  kept. Only measured numbers are recorded.
- Orca registers "maximum tasks started at once" as an open item: derived from the measured per-task process and fd
  counts against `kern.maxprocperuid` and `kern.maxfiles`, with headroom.

## 8. Orca

- Orca's driver uses its own recovery and does not call `ccloop resume`; this round requires no Orca change.
- Orca benefits without a repin once it repins for another reason: the runner watch protects Orca's workers too,
  and R-A's 0 reaches Orca through the existing usage observation.
- Repin only if Orca comes to depend on the new behaviour: ccloop commit → the human pushes ccloop →
  `node scripts/pin-ccloop.mjs <SHA>` in Orca → the human pushes Orca.

## 9. Paid acceptance

One paid real-claude run at the end, asked for separately before it starts (the measurement in §7.3 is approved;
the crash-and-resume run it rides on still needs the human's nod): `run --agents` with a small task,
SIGKILL ccloop during execute, show the runner and claude gone within the grace, wait out the lease,
`resume --agents` to a terminal state, and record the §7.3 numbers. Spend is reported only from claude's own
`total_cost_usd`.

## 10. Out of scope

- Changing the terminal decision for a never-started claude (H3 chose not to).
- Allowing the executor to run commands (H2 rejected that candidate).
- A codex runner, to give codex the parent watch.
- Multi-host ownership.
- Orca's concurrent-start cap itself (registered, §7.3).
