# Codex Log Array Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a valid Codex execute answer when only `stdoutStderrLog` arrives as an array of strings (#316).

**Architecture:** Keep the shared `executionSchema` string-only; accept Codex's array at an explicit adapter-specific normalization boundary and return an ordinary string result. Use the same Codex boundary when validating newly successful exhausted-completion evidence; keep old format-failure capsule refusal.

**Tech Stack:** TypeScript, Zod, Vitest, Node.js.

**Spec:** `docs/superpowers/specs/2026-11-16-codex-log-array-compatibility-design.md`.

## Global Constraints

- Never edit existing ccloop tests without a test-specific human ruling; add new tests.
- Preserve existing published spec and comment text; append a named ERRATUM if it contradicts the new behavior.
- Never mutate the main working tree for fault injection; use a local clone and verify restoration bytes.
- A normalizer accepting a new Codex shape may not silently expand Claude, OMP or the shared persisted schema.
- Redirect all verification runs to complete logs. Test counts are measured, not copied from old handoffs.

## Review Focus

- Complete direct and wrapped Codex answers with an array (Task 1).
- Decorated output with two distinct answer candidates stays ambiguous (Task 1).
- An array with a non-string member or malformed `commandOutputs` still fails with a useful field (Task 1).
- Original final stays unmodified and the joined log is written to the canonical result path (Task 1).
- Old format-failure evidence cannot be upgraded into a successful source (Task 2).

---

### Task 1: Narrow Codex execution normalization

**Files:** Modify `src/runtime/executionNormalizer.ts`, `src/runtime/codex/codexAdapter.ts` and/or a new focused helper; add `tests/runtime/codex/logArrayCompatibility.test.ts`.

**Interfaces:** `normalizeExecutionFinal(final: string)` remains shared strict; a separate `normalizeCodexExecutionFinal(final: string)` returns `ExecutionNormalization`, with only `stdoutStderrLog: string[]` joined into the existing string field.

- [ ] Add direct/wrapped/partial/decorated acceptance, empty array, mixed-element refusal, ambiguous and bad-core refusal; test normalizer and adapter evidence (`final.json`, actual execution log), and usage.
- [ ] Run focused tests to observe each named behavior fail for the right reason.
- [ ] Implement Codex-only projection inside scanner acceptance and final strict parse; preserve raw-byte diagnostics and all shared callers.
- [ ] Run focused tests, typecheck/build, and adjacent normalizer/format-field tests; read complete logs.
- [ ] Commit the verified change.

### Task 2: Saved-result reading and provenance

**Files:** Modify Codex-specific branches in `src/control/savedResultRecovery.ts` and Codex successful-source capture if needed; add `tests/control/codexLogArrayRecovery.test.ts` or focused cases in new file.

**Interfaces:** Codex exhausted-completion source replays through `normalizeCodexExecutionFinal`; older `execution-format-failure-v1` branch remains refused even when the new decoder can parse its raw final. All other source kinds continue using `normalizeExecutionFinal`.

- [ ] Add a test of a newly completed Codex array-log source and an old format-failure provenance refusal; observe RED without replay changes.
- [ ] Change only the successful Codex replay boundary; keep old capsule provenance refusal and unchanged hashes.
- [ ] Run focused recovery suite, typecheck/build, then ccloop JSON suite with `check-known-reds.mjs`; report every unexpected red.
- [ ] Commit the verified change.

### Final integration

- [ ] Review the branch from its base and fix confirmed Critical/Important findings with a RED→GREEN criterion.
- [ ] After the authorized ordinary ccloop push, use Orca's pin script on the pushed SHA from an installation tree with real `node_modules`, then run Orca's affected gate and its ccloop pairing checks. Never treat a locally built binary as the npm-pinned package.
