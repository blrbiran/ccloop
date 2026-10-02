# SDD ledger — plan: docs/superpowers/plans/2026-10-02-crash-resume-and-orphan-reaping.md

Controller: Orca session ece96b67 (Claude Opus 5.5), 2026-10-02, working in ccloop on `main` (local commits only, no push).
Spec: docs/superpowers/specs/2026-10-02-crash-resume-and-orphan-reaping-design.md (subject lines `docs(spec): …crash resume…`, four commits).
Human authorization for this session (H8, verbatim): "这一轮执行过程中如果有问题，先按你的建议执行（不要再找我）。执行完在最后阶段报给我审核。"

## Pre-flight rulings
- Ruling: work on `main` with local commits, no worktree — ccloop's history lands rounds on local `main` and deleting a worktree needs a human (CLAUDE.md Rule 13); cost if wrong: the commits would have to be moved to a branch by the human before push.
- Ruling: this file (the SDD workspace path) replaces the ledger path named in plan Task 10 (`.superpowers/sdd/2026-10-02-crash-resume/progress.md`) — the skill's workspace script owns the location; cost if wrong: none (one path).
- Ruling: R1 (owner check only on adoption) and R2 (sweep class b needs an expired lease timestamp) are in spec §11, pending human ratification.

## Pre-flight scan
| Pair / task | Shared | Finding |
|---|---|---|
| T1 ↔ T3 | runner globals `parentGone`, `claudeEverStarted`, `lastSpawnFailure` | T1 declares `parentGone=false`, T3 sets it; consistent |
| T1 ↔ T9 | runner `main` catch and structured path | different blocks; consistent |
| T2 ↔ T3 | adapter `run()`/`phase()` | T2 touches `phase()`/`singleCall()` head, T3 `run()` spawn and `finish()`; consistent |
| T2 ↔ T9 | `src/runtime/types.ts` | different declarations; consistent |
| T4 → T5, T6 | `readProcessStart`, `classifyOwnerProcess` signatures | consistent |
| T6 → T8 | `isOrcaControlRunDir(runDir): Promise<boolean>` | consistent |
| T7 ↔ T8 | README §3.2 / §3.4 | different sections |
| T1 self | tests vs code | consistent |
| T2 self | runLoop-level case offers a fallback (stub adapter) | allowed by its own text |
| T3 self | T3 fd-leak "spawn-error" ending may be unreachable in-process | Ruling: cover the reachable endings, name the unreachable one in the report — cost: one ending unmeasured |
| T4 self | consistent |
| T5 self | consistent |
| T6 self | consistent |
| T7 self | Step 2 red may need a clone-level revert; allowed by its own text |
| T8 self | consistent |
| T9 self | requires reading downstream of the partial branch before falling through; stated in the task |
| T10 | controller-only | — |

## Tasks
Task 1: complete (commits a079bf3..d2ede88, review clean; reviewer sonnet: spec ✅, quality Approved)
Task 1: minor (deferred): "three spawns" criterion pins only the lower bound (passes for ≥4 attempts) — carried into Task 3 (add upper bound)
Task 1: minor (deferred): claudeEnv strip of CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS unpinned — carried into Task 3's env criterion (M3c covers all three runner variables)
Task 1: minor (deferred): post-wait interrupt re-check, `!interruptHandled` retry term, ESPAWN fallback, sync-throw branch have no deleting mutation; sync throw is hard to trigger from outside — for the final review
Task 1: minor (deferred): handleInterrupt condition uses a stale lastSpawnFailure in an unreachable window — wants a comment
Task 1: minor (deferred): second-spawn test writes then chmods (tiny EACCES window) — rename-after-chmod would remove it
Task 2: review (sonnet) — Needs fixes: Important = execute() catch swallows the never-started abort (null, not 0; spec §3.2/T5b) and test 5 pins that; Minor = fixed-1500ms abort timing; controller hardening = never-started answer must have exactly two keys
Task 2: Ruling: an aborted never-started execute rethrows so runLoop books 0 — spec §3.2 says the 0 reaches the booked usage on the abort path; cost if wrong: an aborted execute's usage is 0 instead of null, which is true (no process existed)
Task 2: fix round 1/5 (3 addressed, 0 open; commits 72b5f33..3c7e965)
Task 2: complete (commits d2ede88..3c7e965, review clean after one fix round)
Task 2: minor (deferred): abort tests wait on request.json + 300 ms, not on evidence of the first ENOENT — small residual timing assumption
Task 2: minor (deferred): the two-key check is pinned only through the runner's merge (a raw lookalike stdout cannot be produced through the fake CLI)
Task 3: implementer (opus) DONE — commits 72a84d0, 426c459, 22cefdb, b69fbb3; 14 mutations, 11 red, 3 green with reasons (M3d fd-3 destroy invisible: Node closes the socket at child exit; M3h readStdin wrap invisible; M3j paused-socket variant); capacity lower bound (fake claude): 2 processes in the runner group, fds runner 20 / fake claude 14 / parent stand-in 18; fake claude did not inherit fd 3
Task 3: Ruling: T3's ledger claim is "no per-phase fd growth", not "guards the fd-3 destroy" — its M3d stays green for a measured reason; cost if wrong: an fd-3 leak in finish() would be unguarded (Node closes it at exit anyway)
Task 3: Ruling (controller, pending human ratification): Task 1's "three spawns" criterion rewritten to a 700 ms delay with bounds 1400–2050 ms so 3 vs 4 attempts separate with margin — same-round criterion, tightened not loosened
Task 3: complete (commits 3c7e965..b69fbb3, review clean; reviewer opus: spec ✅, Approved)
Task 3: minor (deferred → carried into Task 9, which edits the runner): parent gone after the request is read but before the first spawn still spawns claude (up to the 5 s grace of spend); add `if (parentGone) return;` after readStdin and a parentGone check before the first spawn
Task 3: minor (deferred): a bad fd 3 is treated as parent gone — comment should say it is on purpose
Task 3: minor (deferred): the three-spawns upper bound (2050 ms) may flake under full-suite load — watch it in the gate; if it flakes, count attempts instead of widening
Task 3: minor (deferred): RF4 is an outcome check ("Review Focus 4 outcome"), not a guard on the watch; T3 is "no per-phase fd growth"; the runner waits the full grace after claude exits on SIGTERM (bounded)
Task 4: Ruling: plan defect — brief read the year from match[7] of a 6-group regex; implementer used match[6]; the plan text is left as written (historical), this ledger line is the correction; cost if wrong: none (tests pin the parse)
Task 4: complete (commits b69fbb3..23b71dc, review clean; reviewer sonnet: compliant, Approved)
Task 4: minor (deferred, candidate for the final fix wave — fail-closed direction): an unparseable non-empty lastAffirmedAt/leaseAffirmedAt silently falls back to startMs, lowering R; should be `undetermined`
Task 4: minor (deferred): pid 0 not rejected up front (still safe); Date.UTC field ranges unchecked (ps never emits them); readProcessStart reason string coarse; one vacuous assertion in the dead-child test
Task 5: review (sonnet) — Needs fixes: Important = no test for probe-all-then-reap; no idempotence test. Minor = unstubbed signalGroup in mocked refusals (a mutation could signal a foreign pgid), readdir errors swallowed, lstart not re-read before SIGTERM, appendEvent throw after reap, outcome.json isFile edge
Task 5: Ruling: readdir errors other than ENOENT refuse, and lstart is re-read before SIGTERM — spec §4.2 "refuse when unsure"; cost if wrong: a resume refuses on an unreadable directory it could have ignored
Task 5: fix round 1/5 (5 addressed, 0 open; commits 9be3811..5672aa7; implementer reported M5d/M5e/M5f/M5b red in clones)
Task 5: complete (commits 23b71dc..5672aa7, review clean after one fix round)
Task 5: minor (deferred): appendEvent throwing after a reap rejects instead of returning a ReapResult (re-run safe); outcome.json counted only when isFile(); TOCTOU between the pre-SIGTERM re-check and kill (cannot be closed from user space); chmod-000 test vacuous under root
Task 6: implementer (opus) DONE — commits 188b9cd, fdef708 (ERRATUM on the published refusal list in resumeLoop comments); clone full suite 1106/1107 (only stopProof red); M6a–M6d red; no existing criterion rewritten
Task 6: Ruling: the Orca guard runs before readOwnerRecord (brief order) rather than after it (spec numbering) — readOwnerRecord can run transfer-lock recovery, i.e. write, so refusing first keeps resume write-free on Orca runs; cost if wrong: none observable (same refusal)
Task 6: Ruling: a terminal run without a transfer keeps today's `cannot read run artifacts: … ENOENT` — spec §4.3 step 6 adopts only resumable statuses; cost if wrong: an imprecise refusal text for a finished run
Task 6: review (opus) — Approved with one spec-level Important: on the adoption path the reap ran before the owner check, so a resume refusing "owner alive" could already have killed the live owner's claude call
Task 6: Ruling: on the adoption path the owner is classified before reaping and alive/undetermined refuses without reaping; transfer runs keep reap-then-today's-path (R1) — "any doubt refuses" must not be preceded by a destructive act; cost if wrong: none (strictly fewer kills); spec §4.3 to be amended to match
Task 6: Ruling: an append failure after a committed adoption gets its own refusal detail, not `claim CAS failed` — audit truth; cost if wrong: none
Task 7: implementer (sonnet) DONE — commit f589ee3 (test + README §3.2 + report); red only via pre-Task-6 resumeLoop in a clone
Task 7: review (sonnet) — Needs fixes: Important = fake-claude death read from <marker>, which may still hold the dead plan-phase pid (vacuous pass); Minor = 3 s margin tight, probe walk throws on missing entries, README "no orphans" sentence overstates (codex has no watch; 5 s grace)
Task 7: fix round held until Task 6's fix round commits (same repository, avoid concurrent commits)
Task 6: fix round 1/5 (4 addressed, 0 open; commits f589ee3..03c6128; implementer: typecheck RC 0, MF1/MF2 red, MF3 green ⇒ T9 comment names tests/persistence/fileStore.test.ts as the CAS home)
Task 6: complete (commits 5672aa7..03c6128 plus spec 532d3b9, review clean after one fix round)
Task 6: minor (deferred): T9 cannot see a CAS bypass (loser always loses on the lock); exactly-once rests on fileStore CAS criteria
Task 6: minor (deferred): after an event-append failure the resume_denied append likely fails too (benign: next resume takes the transfer path); `replaced` check not tied to the write; test temp dirs not removed
Task 7: fix round 1/5 (4 addressed, 0 open; commit 532d3b9..6ce587a; watchParent-off mutation red: "timed out waiting for the runner to die with its parent")
Task 7: complete (commits fdef708..6ce587a minus Task 6's interleaved commits, review clean after one fix round)
Task 7: minor (deferred): single-Ctrl-C lease release has no pinning test (README says so); probe hardcodes claude/1/execute
Task 8: implementer (sonnet) DONE — commit 29e32b5; M8a–M8c red; no existing criterion rewritten
Task 8: review (sonnet) — Needs fixes: Important = sweep's Orca control-run exclusion pinned by no test (deleting it stays green)
Task 8: fix round 1/5 (1 addressed, 0 open; commit 29e32b5..a7acbea; M8d red)
Task 8: complete (commits 6ce587a..a7acbea, review clean after one fix round)
Task 8: minor (deferred): the control-run test's tmpdir is not removed (scopeTmpdir covers it per file)
Task 9: implementer (opus) DONE — commit bef7503; clone full suite 1123 tests, only stopProof red, check-known-reds RC 0, check-tmp-leak RC 0, build/typecheck RC 0; M9a–M9e red
Task 9: Ruling (controller, pending human ratification): existing criterion tests/control/materialize.test.ts "puts the continuation input itself into the plan and execute prompts" — its fixture contract gains `verification: { requiredChecks: ["true"] }` (a field every real contract carries) because the executor prompt now reads it; no expectation changed, nothing loosened; encodes spec 2026-10-02 crash-resume §5.2
Task 9: Ruling: a codex `error` partial with changed files also goes to verify — codex partials are always the model's own answer (no runner builds them), which is exactly the class §5.1 sends to verify; cost if wrong: a codex partial gets verified instead of failed immediately
Task 9: note: the two parent-gone pre-spawn guards cover each other (each alone is invisible; both removed ⇒ red)
Task 9: complete (commits a7acbea..bef7503, review clean; reviewer opus: Approved)
Task 9: minor (deferred → final fix wave): no test pins execution.json staying the partial after verify; failureType==="error" condition has no named mutation (M9g); spawnClaude first-attempt parentGone guard is redundant with main()'s return (comment or drop)
Final review (opus): no Critical. Important: I1 three published comments now false without ERRATUM (+README table row); I2 ledger not committed / Task 10 open. Minor: M1 codex partials ruling should be pending ratification; M2 abort racing never-started books null; M3 README order; M4 stale unfinished call refusal should name its directory; M5 TERM-honoured reaper test cannot see a skipped SIGTERM; M6 timing-fragile criteria (watch in gate); M7 afterEach SIGKILLs possibly-recycled pids. Deferred minors: none must be fixed before push (triage recorded in the review); M9g effectively closed (T11e uses a timeout partial with changed files).
Ruling (controller, pending human ratification): codex `error` partials with changed files go to verify (relabelled from the Task 9 line, per final review M1)
Final fix wave: one dispatch for I1, M2, M3, M4, M5; M6/M7 stay registered; I2 is the controller's Task 10
Final fix wave: commits fc47fc5, 55ceb1b (+ spec 0aaa59a); scoped re-review (sonnet): all 5 ADDRESSED, no new breakage; out-of-scope: claudeAgentAdapter.ts:35 field comment "never 0" true as written (optional ERRATUM, registered)

## Task 10: gate, paid acceptance, capacity (controller)

Ruling: plan Task 10's ledger path is superseded by this workspace path (pre-flight ruling above); this file is force-added with every task report.

### Gate (fresh `git clone --local` at `docs(spec): record the round's implementation-time corrections, codex partials included`)
Env: HOME + four XDG roots redirected into the session scratchpad `gate/`, TMPDIR=`/private/tmp/cl-O2Br`, ECC_GATEGUARD=off DISABLE_OMC=1. Raw outputs: scratchpad `gate/*.txt`, `gate/vitest.json`.
- `npm run build` RC 0; `npm run typecheck` RC 0.
- `./node_modules/.bin/vitest run --reporter=json`: 1124 tests, 1123 passed, 1 failed, 0 pending. The one red: `tests/control/stopProof.test.ts > quiet execution proof does not treat leader exit as group quiet and proves only after the full tree is gone` (known stable red).
- `node scripts/check-known-reds.mjs gate/vitest.json` RC 0 (roster 9, failed 1, unexpected 0). `node scripts/check-tmp-leak.mjs` RC 0 ("vitest exit 1, 1124 tests, 0 entries left").
- Load: 1-minute load 6.69 before, 23.80 after (`uptime`). `pgrep -fl "fake-claude-cli|claude-phase-runner|runner-parent"` RC 1 afterwards.
- The timing-fragile criteria flagged by the final review (three-spawns bounds, T5b, abort-wait) were green in this run.

### Paid acceptance (spec §9; authorized by H7/H8), 2026-10-02 09:10:25Z–09:12:4xZ
Setup: ccloop `dist/` from the gate clone; agents table drafted by `ccloop agents detect` (claude 2.1.287 at `~/.nvm/versions/node/v22.13.1/bin/claude`, isolation arguments as drafted, `--max-budget-usd` lowered to 1, command wrapped by Orca `scripts/claude-tee.mjs` to keep raw streams); selection `claude-opus-5-5`, agent-default window; CLAUDE* variables unset, HOME not redirected (OAuth in keychain). Target: scratch git repo; task "create greet.txt containing hi"; command verifier `test "$(cat greet.txt)" = hi`; tokenBudget 1,000,000, maxAttempts 2. First attempt of the script failed before any claude call (contract rejected: `buildTestCommands` must be non-empty) — no spend; fixed and rerun.
- `run --agents` started; at the execute call's `process.json` + 5 s, the runner group was `runner (pid 78166, pgid 78166) → claude-tee → claude` (`gate/../paid/group-before.txt`).
- `kill -9` ccloop's own pid only (77324) at 09:10:39Z. The runner group was gone within 5 polls of 0.5 s; `ps -g 78166` afterwards RC 1. Loop state left `executing`.
- After 95 s (real lease expiry), `ccloop resume --run-dir … --agents …` RC 0. Events: `loop_planning, attempt_started, execute_started, resume_requested, lease_expired_observed, owner_crash_adopted, resume_adopted, attempt_started, execute_started, execution_finished, loop_succeeded`. Final status `succeeded`, attemptsUsed 2; `refs/ccloop/run/attempts/2:greet.txt` = `hi\n`.
- claude install dir mtime identical before/after (no reinstall during the run); `~/.claude/projects` listing identical before/after; no runner/tee process left (`pgrep` RC 1).
- Spend (claude's own `total_cost_usd`, nothing estimated): plan (attempt 1) $0.155672; plan (attempt 2) $0.0227602; execute (attempt 2) $0.060769; sum $0.2392012. The killed execute (attempt 1) has no result envelope: its cost is not available.
- n = 1, one target. This proves, under real claude: the parent watch kills runner + claude after a SIGKILL of ccloop; resume adopts the killed run without seeded files and continues it to success. It does not prove the reaper under real claude (nothing was left to reap), nor R-A or R-B under real claude.

### Capacity (spec §7.3)
- Fake claude (Task 3): runner group 2 processes; numeric fds runner 20, fake claude 14.
- Real claude (this run, `lsof -p` per member 5 s into execute): runner group 3 processes — runner 10 fds, claude-tee 8 fds (acceptance-only wrapper, absent in production), claude 18 fds. ccloop's own process (one per task) was not measured. claude had no tool subprocess at the sample moment, and `--strict-mcp-config` with no MCP config starts no MCP servers.
- Derived (arithmetic on the measured numbers, not a measurement): in production a task in flight is at least 3 processes (ccloop/worker, runner, claude) and ≥ 28 fds in the runner group; against `kern.maxprocperuid` 5,333 that is ≤ ~1,700 concurrent tasks before tool shells and anything else the user runs. Orca's "maximum tasks started at once" should be set well below that, and re-measured with tool-using tasks.

## Human ratification and scratchpad cleanup (2026-10-02, Orca session 7fe6d61b; lands in the commit `docs(sdd): record the human ratification of the crash-resume round's pending rulings`)

- Human ruling: "同意" to all six items marked pending human ratification — R1, R2 (pre-flight line / spec §11), the sweep second banner line (spec §4.4), Task 3's three-spawns criterion tightened to a 700 ms delay with bounds 1400–2050 ms, Task 9's `tests/control/materialize.test.ts` fixture gaining `verification: { requiredChecks: ["true"] }`, and codex `error` partials with changed files going to verify. The lines above keep their "pending" wording (history unchanged); this entry closes them. Spec §13 records the same.
- Human ruling: delete the session scratchpads' `gate/` and `paid/` (session ece96b67) and `live-n1/` (session b5e8d368) once no longer needed. Done in this session after checking: no process held them; the only non-`node_modules` untracked files were the N1 driver script (byte-identical to Orca's committed `scripts/live-requirement-acceptance.ts`) and two `plan.json` inputs; every result was already transcribed into this ledger and Orca's N1 ledger. ⇒ The raw-output paths cited in "Task 10" above (`gate/*.txt`, `gate/vitest.json`, `paid/*`) no longer exist; the numbers recorded here are the only copy.

## Paid acceptance, round 2: R-A, R-B, reaper under real claude (2026-10-02, Orca session 7fe6d61b; lands in the commit `docs(sdd): record the second paid acceptance of the crash-resume round`)

Human ruling (Orca session 7fe6d61b): "下一件选：重钉 ccloop + 付费验证 + N5 memory tab", then "同意，继续" on a stated estimate under $1.5. Build: a `git clone --local` of this repository at `ae2caa3` (the pushed tip carrying the round), `npm run build`. Driver: `paid.py` in that session's scratchpad (not committed). Agents table: `ccloop agents detect`'s claude entry (claude 2.1.287 at `~/.nvm/versions/node/v22.13.1/bin/claude`), `--max-budget-usd` lowered to 1; for R-B and reaper the command was wrapped by Orca `scripts/claude-tee.mjs` to keep the result envelopes. Selection `claude-opus-5-5`, agent-default window; CLAUDE* unset, HOME not redirected (keychain OAuth), as in round 1. Command verifier everywhere. Each scenario recorded the claude install-dir mtime and the `~/.claude/projects` listing before and after: identical in all three. The install dir was re-installed once at 12:15:00Z (mtime; version still 2.1.287), between R-A and R-B. `pgrep -fl "claude-phase-runner|claude-tee|fake-claude-cli|fake-codex"` RC 1 at the end.

- R-A (11:37:59Z–11:38:12Z, maxAttempts 1): the claude command was a wrapper that answers `--version` and deletes itself on its first real call, so plan ran and execute's spawn hit ENOENT. Execute's runner answered `{"claudeNeverStarted":true,"spawnError":"ENOENT: …"}`, stderr empty; `ClaudeNeverStartedError` failed the attempt; status `failed`. Booked usage: `tokenBudgetRemaining` 980,801 of 1,000,000, i.e. 19,199 = the plan call's `normalizedTotal` exactly, so execute booked 0. Spend: not available (no tee on this scenario; ccloop keeps no result envelope). First try refused before any spend: the wrapper tested `$1` for `--version`, but ccloop probes `[...command, "--version"]` with the flag last, so the first probe deleted it (`agent-version-drift`-class refusal "answered no x.y.z"); fixed to test every argument.
- R-B (12:17:12Z–12:17:49Z, maxAttempts 2): `--permission-mode acceptEdits`, goal "create greet.txt … and make sure `sh check.sh` passes (run it to confirm)", required check `sh check.sh`. Claude's execute answered a complete object (no `completionStatus`), saying in `stdoutStderrLog` it could not run `sh check.sh` because it needed approval; verify ran the check, approved; `succeeded` in 1 attempt. ⇒ The N1 run's R-B outcome did not recur, through §5.2 (the prompt names the verifier). §5.1 (a self-reported `partial` + `error` with changed files goes to verify) was NOT exercised under real claude. Spend (claude's own `total_cost_usd`): plan $0.0313664, execute $0.1855114; sum $0.2168778.
- Reaper (12:18:17Z–12:20:43Z, maxAttempts 2): at execute's `process.json` + 5 s the group was runner 45446 (leader) → claude-tee 45463 → claude 45464. SIGSTOP the runner (so its parent watch cannot act), SIGKILL ccloop. 3 s later: runner, tee, claude all present. During the 95 s lease wait claude finished its execute on its own; before resume the group was the stopped runner and a defunct tee. `ccloop resume --agents` RC 0; events `resume_requested, lease_expired_observed, orphan_process_group_reaped (pid 45446 pgid 45446 phase execute), owner_crash_adopted, resume_adopted, attempt_started, execute_started, execution_finished, loop_succeeded`; group empty afterwards. ⇒ Under real processes the reaper recognised its group by the leader's `lstart` and reaped it; it did NOT kill a live claude (claude had already exited). Spend: plan 1 $0.0221482, killed execute 1 $0.0550072 (it completed before the reap), plan 2 $0.0227482, execute 2 $0.0615138; sum $0.1614174.
- Total claude-reported spend this round: $0.3782952, plus R-A's plan call (not available). n = 1 per scenario.
