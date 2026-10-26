# ccloop

A **loop controller at L2 autonomy**: you write a **contract** that states the goal, the boundaries and the acceptance
criteria, and ccloop runs *plan → execute → verify* until the run reaches a terminal state, writing its state and
evidence to disk as it goes.

It does not write code and does not decide what is right — the **adapter** (a child process, usually `claude -p`) does
the work. ccloop owns the loop, the budget, isolation, crash recovery, ownership arbitration and the evidence trail.

> **Status**: V1, `private: true`, not published to npm. macOS and Linux only.

---

## 1. Mental model

```
contract.json ──▶ ccloop run ──▶ ┌──────────────────────────────┐
                                 │  attempt N                   │
                                 │   plan → execute → verify    │──▶ approved? ──▶ succeeded
                                 │   (in its own git worktree)  │        │
                                 └──────────────────────────────┘        └──▶ next attempt
                                              │
                                        written to runDir/ throughout
```

Three separations:

| Who | Owns |
|---|---|
| **contract** | Goal, boundaries, budget, acceptance criteria. A person writes it; the machine never edits it. |
| **controller** (ccloop itself) | The loop, budget accounting, worktree isolation, the state machine, leases and ownership, resuming after a crash. |
| **adapter** | One phase's execution. Reads a JSON request on stdin, writes a JSON result on stdout. |

**The controller never pushes, never merges and never deletes a branch.** Those are the person's acts.

---

## 2. Install

```bash
cd /path/to/ccloop
npm install
npm run build          # produces dist/cli.js
```

Then either run it directly, or use the development path (no build):

```bash
node dist/cli.js <command> ...
npm run dev -- <command> ...      # tsx src/cli.ts
```

`npm link` puts a global `ccloop` on PATH (`package.json` already declares `bin`).

As an Orca dependency, Orca pins a commit through a git URL (`"ccloop": "github:blrbiran/ccloop#<commit>"`). npm
installs devDependencies and runs `prepare` (that is, `npm run build`) inside a temporary clone, then packs only what
`package.json`'s `files` lists — so besides `dist/`, the runtime-read `scripts/claude-phase-runner.mjs` and the
`scripts/claude-stream.mjs` it imports must stay in `files` (`tests/packaging/gitDependency.test.ts` guards this). Side
effect: `npm install` in this repository also builds once.

Self-check:

```bash
npm run typecheck
npm test              # vitest run
```

---

## 3. Commands

| Command | What it does | Exit codes |
|---|---|---|
| `run` | Start a new loop from a contract | `0` succeeded / `2` any other terminal state / `1` bad arguments or load failure |
| `resume` | Adopt an interrupted run and continue from the state on disk | same as `run` |
| `ls` | Scan every run under a root and report **observed** fields | `0` / `1` (the root itself cannot be read) |
| `sweep` | Continue in bulk: scan, pick the runs observed as `eligibleForContinuation=true` and runs killed outright (no `owner-transfer.json`, a resumable state, an expired lease — §3.4), adopt each one | `0` / `1` |
| `unlock` | Deal with a stuck owner-transfer lock | `0` no lock remains / `1` any refusal |
| `agents` | Detect installed agent CLIs, validate a table, list an installation's models (§6.1) | `0` / `1` |
| `control` | The JSON-over-stdio boundary an external controller uses (§7) | `0` answered / `2` named protocol or agent refusal / `1` malformed input or handler failure |

### 3.1 `run`

```bash
node dist/cli.js run \
  --contract        examples/v1/minimal-contract.json \
  --run-dir         /tmp/ccloop-runs/task-1 \
  --agents          /abs/private/agents.json \
  --agent-selection /abs/private/selection.json
```

All four flags are **required**, with no defaults. `--agents` is the agents table (which CLIs are installed, where, at
what version); `--agent-selection` is this run's agent and model together with its `configHash`. §6.1 shows where both
files come from.

`run --agents` **freezes** the validated selection into `<runDir>/agent-selection.json` (`0600`; it refuses an existing
one and never overwrites). Afterwards `resume` and `sweep` take no `--agent-selection`: they rebuild the adapter from
that frozen selection against the **then-current** agents table. A changed configuration for that selection (kind,
`configDir`, the kind's own fields, or the selection; the hash no longer matches) or an upgraded CLI (version drift) is
refused before the run directory is touched.

⚠️ `--run-dir` must be **clean**: if it already holds `loop-state.json`, `events.jsonl` or a non-empty `worktrees/`,
`run` exits with an error; a leftover `agent-selection.json` (for example from a `run --agents` that froze it and then
failed) is refused too, exit 1, code `agent-selection-exists`. V1 cannot re-initialise an existing run — use `resume`.

### 3.2 `resume`

```bash
node dist/cli.js resume \
  --run-dir /tmp/ccloop-runs/task-1 \
  --agents  /abs/private/agents.json
```

No `--agent-selection` (the run's frozen copy is used; a directory without one — not started by `run --agents` — is
refused) and no `--contract` (the contract already sits in the run directory). Checks run in order, and any failure
refuses:

- The lease is still fresh (its owner is renewing it) ⇒ refused.
- The run directory is a control run in an Orca control store (`<dir>/run` with a sibling `control/`) ⇒ refused; Orca
  recovers those itself.
- A run in `verify-saved-result` mode is refused (`saved-result-controller-resume-required`); its controller continues
  it.
- A run without `owner-transfer.json` (the process was killed; nobody handed over) whose state is resumable
  (planning / executing / verifying): **first** confirm the old owner process is dead. A live owner, or one that cannot
  be shown to be dead, is refused — and at that point **no process group has been reaped**.
- Claude / codex process groups registered by the run that have not ended (on both paths, with or without a transfer):
  reap (terminate) them; a group that cannot be reaped or identified is refused, and the refusal names the call
  directory at fault. Each reaped group records an `orphan_process_group_reaped` event.
- Once reaping succeeds, a run without a transfer has `resume` write its own owner-transfer and reconciliation records
  and take over (`owner_crash_adopted`, then `resume_adopted`). A run that already has a transfer skips this step and
  the owner-liveness check; only the lease matters.
- Then as always: the eight continuation-eligibility checks, the claim, and the loop continues.

What Ctrl-C does: one Ctrl-C (or SIGTERM) lets the loop stop at the next phase boundary, then releases the lease and
exits; a second Ctrl-C exits at once with code 130 without releasing the lease. Either way, a resumable run can be
adopted by `resume` once its process is gone and the lease has expired (`kill -9` behaves the same). The claude runner
exits on its own about 5 seconds after its parent dies (codex has no such guard); a process group still left over is
reaped by `resume`. No test pins the single-Ctrl-C lease release.

### 3.3 `ls`

```bash
node dist/cli.js ls /tmp/ccloop-runs           # a table for a person
node dist/cli.js ls --json /tmp/ccloop-runs    # machine-readable: {schemaVersion:1, rows:[...]}
```

Every row is an **observation**, not a verdict. The consistency notice in the header is part of the contract:

> The fields in one row are independent observations and do **not** form a consistent snapshot; `eligibleForContinuation`
> is an observed field, **not** the conclusion "this run can be continued".

Take that sentence seriously when reading `ls`: it is the design, not a disclaimer.

### 3.4 `sweep`

```bash
node dist/cli.js sweep \
  --root     /tmp/ccloop-runs \
  --agents   /abs/private/agents.json \
  --max-runs 5
```

Each picked run builds its adapter from **its own** frozen `agent-selection.json`, so one sweep may continue runs of
different agents.

- `--max-runs` must be a **literal positive integer** (`1e3` and `2abc` are refused; no forgiving parse). It is the
  person's ceiling for this sweep.
- It bounds the **number of runs entered**, not attempts: each run still has its own contract's `maxAttempts`.
- Two kinds of candidate. (a) `eligibleForContinuation` is observed as `true` in `owner-transfer.json`; the banner
  counts only these as before. (b) A run killed outright: no `owner-transfer.json`, state `planning` / `executing` /
  `verifying`, and `leaseAffirmedAt` older than `LEASE_TTL_MS` (`null` does not count; Orca control runs do not count).
  For (b), when K > 0, one extra line is printed: `sweep: <K> run(s) under <root> have no owner-transfer.json, a
  resumable status and an expired lease (observed fields; each is resumed only if its owner is confirmed dead)`. (b) is
  only a filter over observed fields; whether the owner is really dead is decided by `resume`, which refuses if it is
  alive.
- The order is fixed: read the agents table first (unreadable ⇒ exit 1, no run scanned), then scan, then print the
  banner, then build adapters one run at a time (a run whose adapter cannot be built reports `refused`).

### 3.5 `unlock`

```bash
node dist/cli.js unlock /tmp/ccloop-runs/task-1                       # deletes only a lock it can prove dead
node dist/cli.js unlock /tmp/ccloop-runs/task-1 --force --expect <sha256>
```

`--force` **requires** `--expect <sha256 of the lock file>`; the argument parser enforces this (a "force without a
digest" state cannot be expressed). The reverse is refused too: `--expect` without `--force` is an error, never silently
ignored.

Every refusal exits 1 (fail closed).

### 3.6 `agents`

```bash
node dist/cli.js agents detect [--home <dir>] [--path <PATH>]
node dist/cli.js agents validate /abs/private/agents.json
node dist/cli.js agents models --agents /abs/private/agents.json --installation <id> [--refresh]
```

`detect` looks for codex, claude and omp on PATH and in the usual install locations and prints a draft table to stdout
only (it writes no file; `candidates` lists what it saw and refused to pick). `validate` probes every installation's
version and exits 1 if any entry drifted. `models` lists one installation's model catalog (a miss or a failed probe is
printed on stderr as `ccloop-agent-catalog: …`).

---

## 4. Stopping a running loop

`SIGINT` / `SIGTERM`:

- **First**: set the stop flag; the loop exits cleanly at the **next boundary**, with state and evidence fully on
  disk.
- **Second**: exit immediately with code `130`.

Both signals share one counter, so the common escalation "Ctrl-C, then kill" really reaches the second level.

---

## 5. Writing a contract

The schema is `src/contract/schema.ts` (zod, `.strict()` — **one extra field rejects the whole file**). A complete
example is `examples/v1/minimal-contract.json`. Six required blocks:

```jsonc
{
  "objective": {
    "taskId": "example-1",
    "goal": "…",                  // what must be achieved
    "successCondition": "…",      // what counts as done
    "nonGoals": ["…"]             // what must not be done
  },
  "context": {
    "repoPath": ".",              // the worktree is opened from this repository
    "targetPaths": ["src"],       // at least one
    "relevantDocs": [],
    "buildTestCommands": ["npm test"],   // at least one
    "constraints": ["smallest possible diff"]
  },
  "executionPolicy": {
    "autonomyLevel": "L2",        // V1 accepts only "L2"
    "maxAttempts": 3,
    "perAttemptTimeoutMs": 300000,
    "totalRuntimeBudgetMs": 900000,
    "tokenBudget": 200000,        // null = no token ceiling
    "worktreeRequired": true,     // V1 accepts only true
    "partialOutcomeRecoveryWindowMs": 1000   // after execute is aborted, how long it may still emit a partial result
  },
  "safetyPolicy": {
    "allowlistPaths": ["src/**"],
    "denylistPaths": [".env", "auth/**"],
    "maxFilesTouched": 10,
    "humanGateConditions": ["touches gated path"]
  },
  "verification": {
    "verifierType": "agent",      // "command" | "agent"
    "requiredChecks": ["…"],      // at least one
    "rejectOn": ["tests fail"],   // at least one; handed to the verifier. ccloop does not grep evidence for it. Under a command verifier it has no effect — write a check command instead (for example ! grep -q 'tests fail' out.log)
    "evidenceRequired": ["command output"]
  },
  "escalationAndExit": {
    "escalationTargets": ["human"],
    "pauseOn": ["missing information"],
    "stopOn": ["budget exhausted"],
    "terminalStates": [ /* must be exactly the five below */ ]
  }
}
```

**Terminal states (five, a fixed set)**:

| Terminal state | Meaning |
|---|---|
| `succeeded` | Verification passed |
| `blocked_waiting_human` | A person must decide; the loop stopped on purpose |
| `exhausted` | Budget (attempts / time / tokens) ran out |
| `cancelled` | A stop signal cancelled it |
| `failed` | It failed |

`terminalStates` must contain and **only** contain these five — too few, too many or a duplicate is a schema error. This
is not a setting: it makes V1's whole set explicit in every contract.

### 5.1 Several repositories

A run may work in more than one repository (a multi-directory group). `context` then carries `repoKey` **if and only
if** it carries `additionalRepos`:

```jsonc
"context": {
  "repoPath": "/path/to/alpha",
  "repoKey": "alpha",
  "targetPaths": ["."],
  "buildTestCommands": ["true"],
  "additionalRepos": [
    { "key": "beta", "repoPath": "/path/to/beta", "targetPaths": ["."],
      "allowlistPaths": ["."], "denylistPaths": [], "requiredChecks": ["true"] }
  ]
}
```

- `repoPath` is the primary; `repoKey` names it in prompts, evidence and `collect`.
- 1 to 7 extras (8 repositories in all). Every key is unique and differs from `repoKey`, and each matches
  `^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$`.
- `targetPaths` has at least one entry. `allowlistPaths`, `denylistPaths` and `requiredChecks` are optional per extra
  repository.
- Each extra repository gets its own worktree, its own path policy and its own attempt commit; §8 lists the files.

A contract without these fields is byte-identical to before.

### 5.2 Tool rules

`executionPolicy.toolRules` is optional and strict at every level:

```jsonc
"toolRules": {
  "commands": [{ "kind": "prefix", "value": "npm test" }],
  "network": false,
  "secretEnv": ["DEPLOY_TOKEN"]
}
```

`commands` (at most 64) closes the set of shell commands an adapter may run; `kind` is `exact` or `prefix`. A value
containing a shell separator (`&`, `|`, `;`, a newline or a carriage return) is refused, because a compound command
cannot be one rule. `network` is a boolean; `secretEnv` names at most 32 environment variables. The mapping to each
agent is never wider than the rule, and a rule a kind cannot enforce is reported as `detected`, `recorded-only` or
`refused` rather than silently accepted. When the contract has rules and the run wrote `run/tool-rules.json`, `collect`
returns it as `toolRules`.

---

## 6. Agents and adapters

The adapter contract (`src/runtime/types.ts`) has three phases: `plan` / `execute` / `verify`. ccloop sends one JSON
request on stdin and reads one JSON result from stdout.

### 6.1 The agents table and the selection file: the CLI's only entry

> Consolidation step 4 (2026-10-01) removed `--adapter` / `--adapter-config`. `run` / `resume` / `sweep` with either one
> exits 1 with `unknown flag --adapter` (or `--adapter-config`) — like any other unknown flag, with no special hint.
> `--agents` is the only form today.

The agents table (`ccloop-agents-table-v1`) records which agent CLIs are installed. Detect them, keep the entries you
want in a file, then validate it:

```bash
node dist/cli.js agents detect                            # draft: {"schema":"ccloop-agents-detect-v1","table":{...},"candidates":[...]}
node dist/cli.js agents validate /abs/private/agents.json  # does each installation's --version still match the table?
```

The table must be an **absolute path that is its own realpath** (on macOS write `/private/tmp`, not `/tmp`), owned by
you, with the file and its directory not group- or world-writable. A codex installation looks like this:

```json
{ "schema": "ccloop-agents-table-v1",
  "installations": { "codex": {
    "kind": "codex", "command": ["/abs/path/to/codex"], "version": "0.155.1", "configDir": null,
    "timeoutMs": 120000, "killGraceMs": 250, "sandbox": "workspace-write", "budgetMode": "soft" } } }
```

The selection file is `{"selection": {...}, "configHash": "<64 hex>"}`. Ask ccloop for both; do not compute them:

```bash
echo '{"agent":{"agent":"codex","model":"<model>"}}' \
  | node dist/cli.js control capabilities --agents /abs/private/agents.json
# copy the answer's selection and configHash verbatim into the selection file
```

At `run`, ccloop recomputes both against the table it has: a version mismatch is `agent-version-drift`, a hash mismatch
is `control-config-hash-mismatch`, and both happen before the contract is read or the run directory touched.

### 6.2 `scripted` — tests only

`ScriptedAdapter` (`{ "frames": [ { "plan": {...}, "execution": {...}, "verification": {...} } ] }`, one frame per
attempt) still exists as a library class: tests construct it and pass it to `runLoop` / `resumeLoop`. The CLI cannot
select it: `examples/v1/scripted-adapter-config.json` went away with `--adapter`.

### 6.3 `claude` — real runs

claude is reached only through `run --agents <table> --agent-selection <file>` (and the `resume` / `sweep --agents`
that follow) or `control`. `ClaudeAgentAdapter` (`src/runtime/claude/claudeAgentAdapter.ts`) starts one
`scripts/claude-phase-runner.mjs` child per phase: JSON request on stdin, JSON result on stdout.

The bundled runner is the reference implementation. It:

- runs `claude -p --output-format stream-json --verbose --include-partial-messages --json-schema <phase schema>
  <prompt>` in `request.worktreePath`, with a JSON Schema constraining the model's output;
- collects the files this attempt actually changed and the diff with `git status --porcelain=v1 -z
  --untracked-files=all` plus `git diff` — **it does not trust the model's own report**;
- extracts token counts from claude's `usage` (accepting both `input_tokens` and `inputTokens`) and records a missing
  field, a wrong type and a non-finite number as distinct observations instead of quietly reading 0;
- on `SIGTERM` / `SIGINT`, tries to emit a partial result with `completionStatus: "partial"` within
  `partialOutcomeRecoveryWindowMs`.

The runner is fixed: `ClaudeAgentAdapter` always starts this file. The only configurable part is the installation's
`command` — the claude CLI the runner calls.

### 6.4 `codex` — real runs

The codex adapter uses the installation's `sandbox` (`read-only` or `workspace-write`) and accepts only
`budgetMode: "soft"`; codex budget enforcement is soft, and ccloop does not claim a strict token cap. Each phase runs
in the installation's private homes.

- A call rejected with a 429 **before any work** is tried again after 30 s, 60 s and 120 s, within the phase's time
  limit; each call keeps its own evidence directory and a rejected one also records `rate-limit.json`.
- A provider 5xx or a network failure is retried only for a read-only phase (plan, verify) or for a call that observed
  no work. The contract's `perAttemptTimeoutMs` bounds the whole phase, not each try.
- An execute phase must answer in the strict `{ "result": … }` envelope whose `result` passes the execution union; plan
  and verify use their own phase schemas. Only an established strict execute envelope owns an opaque report subtree.
- **Single calls** bring their own JSON Schema, and the codex provider accepts strict schemas only: every object closed,
  every property in `required`, an optional property spelled `anyOf: [schema, null]`. ccloop projects the caller's
  schema on the wire and removes the nulls it added, guided by the caller's own schema; the call's schema, prompt hash
  and answer validation are unchanged. A schema strict mode cannot express (a free-form object, `oneOf`, `allOf`, `not`,
  `$ref`, `$defs`, `patternProperties`) is refused **before the spawn** with
  `codex-single-call-schema-unsupported:<path>:<reason>`.

### 6.5 `omp` — one restricted call per phase

An OMP installation accepts one absolute executable and no preset arguments. The model name comes from **that
installation's own configuration**: `agents detect` reads the effective `modelRoles.default` and the model catalog and
writes only an exactly and uniquely resolved `provider/model`; default model names are not shared across machines. A
hand-written entry is allowed, for example:

```json
{ "schema": "ccloop-agents-table-v1", "installations": { "omp": {
  "kind": "omp", "command": ["/abs/path/to/omp"], "version": "<detected-version>",
  "configDir": "/abs/private/omp-agent", "profile": null,
  "defaultModel": "your-provider/your-model", "timeoutMs": 120000, "killGraceMs": 5000
} } }
```

`configDir` and a named `profile` are alternatives; with a profile, set `configDir` to `null`. Versions and catalogs
come from the machine's own detection. Updating an existing installation's version or path must still resolve its
**frozen exact model**, otherwise the preview marks it unselectable and Apply checks again and refuses drift.

Each plan / execute / verify is a separate OMP print call. ccloop passes the phase's system prompt, with extensions,
skills and sessions off; plan and verify may only read / grep / glob, while execute may also edit / write / bash. Even
if OMP tends to finish the whole task, it must stop after this phase's JSON answer: extra continuation, a disabled tool
or a model switch in the event stream is refused. plan and verify are refused if they move HEAD or a git-visible file;
execute is refused if it commits on its own or moves HEAD. Execute's self-reported `changedFiles` must match the
git-visible changes exactly, rename sources and targets included, and only then is the path policy applied.

OMP usage is the sum of input, output, cacheRead and cacheWrite of every complete assistant message; an interrupted call
with only partial messages leaves usage unknown, and the lower bound is not reported as a known total. A zero-cost
field from the proxy does not mean the model was free. The first round uses a restricted CLI plus isolated acceptance:
git-ignored files and host side effects outside the worktree still need outer isolation; this is not a full sandbox.
OMP's syncskill injection goes through `ompSkillsDir`: ccloop keeps OMP's own skill discovery off and lists each
snapshot skill's name, one-line description and absolute `SKILL.md` path in every phase's system prompt, for the model
to read on demand; an invalid snapshot fails before OMP starts with `omp-skills-source-invalid:<detail>`.

OMP's **single call** (estimate / clarify / split) needs a catalog row that declares the `maxTokens` cap pi-ai sends,
and whose provider is not `openrouter` (pi-ai sends no cap there unless one is given explicitly). Such a row reports
`singleCallExecution: "v1"`; any other row reports `null`, and the call is refused as `omp-single-call-unavailable`. The
call re-reads the catalog inside its own deadline, and a row whose cap exceeds the caller's `maxOutputTokens` is refused
before the spawn (`omp-single-call-cap-exceeded`).

### 6.6 Prompts

`src/runtime/claude/prompts.ts` generates the three phase prompts mechanically from the contract. Two hard rules are
worth naming:

- The executor prompt says **"Never declare final success; only report what changed in this attempt."** Deciding
  success belongs to the verifier.
- The verifier prompt injects `rejectOn` and `evidenceRequired` verbatim and requires "missing evidence means
  `approved: false`".

---

## 7. The control protocol

`control` is a local JSON-over-stdio boundary for an external controller such as Orca. The authoritative definitions are
in `src/control/protocol.ts`; `docs/control-protocol-v1.md` is the published v1 description. Orca starts runs with a
protocol 3 envelope.

```bash
echo '{}' | node dist/cli.js control features
echo '{"agent":{"agent":"codex","model":"<model>"}}' \
  | node dist/cli.js control capabilities --agents /abs/private/agents.json
```

- The method is an argument: `control <method> --agents <table>`. `features` is the one method that takes no table
  (`control features`), because it must answer even when the table is broken.
- Stdin holds exactly one JSON value (the method's strict payload; the method name is not repeated). A successful
  response is one compact JSON value and a newline; diagnostics go to stderr only.
- Exit codes: `0` the response passed its method's response schema; `2` a named protocol or agent refusal (for example
  `control-request-invalid`, `control-method-unavailable`, `agent-version-drift`); `1` malformed CLI/JSON, IO failure,
  handler failure or an invalid handler response.

### 7.1 Methods

| Method | Payload | Answers |
|---|---|---|
| `features` | `{}` | `{"protocol":1,"tokenPolicy":"optional-v1","savedResultRecovery":"v1","agentInstallationUpdate":"v1","transcripts":"v1"}` |
| `capabilities` | `{"agent": <selection or null>}` | the protocol and capability record, including the selection and `configHash` |
| `models` | `{"installation": <id>, "refresh": <bool>}` | that installation's model catalog |
| `agent-installation-observe` / `-preview` / `-apply` | observation, preview, or apply request | what the installation is, a proposed change, and a receipt |
| `accept` | a start envelope | `absent`, `accepted` (execution id and sealed config hash), `unknown`, or `stopped` (with evidence) |
| `inspect` | a start envelope | the same execution status |
| `handoff` | `{"input": <envelope>, "request": <handoff request>}` | `latched` or `complete` |
| `collect` | `{"input": <envelope>, "afterSeq": <n>}` | new usage events, candidate, terminal state, progress, and the optional fields in §7.3 |
| `read-evidence` | `{"input": <envelope>, "ref": <artifact ref>}` | the referenced bytes, base64 |
| `task-results` / `read-task-result-evidence` | an envelope (and a ref) | the task result read model and its evidence |
| `saved-result-*` | see `src/control/protocol.ts` | source eligibility, settlement, evidence |

### 7.2 What the start envelope may carry

Besides the contract, target, base and source directory:

- `priorFailures` — up to three earlier failures, oldest first, for this run's plan and execute.
- `operatorNote` — the person's note for **plan and execute only** (verify never gets it). `text` is 1–4096 UTF-8
  bytes; `scope` is `next-attempt` or `remaining-attempts`. `remaining-attempts` reaches every attempt. `next-attempt`
  reaches the first attempt this run plans or executes; a continuation that resumes at verify passes it on to the next
  attempt, because the resumed attempt's plan and execute do not run again.
- `additionalRepos` — one `{key, targetRepo, base}` per extra repository, in contract order. When present, its keys are
  exactly the contract's `additionalRepos` keys.
- `skillPluginDir` (claude), `codexSkillsDir` (codex) or `ompSkillsDir` (omp) — at most one; an invalid snapshot or a
  kind mismatch is refused before anything is persisted.

A saved-result recovery (`mode: "verify-saved-result"`) builds no prompt, so it takes neither `priorFailures` nor an
operator note.

### 7.3 What `collect` adds

Top-level fields, each absent when it does not apply, so a caller that predates them sees no new bytes:

- `decisions` and `debug` — what the collected candidate's attempt reported, carried opaquely.
- `flow` — Orca's flow-step report, read the same way.
- `failureCause` — why the run failed or was exhausted, present iff there is a terminal state that carries one.
- `toolRules` — the run's tool-rule report, present iff the contract has rules and `run/tool-rules.json` exists.
- `transcripts` — one entry per agent call (§7.4).
- `dirs` — one entry per extra repository, in contract order: `{key, resultRepo, changedPaths, attemptSha}`.
  `changedPaths` is ccloop's own observation of the current attempt (`[]` before there is one); `attemptSha` is null
  before the attempt is published, and after a crash resume (which writes no `commits.json`).

### 7.4 Live transcripts

Each adapter call writes `transcript.jsonl` in its own evidence directory, capped at 128 MiB per call (an oversized or
unterminated line is replaced by a marker line). `collect` lists calls as `{attempt, phase, seq, path, bytes, final,
truncatedAt}`: `path` is relative to `<sourceDir>/run`, `seq` is the call's 1-based order within its phase, `truncatedAt`
names the byte at which recording stopped, and `final` means the call wrote `outcome.json`, the run is terminal, or a
stop proof exists — so a call whose worker died does not read as live forever. Listing never follows a symlink and never
leaves the run directory. ccloop does not copy the bytes: the caller reads the file itself.

---

## 8. The run directory

After a run finishes, the run directory looks like this (`agent-selection.json` is written by `run --agents`):

```
<runDir>/
├── loop-contract.json      # a copy of the contract — so resume needs no --contract
├── agent-selection.json    # the selection run --agents froze (0600) — resume/sweep rebuild the adapter from it
├── loop-state.json         # state-machine snapshot (atomic write)
├── owner-record.json       # ownership: epoch, process instance id, last lease renewal
├── owner-transfer.json     # only when ownership was handed over
├── events.jsonl            # append-only event stream, one event per line
├── attempts/
│   └── 1/
│       ├── plan.json           # plan phase output
│       ├── execution.json      # execute phase output
│       ├── verify.json         # verify phase output (approved / evidence)
│       ├── diff.patch          # this attempt's actual diff
│       ├── commits.json        # every published attempt commit, primary first (multi-repo runs)
│       ├── dirs.json           # each extra repository's observed changed paths (multi-repo runs)
│       └── stdout-stderr.log
├── run/
│   ├── tool-rules.json         # only when the contract has toolRules
│   ├── <kind>/<attempt>/<phase>/call-*/   # each call's evidence, transcript.jsonl included
└── worktrees/                  # empty after a normal run, see below
```

`events.jsonl` looks like this:

```jsonc
{"type":"loop_planning","at":"…","detail":"run initialized and ready to plan"}
{"type":"attempt_started","at":"…","detail":"attempt 1"}
{"type":"execute_started","at":"…","detail":"attempt 1"}
{"type":"execution_finished","at":"…","detail":"attempt 1"}
{"type":"loop_succeeded","at":"…","detail":"success condition satisfied"}
```

**About `worktrees/`**: each attempt opens a detached worktree at `worktrees/attempt-<n>/` (`git worktree add --detach`
with `context.repoPath` as cwd) and, when the attempt ends, ccloop removes it with `git worktree remove --force`. A
normal run therefore leaves this directory empty; anything left there means an attempt did not finish cleaning up. The
main worktree is never touched (measured: after a run, `git worktree list` in the source repository gains no entry).

### Attempt commits: before the worktree goes away, the work is committed and pinned to a ref

Before `git worktree remove --force`, ccloop runs `git add -A` and commits the attempt worktree, then writes a ref so
the commit stays reachable after the worktree is gone:

```
refs/ccloop/<run-id>/attempts/<n>
```

`<run-id>` is the basename of the run directory and `<n>` matches the `attempts/<n>/` artifact directory. An attempt's
**base is the first parent of that commit**, so to see what an attempt changed:

```bash
git for-each-ref --format='%(refname) %(objectname)' 'refs/ccloop/<run-id>/attempts/'
git diff --name-only <sha>^ <sha>
```

**An attempt that changed nothing still gets a commit** (`--allow-empty`). So "**a ref with an empty diff**" means the
agent did nothing, and "**no ref**" means publishing failed — they are not the same thing, and the latter leaves
`attempt_commit_publish_failed` in `events.jsonl`. **Publishing success records no event**: the ref is the artifact,
and `git for-each-ref` already answers "was it published?"; one more line would only repeat it.

The identity is passed explicitly with `-c user.name=ccloop -c user.email=ccloop@invalid`, never taken from the
environment's git config — a one-off clone or a CI container often has none, and that is exactly where this feature
matters most.

`attempts/<n>/diff.patch` is **unchanged, byte for byte**; it remains evidence for a person. It is **not** the
machine-readable copy: both of its `git diff` calls lack `--binary`, and `readGitDiff`'s catch returns stdout only for
`code === 1` and an empty string for everything else.

In a multi-repo attempt, each extra repository is committed and pinned the same way under its own key; `commits.json`
lists every published commit, primary first.

**Known costs** (not bugs; the price of this design):

- **Refs accumulate.** One ref per attempt; ccloop **does not** clean them up — deleting a ref is irreversible and needs
  a person's separate authorization. After many runs, `git for-each-ref refs/ccloop/` gets long.
- **The object store grows.** An attempt's changes used to vanish with its worktree; a ref now holds them, so `gc` will
  not collect them.
- **Git-ignored files do not go in.** `git add -A` respects `.gitignore`.
- **Temporary files do go in.** Anything the agent left in the worktree becomes part of that commit. `diff.patch`
  already collected those too, so this is not new, but it is worth knowing.

`RunState` in `loop-state.json`:

```ts
{
  status,               // queued | planning | executing | verifying | one of the five terminal states
  currentAttempt, attemptsUsed, lastTransitionAt,
  waitingOnHuman, stopReason,
  budgetSnapshot: { attemptsRemaining, timeRemainingMs, tokenBudgetRemaining },
  recentFailures: [{ rejectCategory, primaryTargetPaths, failingCommand }]
}
```

The triple in `recentFailures` is a **failure fingerprint**: the loop recognises "stuck in the same place" by it, not
by comparing prose.

---

## 9. Ownership and leases (why this code is heavy)

Several ccloop processes may see the same run directory at once (two sweeps, or a resume meeting a live run). ccloop
handles it like this:

- **Lease + heartbeat**: the run's owner keeps renewing its lease; only after the heartbeat stops may another process
  take over.
- **owner-transfer lock**: taking over is a cross-process locked transaction (acquire → recover → three renames →
  release), not a "whoever writes first wins".
- **fail closed**: a lock it cannot read makes it throw and stop rather than pretend the lock is dead and delete it.
  `unlock --force` requires a person to supply the lock file's sha256 — **a person confirmed that this lock is that
  lock**.

If you run one run in one process, you never notice any of this. It exists because, under concurrency, quietly stealing
a live run costs data loss.

---

## 10. One run end to end (codex)

⚠️ **The CLI has no way to run without calling a model.** It used to be `--adapter scripted`, removed with consolidation
step 4 (2026-10-01). The test suite spends nothing because it points the agents table's `command` at a fake codex
(`tests/fixtures/fake-codex.mjs`) — a test fixture, not a production path for users. The command below really calls
codex; **make sure you can afford its token spend first**.

```bash
npm install && npm run build
PRIV=$(cd "$(mktemp -d)" && pwd -P)       # the table must be on its own realpath
RUN_DIR="$PRIV/runs/run-1"

node dist/cli.js agents detect             # keep the codex entry as "$PRIV/agents.json" (see §6.1)
chmod 600 "$PRIV/agents.json"
echo '{"agent":{"agent":"codex","model":"<model>"}}' \
  | node dist/cli.js control capabilities --agents "$PRIV/agents.json"
# save the answer's selection and configHash as "$PRIV/selection.json": {"selection":…,"configHash":…}

node dist/cli.js run \
  --contract examples/v1/minimal-contract.json \
  --run-dir "$RUN_DIR" \
  --agents "$PRIV/agents.json" \
  --agent-selection "$PRIV/selection.json"
echo "exit=$?"        # expect 0

cat "$RUN_DIR/loop-state.json"          # status should be succeeded
cat "$RUN_DIR/events.jsonl"
ls  "$RUN_DIR/attempts/1"               # plan.json execution.json verify.json diff.patch …
cat "$RUN_DIR/agent-selection.json"     # the selection run --agents froze; resume/sweep uses it
node dist/cli.js ls "$(dirname "$RUN_DIR")"
```

A `--run-dir` that does **not** exist yet is fine; ccloop creates it.

⚠️ `minimal-contract.json` has `context.repoPath` set to `"."`, so run this inside a **git repository**, otherwise `git
worktree add` fails.

To use claude instead: add a claude installation to the table and change `agent` in the selection file to its id
(§6.3).

---

## 11. Known limits

- **V1 cannot `run` again on an existing run directory** — only `resume`.
- **The contract schema is `.strict()`**: one extra field rejects the whole file. That is deliberate.
- **`ls` reports observations, not conclusions.** Do not read `eligibleForContinuation=true` as "safe to continue".
- **ccloop does not estimate cost.** It records the usage an adapter reports; when there is none it records "not
  available" rather than guessing.
- The whole suite is currently green on macOS; **Linux has known failures** — see `docs/handoff/handoff.md`.

---

## 12. More material

| What you want | Where |
|---|---|
| Current progress, open items, past rulings | `docs/handoff/handoff.md` (entry point), `.superpowers/sdd/**/progress.md` (source of truth) |
| Design and plan for each feature | `docs/superpowers/specs/`, `docs/superpowers/plans/` |
| The control protocol | `src/control/protocol.ts`, `docs/control-protocol-v1.md` |
| The codex adapter | `src/runtime/codex/`, `docs/codex-adapter.md` |
| Background on loop engineering | `docs/ref/LoopEngineering.md`, `docs/ref/loop-how-to-stop.md` |
| This repository's collaboration rules | `CLAUDE.md` |
