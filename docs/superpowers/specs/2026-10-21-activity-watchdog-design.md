# Activity watchdog: a phase that goes quiet is stopped as `stalled`

- **Author:** Orca session `9ec98639` (2026-10-21), background track D. Code references are ccloop main `75343fd`.
- **Status:** design; not planned. **Human ruling** (Orca ledger `.superpowers/sdd/2026-10-20-session-308b874c/progress.md`,
  "Activity watchdog: 同意按你的建议走"): the wall clock stays the hard ceiling (default relaxed); a new idle limit,
  default **10 min per installation**; an idle stop is recorded `stalled` = transient/retryable; ccloop spec first.
- **Depends on:** `2026-10-21-failure-causes-and-transient-retries-design.md` (the `stalled` cause and the in-phase retry
  loop). Lands after it or in the same round.

## 1. Today

Each phase has one timer: the installation's `timeoutMs` capped by the run's remaining time
(`src/runtime/codex/runCodexPhase.ts:52`, `:103`; `src/runtime/claude/claudeAgentAdapter.ts:187`, `:232`;
`src/runtime/omp/runOmpPhase.ts:56`, `:98`). A hung agent (no output, waiting on a dead connection) is noticed only when
that timer fires — 30 min per phase with detect's draft value (`src/agents/detect.ts:25`, `DRAFT_TIMEOUT_MS`; the
human's table, read 2026-10-21, has `1800000` for all three installations).

## 2. Design

### 2.1 Configuration (agents table, per installation)

- New optional common field `idleTimeoutMs` in `commonInstallation` (`src/agents/table.ts:10-17`): a positive safe
  integer ≤ `timeoutMs`, or `null` = no idle watchdog. **Absent ⇒ 600 000** (10 min). Strict parsing stays; a table
  without the field parses as today. The field is part of the installation, so it enters `configHash` only for a table
  that sets it.
- Wall clock "relaxed": detect's draft `timeoutMs` goes 1 800 000 → **7 200 000** (2 h) for newly detected installations.
  Existing tables are the person's data and are not rewritten (Orca's auto-refresh rewrites `version` only).

### 2.2 What counts as activity (what ccloop actually observes, per kind)

A phase runner keeps `lastActivityAt` and `openTools` (count). The idle timer fires when `openTools === 0` and
`now − lastActivityAt ≥ idleTimeoutMs`. While a tool is open the idle timer is suspended (a long test suite produces no
agent output while it runs); a hung tool is caught by the wall clock only (§5).

- **codex** (`runCodexPhase`, stdout `--json` JSONL): any stdout or stderr bytes are activity (`:106-115`). Each complete
  stdout line is parsed once more for tool state: `item.started` with `item.type` ∈ {`command_execution`,
  `mcp_tool_call`, `web_search`} adds its `item.id`; `item.completed` with that id removes it. An unparseable line is
  activity only.
- **claude**: the adapter sees only the runner's final stdout, so the runner reports activity. It gets a fifth stdio pipe
  (fd 4; fd 3 is the parent-watch pipe, `claudeAgentAdapter.ts:201-204`) and writes JSON lines
  `{"openTools":n}\n` — on every claude stdout chunk, throttled to one line per second unless `openTools` changed.
  `openTools`: a `tool_use` content block in an assistant message adds its id; a `tool_result` with that id in a user
  message removes it (both are stream-json lines the runner already parses, `scripts/claude-phase-runner.mjs:596`).
  Any line on fd 4 is activity. `CCLOOP_CLAUDE_ACTIVITY_FD=4` is set only for adapter-spawned runners and stripped from
  claude's env (as `:426`). A runner without fd 4 (tests calling it directly) reports nothing and is not watched.
- **omp** (`runOmpProcess`, stdout `--mode json`): any stdout/stderr bytes are activity (`:100-111`);
  `tool_execution_start` adds `toolCallId`, `tool_execution_end` removes it.

### 2.3 Stopping

- On idle: the runner's existing `stop(...)` with a new reason **`stalled`** (SIGTERM, grace, SIGKILL — the same path as
  `timeout`). `outcome.json` gains `idle: { limitMs, lastActivityAt, openTools }`.
- Outcome reason unions gain `"stalled"` (`runCodexPhase.ts:18`, `claudeAgentAdapter.ts:95`, `runOmpPhase.ts:15`).
- Adapters treat `stalled` like `timeout` for result recovery: claude's after-stop branch (`claudeAgentAdapter.ts:284`)
  accepts `stalled` too, so an execute that printed a partial still yields it (and goes to verify as today). Otherwise
  the adapter throws `<kind>-stalled: <dir>` (`codex-stalled`, `claude-stalled`, `omp-stalled`) carrying
  `observedTokens` as the `timeout` error does, plus `failureCause: "stalled"` and `workObserved`.
- The failure-causes retry loop then retries it when safe (read-only phase, or no work observed; ≤3 per phase; within
  the phase limit). Otherwise the run ends `failed` with `failureCause.cause = "stalled"`.
- `runPhaseWithTimeout`'s own timer (`src/controller/runLoop.ts:499-579`) is the outer ceiling and is unchanged.

## 3. Wire and Orca impact

- New `stopReason` prefixes `codex-stalled:`, `claude-stalled:`, `omp-stalled:` (free string, bounded by Orca's
  `boundStopReason`); the typed signal is `failureCause.cause === "stalled"` (failure-causes spec §5).
- Agents table: optional `idleTimeoutMs`. Orca's agent-installation protocol keeps installations as `z.unknown()`
  (`Orca/src/control/agentInstallationProtocol.ts:23`); Orca's version auto-refresh must keep unknown fields when it
  rewrites `version` — verify in Orca before the repin (add to the ccloop handoff's Orca dependency list).
- `capabilities`, `features`, collect schemas: unchanged.

## 4. Tests (each red first with its named mutation, in a `git clone --local` copy)

1. Table: absent ⇒ 600 000 effective; `null` ⇒ no watchdog; `0`, negative, > `timeoutMs`, non-integer ⇒
   `agents-table-invalid`. Mutation: drop the `≤ timeoutMs` refine.
2. Per kind, fake CLI that prints one line then sleeps past a short idle limit (test option; real default untouched):
   outcome `stalled`, `outcome.json.idle` present, process group gone. Mutation: never arm the idle timer ⇒ the test
   reaches the wall clock and reports `timeout` (red).
3. Activity resets: fake prints a line every 0.3 × idle for 3 × idle ⇒ `completed`. Mutation: don't reset on stderr
   (codex/omp: fake writes only to stderr) ⇒ red.
4. Open tool suspends: fake emits a tool start, sleeps 2 × idle, emits the end and finishes ⇒ `completed`; same without
   the end event ⇒ wall clock `timeout`. Mutation: ignore `openTools` ⇒ first case `stalled` (red).
5. Claude fd 4: runner with a fake claude streaming chunks writes throttled lines; a tool_use/tool_result pair moves
   `openTools` 1 → 0. Mutation: drop the throttle exception for `openTools` changes ⇒ the change is not reported within
   the window (red).
6. Execute stalled after a tool ran (claude, partial printed) ⇒ partial reaches verify; codex execute stalled after work ⇒
   no in-phase retry, run `failed`, `failureCause.cause === "stalled"`. Plan stalled before work ⇒ retried once, then
   success.
7. Draft `timeoutMs` 7 200 000 in `agents detect` output; existing-table criteria unchanged.

## 5. Decisions (controller's calls, reversible)

1. An open tool suspends the idle clock (no false kills of long test runs); a hung tool is left to the wall clock.
2. Activity = bytes from the agent CLI (codex/omp stdout+stderr; claude via the runner's fd-4 lines), not CPU time.
3. `null` disables; absent = 10 min (human's default).
4. Only newly detected installations get the relaxed 2 h wall clock; existing tables are not touched.
5. `stalled` reuses `timeout`'s stop and recovery path; only the reason name and the cause differ.

## 6. Open (not blocking)

- Whether codex emits nothing for > 10 min during long `xhigh` reasoning: measure on a real run (paid ⇒ ask); the
  per-installation `idleTimeoutMs` is the escape hatch.
