# Consolidation step 1: one claude adapter — design

Status: draft for the human's review. Author: Orca controller session `be653b22`, 2026-10-01.
Base: ccloop main at the commit titled `docs(handoff): roll the Orca section: repinned at the rejectOn fix; adapter/CLI consolidation is next, step one first`.
Scope: this repository and one function in Orca (§6). Every count below was measured at that base; re-measure before quoting.

## 1. Rulings

The human, 2026-10-01 (Orca session `ceca1c47`), set the order of the adapter/CLI consolidation: ① delete
`SubprocessClaudeAdapter` and `--adapter claude`; ② let `resume`/`sweep` continue a run started by `run --agents` (#4);
③ retire Orca's legacy `orca run --adapter-config` path; ④ delete the old entry. Words: "先将这些问题解决，再删老入口",
"同意按你建议的顺序走", "选方案二". This spec is step ① only.

In this session (`be653b22`, 2026-10-01), each by the human's own choice:

- **R1** — the v1 validation toolchain's claude part is retired, not ported (§4).
- **R2** — `ClaudeAgentAdapter` reads the partial execute result the runner writes after SIGTERM (§5), rather than
  leaving that runner path without a caller.
- **R3** — on execute, the stop grace becomes `max(killGraceMs, partialOutcomeRecoveryWindowMs + 5_000)` (§5.3).
- **R4** — Orca's handoff grace follows that bound in the same step (§6).
- **R5** — the design as presented (five sections) is approved; "我同意修改判据" — the criteria named in §7 may be
  deleted or rewritten as listed there. The written list in §7 is what this approval covers.

## 2. Today (measured)

Two claude adapters drive the same runner, `scripts/claude-phase-runner.mjs`:

| | `SubprocessClaudeAdapter` | `ClaudeAgentAdapter` |
|---|---|---|
| Reached by | `run`/`resume`/`sweep --adapter claude --adapter-config <file>` | `run --agents`, `control` |
| Process handling | spawns the configured command; SIGTERM to that one process on abort; never SIGKILL; waits for `close` | runner leads its own process group, registered before the prompt is written; SIGTERM to the group, SIGKILL after `killGraceMs` |
| Execute aborted/timed out | runner exit 0 + JSON on stdout ⇒ returned (partial or complete); otherwise `null` | always `ClaudePhaseAborted` / `claude-timeout` (or `null` when aborted with no observed usage); stdout ignored |

The runner, on SIGTERM during execute, stops claude (waiting up to `partialOutcomeRecoveryWindowMs` for it to close),
reads `git status`/`git diff` in the worktree, and prints a `completionStatus: "partial"` result with exit 0 — or exits
1 when the worktree has no change. It does not read anything claude printed after the interrupt. On an **error**
(not a signal) during execute it prints the same kind of partial result with exit 0, and `ClaudeAgentAdapter` does
return that one today, because the call's outcome is `completed`.

So the SIGTERM partial path is reached only through `SubprocessClaudeAdapter`. Deleting it without R2 would leave that
runner code with no caller in this repository.

`runLoop` already handles a partial execute result: it writes the attempt artifacts, applies the path policy
(`blocked_waiting_human` on a gate hit), otherwise ends the run `exhausted` (`failureType: "timeout"`) or `failed`
(`"error"`) and cleans the worktree. On a phase timeout it awaits the aborted execute's result
(`awaitAbortedResult: true`); on a handoff abort it takes whatever result arrived. No `runLoop` change is needed.

Orca never passes `--adapter claude` (measured: no match in `src`, `tests`, `scripts`, `web/src`).

## 3. What is deleted

- `src/runtime/claude/subprocessClaudeAdapter.ts`; `SubprocessAdapterConfig` in `src/runtime/claude/types.ts` (no other
  user, measured).
- In `src/cli.ts`: `"claude"` from the `adapter` union of `run`, `resume` and `sweep`, from both validity checks, and
  the claude branch of `buildAdapter`. `--adapter claude` then fails as any unknown adapter does (`invalid adapter`).
- `adapterName` in `src/sweep/sweepRuns.ts` loses `"claude"`. Its two comments about approving `--adapter claude`
  are published text: each keeps its words and gets a named ERRATUM appended at the end of its comment block.
- `examples/v1/claude-adapter-config.json`.
- Published comments that this step makes false keep their words and get a named ERRATUM at the end of their block.
  Found by scanning `src`, `scripts`, `tests`, `validation` and `README.md` for `SubprocessClaudeAdapter`,
  `subprocessClaudeAdapter`, `subprocess adapter` and `fake-claude.mjs`, outside the files this step deletes; the plan
  re-runs the scan before editing:
  - `src/runtime/claude/claudeAgentAdapter.ts` (header: "SubprocessClaudeAdapter stays as it was")
  - `scripts/claude-phase-runner.mjs` (the comment naming "the older SubprocessClaudeAdapter criteria's stand-ins")
  - `tests/runtime/claude/claudeAgentAdapter.test.ts` (header)
  - `tests/runtime/claude/claudePhaseRunnerEnv.test.ts` (header: "the older SubprocessClaudeAdapter still …")
  - `tests/runtime/claude/claudePhaseRunnerStream.test.ts` (the two comments naming `subprocessClaudeAdapter.test.ts`
    and its fixtures; the criterion name that says "older SubprocessClaudeAdapter stand-ins" stays — those stand-ins
    move with the runner criteria)
  - `tests/fixtures/fake-claude-cli.mjs` (header: "fake-claude.mjs … stays untouched")
- README §3.2 (`resume`) and §3.4 (`sweep`): the examples use `--adapter scripted` with
  `examples/v1/scripted-adapter-config.json`, with one line saying that claude runs are started by `run --agents` and
  that continuing them needs step ② (#4). Any other README mention of `--adapter claude` is rewritten the same way.

Not touched in step ①: `scripted`, `codex`, the `--adapter`/`--adapter-config` flags themselves (step ④), the
historical specs and plans that mention `SubprocessClaudeAdapter`, and `.superpowers/sdd/**`.

**Accepted cost (until step ②):** a run started with `--adapter claude` before this step can no longer be resumed or
swept with claude. Its run directory and evidence are untouched.

## 4. Retiring the v1 validation toolchain's claude part (R1)

`validation/v1/scripts/run-scenario.ts` hard-codes `run … --adapter claude --adapter-config <path>`, and
`validation/v1/scripts/prepare-a04.ts` with `validation/v1/lib/a04.ts` exists to build and approve that command.
All three are deleted. `validation/v1/README.md`: the sections that operate those two scripts are replaced by one
paragraph saying they were retired in this step and that paid real-claude acceptance now goes through Orca's
acceptance script; the rest of the README is unchanged.

Kept: `lib/evidence.ts`, `lib/scenarios.ts`, `scripts/create-fixture.ts`, `scripts/finalize-review.ts`,
`scripts/render-contract.ts`, and their criteria. Exports of `lib/evidence.ts` that only `run-scenario.ts` used are
left in place (registered in §9, not cleaned up here). Retained evidence (`.validation-runs/`, the accepted
A-04-08/B-02/C-05/D-01/E-01 set) is not touched.

## 5. `ClaudeAgentAdapter` reads the post-SIGTERM partial (R2, R3)

### 5.1 Rule

In `execute` only: when the call's outcome is `aborted` or `timeout`, **and** the runner exited with code 0 and no
signal, **and** its stdout parses as a JSON object, that object is the phase's result — the same rule
`SubprocessClaudeAdapter` used, so a runner that had already finished claude and prints a complete result is returned
too. Its `usageEvidence`, if present, is written to the call's `usage.json` as on the completed path.

Everything else is unchanged: `plan`, `verify` and `singleCall` on abort/timeout; an execute whose runner exited
non-zero (clean worktree), was killed, or printed something that is not a JSON object; and every `completed` outcome.
In particular N2, N3, N4, N9b and "kills the runner's grandchild within killGraceMs of an abort" keep passing
unchanged, because their fixtures leave the worktree clean.

### 5.2 Usage

A post-SIGTERM partial carries no `usageEvidence`/`tokenUsage`. When the result has no `tokenUsage` and
`readObservedTokens` gives a value, the adapter sets `tokenUsage` to that value; when it gives `null`, `tokenUsage`
stays absent — never 0. A result that already carries `tokenUsage` is left as it is.

What `runLoop` books then depends on how the execute was stopped (measured in `runLoop.ts`):

- **Handoff abort, stop request** (the phase did not reach `runLoop`'s own timeout): today the thrown
  `ClaudePhaseAborted` becomes a `PhaseExecutionError` whose `tokenUsage` is booked; after this step the partial's
  `tokenUsage` is booked through `settlePhase`. Same number, different shape.
- **`runLoop`'s own phase timeout** (`awaitAbortedResult: true`): today a thrown error lands in
  `PhaseOutcome.abortedError`, which nothing reads, so the observation is **not booked**. After this step, when the
  runner returns a partial, its `tokenUsage` **is** booked. This is a change in what is booked, in the direction of
  booking usage that was spent; when there is no partial (clean worktree) nothing changes and the observation is still
  lost (registered in §9).

### 5.3 Stop grace

For `execute`, the delay from the group SIGTERM to the group SIGKILL becomes
`max(installation.killGraceMs, contract.executionPolicy.partialOutcomeRecoveryWindowMs + PARTIAL_FLUSH_MARGIN_MS)`,
`PARTIAL_FLUSH_MARGIN_MS = 5_000` — the window the runner may wait for claude, plus room for `git status`, `git diff`
and the write. `plan`, `verify` and `singleCall` keep `killGraceMs`. The constant is mirrored in Orca (§6); each side's
comment names the other.

A grace longer than `killGraceMs` is only reached when the runner has not exited: the adapter already finishes on the
runner's `close` (and SIGKILLs the group then), so a runner that writes its result early ends the stop early.

## 6. Orca: the handoff grace (R4)

`handoffGraceMsOf` (Orca `src/control/driverHandoff.ts`) is `killGraceMs + HANDOFF_EXTRA_GRACE_MS` today, on the
stated ground that "ccloop waits killGraceMs before it kills a phase". After §5.3 that ground is false for execute.
It becomes `max(killGraceMs, recoveryWindowMs + 5_000) + HANDOFF_EXTRA_GRACE_MS`, where `recoveryWindowMs` is the
`partialOutcomeRecoveryWindowMs` of the run's frozen contract (Orca freezes it at
`min(task's value, handoff.activeMs)`; Orca's loop plans default it to 60_000). The formula applies to every run,
codex included: codex never prints a partial, so for it this only delays an outcome-unknown — the direction the
existing ERRATUM on that function already calls safe.

When the frozen window cannot be read as a non-negative safe integer, the grace is the existing ceiling,
`120_000` ms — the same fallback an unusable `killGraceMs` gets today. (Orca writes the window into every frozen
contract itself, so this is a corrupt-state path.) How the driver reaches the frozen contract from a `DriverRun` is
settled in the plan, by reading the code, not here.

The comment above `handoffGraceMsOf` is published: it keeps its words, and a named ERRATUM is appended at the end of
its block. Order: ccloop commits → the human pushes ccloop → the agent repins with `node scripts/pin-ccloop.mjs <SHA>`
→ the human pushes Orca. The Orca change does not depend on the repin to be correct (a longer grace is safe with the
old ccloop), so it may land before or after the repin.

## 7. Criteria (R5 — the human approved this list)

### 7.1 Moved, body unchanged (new file `tests/runtime/claude/claudePhaseRunner.test.ts`)

From `tests/runtime/claude/subprocessClaudeAdapter.test.ts`, every criterion that drives the runner directly or tests
the prompt builders, with its helpers; the top-level `describe` is renamed from `SubprocessClaudeAdapter` to
`claude phase runner`, which changes their full names:

- `includes the current attempt plan in the executor prompt`
- `includes plan, execution, rejectOn, and evidenceRequired in the verifier prompt`
- `reports token usage for ${testCase.label}` (every case of that table)
- `reports usage evidence when ${testCase.label}` (every case of that table)
- `falls back from a non-finite snake alias to a finite camel alias`
- `ignores a non-finite alias when no finite fallback exists`
- `omits token usage when finite selected fields overflow in sum`
- `terminates the inner Claude process when ${phase} is interrupted` (plan, execute, verify)
- `includes brand-new untracked files in partial execute diff recovery`
- `includes both staged and unstaged edits in partial execute diff recovery`
- `waits for close before interrupting a close-pending successful execute`
- `returns repo-relative target paths for renamed and quoted files`

The `adapter` constant built from `SubprocessClaudeAdapter` and `tests/fixtures/fake-claude.mjs` go with the
adapter-level criteria below; `fake-claude.mjs` is deleted (no other user in `src`, `tests`, `scripts`,
`validation`, `examples`, measured).

### 7.2 Deleted

From `tests/runtime/claude/subprocessClaudeAdapter.test.ts` (`SubprocessClaudeAdapter > …`):

| Criterion | Why it is not ported |
|---|---|
| `passes phase context through the wrapper and parses structured JSON` | `ClaudeAgentAdapter > passes the selected model to the claude CLI and returns the structured answer with its usage` covers the same path |
| `waits for close before parsing wrapper stdout` | `ClaudeAgentAdapter` always spawns the real runner (`claudeRunnerPath()`), so a stand-in wrapper cannot be injected; its own drain-after-exit is unpinned — registered in §9 |
| `returns null when aborted execute yields no final result` | `ClaudeAgentAdapter > kills the runner's grandchild within killGraceMs of an abort` already asserts `null` for an aborted execute with a clean worktree |

From `tests/runtime/claude/stderrDecoding.test.ts`:
`stderr decoding across chunks (Orca backlog #12(a)) > SubprocessClaudeAdapter's error carries a character its command's stderr split across two chunks`
— `ClaudeAgentAdapter` does not put stderr in its error; the runner-side sibling criterion in the same file stays.

From `tests/validation/evidence.test.ts`, the whole `run-scenario CLI` block (ten criteria):

- `records env names only and tracks descendants rooted at the spawned pid`
- `works when invoked outside the repo root`
- `runs when invoked through a canonical-path alias`
- `creates a fresh nested evidence directory when its parent does not exist`
- `writes evidence files even when ccloop fails before creating the run directory`
- `fails on an existing evidence directory without overwriting it`
- `fails on an existing run directory without creating evidence or harvesting stale run data`
- `rejects a fixture path that does not match the rendered contract repoPath`
- `rejects a scenario that does not match contract objective.taskId before child launch`
- `records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked`

The whole of `tests/validation/prepareA04.test.ts` (44 criteria in `inspectMetadataBackedA04History`,
`verified checkout dependency materialization` and `A-04 approval package`), with the code it tests. Its full list of
names is the file at the base commit; the plan lists them again from a fresh read before deleting.

### 7.3 Rewritten against `ClaudeAgentAdapter`

- `SubprocessClaudeAdapter > preserves partial execute outcomes returned by the wrapper` → a criterion in
  `claudeAgentAdapter.test.ts`: a runner that fails during execute with a changed worktree yields the partial result
  (`completionStatus: "partial"`, `failureType: "error"`, the changed file listed).
- `SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption` → the main criterion of
  §5: an aborted execute whose worktree holds a ~400 kB change returns the partial (`failureType: "timeout"`,
  `diffPatch` longer than 350 000 characters), not `null` and not `ClaudePhaseAborted`.
- `runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals` → the
  same assertions with `ClaudeAgentAdapter`; the test's usage-aware fake `claude` is named by the installation's
  `command` instead of being put on `PATH` (the runner still accepts its bare `{structured_output, usage}` line);
  renamed to say "claude agent adapter" instead of "subprocess adapter".

Each rewritten criterion carries a comment naming this spec and ruling R5.

### 7.4 New

- An aborted execute that returns a partial carries `tokenUsage` equal to the observed usage; one with no
  observation has no `tokenUsage` key.
- An execute stopped by the adapter's own **timeout** with a changed worktree returns the partial.
- With `killGraceMs` smaller than `partialOutcomeRecoveryWindowMs` (e.g. 300 ms vs 3 000 ms) and a fake claude that
  ignores SIGTERM until the window ends, the partial still arrives (the runner was not SIGKILLed at `killGraceMs`).
- An aborted **plan** whose runner prints a JSON object still throws `ClaudePhaseAborted` (the rule is execute-only).

The criteria above need a fake claude that changes the worktree and then hangs, with and without ignoring SIGTERM.
`tests/fixtures/fake-claude-cli.mjs` has no such mode (its modes: `ok`, `script`, `hang`, `grandchild`,
`usage-then-hang`, `start-then-hang`, `flood`), so this step adds modes to it; existing modes are not changed.
- Orca: `handoffGraceMsOf` with a recovery window larger than `killGraceMs` is that window + 5 000 + 60 000; with a
  smaller one it is unchanged; with an unusable window it is 120 000.

### 7.5 Orca criteria rewritten (named by the human under R5)

- `tests/panel/assemblyHandoffGrace.test.ts > the handoff grace the driver waits (spec §3) > is the agent's killGraceMs plus the fixed extra, and the ceiling's grace when killGraceMs is unusable`
- `tests/control/agentFreeze.test.ts > plan files and grace (spec §6.2, §6.6) > judges a handoff's grace by the run's frozen killGraceMs plus the fixed extra`

Both keep every case they have today (with a recovery window that does not change the result) and add the window.

### 7.6 Known-reds list (`scripts/check-known-reds.mjs`)

The five `run-scenario CLI > …` names leave the list with their criteria (`records env names only …`,
`fails on an existing run directory …`, `runs when invoked through a canonical-path alias`,
`creates a fresh nested evidence directory …`, `records claudeChildExited as NOT_OBSERVABLE …`), taking the list from
14 names to 9. The two renamed criteria are renamed there:
`SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute` →
`claude phase runner > …`, and the `runLoop > persists phase usage evidence …` name → its new name. No name is added.

## 8. Mutations (each must be seen red before the step is done)

Each runs in a `git clone --local` copy only; restoration is proved by `git diff` / `git diff --cached` byte counts.

| # | Mutation | Expected red |
|---|---|---|
| M1 | read the post-abort stdout for every phase, not only execute | the new aborted-plan criterion |
| M2 | drop the `observedTokens` → `tokenUsage` fill | the new usage criterion |
| M3 | fill `tokenUsage` with 0 when there is no observation | the new no-observation half of the usage criterion |
| M4 | execute stop grace back to `killGraceMs` | the window-larger-than-grace criterion |
| M5 | accept the stdout only on `aborted`, not on `timeout` | the adapter-timeout criterion |
| M6 | accept the stdout when the runner exited non-zero | expected to stay green: the runner never prints a JSON object and then exits non-zero except when the write itself failed, and `ClaudeAgentAdapter` cannot be given a stand-in runner. If it stays green it is recorded as an equivalent mutant with that reason, not claimed as covered |
| M7 | Orca: drop the window from `handoffGraceMsOf` | the new Orca criterion |
| M8 | Orca: unusable window counts 0 instead of falling back | the new Orca criterion |

## 9. Registered, not done in this step

- The executor prompt still says "you may have up to Nms to flush one final execute-phase result"; the runner reads
  nothing claude prints after the interrupt — the partial is built from git. Not changed here.
- `ClaudeAgentAdapter`'s drain after the runner's `exit` (`drainTimer`, 1 000 ms) is pinned by no criterion (§7.2).
- Exports of `validation/v1/lib/evidence.ts` that only `run-scenario.ts` used become unused.
- `PhaseOutcome.abortedError` is set but never read: an execute that throws after `runLoop`'s own timeout loses its
  observed usage (§5.2). Applies to codex and to claude without a partial. Not changed here.
- `partialOutcomeRecoveryWindowMs` has no upper bound in the contract schema; a large window lengthens the execute
  stop on both sides by design (R3, R4).

## 10. Gate

In fresh `git clone --local` copies, built first; HOME and the four XDG roots redirected; `TMPDIR` a short real
directory (`mktemp -d /private/tmp/cl-XXXX`); the Orca agents table points at the fake codex in `integration` mode;
every output redirected to a file and read back whole.

- ccloop: typecheck and build RC 0; full suite with the JSON reporter; `node scripts/check-known-reds.mjs` RC 0;
  `node scripts/check-tmp-leak.mjs` RC 0.
- Orca: web build, typecheck, full suite, web check, `verify:panel`, `verify:ccloop-pin`, `check-tmp-leak` RC 0, the
  real `~/.orca` unchanged. A red in a known load flake (`driverLanding`, `driverRecovery`, `controlShutdown`,
  `driverProgress` R2, `handoffE2E`, `ccloopPort`) counts only if its file alone is not 3/3 green.

## 11. Addendum after publication (plan writing, 2026-10-01, Orca session `be653b22`)

The sections above were pushed by the human before this addendum; they keep their words. Read them with these
corrections, which the plan (`docs/superpowers/plans/2026-10-01-claude-adapter-consolidation-step1.md`) implements.

- **Approval.** The human, after the review round: "这一轮执行过程中如果有问题，先按你的建议执行（不要再找我）" and
  "使用 subagent driven 的方式实现". The controller takes this as approval of this spec, including §5.2's change in
  what `runLoop` books on its own timeout, and of executing the plan without a further review stop.
- **§3, `sweepRuns.ts`.** `adapterName` keeps `"claude"` in its type. Narrowing it fails typecheck on
  `tests/sweep/sweepRuns.test.ts`'s banner criterion, which passes `adapterName: "claude"` and expects `adapter=claude`;
  that criterion is not in §7. The two comments still get their ERRATUM.
- **§6, no start envelope.** A run whose handoff is judged before ccloop was started has no frozen contract to read;
  its recovery window counts 0 (nothing is executing, so there is nothing to wait for), not "unusable".
- **§6, `killGraceMs: 0`.** With the formula of §6 a run whose frozen `killGraceMs` is 0 now gets 65 000 ms, not
  60 000 ms (the margin applies with a window of 0). The rewritten criterion states it.
- **§6, wiring.** §7.4's Orca criteria test `handoffGraceMsOf` alone; the plan adds one criterion that reaches it
  through `settleIfPastGrace` with a real frozen window, and mutation M10 (the driver passes 0) must turn it red.
- **§8.** The plan adds M9 (execute passes no post-stop option at all) and M10 (above).

## 12. Correction after implementation (2026-10-01, Orca session `be653b22`)

- §7.2 says `tests/validation/prepareA04.test.ts` held "44 criteria". A fresh read at deletion time counted 46 `it(` sites,
  two of them `it.each`, i.e. 52 expanded criteria, in the same three `describe` blocks. The whole file was deleted as
  §7.2 says; only the count was wrong. Measured by the Task 3 implementer (ledger
  `.superpowers/sdd/2026-10-01-claude-adapter-consolidation-step1/progress.md`, Task 3 line).
- §8's M7/M8 (Orca) were carried as: M10 (driver passes 0 instead of the window) and "driver passes killGraceMs 0", each
  seen red in an Orca clone by the Task 4 implementer; M7/M8 as written are covered by the `handoffGraceMsOf` unit
  criteria the same task added.

## 13. Correction (final review, 2026-10-01)

Recorded by the final-review fix agent, Orca session `be653b22`, from the Orca final whole-branch review (I1) and the
controller's ruling on it.

- §6 calls `120_000` ms "the existing ceiling". With §6's own formula it is not: every Orca loop plan freezes a
  window of 60_000 (Orca `src/control/loopPlans.ts`), so a default run already gets
  `max(killGraceMs, 60_000 + 5_000) + 60_000 = 125_000` ms, and a `120_000` fallback is *shorter* than a normal
  grace — the outcome-unknown would come earlier, the direction §6 calls unsafe.
- Orca now counts an unusable recovery window (an invalid value, or a start envelope it cannot read) as 60_000 ms,
  Orca's own default window. The grace on that path is then `max(killGraceMs, 65_000) + 60_000`, which is at least
  125_000 ms, i.e. no shorter than any default run's grace. (`killGraceMs` itself, when unusable, still falls back
  as before.)
- This is still not a true ceiling: a plan may raise the window up to `handoff.activeMs`, and such a run's normal grace
  exceeds the fallback. Accepted, because the path is reachable only from corrupt state (Orca writes the window into
  every frozen contract itself).
