# Live token ceiling: an opt-in bound Orca keeps current (Orca tester follow-up G, part 2)

Written 2026-11-12 by the ccloop implementation seat of Orca session `d1cbbd58`, branch `g/ccloop-budget-handoff`.
Orca spec: `docs/superpowers/specs/2026-11-12-tester-followup-g-design.md` §2 and §10 (Orca repository); Orca plan
`docs/superpowers/plans/2026-11-12-tester-followup-g-part-b-budget.md` tasks K1, K2.

## What and why

In an Orca group with a finite token limit, the group's limit becomes the one hard line; a task's token amount becomes an
expectation. Orca therefore starts such a run with a **null work token grant** and a **live ceiling**: a bound on the run's
whole work tokens derived from the group's remainder, which Orca raises while the run runs (another task settles, a person
tops up the group). ccloop stops the run when its total reaches the ceiling:

- **mid-call** for adapters that report usage while they stream (claude through its runner, omp), through the same abort
  the #225 live threshold uses (`LIVE_TOKEN_STOP_REASON`, so each adapter books its observed lower bound);
- **at the next phase boundary** (before each attempt, before execute, before verify) for every adapter -- the only stop
  for codex, which reports usage only as its turn completes, so codex may pass the ceiling by one turn.

The spec's open point -- "can ccloop update a running run's threshold without restarting the phase?" -- is answered yes:
the ceiling is re-evaluated on every usage observation (criterion "lets the phase finish").

## Interfaces

- Start envelope (protocol 4 only): optional `liveCeiling: { protocol: 1, revision: positive int, tokens: int >= 0,
  cause: "group" | "pause-line" | "task-cap" }`, refused unless `claim.grant.work.tokens === null` and `mode` is absent. An
  envelope without it parses and hashes as before. `features` is unchanged.
- Control method `live-ceiling`: request `{ input: <the accepted envelope>, ceiling: LiveCeiling }`, answer
  `{ revision, tokens }` (strict). It writes `<sourceDir>/control/live-ceiling.json` (0600, atomic, under
  `control/live-ceiling.lock`). Refusals (exit 2): `control-live-ceiling-unsupported` (the envelope has no `liveCeiling`),
  `control-live-ceiling-not-accepted`, `control-envelope-conflict`, `control-live-ceiling-stale` (revision not newer than
  the stored one), `control-live-ceiling-busy` (lock held over 2 s), `control-live-ceiling-invalid` (stored file unreadable).
- Worker: seeds the file from the envelope unless a newer revision is stored, watches it every 50 ms (highest revision
  wins; a failed read keeps the last good value and appends one `live_ceiling_read_failed` run event per streak), and gives
  runLoop `liveCeiling: { current(), baseTokens }`, where `baseTokens` is the last work usage event's cumulative tokens (0
  for a fresh run).
- A stop: status `exhausted`, `stopReason: "live token ceiling reached"`, `failureCause.cause: "budget-exhausted"`, and
  `RunState.liveCeilingStop: { revision, tokens, cause, observedTokens, phase, at: "mid-call" | "boundary" }` --
  `observedTokens` is the run's whole work total at the stop, `phase` the stopped phase (mid-call) or the phase not started
  (boundary). The candidate is `partial` as for any exhausted run; a mid-call execute stop keeps the agent's edits in the
  attempt commit (criterion "keeps the agent's file").
- Collect: the protocol-4 `terminal` never carries `liveCeilingStop`; the collection has a top-level `liveCeilingStop`
  present iff the terminal state has one. Orca's strict collect schema must accept it in the repin.

## Limits

- Observation is a lower bound (claude: the message whose start crossed plus its output until the kill; omp: requests in
  flight); codex overshoots by up to one turn. With N parallel runs the overshoot bound is per run.
- A saved-result recovery never takes a ceiling.

## Criteria

`tests/control/liveCeilingMethod.test.ts` (8), `tests/controller/liveCeiling.test.ts` (8),
`tests/control/liveCeilingCollect.test.ts` (4). No existing criterion was edited.

## Mutations (in a `git clone --local`, restore proof `git diff` / `git diff --cached` 0 / 0 bytes after each)

| Mutation | Criterion that went red |
|---|---|
| K1-M1 drop the revision check | refuses a revision that is not newer |
| K1-M2 drop the null-grant clause of the envelope refine | refuses an envelope that carries both a finite work grant and a live ceiling |
| K1-M3 write with plain `writeFile` (umask mode) | writes the ceiling with mode 0600 |
| K1-M4 drop the not-accepted check | refuses before the run is accepted |
| K1-M5 drop the envelope hash check | refuses ... for an envelope other than the accepted one |
| K1-M6 drop the unsupported check | refuses live-ceiling for a run started without one |
| K2-M1 never consult the ceiling mid-call | omp execute, claude execute, resumed run, keeps the agent's file |
| K2-M2 no boundary check | codex between turns, earlier invocations, before verify, both worker criteria |
| K2-M3 read the ceiling once at phase start | lets the phase finish |
| K2-M4 ignore `baseTokens` | resumed run, earlier invocations |
| K2-M5 leave `liveCeilingStop` in the v4 terminal | the v4 terminal stays strict (control-response-invalid) |
| K2-M6 seed the file without `liveCeiling` | no liveCeiling: nothing is written |
| K2-M7 the seed does not tolerate a newer stored revision | a newer ceiling Orca wrote before the worker started is kept |
| K2-M8 the watch takes an older revision | the watch criterion |
| K2-M9 the watch reports every failed read | the watch criterion |
| K2-M10 a mid-call plan stop keeps the old stop reason | resumed run |
