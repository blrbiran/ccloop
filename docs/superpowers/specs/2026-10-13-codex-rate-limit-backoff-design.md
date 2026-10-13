# Codex 429: recognise it, back off inside the phase, book a pre-work rejection as zero

Orca session `7f37d261`, 2026-10-13. Source: external tester feedback (Orca `orca_archived_files/issue-20261008.md`,
issues 45, 46, 48, 49, 50) and two real `events.jsonl` samples,
`/Users/biran/code/skills/orca/orca_archived_files/recommendations-{1,2}-events.jsonl`.

## 1. Problem

A Codex phase whose provider answers HTTP 429 fails the run outright. Codex CLI retries internally, gives up, and prints:

```
{"type":"thread.started","thread_id":"…"}
{"type":"turn.started"}
{"type":"error","message":"exceeded retry limit, last status: 429 Too Many Requests"}
{"type":"turn.failed","error":{"message":"exceeded retry limit, last status: 429 Too Many Requests"}}
```

Both samples are exactly these four lines: the rejection happens before any `item.*` event. Today:
`runCodexPhase` reports `exit-error` (non-zero exit; a zero exit with no final message reports `io-error`), the adapter
throws `codex-exit-error: <dir>` with `observedTokens: null`, `runLoop` fails the run (no second attempt is opened for a
phase exception), and the phase usage is unknown (`null`), which blocks Orca's group until an owner settles it.

## 2. Rulings

Human (2026-10-13, Orca session `6b7843ec`): recognise 429 and retry with bounded backoff inside the phase; do not drop
`--ephemeral`, do not resume a Codex session, no multi-provider, no forced wait between tasks. Human (same day): a call
rejected by 429 before any action (`turn.started`, zero `item.*`, then a 429 `turn.failed`) books usage **0**; anything
else (items seen, or not provable) keeps today's observed-or-null usage. The two predicates below were the Orca
controller's recommendation and are adopted here.

## 3. Design

### 3.1 Classification (`src/runtime/codex/rateLimit.ts`, pure)

`classifyRateLimit(events: string): "before-work" | "after-work" | null`, over the phase's stdout:

- A **429 line** is an `error` row whose `message`, or a `turn.failed` row whose `error.message`, matches
  `/\blast status: 429\b/`. No sample exists for 5xx or for other wordings, so nothing else is recognised.
- `null` when there is no 429 line, or when a `turn.completed` row exists (the turn reported usage; today's path owns it).
- `"before-work"` when, in addition, a `turn.started` row exists, no row's `type` starts with `item.`, and every
  non-empty line parses as a JSON object (an unparseable line means the absence of items is not proven).
- `"after-work"` otherwise.

Classification applies only to a phase outcome of `exit-error` or `io-error` (the two shapes a provider rejection takes);
`aborted`, `timeout`, `spawn-error`, `output-limit` and `codex-skills-*` keep their meaning.

### 3.2 Bounded backoff inside the phase (`CodexAdapter.phase`)

On `"before-work"` the adapter waits and calls the same phase again with the same prompt; the worktree was not touched
(no item ran). Delays are `[30_000, 60_000, 120_000]` ms (at most three retries, four calls), a constructor option so
tests use short delays. Before each wait:

- the wait is abortable: an abort ends it at once, and the next call returns `aborted` through today's path;
- no retry is scheduled when the wait would end past the phase's time limit (`min(config.timeoutMs,
  budgetSnapshot.timeRemainingMs)` measured from the phase start); each retry call gets the remaining time, not the
  original limit.

Every call keeps its own evidence directory (`call-*`, as today). A rejected call's directory also gets
`rate-limit.json`: `{ "classification": "before-work", "call": <1-based>, "nextDelayMs": <ms or null> }`.

### 3.3 Outcome and usage

- A retry that completes returns that call's result and usage, exactly as a first-call success does. The rejected calls
  add nothing (they booked 0).
- When retries are exhausted (or the time limit stops them), the phase throws `codex-rate-limited: <last evidence dir>`
  with `rateLimitedBeforeWork: true`. `observedTokensOf` (`src/runtime/types.ts`) returns `0` for that flag, so the phase
  books 0 and the run's usage stays known.
- `"after-work"` does not retry. The phase throws `codex-rate-limited: <dir>` with today's `observedTokens`
  (observed or null); only the reason text changes.

Run status is unchanged: the run still fails on a phase exception. What changes is that the failure is named, a
pre-work rejection is retried, and its usage is 0 instead of unknown.

## 4. Criteria (each seen red by deleting its own branch)

1. The real sample classifies `"before-work"`; the same lines plus one `item.started` classify `"after-work"`; plus a
   `turn.completed` classify `null`; a 500 wording classifies `null`; an unparseable extra line classifies `"after-work"`.
2. Fake codex replays the sample once, then succeeds: the phase returns the success, two `call-*` dirs exist, the first
   has `rate-limit.json` with `call: 1, nextDelayMs: <first delay>`.
3. Fake codex replays the sample on every call: four calls, then `codex-rate-limited:` with `observedTokensOf(error) === 0`.
4. A zero-exit replay (no final written) is classified the same as a non-zero one.
5. A 429 after an item: one call only, `codex-rate-limited:`, `observedTokensOf(error) === null`.
6. An abort during a wait ends the phase as `CodexPhaseAborted` without waiting out the delay.
7. A time limit shorter than the next delay stops retrying: `codex-rate-limited:` after one call.
8. Through `runLoop` with the real `CodexAdapter` (fake codex replaying the sample on every call, short delays): the run
   ends `failed`, its stop reason names `codex-rate-limited:`, and the plan phase settles with `tokenUsage: 0`, not absent.

## 5. Out of scope

5xx, other providers, Claude and OMP adapters, dropping `--ephemeral`, session resume, and run-level retry policy.
