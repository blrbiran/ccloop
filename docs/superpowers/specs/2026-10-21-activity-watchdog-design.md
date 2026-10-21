# Activity watchdog: a phase that goes quiet is stopped as `stalled`

- **Author:** Orca session `9ec98639` (2026-10-21), background track D. **Code references are ccloop main `71d650c`.**
- **Status:** design; not planned; revised after independent review round 1 (last section). **Human ruling** (Orca
  ledger `.superpowers/sdd/2026-10-20-session-308b874c/progress.md`, "Activity watchdog: 同意按你的建议走"): the wall
  clock stays the hard ceiling (default relaxed); a new idle limit, default **10 min per installation**; an idle stop is
  recorded `stalled` = transient/retryable; ccloop spec first.
- **Depends on:** `2026-10-21-failure-causes-and-transient-retries-design.md` (the `stalled` cause, the precedence table,
  the in-phase retry loop). Lands after it or in the same round.

## 1. Today

Each phase has one timer: the installation's `timeoutMs` capped by the run's remaining time
(`src/runtime/codex/runCodexPhase.ts:52`, `:103`; `src/runtime/claude/claudeAgentAdapter.ts:187`, `:232`;
`src/runtime/omp/runOmpPhase.ts:56`, `:98`), inside `runPhaseWithTimeout`'s per-attempt ceiling
(`src/controller/runLoop.ts:533-605`). A hung agent (no output, waiting on a dead connection) is noticed only when a timer
fires — 30 min per phase with detect's draft value (`src/agents/detect.ts:25`, `DRAFT_TIMEOUT_MS`; the human's table,
read 2026-10-21, has `1800000` for all three installations).

## 2. Design

### 2.1 Configuration (agents table, per installation)

- New optional common field `idleTimeoutMs` in `commonInstallation` (`src/agents/table.ts:10-17`): a positive safe
  integer, or `null` = no idle watchdog. The cross-field rule `idleTimeoutMs ≤ timeoutMs` is a `superRefine` on the
  parsed installation (the common fields are a shape merged with each kind's extras, `table.ts:39`). **Absent ⇒ effective
  `min(600 000, timeoutMs)`** (10 min, never above the wall clock, so every existing table stays valid).
- **Not part of `configHash`:** `agentConfigHash` already drops the run limits `timeoutMs`/`killGraceMs`
  (`src/agents/materialize.ts:36-45`); `idleTimeoutMs` is a run limit too and is dropped the same way, so setting it does
  not invalidate Orca's frozen selections.
- Wall clock "relaxed": detect's draft `timeoutMs` goes 1 800 000 → **7 200 000** (2 h) for **newly detected**
  installations only. ⚠️ **For the human:** existing tables are not rewritten (Orca's version auto-refresh rewrites
  `version` only and keeps unknown fields, `Orca/src/agents/versionRefresh.ts:94-104`, checked); the human's three
  installations keep their 30 min wall clock unless edited by hand.

### 2.2 What counts as activity (what ccloop actually observes, per kind)

A phase runner keeps `lastActivityAt`, `openTools` (count) and `toolOpenedAt`. The idle timer fires when
`now − lastActivityAt ≥ idleTimeoutMs` **and** either `openTools === 0`, or a tool has been open with no activity for
`≥ 3 × idleTimeoutMs` (open-tool suspension is capped: a long test suite produces no agent output while it runs, but a
hung tool is not left to the wall clock alone). A tool that stays silent for more than 3 × `idleTimeoutMs` is therefore
stopped as `stalled` and, if the call cannot be retried, the run ends `failed` with cause `stalled`.

- **codex** (`runCodexPhase`, stdout `--json` JSONL): any stdout or stderr bytes are activity (`:106-115`). Each complete
  stdout line is parsed once more for tool state: `item.started` with `item.type` ∈ {`command_execution`,
  `mcp_tool_call`, `web_search`} adds its `item.id`; `item.completed` with that id removes it. An unparseable line is
  activity only.
- **claude**: the adapter sees only the runner's final stdout, so the runner reports activity. It gets a fifth stdio pipe
  (fd 4; fd 3 is the parent-watch pipe, `claudeAgentAdapter.ts:201-204`) and writes JSON lines `{"openTools":n}\n` — on
  every claude stdout chunk, throttled to one line per second unless `openTools` changed. `openTools`: a `tool_use`
  content block in an assistant message adds its id; a `tool_result` with that id in a user message removes it (both are
  stream-json lines the runner already parses, `scripts/claude-phase-runner.mjs:596`). Any line on fd 4 is activity.
  `CCLOOP_CLAUDE_ACTIVITY_FD=4` is set only for adapter-spawned runners and stripped from claude's env (as `:426`). A
  runner without fd 4 (tests calling it directly) reports nothing and is not watched.
- **omp** (`runOmpProcess`, stdout `--mode json`): any stdout/stderr bytes are activity (`:100-111`);
  `tool_execution_start` adds `toolCallId`, `tool_execution_end` removes it.

### 2.3 Stopping a phase

- On idle: the runner's existing `stop(...)` with a new reason **`stalled`** (SIGTERM, grace, SIGKILL — the `timeout`
  path). `outcome.json` gains `idle: { limitMs, lastActivityAt, openTools, toolOpenedAt }`.
- Outcome reason unions gain `"stalled"` (`runCodexPhase.ts:18`, `claudeAgentAdapter.ts:95`, `runOmpPhase.ts:15`).
- **claude partial after an idle stop.** The runner's interrupt path prints a runner-built partial with
  `failureType: "timeout"` (`scripts/claude-phase-runner.mjs:361`); the adapter's after-stop branch
  (`claudeAgentAdapter.ts:284`) accepts `stalled` as it accepts `timeout`, returns that partial and attaches
  `failureCause: "stalled"`. runLoop's runner-partial terminal (`runLoop.ts:1768-1786`, today `timeout` ⇒ `exhausted`)
  checks the cause **first**: a partial carrying `stalled` ⇒ status **`failed`**, `failureCause.cause = "stalled"` —
  before the `timeout` ⇒ `exhausted`/`budget-exhausted` mapping (failure-causes spec §5 row 2). Why `failed`: Orca's ladder
  escalates `failed` and `exhausted` alike, so the reason is the cause mapping — a stall is a transient fault, not a spent
  budget, and `exhausted` would pair it with `budget-exhausted`. The run's `stopReason` is the partial's
  `failureMessage` (`claude phase runner interrupted by SIGTERM`), prefixed by the adapter with `claude-stalled: ` so the
  free string names the stall too. The partial is never retried in-phase (failure-causes spec §4).
- Otherwise the adapter throws `<kind>-stalled: <dir>` (`codex-stalled`, `claude-stalled`, `omp-stalled`) carrying
  `observedTokens` as the `timeout` error does, plus `failureCause: "stalled"` and `workObserved`. The failure-causes
  retry loop retries it when safe (its §4); otherwise the run ends `failed` with `failureCause.cause = "stalled"`.
- **Cost of a false stall:** a retried false stall repeats the call's work (read-only phase or no work observed — so
  tokens, not worktree state) and adds the backoff; the per-installation `idleTimeoutMs` is the escape hatch.
- `runPhaseWithTimeout`'s own timer stays the outer ceiling, unchanged.

### 2.4 Single calls

Single calls run through the same runners — codex `singleCall` → `runCodexPhase` (`codexAdapter.ts:155-192`), omp
`ompSingleCall` → `runOmpProcess` (`src/runtime/omp/ompSingleCall.ts:68`), claude `singleCall`
(`claudeAgentAdapter.ts:363`) → `run` — so they are **watched the same way** (single calls use no tools, so `openTools`
stays 0). A stalled single call throws `<kind>-stalled: <dir>` with `failureCause: "stalled"` and today's
`observedTokens`/`neverStarted` handling. **Not retried inside ccloop:** single-call callers (Orca's estimator) own
retries, and a single call has no phase loop to put the retry in.

## 3. Wire and Orca impact

- New `stopReason` prefixes `codex-stalled:`, `claude-stalled:`, `omp-stalled:` (free string, bounded by Orca's
  `boundStopReason`); the typed signal is `failureCause.cause === "stalled"` (failure-causes spec §5–§6).
- New single-call error codes `<kind>-stalled` reach Orca's single-call path; Orca maps unknown codes as it does today —
  list in the ccloop handoff's Orca dependency list.
- **Version skew:** ccloop's table parse is strict (`src/agents/table.ts:39`), so a ccloop that does not know
  `idleTimeoutMs` refuses the whole table (`agents-table-invalid`). Set `idleTimeoutMs` in `~/.orca/agents.json` only
  after Orca has repinned a ccloop that knows the field (Orca dependency note).
- Agents table: optional `idleTimeoutMs`, excluded from `configHash`. Orca keeps installations as `z.unknown()`
  (`Orca/src/control/agentInstallationProtocol.ts:23`) and its version refresh keeps unknown fields (checked, §2.1).
- `capabilities`, `features`, collect schemas: unchanged.

## 4. Tests (each red first with its named mutation, in a `git clone --local` copy)

1. Table: absent ⇒ effective `min(600 000, timeoutMs)` (a table with `timeoutMs: 300 000` stays valid ⇒ 300 000);
   `null` ⇒ no watchdog; `0`, negative, non-integer, > `timeoutMs` ⇒ `agents-table-invalid`. Mutation: drop the
   `superRefine` ⇒ the `> timeoutMs` case parses (red).
2. `configHash` is equal for an installation with and without `idleTimeoutMs`. Mutation: stop excluding it (red).
3. Per kind, fake CLI that prints one line then sleeps past a short idle limit (test option; real default untouched):
   outcome `stalled`, `outcome.json.idle` present, process group gone. Mutation: never arm the idle timer ⇒ `timeout` (red).
4. Activity resets: fake prints a line every 0.3 × idle for 3 × idle ⇒ `completed`. Mutation: don't reset on stderr
   (codex/omp fake writes only to stderr) ⇒ red.
5. Open tool: tool start, sleep 2 × idle, tool end, finish ⇒ `completed`; tool start then silence ⇒ `stalled` after
   3 × idle (not at the wall clock). Mutations: ignore `openTools` ⇒ first case `stalled` (red); drop the 3× cap ⇒ second
   case reaches `timeout` (red).
6. Claude fd 4: runner with a fake claude streaming chunks writes throttled lines; a tool_use/tool_result pair moves
   `openTools` 1 → 0. Mutations: drop the throttle exception for `openTools` changes (red); the adapter ignores fd-4 lines
   (a fake claude streaming steadily is stopped as `stalled`, red).
7. **Claude execute idle-stopped after a tool ran** ⇒ the runner partial comes back, run status `failed`,
   `failureCause.cause === "stalled"` (not `exhausted`/`budget-exhausted`). Mutation: check `failureType === "timeout"`
   before the cause ⇒ `exhausted` (red). Codex execute stalled after work ⇒ no in-phase retry, `failed`, `stalled`.
   Plan stalled before work ⇒ retried once, then success.
8. Single calls (each kind): a fake that goes silent ⇒ throws `<kind>-stalled`, one call only. Mutation: route single
   calls through the retry loop ⇒ two calls (red).
9. Draft `timeoutMs` 7 200 000 in `agents detect` output; existing-table criteria unchanged. Mutation: keep
   `DRAFT_TIMEOUT_MS` at 1 800 000 (red).

## 5. Decisions (controller's calls, reversible)

1. An open tool suspends the idle clock, capped at 3 × `idleTimeoutMs`.
2. Activity = bytes from the agent CLI (codex/omp stdout+stderr; claude via the runner's fd-4 lines), not CPU time.
3. `null` disables; absent = `min(10 min, timeoutMs)`; excluded from `configHash` like the other run limits.
4. Only newly detected installations get the relaxed 2 h wall clock; existing tables are not touched (flagged for the human).
5. `stalled` reuses `timeout`'s stop and recovery path; a claude partial after an idle stop ends `failed` with cause
   `stalled`.
6. Single calls are watched; their stalls are not retried by ccloop.

## 6. Open (not blocking)

- Whether codex emits nothing for > 10 min during long `xhigh` reasoning: measure on a real run (paid ⇒ ask).

## Review round 1 (Orca session 9ec98639, 2026-10-21)

Independent review verdict: NOT READY. Applied: re-anchored to `71d650c`. **C2** a claude partial after an idle stop
carries `stalled`, status `failed`, mapped before `budget-exhausted`; test 7 rewritten. **I8** `idleTimeoutMs` excluded
from `agentConfigHash` + test 2. **I9** open-tool suspension capped at 3 × `idleTimeoutMs`; the 2 h wall clock applies
only to newly detected installations, flagged for the human (§2.1). **I10** single calls watched, `stalled` mapped, not
retried (§2.4, test 8). Minors: `superRefine` for the cross-field rule; effective default `min(600 000, timeoutMs)`;
false-stall retry cost noted; Orca version auto-refresh check done (keeps unknown fields).

## Review round 2 (Orca session 9ec98639, 2026-10-21)

Independent review verdict: READY WITH FIXES. Applied: **I-D** version-skew note (§3; also in the ccloop handoff's
Orca dependency list when this lands). **M-7** `stalled` ⇒ `failed` rationale restated (cause mapping, not escalation).
**M-8** stopReason wording of a claude partial after an idle stop. **M-9** fd-4 mutation (test 6). **M-10** test 9
mutation named. Silent tool > 3 × idle ⇒ `stalled` ⇒ `failed` stated in §2.2.
