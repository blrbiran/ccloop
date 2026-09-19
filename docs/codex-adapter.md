# Codex CLI adapter

ccloop owns agent execution; Orca controls ccloop. This adapter invokes a fresh
`codex exec` for each plan, execute, and verify phase. It does not invoke Claude.

Use `--adapter codex --adapter-config /absolute/path/codex.json` with `run`,
`resume`, or `sweep`. All configuration fields below are required:

```json
{
  "command": ["/absolute/path/to/codex"],
  "model": "your-explicit-model",
  "budgetMode": "soft",
  "sandbox": "workspace-write",
  "timeoutMs": 120000,
  "killGraceMs": 250
}
```

The executable must be absolute; the model is passed as one argument without a
shell. Unknown configuration keys and strict budget mode are rejected. Plan and
verify use read-only sandboxing; execute uses the configured sandbox (`read-only`
or `workspace-write`). User configuration and repository rules still apply.
No bypass flags are added. Fixed command prefixes support offline fixtures;
real configurations must point to the Codex executable itself.

Token budgets are **soft**: completed phase input plus output usage is charged,
with cached input counted once. This is not a guaranteed token ceiling. Missing,
invalid, conflicting, or all-zero usage refuses success. Model-supplied usage
fields are rejected. Dollar cost is unknown. Timeouts and cancellation signal the
whole process group with TERM then KILL; output pipes have a bounded drain.

Private evidence lives under `<runDir>/codex/<attempt>/<phase>/call-*/` (directory
0700, files 0600): schema, final message, raw JSONL and stderr, process identity,
outcome, and decoded usage or decode error. Raw logs are appended during execution;
stdout/stderr/final each have a 16 MiB limit and truncation is marked in outcome.
Each invocation has a separate directory. Evidence is retained, not auto-deleted.

Errors include `codex-aborted`, `codex-timeout`, `codex-spawn-error`,
`codex-exit-error`, `codex-output-limit`, `codex-io-error`,
`codex-no-completion`, `codex-usage-invalid`, and `codex-usage-unavailable`.
Error messages identify the evidence directory. Execute abort returns no model
result; the existing controller records mechanical recovery and preserves the
attempt ref. It must not manufacture a successful partial result.

`resume` retains ccloop's existing recovery eligibility and ownership rules. It
does not resume a Codex native session or implement the future per-task handoff
protocol. This slice also does not implement Orca's Web UI, task groups, or group
budget ledger. Claude remains the first long-term adapter priority; its live test
is deferred until separate human approval after quota is available.
