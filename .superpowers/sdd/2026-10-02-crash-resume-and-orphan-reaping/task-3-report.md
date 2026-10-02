# Task 3 report: the runner watches its parent over fd 3 (Orca session ece96b67 implementer, 2026-10-02)

Commits (main, local only, base 3c7e965):
- 72a84d0 feat(claude): the phase runner dies with its parent, taking its process group with it
- 426c459 test(claude): pin the adapter's half of the parent watch, with ClaudeAgentAdapter itself as the killed parent
- 22cefdb test(claude): pin the parent-watch SIGTERM to claude and the grace-timer group kill on their own
- b69fbb3 test(claude): T3 compares endings and descriptor growth in one assertion

Scratch (all raw outputs, read back whole): /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t3/ (below: `$S`).

## Implementation
- `src/runtime/claude/claudeAgentAdapter.ts`: runner spawned with `stdio: ["pipe","pipe","pipe","pipe"]` and `env: { ...env, CCLOOP_PARENT_WATCH_FD: "3" }`; `finish()` destroys `child.stdio[3]` after the other three. Code is the brief's Step 5.
- `scripts/claude-phase-runner.mjs`: the brief's Step 6, verbatim in substance: `PARENT_GONE_GRACE_MS = readNonNegativeIntEnv("CCLOOP_PARENT_GONE_GRACE_MS", 5000)`, `killOwnGroup`, `onParentGone` (sets `parentGone`, no-op error listeners on stdout/stderr, `process.on("exit", killOwnGroup)`, SIGTERM to claude, grace timer), `watchParent` (only on `CCLOOP_PARENT_WATCH_FD === "3"`; `Socket({fd:3, readable:true, writable:false})`; end/close/error; resume; unref). `watchParent()` is the first statement of `main()`. `readStdin()` is wrapped: a rejection while `parentGone` returns quietly, otherwise rethrows. `claudeEnv()` strips `CCLOOP_PARENT_WATCH_FD` and `CCLOOP_PARENT_GONE_GRACE_MS` (one comment line). The Task 1 comment "Task 3 sets parentGone; until then..." was replaced in place (written this round after the spec commits, so not a published comment).
- `tests/fixtures/runner-parent.mjs` (new): stand-in parent as Step 1. Deviation (small): its argv is one JSON object `{command, graceMs, cwd, request, lingerChild?, noRequest?}` instead of separate flags, so a criterion can also choose the phase and recovery window.
- `tests/fixtures/adapter-parent.ts` (new, not in the brief): runs one real `ClaudeAgentAdapter` plan phase under `node --import tsx/dist/loader.mjs`, so a criterion can SIGKILL the adapter's own process. Reason: every other parent-watch criterion uses runner-parent.mjs, which only imitates the adapter; deleting the adapter's env var stayed green (M3e below) until this existed.
- `tests/fixtures/fake-claude-cli.mjs`: new mode `grandchild-ignore-term` (= `grandchild`, but claude itself ignores SIGTERM). Needed for T2b during an abort flush (the brief's M3b fallback) and for the grace-timer criterion.

## Tests
- `tests/runtime/claude/claudeParentWatch.test.ts` (new, 9): live-parent control (runner and claude alive 1200 ms past a 200 ms grace); T1; "claude gets SIGTERM at once" (claude gone within 1500 ms under a 3000 ms grace); "grace timer kills the group when claude ignores SIGTERM" (alive at grace/2, gone after); T2 (linger child stays alive); T2b plain (mode grandchild); T2b abort flush (execute, recovery window 1500, grace 4000: SIGTERM to the runner group, 300 ms later parent SIGKILL, all three gone within 2500 ms, i.e. before the grace timer could fire); T1 through ClaudeAgentAdapter; RF4. Every pid learned (parent, runner, claude, grandchild, linger) is registered and SIGKILLed in afterEach; temp dirs removed.
- `tests/runtime/claude/claudeAdapterFdLeak.test.ts` (new, 1): T3. A warm-up round, then two rounds of five endings in-process; one `toEqual({endings, fdGrowth})`, fdGrowth 0. Endings reached: completed (`ok`), timeout (`hang`, `timeRemainingMs` 800), aborted (`hang` + AbortController), **spawn-error (reachable: worktreePath that does not exist -> `spawn` emits `error`)**, io-error (the registration callback throws; chosen over the read-only evidence dir because `hang` never writes stdout, so `appendFileSync` would never run). Not reached: exit-error and output-limit (no fake mode produces them through the adapter without new fixture work); they share `finish()`.
- `tests/runtime/claude/claudePhaseRunnerEnv.test.ts` (+1): the runner, given a real fd-3 pipe and all three variables, hands claude none of `CCLOOP_PARENT_WATCH_FD`, `CCLOOP_PARENT_GONE_GRACE_MS`, `CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS`; another variable still passes (Task 1 deferred item + M3c).
- `tests/runtime/claude/claudePhaseRunnerNeverStarted.test.ts`: three-spawns criterion now has an upper bound (Task 1 deferred item; see "Existing criteria rewritten").

## RED / GREEN (main tree, single files, `ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run <file> > $S/<x>.txt 2>&1; echo RC=$? >> $S/<x>.txt`)
- RED before implementation (`$S/red.txt`, RC=1): T1, T2, T2b, T2b-abort-flush red ("expected false to be true" on waitGone); control green; **RF4 green before the change** (see Concerns 1); T3 green (expected per brief Step 4).
- GREEN: `$S/green1.txt` (both new files, RC=0), `$S/g4-parentwatch.txt` (9/9, RC=0), `$S/g5-fdleak.txt` (RC=0). Focused reruns, each alone, all RC=0 (`$S/g-*.txt`): claudeParentWatch 6 (pre-addition), claudeAdapterFdLeak 1, claudePhaseRunnerEnv 9, claudePhaseRunnerNeverStarted 5, claudePhaseRunner 24, claudePhaseRunnerFailure 2, claudePhaseRunnerStream 6, largePrompt 3, stderrDecoding 1, claudeSingleCall 9, claudeNeverStarted 8, claudeAgentAdapter 24, fakeClaudeCli 18, tests/control/claudeEndToEnd 1, tests/control/claudeHandoffDeadlineUsage 1.
- Typecheck: `npx tsc --noEmit -p .` RC=0 (`$S/tsc3.txt`). Build and the full suite were not run (main tree forbids; that is the controller's gate).

## Mutations
Clones: `$S/t3-mut2` (base 22cefdb) for M3a-M3h, M1d, M1e; `$S/t3-mut3` (base b69fbb3) for the T3 mutations; an earlier clone `$S/t3-mut` (base 426c459) holds the first M3i attempt. Env per constraints (HOME/XDG into `$S/home`, `TMPDIR=$(mktemp -d /private/tmp/cl-XXXX)`). Drivers: `$S/mutate.py`, `$S/mutate3.py`. Every row: after `git checkout -- .`, `git diff | wc -c` = 0 and `git diff --cached | wc -c` = 0 (`$S/mutate-summary.txt`, `$S/mutate3-summary.txt`).

| M | change | result | red line |
|---|---|---|---|
| M3a | `watchParent` returns at once | red 7/9 (`$S/mut-M3a.txt`) | T1, SIGTERM-at-once, grace-timer, T2, T2b, T2b-flush, T1-adapter: "expected false to be true". RF4 and control stay green |
| M3b | remove `process.on("exit", killOwnGroup)` | red 1/9 (`mut-M3b.txt`) | T2b (abort flush): "expected false to be true". Plain T2b stays green, as predicted: the ref'd grace timer keeps the runner alive and kills the group |
| M3c1 | keep `CCLOOP_PARENT_WATCH_FD` in claude's env | red (`mut-M3c1.txt`) | `+ "watchFd": "3"` |
| M3c2 | keep `CCLOOP_PARENT_GONE_GRACE_MS` | red (`mut-M3c2.txt`) | `+ "grace": "5000"` |
| M3c3 | keep `CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS` | red (`mut-M3c3.txt`) | `+ "retryDelay": "200"` |
| M3d | delete the fd-3 destroy in `finish()` | **green** (`mut-M3d.txt`, `mut3-M3d.txt`) | T3 cannot see it (below) |
| M3e | adapter env without `CCLOOP_PARENT_WATCH_FD` | red 1/9 (`mut-M3e.txt`) | T1 through ClaudeAgentAdapter: "expected false to be true" |
| M3f | remove the SIGTERM to claude in `onParentGone` | red 1/9 (`mut-M3f.txt`) | "stops claude with SIGTERM at once": "expected false to be true" |
| M3g | remove the grace `setTimeout` | red 1/9 (`mut-M3g.txt`) | "kills its group at the end of the grace when claude ignores SIGTERM": "expected false to be true" |
| M3h | remove the `readStdin` parentGone return | **green** (`mut-M3h.txt`) | not observable (below) |
| M1d | `CLAUDE_SPAWN_ATTEMPTS = 4` | red (`mut-M1d.txt`) | "expected 2179 to be less than 2050" |
| M1e | `CLAUDE_SPAWN_ATTEMPTS = 2` | red (`mut-M1e.txt`) | "expected 773 to be greater than or equal to 1400" |
| M3i | adapter opens `/dev/null` once per phase, never closes | red (`mut3-M3i.txt`) | `- "fdGrowth": 0` / `+ "fdGrowth": 10`, endings unchanged |
| M3j | M3d plus `pause()` on the parent's fd-3 socket | green (`mut3-M3j.txt`); control (pause only) green | — |

T3 and M3d (controller ruling applied): **T3 cannot see M3d.** When the runner exits, the parent's fd-3 socket reads EOF and Node closes it on its own; pausing that socket (M3j) does not change this. T3 is kept because it still pins something real: no descriptor accumulates per phase across five endings, and M3i shows it goes red (+10 for ten phases). Its claim in the ledger should read "no per-phase fd growth", not "guards the fd-3 destroy". The destroy stays as spec §3.1 says, unpinned.

First M3i attempt (fd 3 = `/dev/null`) went red only through the endings assertion (the runner read EOF on fd 3 at once and treated the parent as gone), which hid the fd count; that is why b69fbb3 merged the two assertions (`$S/mut-M3i.txt`, before the merge).

## Capacity lower bound (Step 9; fake claude, mode hang, one plan phase in flight)
Command: `node $S/capacity/measure.mjs $S/capacity` from the repo root at commit b69fbb3; raw outputs `$S/capacity/{ps-g-runner,ps-A,lsof-runner,lsof-claude,lsof-parent}.txt`, counts `$S/capacity/summary.json`, `$S/capacity/fdcounts.txt`.
- Processes in the runner's group (`/bin/ps -o pid,pgid,command -g <runner>`, cross-checked against `ps -A` by pgid): **2** (runner, fake claude).
- `lsof -p` rows (excluding the header) / numeric fds: runner **23 / 20**, fake claude **17 / 14**, parent stand-in **21 / 18**.
- Observation: the fake claude's fd 3 is its own KQUEUE, not the runner's fd-3 socket, so under a node-based fake claude the runner's end was **not** inherited (spec §3.1 allows that it may be; real claude unmeasured).
- After SIGKILL of the parent, 2500 ms later: runner and claude both gone (`after-kill.json`).

## Files
Modified: scripts/claude-phase-runner.mjs, src/runtime/claude/claudeAgentAdapter.ts, tests/fixtures/fake-claude-cli.mjs, tests/runtime/claude/claudePhaseRunnerEnv.test.ts, tests/runtime/claude/claudePhaseRunnerNeverStarted.test.ts.
New: tests/fixtures/runner-parent.mjs, tests/fixtures/adapter-parent.ts, tests/runtime/claude/claudeParentWatch.test.ts, tests/runtime/claude/claudeAdapterFdLeak.test.ts.

## Existing criteria rewritten
- "answers claudeNeverStarted with exit 0 when the claude command does not exist, after three spawns" (tests/runtime/claude/claudePhaseRunnerNeverStarted.test.ts), written in Task 1 of this round. The controller asked to keep the 200 ms delay and add an upper bound near ~1200 ms. That bound cannot catch four spawns: four spawns take only >= 600 ms of waits plus ~80 ms startup (measured 2179 ms at 700 ms delay => ~80 ms), so they finish under 1200 ms. With 200 ms delay, any bound that always catches four spawns (< 600 ms) leaves under 200 ms for startup under load. Decision (smallest change that works): delay 700 ms, lower bound 1400 ms, upper bound 2050 ms (a fourth spawn is >= 2100 ms, because timers do not fire early). Both bounds were seen red (M1d, M1e). Not loosened: the lower bound still requires three spawns. Encodes spec 2026-10-02 crash-resume (pending human ratification).
- No pre-round criterion was rewritten. Two additions to existing files (claudePhaseRunnerEnv +1 test, fake-claude-cli +1 mode) are new coverage.

## Concerns
1. **RF4 cannot see M3a.** A parent that dies before writing the request also closes the runner's stdin, so `JSON.parse("")` throws and the runner exits whether or not it watches fd 3. RF4 pins the Review Focus 4 outcome (runner exits, no claude spawned), not the watch. M3h (the `readStdin` wrap) is likewise not observable: without it the runner still exits, just loudly to a dead stderr.
2. T3 cannot see M3d (above). The fd-3 destroy in `finish()` is unpinned.
3. Plain T2b cannot see M3b; the abort-flush T2b is the one that does. Both are kept.
4. The new adapter-level criterion runs a TS fixture through tsx's loader (as tests/cli/agentsRun.test.ts already does). It relies on the `TMPDIR` scope staying short (tsx IPC socket path limit, see tests/setup/scopeTmpdir.ts).
5. Timing margins: the abort-flush T2b allows 2500 ms against a 4000 ms grace; the grace-timer criterion checks "still alive" at 750 ms of a 1500 ms grace. Under heavy load a spawn could stretch these; none flaked across the 6 runs above.
6. This report is not committed (`.superpowers/sdd/**` needs `git add -f`; left to the controller).

## Process hygiene
`pgrep -fl "fake-claude-cli|claude-phase-runner|runner-parent" > $S/pgrep-final.txt 2>&1; echo RC=$? >> $S/pgrep-final.txt` -> file content: `RC=1` (no output). It also printed nothing after every test and mutation batch above. Only processes these tests started were killed.
