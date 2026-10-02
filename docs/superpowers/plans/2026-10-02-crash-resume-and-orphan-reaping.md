# Crash resume, orphan reaping, R-A and R-B — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SIGKILLed ccloop run becomes resumable by plain `resume`/`sweep` with its orphans reaped, the runner dies with its parent, a never-started claude books usage 0 (with an `ENOENT` retry), and claude's own `partial`+`error` with changed files goes to verify.

**Architecture:** Runner-side changes live in `scripts/claude-phase-runner.mjs` (spawn hardening, never-started answer, fd-3 parent watch, `partialOrigin`). The adapter (`src/runtime/claude/claudeAgentAdapter.ts`) opens fd 3 and maps the never-started answer to an error that `observedTokensOf` reads as 0. Two new ownership modules (`ownerLiveness.ts`, `reapRunProcesses.ts`) and one controller module (`adoptCrashedRun.ts`) are wired into `resumeLoop`; `sweepRuns` gains a second candidate class. `runLoop`'s partial branch gains one fall-through.

**Tech Stack:** TypeScript (Node ≥ 22, ESM), vitest, zod; plain `.mjs` for the runner and fixtures.

**Spec:** `docs/superpowers/specs/2026-10-02-crash-resume-and-orphan-reaping-design.md` (read §2 H1–H8, §11 R1/R2 first; the spec wins over this plan on any conflict).

## Global Constraints

- Constants (spec, verbatim values): `PARENT_GONE_GRACE_MS = 5000`, `CLAUDE_SPAWN_ATTEMPTS = 3`, `CLAUDE_SPAWN_RETRY_DELAY_MS = 2000`, `OWNER_START_MARGIN_S = 2`, `REAP_GRACE_MS = 5000`, `REAP_TIMEOUT_MS = 15000`, `LEASE_TTL_MS` (existing, 90,000).
- Env variables read by the runner only: `CCLOOP_PARENT_WATCH_FD` (`"3"`), `CCLOOP_PARENT_GONE_GRACE_MS`, `CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS`. All three are stripped by `claudeEnv()`.
- Event types (new): `orphan_process_group_reaped`, `owner_crash_adopted`, `partial_execute_sent_to_verify`.
- Never-started answer on runner stdout: exactly `{"claudeNeverStarted": true, "spawnError": "<code>: <message>"}`, exit 0.
- `ps` in new code: `/bin/ps -o lstart= -p <pid>`, env `TZ=UTC LC_ALL=C`, timeout 1000 ms, maxBuffer 16 KiB.
- Repository rules (`CLAUDE.md`): no push, no merge, no branch/worktree deletion; never rewrite an existing criterion without recording it in the ledger as `Ruling (controller, pending human ratification)` with the ruling-88 three conditions; published comments get an appended `*** ERRATUM (crash resume, 2026-10-02, Orca session ece96b67) -- … ***`, never an in-place edit; `.superpowers/sdd/**` is append-only and new files there need `git add -f`.
- Verification runs only in a `git clone --local` copy under the session scratchpad (`/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/`), `node_modules` symlinked, `npm run build` first, HOME and `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME` redirected into the scratchpad, `TMPDIR=$(mktemp -d /private/tmp/cl-XXXX)`, `ECC_GATEGUARD=off DISABLE_OMC=1`. Output redirected to a file and read back whole; never piped through grep/tail/head.
- Single-file test runs in the main tree are allowed (`./node_modules/.bin/vitest run <file>`); the full suite and builds run only in the clone.
- Mutations only in a clone; restore proof = `git diff | wc -c` and `git diff --cached | wc -c` both 0.
- Commit style: conventional subject, body explains why, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A run killed before its first heartbeat affirm** (`leaseAffirmedAt: null`): `resume` must still adopt it once the owner is confirmed dead (sweep does not take it, R2). Test in Task 6 (`adopts a killed run whose lease was never affirmed`).
2. **A transient `ps` failure while the owner is really dead** (the pid vanished between `kill(0)` and `ps`): must refuse (undetermined), never adopt on a guess. Test in Task 4 (`readStart null ⇒ undetermined`).
3. **The operator runs `resume` twice in a row on a killed run** (second after the first already adopted and finished): second must be a clean refusal, not a second adoption. Test in Task 6 (`a second resume after adoption takes today's path`).
4. **Parent dies while the runner is still reading stdin** (before claude was ever spawned): runner must exit, no claude spawned. Test in Task 3 (`parent gone before the request arrives`).
5. **A claude that exits non-zero after having started** (real failure, not never-started): usage must stay as today (observed or null), never forced to 0. Test in Task 2 (`exit after start keeps today's usage`).

---

### Task 1: Runner — spawn hardening, never-started answer, ENOENT retry

**Files:**
- Modify: `scripts/claude-phase-runner.mjs` (around `runClaude` ~:375–455, `handleInterrupt` ~:271–311, `main` ~:460–525, `claudeEnv` ~:348)
- Test: `tests/runtime/claude/claudePhaseRunnerNeverStarted.test.ts` (new)

**Interfaces:**
- Produces: the never-started stdout answer (Global Constraints); `CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS` override; runner globals `claudeEverStarted`, `lastSpawnFailure` (string | null) used by Task 3.

- [ ] **Step 1: Write the failing tests.** Reuse the helpers of `tests/runtime/claude/claudePhaseRunner.test.ts` (copy `contract`, `createFakeClaudeBinary`, `spawnPhaseRunner` — do not import across test files). Request shape: copy an execute request from that file (fields `phase`, `prompt`, `worktreePath`, `partialOutcomeRecoveryWindowMs`, …).

```ts
// claudePhaseRunnerNeverStarted.test.ts — spec §3.2 (R-A).
it("answers claudeNeverStarted with exit 0 when the claude command does not exist, after three spawns", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "ccloop-missing-")), "claude"); // never created
  const started = Date.now();
  const { result } = spawnPhaseRunner(executeRequest(worktree), {
    CCLOOP_CLAUDE_COMMAND: JSON.stringify([missing]), CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: "200",
  });
  const r = await result;
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ claudeNeverStarted: true, spawnError: expect.stringMatching(/^ENOENT: /) });
  expect(Date.now() - started).toBeGreaterThanOrEqual(400); // two waits of 200 ms => three spawns
});

it("starts claude on the second spawn when the command appears during the retry wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccloop-late-"));
  const late = join(dir, "claude");
  const { result } = spawnPhaseRunner(executeRequest(worktree), {
    CCLOOP_CLAUDE_COMMAND: JSON.stringify([late]), CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: "600",
  });
  await new Promise((r) => setTimeout(r, 200));
  await writeFile(late, `#!/usr/bin/env node\n${FAKE_EXECUTE_SOURCE}`); await chmod(late, 0o755);
  const r = await result;
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).changedFiles).toEqual(["answer.txt"]);
});

it("does not retry a spawn failure other than ENOENT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccloop-noexec-"));
  const noexec = join(dir, "claude"); await writeFile(noexec, "#!/bin/sh\n"); await chmod(noexec, 0o644); // EACCES
  const started = Date.now();
  const r = await spawnPhaseRunner(executeRequest(worktree), {
    CCLOOP_CLAUDE_COMMAND: JSON.stringify([noexec]), CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: "2000",
  }).result;
  expect(JSON.parse(r.stdout)).toEqual({ claudeNeverStarted: true, spawnError: expect.stringMatching(/^EACCES: /) });
  expect(Date.now() - started).toBeLessThan(1500);
});

it("answers once, never-started, when SIGTERM arrives during the retry wait (T5b)", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "ccloop-missing-")), "claude");
  const { child, result } = spawnPhaseRunner(executeRequest(worktree), {
    CCLOOP_CLAUDE_COMMAND: JSON.stringify([missing]), CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: "3000",
  });
  await new Promise((r) => setTimeout(r, 500));
  child.kill("SIGTERM");
  const r = await result;
  expect(r.code).toBe(0);
  expect(r.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(r.stdout)).toEqual({ claudeNeverStarted: true, spawnError: expect.stringMatching(/^ENOENT: /) });
});

it("never-started applies to a single call too", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "ccloop-missing-")), "claude");
  const r = await spawnPhaseRunner(singleCallRequest(), {
    CCLOOP_CLAUDE_COMMAND: JSON.stringify([missing]), CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: "50",
  }).result;
  expect(JSON.parse(r.stdout)).toEqual({ claudeNeverStarted: true, spawnError: expect.stringMatching(/^ENOENT: /) });
});
```

`worktree` is a temporary git repo (`git init`, one commit), so `buildPartialExecutionOutcome` finds no changes. `FAKE_EXECUTE_SOURCE` is a fake claude that prints one json envelope with `structured_output` `{changedFiles:["answer.txt"], diffPatch:"", commandOutputs:[], stdoutStderrLog:""}` — copy the shape used by the existing runner tests.

- [ ] **Step 2: Run, expect red.** `./node_modules/.bin/vitest run tests/runtime/claude/claudePhaseRunnerNeverStarted.test.ts > $SCRATCH/t1-red.txt 2>&1; cat $SCRATCH/t1-red.txt` — expected: today the runner exits 1 with the spawn error on stderr.

- [ ] **Step 3: Implement.** In the runner:

```js
const CLAUDE_SPAWN_ATTEMPTS = 3;
const CLAUDE_SPAWN_RETRY_DELAY_MS = readNonNegativeIntEnv("CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS", 2000);
let claudeEverStarted = false;
let lastSpawnFailure = null; // "<code>: <message>" of the latest failed spawn in this call

class ClaudeNeverStarted extends Error {
  constructor(spawnError, code) { super(`claude never started: ${spawnError}`); this.spawnError = spawnError; this.code = code; }
}
function describeSpawnError(error) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "ESPAWN";
  return `${code}: ${error instanceof Error ? error.message : String(error)}`;
}
// Spec §3.2: "never started" is Node's own verdict -- spawn() threw, or `error` came before `spawn`.
// The listeners go on before any stdio stream is touched: for EMFILE/ENFILE Node returns before creating them.
function spawnClaudeOnce(command, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, options); }
    catch (error) { reject(new ClaudeNeverStarted(describeSpawnError(error), error?.code)); return; }
    const onError = (error) => { child.off("spawn", onSpawn); reject(new ClaudeNeverStarted(describeSpawnError(error), error?.code)); };
    const onSpawn = () => { child.off("error", onError); resolve(child); };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}
async function spawnClaude(command, args, options) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const child = await spawnClaudeOnce(command, args, options);
      claudeEverStarted = true;
      return child;
    } catch (error) {
      if (error instanceof ClaudeNeverStarted) lastSpawnFailure = error.spawnError;
      const retry = error instanceof ClaudeNeverStarted && error.code === "ENOENT" && attempt < CLAUDE_SPAWN_ATTEMPTS && !interruptHandled && !parentGone;
      if (!retry) throw error;
      await new Promise((r) => setTimeout(r, CLAUDE_SPAWN_RETRY_DELAY_MS));
      if (interruptHandled || parentGone) throw error;
    }
  }
}
async function writeNeverStarted(spawnError) {
  await writeJsonToStdout({ claudeNeverStarted: true, spawnError });
}
```

`parentGone` is introduced here as `let parentGone = false;` (Task 3 sets it). `readNonNegativeIntEnv(name, fallback)` returns the fallback unless the variable parses as a non-negative safe integer.

In `runClaude`, replace `const child = spawn(...)` with `const child = await spawnClaude(claudeCommand[0], [...args], {cwd, env, stdio})` (same arguments as today); everything after it is unchanged (the `child.on("error", reject)` inside the promise stays for post-spawn errors).

In `handleInterrupt`, directly after `interruptHandled = true;`:

```js
  // Spec §3.2: interrupted while waiting to retry a failed spawn -- no claude ever ran in this call, so the
  // answer is "never started", not a timeout partial. Main sees interruptHandled and writes nothing.
  if (!claudeEverStarted && lastSpawnFailure !== null) {
    if (!parentGone) { try { await writeNeverStarted(lastSpawnFailure); } catch { process.exit(1); } }
    process.exit(0);
    return;
  }
```

In `main`'s catch, first lines:

```js
  } catch (error) {
    if (interruptHandled) return;
    if (error instanceof ClaudeNeverStarted) {
      if (!parentGone) await writeNeverStarted(error.spawnError);
      return;
    }
```

(Keep the existing `interruptHandled` early return as the first statement; the never-started branch must precede the execute partial branch.)

Add `CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS` to `claudeEnv()`'s destructured strip list with a one-line comment (`// Crash resume (2026-10-02): this runner's own input too.`).

- [ ] **Step 4: Run, expect green**, then run the other runner files alone (`claudePhaseRunner.test.ts`, `claudePhaseRunnerEnv.test.ts`, `claudePhaseRunnerFailure.test.ts`, `claudePhaseRunnerStream.test.ts`, `largePrompt.test.ts`, `stderrDecoding.test.ts`), each to its own file, read back. Any red there that pins today's spawn-failure stdout/exit code is an existing criterion: record it (name, why) for the ledger instead of editing it silently.

- [ ] **Step 5: Mutations (in a clone).** M1a: make `retry` always false ⇒ the "second spawn" criterion red. M1b: delete the never-started branch in `handleInterrupt` ⇒ T5b red. M1c: delete the `ClaudeNeverStarted` branch in main ⇒ first criterion red. Record each red line.

- [ ] **Step 6: Commit** `fix(claude): a claude that never started answers so, and a missing binary is retried twice` (body: spec §3.2, R-A evidence).

---

### Task 2: Adapter and usage — never-started books 0

**Files:**
- Modify: `src/runtime/claude/claudeAgentAdapter.ts` (`phase()` ~:200, `singleCall()` ~:276), `src/runtime/types.ts` (`observedTokensOf` ~:159, its doc comment ~:142–158)
- Test: `tests/runtime/claude/claudeNeverStarted.test.ts` (new), plus one runLoop-level case in the same file

**Interfaces:**
- Consumes: Task 1's stdout answer.
- Produces: `export class ClaudeNeverStartedError extends Error { readonly neverStarted = true; constructor(readonly spawnError: string, readonly evidenceDir: string) }` exported from `claudeAgentAdapter.ts`; `observedTokensOf(e)` returns `0` when `e.neverStarted === true`.

- [ ] **Step 1: Failing tests.** Build a `ClaudeAgentAdapter` the way `tests/runtime/claude/claudeAgentAdapter.test.ts` does, with an installation whose `command` is a path that does not exist and `CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS=10` set in `process.env` for the test (restore in `afterEach`).

```ts
it("execute with a missing claude throws ClaudeNeverStartedError whose observed usage is 0", async () => {
  const error = await adapter.execute(context).then(() => { throw new Error("resolved"); }, (e: unknown) => e);
  expect(error).toBeInstanceOf(ClaudeNeverStartedError);
  expect(observedTokensOf(error)).toBe(0);
});
it("singleCall with a missing claude throws ClaudeNeverStartedError, not SingleCallOutputInvalid", async () => { /* same shape via adapter.singleCall */ });
it("exit after start keeps today's usage (null without observation)", async () => {
  // fake claude that starts and exits 1 without output: observedTokensOf(error) === null
});
it("runLoop books 0 for a never-started execute and ends failed (T5)", async () => {
  // runLoop with the adapter above (plan phase answered by a working fake via a script? use a fake claude path that
  // exists for plan and is removed before execute: the fake writes a marker on plan; the test deletes the binary
  // when <marker>.calls shows "plan"). Assert: state.status === "failed"; onPhaseSettled saw {phase:"execute", tokenUsage: 0}.
});
```

For the runLoop case pass `options.onPhaseSettled` (see `runLoop`'s `RunControlHooks` / `RunLoopFromStateOptions`) and collect observations. If arranging plan-then-missing proves fragile, assert the same at `PhaseExecutionError` level through `runLoop` with a `RuntimeAdapter` stub whose `execute` throws `new ClaudeNeverStartedError("ENOENT: x", "/e")` — that measures the runLoop end, the adapter cases measure the adapter end.

- [ ] **Step 2: Red.** Run the file; expect `claude-exit-error` and `null`.

- [ ] **Step 3: Implement.**

```ts
// claudeAgentAdapter.ts
export class ClaudeNeverStartedError extends Error {
  readonly neverStarted = true;
  constructor(readonly spawnError: string, readonly evidenceDir: string) {
    super(`claude-never-started: ${spawnError} (${evidenceDir})`);
    this.name = "ClaudeNeverStartedError";
  }
}
// Spec §3.2: the runner's dedicated answer when claude never existed in this call. Checked before every other reading of
// stdout, because the after-stop branch below returns any JSON object printed with exit 0 as the phase's result.
function neverStartedOf(outcome: Outcome): string | null {
  if (outcome.code !== 0 || outcome.signal !== null) return null;
  const written = parseObject(outcome.stdout) as { claudeNeverStarted?: unknown; spawnError?: unknown } | undefined;
  return written?.claudeNeverStarted === true && typeof written.spawnError === "string" ? written.spawnError : null;
}
function throwIfNeverStarted(outcome: Outcome): void {
  const spawnError = neverStartedOf(outcome);
  if (spawnError === null) return;
  if (outcome.reason === "aborted") throw Object.assign(new ClaudePhaseAborted(outcome.evidenceDir, null), { neverStarted: true as const });
  throw new ClaudeNeverStartedError(spawnError, outcome.evidenceDir);
}
```

Call `throwIfNeverStarted(outcome)` as the first statement after `const outcome = await this.run(...)` in both `phase()` and `singleCall()`. (`Outcome` and `parseObject` already exist in this file; if `parseObject` is declared below, hoisting of function declarations covers it.)

```ts
// types.ts, inside observedTokensOf, first line:
  if (error !== null && typeof error === "object" && (error as { neverStarted?: unknown }).neverStarted === true) return 0;
```

Append to the doc comment block above `observedTokensOf` (keep every existing line verbatim):

```
 * *** ERRATUM (crash resume, 2026-10-02, Orca session ece96b67; ccloop spec
 * 2026-10-02-crash-resume-and-orphan-reaping-design.md §3.2) -- "never 0" no longer holds for one case: an error
 * carrying `neverStarted: true` answers 0. That 0 is observed, not assumed: the runner proved no claude process
 * existed in the call, so nothing could have been spent. ***
```

- [ ] **Step 4: Green**, then run alone: `claudeAgentAdapter.test.ts`, `claudeSingleCall.test.ts`, `tests/control/singleCall.test.ts`, `tests/runtime/phaseTimeoutUsage.test.ts`, `tests/control/usage.test.ts`. Record any pinned existing criterion.

- [ ] **Step 5: Mutations.** M2a: drop the `observedTokensOf` branch ⇒ "observed usage is 0" red. M2b: move `throwIfNeverStarted` after the after-stop branch in `phase()` ⇒ write a criterion that SIGTERMs (abort) during the retry wait through the adapter and expects `ClaudePhaseAborted` with `observedTokensOf === 0`; it must go red under M2b (add that criterion in this task if Step 1's set does not cover it). M2c: drop the call in `singleCall()` ⇒ the single-call criterion red.

- [ ] **Step 6: Commit** `fix(claude): book a never-started claude as 0 spent, in a phase and in a single call`.

---

### Task 3: Runner watches its parent over fd 3

**Files:**
- Modify: `src/runtime/claude/claudeAgentAdapter.ts` (`run()` spawn ~:130, `finish()` ~:139), `scripts/claude-phase-runner.mjs`
- Create: `tests/fixtures/runner-parent.mjs`
- Test: `tests/runtime/claude/claudeParentWatch.test.ts` (new), `tests/runtime/claude/claudeAdapterFdLeak.test.ts` (new)

**Interfaces:**
- Consumes: `parentGone` global from Task 1.
- Produces: env contract `CCLOOP_PARENT_WATCH_FD=3`; nothing else for later tasks.

- [ ] **Step 1: Fixture `tests/fixtures/runner-parent.mjs`.** A stand-in parent: spawns the runner exactly the way the adapter does (`detached: true`, `stdio: ["pipe","pipe","pipe","pipe"]`, env with `CCLOOP_PARENT_WATCH_FD: "3"`, `CCLOOP_PARENT_GONE_GRACE_MS` from argv, `CCLOOP_CLAUDE_COMMAND` from argv), writes the request on stdin, optionally (argv flag `--linger-child`) spawns an unrelated `node -e "setInterval(()=>{},1000)"` child (not detached, `stdio: "ignore"`), prints one JSON line `{"runner": <pid>, "linger": <pid|null>}` to its own stdout, then idles forever. Arg `--no-request` skips writing the request (Review Focus 4).

- [ ] **Step 2: Failing tests (T1, T2, T2b, RF4).** Fake claude = `tests/fixtures/fake-claude-cli.mjs` in mode `hang` (T1, T2), `grandchild` (T2b: TERM-ignoring grandchild in the runner's group). Helper `alive(pid)` = `try { process.kill(pid, 0); return true } catch (e) { return e.code !== "ESRCH" }`. Helper `waitGone(pids, ms)` polls every 50 ms.

```ts
it("T1: runner and claude die within the grace after the parent is SIGKILLed", async () => {
  const p = startParent({ mode: "hang", graceMs: 500 });
  const { runner } = await p.ready;               // first stdout line
  const claudePid = await waitForMarkerPid(p.marker); // fake claude writes {pid} into <marker>
  p.child.kill("SIGKILL");
  expect(await waitGone([runner, claudePid], 500 + 3000)).toBe(true);
});
it("T2: same while an unrelated child of the dead parent still lives", async () => {
  const p = startParent({ mode: "hang", graceMs: 500, lingerChild: true });
  const { runner, linger } = await p.ready; const claudePid = await waitForMarkerPid(p.marker);
  p.child.kill("SIGKILL");
  expect(await waitGone([runner, claudePid], 3500)).toBe(true);
  expect(alive(linger!)).toBe(true); process.kill(linger!, "SIGKILL");
});
it("T2b: the TERM-ignoring grandchild in the runner's group dies too", async () => { /* mode grandchild; read the grandchild pid the fixture records (see fake-claude-cli.mjs grandchild branch); assert all gone */ });
it("RF4: parent gone before the request arrives -- runner exits, no claude spawned", async () => {
  const p = startParent({ mode: "hang", graceMs: 500, noRequest: true });
  const { runner } = await p.ready; p.child.kill("SIGKILL");
  expect(await waitGone([runner], 3500)).toBe(true);
  expect(existsSync(`${p.marker}.argv`)).toBe(false);
});
```

`startParent` spawns `node tests/fixtures/runner-parent.mjs …` with `stdio: ["ignore","pipe","inherit"]`; register every pid for an `afterEach` that SIGKILLs survivors (`try/catch`), so a red test does not leak processes.

- [ ] **Step 3: Failing test T3 (fd leak).** In `claudeAdapterFdLeak.test.ts`, run the adapter `run()` path in-process five times, one per ending: complete (`ok`), timeout (`hang` with tiny `timeLimitMs`), abort (`hang` + `AbortController.abort()`), spawn-error (runner path made unspawnable by pointing `process.execPath`? — use `installation.command` missing so the runner answers never-started; that is the complete path, so instead force adapter-level `spawn-error` by temporarily setting `claudeRunnerPath` env/arg if the adapter exposes one; if it does not, cover four endings and note the fifth), io-error (`hang` + make the evidence dir read-only after spawn so `appendFileSync` throws). Count `readdirSync("/dev/fd").length` before the loop and after (after a 200 ms settle); expect equal.

- [ ] **Step 4: Red.** Run both files; T1/T2/T2b/RF4 red (runner survives), T3 likely green today (no fd 3 yet) — that is expected; its job starts once fd 3 exists.

- [ ] **Step 5: Implement adapter.**

```ts
// run(): spawn
const child = spawn(process.execPath, [runner], {
  cwd: call.cwd, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"],
  // Spec §3.1: fd 3 is a pipe this process never writes; its end closes only when this process dies (or finish()
  // destroys it), which is how the runner learns that its parent is gone.
  env: { ...env, CCLOOP_PARENT_WATCH_FD: "3" },
});
// finish(): after child.stderr.destroy();
(child.stdio[3] as { destroy?: () => void } | null)?.destroy?.();
```

- [ ] **Step 6: Implement runner.** (`import { Socket } from "node:net";`)

```js
const PARENT_GONE_GRACE_MS = readNonNegativeIntEnv("CCLOOP_PARENT_GONE_GRACE_MS", 5000);
// Spec §3.1: once the parent is gone nobody reads this runner's output and nobody will stop its group, so the runner
// stops it itself -- after a grace for claude's SIGTERM, and in any case on its own way out.
function killOwnGroup() { try { process.kill(-process.pid, "SIGKILL"); } catch { /* already gone */ } }
function onParentGone() {
  if (parentGone) return;
  parentGone = true;
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  process.on("exit", killOwnGroup);
  try { currentClaudeProcess?.kill("SIGTERM"); } catch { /* exited */ }
  setTimeout(killOwnGroup, PARENT_GONE_GRACE_MS);
}
function watchParent() {
  if (process.env.CCLOOP_PARENT_WATCH_FD !== "3") return;
  let watch;
  try { watch = new Socket({ fd: 3, readable: true, writable: false }); } catch { onParentGone(); return; }
  watch.on("end", onParentGone); watch.on("close", onParentGone); watch.on("error", onParentGone);
  watch.resume();
  watch.unref();
}
```

Call `watchParent()` at the top of `main()` before `readStdin()`. Add `CCLOOP_PARENT_WATCH_FD` and `CCLOOP_PARENT_GONE_GRACE_MS` to `claudeEnv()`'s strip list (one comment line covering both: spec §3.1).

If `readStdin()` rejects because the parent died mid-request (JSON parse of a partial body), main must not crash loudly before the exit hook: wrap `const request = await readStdin();` so that when `parentGone` is true it just `return`s (exit hook kills the group).

- [ ] **Step 7: Green**; re-run the six runner files and `claudeAgentAdapter.test.ts`, `claudeEndToEnd.test.ts`, `tests/control/claudeHandoffDeadlineUsage.test.ts` alone.

- [ ] **Step 8: Mutations.** M3a: `watchParent` returns immediately ⇒ T1, T2, RF4 red. M3b: remove `process.on("exit", killOwnGroup)` ⇒ T2b must go red; if it stays green, add a criterion where the parent dies during an abort flush (fake claude `write-ignore-term-then-hang`-style mode that exits only on SIGKILL, adapter SIGTERM first, then kill the parent) so that the runner's `handleInterrupt` `process.exit` happens inside the grace — red without the hook. M3c: remove `claudeEnv` stripping of `CCLOOP_PARENT_WATCH_FD` ⇒ add `claudePhaseRunnerEnv.test.ts`-style criterion: the env the fake claude records (`<marker>` has `env`? if not, a tiny fake that writes `process.env.CCLOOP_PARENT_WATCH_FD` to a file) must not contain it ⇒ red under M3c. M3d: delete the fd-3 destroy in `finish()` ⇒ T3 red **or** record "T3 cannot see this mutation (Node resumes child stdio on exit)" and remove T3's claim from the ledger table.

- [ ] **Step 9: Record capacity lower bound.** In the T1 setup, before the kill, run `lsof -p <runner>` and `ps -o pid,pgid,command -g <runner>` into files under the scratchpad, count lines, and write the counts (fake claude, lower bound) into the ledger in Task 10.

- [ ] **Step 10: Commit** `feat(claude): the phase runner dies with its parent, taking its process group with it`.

---

### Task 4: `classifyOwnerProcess`

**Files:**
- Create: `src/ownership/ownerLiveness.ts`
- Test: `tests/ownership/ownerLiveness.test.ts`

**Interfaces:**
- Consumes: `classifyProcessLiveness(pid): LivenessVerdict` (`src/persistence/fileStore.ts`; `{verdict:"alive"} | {verdict:"dead"} | {verdict:"unknown"; reason}`); `OwnerRecord` (`src/runtime/types.ts`).
- Produces:
  - `export type OwnerVerdict = { verdict: "dead" | "alive" | "undetermined"; reason: string }`
  - `export type OwnerLivenessDeps = { liveness?: (pid: number) => LivenessVerdict; readStart?: (pid: number) => Promise<string | null> }`
  - `export function parseLstartUtc(text: string): number | null` (epoch seconds)
  - `export async function readProcessStart(pid: number): Promise<string | null>`
  - `export async function classifyOwnerProcess(record: Pick<OwnerRecord, "currentProcessInstanceId" | "lastAffirmedAt"> & { leaseAffirmedAt?: string | null }, deps?: OwnerLivenessDeps): Promise<OwnerVerdict>`
  - `export const OWNER_START_MARGIN_S = 2`

- [ ] **Step 1: Failing tests.**

```ts
const rec = (id: string, lastAffirmedAt = "2026-10-02T04:00:00.000Z", leaseAffirmedAt: string | null = null) => ({ currentProcessInstanceId: id, lastAffirmedAt, leaseAffirmedAt });
const START = Date.parse("2026-10-02T03:59:00.000Z");
it("legacy or malformed id ⇒ undetermined", async () => { expect((await classifyOwnerProcess(rec("pid:100"))).verdict).toBe("undetermined"); });
it("ESRCH ⇒ dead", async () => { expect((await classifyOwnerProcess(rec(`pid:7:${START}`), { liveness: () => ({ verdict: "dead" }) })).verdict).toBe("dead"); });
it("EPERM-like unknown ⇒ undetermined", async () => { /* liveness: unknown */ });
it("alive, holder started before R ⇒ alive", async () => { /* readStart: "Fri Oct  2 03:59:00 2026" */ });
it("alive, holder started after the last affirmation + margin ⇒ dead (pid recycled)", async () => {
  const v = await classifyOwnerProcess(rec(`pid:7:${START}`, "2026-10-02T04:00:00.000Z", "2026-10-02T04:05:00.000Z"),
    { liveness: () => ({ verdict: "alive" }), readStart: async () => "Fri Oct  2 04:05:03 2026" });
  expect(v.verdict).toBe("dead");
});
it("alive, holder started within the margin of R ⇒ alive", async () => { /* 04:05:02 with lease 04:05:00.000 ⇒ alive */ });
it("ps unavailable ⇒ undetermined (Review Focus 2)", async () => { /* readStart: async () => null */ });
it("parseLstartUtc reads UTC whatever TZ the process has", () => {
  const saved = process.env.TZ; process.env.TZ = "America/Los_Angeles";
  try { expect(parseLstartUtc("Fri Oct  2 04:05:03 2026")).toBe(Date.UTC(2026, 9, 2, 4, 5, 3) / 1000); }
  finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});
it("real process: this test process is alive and classified alive", async () => {
  const v = await classifyOwnerProcess(rec(`pid:${process.pid}:${Math.trunc(performance.timeOrigin)}`, new Date().toISOString()));
  expect(v.verdict).toBe("alive");
});
it("real process: a dead child is dead", async () => { /* spawn node -e 0, await exit, classify pid:<pid>:<now> ⇒ dead (pid reuse within ms is negligible; if it reads alive, the start check must still say dead or alive, never throw) */ });
```

- [ ] **Step 2: Red** (module missing).

- [ ] **Step 3: Implement.**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyProcessLiveness, type LivenessVerdict } from "../persistence/fileStore.js";
import type { OwnerRecord } from "../runtime/types.js";

const execFileAsync = promisify(execFile);
export const OWNER_START_MARGIN_S = 2;
export type OwnerVerdict = { verdict: "dead" | "alive" | "undetermined"; reason: string };
export type OwnerLivenessDeps = { liveness?: (pid: number) => LivenessVerdict; readStart?: (pid: number) => Promise<string | null> };

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** `ps -o lstart=` under TZ=UTC prints e.g. "Fri Oct  2 04:05:03 2026" with no zone; read it as UTC, never as local time. */
export function parseLstartUtc(text: string): number | null {
  const match = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (match === null) return null;
  const month = MONTHS[match[1]!];
  if (month === undefined) return null;
  return Date.UTC(Number(match[7]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000;
}

export async function readProcessStart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, timeout: 1_000, maxBuffer: 16 * 1024,
    });
    const text = stdout.trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

function moment(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Spec §4.1: answers `dead` only when the owner's pid is gone, or is held by a process that started after the owner was
 * last known alive (R = the latest of its start, lastAffirmedAt, leaseAffirmedAt). Everything else is `alive` or
 * `undetermined`, and both refuse adoption.
 */
export async function classifyOwnerProcess(
  record: Pick<OwnerRecord, "currentProcessInstanceId" | "lastAffirmedAt"> & { leaseAffirmedAt?: string | null },
  deps: OwnerLivenessDeps = {},
): Promise<OwnerVerdict> {
  const id = record.currentProcessInstanceId;
  const parsed = /^pid:(\d+):(\d+)$/.exec(id);
  if (parsed === null) return { verdict: "undetermined", reason: `owner id ${JSON.stringify(id)} is not pid:<pid>:<startMs>` };
  const pid = Number(parsed[1]), startMs = Number(parsed[2]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(startMs)) return { verdict: "undetermined", reason: `owner id ${JSON.stringify(id)} is out of range` };
  const live = (deps.liveness ?? classifyProcessLiveness)(pid);
  if (live.verdict === "dead") return { verdict: "dead", reason: `owner pid ${pid} does not exist` };
  if (live.verdict === "unknown") return { verdict: "undetermined", reason: `owner pid ${pid}: ${live.reason}` };
  const lstart = await (deps.readStart ?? readProcessStart)(pid);
  const holderStart = lstart === null ? null : parseLstartUtc(lstart);
  if (holderStart === null) return { verdict: "undetermined", reason: `owner pid ${pid} is alive but its start time could not be read` };
  const knownAlive = Math.max(startMs, moment(record.lastAffirmedAt) ?? startMs, moment(record.leaseAffirmedAt) ?? startMs);
  if (holderStart > Math.ceil(knownAlive / 1000) + OWNER_START_MARGIN_S) {
    return { verdict: "dead", reason: `pid ${pid} now belongs to a process started ${lstart} UTC, after the owner was last known alive (${new Date(knownAlive).toISOString()})` };
  }
  return { verdict: "alive", reason: `owner pid ${pid} is alive (started ${lstart} UTC)` };
}
```

- [ ] **Step 4: Green.** **Step 5: Mutations:** M4a replace `parseLstartUtc` body with `Date.parse(text)/1000` ⇒ TZ criterion red; M4b drop `leaseAffirmedAt` from `knownAlive` ⇒ the "recycled pid" criterion must go red (adjust its fixture so `startMs`/`lastAffirmedAt` are earlier than the holder start but `leaseAffirmedAt` is later: then without the lease the holder looks newer ⇒ wrongly dead; the criterion that pins this is "alive, holder started before the lease ⇒ alive" — add it); M4c `unknown ⇒ dead` ⇒ EPERM criterion red.

- [ ] **Step 6: Commit** `feat(ownership): tell a dead owner from a live one by pid and start time, refusing when unsure`.

---

### Task 5: `reapRunProcesses`

**Files:**
- Create: `src/ownership/reapRunProcesses.ts`
- Test: `tests/ownership/reapRunProcesses.test.ts`

**Interfaces:**
- Consumes: `readProcessStart` (Task 4), `appendEvent` (`src/persistence/fileStore.ts`).
- Produces:
  - `export type ReapResult = { ok: true; reaped: number } | { ok: false; reason: string }`
  - `export type ReapDeps = { probeGroup?: (pgid: number) => "gone" | "present" | { error: string }; readStart?: (pid: number) => Promise<string | null>; signalGroup?: (pgid: number, signal: NodeJS.Signals) => void; sleep?: (ms: number) => Promise<void>; graceMs?: number; timeoutMs?: number; pollMs?: number }`
  - `export async function reapRunProcesses(runDir: string, deps?: ReapDeps): Promise<ReapResult>`
  - `export const REAP_GRACE_MS = 5_000, REAP_TIMEOUT_MS = 15_000`

- [ ] **Step 1: Failing tests (T8 + success path).** Real processes: `spawnGroup()` = `spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" })` (ignores TERM, so the SIGKILL path is exercised) and a TERM-honouring variant. Write `<runDir>/claude/1/execute/call-x/process.json` = `{pid, pgid: pid, startedAt: <readProcessStart(pid)>, phase: "execute"}` and `request.json`.

Cases: (1) unfinished call, group alive, matching lstart ⇒ `{ok:true, reaped:1}`, pid gone, one `orphan_process_group_reaped` event; with the TERM-ignoring child and `graceMs: 200` ⇒ still reaped (SIGKILL path). (2) same with `outcome.json` present ⇒ untouched, `reaped: 0`, process still alive (kill it in cleanup). (3) mismatching `startedAt` ⇒ `{ok:false}`, process alive. (4) leader absent but group present ⇒ refuse: use `probeGroup: () => "present"`, `readStart: async () => null`. (5) `probeGroup` returns `{error:"EPERM"}` ⇒ refuse. (6) group outlives timeout: `signalGroup: () => {}`, `timeoutMs: 300` ⇒ refuse. (7) unparseable `process.json` with `request.json` ⇒ refuse; (8) without `request.json` ⇒ skipped, `ok`. (9) a `process.json` under `worktrees/` ⇒ ignored. Refusals write no event (assert `events.jsonl` unchanged).

- [ ] **Step 2: Red.** **Step 3: Implement.**

```ts
import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { appendEvent } from "../persistence/fileStore.js";
import { readProcessStart } from "./ownerLiveness.js";

export const REAP_GRACE_MS = 5_000;
export const REAP_TIMEOUT_MS = 15_000;
export type ReapResult = { ok: true; reaped: number } | { ok: false; reason: string };
export type ReapDeps = { /* as Interfaces */ };
type Registered = { pid: number; pgid: number; startedAt: string; phase: string };

const exists = (path: string) => access(path).then(() => true, () => false);

async function unfinishedCalls(runDir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, top: boolean): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === "process.json") && !entries.some((e) => e.isFile() && e.name === "outcome.json")) found.push(dir);
    for (const e of entries) if (e.isDirectory() && !(top && e.name === "worktrees")) await walk(join(dir, e.name), false);
  }
  await walk(runDir, true);
  return found.sort();
}

function parseRegistered(text: string): Registered | null {
  try {
    const v = JSON.parse(text) as Partial<Registered>;
    const ok = Number.isSafeInteger(v.pid) && v.pid! > 0 && Number.isSafeInteger(v.pgid) && v.pgid! > 0 && typeof v.startedAt === "string" && v.startedAt !== "" && typeof v.phase === "string";
    return ok ? (v as Registered) : null;
  } catch { return null; }
}

function defaultProbe(pgid: number): "gone" | "present" | { error: string } {
  try { process.kill(-pgid, 0); return "present"; }
  catch (e) { const code = (e as NodeJS.ErrnoException).code; return code === "ESRCH" ? "gone" : { error: String(code) }; }
}

/** Spec §4.2. Only calls the adapter never finished (no outcome.json); reaps only an exact lstart match; refuses when unsure. */
export async function reapRunProcesses(runDir: string, deps: ReapDeps = {}): Promise<ReapResult> {
  const probe = deps.probeGroup ?? defaultProbe;
  const readStart = deps.readStart ?? readProcessStart;
  const signal = deps.signalGroup ?? ((pgid, sig) => { try { process.kill(-pgid, sig); } catch { /* raced to exit */ } });
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const graceMs = deps.graceMs ?? REAP_GRACE_MS, timeoutMs = deps.timeoutMs ?? REAP_TIMEOUT_MS, pollMs = deps.pollMs ?? 100;
  const targets: Registered[] = [];
  for (const dir of await unfinishedCalls(runDir)) {
    const registered = parseRegistered(await readFile(join(dir, "process.json"), "utf8").catch(() => ""));
    if (registered === null) {
      if (!(await exists(join(dir, "request.json")))) continue; // the runner never received a prompt
      return { ok: false, reason: `${join(dir, "process.json")} is unreadable and the call had a request` };
    }
    const state = probe(registered.pgid);
    if (state === "gone") continue;
    if (typeof state === "object") return { ok: false, reason: `process group ${registered.pgid}: ${state.error}` };
    const lstart = await readStart(registered.pid);
    if (lstart === null) return { ok: false, reason: `process group ${registered.pgid} is alive but its leader ${registered.pid} is gone` };
    if (lstart !== registered.startedAt.trim()) return { ok: false, reason: `pid ${registered.pid} started ${lstart}, not ${registered.startedAt}` };
    targets.push(registered);
  }
  const waitGone = async (pgid: number, ms: number) => {
    for (let waited = 0; waited <= ms; waited += pollMs) { if (probe(pgid) === "gone") return true; await sleep(pollMs); }
    return probe(pgid) === "gone";
  };
  for (const t of targets) {
    signal(t.pgid, "SIGTERM");
    if (!(await waitGone(t.pgid, graceMs))) {
      signal(t.pgid, "SIGKILL");
      if (!(await waitGone(t.pgid, timeoutMs))) return { ok: false, reason: `process group ${t.pgid} survived SIGKILL for ${timeoutMs}ms` };
    }
    await appendEvent(runDir, { type: "orphan_process_group_reaped", at: new Date().toISOString(), detail: `pid ${t.pid} pgid ${t.pgid} phase ${t.phase}` });
  }
  return { ok: true, reaped: targets.length };
}
```

- [ ] **Step 4: Green. Step 5: Mutations:** M5a drop the `outcome.json` exclusion ⇒ case (2) red; M5b treat `lstart === null` as reapable ⇒ case (4) red; M5c skip the SIGKILL ⇒ TERM-ignoring case red. **Step 6: Commit** `feat(ownership): reap a run's unfinished process groups when their identity is certain`.

---

### Task 6: `resume` adopts a killed run

**Files:**
- Create: `src/controller/adoptCrashedRun.ts`
- Modify: `src/controller/resumeLoop.ts` (`resumeLoop` ~:180–300)
- Test: `tests/controller/resumeCrashAdoption.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 4, 5; `applyOwnerEpochTransfer` (`src/ownership/ownerController.ts`); `writeOwnerTransferArtifacts`, `readOwnerRecord`, `readOwnerTransferRecord`, `readReconciliationRecord`, `readRunState`, `appendEvent` (`fileStore.ts`); `buildProcessInstanceId`.
- Produces:
  - `export async function isOrcaControlRunDir(runDir: string): Promise<boolean>` (in `adoptCrashedRun.ts`; used by Task 8)
  - `export async function adoptCrashedRun(runDir: string, ownerRecord: OwnerRecord, runState: RunState, deps?: { classify?: typeof classifyOwnerProcess }): Promise<{ ok: true } | { ok: false; reason: string }>`

- [ ] **Step 1: Failing tests.** Base on `tests/controller/resumeLoop.integration.test.ts` helpers (copy `createRepo`, `createContract`; seed with the shape of its `seedEligibleRun` but **without** `owner-transfer.json`/`reconciliation-record.json`). Owner id of a really dead process: spawn `node -e 0`, await exit, use `pid:<pid>:<Date.now()-1000>`; `leaseAffirmedAt` = `new Date(Date.now() - LEASE_TTL_MS - 1000).toISOString()`. Adapter: `ScriptedAdapter` with `successFrame()` (copy from the same file).

```ts
it("T6: adopts a killed run and continues it to succeeded", async () => { /* resumeLoop(runDir, adapter) ⇒ status succeeded; events include owner_crash_adopted before resume_adopted; owner-record epoch = seeded + 1; owner-transfer.json reason "owner process confirmed dead by resume" */ });
it("adopts a killed run whose lease was never affirmed (Review Focus 1)", async () => { /* leaseAffirmedAt: null */ });
it("refuses when the owner is alive (pid = this process)", async () => { /* ResumeNotEligibleError, detail contains "alive"; snapshot(runDir) minus events.jsonl unchanged */ });
it("refuses a legacy owner id", async () => { /* pid:100 ⇒ "undetermined" */ });
it("T9: two concurrent resumes adopt exactly once", async () => { /* Promise.allSettled of two resumeLoop calls with separate ScriptedAdapters; exactly one fulfilled */ });
it("T9b: replaces a reconciliation record left without a transfer and says so", async () => { /* seed reconciliation with newOwnerEpoch null; adopt; event detail contains "replaced" */ });
it("T9c: a run with a transfer and a live unfinished registered group: reaped, then resumed", async () => { /* seedEligibleRun shape + process.json of a detached TERM-honouring node child, no outcome.json */ });
it("T6b: a killed run with a live orphan group: reaped, orphan_process_group_reaped recorded, then adopted", async () => {});
it("T9d: refuses an Orca control run", async () => { /* runDir = <dir>/run with mkdir <dir>/control */ });
it("a second resume after adoption takes today's path (Review Focus 3)", async () => { /* after T6 success: second resumeLoop ⇒ refused "run status succeeded is not resumable", no second owner_crash_adopted */ });
```

- [ ] **Step 2: Red. Step 3: Implement `adoptCrashedRun.ts`.**

```ts
import { stat, access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { applyOwnerEpochTransfer } from "../ownership/ownerController.js";
import { classifyOwnerProcess } from "../ownership/ownerLiveness.js";
import { appendEvent, writeOwnerTransferArtifacts } from "../persistence/fileStore.js";
import { buildProcessInstanceId } from "../runtime/processIdentity.js";
import type { OwnerRecord, ReconciliationRecord } from "../runtime/types.js";
import type { RunState } from "../state/types.js";

export const CRASH_ADOPTION_REASON = "owner process confirmed dead by resume";
const BOUNDARY = { planning: "planning", executing: "execute", verifying: "verify" } as const;

/** Spec §4.3 step 3: a run directory inside an Orca control source dir is Orca's to recover. */
export async function isOrcaControlRunDir(runDir: string): Promise<boolean> {
  if (basename(runDir) !== "run") return false;
  return stat(join(dirname(runDir), "control")).then((s) => s.isDirectory(), () => false);
}

export async function adoptCrashedRun(runDir: string, ownerRecord: OwnerRecord, runState: RunState, deps: { classify?: typeof classifyOwnerProcess } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const boundary = BOUNDARY[runState.status as keyof typeof BOUNDARY];
  if (boundary === undefined) return { ok: false, reason: `run status ${runState.status} is not resumable` };
  const owner = await (deps.classify ?? classifyOwnerProcess)(ownerRecord);
  if (owner.verdict !== "dead") return { ok: false, reason: `no owner transfer and the owner is ${owner.verdict}: ${owner.reason}` };
  const at = new Date().toISOString();
  const transfer = applyOwnerEpochTransfer(ownerRecord, buildProcessInstanceId(), at, CRASH_ADOPTION_REASON);
  const reconciliation: ReconciliationRecord = {
    staleSuspicionBasis: [`lease not fresh (leaseAffirmedAt ${String(ownerRecord.leaseAffirmedAt ?? null)})`, owner.reason],
    staleConfirmed: true, ownershipVerdict: "OWNER_LOST", lastTrustedBoundary: boundary, conflictingEvidence: [],
    takeoverPermission: { allowed: true, reason: CRASH_ADOPTION_REASON },
    priorOwnerEpoch: ownerRecord.currentOwnerEpoch, newOwnerEpoch: transfer.transferRecord.newOwnerEpoch, eligibleForContinuation: true,
  };
  const replaced = await access(join(runDir, "reconciliation-record.json")).then(() => true, () => false);
  await writeOwnerTransferArtifacts(runDir, ownerRecord, transfer.nextOwnerRecord, transfer.transferRecord, reconciliation);
  await appendEvent(runDir, {
    type: "owner_crash_adopted", at,
    detail: `epoch ${transfer.transferRecord.priorOwnerEpoch} -> ${transfer.transferRecord.newOwnerEpoch}: ${ownerRecord.currentProcessInstanceId} confirmed dead (${owner.reason})${replaced ? "; replaced a reconciliation record that had no transfer" : ""}`,
  });
  return { ok: true };
}
```

(Check `OwnerRecord` really has `leaseAffirmedAt?`; `ReconciliationRecord` fields per `src/runtime/types.ts:121`. `writeOwnerTransferArtifacts` throws its lock/CAS errors; the caller maps them.)

- [ ] **Step 4: Wire into `resumeLoop`.** After the lease check and before the big `try`:

```ts
  if (await isOrcaControlRunDir(runDir)) return deny("run directory belongs to an Orca control store; Orca recovers it");
```

where `deny(detail)` is a local helper doing what the existing refusals do (`appendEvent resume_denied` + `throw new ResumeNotEligibleError(detail)`); do not change the existing refusal sites' text. Inside the `try`, after `ownerRecord = await readOwnerRecord(runDir);`:

```ts
    const reap = await reapRunProcesses(runDir);
    if (!reap.ok) { deniedDetail = `orphan process groups not reaped: ${reap.reason}`; throw new CrashAdoptionRefused(); }
    const transferMissing = await readOwnerTransferRecord(runDir).then(() => false, (e: NodeJS.ErrnoException) => { if (e?.code === "ENOENT") return true; throw e; });
    if (transferMissing) {
      const stateNow = await readRunState(runDir);
      let adopted;
      try { adopted = await adoptCrashedRun(runDir, ownerRecord, stateNow); }
      catch (error) { deniedDetail = lockOrCasDetail(error); throw new CrashAdoptionRefused(); }
      if (!adopted.ok) { deniedDetail = adopted.reason; throw new CrashAdoptionRefused(); }
      ownerRecord = await readOwnerRecord(runDir); // spec C3: the step-2 record is one epoch behind
    }
    [ownerTransfer, reconciliation, runState, contract] = await Promise.all([...as today...]);
```

`CrashAdoptionRefused` is a module-private sentinel class; the existing `catch` gets a first branch `if (error instanceof CrashAdoptionRefused) { append resume_denied with deniedDetail; throw new ResumeNotEligibleError(deniedDetail) }`. `lockOrCasDetail` reuses the claim step's mapping (`owner-transfer lock unattributable/busy/liveness undetermined`, else `claim CAS failed: …`) — extract that mapping into a local function used by both sites, keeping the exact strings. The existing verbatim comments stay where they are.

- [ ] **Step 5: Green**, then run alone `resumeLoop.integration.test.ts`, `resumeLoop.gate.test.ts`, `tests/cli/agentsResume.test.ts`, `leaseLifecycle.integration.test.ts`, `cli.test.ts`, `zeroWrite.test.ts`. Any criterion that expected `cannot read run artifacts: ENOENT … owner-transfer.json` for a seeded run without a transfer now gets the owner check instead (legacy id ⇒ `undetermined` refusal): record each by name for the ledger (pending ratification) and rewrite it whole to assert the new refusal text, no loosening.

- [ ] **Step 6: Mutations.** M6a remove the re-read ⇒ T6 red ("superseded"). M6b skip `reapRunProcesses` ⇒ T6b/T9c red. M6c remove the control guard ⇒ T9d red. M6d make `adoptCrashedRun` skip `classify` ⇒ "owner alive" red.

- [ ] **Step 7: Commit** `feat(resume): adopt a killed run once its owner is confirmed dead and its orphans reaped`.

---

### Task 7: CLI crash end-to-end and README §3.2

**Files:**
- Test: `tests/cli/crashResume.test.ts` (new)
- Modify: `README.md` §3.2

- [ ] **Step 1: Failing test (T6 through the CLI).** Claude table with fake claude in `script` mode (see `tests/control/agentsFixture.ts` `claudeInstallation`/`writeAgentsTable` and `tests/cli/agentsRun.test.ts` for a `run --agents` invocation with claude). Script: task entry with `files: {"answer.txt": "x\n"}` and `delayMs: { execute: 60000 }`. Start `ccloop run --agents …` with `spawn(process.execPath, ["--import", loader, cli, ...], { detached: true })`; poll `events.jsonl` until `execute_started`, poll the call dir for `process.json`; record the runner pid; `process.kill(-ccloopPid, "SIGKILL")` … **note: kill only ccloop's own pid (`process.kill(ccloopPid, "SIGKILL")`), not its group, so the runner (its own group) survives the kill and the parent watch is what stops it.** Assert the runner pid is gone within 5 s + 3 s. Then rewrite the script with `delayMs` removed, rewrite `owner-record.json`'s `leaseAffirmedAt` to `LEASE_TTL_MS + 1000` ms ago (the lease ageing is simulated; the kill is real — say so in a comment), run `ccloop resume --run-dir … --agents …`; expect RC 0, status `succeeded`, events contain `owner_crash_adopted`.

- [ ] **Step 2: Red** before Task 6 lands (if executed in order it may already pass — then show it red with M6b-style mutation in a clone: revert `resumeLoop.ts` to the pre-Task-6 version ⇒ refusal ENOENT). **Step 3:** README §3.2: replace the paragraph after the code block with what `resume` now does (spec §4.3, §4.5) and the Ctrl-C consequences; keep the existing first two sentences (`不需要 --agent-selection…`, `不需要 --contract…`). Write in the README's language (Chinese prose, like the rest of the file).

- [ ] **Step 4: Commit** `test(cli): a SIGKILLed run resumes from the CLI; README says what resume now does`.

---

### Task 8: sweep takes killed runs

**Files:**
- Modify: `src/sweep/sweepRuns.ts` (candidate filter ~:119, banner ~:173), `README.md` §3.4
- Test: `tests/sweep/sweepCrashCandidates.test.ts` (new)

**Interfaces:**
- Consumes: `isOrcaControlRunDir` (Task 6), `LEASE_TTL_MS`.

- [ ] **Step 1: Failing tests (T10).** Use `harness`/`runRow` style from `tests/sweep/sweepRuns.test.ts` (copy what you need). Rows: A eligible (class a); B transfer absent, status `executing`, lease `observedAt − 91 s` (class b); C class-b shape but lease `observedAt − 10 s` (not a candidate); D class-b shape with lease `null` (not a candidate, R2); E class-b shape, status `succeeded` (not). Expect: the existing banner line counts 1, the second line `sweep: 1 run(s) under /fake/root have no owner-transfer.json, a resumable status and an expired lease (observed fields; each is resumed only if its owner is confirmed dead)` follows it; `resume` called for A and B in path order; a resume rejection on B does not stop A (order them so B comes first). With no class-b row, stderr has exactly the old banner (no second line).

- [ ] **Step 2: Red. Step 3: Implement.**

```ts
const RESUMABLE = new Set(["planning", "executing", "verifying"]);
function present(row: RunObservation, file: string, field: string): unknown {
  const observation = row.files.find((f) => f.file === file)?.fields[field];
  return observation?.kind === "present" ? observation.value : undefined;
}
// Spec §4.4 class (b): observed fields only -- the transfer file absent, a resumable status, and a lease timestamp older
// than LEASE_TTL_MS at the row's observedAt. A null lease is not a candidate (controller ruling R2). Whether the owner is
// really dead is resumeLoop's question, not this filter's.
function isObservedCrashed(row: ScanRow): row is RunObservation {
  if (row.kind !== "run") return false;
  if (row.files.find((f) => f.file === "owner-transfer.json")?.fields["eligibleForContinuation"]?.kind !== "absent") return false;
  if (!RESUMABLE.has(present(row, "loop-state.json", "status") as string)) return false;
  const lease = present(row, "owner-record.json", "leaseAffirmedAt");
  if (typeof lease !== "string") return false;
  const leaseMs = Date.parse(lease), observedMs = Date.parse(row.observedAt);
  return !Number.isNaN(leaseMs) && !Number.isNaN(observedMs) && observedMs - leaseMs >= LEASE_TTL_MS;
}
```

Candidates: `eligible = rows.filter(isObservedEligible)`; `crashed = []` then for each `rows.filter(isObservedCrashed)` keep those with `!(await isOrcaControlRunDir(row.path))`; `candidates = [...eligible, ...crashed].sort(byPath)`. Banner: the existing `options.stderr(...)` call with `eligible.length` (unchanged text); then `if (crashed.length > 0) options.stderr(\`sweep: ${crashed.length} run(s) under ${options.root} have no owner-transfer.json, a resumable status and an expired lease (observed fields; each is resumed only if its owner is confirmed dead)\`);`. Add a comment pointing at spec §4.4 and that the wording is pending human ratification (H8). Check `ScanRow` row `observedAt` exists on `RunObservation` (it does in the fixture).

- [ ] **Step 4: Green**, then `sweepRuns.test.ts`, `zeroWrite.test.ts`, `cli.test.ts`, `agentsResume.test.ts` alone. **Step 5: Mutations:** M8a drop the lease-age test ⇒ row C becomes a candidate ⇒ red; M8b accept `null` ⇒ row D red; M8c always print the second line ⇒ "no class-b row" red. **Step 6:** README §3.4 gains the second line and one sentence on class (b). **Commit** `feat(sweep): also resume runs killed outright, counted on their own banner line`.

---

### Task 9: R-B — claude's own partial with changed files goes to verify; prompt names the checks

**Files:**
- Modify: `scripts/claude-phase-runner.mjs` (`buildPartialExecutionOutcome` ~:237, the structured-answer path in `main` ~:495), `src/runtime/types.ts` (`PartialExecutionResult`), `src/controller/runLoop.ts` (partial branch ~:1531–1572), `src/runtime/claude/prompts.ts` (`buildExecutorPrompt`)
- Test: `tests/controller/partialToVerify.test.ts` (new), `tests/runtime/claude/claudePhaseRunnerPartialOrigin.test.ts` (new), prompt case in the new runner test file

**Interfaces:**
- Produces: `PartialExecutionResult.partialOrigin?: "runner"`.

- [ ] **Step 1: Failing tests.** runLoop level with `ScriptedAdapter` (see `tests/controller/runLoop.integration.test.ts` for constructing a run with a scripted execute frame that returns a partial; copy its contract helper with `verifierType: "command"` and `requiredChecks: ["true"]` / `["false"]`):

```ts
it("T11a: claude's own partial error with changed files goes to verify and succeeds when checks pass", async () => {
  // execute frame: {changedFiles:["src/index.ts"], diffPatch:"…", commandOutputs:[], stdoutStderrLog:"", completionStatus:"partial", failureType:"error", failureMessage:"tests could not be run"}
  // requiredChecks ["true"] ⇒ status succeeded; events include partial_execute_sent_to_verify
});
it("T11b: a failing required check gives today's stop decision", async () => { /* requiredChecks ["false"] ⇒ status failed (safeToRetry false), verify ran */ });
it("T11c: no changed files ⇒ failed without verify", async () => {});
it("T11d: a runner-built partial (partialOrigin runner) ⇒ failed without verify", async () => {});
it("T11e: timeout partial ⇒ exhausted, unchanged", async () => {});
it("T11f: budget exceeded after execute ⇒ exhausted before verify", async () => { /* tokenBudget tiny so execute usage exceeds it */ });
```

Runner level: a fake claude that writes a file then exits 1 ⇒ runner's failure partial carries `partialOrigin: "runner"`; a fake claude whose structured answer includes `partialOrigin` ⇒ stripped from the runner's stdout. Prompt: `buildExecutorPrompt(context)` contains `Required checks (run by the verifier in this worktree after you finish):`, each check line, and the instruction sentence (T12).

- [ ] **Step 2: Red. Step 3: Implement.**

Runner: in `buildPartialExecutionOutcome`'s returned object add `partialOrigin: "runner",`. In main's structured path, before `partialExecutionRuleBroken`: `if (request.phase === "execute" && Object.prototype.hasOwnProperty.call(structured, "partialOrigin")) delete structured.partialOrigin;` (comment: spec §5.1, only the runner may say a partial is its own).

Types: `partialOrigin?: "runner";` on `PartialExecutionResult` with a one-line comment.

runLoop: in the `isPartialExecutionResult(completedExecution)` branch, after the `partialPathPolicy.humanGateHit` return and before `persistTerminalState(... exhausted/failed)`:

```ts
        // Spec §5.1 (R-B): claude's own `error` partial that changed files is judged by verify, not thrown away -- the
        // verify phase runs requiredChecks in this worktree. Falls through to the path a complete execution takes,
        // budget check included. Runner-built partials (partialOrigin) and `timeout` keep today's terminal decision.
        const sendToVerify = completedExecution.failureType === "error"
          && completedExecution.partialOrigin === undefined
          && completedExecution.changedFiles.length > 0;
        if (sendToVerify) {
          await appendEvent(runDir, {
            type: "partial_execute_sent_to_verify",
            at: new Date().toISOString(),
            detail: `failureType error, ${completedExecution.changedFiles.length} changed file(s): ${completedExecution.failureMessage}`,
          });
        } else {
          state = await persistTerminalState(/* unchanged */);
          await heartbeat.assertHeld();
          await cleanupAttemptWorkspaceBestEffort(/* unchanged */);
          return state;
        }
      }
```

so control continues to the existing `const pathPolicy = evaluatePathPolicy(...)` block. Before relying on that, read the code from there to the verify call and confirm: writing the attempt artifacts a second time (`writeCompletedAttemptArtifacts` at the start of the partial branch and again later) only overwrites the same files; the verify path treats `execution` as an `ExecutionResult` without assuming `completionStatus` is absent (grep `isPartialExecutionResult` uses downstream). If a downstream site would misread a partial, handle it there and say so in the commit body.

Prompt (`buildExecutorPrompt`, after the `Success condition` line):

```ts
    "Required checks (run by the verifier in this worktree after you finish):",
    formatList(contract.verification.requiredChecks),
    "If you cannot run a command (for example it needs approval), do not report partial or error for that reason; deliver your changes and say in stdoutStderrLog which commands you could not run.",
```

The codex adapter appends to `buildExecutorPrompt` too (`codexAdapter.ts:42`); that is intended (same contract), note it in the commit body.

- [ ] **Step 4: Green**, then alone: `runLoop.integration.test.ts` (it pins partial-error terminals; record every changed expectation by name), `claudePhaseRunner.test.ts` (it asserts the executor prompt text and partial shapes), `claudePhaseSchemas.test.ts`, `codexAdapter.test.ts`, `tests/runtime/codex/contracts.test.ts`, `evidence.test.ts`.

- [ ] **Step 5: Mutations.** M9a `sendToVerify = false` ⇒ T11a red. M9b drop the `partialOrigin` condition ⇒ T11d red. M9c drop the `changedFiles.length > 0` condition ⇒ T11c red. M9d remove `partialOrigin` from the runner's partial ⇒ runner-level criterion red. M9e remove the prompt lines ⇒ T12 red.

- [ ] **Step 6: Commit** `fix(loop): send claude's own partial error with changed files to verify, and tell execute who runs the checks`.

---

### Task 10: Gate, ledger, paid acceptance (controller)

**Files:**
- Create: `.superpowers/sdd/2026-10-02-crash-resume/progress.md` (`git add -f`)

- [ ] **Step 1: Full gate in a fresh clone** (Global Constraints env): `npm run build`, `npm run typecheck`, `./node_modules/.bin/vitest run --reporter=json --outputFile=$SCRATCH/gate/vitest.json > $SCRATCH/gate/vitest.txt 2>&1`, `node scripts/check-known-reds.mjs $SCRATCH/gate/vitest.json > $SCRATCH/gate/kr.txt 2>&1; echo $? >> $SCRATCH/gate/kr.txt`, `node scripts/check-tmp-leak.mjs > $SCRATCH/gate/leak.txt 2>&1; echo $?`. Read every file back whole. Also `pgrep -fl "fake-claude-cli|claude-phase-runner|runner-parent"` must be empty (RC 1) after the suite.
- [ ] **Step 2: Ledger.** Sections: who/when/which commit (subject lines); the rulings table H1–H8, R1, R2; one row per task (commit subject, criteria added, mutations with the red line each produced, existing criteria rewritten with `Ruling (controller, pending human ratification)` and the ruling-88 three conditions); gate raw numbers with the command; capacity lower bound (Task 3 Step 9); open items.
- [ ] **Step 3: Paid acceptance (spec §9).** In a clone with `dist/` built, claude from the agents table produced by `ccloop agents detect` (isolation args as drafted, `--max-budget-usd 1`), a scratch git repo with one-file task. Record the install dir mtime of claude before and after. `run --agents` detached; at `execute_started` + 5 s record `ps -o pid,pgid,ppid,command -g <runnerPgid>` and `lsof -p <pid>` for each member into files; SIGKILL ccloop's pid only; assert runner group gone within 8 s (`pgrep`/`kill -0`); wait out the lease (≥ 91 s, real); `resume --agents`; record terminal status. Spend = sum of `total_cost_usd` from the kept claude streams (use Orca's `scripts/claude-tee.mjs` wrapper the way the 2026-10-01 ledger did if available, otherwise report the spend as not available). Write it all in the ledger.
- [ ] **Step 4: Commit** `docs(sdd): ledger of the crash-resume round -- tasks, mutations, gate, paid run`.
