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


## Isolated acceptance — 2026-09-19

`node scripts/validate-codex-adapter.mjs --codex <absolute-bin> --model <name> --output <new-dir>`
creates a fresh repository without remotes. It allows one attempt, 120 seconds per
phase, 360 seconds total, and a 420 second outer watchdog. Its 100,000-token
budget is soft. Existing output directories are refused; there are no retries.
The outer watchdog records process identities and cleans registered detached
Codex groups before the controller group.

Structured Outputs disallows a root `anyOf`; execute therefore uses the wire
shape `{"result": <complete-or-partial-result>}`. The adapter validates this
strict wrapper and the business result separately. The original phase schema
and controller result types remain unchanged.

One real run used codex-cli 0.155.1 and the user's configured `gpt-6-astra`.
Evidence is retained at `/tmp/ccloop-codex-live-20260919-01`.
All three processes exited 0; ccloop status was `succeeded`; the published Git
answer is bytes `34 32 0a`; watchdog unresolved list is empty.

| Phase | Input | Output | Total |
| --- | ---: | ---: | ---: |
| plan | 20,528 | 77 | 20,605 |
| execute | 42,893 | 329 | 43,222 |
| verify | 63,999 | 400 | 64,399 |

Total reported usage: 128,226 tokens; soft-budget overrun: 28,226. Dollar cost:
unknown. The first-phase observation F is 20,605 for this configuration/run;
it is not a universal per-call estimate or an Orca strict-cap measurement.

The original harness returned 1 because it incorrectly compared the controller's
zero-clamped remaining budget with a negative number. That evidence is preserved
in `summary.json`. A new offline regression reproduced the defect and the harness
now compares against `max(0, budget - usage)` while reporting the full overrun.
`offline-audit.json` independently checks the retained raw usage and Git artifact.
No second model run was made; this is a functional live result with a corrected
offline accounting audit, not a fresh live run of the corrected harness.

The inherited CLI configuration emitted warnings about skill-description
truncation, an unknown feature key, plugin icon paths and Figma MCP authorization.
These did not stop the three phases. No configuration, hooks, or trust rules were
disabled for acceptance. Claude live acceptance remains separately pending.


### Native final review — 2026-09-19

Three review findings fixed: reject FIFO final output without blocking; normalize historical process start-time whitespace; continue registered-process cleanup when observation persistence fails while retaining the error. All three have RED→GREEN regression tests. Final offline suite: 45 files / 706 tests; typecheck and build pass. Affected mutation checks fail at behavior assertions and restore the clone to zero tracked/cached diff. Corrected acceptance harness has not been rerun against a live model; the original live result and separate offline audit above remain distinct.
