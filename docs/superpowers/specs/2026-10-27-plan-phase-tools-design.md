# omp plan phase: name its tools, classify a forbidden one

- **Author:** Orca session `7753e97d` (2026-10-27), implementer lane `fix/strict-and-plan-tools`. Code references are
  ccloop main `6df6cd1`.
- **Source:** Orca tester issue 60 (`orca_archived_files/issue-20261023.md`, run `run-30b2087f-…`): an omp plan phase
  failed `omp-phase-tool-forbidden` because the model called `write` on the MCP path `xd://mcp__rea_capture_process_scenario`
  to run `git log`. The run's `failureCause` was `unknown`, so Orca neither retried nor explained it.
- **Human direction (relayed by the Orca controller, session `7753e97d`):** do **not** allow bash or writes in plan.
  Instead (a) the plan phase's system prompt names the tools it has and says what is unavailable; (b) the refusal gets a
  classified `failureCause`, reusing an existing cause if one fits.

## 1. Today

- `runOmpPhase.ts:59` passes `--tools read,grep,glob` for plan and verify, `read,grep,glob,edit,write,bash` for execute;
  `OmpPhaseFold` (`ompProtocol.ts:93`) holds the same two sets and refuses any other `tool_execution_start`, an
  `extension_ui_request` or a subagent event as `omp-phase-tool-forbidden`.
- `phaseSystemPrompt("plan")` (`phasePrompt.ts:4`) says only "inspect and describe one attempt; do not change files". It
  never names the tools, so a model that wants history reaches for whatever it has seen elsewhere (here, an MCP bridge
  through `write`).
- `OmpAdapter.phase` (`ompAdapter.ts:40-50`) classifies a decode error of a completed call with `OmpCallFold`, which
  answers `unknown` for everything but its typed rows. Hence `unknown`.

## 2. Change

1. **Prompt.** The plan system prompt gains one line built from the same tool list `runOmpPhase` passes to `--tools`
   (one source, `ompPhaseTools(phase)` in `phasePrompt.ts`, also read by the fold), so the words cannot drift from the
   argv:
   `Tools available in this phase: read, grep, glob. Writes, shell commands and MCP calls (including xd:// paths) are
   unavailable until the execute phase; describe what execute should run instead of calling them.`
   Verify keeps its prompt (the issue and the direction name plan only; the verify tool set is the same, so the line can
   be added there later by the same function if a verify sample appears).
2. **Cause.** A `tool_execution_start` whose tool is not in the phase's set, an `extension_ui_request`, or a subagent event
   is refused as before (`omp-phase-tool-forbidden`, message unchanged) and the error now carries a bounded `detail`
   naming the phase, the tool and, when present, its `args.path`, e.g.
   `plan phase allows read, grep, glob; the agent called write on xd://mcp__rea_capture_process_scenario`.
   `OmpAdapter.phase` classifies exactly that error (by its typed `code` and `detail`, never by model text) as
   **`tool-rule-violated`**, `workObserved: true`. The other `omp-phase-tool-forbidden` shapes (an orphan or duplicate
   tool id, a tool still pending at the end, a tool after the answer) are protocol anomalies, not a tool choice, and stay
   `unknown`.

## 3. Why reuse `tool-rule-violated`

- **Meaning.** Its wording on both sides is "the agent broke the step's tool rules" (Orca `web/src/locales/en.ts`); the
  phase's own tool set is a tool rule ccloop applies to every run, the contract's `toolRules` are the ones the caller adds.
  A new cause (say `phase-tool-forbidden`) would be **accepted** by Orca — `runFailureCauseSchema.cause` is a bounded
  string, not an enum (`Orca/src/control/schema.ts:118`) — but its panel words every cause outside
  `KNOWN_FAILURE_CAUSES` (`Orca/web/src/RunReason.tsx:12`) as `unknown`, which is the very thing issue 60 reports. Reuse
  explains it today with no Orca change.
- **Policy.** `tool-rule-violated` is terminal (not in `RETRYABLE_CAUSES`) and Orca's system-debug ladder exempts it
  (`Orca/src/control/systemDebug.ts:328`). That is the existing transient/non-transient rule applied as written: the call
  failed because the model chose a tool the phase does not have — no evidence a retry passes, and every retry costs a full
  plan call. The prompt line (2.1) is the fix for recurrence; a retry is not. **Not retried.**
- **Run-level effects** of the cause in `runLoop.ts` (`isToolRuleViolation`, `:694`) are an execute timeout and a handoff
  abort; neither occurs in a plan failure, so a plan run fails exactly as before, only with a cause.
- claude and codex do not need this: claude's permission layer denies a tool and the call continues; codex's sandbox does
  the same. Neither ends a phase on a forbidden tool, so neither has an `unknown` to fix.

## 4. Tests (add only)

- `phasePrompt.test.ts`: the plan prompt names exactly `ompPhaseTools("plan")` and says writes, shell and MCP are
  unavailable; execute's prompt does not carry the line.
- `ompPlanTools.test.ts` (runLoop over the omp adapter and `fake-omp.mjs`, which gains an additive
  `<marker>.plan-tools.json`): a plan `write` to `xd://…` ends the run `failed` with
  `failureCause {cause: "tool-rule-violated", phase: "plan", retries: 0, detail ∋ "write", "xd://"}` and only one call;
  the argv still passes `read,grep,glob` (no widening).
- An orphan tool end stays `unknown` (the cause is not attached to every `omp-phase-tool-forbidden`).

## 5. Comment correction

`src/runtime/failureCause.ts:12-13` says the cause is "classified only from the decode error code
`omp-tool-rule-violated`" for "an omp execute call". That comment is published (origin main), so it stays verbatim and an
ERRATUM line follows it (ccloop Rule 16).
