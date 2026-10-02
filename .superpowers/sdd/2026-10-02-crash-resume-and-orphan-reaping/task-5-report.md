# Task 5 report: reapRunProcesses

Status: DONE (one concern, below).

## Commits
- 3abb95a feat(ownership): reap a run's unfinished process groups when their identity is certain
- 9be3811 test(ownership): wait for the test child's SIGTERM handler before reaping (fixes a test race found by M5c)

## Implementation
src/ownership/reapRunProcesses.ts is the brief's module verbatim (only `new Promise<void>` typed). Spec 4.2 matched; no edit to ownerLiveness.ts.

## Tests (tests/ownership/reapRunProcesses.test.ts, 10 tests)
The brief's nine cases; case 1 is split into TERM-honoured and TERM-ignoring (SIGKILL path, graceMs 200). Real detached `node -e setInterval` groups; afterEach SIGKILLs every pid. Refusals assert events.jsonl is empty/absent; the finished-call case also asserts no events file.

## RED / GREEN
- RED: `vitest run tests/ownership/reapRunProcesses.test.ts` before the module: "Failed to load url ../../src/ownership/reapRunProcesses.js", RC=1.
- GREEN: same command, 10 passed, RC=0; `npx tsc --noEmit -p .` RC=0.

## Mutations (clone: scratchpad/t5/t5-mut, at 9be3811)
| id | mutation | red line |
|---|---|---|
| M5a | drop the outcome.json exclusion | "leaves a finished call (outcome.json present) alone": expected { ok: true, reaped: 1 } to deeply equal { ok: true, reaped: +0 } |
| M5b | lstart === null treated as reapable (null no longer refuses, mismatch check skipped for null) | "refuses when the group is present but its leader is absent": Test timed out in 5000ms (it tried to reap a fake group that never goes) |
| M5c | skip the SIGKILL | "falls through to SIGKILL when the group ignores SIGTERM": Test timed out in 5000ms |

Restore proof: after all three, `git diff | wc -c` = 0 and `git diff --cached | wc -c` = 0.
Note on M5b: the naive "delete the null check" mutation is equivalent (null !== startedAt still refuses), so I used the null-reapable form.

## Test race found and fixed
First M5c run stayed green: the TERM-ignoring child was SIGTERMed before node installed its handler and died, so SIGKILL was never exercised. Fixed in 9be3811: child writes a ready marker after installing the handler; spawnGroup is now async and waits for it. M5c then went red.

## Cleanup check
`pgrep -fl setInterval` after all runs: no output (exit 1).

## Files
- /Users/biran/code/skills/loop/ccloop/src/ownership/reapRunProcesses.ts
- /Users/biran/code/skills/loop/ccloop/tests/ownership/reapRunProcesses.test.ts

## Concerns
- Real-process tests take ~1.4s total and rely on wall-clock polling (marker wait up to 5s); low flake risk but not zero under heavy load.
- Case 4's M5b red shows as a timeout rather than an assertion failure (mutation makes reaper wait on a fake group); still a real red.
- Spec says the 15s timeout poll is after SIGKILL; implemented as in brief. Reaping targets are all probed before any is signalled, so one refusal reaps nothing (intended, matches brief).

---
## Fix round 1 (commits 4f542f9, 5672aa7)

Changes
1. Test "identifies every call before signalling any": live TERM-honouring group (call-a) plus a mismatching-lstart call (call-b) => ok:false, both processes alive, no events.
2. Test "is idempotent": reaped:1 then reaped:0, exactly one orphan_process_group_reaped event.
3. Leader-absent and EPERM tests stub `signalGroup: () => {}` and `sleep`. The leader-absent test now also asserts the reason contains "its leader 999999 is gone" (5672aa7), because the new re-verification would otherwise make M5b equivalent (green): see M5b below.
4. Walk fails closed: readdir error other than ENOENT => `{ok:false, reason:"<dir>: <code>"}`; ENOENT (missing runDir, or a dir removed mid-walk) is skipped, so a missing runDir is ok/reaped 0. Test uses a chmod-000 subdir (mode restored in finally).
5. Before SIGTERM to each target, `readStart` is re-read; mismatch or null => refuse without signalling. Test: injected readStart returns the real value then a different one; asserts 2 calls, process alive, no events.

Commands: `ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run tests/ownership/reapRunProcesses.test.ts` => 14 passed RC=0; `npx tsc --noEmit -p .` => 0.

Mutations (clones t5-mut2 / t5-mut3), red lines
- M5d signal inside the identification loop: 3 failed, incl. "identifies every call before signalling any": expected false to be true (call-a was killed).
- M5e swallow readdir errors again: "refuses when a directory cannot be read": expected true to be false.
- M5f drop the pre-SIGTERM re-verification: "refuses without signalling when the leader's lstart changed": expected true to be false.
- M5b (null leader reapable): first run was GREEN, because the new re-verification refuses anyway (equivalent mutant, found by running it). Added the reason assertion; rerun: red in 6ms, "expected 'pid 999999 changed identity before it…' to contain 'its leader 999999 is gone'", with signalGroup/sleep stubbed so no real kill was possible.
Restore proof after each batch: `git diff | wc -c` = 0, `git diff --cached | wc -c` = 0.
`pgrep -fl setInterval` after all runs: empty (exit 1).
Note: the first fix-round commit attempt was blocked once by the Orca gate hook on an unrelated command shape; nothing ran, reissued in pieces.
