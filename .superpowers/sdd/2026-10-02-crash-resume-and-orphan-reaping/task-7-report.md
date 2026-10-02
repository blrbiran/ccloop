# Task 7 report: CLI crash end-to-end and README 3.2

Status: DONE.

## What
- tests/cli/crashResume.test.ts (new): real `ccloop run --agents` (fake claude, script mode, execute delayed 60 s) spawned detached; waits for `execute_started`, the execute call's `process.json` (runner pid) and the fake's marker pid; `kill(ccloopPid, SIGKILL)` (own pid only); asserts runner gone within 8 s (5 s grace + 3 s) and fake claude gone; ages `leaseAffirmedAt` to LEASE_TTL_MS + 1000 ms ago (comment: kill real, ageing simulated); removes the delay; `ccloop resume --run-dir --agents` => RC 0, status succeeded, `owner_crash_adopted` before `resume_adopted`. Contract widened (maxAttempts 2, perAttempt 120 s) so the kill sequence is not cut by the fixture's 5 s attempt timeout. afterEach SIGKILLs registered ccloop/runner/fake pids.
- README.md 3.2: first two sentences kept; rest replaced by the ordered resume checks (fresh lease, Orca control run, reaping with `orphan_process_group_reaped`, no-transfer run adopted only if status resumable and owner confirmed dead, then the unchanged eligibility/claim) and the Ctrl-C consequences (single: stop at next phase boundary then release; second: exit 130, no release; once the process is gone resume adopts a resumable run).

## Evidence
- Green: 3 runs of the file (main tree), RC=0 each, about 7 s. `tsc --noEmit` RC=0.
- Red (clone, scratchpad t7/mut): `src/controller/resumeLoop.ts` from 5672aa7 => RC=1, `cannot read run artifacts: Error: ENOENT ... owner-transfer.json`. Restored with checkout; `git diff | wc -c` = 0, `git diff --cached | wc -c` = 0.
- `pgrep -fl "fake-claude-cli|claude-phase-runner"` empty after every run (including the red run).

## Decisions / concerns
- Test passed immediately in order (Task 6 landed), so red was shown via the pre-Task-6 resumeLoop as instructed. The runner-death assertion is not independently mutated here (Tasks 2/3 own that).
- README says the single Ctrl-C releases the lease (from spec 4.3 / registerStopHandlers + loop behaviour; not re-verified by a new test here). Also states 8 eligibility checks per spec.
- No existing criteria rewritten.
