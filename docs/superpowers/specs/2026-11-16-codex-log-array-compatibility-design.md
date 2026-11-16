# Codex Execute Log Array Compatibility

Date: 2026-11-16. Source: Orca tester feedback #316 in `/Users/biran/code/skills/orca/orca_archived_files/issue-20261023.md` (external to this repository). Authoring checkout: ccloop branch `fix/codex-log-array-316`, based on the commit titled `docs(handoff): roll the Orca line to the repin at this main and the g-28d9b560 acceptance`. This is a prospective design; earlier format-failure capsules retain their original meaning.

## Intent

A Codex execute that completes its work and reports valid usage can put an array of log lines in `stdoutStderrLog` while keeping the rest of its answer valid. The current strict decoder rejects the whole answer, charges the observed usage and loses the automatic success/verification path. Accept only an array of strings for this one Codex field, preserving all other strict checks and original evidence.

## Approaches

1. Widen the shared execution schema to `string | string[]`: short but also changes Claude, OMP, persisted execution and old recovery semantics. Rejected.
2. Reinterpret only Codex execute at its normalization boundary, projecting `string[]` to a string after validating the original answer. Selected. The established execution and source-package shape remains a string.
3. Auto-accept any format failure's worktree: would turn malformed core answers into apparent success without authority. Rejected. Orca's existing owner accept-attempt stays a conditional fallback.

## Behavior and limits

- A Codex execute whole or decorated final with a unique valid result may carry `stdoutStderrLog: string[]`. Join elements with one newline in order; `[]` yields an empty string. The existing final-text cap bounds the input; no additional permissive coercion. A non-string element, malformed core field, hidden competing candidate or ambiguity is refused as before.
- The Codex wire schema continues to ask the provider for a string. The new decoder tolerates a provider/prompt-mode deviation when one reaches the process anyway; it does not promise to make a strict provider generate arrays.
- Keep `executionSchema`, other adapters and the stored `ExecutionResult` unchanged. `runCodexPhase` keeps the original final bytes, usage and stream. `execution-normalization.json` retains its existing diagnostic shape and original byte count; successful execution writes the joined log. `commandOutputs`, `changedFiles`, `diffPatch` and `taskResult` retain strict behavior.
- Captured format-failure capsules are historical failure evidence and must not become successful merely because the new Codex interpretation can understand an array. The explicit `execution-format-failure-v1` refusal remains. New successful Codex results recoverable from an exhausted-completion source must be re-decoded using the same Codex interpretation; non-Codex sources keep the old strict decoder.
- No automatic retry or billing change. If an incident run was superseded, it cannot be retroactively accepted under Orca's current-run guard; owner accept-attempt on a future complete snapshot is independently available after checks.

## Verification

- New Codex-specific tests: complete and partial, direct/wrapped finals, decorated unique result, empty array, bad element, ambiguous/malformed core; raw final and joined log agree with expected evidence, observed usage retained. Existing Claude/OMP string-only tests remain unchanged.
- Recovery tests: new Codex exhausted completion can be read under Codex mode; historical format-failure capsule is still refused. Current saved-result schema and normalizer provenance stay explicit.
- Run ccloop typecheck/build and focused runtime/recovery tests; record full-suite result with `check-known-reds.mjs` only after a real JSON run. All mutations happen in a `git clone --local` copy, never the source tree.

## Open risk

A malformed model final may have no successful execute even if files changed; this compatibility rule does not infer success from the worktree. The provider's strict output-schema dialect may reject an array before it can reach this decoder; the test covers the transport boundary, not an unobserved provider behavior.
