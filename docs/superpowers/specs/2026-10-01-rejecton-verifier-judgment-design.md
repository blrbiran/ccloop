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
   missing (unchanged). The `"reject-on-matched"` category is no longer produced by ccloop.
2. Verifier prompt (src/runtime/claude/prompts.ts `buildVerifierPrompt`, shared by both claude adapters and the codex
   adapter): the line
   `Reject-on conditions (must force approved=false when present in evidence):` becomes
   `Reject-on conditions (if any of these holds for this attempt, approved must be false):`.
   The list itself is unchanged.
3. Contract schema unchanged (`rejectOn: z.array(z.string()).min(1)`); every stored contract still loads.
4. `verifierType: "command"`: `rejectOn` has no effect. Today it can only substring-search check output, which nothing
   pins; a check that must reject on output text is written as a check (`! grep -q X out.log`).
5. README §6.3 and the contract field docs: say what `rejectOn` now means.

`evidenceIncludes` stays (still used by `evidenceRequired`).

## 5. Criteria

- Existing, named for rewrite by the human (Rule 15): `tests/runtime/claude/subprocessClaudeAdapter.test.ts`
  "includes plan, execution, rejectOn, and evidenceRequired in the verifier prompt" — the asserted prompt line
  becomes the new one. **Needs the human's naming before the plan runs.**
- New, in the controller's integration tests: an `agent` verifier that approves with evidence quoting the rule
  (`"…so tests fail does not apply"`, and an entry exactly equal to the token) ends the attempt approved, the run
  `succeeded`. Red on today's code (the branch fires), green after.
- New: a `command` verifier whose check output contains a `rejectOn` string still approves.
- Mutation: restore the branch → both new criteria red. Mutation: restore the old prompt line → the rewritten prompt
  criterion red.

## 6. What changes for clients

- An approving verifier is never overridden by `rejectOn` any more; a rejecting verifier keeps its own
  `safeToRetry` (as today).
- Lost: a safety net for a verifier that approves while naming a matched condition. Accepted: today it fires on
  mentions, and no criterion ever pinned it.
- Orca: its loop plans v2 no longer rely on tokens (Orca commit titled `feat(control): loop plans v2 stop relying on
  rejectOn tokens …`), so Orca needs no change and no repin to stay correct; a repin only brings this fix along.
  Orca's spec `2026-09-30-loop-plans-design.md` §2.1/§2.2 statements on rejectOn get a correction section in Orca.
- Other local clients: none found (search of `/Users/biran/code` for `rejectOn` outside ccloop and Orca, session
  `ceca1c47`: only unrelated promise `rejectOn` identifiers).

## 7. Registered, not in this design

- `evidenceRequired` uses the same substring search in the other direction: an evidence entry saying "no command
  output was available" satisfies `"command output"`. Same shape; a separate round.
