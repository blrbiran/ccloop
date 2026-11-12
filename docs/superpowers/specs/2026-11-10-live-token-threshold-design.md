# Live token threshold: stop a claude or omp phase whose observed usage passes the remaining budget

- **Author:** ccloop implementer agent (Claude Opus 5.5), dispatched by an Orca session on 2026-11-10, branch
  `feat/live-token-threshold`. Code references are ccloop main `e47f763` plus the commit whose subject is
  `feat(control): stop a claude or omp phase whose live usage passes the remaining token budget (#225)`.
- **Source:** Orca tester issue #225: a run's token budget is checked only at phase boundaries, so one long phase can spend
  far past the remainder before anything looks at it.
- **Human ruling R4 (Orca session, 2026-11-10), verbatim:** "#224／#225 同意软上限". As relayed by the Orca controller:
  budgets are soft and no hard cap is promised, but where an adapter can stop mid-phase (claude, omp) it should. Codex
  cannot, and is not changed.

## 1. Today

The budget is checked only between phases: `settlePhase` → `applyPhaseUsage` books a phase's usage when it ends, and
`hasBudgetExceeded` is read at the loop top, after plan, after execute and in the stop decision
(`src/controller/runLoop.ts`). Inside a phase the only stops are the wall clock (`runPhaseWithTimeout`), the activity
watchdog and the handoff `phaseSignal`. A phase that starts with 1,000 tokens left can spend 100,000.

## 2. The threshold

A phase is stopped when its **observed total** passes

    threshold = ceil(remaining-before-phase × LIVE_TOKEN_THRESHOLD_FACTOR),   LIVE_TOKEN_THRESHOLD_FACTOR = 1.2

where `remaining-before-phase` is `budgetSnapshot.tokenBudgetRemaining` as the phase starts. Equivalently: the run's
usage so far plus the phase's observed total passes the run's usage so far plus that threshold. The factor is a named
constant in `src/budget/tokenPolicy.ts` (`liveTokenThreshold`), **not a contract field**.

**Factor without a floor.** The brief offered `remaining + a floor of a few thousand` as an alternative, so that a tiny
remainder still gets one request. A floor buys nothing here:

- omp reports usage per assistant `message_end`, after that request has finished, so the first request always completes
  before the threshold can be checked.
- claude reports a message's usage at `message_start`, and that opening snapshot already includes the whole prompt. Its
  input, typically tens of thousands of tokens with cache, is spent before the threshold is checked. A floor of a few
  thousand would not cover it either. Letting that request run on buys only its output, after which the next request
  is stopped anyway.

The 20 % margin keeps an overshoot of the remainder that is about to finish from being stopped. A completed phase is worth
more than a stopped one: a verify that approves still ends `succeeded` (`evaluateStopDecision` puts success first), and
a completed execute over budget is still captured for saved-result recovery.

## 3. Where the observation comes from

`AttemptContext.onObservedUsage(tokens)` is new. The adapter calls it with the call's running observed total, a lower
bound, each time the total grows.

| Adapter | Source | Channel |
|---|---|---|
| claude | the runner's `createUsageObserver` (message_start opening snapshots, closed by message_delta) | fd 4, a new line kind `{"observedTokens":n}` beside `{"openTools":n}`; unthrottled, one line per change |
| omp | `OmpLowerBoundFold`: the sum of every assistant `message_end`'s `usage.totalTokens` | in-process, in `runOmpProcess`'s line splitter |
| codex | none: `codex exec --json` reports usage only on `turn.completed` | not called; codex is unchanged |

Single calls do not pass the callback (out of scope).

## 4. The stop

`runPhaseWithTimeout` races a third promise beside the result and the timeout. When the reported total passes the
threshold, it aborts its own `AbortController` (the path a timeout uses) with reason `LIVE_TOKEN_STOP_REASON`
(`"ccloop-live-token-threshold"`), then **awaits** the phase. The agent's process is therefore gone before the worktree is
touched, and the adapter's own after-stop observation can be read. The outcome is `timedOut: true` with `budgetStop`. It is
charged the time the phase actually ran, not the floor a timeout gets for using up its window.

**What is booked:** the larger of ccloop's live observation and the adapter's own (the claude partial's `tokenUsage`, or
the error's `observedTokens`). Both are lower bounds. That total is above the threshold, and the threshold is above the
remainder, so booking it leaves `tokenBudgetRemaining` at 0. Each phase's existing timed-out branch then ends the run
`exhausted` with `stopReason` "runtime or token budget exhausted", the wording a budget check at a boundary uses:

- plan, verify: the phase settles with `{tokenUsage}` as usage only (`completedWithResult: false`).
- execute with no result (omp; claude when the agent wrote nothing): `executionRecovery.failureBoundary` is
  `token_exhausted`, and the worktree is retained and cleaned as for a timeout.
- execute with a claude runner-built partial (`failureType: "timeout"`, `partialOrigin: "runner"`): the existing partial
  branch ends it `exhausted` with cause `budget-exhausted` (phase `execute`). Its stop reason is the budget wording, not the
  partial's "claude phase runner interrupted by SIGTERM".
- a complete answer that raced the stop goes through the normal flow, which reaches `hasBudgetExceeded` and the existing
  exhausted path (with exhausted-completion capture where it applies).

`failureCause` is `budget-exhausted`. That is the default every exhausted terminal gets (`withFailureCause`), or the claude
partial's own classification.

**After a stop**, the attempt worktree holds whatever the agent wrote. There is no final answer, and there is no
exhausted-completion capsule (`captureExhaustedCompletion` requires a completed execute). This matches a phase stopped by
its timeout today.

**omp's floor.** An omp call that ends unfinished writes `usage-lower-bound.json`. Collect sums those files into
`usageLowerBound`, which Orca's soft-mode settlement books as the floor of calls *whose usage went unbooked*, disjoint
from the booked baseline. A budget-stopped omp call is booked, so on that abort reason the omp adapter throws its
observation as `observedTokens` and writes no `usage-lower-bound.json`. Every other unfinished omp call is unchanged.
This narrows `ompProtocol.ts`'s "the diagnostic lower bound never becomes a ccloop usage observation", recorded there as an
ERRATUM.

## 5. Where it does not apply

- **No token ceiling** (`tokenBudgetRemaining === null`): `liveTokenThreshold(null)` is null and nothing is ever stopped.
- **Codex**: `codex exec --json` reports usage only on `turn.completed`, at the end of the turn. There is nothing to stop
  on mid-phase, so the codex adapter never calls `onObservedUsage`. Codex stays boundary-checked as before.
- **A run that can park on its allowance**: `tokenPolicy.bindingCauses` includes `group` or `spend-cap`, outside
  saved-result recovery, which is the condition `parkAllowance` reads. Such a run parks `blocked_waiting_human`
  (`waitingCause: token-allowance`) after the phase that depleted the allowance, and a person can renew it and continue
  from the next phase with the paid phase's evidence. Stopping that phase mid-call would end the run `exhausted` instead.
  R4 did not rule on this case. **The exclusion is the implementer's reading and needs the human's confirmation.**
- **Single calls**: out of scope this round.

## 6. Limits (honest)

- **A soft limit, not a cap.** The stop lands after the observation that passed the threshold. Whatever streamed before
  the process died is spent and booked when observed: for omp at most the requests already in flight, for claude the rest
  of the open message.
- **Transient retries inside one phase** (claude, omp) restart the call's running total. The live check compares the
  largest single-call total seen, not their sum. The tokens of an earlier failed try are still booked as today when the
  phase settles.
- claude's opening snapshot is a lower bound, as `observed-usage.json` already says (`lowerBound: true`).

## 7. Interfaces

No contract, collect or schema change. `onObservedUsage` is an optional runtime callback, `{"observedTokens":n}` is a new
line on the runner→adapter fd 4 channel (the adapter ignores unknown lines), and `LIVE_TOKEN_STOP_REASON` is an abort
reason. Orca's strict collect/features parsers see nothing new. The values they already parse (`status: exhausted`, the
budget `stopReason`, `failureCause.cause: budget-exhausted`, `failureBoundary: token_exhausted`) were all produced before.

## 8. Criteria

`tests/controller/liveTokenThreshold.test.ts`, through the real adapters and the existing fakes (no provider is called):

1. **omp execute stopped**: fake-omp (`<marker>.usage-stream.json`) streams 40 × 500-token messages against a threshold of
   1,184. The fake records `terminated` and no `done`. The run ends `exhausted` with the budget reason and cause, verify
   never runs, and the booked execute total equals the `message_end` usage in the call's `events.jsonl`: above 1,184,
   below 20,000, with no `usage-lower-bound.json`.
2. **claude execute stopped** (via the runner): fake-claude mode `usage-stream`, 40 × 2,000 tokens. Same expectations; the
   booked total equals the runner's `observed-usage.json`.
3. **codex not stopped**: fake-codex `high-usage` spends 40,000 in a verify that starts with 20,000 left (threshold
   24,000). All three phases complete with a result and the run `succeeded`.
4. **no token ceiling**: an omp verify streaming 4 × 280 completes; `succeeded`.
5. **under the threshold**: an omp verify spends 1,134 against a remainder of exactly 1,000 (threshold 1,200). It
   completes and the run `succeeded` (positive observation: the fake records `done`, verify `completedWithResult`).
6. **allowance-parkable run**: a `spend-cap` run whose plan reports 50 against an allowance of 10 parks as before.

Criteria 1 and 2 were seen red before the code: `expected [ '0', '1', '2', '3', '4', '5', …(35) ] to include 'terminated'`.
Criteria 3 to 6 are green before and after by design (they pin what must not change). Each is seen red under its own
mutation (§9).

## 9. Mutations

Run on 2026-11-11 in a `git clone --local` copy of the feature commit, criteria file only. Each was restored with
`git checkout`, and `git diff` / `git diff --cached` were 0 bytes after every one. Logs were under the session scratchpad
(`/tmp/ccloop-lt/mut-*.log`, not kept).

| Mutation | Criterion that went red | Red line |
|---|---|---|
| M1 drop the threshold check | 1, 2 | `expected [ '0', '1', '2', '3', '4', '5', …(35) ] to include 'terminated'` |
| M2 factor = Infinity | 1, 2 | same |
| M3 apply it to codex (`runCodexPhase` reports `TurnUsageFold` live) | 3 | verify `completedWithResult` `true` → `false` |
| M4 factor = 1 | 5 (and 1: `expected 1000 to be greater than 1184`) | verify `completedWithResult` `true` → `false` |
| M5 no ceiling read as 0 | 4 | `expected [] to deeply equal [ '0', '1', '2', '3', 'done' ]` |
| M6 drop the allowance-park exclusion | 6 | plan `completedWithResult` `true` → `false` |
| M7 omp books no `observedTokens` on the stop (floor written) | 1 | `existsSync(…usage-lower-bound.json)`: `expected true to be false` |
| M8 claude partial keeps its own stop reason | 2 | `Expected: "runtime or token budget exhausted"` / `Received: "claude phase runner interrupted by SIGTERM"` |
| M9 the claude runner never writes `{"observedTokens":n}` | 2 | `expected [ '0', '1', '2', '3', '4', '5', …(35) ] to include 'terminated'` |
| M10 omp never reports its running sum | 1 | same |

## Addendum 2026-11-12: an opt-in ceiling Orca updates (Orca G part 2)

Appended by the ccloop implementation seat of Orca session `d1cbbd58`; the text above is unchanged. A protocol-4 envelope
that carries `liveCeiling` (spec `2026-11-12-live-ceiling-design.md`) has a null work token grant, so this design's 1.2
factor and its allowance-park exclusion never apply to it: the run is bounded instead by the live ceiling, checked against
the run's whole total mid-call (claude, omp) and at every phase boundary (all adapters). Envelopes without `liveCeiling`
keep everything above as it is.
