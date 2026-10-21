# Failure causes and transient retries inside a phase

- **Author:** Orca session `9ec98639` (2026-10-21), background track D. Mirrors Orca spec
  `Orca/docs/superpowers/specs/2026-10-21-failure-causes-and-agent-fallback-design.md` §3–§4 (ccloop's half; Orca
  Rule 16 keeps the two separate). **Code references are ccloop main `71d650c`.**
- **Status:** design; not planned; revised after independent review round 1 (last section). Human direction (Orca ledger
  `.superpowers/sdd/2026-10-20-session-308b874c/progress.md`, "multica ideas: 同意按你的建议走"); open choices are the
  controller's calls (§9), reversible.
- **Composes with** the verifier/last-failure round already on main (spec
  `2026-10-20-verifier-sees-checks-and-last-failure-design.md`, option (b): a `required-check-failed` on lineage attempt 1
  is retried once as a new attempt, `checkFailureRetryable`, `src/controller/runLoop.ts:205`, `:232`). That retry is
  **attempt-level**; this spec adds **call-level** retries inside one phase. They do not share a counter.
  `2026-10-21-activity-watchdog-design.md` produces the `stalled` cause consumed here.

## 1. Today

- A phase that fails throws from its adapter; `runPhaseWithTimeout` wraps it in `PhaseExecutionError`
  (`runLoop.ts:117-136`, `:547`), and the run becomes `failed` with `stopReason` = the error text (`:2151`, `:2200-2204`).
  Orca sees only `status` and that free string (`src/control/collect.ts:77-111`).
- One transient case is retried: Codex HTTP 429 before any item, 30/60/120 s, within `min(config.timeoutMs,
  timeRemainingMs)` (`src/runtime/codex/codexAdapter.ts:14`, `:56-70`; `src/runtime/codex/rateLimit.ts`; spec
  `2026-10-13-codex-rate-limit-backoff-design.md`). Claude and OMP retry nothing (claude's runner retries only a spawn
  ENOENT, `scripts/claude-phase-runner.mjs:479-495`). The agent CLIs also retry internally before they report an error
  (codex: "exceeded retry limit"; claude: its own API retries) — every delay here comes on top of those.

## 2. Vocabulary (`FailureCauseV1`)

`auth` · `quota` · `rate-limited` · `provider-5xx` · `network` · `context-overflow` · `stalled` · `executable-missing` ·
`required-check-failed` · `verifier-rejected` · `budget-exhausted` · `unknown`.

Retryable inside a phase: `rate-limited`, `provider-5xx`, `network`, `stalled`. Never: `auth`, `quota`,
`executable-missing`, `context-overflow`, `unknown` (no evidence it would pass), and the run-level causes.

## 3. Classification (code, per agent kind; `src/runtime/failureCause.ts`, pure)

`classifyCall(kind, evidence) → { cause, workObserved: boolean, detail: string | null }`. Only **typed fields** and the
**agent CLI's own error rows** are read — never model text, tool output or check output (a model that prints
"last status: 429" must not be classified). One class per call: the **last** error signal in the call wins. Anything not
in a table row ⇒ `unknown`. `detail` = the matched error text, head 512 bytes, code-point safe.

**codex** (rows of type `error` → `message`, `turn.failed` → `error.message`; the reader of `rateLimit.ts`). A call with a
`turn.completed` row is **not classified** (null — the turn reported usage; today's path owns it, as `rateLimit.ts`).
Wording sources: the two real 429 samples (`orca_archived_files/recommendations-{1,2}-events.jsonl`) and codex-cli
0.163.0's binary strings (static, `strings` on `@openai/codex-darwin-arm64/.../bin/codex`, read this session).

| pattern on the error message | cause | source |
|---|---|---|
| `/\blast status: 429\b/` | rate-limited | real sample — this row alone drives codex `rate-limited` |
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
`CCLOOP_CLAUDE_SIGNALS_PATH` (0600, next to the observed-usage file; stripped from claude's env like the other ccloop
variables at `:426`) on every exit path, including a non-zero claude exit. `assistantError` is the SDK assistant
message's typed `error` field — enum read from claude 2.1.304 statically: `authentication_failed, oauth_org_not_allowed,
account_on_hold, verification_required, billing_error, rate_limit, overloaded, invalid_request, model_not_found,
server_error, unknown, max_output_tokens, cloud_credential_error`. **`errorText` is only the text of the assistant
message that carries the typed `error`** — never other assistant text, tool results or stderr.

| `assistantError` (and errorText) | cause |
|---|---|
| authentication_failed, oauth_org_not_allowed, account_on_hold, verification_required, cloud_credential_error | auth |
| billing_error | quota |
| rate_limit **and** errorText contains one of the observed phrases `usage limit reached`, `usage credit limit reached`, `spend limit reached` (static strings, 7/2/4 occurrences in the binary) | quota |
| rate_limit otherwise | rate-limited (this typed value alone drives claude `rate-limited`) |
| overloaded, server_error | provider-5xx |
| invalid_request **and** errorText contains `Prompt is too long` or `input is too long for requested model` | context-overflow |
| anything else | unknown |

`workObserved` = `toolUses > 0`. The runner writes the signals file **incrementally** (rewritten atomically whenever a
field changes), so a runner killed mid-call leaves the last state. A **missing or unparseable** signals file ⇒
`workObserved = true` (not retried) and cause `unknown`, unless the adapter outcome itself gives `stalled` or `timeout`
(those map as below).

**omp.** No error sample exists. v1: `executable-missing` (below); a final assistant `message_end` with
`stopReason: "error"` records its `errorMessage` as `detail` and classifies `unknown`; `omp-read-only-phase-mutated`
(`src/runtime/omp/ompAdapter.ts:27`) classifies `unknown` (never retried). `workObserved` = any
`tool_execution_start`.

**Every kind:**
- `executable-missing`: claude `ClaudeNeverStartedError` whose spawn error string starts with `ENOENT` (the runner's
  `describeSpawnError` prefix, `claude-phase-runner.mjs:451-454`); codex/omp a `spawn-error` whose recorded errno is
  `ENOENT` (they record `error.code` in `outcome.json` from now on; today only `spawn-error`,
  `src/runtime/codex/runCodexPhase.ts:104`, `src/runtime/omp/runOmpPhase.ts:114`).
- an adapter outcome `stalled` (watchdog spec) ⇒ `stalled`; an adapter outcome `timeout` ⇒ `budget-exhausted` (§6).

## 4. Retries inside a phase (`src/runtime/transientRetry.ts`)

- One shared loop generalising `callWithBackoff` (`codexAdapter.ts:56-70`), used by all three adapters' **phases** (single
  calls are not retried here — their callers own retries; watchdog spec §2.4). Delays `[30_000, 60_000, 120_000]` ms,
  **≤3 retries per phase in total**, one budget shared by every cause (a phase that retried twice for `network` has one
  retry left for `stalled`), constructor option for tests (as `rateLimitDelaysMs`).
- **Retry-safety, per kind** — a call is retried only when its cause is retryable **and**:
  - **codex, omp:** the phase is `plan` or `verify` (read-only is enforced: codex `--sandbox read-only`,
    `runCodexPhase.ts:39`; omp tools `read,grep,glob`, `runOmpPhase.ts:49`, plus the mutation check,
    `src/runtime/omp/ompAdapter.ts:27`), or `workObserved === false`;
  - **claude:** `workObserved === false` in **every** phase (claude phases are not sandboxed read-only);
  - **codex `rate-limited`:** exactly today's predicate `classifyRateLimit(events) === "before-work"` — so the codex 429
    path is unchanged (§4 last bullet holds literally).
- **Time:** the phase limit is `L = min(installation.timeoutMs, contract.executionPolicy.perAttemptTimeoutMs,
  timeRemainingMs)` taken once at phase start. A retry is scheduled only if `elapsed + delay < L` and the run is not
  aborted; **each try's own timer is `L − elapsed`** at its start (today a codex retry gets a fresh `config.timeoutMs`
  capped only by remaining run time, `codexAdapter.ts:59-61`; adding `perAttemptTimeoutMs` only shortens it). The wait is
  abortable.
- A claude runner-built partial (§5) is a result, not a failed try: it is **never** retried in-phase.
- An execute call that observed work and then failed transiently is **not** retried in-phase; the run ends with that
  cause and Orca's escalation ladder re-dispatches (Orca kanban spec §6).
- Evidence: codex's `rate-limit.json` stays byte-identical (`classification`, `call`, `nextDelayMs`); every classified
  call (all kinds) also gets `failure-cause.json` `{ cause, workObserved, call, nextDelayMs, detail }`.
- **Usage (C1, round 2 I-A):** the phase books the **sum over all its tries**. A try that returns a result contributes its
  `tokenUsage`; a failed try contributes its observation (`observedTokensOf`, `src/runtime/types.ts:187-193`): `0` under
  the two existing rules (never-started, codex 429 before work), observed tokens, or **null**.
  - The final error of a failed phase carries `observedTokens = Σ` of the non-null observations.
  - The 0-by-rule flags (`rateLimitedBeforeWork`, `neverStarted`) go on the final error **only when every try was
    0-by-rule**; otherwise the final error carries the sum and no flag (a phase that spent 7 tokens and then hit a 429
    before work books 7, not 0).
  - If any try is null **and** the observed sum is 0 ⇒ `observedTokens: null` (today's "never 0" rule). If any try is
    null and the sum is > 0 ⇒ the sum is booked and recorded as a **lower bound**.
  - Where the lower bound is recorded: each unobserved try's `failure-cause.json` has `usageObserved: false`; the phase's
    `usage.json` (successful phase) or the last call's `failure-cause.json` (failed phase) has
    `retriedTriesUnobserved: <n>`.

## 5. Recording the cause on the run (wire)

- Adapters attach `failureCause` (the last try's classification) to the error they throw, and to a **claude runner-built
  partial** (`failureType` `error`/`timeout`, `partialOrigin: "runner"`, `scripts/claude-phase-runner.mjs:255-267`, built on
  interrupt at `:361` and on a failed claude exit at `:737`) that the adapter returns. `PhaseExecutionError` copies it; absent ⇒ `unknown`.
- `RunState` (persisted as `run/loop-state.json`, `src/persistence/fileStore.ts:84`) gains optional
  `failureCause?: { cause: FailureCauseV1; phase: "plan"|"execute"|"verify"|null; retries: number; detail: string|null }`,
  written with the terminal transition by this **precedence** (first row that applies):

| # | the attempt ended … | `failureCause.cause` | status (unchanged) |
|---|---|---|---|
| 1 | on a verifier decision with `approved: false` whose stop is `failed` or `exhausted` (incl. "repeated failure pattern"), or `blocked_waiting_human` caused by that rejection; **or** the next loop iteration's budget/attempt check (`runLoop.ts:1486-1487`) ends the run right after a persisted rejection (last `recentFailures` entry, status `planning`, no new attempt started — read from the persisted state, so it holds across crash resume) | `required-check-failed` if `rejectCategory === "required-check-failed"`, else `verifier-rejected` | as today |
| 2 | on a runner-built partial carrying a cause (`runLoop.ts:1768-1786`) | that cause (`stalled` per watchdog spec §2.3 — and then status `failed`) | `failed`/`exhausted` as today except `stalled` ⇒ `failed` |
| 3 | on a phase exception (`runLoop.ts:2151-2204`) | the classified cause, else `unknown` | `failed` |
| 4 | on a phase timeout or budget check with no rejection (`:1487`, `:1582-1590`, `:1615`, `:1654-1680`, `:1822`, `:1900-1912`) | `budget-exhausted` | `exhausted` |
| 5 | parked for a token allowance (`waitingCause: "token-allowance"`, `:1404`) | absent | — |
| 6 | succeeded, cancelled, a human gate that is not a failure (path policy, `:1755`, `:2187`) | absent | — |

  A cleanup failure after a rejection (the controller-failure path, `:2151-2204`, reached from cleanup) is row 3 ⇒
  `unknown`, not row 1. Invariant: **no `failed` or `exhausted` run without a cause** — a terminal write that reaches neither row 1–4 records
  `unknown`.
- **collect:** protocol 4's terminal copies the whole state minus `savedResult` (`collect.ts:80`); it also strips
  `failureCause`, so both strict terminal schemas (ccloop `src/control/command.ts:170-179`, `:318-322`; Orca
  `src/control/ccloopPort.ts:34`, `:40`) and the frozen protocol-3 projection are unchanged. The cause is exposed as an
  optional **top-level** `failureCause` of `CollectionV1`, present iff `terminal` is non-null and the state has one — the
  placement of `decisions`/`debug` (`collect.ts:128-145`). ccloop's own `collectionSchema` (`command.ts:180-204`) gains it.
- **handoff:** the packet's `runState` is the core run state (`src/control/handoff.ts:311-314`), so it carries
  `failureCause` too; Orca parses `runState` as `z.unknown()` (`Orca/src/control/handoff.ts:11`) — safe.
- `stopReason`, `recentFailures`, fingerprints, `features` — unchanged. No `features` flag: Orca's features parse is strict
  (`ccloopPort.ts:201`) and would refuse a new key; Orca learns the field from the pin.

## 6. Orca impact (add to ccloop handoff "Orca 依赖本仓")

- Orca's strict collect parse (`ccloopPort.ts:39-40`) must accept optional top-level `failureCause` **in the same repin
  commit**; until then, a ccloop that emits it breaks every collect.
- **How Orca parses `cause`:** as `z.string()` with known values mapped and anything else shown as `unknown` — not a closed
  `z.enum`. Consequence: **adding** a value later is not a wire break; **renaming or removing** one is (Orca's
  next-step text keys on the names). If Orca chose a closed enum instead, every new value would be a breaking change.
- Codex 429 behaviour, `rate-limit.json` and its usage-0 rule unchanged; `codex-rate-limited:` stopReason unchanged.
- New: claude/omp phases may take up to ~3.5 min longer before failing (backoff), always inside `L`. Phase usage now sums
  the tries (may rise versus today for retried phases; never falls).

## 7. Accepted loss: saved-result recovery after a retried phase

Saved-result recovery requires exactly one codex `plan` and one `execute` call directory per attempt
(`src/control/savedResultRecovery.ts:245-247`, `saved-result-execute-call-ambiguous`). A phase retried by this loop
leaves several, so such an attempt cannot be recovered from a saved result. **Accepted for this round** (it already holds
for today's codex 429 retries); the check is not relaxed.

## 8. Tests (each red first with its named mutation, in a `git clone --local` copy)

Fakes keep their argument conventions (`fake-codex.mjs <mode> <marker>`, `fake-omp.mjs <marker>`, `fake-claude-cli.mjs`):
error behaviour comes from **new mode names** / a marker sidecar, never new argv positions (Orca uses these fakes).

1. Classifier sample sets, one file per kind: **must-match** each table row (codex rows from the real samples and the
   static strings inside error rows; claude rows as stream lines with the typed field); **must-not-match**: the same
   strings inside an `agent_message` item / assistant text without the typed error / a tool result; a 429 wording in
   stderr only; codex error rows plus `turn.completed`; an unknown `assistantError`; `rate_limit` whose limit phrase
   appears only in another assistant message. `rate_limit` + each of the three phrases ⇒ `quota`. Mutations: delete each
   row ⇒ its sample goes `unknown`; widen the codex reader to all rows ⇒ the agent_message sample goes red; take
   errorText from all assistant text ⇒ the "other message" sample goes red.
2. `workObserved` per kind and retry-safety: codex `item.started` present / absent / unparseable; claude plan with a tool
   use ⇒ **not retried**; omp `tool_execution_start`. Mutations: return `false` always; treat claude plan as read-only.
3. Retry loop with fakes: transient once then success ⇒ two call dirs, success; transient every call ⇒ 4 calls then throw
   with cause; execute with work ⇒ one call; `auth` ⇒ one call; `L` shorter than the next delay ⇒ one call; abort during
   wait ⇒ aborted without waiting; **`perAttemptTimeoutMs` < `installation.timeoutMs`**: second try's timer is
   `perAttemptTimeoutMs − elapsed` (fake records the deadline it was given). Mutations: drop each guard; use
   `config.timeoutMs` for the try timer.
4. **Usage sum (C1, I-A):** fake spends 7 tokens and fails transiently (read-only phase), then succeeds with 5 ⇒ phase
   books 12; a failed try with no observation then success 5 ⇒ 5 and `retriedTriesUnobserved: 1`; all tries null and the
   phase fails ⇒ `observedTokens: null`; codex spends 7, then 429 before work ×3 ⇒ final error `observedTokens: 7`, no
   `rateLimitedBeforeWork`. Mutations: "book only the last" ⇒ 5 (red); "treat null as 0" ⇒ all-null case 0 (red);
   "keep the 429 flag on the final error" ⇒ 0 instead of 7 (red).
   **Claude signals (I-C):** delete the signals file before the adapter reads it ⇒ `workObserved` true, one call, cause
   `unknown`; a stalled outcome with no file ⇒ `stalled`. Mutation "default workObserved to false" ⇒ retried (red).
   **omp read-only mutation** ⇒ `unknown`, one call.
5. Codex 429 criteria of `2026-10-13` stay green unchanged (`rate-limit.json` bytes, usage 0). This is a regression
   guard only — it cannot go red for any new branch here, so it is not counted as any branch's red proof.
6. Through `runLoop`, one test per precedence row 1–6 (row 1 for each of `failed`, `exhausted`, `blocked_waiting_human`;
   row 2 a claude runner partial after an API error ⇒ the classified cause, not retried; row 4 adapter `timeout` ⇒
   `budget-exhausted`). The rejected-then-budget case goes **through `runLoop.ts:1487`** explicitly (rejection, attempts
   left 0 ⇒ next iteration exhausts) ⇒ row 1 with that `rejectCategory`; repeated with a crash resume between the
   rejection and the check. Cleanup failure after a rejection ⇒ `unknown`. Mutation: swap rows 1 and 4 ⇒ red.
7. `collect` protocol 3 and 4: terminal objects byte-identical to today's for the same state; top-level `failureCause`
   present iff terminal; ccloop's `validateResponse` accepts it. Mutation: leave it in the protocol-4 terminal ⇒ strict
   schema refusal (red).

## 9. Decisions (controller's calls, reversible)

1. Rows only from a real sample or the agent binary's own strings; everything else `unknown`. OMP v1 classifies only
   `executable-missing`/`stalled`.
2. Retry only when the call could not have changed the worktree: enforced read-only phases (codex/omp plan+verify) or no
   work observed; claude always needs `workObserved === false`.
3. `unknown` is not retried. Adapter/phase timeouts and budget exhaustion are `budget-exhausted`.
4. Cause exposed at collect top level, not inside `terminal`.
5. One retry budget (3) per phase across causes; not counted toward the attempt retry or Orca's ladder.
6. Claude `rate_limit` + an observed plan-limit phrase ⇒ `quota`.
7. Phase usage is the sum of tries; unobserved tries make it a recorded lower bound.

## 10. Open (not blocking)

- Codex context overflow and OMP provider errors need samples (a free or paid probe; paid ⇒ ask the human).
- Saved-result recovery of retried attempts (§7).

## Review round 1 (Orca session 9ec98639, 2026-10-21)

Independent review verdict: NOT READY. Applied: re-anchored to `71d650c`; dropped the "branch" wording (the verifier
round is merged). **C1** usage = sum of tries, lower bound recorded (§4, test 4). **I1** retry-safety per kind (§4).
**I2** runner-built claude partial carries the cause; invariant "no failed/exhausted run without a cause" (§5 row 2).
**I3** `L` includes `perAttemptTimeoutMs`; per-try timer `L − elapsed` (§4, test 3). **I4** codex rate-limited predicate
kept exactly `before-work` (§4). **I5** precedence table (§5). **I6** adapter `timeout` ⇒ `budget-exhausted` (§3, §5 row 4).
**I7** saved-result ambiguity listed as accepted loss (§7). Minors: claude phrases pinned to observed strings with
must-not-match samples; errorText only from the typed-error message; codex `turn.completed` not classified; the signal
driving `rate-limited` named per kind; `ENOENT` prefix; CLI-internal retries noted; `run/loop-state.json`; handoff packet
`runState` carries the cause (Orca `z.unknown`); Orca parses `cause` as a string (adding values non-breaking); fake
argument conventions kept.

## Review round 2 (Orca session 9ec98639, 2026-10-21)

Independent review verdict: READY WITH FIXES. Applied: **I-A** final-error usage = sum; 0-flags only when every try was
0-by-rule; null only when some try is null and the sum is 0, else lower bound (§4, test 4). **I-B** the `:1487`
budget/attempt terminal right after a persisted rejection is row 1, read from persisted state (§5, test 6). **I-C**
missing/unparseable claude signals ⇒ `workObserved = true`, `unknown` unless `stalled`/`timeout`; written incrementally
(§3, test 4). **M-1** shared retry budget wording; **M-2** row 1 limited to failed/exhausted or a rejection-caused gate,
cleanup failure after a rejection ⇒ `unknown`; **M-3** claude partial never retried in-phase; **M-4** where
`retriedTriesUnobserved` lives; **M-5** omp read-only mutation ⇒ `unknown` + test; **M-6** test 5 is a regression guard;
**M-11** collect citation widened to `:77-111`.
