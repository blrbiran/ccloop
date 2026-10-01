# Live claude: partial after interrupt, resume --agents (2026-10-01, Orca session b5e8d368)

Human (2026-10-01): "允许跑" (paid real-claude runs of the two unverified paths); "不需要提示，直接不支持就好"
(drop the --adapter removal message); approved every Ruling of the consolidation ledgers.

## Setup
- claude 2.1.286 (`~/.nvm/versions/node/v22.13.1/bin/claude`), `--model claude-opus-5-5`, agent-default window.
- Agents table from `agents detect` (isolation arguments as drafted), `--max-budget-usd` lowered to 2 per call, command
  wrapped by Orca `scripts/claude-tee.mjs` to keep each call's raw stream. CLAUDE* variables removed; HOME not
  redirected (OAuth lives in the keychain). Contracts: command verifier, tokenBudget 1,000,000,
  partialOutcomeRecoveryWindowMs 30,000. Everything under the session scratchpad `live/`; ccloop built from
  `git clone --local`.

## P: execute cut by its own 90 s phase timeout (task: ten ~400-word files)
- P1 (build = `refactor(cli): refuse an unknown flag …`, 12:53:19Z–12:55:00Z): runner exited 0 with a partial on
  stdout, but stdout.json was exactly 8192 bytes and not valid JSON. The adapter could not parse it, so the run took
  the `execution === null` branch: no execution.json, only execution-recovery.json, terminal `exhausted` with the
  phase-timeout reason. Usage observed before the stop (input+output 6,866) was not booked (budget used 19,554 =
  plan only).
- Cause: the runner's interrupt path called process.exit right after process.stdout.write returned true. On macOS a
  pipe write is asynchronous and process.exit drops the queue. Reproduced without claude (scratchpad `trunc/`):
  payloads of 12 KB–40 KB arrive as 8192 bytes 5/5; 4 KB, 8 KB and 100 KB (drain branch) arrive whole. Exiting on
  the write callback: all sizes whole 5/5.
- Fix: commit `fix(claude): deliver an interrupted execute's partial whole instead of cut at 8192 bytes`. New
  criterion `claude phase runner > delivers a partial larger than one pipe chunk whole after SIGTERM`, red before the
  fix (`expected 8192 to be greater than 16384`), green after.
- P2 (build = the fix, 12:58:38Z–13:00:20Z): execution.json `completionStatus: partial`, `failureType: timeout`,
  6 changed files, diffPatch 15,628 bytes, `tokenUsage` 195,810 filled from the observation and booked
  (tokenBudgetRemaining 784,619); terminal `exhausted` with `claude phase runner interrupted by SIGTERM`;
  `refs/ccloop/p2/attempts/1` holds the files.

## R: resume --agents after a crash
- R1: `run --agents` started in its own process group, SIGKILLed 3 s after `execute_started`. Loop state stayed
  `executing`. The runner and claude survived (the adapter spawns the runner `detached`, so it is not in ccloop's
  group) and finished the execute on their own as orphans.
- `resume --agents` at once: refused, `run lease is held by pid:… for another 67492ms` (by design).
- After the lease expired: refused, `cannot read run artifacts: ENOENT … owner-transfer.json`. Finding: resume and
  sweep only continue a run whose own loop published an owner transfer (stale_candidate + OWNER_LOST at a boundary,
  runLoop.ts persistOwnerTransfer); a run killed outright never writes one, so no CLI path continues it, and the
  refusal names a missing file instead of saying why. README §3.2 says resume "接管一个被中断的 run".
  Not changed: whether a crashed run should become resumable is a design decision for the human.
- R2: seeded owner-transfer.json / reconciliation-record.json (and owner epoch 2) in the shape of
  `tests/cli/agentsResume.test.ts`'s `seed`, then `resume --agents` (13:04:44Z–13:05:12Z): RC 0, `resume_adopted`
  epoch 2, attempt 2 plan + execute by real claude, command verifier passed, `succeeded`;
  `refs/ccloop/r1/attempts/2:hello.txt` = `hi\n`; the stale attempt-1 worktree was committed to its ref and removed.
  This verifies the adapter rebuilt from the frozen selection under real claude; the eligibility itself was seeded.

## Gates (fresh clones, HOME + four XDG roots redirected, short real TMPDIR)
- At `refactor(cli): refuse an unknown flag …`: typecheck/build RC 0; 1044 tests, 1043 passed, 1 failed (stopProof);
  check-known-reds RC 0; check-tmp-leak RC 0. Mutations U1 (drop the check) 9 red, U2 (check after the
  required-flags checks) 5 red incl. both rows that omit other flags; clone restored, git diff 0/0 bytes.
- At the fix: typecheck/build RC 0; 1045 tests, 1044 passed, 1 failed (stopProof); check-known-reds RC 0;
  check-tmp-leak RC 0.

## Spend (claude's own total_cost_usd from the kept streams; nothing estimated)
- plan P1 $0.161956; plan P2 $0.0290954; plan R1 $0.0226034; orphan execute R1 $0.0559674; plan R2 $0.0221634;
  execute R2 $0.0551702 — sum $0.3469558. The two interrupted executes (P1, P2) have no result envelope: their cost
  is not available.
- `~/.claude/projects` top-level entries identical before and after; no runner/tee/ccloop process left (pgrep RC 1).

## Registered, not fixed
- A crashed run is not resumable by any CLI path; refusal text `cannot read run artifacts: ENOENT owner-transfer.json`.
- The runner outlives a SIGKILLed ccloop and keeps spending until claude finishes.
