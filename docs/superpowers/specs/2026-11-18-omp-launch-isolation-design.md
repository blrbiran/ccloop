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
