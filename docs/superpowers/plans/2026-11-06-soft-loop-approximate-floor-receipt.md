# Soft loop settlement: an approximate-floor marker and its orca-auto receipt (ccloop half)

**Goal:** saved-result recovery accepts a run whose unknown usage Orca settled itself with an approximate floor: an
`approximate-floor` marker under principal `orca-auto`, backed by Orca's own panel-class row (verb
`settle-approximate-usage`), under a finite work ceiling only.

**Spec:** Orca `docs/superpowers/specs/2026-11-06-soft-mode-loop-run-settlement-design.md` §2 (d), §3.2 ("ccloop" and
"Errata"), §3.7 C1–C8, and the human's answers in **§6** (session 86352010), which rule over the text above them:
Q3 = (d), Q5 = keep (`reservationDisposition` stays `committed | released`), Q6 = finite ceiling only, Q7 = exclude
(no C7).

**Constraints:** this repository's `CLAUDE.md` (Rule 13–18). Criteria added only (Rule 15);
`tests/control/socketSettlementReceipt.test.ts` unchanged and green (C8). Mutations only in a built `git clone --local`
copy. Merge `--ff-only`; push is the human's.

## Tasks

1. `src/control/savedResultRecovery.ts`: marker and receipt schemas become unions; the backing comparison and the
   charge rule gain an `approximate-floor` branch; `remaining-grant` unchanged.
2. `tests/control/approximateFloorReceipt.test.ts`: C1–C6, each seen red on its named mutation.
3. Errata: the scan below, a named ERRATUM at the end of each hit's comment block.

## As built

Orca session 86352010, 2026-11-06; implemented by a subagent of that session (Claude Opus 5.5).

### What

- **Marker** (`personSettlementSchema` is today's object, bytes unchanged): union with `approximateSettlementSchema` =
  today's fields minus `method`/`principal`, plus `method: "approximate-floor"`, `principal: z.literal("orca-auto")`,
  `floorTokens: safe | null` (`safe` = non-negative safe integer, the file's own), `reason: string.min(1)`; `commandId`
  kept; `reservationDisposition` `committed | released` (Q5).
- **Receipt** (`personReceiptSchema` is today's object, bytes unchanged): union with
  `{principal: "orca-auto", client: "panel", verb: "settle-approximate-usage", commandId, result}` where `result` is
  today's result object with `method: "approximate-floor"`; strict, so no `personPrincipal`.
  - **Choices the spec left open (narrowest taken):** `principal` and `client` are literals. `client: "panel"` is a
    choice, not a reading: in Orca as read in this session (Orca checkout at `660b4bdf`), a command issued inside the panel
    with no route context records `client` and `principal` as NULL (`src/control/commandClient.ts:56-57`,
    `commandClientFor`/`commandPrincipalFor`; `src/control/commandLedger.ts:300-310`), and Orca's attribution for such a
    command is `via: "panel"` (`commandAttributionFor`, `commandClient.ts:62-64`). So **Orca's pass must apply its
    row under a command context `{client: "panel", principal: "orca-auto"}`**, or `settlementReceipt` copies NULLs and
    this receipt fails to parse (`saved-result-evidence-invalid`). The result object carries no `floorTokens`/`reason`
    (the marker does), matching today's person result.
- **Backing:** `approximate-floor` needs `receipt.verb === "settle-approximate-usage"` and
  `marker.principal === receipt.principal`; `remaining-grant` needs `receipt.verb === "settle-unknown-usage"` and
  today's principal rule. `same(receipt.result, {…, method: marker.method})` is unchanged. Cross-combinations ⇒
  `saved-result-settlement-invalid`.
- **Charge rule, `approximate-floor`:** `source.claim.grant.work.tokens === null` ⇒ `saved-result-settlement-invalid`
  (Q6, the code a null ceiling gets today); `charged.work.tokens === (floorTokens ?? 0)`; every other dimension and all
  of handoff charged 0; `a[bucket][d] === baseline[bucket][d] + charged` for every dimension. Only the work-token
  ceiling is consulted (Q6 names "the run's work ceiling").
- **Not changed:** the interrupted-predecessor path (`validateInterruptedPredecessor` → the shared
  `validateAccounting`) reads the same schemas, so it would also accept an `approximate-floor` marker. Q7 = exclude
  means Orca never writes one for a recovery run; no criterion covers that path (no C7), and no guard was added.

### Criteria and mutations

`tests/control/approximateFloorReceipt.test.ts`, 12 cases. Mutations in a `git clone --local` copy of this branch at
`5590779` (built), applied and reverted by `afr-mutate.py` in the session scratchpad; each run
`./node_modules/.bin/vitest run tests/control/approximateFloorReceipt.test.ts --reporter=json`. Restore:
`git diff` 0 bytes, `git diff --cached` 0 bytes (Python `len()` of the captured stdout).

| Case | Mutation | Observed |
|---|---|---|
| C1 finite ceiling ⇒ eligible | M1 marker schema keeps `remaining-grant` only | red (9 of 12 red, incl. this) |
| C1 null ceiling ⇒ `saved-result-settlement-invalid` | M2 consult no ceiling for the method | red: `eligible` (only this case) |
| C2 marker `principal: "user:fixture"` ⇒ `saved-result-evidence-invalid` | M3 `principal: z.string()` | red (reason became `settlement-invalid`; only this case) |
| C3 approximate + person receipt (`user:fixture`; and `orca-auto`), remaining-grant + orca-auto receipt ⇒ `settlement-invalid` | M4 (spec) compare principals without the verb | **not red (0 of 12)**, see below |
| | M4b M4 + result method taken from the receipt | red: the `orca-auto`-principal person receipt becomes `eligible` |
| | M4c no verb/principal clause + result method from the receipt | red: all three C3 cases `eligible` |
| | M4d verb clause only (no principal compare) + result method from the receipt | not red (0 of 12) |
| C4 charged ≠ floor; cumulative ≠ baseline + charged | M5 skip the charge rule for the method | red: both |
| | M5a drop the charged arm only / M5b drop the cumulative arm only | red: each its own case only |
| C4 `floorTokens: null` ⇒ charge 0, eligible | M5c `floorTokens` without `?? 0` | red |
| C5 `receipt: null` ⇒ `saved-result-usage-unsettled` | M6 accept a null receipt for the method | red (reason became `evidence-invalid`) |
| C6 released + `handoffResolution` ⇒ eligible; released alone ⇒ refused | M7 drop the released check for the method | red: released alone `eligible` (the eligible case is red under M1) |
| C8 `socketSettlementReceipt.test.ts` 4/4 | — | green, file not edited |

**C3 finding (spec §3.7's mutation is equivalent).** With the receipt schema a union, `same(receipt.result, {…,
method: marker.method})` already ties the receipt's branch to the marker's method, and the two principals of the
`approximate-floor` branch are both literals. So the verb clause and the result-method comparison each refuse every
cross-combination on their own: M4 (verb dropped) and M4d (method dropped, verb kept) both stay green; dropping both
(M4b/M4c) turns C3 red. The verb clause is kept because the spec and the task ask for it; it is a second, independent
guard, not one a single-line mutation can see.

### Errata scan (Rule 16)

Command, run in this worktree at `292ddb5` (before any edit):
`grep -rn -i 'never booked\|never.*to book\|never charged' src` → five hits:

- `src/runtime/codex/codexAdapter.ts:106` ("named exception to \"usage is never booked as 0\"") — about a codex
  isolation refusal before spawn, not a floor; **left**.
- `src/runtime/omp/ompAdapter.ts:193` ("never booked as usage") — ERRATUM (single call).
- `src/control/usageLowerBound.ts:7` ("never an exact figure to book") — ERRATUM (loop run).
- `src/control/singleCall.ts:33` ("Diagnostic only -- never booked") — ERRATUM (single call). **Missing from the spec's
  list**; it is at `f3ea202` too (`git show f3ea202:src/control/singleCall.ts`, line 33).
- `src/control/collect.ts:57` ("For display, never booked.") — ERRATUM (loop run), as a line comment after the
  one-line JSDoc so the original line is byte-identical.

### Gate

Measured on this branch at `5590779` (code + errata; the plan is docs only), in the worktree, with
`export ECC_GATEGUARD=off DISABLE_OMC=1`, nvm node v22.13.1:

- `rtk proxy npm run typecheck` rc 0; `rtk proxy npm run build` rc 0.
- `./node_modules/.bin/vitest run tests/control/approximateFloorReceipt.test.ts tests/control/socketSettlementReceipt.test.ts`
  rc 0, 16/16 (12 + 4).
- Full: `./node_modules/.bin/vitest run --reporter=json --outputFile=<scratchpad>/afr-full.json` rc 1: 2542 tests,
  2529 passed, 13 failed, 0 skipped; load 40 before, 39 after (`uptime`).
  `node scripts/check-known-reds.mjs <scratchpad>/afr-full.json` rc 1: 3 reds in the roster (`codexAdapter` outer
  watchdog, `claudePhaseRunner` close-pending, `runCodexPhase` TERM-ignoring), **10 outside it**:
  `endToEnd` candidate-fsynced (1), `phasesCompleted` (1), `savedResultRecovery.native` (5: terminal-fsynced, successor
  after usage-settled, four "refuses cleaned success"), `setupRunLoop` continuation (1), `ompPhase` TERM-ignoring
  grandchild (1).
- **Classified as load**, each file run alone, branch and an untouched `git clone --local` of main at `292ddb5`
  (built), alternately (`afr-compare*.sh` in the session scratchpad):
  - `endToEnd` 7/7 and `ompPhase` 23/23 on both sides in rounds 1–2.
  - `phasesCompleted`: branch red round 1, green 2–4; main red round 3 (the same timeout), green 1, 2, 4.
  - `setupRunLoop`: branch red round 1, green 2–4; main green 1–4.
  - `savedResultRecovery.native` (the file holding the changed module; every failing case settles **known** usage, so
    none reaches the changed `unknown` branch): main red in 3 of 7 rounds (3, 5, 7) with the same shapes
    (`ENOTEMPTY` on cleanup, `worker did not seal and exit`, 30 s timeouts); the branch's code in a scratchpad clone
    green 28/28 in rounds 5 and 6, red in 7 (load 145); the worktree green in rounds 1 and 5, red in 2, 3, 4, 6, 7.
    The worktree reds more often than the clone of the same commit (same bytes, `cmp`); not explained, recorded.
- Merged `--ff-only` into main; not pushed (the human pushes).
