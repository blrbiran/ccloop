# The verifier sees ccloop's own required-check results; a retried attempt sees why the last one was rejected

Written by a spec-writer subagent of Orca session `308b874c` (Claude Code interactive session, not an orca run),
2026-10-20. Observation anchor: ccloop `main` at `86f6123` (subject `docs(handoff): codex phase isolation 1-6 and the
claude required-check allow rules; ...`). Every `file:line` below was read at that commit; re-measure before quoting
(Rule 14). This document is a design only: no code, no criterion edited.

## 1. Intent and the human's words

Two approvals, given by the human in Orca session `308b874c` on 2026-10-20, on proposals the controller made:

- **A.** 「verifier 不知道检查已经过了 => 同意，按你的建议」 — the verify prompt carries ccloop's own results for the
  required checks it just ran, and tells the verifier not to reject merely because it cannot re-run them. The verifier
  may still re-run them.
- **B.** 「把上一次失败喂给下一次 attempt => 同意」 — the plan and execute prompts of a retried attempt carry the last
  rejection: its category, the failing command, and a bounded excerpt of its evidence.

⚠️ 「按你的建议」 approves the design direction. Per the handoff (「「按你的建议办」不是改判据的授权。」) it is **not** an
authorization to edit any existing criterion; §7 lists the ones that would change, each needing its own nod (Rule 15).

## 2. Current behaviour (ccloop `86f6123`)

### 2.1 The verifier is not told the checks already passed

- `runVerification` (`src/controller/runLoop.ts:267-313`) first runs the contract's required checks through
  `runRequiredChecks` (`:191-237`, each as `sh -lc <command>` in the attempt worktree, `maxBuffer` 10 MiB, `:201-205`).
  On the first failure it returns `required-check-failed` with `tokenUsage: 0` and the verifier is never called
  (`:287-289`). A `command` verifier stops there with approval (`:291-305`).
- Only when every check passed does it call `adapter.verify(context)` (`:307-308`), with the same `context` the caller
  built (`:1819`). ccloop's check evidence is merged **after** the verifier answered (`:309-312`); the verifier never
  sees it. `RequiredChecksOutcome` (`:82-90`) keeps only evidence strings, no structured result.
- The verify prompt is one builder shared by all three kinds — `buildVerifierPrompt` (`src/runtime/claude/prompts.ts:81-112`),
  called by claude `claudeAgentAdapter.ts:355`, codex `codexAdapter.ts:147`, omp `ompAdapter.ts:65`; there are no
  codex/omp equivalents to change separately. It lists the checks as bare commands (`prompts.ts:97-98`,
  `"Required checks:"` + list) and ends with `"Prefer rejection backed by concrete evidence."` (`:108`).
- Consequence, measured (handoff, claude allow-rules entry, Orca session `3d229487`): the verifier re-runs the checks;
  when it cannot (claude's permission layer under `-p`; compound commands that an exact `Bash(<cmd>)` rule never
  matches; a codex/omp sandbox), it rejects with `required_check_not_run`, although ccloop's own run of the same command
  in the same worktree passed seconds earlier. The exact allow rules (subject `fix(claude): execute and verify allow
  exactly the contract's required checks`) narrowed this for claude; compound commands and the other kinds remain.

### 2.2 A retried attempt does not see why the previous one failed

- The planner prompt takes the contract only: `buildPlannerPrompt(contract)` (`prompts.ts:16-32`); every adapter calls
  it with `context.contract` (claude `claudeAgentAdapter.ts:332`, codex `codexAdapter.ts:136`, omp `ompAdapter.ts:45`).
- `buildExecutorPrompt(context, …)` (`prompts.ts:47-79`; claude `:338`, codex `:138`, omp `:49`) reads the contract
  and `context.plan`, nothing about earlier attempts.
- The run loop does know: on a retryable rejection it appends a `FailureFingerprint` to `state.recentFailures`
  (`runLoop.ts:1935-1946`; type `src/state/types.ts:14-18` = `rejectCategory`, `primaryTargetPaths`,
  `failingCommand`, **no evidence**), and the rejection's full `VerificationResult` is in memory and written to
  `attempts/<n>/verify.json` (`runLoop.ts:1889-1891` → `src/persistence/fileStore.ts:2007-2008`) before the retry
  decision. The plan and execute contexts of the next attempt are built at `runLoop.ts:1532` and `:1599`; `state`
  rides along in them, but no prompt reads it.
- An allowance continuation starts a new run with the previous run's `recentFailures` (`runLoop.ts:1160`, from
  `src/control/materialize.ts:253-279`), so "a retried attempt" is "`state.recentFailures` is non-empty", not
  "attempt ≥ 2" (that run's first attempt is `attempt === 1`, `runLoop.ts:1448`, `:1520`).
- `isRepeatedFailure` (`src/stop/stopController.ts:9-18`) stops the run when the same category recurs with the same
  paths or command. So a retry that repeats the failure costs a whole paid attempt and then ends the run.
- Fresh evidence (Orca paid codex run, 2026-10-20, Orca session `308b874c` scratchpad `acc-codex-decision/`, ccloop
  `86f6123`, `gpt-6-luna`): attempt 1 failed `required-check-failed` on `node check-median.js`. The worktree's
  `median.js` did `module.exports = median` while the check destructures `{ median }`; codex's answer said it did not
  run the required check. The one evidence entry in `attempts/1/verify.json` is 1237 bytes (UTF-8,
  `Buffer.byteLength`), with `TypeError: median is not a function` starting at byte 391. That contract had
  `maxAttempts: 1`, so no retry happened; with 2, attempt 2 would have been planned and executed from the same prompt
  bytes as attempt 1.

## 3. Design A — the verify prompt carries ccloop's check results

1. `RequiredChecksOutcome`'s passing branch gains `results: { command: string; stdout: string; stderr: string }[]`,
   one per check in contract order, filled at the same point that pushes the passed evidence (`runLoop.ts:207`). Exit
   status is 0 by construction (the exec resolved). The `checkRunner` path (saved-result recovery,
   `runSavedResultCheck`) returns the same `{stdout, stderr}` and is covered identically.
2. `AttemptContext` (`src/runtime/types.ts:5-21`) gains an optional `requiredCheckResults?: RequiredCheckResult[]`
   with that shape. `runVerification` passes `{ ...context, requiredCheckResults: requiredChecks.results }` to
   `adapter.verify` (`:308`); nothing else sets it. The command-verifier and failing paths are unchanged.
3. `buildVerifierPrompt` adds the §5.1 lines **only when** `requiredCheckResults` is present and non-empty
   (`requiredChecks` is `min(1)` in the schema, `src/contract/schema.ts:65`, so a real verify always has it). Absent ⇒
   the prompt is byte-identical to today — this is what keeps the direct-builder criteria unchanged (§7).
4. Position: immediately before `FINAL_MESSAGE_LINE`, the slot the prompts.ts rule (`prompts.ts:12-13`: "every
   existing line stays byte-for-byte and in order (the fake CLIs anchor on the second line); new text is inserted after
   the second line or appended as the last line") already admitted for `DECISION_LINES` (`:36`, "Last before
   FINAL_MESSAGE_LINE, as the rule above allows"). Existing lines keep bytes and order; line 2 is untouched.
5. The tails are rendered with `formatJson` (`prompts.ts:8-10`), so newlines in check output are escaped inside JSON
   strings and cannot create a line that the fakes' line-anchored regexes (`tests/fixtures/fake-codex.mjs:136`,
   `fake-claude-cli.mjs:158`, `/^Verify task (.+)\.$/m`) would match.
6. ccloop's evidence merge after the verifier (`:309-312`) and `enforceVerificationContract` are unchanged.

## 4. Design B — plan and execute of a retried attempt carry the last rejection

1. `AttemptContext` gains an optional `lastFailure?: { rejectCategory: string; failingCommand: string | null;
   evidence: string[] | null }`.
2. In `runLoop`, one variable per run, `lastRejectionEvidence: string[] | null = null`, is set to
   `verification.evidence` in the retry branch (`:1935`), next to the fingerprint it accompanies.
3. The plan (`:1532`) and execute (`:1599`) contexts get `lastFailure` when `state.recentFailures.length > 0`:
   `rejectCategory` and `failingCommand` from `state.recentFailures.at(-1)` (the source the human named), `evidence`
   from `lastRejectionEvidence` — `null` when the failure came in through an allowance continuation (its evidence lives
   in another run's directory; not carried, §10). The verify context does **not** get it (the verifier judges this
   attempt on its own evidence).
4. `buildPlannerPrompt(contract, lastFailure?)` gains an optional second parameter; the three adapters pass
   `context.lastFailure` (`claudeAgentAdapter.ts:332`, `codexAdapter.ts:136`, `ompAdapter.ts:45`). Existing
   one-argument callers (tests, `tests/control/materialize.test.ts:197`) keep their bytes. `buildExecutorPrompt` reads
   `context.lastFailure`.
5. Both builders add the §5.2 lines only when `lastFailure` is present, immediately before `FINAL_MESSAGE_LINE`
   (executor: after `CODEX_NULL_LINE` when codex adds it, `prompts.ts:76`; codex's own trailing "Wrap the complete or
   partial result…" line, `codexAdapter.ts:138`, stays last).
6. Evidence excerpt (code, not model, Rule 5): drop entries that start with `"command output | required check passed: "`
   (ccloop's passed-check lines, `runLoop.ts:150`; they say nothing about the cause), then bound each remaining entry
   and the total as in §6.2, keeping order. Category and command are not bounded beyond what they already are.
7. Stop logic (`isRepeatedFailure`), fingerprints, `run-state.json`, `control` wire and the `recentFailures` strict
   schema (`src/control/command.ts:178`) are unchanged: nothing new is persisted.

## 5. Exact prompt text to append

### 5.1 Verifier (A)

```
ccloop already ran every required check above in this worktree, after the execute phase and immediately before this verify phase; each one exited 0. Its results follow (each output stream is cut to its last bytes; the omitted counts are the bytes cut from the front):
<formatJson([{ "command": string, "exitCode": 0, "stdoutTail": string, "stdoutOmittedBytes": number, "stderrTail": string, "stderrOmittedBytes": number }, ...])>
These results are ccloop's own measurement of the required checks. Do not reject only because you cannot run a required check yourself (for example a permission, sandbox or compound-command refusal); you may still run any of them, and if your own run fails, reject with that output as evidence.
```

### 5.2 Planner and executor (B), identical text in both

```
The previous attempt at this task was rejected. This attempt runs in a new worktree; do not assume the previous attempt's changes are present. Its rejection, quoted as data (evidence entries come from ccloop's checks and the verifier, long entries keep only their first and last bytes; evidence is null when it was not carried into this run):
<formatJson({ "rejectCategory": string, "failingCommand": string | null, "evidence": string[] | null, "evidenceOmittedEntries": number })>
Address that cause so this attempt does not fail the same way. It does not change the goal, the success condition or the constraints above.
```

`evidenceOmittedEntries` is present only when `evidence` is non-null. Wording is English to match every other prompt
line.

## 6. Size bounds (UTF-8 bytes of the raw text; cuts land on code-point boundaries)

Cut rules: *tail of K bytes* = the last K bytes, start moved forward past UTF-8 continuation bytes (`(b & 0xC0) === 0x80`);
*head of K bytes* = the first K bytes, end moved back the same way. Never a U+FFFD from a split character.

### 6.1 A

- Per stream (stdout, stderr of each check): tail of `min(2048, floor(8192 / n))` bytes, `n` = number of checks.
  Total tails ≤ 2 · n · floor(8192/n) ≤ **16384 bytes** for any n. `…OmittedBytes` = original bytes − kept bytes.
- Tail, not head: a failing tool prints its diagnosis last; for a passing check the verifier mostly needs "it ran and
  what it said at the end".
- Commands are not cut (they are contract text already in the prompt at `prompts.ts:98`).

### 6.2 B

- Per evidence entry: ≤ 2048 bytes; a longer one becomes head 512 + `…[<n> bytes omitted]…` + tail 1536.
  Head keeps `required check failed: <command>`; tail keeps stderr and `exit=` (`runLoop.ts:143-173` builds them in
  that order). The §2.2 median entry (1237 bytes) passes whole.
- Entries are taken in order while the running total of kept entries is ≤ **8192 bytes**; the rest are counted in
  `evidenceOmittedEntries`.

### 6.3 Not bounded by this

JSON escaping can grow the rendered text (a control byte becomes `\u001b`, 6 bytes; ANSI colour codes in test output
are the realistic case). Accepted: the bound is on content, the rendering factor is ≤ 6 and only for control bytes.

## 7. Existing criteria that would change (each needs the human's per-item nod, Rule 15)

Found by reading and grep at `86f6123` (every test that imports a prompt builder, every byte-level `prompt` assertion,
every fake-CLI test with `maxAttempts ≥ 2`). The implementer must still run the affected tests and report any other
red as a new item, not fix it.

1. **`tests/controller/taskResultOutcome.test.ts:33` (build) and `:43` (assert)** — "%s: invokes the real verifier once
   with baseline prompt even when optional report accessor throws". It builds `expectedPrompt` in `execute` from the
   execute context, then asserts the real verify prompt `toBe` it. Under A the real verify context carries
   `requiredCheckResults` (the codex fixture has one required check, `tests/runtime/codex/fixture.ts:23`), so the two
   differ by design. Proposed whole rewrite, not loosened: build `expectedPrompt` in `verify(context)` as
   `buildVerifierPrompt({ ...context, execution: <the core object execute returned, without the accessor> })`, keep
   `toBe`, and add `expect(actual.prompt).toContain("ccloop already ran every required check above")`. It then encodes
   the original ruling (the optional report never changes what the verifier sees) plus ruling A.

Checked and **unchanged** under this design (because new lines appear only when the new context fields are present):
`tests/runtime/taskResultPrompts.test.ts:13-53` (literal verifier golden), `tests/runtime/claude/phasePrompts.test.ts:29-77`
(first two lines, ordered-lines filters at `:35-38` and `:56-65`, final line), `tests/runtime/reportedDecisionsPrompts.test.ts:52-118`
(executor length `BEFORE.length + 5` at `:58`, codex null line at `:105`, verifier byte-identity), `tests/runtime/claude/claudePhaseRunner.test.ts:258-310`,
`tests/runtime/claude/claudePhaseRunnerPartialOrigin.test.ts:75-86`, `tests/runtime/codex/taskResultDecoding.test.ts:27-28`,
`tests/control/materialize.test.ts:197`, `tests/runtime/claude/claudeSkillPluginDir.test.ts` (prompt masked as `<prompt>`).
`tests/cli/cli.test.ts`, `tests/cli/crashResume.test.ts`, `tests/control/accept.test.ts` run multi-attempt fakes but
assert no prompt bytes (crashResume only `includes("Execute one isolated attempt")`, `:75`).

## 8. New tests (add only; each with the mutation that must turn it red, seen red in a `git clone --local` copy, Rule 17)

A:
- `buildVerifierPrompt` with `requiredCheckResults`: the three §5.1 lines sit immediately before the final line; every
  other line equals the same prompt built without the field, in order. *Mutation:* emit the block unconditionally ⇒
  `taskResultPrompts` golden red; emit never ⇒ this test red.
- Bounds: one check with 10 MiB stdout of `"é"` ⇒ `stdoutTail` ≤ 2048 bytes, no U+FFFD, `stdoutOmittedBytes` exact;
  five checks ⇒ each tail ≤ 1638 bytes. *Mutations:* head instead of tail; drop the boundary step; drop `/ n`.
- `runLoop` with a stub adapter whose `verify` records its context, check `printf ok; printf err >&2`: the verify
  context has `[{command, stdout:"ok", stderr:"err"}]`; plan/execute contexts do not. A failing check still never
  calls `verify`. *Mutation:* drop the `requiredCheckResults` spread at `runLoop.ts:308`.
- Through the real claude and codex adapters with the fakes: the marker's verify prompt contains the block.

B:
- Builders with `lastFailure`: §5.2 lines last before the final line in planner and executor (and before codex's
  wrap line); absent ⇒ byte-identical. *Mutation:* planner ignores the new parameter.
- Excerpt: passed-check entries dropped; a 5000-byte entry ⇒ 512 + marker + 1536; ten 2048-byte entries ⇒ four kept,
  `evidenceOmittedEntries: 6`; the median entry (fixture copy of §2.2, path shortened) passes whole and contains
  `TypeError: median is not a function`.
- `runLoop`, `maxAttempts: 2`, stub adapter, check fails on attempt 1 with that stderr: attempt 2's plan and execute
  contexts carry `lastFailure` with category `required-check-failed`, the command, and the evidence; attempt 1's carry
  none; the verify context never does. *Mutation:* stop setting `lastRejectionEvidence` (⇒ evidence null).
- Allowance continuation with one inherited fingerprint: attempt 1's plan carries `lastFailure` with `evidence: null`.
  *Mutation:* gate on `attempt >= 2` instead of `recentFailures.length` ⇒ red.

## 9. Risks

- **A lets a lazy verifier approve without looking.** The checks passed by ccloop's own measurement either way; the
  text keeps "you may still run any of them" and the success condition / reject-on lines unchanged. The verifier's
  judgment of everything beyond the checks is not touched.
- **Check output is target-repo text in the verifier prompt; rejection evidence is model text in the next planner
  prompt.** Both are rendered as JSON data with a "quoted as data" lead-in and bounded. Same trust domain as today's
  `Current execution outcome` (`prompts.ts:105-106`), which already embeds model-written logs unbounded.
- **Prompt growth**: ≤ 16 KiB (A) and ≤ 8 KiB (B) of content per phase, plus JSON escaping (§6.3). Cost per call rises
  by that many input tokens at most; no number is estimated here (Rule 14).
- **B can bias the retry toward the reported cause** when the cause was the verifier's misjudgment. The text says "it
  does not change the goal, the success condition or the constraints".
- **Orca side**: nothing Orca parses changes (no wire field, no persisted field). Orca's acceptance scripts read
  outcomes, not prompts; the fake CLIs' argument conventions Orca uses are untouched.

## 10. Non-goals

- Carrying evidence across an allowance continuation or a handoff run boundary (it would mean reading another run
  directory's `verify.json`; B passes `evidence: null` there).
- Feeding more than the last failure, or execution-format / partial / infra failures (they never enter
  `recentFailures`).
- Showing the verifier the previous attempt's rejection.
- Changing `isRepeatedFailure`, retry counts, `safeToRetry`, the claude allow rules, or the permission mode.
- Making ccloop decide `required_check_not_run` itself (the verifier's category stays its own judgment).

## 11. Context recorded, not designed here

- **Permission mode**: the human chose claude `--permission-mode bypassPermissions` in their own agents table for now
  (Orca session `308b874c`, 2026-10-20). That is operator configuration, outside this repository's defaults.
- **Deferred alternative — claude's Bash sandbox** (research: Orca session `308b874c` scratchpad
  `/private/tmp/claude-501/-Users-biran-code-skills-orca-Orca/308b874c-2161-4914-b57e-705e8b169315/scratchpad/docs/`,
  copies of the code.claude.com permission-modes, sandboxing, settings and headless pages). Instead of bypassing
  permissions, a run could enable the built-in Bash sandbox (macOS, Linux, WSL2) per session through `--settings`
  (`sandbox.enabled: true`, above user/project settings, below managed) so sandboxed commands, compound ones included,
  run without an allow rule while filesystem and network stay confined; network is closed by default and opened per
  domain (`sandbox.network.allowedDomains`, `strictAllowlist`). Open questions that keep it deferred: the docs describe
  auto-allow through the interactive `/sandbox`, while `claude -p` without a mode starts in Manual mode and denies what
  needs approval unless an allow rule, hook, or auto mode applies — whether sandbox auto-allow covers `-p` is unmeasured;
  checks that need the network (package installs) would fail closed; deny rules still apply. Not designed, not
  measured, no paid run.
- A correction to the codex phase isolation spec and handoff (`~/.codex/config.toml` is written through the symlink
  by a real paid exec; human ruled that allowed) is drafted separately for the human, not in this document.
