# rejectOn is the verifier's judgment, not a substring search — design

Status: draft for the human's review. Author: Orca controller session `ceca1c47`, 2026-10-01.
Base: ccloop main at the commit titled `docs(handoff): roll the Orca section to 2026-10-01: …`.

## 1. Ruling

The human, 2026-10-01 (Orca session `ceca1c47`), on the four options below: "ccloop 的 rejectOn：我推荐第四条路 D => 同意".
Earlier in the same session, on fixing the matching rule in this repo at all: "同意".

## 2. Problem (measured)

`enforceVerificationContract` (src/controller/runLoop.ts) runs after an **approving** verifier and turns the approval
into `approved: false`, `rejectCategory: "reject-on-matched"`, `safeToRetry: false` when any evidence entry contains a
`rejectOn` string as a case-sensitive substring (`evidenceIncludes`).

`rejectOn` is written for a model: the README's example is `"rejectOn": ["tests fail"]`, and the verifier prompt lists
the conditions. A substring cannot tell "the condition occurred" from "the condition was mentioned":

- Orca measured it with real claude (claude 2.1.285, six verify calls; Orca ledger
  `.superpowers/sdd/2026-10-01-loop-plans-followups/progress.md`, "## C4"): in two of three good runs the approving
  verifier explained "…so REJECT:empty-document does not apply", and the run failed with no retry.
- The same shape fires on ordinary words: an approval saying "no tests fail" contains `tests fail`.
- For a rejecting verifier the branch is skipped (`if (!verification.approved) return verification`), so it never
  adds a rejection the verifier did not make; it only overrides approvals.
- The searched evidence is not only the verifier's prose: for both verifier types it also holds ccloop's own
  required-check evidence (`buildRequiredCheckEvidence`: the literal `command output`, `required check passed: <cmd>`,
  `stdout=…`, `stderr=…`), merged in ahead of the verifier's entries for `agent`. So today a check that exits 0 but
  prints a `rejectOn` string, or whose command text contains it, also overrides an approval. That half is
  deterministic, but it has the same mention problem (`0 tests fail` contains `tests fail`) and is equally unpinned.

Coverage: no criterion pins the branch. Measured in a throwaway clone (session `ceca1c47` scratchpad `ccprobe/`,
`vitest run --reporter=json`): with the branch removed, 1087 tests, 1085 passed; the two reds are the known
`stopProof` and the verifier-prompt criterion named in §5 (red only because the prompt line also changed).

## 3. Options considered

- **A. Whole-entry match**: an evidence entry must equal the token. Depends on the model following a formatting
  convention; for natural-language conditions it almost never fires, so it behaves like D while keeping the code and
  a prompt convention.
- **B. Dedicated output field** (`rejectOnMatched: string[]`): only adds a case where the verifier approves and lists
  a matched condition at once — a contradictory output. Costs a verifier-output schema change across the claude and
  codex adapters and every fake, and a paid run to prove the real CLI accepts the schema.
- **C. Skip negated mentions**: guesses at language; not reliable.
- **D (chosen). rejectOn feeds the verifier's judgment only**: ccloop stops searching evidence for it.

## 4. Design

1. `enforceVerificationContract`: remove the `rejectOn` branch. An approval stands unless `evidenceRequired` is
   missing (unchanged). The `"reject-on-matched"` category is no longer produced by ccloop; where both conditions held
   before, the category is now `"missing-required-evidence"` (intended). Readers of the category are shape-only
   (`stopController.ts` equality, `control/handoff.ts` category list, `z.string()` in state types and `control/command.ts`),
   so persisted `recentFailures` holding the old value still load.
2. Verifier prompt (src/runtime/claude/prompts.ts `buildVerifierPrompt`, shared by both claude adapters and the codex
   adapter): the line
   `Reject-on conditions (must force approved=false when present in evidence):` becomes
   `Reject-on conditions (if any of these holds for this attempt, approved must be false):`.
   The list itself is unchanged.
3. Contract schema unchanged (`rejectOn: z.array(z.string()).min(1)`); every stored contract still loads.
4. `verifierType: "command"`: `rejectOn` has no effect. Today it can only substring-search check output, which nothing
   pins; a check that must reject on output text is written as a check (`! grep -q X out.log`).
5. Docs: README.md line 189 (`"rejectOn": ["tests fail"],   // 至少一个`) gains the meaning — prompt-only, no effect
   for `command`, output conditions belong in a check; line 249 ("原样注入") stays true. The published framework spec
   `2026-07-14-loop-engineer-framework-design.md` (§ Verification, line 132 lists the field) gets an appended correction
   section, not an edit (Rule 16). `docs/handoff/handoff.md` (Orca section, lines 419, 433, 466 describe the substring
   rule as current / open) is rolled.
6. `dist/` is build output (gitignored); it is rebuilt, not edited. A leftover old prompt line in an unbuilt `dist/`
   is not a finding.

`evidenceIncludes` stays (still used by `evidenceRequired`).

## 5. Criteria

- Existing, named for rewrite by the human (Rule 15): `tests/runtime/claude/subprocessClaudeAdapter.test.ts`
  "includes plan, execution, rejectOn, and evidenceRequired in the verifier prompt" — the asserted prompt line
  becomes the new one. **Needs the human's naming before the plan runs.**
- New, in the controller's integration tests: an `agent` verifier (the scripted adapter's verify frame) that approves
  with evidence quoting the rule (`"…so tests fail does not apply"`, and an entry exactly equal to the token) ends the
  attempt approved, the run `succeeded`. The required check's own command and output must not contain the token, so
  the case measures the verifier's prose alone. Red on today's code (the branch fires), green after.
- New: a `command` verifier whose required check exits 0 and prints the token on stdout, with the token absent from
  the command text (a script file in the fixture repo, or `printf 'tests\x20fail'`), still approves. Red today, green
  after.
- Mutation: restore the branch → both new criteria red. Mutation: put the token only in the command text of the
  second criterion on today's code → red, showing the command text is a separate path the criterion does not rely on.
  Mutation: restore the old prompt line → the rewritten prompt criterion red.

## 6. What changes for clients

- An approving verifier is never overridden by `rejectOn` any more; a rejecting verifier keeps its own
  `safeToRetry` (as today).
- Lost, (a): a net for a verifier that approves while naming a matched condition. Today it fires on mentions.
- Lost, (b): rejection of an approved attempt because a passing check's stdout/stderr (or its command text) contains a
  `rejectOn` string, for both verifier types. This was deterministic, model-free, but also fires on mentions
  (`0 tests fail`) and was never pinned or documented. A contract that wants it writes the condition as a check
  (`! grep -q 'tests fail' out.log`), whose exit code is the verdict.
- Neither (a) nor (b) is pinned by any criterion today.
- Orca v2 plans no longer rely on tokens (Orca commit titled `feat(control): loop plans v2 stop relying on rejectOn
  tokens …`). Orca v1 plans (bugfix, design, investigate) are agent-verified with `REJECT:no-red-first`,
  `REJECT:empty-document`, `REJECT:empty-report`; after a repin those tokens are prompt-only, and the verifier prompt
  carries no `constraints`, so a v1 verifier sees a bare token under "if any of these holds". Measured in the real
  `~/.orca` (session `ceca1c47`): 0 stored loop recipes, so no live task is on v1. New tasks expand at v2.
- Orca text to correct when Orca repins (Orca's own work, not this repo's): `src/control/loopPlans.ts` comment on
  `rejectOn` ("A case-sensitive substring over every evidence string") and the C4 comment's present-tense description;
  spec `2026-09-30-loop-plans-design.md` §2.1/§2.2 via a correction section. `src/scheduler/reconcile.ts` uses
  `rejectOn: ["nonzero exit"]` with a command verifier; already inert in practice, fully dead after.
- Other local clients: none found (search of `/Users/biran/code` for `rejectOn` outside ccloop and Orca, session
  `ceca1c47`: only unrelated promise `rejectOn` identifiers).

## 7. Registered, not in this design

- `evidenceRequired` uses the same substring search in the other direction: an evidence entry saying "no command
  output was available" satisfies `"command output"`. Worse: every required check's evidence starts with the literal
  `command output` (`buildRequiredCheckEvidence`), so the README's own example `"evidenceRequired": ["command output"]`
  is always satisfied by ccloop's text. Same shape; a separate round.
