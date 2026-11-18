# omp launch isolation: no auto-retry in phases, a named provider error, a bounded MCP wait (Orca #369 (a), #375)

Written 2026-11-18 by the implementer subagent of an Orca session (controller-dispatched; branch
`fix/omp-mcp-retry-369-375` from ccloop main `72b8935`). Sources: Orca triage
`.superpowers/sdd/2026-11-18-tester-pm/g2-runs-settle-storage.md` §#369 and `g3-groups-cli-ui.md` §#375; tester ledger
`orca_archived_files/issue-20261023.md` Issues 369 and 375.

Human constraints for this round (quoted): 「这次批准改写所有必要的判据」 (a blanket approval; this repository's ruling 88
still asks for per-test confirmation, so every rewritten criterion is marked and listed) and 「我们不应该删 omp 或其他
agent 的 profile 文件内容」 -- **nothing here edits any agent's profile or config file on disk; every change is per launch**
(an environment variable, a `--config` overlay file in the call's own evidence directory, argv).

## 1. Problem

**#369 (a).** A loop phase starts omp without the overlay the single call uses (`ompSingleCall.ts` `OMP_SINGLE_CALL_OVERLAY`),
so omp's own session auto-retry and model fallback stay on. The phase fold records an assistant `message_end` with
`stopReason:"error"` but nothing ends the call on it; the process is left to exit by itself. In the field
(`run-5c248541`, omp, a removed model) the provider answered `errorStatus:404` at 07:43:31 and the process was still alive
until a person abandoned the run four minutes later; the run ended `omp-exit-error` with cause `unknown`. Why omp did not
exit after the 404 is **not proven** (no reproduction; the evidence shows only that it did not).

**#375.** omp has no `--no-mcp`. In print mode it waits for MCP servers from the profile up to `OMP_MCP_TIMEOUT_MS`
(default 30 000 ms) before the first turn, so one unreachable server costs every omp phase 30 s, visible only in the
call's `stderr.log` (`Warning: MCP server "rea" not ready after 30000ms; ...`). Worse, omp loads project-level MCP
configs from the cwd by default (`mcp.enableProjectConfig: true`): a target repository's `.mcp.json` could start
processes inside a run -- against "omp runs isolated" (`--no-extensions`, `--no-skills`).

## 2. Verified against the installed omp (18.17.0)

`omp --version` ⇒ `omp/18.17.0` (`/Users/biran/.bun/bin/omp`). Source read from the installed package
`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent` (package.json version 18.17.0):

- `src/mcp/timeout.ts`: `OMP_MCP_TIMEOUT_MS` (env; non-negative number), default 30 000; `isMCPTimeoutEnabled(t) = t > 0`,
  so **0 disables the timeout** (waits forever). `src/modes/print-mode.ts` `evaluateReadiness` calls
  `waitForStartup(resolveMCPTimeoutMs())` and writes `Warning: MCP server "<name>" not ready after <t>ms; ...` /
  `Warning: MCP server "<name>" failed to connect: ...` to stderr. The same value also bounds each MCP client request.
- `src/mcp/settings.ts`: setting id `mcp.enableProjectConfig`, boolean, default `true`. `src/mcp/config.ts`
  `loadAllMCPConfigs` drops **every** server whose source level is `project` when it is false (all discovery providers,
  not only `.mcp.json`).
- `src/session/settings.ts`: `retry.enabled` (default true), `retry.modelFallback` -- the keys the single-call overlay
  already sets (originally measured on 18.10.1).
- `src/cli/flag-tables.ts` `--config` appends overlay files; `src/config/settings.ts` merges layers
  global → project → `--config` overlay → runtime overrides, and `#loadOverlayYaml` parses YAML (JSON is YAML) and refuses
  a missing or malformed file. So an overlay wins over both the profile and a target repository's project settings.
- No environment variable carries a settings overlay, so the phase overlay must be an argv `--config`.
- `stopReason:"error"` assistant messages carry `errorStatus` (pi-ai `types.ts`; every provider sets it from the HTTP
  status); the field sample in #369 has `errorStatus:404` in ccloop's `events.jsonl`, i.e. on omp's JSON stdout.

## 3. Fix A -- #369 (a)

1. **Per-launch overlay for phases.** Every loop phase writes `config-overlay.yml` in its own evidence directory and passes
   `--config <it>` right after `--cwd <worktree>` (before the extra-worktree and handoff `--add-dir=` arguments):
   `{"retry":{"enabled":false,"modelFallback":false},"mcp":{"enableProjectConfig":false}}` (`OMP_PHASE_OVERLAY`).
   Only the retry/fallback keys are taken from the single-call overlay: the loop guard, advisor and **compaction** stay as
   the profile has them, because a long execute phase relies on compaction and none of #369 is about them.
2. **Status classification (omp call fold).** The last errored assistant `message_end` with a numeric `errorStatus` is
   classified by status, as the codex table does by its typed status (spec 2026-10-21 §3): 429 `rate-limited`;
   5xx `provider-5xx`; 401/403 `auth`; 402 `quota`; 404 whose `errorMessage` names a model (`/model/i`)
   `model-unavailable`; **every other 4xx except 408 ⇒ the new terminal cause `provider-error`**; 408 and a message
   without a status stay `unknown` as before. The detail is `HTTP <status>: <errorMessage>` (≤ 512 bytes). Model text is
   never read: only the typed `errorStatus` of omp's own error message.
   `rate-limited` and `provider-5xx` are already retryable in ccloop's shared loop: with omp's own retry off, ccloop's
   bounded transient retry (spec 2026-10-21 §4, same safety rule) is what still absorbs those.
3. **End the phase on a non-retryable 4xx.** While a phase runs, an assistant error whose status is 4xx other than 408 or
   429 stops the process at once (SIGTERM, then SIGKILL after `killGraceMs`) with the new outcome reason
   `provider-error` (outcome.json, error `omp-provider-error: <dir>`). The single call is unchanged (its retry is already
   off, so omp ends by itself). `provider-error` is not in `RETRYABLE_CAUSES`.

Orca side: Orca maps an unknown cause safely; it would want a label for `provider-error` (suggested: "the provider
refused the request (HTTP <status>)", next step: check the model/provider configuration or switch agent/model -- as for
`model-unavailable`). Orca's `failureCause.cause` is `z.string()`, so no parse change is needed for the cause itself.

## 4. Fix B -- #375

1. `OMP_MCP_TIMEOUT_MS=2000` in the environment of every omp phase and single call (overrides an inherited value).
   Why 2000: a phase can never use an MCP tool (the phase fold refuses any tool outside the phase's list), so the wait
   buys the run nothing; the only use of waiting is telling a slow-but-healthy server from a dead one for the warning
   below. 2 s is the figure the triage already gave people as the manual workaround and the tester asked for; it bounds
   the tax at 2 s per call instead of 30 s. It must stay positive: 0 means "no timeout".
2. `mcp.enableProjectConfig: false` in the phase overlay (above) and added to `OMP_SINGLE_CALL_OVERLAY`, so a target
   repository's MCP configs never start a process in a run. User-level (profile) servers still start: disabling them
   would need the profile's MCP file, which this round must not touch (residual, Orca `doctor` work).
3. **Warnings as an observation.** runOmpProcess keeps omp's stderr lines that start with `Warning: ` (at most 16, each
   ≤ 512 bytes) and writes them to the call's `outcome.json` as `warnings` -- only when there is one, so other
   outcome.json bytes are unchanged. `control collect`'s `transcripts` entry of an omp call carries the same list as
   optional `warnings` (absent when none).

**Orca must accept `transcripts[].warnings` in the same repin:** Orca's `transcriptEntrySchema` is `.strict()`, so a
ccloop that reports a warning to an Orca that does not know the key makes the whole collect answer refuse. No feature
flag is added (that would change `features` criteria pinned by this repository's tests); presence is the signal.

## 5. Tests (all new unless listed)

`tests/runtime/omp/ompLaunchIsolation.test.ts`: phase argv carries the overlay after `--cwd` with exactly the keys above;
the single-call overlay file equals the literal object; both spawn with `OMP_MCP_TIMEOUT_MS=2000` even when the parent
has another value; the status table (and `errorMessage` text alone never classifies); a phase whose provider answers 404
and then hangs ends within seconds as `provider-error` with the status in the detail, not at the watchdog; a 429 or 408
does not stop it; `Warning:` lines reach outcome.json and the collect transcript entry, absent when none, and the collect
schema accepts them. The fake omp gains an opt-in `<marker>.phase-script.json` (without it nothing changes).

Rewritten (golden argv now has `--config <evidence>/config-overlay.yml` after `--cwd`): the omp golden comparisons in
`tests/runtime/omp/ompToolRules.test.ts` and `tests/runtime/multiRepoArgv.test.ts`, through one fixture helper that
inserts exactly that pair into the 2a2ae53 capture (left byte-for-byte), as `executorPromptGolden.ts` does for the prompt.

## 6. Review fixes (2026-11-18)

Written 2026-11-18 by the fix-wave implementer subagent of the same Orca session (controller-dispatched), on branch
`fix/omp-mcp-retry-369-375` after the commit `fix(runtime): omp phases run without omp's own retry, end on a non-retryable 4xx
as provider-error, wait 2 s for MCP and never load project MCP (Orca #369 (a), #375)`. An independent review found the items
below; each was re-checked against the code and the installed omp 18.17.0 source before it was fixed. §3 and §4 above are kept
as written; where this section differs, **this section holds**.

**C1 (critical) -- the early stop killed omp's in-session recovery.** Verified: omp writes the errored assistant `message_end`
first; its `agent_end` handling then decides to recover (`agent-session.ts` ~5150-5283: compaction on a context overflow --
`turn-recovery.ts` `isRetryableError` says overflow "is handled by compaction instead" -- a retryable error, a malformed call),
so §3.3's stop "at once" could kill a phase that omp was about to recover. Now: a non-retryable 4xx assistant message
(`OmpCallFold.terminalProviderStatus`, unchanged) **arms a grace window** (`OMP_PROVIDER_ERROR_GRACE_MS` = 20 000 ms); a
**continuation row** disarms it (`auto_compaction_start`, `auto_retry_start`, `agent_start`, `turn_start`,
`tool_execution_start`, an assistant `message_start`); a **terminal `agent_end`** while the latest assistant message is still
such a refusal stops the phase at once; the window running out stops it. Either stop is outcome reason `provider-error`.
Choices, with the evidence:
- *Not "any later row".* The agent loop always writes the errored turn's own `turn_end` (and placeholder tool-result messages
  for any tool calls in it) after the error (`pi-agent-core` `agent-loop.ts` ~1594-1633), so "any row" would disarm on the
  error's own bookkeeping and a dead phase would again run to the watchdog.
- *A non-terminal `agent_end` is not a continuation signal.* omp holds `agent_end` while a prompt is in flight and replaces the
  held one (`agent-session.ts` `#emitSessionEvent`, `#pendingAgentEndEmit`), so print mode writes only the last; the measured
  18.10.1 continuation stream had one `agent_end` (plan `2026-10-26-omp-empty-stop-and-perf-l7.md`), and ccloop's phase fold
  refuses a non-terminal one anyway (`omp-phase-continuation`, unchanged).
- *20 s.* omp announces a recovery with a local event before any network call (`session-maintenance.ts` emits
  `auto_compaction_start` right after installing its abort controller; `turn-recovery.ts` emits `auto_retry_start` before the
  backoff), so the gap is omp's own bookkeeping; 20 s leaves room for a machine at load 60+ while a dead phase still ends in
  seconds rather than at the 10-minute watchdog. A terminal `agent_end` (the usual dead-end shape) does not wait at all.
- Injectable for criteria only: `OmpAdapter`'s 4th constructor argument → `runOmpPhase` option → `OmpProcessInput.providerErrorGraceMs`.
  No configuration key; the production path never passes it.
Not proven: a real omp compaction after a provider 400 (no paid run); the continuation shapes are read from source.

**I1 -- omp's in-session retry stays on, bounded.** §3.1's overlay retry keys become
`{"retry":{"maxRetries":3,"maxDelayMs":60000,"modelFallback":false}}` (keys and meaning from omp 18.17.0
`src/session/settings.ts`: `retry.maxRetries` default 10, `retry.maxDelayMs` default 300 000 -- "when the provider asks us to
wait longer than this ... the request fails fast instead of sleeping"). `retry.enabled` is no longer written: the profile decides
(default true). Only the model fallback is forced off (a phase runs on the run's selected model). A 429/5xx that outlives omp's
3 attempts still reaches ccloop typed (`rate-limited`/`provider-5xx`) and ccloop's bounded transient retry still applies.

**I3 -- an omp 404 is `model-unavailable` whatever its text.** §3.2's "404 whose `errorMessage` names a model" is dropped: the
#369 field text 「模型已下架，建议更换新模型」 names no "model". Other non-408/429 4xx stay `provider-error`; a 404 still stops
the phase (it is still a non-retryable 4xx).

**M1/M2 -- warnings.** §4.3's "lines that start with `Warning: `" narrows to omp's two MCP readiness shapes
(`print-mode.ts` `evaluateReadiness`), kept only up to the server name and state:
`Warning: MCP server "<name>" not ready after <t>ms` and `Warning: MCP server "<name>" failed to connect`. The
failed-to-connect tail is the server's own error and can carry a URL with a token; every other `Warning:` line (omp also prints
session-store notices and others) is **dropped**, not cut at a colon -- the safe choice, since nothing else needs it. ANSI
escapes (CSI and two-byte ESC sequences) are stripped before matching. Bounds unchanged (16 lines, 512 bytes each).

**M3 -- saved results from an older ccloop.** `captureOmpWithoutFinal` compares a saved call's argv with today's
(`--config <call>/config-overlay.yml` included), so a saved omp execute result recorded by a ccloop before this change is refused
`saved-result-config-mismatch`: it fails closed (no recovery, nothing accepted on a guess). Accepted; no migration.

**M4 -- timing.** The 404 criterion no longer bounds elapsed time from above; it asserts outcome reason `provider-error`, which
only ccloop's own stop writes (not the call limit, not the watchdog), plus a lower bound (the window was waited out).

**M5.** `OmpCallFold` clears `detail` together with status and cause when a later assistant message is not an error.

Tests (`tests/runtime/omp/ompLaunchIsolation.test.ts`, this branch's own file): the overlay criterion now expects the keys above;
the status table has the Chinese-text 404 and a bare 404 as `model-unavailable`; the 404-then-silence phase stops after an
injected 300 ms window with cause `model-unavailable`; 400 then a terminal `agent_end` stops at once under a 10-minute window;
400 (context overflow), its `turn_end`, then `auto_compaction_start` / `auto_retry_start` / `agent_start` and a successful answer
1.2 s later (window 200 ms) completes; the warnings criteria use the MCP shapes, a token-bearing tail, an ANSI-coloured line and
a non-MCP warning. The fake omp's phase script gains an opt-in `answerAfterMs`. No other existing test was rewritten; the two
rewrites listed in §5 are unchanged and still await the human's per-test confirmation.


## 7. Correction (2026-11-19, re-review I-1, Orca controller session)

§6 says the errored turn's placeholder tool results are not among the continuation rows and lists `tool_execution_start`
as one. The omp 18.17.0 source says otherwise: `pi-agent-core/src/agent-loop.ts` (createAbortedToolResult, ~4092-4121)
emits `tool_execution_start`/`tool_execution_end` and a toolResult message for each tool call of an errored message, before
its `turn_end`. `tool_execution_start` is therefore removed from the continuation rows; every real continuation begins with
`agent_start` (agent-loop.ts ~656, ~723-728). §6's claim that omp always announces a recovery with a local event before any
network call has two rare exceptions (a usage-limit 4xx awaits a usage report before `auto_retry_start`; an overflow during
a handoff summary awaits that summary before `auto_compaction_start`); both still end typed. Test:
"4xx with a tool call, its placeholder tool rows and turn_end, then silence: still stopped as provider-error".
