# Failure causes and transient retries inside a phase

- **Author:** Orca session `9ec98639` (2026-10-21), background track D. Mirrors Orca spec
  `Orca/docs/superpowers/specs/2026-10-21-failure-causes-and-agent-fallback-design.md` §3–§4 (ccloop's half; Orca
  Rule 16 keeps the two separate). Code references are ccloop main `75343fd`.
- **Status:** design; not planned. Human direction (Orca ledger `.superpowers/sdd/2026-10-20-session-308b874c/progress.md`,
  "multica ideas: 同意按你的建议走"); the open choices below are the controller's calls (§8), reversible.
- **Composes with:** `2026-10-20-verifier-sees-checks-and-last-failure-design.md` (branch
  `spec/verifier-sees-checks-and-last-failure`, option (b): a `required-check-failed` on lineage attempt 1 is retried once
  as a new attempt). That is an **attempt-level** retry; this spec adds **call-level** retries inside one phase. They do
  not share a counter. `2026-10-21-activity-watchdog-design.md` produces the `stalled` cause consumed here.

## 1. Today

- A phase that fails throws from its adapter; `runPhaseWithTimeout` wraps it in `PhaseExecutionError`
  (`src/controller/runLoop.ts:111-131`, `:513-515`), and the run becomes `failed` with `stopReason` = the error text
  (`:2108`, `:2157-2161`). Orca sees only `status` and that free string (`src/control/collect.ts:77-89`).
- One transient case is retried: Codex HTTP 429 before any item, 30/60/120 s, within the phase limit
  (`src/runtime/codex/codexAdapter.ts:14`, `:56-70`; `src/runtime/codex/rateLimit.ts`; spec
  `2026-10-13-codex-rate-limit-backoff-design.md`). Claude and OMP retry nothing (claude's runner retries only a spawn
  ENOENT, `scripts/claude-phase-runner.mjs:479-495`).

## 2. Vocabulary (`FailureCauseV1`)

`auth` · `quota` · `rate-limited` · `provider-5xx` · `network` · `context-overflow` · `stalled` · `executable-missing` ·
`required-check-failed` · `verifier-rejected` · `budget-exhausted` · `unknown`.

Retryable inside a phase: `rate-limited`, `provider-5xx`, `network`, `stalled`. Never: `auth`, `quota`,
`executable-missing`, `context-overflow`, `unknown` (no evidence it would pass), and the three run-level causes.

## 3. Classification (code, per agent kind; `src/runtime/failureCause.ts`, pure)

`classifyCall(kind, evidence) → { cause, workObserved: boolean, detail: string | null }`. Only **typed fields** and the
**agent CLI's own error rows** are read — never model text, tool output or check output (a model that prints
"last status: 429" must not be classified). One class per call: the **last** error signal in the call wins. Anything not
in a table row ⇒ `unknown`. `detail` = the matched error text, head 512 bytes, code-point safe.

**codex** (rows of type `error` → `message`, `turn.failed` → `error.message`; same reader as `rateLimit.ts`). Wording
sources: the two real 429 samples (`orca_archived_files/recommendations-{1,2}-events.jsonl`) and codex-cli 0.163.0's
binary strings (static, `strings` on `@openai/codex-darwin-arm64/.../bin/codex`, read this session).

| pattern on the error message | cause | source |
|---|---|---|
| `/\blast status: 429\b/` | rate-limited | real sample |
| `/\blast status: (401\|403)\b/` | auth | static: same format string `exceeded retry limit, last status: ` |
| `/\blast status: 402\b/` | quota | static, same |
| `/\blast status: 5\d\d\b/` | provider-5xx | static, same |
| `/ve hit your usage limit/`, `/Quota exceeded\. Check your plan and billing details/` | quota | static |
| `/Selected model is at capacity/` | provider-5xx | static |
| `/stream disconnected before completion/`, `/^Connection failed: /`, `/Error while reading the server response/` | network | static |

`workObserved` = any `item.*` row, or any unparseable line (absence of work not proven — `rateLimit.ts` rule).
Context overflow has no confirmed exec wording (the binary has a `ContextWindowExceeded` variant; its `--json` rendering
is unproven) ⇒ `unknown` until a sample exists.

**claude.** The runner (`scripts/claude-phase-runner.mjs:596-614`) already parses every stream-json line. It additionally
keeps, per call, `{ assistantError, errorText, toolUses, assistantMessages }` and writes them to
`CCLOOP_CLAUDE_SIGNALS_PATH` (0600, next to the observed-usage file; not in the runner's child env, as the other ccloop
variables at `:426`), on every exit path including a non-zero claude exit (the case that matters here). `assistantError` is the SDK assistant message's typed `error` field — enum read from claude 2.1.304
statically: `authentication_failed, oauth_org_not_allowed, account_on_hold, verification_required, billing_error,
rate_limit, overloaded, invalid_request, model_not_found, server_error, unknown, max_output_tokens, cloud_credential_error`.

| `assistantError` (and text) | cause |
|---|---|
| authentication_failed, oauth_org_not_allowed, account_on_hold, verification_required, cloud_credential_error | auth |
| billing_error | quota |
| rate_limit **and** errorText matches `/usage limit\|limit reached/i` | quota (claude reuses `rate_limit` for plan limits — static strings "usage limit reached") |
| rate_limit otherwise | rate-limited |
| overloaded, server_error | provider-5xx |
| invalid_request **and** errorText matches `/Prompt is too long\|input is too long for requested model/` | context-overflow |
| anything else | unknown |

`workObserved` = `toolUses > 0`. A never-started call with spawn error `ENOENT` (`ClaudeNeverStartedError`,
`src/runtime/claude/claudeAgentAdapter.ts:79-84`) ⇒ `executable-missing`.

**omp.** No error sample exists. v1: spawn `ENOENT` ⇒ `executable-missing` (runOmpProcess records `error.code` in
`outcome.json`, today it records only `spawn-error`, `src/runtime/omp/runOmpPhase.ts:114`); a final assistant
`message_end` with `stopReason: "error"` records its `errorMessage` as `detail` and classifies `unknown`.
`workObserved` = any `tool_execution_start`. Codex likewise records `error.code` for `spawn-error`
(`runCodexPhase.ts:104`).

**Every kind:** an adapter outcome `stalled` (watchdog spec) ⇒ `stalled`.

## 4. Retries inside a phase (`src/runtime/transientRetry.ts`)

- One shared loop generalising `callWithBackoff` (`codexAdapter.ts:56-70`), used by all three adapters' phases (not by
  single calls — Orca owns single-call retry). Delays `[30_000, 60_000, 120_000]` ms, **≤3 retries per phase in total**
  across causes, constructor option for tests (as `rateLimitDelaysMs`).
- A call is retried only when **(a)** its cause is retryable, **(b)** the retry is safe: the phase is `plan` or `verify`
  (read-only), or `workObserved === false` (execute that touched nothing), **(c)** elapsed + delay < the phase limit
  `min(timeoutMs, timeRemainingMs)` and the run is not aborted. Each retry gets the remaining time. The wait is abortable.
- An execute call that observed work and then failed transiently is **not** retried in-phase; the run ends with that
  cause and Orca's escalation ladder re-dispatches (Orca kanban spec §6).
- Codex's existing 429 path becomes the `rate-limited` row of this loop: `rate-limit.json` stays byte-identical
  (`classification`, `call`, `nextDelayMs`) and `rateLimitedBeforeWork` keeps booking 0 (`src/runtime/types.ts:177-183`).
  Every classified call (all kinds) also gets `failure-cause.json` `{ cause, workObserved, call, nextDelayMs, detail }`.
- Usage: a failed try books what it booked before (observed or null; 0 only under the two existing rules).

## 5. Recording the cause on the run (wire)

- `PhaseExecutionError` gains `failureCause` taken from the thrown error's `failureCause` property (adapters attach the
  classification of the **last** call); absent ⇒ `unknown`.
- `RunState` gains optional `failureCause?: { cause: FailureCauseV1; phase: "plan"|"execute"|"verify"|null;
  retries: number; detail: string | null }`, written with the terminal transition:
  - phase exception (`runLoop.ts:2157-2161`) ⇒ the classified cause;
  - verifier rejection terminal ⇒ `required-check-failed` when `rejectCategory === "required-check-failed"`, else
    `verifier-rejected` (this includes the `exhausted` "repeated failure pattern" of the verifier spec, option (b));
  - budget exhaustion and a timed-out execute (`runLoop.ts:1739-1745`, `exhausted`) ⇒ `budget-exhausted`;
  - succeeded, cancelled, and human gates that are not failures (path policy, `:1714`, `:2144`) ⇒ absent.
- **collect:** protocol 4's terminal copies the whole state minus `savedResult` (`collect.ts:80`); it also strips
  `failureCause`, so both strict terminal schemas (ccloop `src/control/command.ts:170-179`, `:318-322`; Orca
  `src/control/ccloopPort.ts:34`, `:40`) are unchanged. The cause is exposed as an optional **top-level**
  `failureCause` of `CollectionV1`, present iff `terminal` is non-null and the state has one — the same placement as
  `decisions`/`debug` (`collect.ts:128-145`). ccloop's own `collectionSchema` (`command.ts:180-204`) gains it as optional.
- `stopReason`, `recentFailures`, fingerprints, `features` — unchanged. No `features` flag: Orca's features parse is strict
  (`ccloopPort.ts:201`) and would refuse a new key; Orca learns the field from the pin.

## 6. Orca impact (add to ccloop handoff "Orca 依赖本仓")

- Orca's strict collect parse (`ccloopPort.ts:39-40`) must accept optional top-level `failureCause` **in the same repin
  commit**; until then, a ccloop that emits it breaks every collect.
- The vocabulary strings are a contract: renaming one is a wire change.
- Codex 429 behaviour, `rate-limit.json` and its usage-0 rule are unchanged; `codex-rate-limited:` stopReason unchanged.
- New: claude/omp phases may now take up to ~3.5 min longer before failing (backoff), always inside the phase limit.

## 7. Tests (each red first with its named mutation, in a `git clone --local` copy)

1. Classifier sample sets, one file per kind: **must-match** each table row (codex rows from the real samples and from
   the static strings embedded in error rows; claude rows as stream lines with the typed field), **must-not-match**: the
   same strings inside an `agent_message` item / assistant text / tool result; a 429 wording in stderr only; an
   unknown `assistantError`; `rate_limit` with "usage limit reached" (must be quota, not rate-limited). Mutation: delete
   each row ⇒ its must-match goes `unknown`; widen the codex reader to all rows ⇒ the agent_message sample goes red.
2. `workObserved` per kind: codex `item.started` present / absent / unparseable line; claude `toolUses` 0 / 1; omp
   `tool_execution_start`. Mutation: return `false` always ⇒ the execute-after-work case retries and goes red.
3. Retry loop with fakes (`fake-codex.mjs`, `fake-claude-cli.mjs`, `fake-omp.mjs` gain a scripted error mode): transient
   once then success ⇒ two call dirs, success; transient every call ⇒ 4 calls then throw with cause; execute with work ⇒
   one call; non-retryable (`auth`) ⇒ one call; limit shorter than the next delay ⇒ one call; abort during wait ⇒
   aborted without waiting. Mutations: drop each guard (a)–(c) in turn.
4. Codex 429 criteria of `2026-10-13` stay green unchanged (`rate-limit.json` bytes, usage 0).
5. Through `runLoop`: phase failure ⇒ `run-state.json` `failureCause.cause` as classified; required-check-failed ⇒
   `required-check-failed`; verifier rejection ⇒ `verifier-rejected`; budget ⇒ `budget-exhausted`; success ⇒ absent.
6. `collect` protocol 3 and 4: terminal objects byte-identical to today's for the same state; top-level `failureCause`
   present iff terminal; ccloop's `validateResponse` accepts it. Mutation: leave it in the protocol-4 terminal ⇒ strict
   schema refusal (red).

## 8. Decisions (controller's calls, reversible)

1. Rows only from a real sample or the agent binary's own strings; everything else `unknown` (anti-goal: wrong class).
   OMP v1 classifies nothing but `executable-missing`/`stalled`.
2. In-phase retry only when the call could not have changed the worktree (read-only phase or no work observed).
3. `unknown` is not retried. A timed-out execute and budget exhaustion are `budget-exhausted` (no separate timeout cause).
4. Cause exposed at collect top level, not inside `terminal` (keeps both strict terminal schemas and the frozen
   protocol-3 projection untouched).
5. One retry budget (3) per phase across causes; not counted toward the verifier spec's attempt retry or Orca's ladder.
6. Claude `rate_limit` + plan-limit wording ⇒ `quota`.

## 9. Open (not blocking)

- Codex context overflow and OMP provider errors need samples (a free or paid probe; paid ⇒ ask the human).
- Retries for single calls (Orca-side today).
