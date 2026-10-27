# Per-contract tool rules (`executionPolicy.toolRules`) — design

- **Author:** spec writer subagent invoked from Orca session `8b1469ea` (2026-10-22). Not committed by the writer.
  Revised once after an independent review (same session; review items C1, I2–I8 and minors applied in place — the text
  was never committed or published, so in-place correction is allowed, CLAUDE.md Rule 16).
- **Status:** design; not planned. Anchors measured with `grep -n` / `sed -n` at ccloop main `2a2ae53`; re-measure before a
  plan cites them (CLAUDE.md Rule 14).
- **Why (consumer requirement):** Orca spec `Orca/docs/superpowers/specs/2026-10-22-flow-engine-design.md`
  - §3.2 row `step tools`: `{commands?: [{exact} | {prefix}], network?: bool (default false), secrets?: [ENV_NAME]}`, passed
    to ccloop as per-contract tool rules; absent = today's behaviour; required checks always allowed in addition.
  - §16.2: ccloop's work contract gains optional `executionPolicy.toolRules = {commands: [{kind: "exact" | "prefix",
    value}], network: boolean, secretEnv: [name]}`; absent ⇒ today exactly; **never widen**; **report status per rule**:
    `enforced` (blocked before it runs), `detected` (a violation is seen after the fact and fails the attempt),
    `recorded-only` (declared, not checked), `refused(reason)` (not expressible); Orca flags `detected`, `recorded-only`
    network and `refused` rules red.
  - §18: "step `tools` shape and its mapping to ccloop `toolRules`" is frozen from Orca phase 1.
  - §21 C17: a step's `tools` reach the child contract's `toolRules` exactly; a step without `tools` produces a contract
    byte-equal to today's; the run page shows each rule's status as ccloop reports it, `detected` / `recorded-only` network
    / `refused` flagged red.
- **Human rulings this implements** (Orca ledger `Orca/.superpowers/sdd/2026-10-21-session-8b1469ea/progress.md`, last
  entries): H-A 「a」 (per-step tool declarations passed to ccloop as per-contract tool rules; a ccloop spec first), and the
  unenforceable-rule question answered 「a」 (relayed by the coordinator as a ruling): **a rule the agent cannot enforce ⇒
  the step still runs, the rule is reported `recorded-only`, Orca flags it red.** This spec announces no ruling of its own
  (CLAUDE.md Rule 18). Decisions are marked **Writer's call (reversible)** or **Controller's call (session 8b1469ea)**
  (the latter relayed by the coordinator after review; still reversible, not human rulings).
- **Not in scope:** Orca's side (template field, run page, red flags) is Orca's spec; listed in §9 only so the repin round
  knows what to build.

---

## 1. Today (`2a2ae53`)

- **Contract.** `loopContractSchema` (`src/contract/schema.ts:24-79`) is `.strict()` at every level; `executionPolicy`
  (`:43-53`) has no tool field. An unknown key ⇒ the start envelope fails to parse ⇒ `control-request-invalid`
  (`src/control/protocol.ts:440-450`). `contractHash` is **computed by Orca** and carried on the envelope (`:291`, `:303`);
  ccloop never recomputes it, it only compares hashes it was handed (`src/control/materialize.ts:228`,
  `src/control/savedResultRecovery.ts:129,234`). ccloop's own content comparison is `semanticContract`
  (`materialize.ts:196-201`, used at `:239` for allowance continuation), which keeps everything in `executionPolicy` except
  `tokenBudget`, `maxAttempts`, `totalRuntimeBudgetMs`.
- **claude.** Execute and verify get one exact `Bash(<cmd>)` allow rule per required check; plan gets none
  (`src/runtime/claude/claudeAgentAdapter.ts:350`). `requiredCheckAllowRules` (`:120-134`, grammar notes `:110-119`) refuses
  empty, `*`, parentheses, backslash, control characters and edge whitespace — **never a wider rule** — and records refusals
  as `requiredChecksNotAllowed` in the call's `outcome.json`. `--allowedTools` goes before `--model` (`:185-186`) because
  the list option swallows what follows. The installation command is the person's (`src/agents/claude.ts:36-48`; draft:
  `--permission-mode acceptEdits`, `--setting-sources project,local`, inline `--settings '{"autoMemoryEnabled":false}'` at
  `:45`) and is **outside** `agentConfigHash` (`src/agents/materialize.ts:36-50`).
- **codex.** `--sandbox <installation.sandbox>` on execute, `read-only` on plan/verify (`src/runtime/codex/runCodexPhase.ts:41-43`);
  `installation.sandbox ∈ {read-only, workspace-write}` (`src/agents/codex.ts:38`). Phase isolation adds `-c` pairs
  (`src/runtime/codex/codexPhaseIsolation.ts:29-35`; `CODEX_PHASE_CONFIG` in `src/agents/codexIsolation.ts:29-31`); the
  private `CODEX_HOME` **links the person's `config.toml`**, so anything it sets (network access, web search) applies unless
  a `-c` overrides it. No per-command allowlist is passed.
- **omp.** A fixed tool set per phase: execute `read,grep,glob,edit,write,bash`, else `read,grep,glob`
  (`src/runtime/omp/runOmpPhase.ts:52`); `decodeOmpPhase` re-checks tool names **after the process exited**
  (`src/runtime/omp/ompProtocol.ts:33,46-48`) ⇒ `omp-phase-tool-forbidden`. Detection, not prevention.
- **Prompts.** All three kinds build plan/execute/verify prompts from one module, `src/runtime/claude/prompts.ts`
  (imported by `src/runtime/codex/codexAdapter.ts:6` and `src/runtime/omp/ompAdapter.ts:4`).
- **Failure causes.** `FAILURE_CAUSES` (`src/runtime/failureCause.ts:7-10`), `RETRYABLE_CAUSES` (`:14`).
- **Environment.** No adapter filters it: claude `{...process.env, …}` (`claudeAgentAdapter.ts:204`), codex
  `{...process.env, ...extraEnv}` (`runCodexPhase.ts:45`; isolation sets only `HOME`/`CODEX_HOME` and
  `shell_environment_policy.set.HOME`), omp `{...process.env, OMP_PROFILE}` (`runOmpPhase.ts:80`). ccloop's own required
  checks run with `sh -lc` and the inherited environment (`src/controller/runLoop.ts:217`).
- **Capability advertisement.** `control features` answers exactly
  `{protocol:1, tokenPolicy:"optional-v1", savedResultRecovery:"v1", agentInstallationUpdate:"v1"}`, validated strictly on
  both sides (`src/control/command.ts:270,320`; Orca `src/control/ccloopPort.ts:205`), and asserted with `toEqual` by
  `tests/control/protocol4.test.ts:13` and `tests/control/savedResultEvidence.test.ts:110`.

## 2. Wire shape

`contract.executionPolicy.toolRules` — **optional**, on the one shared `loopContractSchema` (so protocol 3, protocol 4 and
`ccloop run` contract files all accept it):

```
toolRules?: {
  commands:  [{ kind: "exact" | "prefix", value: string }],   // 0..64 entries
  network:   boolean,
  secretEnv: [string]                                          // 0..32 names
}   // .strict() at every level; all three keys required
```

Validation (zod, code — Rule 5):

- `value`: 1..4096 UTF-8 bytes (`Buffer.byteLength`, as `utf8Bounded` in `protocol.ts:247`), no NUL. Characters an agent
  cannot express are **not** schema errors: they are per-kind `refused` (§4), so the person sees why.
- `commands`: no two entries with the same `(kind, value)`.
- `secretEnv`: each `^[A-Za-z_][A-Za-z0-9_]{0,127}$`, unique.
- All keys required, no zod `.default()` inside `toolRules`. **Writer's call (reversible):** one rule set has exactly one
  spelling — with defaults, "`network` omitted" and "`network: false`" would be two byte-different contracts (two Orca
  `contractHash`es) for one meaning — and the contract ccloop parses, seals as the accepted contract and feeds to
  `semanticContract` stays exactly the object Orca sent. Orca fills its own template defaults (§3.2 "network default false").

**Absent ⇒ identical.** No field is added on parse; contract bytes, envelope bytes, every argv, prompt and evidence file
are byte-identical to `2a2ae53`. Proven by T1 (§8).

**Old ccloop + new contract** ⇒ strict parse refuses (`control-request-invalid`) at accept, before any work: fails closed,
never silently ignored.

**Why the contract, not `work`:** the skill directories live on `work` because they are per-run paths, not task identity.
Tool rules are what the task is allowed to do: in the contract they are covered by Orca's `contractHash`, sealed in the
accepted contract, and compared by ccloop's `semanticContract` on allowance continuation — with no new code in those
paths. This is also where Orca §16.2 names it.

## 3. Semantics

### 3.1 What a rule means

- `{kind:"exact", value}` — the agent may run exactly this one simple command.
- `{kind:"prefix", value}` — the agent may run `value` alone or `value` followed by a space and further arguments.
- **A rule is one simple command.** A `value` containing a shell separator (`&`, `|`, `;`, or a newline — `&&`, `||` are
  covered) is `refused` on every kind ("a compound command cannot be one rule"): claude splits compound commands and
  matches each part (`claudeAgentAdapter.ts:110-119`), so such a rule could never match there, and §4's omp check splits
  the same way. A prefix never matches across a separator: `npm test && rm -rf x` is two commands, each must match.
- `network` — whether the agent's tools may reach the network.
- `secretEnv` — names of environment variables the contract needs (values never travel on the wire or into evidence).
- **Required checks are always allowed in addition** (Orca §3.2), exactly as today; tool rules never remove or replace a
  required-check allowance, so `verification.requiredChecks` stays runnable whenever it is runnable today.

### 3.2 "Never widen" — precisely

1. **Translation never widens.** Each rule maps to agent mechanisms that admit **at most** what the rule says. A rule the
   kind cannot express exactly is left out and reported `refused(reason)` — never replaced by a broader rule (the
   `requiredCheckAllowRules` principle).
2. **Rules never loosen the person's agent settings. Writer's call (reversible), extended by Controller's call (session
   8b1469ea):** a rule may add a *named grant inside* the mode the installation runs in, never change the mode or override
   a restriction the person set:
   - claude: rules add `--allowedTools` / `--disallowedTools` entries; ccloop never adds or changes `--permission-mode`,
     `--dangerously-skip-permissions`, `--settings`, `--setting-sources`, or anything else in `installation.command`.
   - codex: `network: true` may switch the network on **inside** `workspace-write`; it never changes `--sandbox`. It is
     `refused` when (a) `installation.sandbox` is `read-only` (no write sandbox to open), or (b) **the person's effective
     `config.toml` sets `sandbox_workspace_write.network_access = false` explicitly** (Controller's call: an explicit "off"
     in the person's own config is a restriction, and overriding it is widening). An unreadable or unparseable
     `config.toml` ⇒ `refused` too (cannot prove it is not widening). How ccloop reads the key (an existing dependency, or
     codex itself) is measured by the builder (§7).
   - omp: rules never add a tool name to the phase's `--tools` list.

   Why "grants inside the mode" and not "may only narrow": today's contract already adds grants beyond the installation's
   mode (required checks become Bash allow rules that `acceptEdits` would deny) — that is the precedent the human approved
   (`fix(claude): execute and verify allow exactly the contract's required checks`); a narrow-only rule set could never let
   a step run the one command it needs. Why not "change the mode": the installation is the person's agent-wide choice
   (the table is theirs, `claude.ts:33-35`); a contract — ultimately a template that may come from someone else — must not
   flip it.

### 3.3 Status values and rows

The report (§5) has one row per declared rule plus one synthetic row. Statuses are Orca's frozen set:

- `enforced` — held by the agent **before** anything runs.
- `detected` — not prevented, but a violation is seen after the fact and fails the attempt (omp, §4).
- `recorded-only` — the step runs; the rule is written down, nothing checks it (human ruling 「a」).
- `refused` (+ `reason`) — not expressible on this kind without widening; nothing was passed for it. The step still runs.

Rows and what the status means for each (**Writer's call (reversible)**, consistent with Orca's definitions):

| Row | Kind of rule | `enforced` means |
|---|---|---|
| `commands-closed` — **always emitted, also for `commands: []`** | restriction: "nothing outside `commands` ∪ required checks ∪ the installation's baseline" | commands outside that set are blocked before they run |
| one per `commands[i]` | grant | the exact allow mechanism for this command was passed to the agent (it will run without being denied). `recorded-only` = nothing was passed; whether the agent may run it is up to the installation |
| `network` (`value:true`) | grant | the network permission was passed to the agent |
| `network` (`value:false`) | restriction | the agent's network-capable tools are blocked before they run |
| one per `secretEnv[i]` | declaration | never `enforced` (§4) |

So the boundary question "can the agent run something else?" is answered by `commands-closed`, and Orca's red flags
(`detected`, `recorded-only` network, `refused`) read off rows directly. This spec adds no red-flag rule of its own.

### 3.4 claude's baseline (what the installation itself admits)

`commands-closed` on claude is `enforced` only when code can show from the installation command that an un-granted Bash
command is denied in `-p`. Closed lists, no guessing (**Writer's call (reversible)**, tightened per review):

- **Permission mode** = the `--permission-mode` value; else `permissions.defaultMode` in an **inline** `--settings` JSON
  argument (a `--settings` value that is a file path is not read ⇒ unknown). `acceptEdits` or `default` ⇒ "denies"
  (`acceptEdits` measured, Orca session `3d229487`; `default`: builder measures, §7). **Absent** (neither given) ⇒
  **unknown** — project/local settings may set it ⇒ `commands-closed` `recorded-only`. Any other value,
  `--dangerously-skip-permissions` or `--allow-dangerously-skip-permissions` present ⇒ `recorded-only`.
- **Installation allows**: `--allowedTools` / `--allowed-tools` entries in the installation command and
  `permissions.allow` in an inline `--settings` JSON. Any Bash entry that is not an exact `Bash(<cmd>)` passing
  `requiredCheckAllowRules`' refusals (bare `Bash`, `Bash()`, `Bash(*)`, any `*` or `:*`) ⇒ `recorded-only`. Exact ones are
  listed in the report's `baseline`.
- **claude's built-in read-only Bash set** is always part of the baseline (named in `baseline`; its membership is the
  builder's measurement, §7, recorded as text, not re-implemented).
- **Not read:** `.claude/settings.json` / `settings.local.json` loaded by `--setting-sources` (the target repo's and the
  person's). `baseline` names them. Parsing another tool's permission files is a guess that would make `enforced` lie in a
  new way; naming them is honest.

## 4. Per-agent mapping

Grants apply to **execute only**; restrictions apply to **every phase** (plan, execute, verify, and the verify of a
saved-result recovery). **Writer's call (reversible):** plan and verify are read-only judgement phases and today get no
work tools (plan none, verify only required checks); a restriction is always safe to add, a grant is not needed there.

| Row | claude | codex | omp |
|---|---|---|---|
| `exact` | `Bash(<value>)` in execute's `--allowedTools`, same refusals as `requiredCheckAllowRules` plus §3.1's separators ⇒ `enforced`, else `refused(reason)` | `recorded-only` ("codex exec has no per-command allowlist"); separators ⇒ `refused` | `recorded-only` (omp has no allowlist; checked by `commands-closed`); separators ⇒ `refused` |
| `prefix` | claude's prefix form (spelling measured, §7) if `value` passes the same refusals **and** the form matches only §3.1's meaning ⇒ `enforced`; else `refused` | `recorded-only`; separators ⇒ `refused` | `recorded-only`; separators ⇒ `refused` |
| `commands-closed` | `enforced` per §3.4, else `recorded-only` | `recorded-only` (workspace-write runs any command in the sandbox) | `detected` if the after-exit check below is built, else `recorded-only` |
| `network: true` | `WebFetch`, `WebSearch` in execute's `--allowedTools` ⇒ `enforced` | `-c sandbox_workspace_write.network_access=true` on execute ⇒ `enforced`; `refused` per §3.2.2 (a)/(b) | `recorded-only` ("omp has no network switch ccloop can set") |
| `network: false` | `--disallowedTools WebFetch WebSearch` (before `--model`) on every phase; Bash cannot be kept off the network (allowed commands, required checks) ⇒ `recorded-only` (Orca §16.2) | `-c sandbox_workspace_write.network_access=false` on execute (overrides the linked `config.toml`) ⇒ **`recorded-only` until §7 proves both that override and the `-c` that turns codex's web-search tool off**; with both proven and passed ⇒ `enforced` (plan/verify run `read-only`) | `recorded-only` |
| `secretEnv` | `recorded-only` | `recorded-only` | `recorded-only` |

**omp after-exit check (`detected`) — Writer's call (reversible), conditional.** Built only if omp's `tool_execution_start`
event carries the bash command (the builder proves it from omp source or a zero-cost probe, §7); otherwise
`commands-closed` is plain `recorded-only`. The check, in `decodeOmpPhase`, for every execute `bash` call:

1. If the whole command string equals a required check ⇒ allowed (required checks may themselves be compound).
2. Else, if it contains a construct ccloop does not split — backtick, `$(`, `(`, `)`, `<(`, `>(`, `{`, `}` — ⇒ violation
   (fail closed).
3. Else split on `&&`, `||`, `;`, `|`, `&`, newline; trim each segment; every segment must equal a required check, equal
   an `exact` value, or match a `prefix` (equal, or begin with `value + " "`). Any segment that does not ⇒ violation.

A violation fails the phase with decode error `omp-tool-rule-violated`. The tokenizer is deliberately crude: it can only
produce false violations (the attempt fails, the person sees why), never false passes for the separators listed, because
anything it cannot split is a violation.

**Violation is terminal — Controller's call (session 8b1469ea).** `tool-rule-violated` is added to `FAILURE_CAUSES`
(not to `RETRYABLE_CAUSES`), classified **explicitly** from the decode error code `omp-tool-rule-violated` (never from
text). A violated attempt ends the run `failed` with that cause: no further attempt, no in-run continuation, no saved-result
recovery of that attempt. Its worktree is not landed. Rationale: the command already ran outside the declared boundary;
retrying would repeat it.

**`secretEnv` — recorded-only, no filtering. Writer's call (reversible), with reasons:**

- Filtering is new behaviour for every adapter (§1 Environment) and the variables each agent CLI needs for its own login,
  proxy and endpoint (`ANTHROPIC_*`, `OPENAI_*`, `HTTP(S)_PROXY` — omp uses `HTTP_PROXY` even for 127.0.0.1, handoff
  "零成本探针"; LiteLLM endpoint variables) are not measured. An allowlist built without measurement either breaks auth or
  leaks — a guess on a security boundary.
- codex's `shell_environment_policy` could filter the *commands'* environment, but would also change what required checks
  and builds see inside the agent; claude and omp have no equivalent ccloop can set.
- ccloop's own environment is set by whoever spawns `ccloop control` (Orca). The real enforcement point is there: **Orca
  can strip variables from the environment it spawns ccloop with** (§9).
- What ccloop does: report per name `present: true|false` (set in ccloop's environment at worker start — the name only,
  never the value), so a missing secret is visible before the step fails on it.

## 5. Report — where and what

Computed **once per run by code**, in the worker before the first phase, from `(contract.toolRules, installation kind,
installation.command, installation.sandbox, the effective codex config.toml key (§3.2.2), process.env names)` — no agent
call. The mapping and report builder live in one new pure module, **`src/runtime/toolRules.ts`** (the per-kind adapters
call it for their argv pieces; the worker calls it for the report; `decodeOmpPhase` calls its matcher). Written to
`<sourceDir>/run/tool-rules.json` (mode `0600`, like the other run files). Each phase call's `outcome.json` already
records the argv (`extraArgs` / `args`) — the evidence that the mapping was passed.

```
ToolRulesReportV1 = {
  schema: "ccloop-tool-rules-report-v1",
  agentKind: "claude" | "codex" | "omp",
  baseline: string,                       // ≤1024 B: what the installation admits or loads that ccloop cannot see (§3.4)
  rules: [{
    rule: { kind: "commands-closed" }
        | { kind: "exact" | "prefix", value }
        | { kind: "network", value: boolean }
        | { kind: "secretEnv", name },
    status: "enforced" | "detected" | "recorded-only" | "refused",
    reason: string | null,                // ≤512 B; null only for enforced
    phases: ("plan" | "execute" | "verify")[],   // where a mechanism was passed or checked; [] when none
    present?: boolean                     // secretEnv only
  }]                                      // order: commands-closed, commands as given, network, secretEnv as given
}
```

- **`control collect`** gains optional top-level `toolRules: ToolRulesReportV1`, present **iff** the contract has
  `toolRules` and the file exists; absent otherwise ⇒ collect bytes unchanged for every existing caller (Orca's collect
  parse is strict, and it only sees the key on runs it asked for). Same placement rule as `failureCause`
  (`src/control/collect.ts:86,152`): top level, not inside the protocol-4 terminal.
- **Violations** surface as the run's `failureCause` `tool-rule-violated` (§4); Orca reads `cause` as a bounded string,
  so a new value does not break it (handoff "Orca 那条线").
- **Prompt. Writer's call (reversible):** when `toolRules` is present, `buildExecutorPrompt` in
  `src/runtime/claude/prompts.ts` (shared by all three kinds) gains one short section listing the allowed commands, whether
  network is allowed and the secret names, so the agent does not spend turns on denied calls. Absent ⇒ no bytes. Plan and
  verify prompts unchanged.

## 6. Interactions

- **Required checks.** Execute and verify keep `requiredCheckAllowRules` exactly; tool-rule allow entries are appended and
  de-duplicated against them (one `Bash(x)` even if `x` is both). A required check refused by claude's grammar is still
  recorded as `requiredChecksNotAllowed`, unchanged. The omp check always admits a command equal to a required check.
  ccloop's own check runs (`runLoop.ts:217`) are untouched (they are ccloop's, not the agent's).
- **Plan / verify.** Restrictions only (§4). Verify still gets exactly the required checks as Bash rules.
- **Handoff and continuation.** A mechanical in-run handoff resumes under the same contract ⇒ same rules. A successor run
  carries whatever contract its envelope has. An allowance continuation already requires `semanticContract` equality
  (`materialize.ts:239`, computed by ccloop from contract content), which now includes `toolRules` — a changed rule set
  cannot ride an allowance continuation even when Orca hands the same `contractHash` (`control-allowance-authority-mismatch`,
  existing code).
- **Saved-result recovery.** ccloop compares the `contractHash` Orca hands it (`savedResultRecovery.ts:129,234`); that the
  rules are covered rests on **Orca computing `contractHash` over the whole contract, `toolRules` included** (listed in §9).
  A recovery runs verify only ⇒ only restrictions apply; its own `tool-rules.json` is computed like any run's. A
  `tool-rule-violated` attempt is never a recovery source (§4).
- **`agentConfigHash`.** Unchanged — tool rules are task identity, not agent identity. Putting them in `agentConfigHash`
  would strand a frozen agent selection whenever a template step changes its tools (the reason `command`, `timeoutMs`,
  `idleTimeoutMs` were removed from it, `materialize.ts:29-47`).
- **Single call.** No contract ⇒ no tool rules. Unchanged.
- **Crash resume.** The worker re-parses `envelope.json` on every start; the report is recomputed and rewritten atomically
  (if the installation command or config changed in between, the new report is the true one for the remaining phases).

## 7. Left to the builder (decide, record in the plan's ledger)

Each is a measurement, not a policy; record command + version + commit (Rule 14). Real paid calls need the human's
approval first (handoff: codex is paid; omp's endpoint is the human's).

- claude (installed version, static read of the binary as in `claudeAgentAdapter.ts:110-119`): the exact prefix-rule
  spelling and whether it matches only §3.1's meaning (if none does, `prefix` is always `refused` on claude); that
  `--disallowedTools` holds under `acceptEdits` and must precede `--model`; whether `default` mode denies un-granted Bash
  in `-p`; the built-in read-only Bash set (recorded as text in `baseline`); whether `WebFetch`/`WebSearch` are all of
  claude's network tools.
- codex 0.163.0: that `-c sandbox_workspace_write.network_access=<bool>` is accepted and overrides a linked `config.toml`
  (zero-cost `codex sandbox` probe under the phase isolation); the `-c` that turns the web-search tool off whatever the
  linked `config.toml` says (until both are proven, `network:false` stays `recorded-only`); how to read the effective
  `sandbox_workspace_write.network_access` key (§3.2.2).
- omp 18.x: whether `tool_execution_start` carries the bash command (omp source in `~/.sourceget`); extend
  `tests/fixtures/fake-omp.mjs` only after the real shape is known.
- Exact reason strings (bounded), helper names inside `src/runtime/toolRules.ts`.

## 8. Tests (add only; each seen red; mutations in a built `git clone --local` copy, Rule 17)

Every criterion is a command with an exit code, run from the copy after `npm run build`:
`./node_modules/.bin/vitest run <file> --reporter=json --outputFile=<scratchpad>/<name>.json > <scratchpad>/<name>.log 2>&1; echo $?`
(0 = green). The round ends with the full suite + `node scripts/check-known-reds.mjs <json>; echo $?` = 0 (handoff "先跑这些").

| # | Criterion (new test file) | Named mutations that must be seen red |
|---|---|---|
| T1 | absent ⇒ identical (`tests/contract/toolRulesAbsent.test.ts`): a contract without `toolRules` parses to the same canonical bytes as at `2a2ae53`; **claude, codex and omp argv** for plan/execute/verify and the executor prompt equal goldens **captured by running `2a2ae53` code in a clone** (checked in as fixtures, not computed by the code under test); collect has no `toolRules` key. The existing `tests/runtime/claude/claudeSkillPluginDir.test.ts` `goldenArgv` stays byte-unmodified | add `.default()` to `toolRules`; always emit `--disallowedTools`; always write `toolRules: null` into collect; always add the `-c network_access` pair |
| T2 | schema (`tests/contract/toolRulesSchema.test.ts`): unknown key at each level, missing key, 65 commands, 4097-byte value (multi-byte at the edge), NUL, duplicate `(kind,value)`, 33 names, bad name, duplicate name — each `control-request-invalid` through `parseControlRequest("accept")`; boundary values accepted | drop `.strict()` on `toolRules`; count `.max` in UTF-16 units; drop the duplicate refine |
| T3 | claude mapping (`tests/runtime/claude/claudeToolRules.test.ts`, fake runner reading `CCLOOP_CLAUDE_EXTRA_ARGS`): execute gets required checks + exact rules (deduplicated) + web tools per `network`; plan gets only `--disallowedTools` when `network:false`; verify gets required checks only (+ disallow); every list option precedes `--model`; each refusal class, including `a && b`, `a; b`, `a \| b` ⇒ `refused` and nothing passed; `commands-closed`: `acceptEdits` ⇒ `enforced`; absent mode, `bypassPermissions`, skip-permissions, inline `--settings` with `defaultMode:"bypassPermissions"`, installation `--allowedTools Bash` / `Bash(npm:*)` ⇒ `recorded-only`; `network:false` ⇒ `recorded-only` | map a refused value to `Bash(*)` / `Bash()`; grant exact rules in plan; drop a required check when a tool rule is present; report `commands-closed` `enforced` with absent mode; place `--disallowedTools` after `--model`; ignore inline `--settings` |
| T4 | codex mapping (`tests/runtime/codex/codexToolRules.test.ts`, fake codex recording argv, fixture `config.toml`): `workspace-write` + `network:true` ⇒ `-c …network_access=true` on execute only, `enforced`; `read-only` installation ⇒ `refused`, `--sandbox read-only` unchanged; config with `network_access = false` ⇒ `network:true` `refused`, no `-c`; unparseable config ⇒ `refused`; `network:false` ⇒ `=false` passed, status `recorded-only` (until §7 proven); commands and `commands-closed` `recorded-only` | change `--sandbox` to satisfy `network:true`; override the person's explicit `false`; report `network:false` `enforced`; report commands `enforced` |
| T5 | omp mapping (`tests/runtime/omp/ompToolRules.test.ts`, `fake-omp.mjs`): `--tools` unchanged with rules present; rows `recorded-only` except `commands-closed`. If the check is built: `commands-closed` `detected`; prefix rule `npm test` + bash `npm test && rm -rf x` ⇒ `omp-tool-rule-violated` and run cause `tool-rule-violated`, run `failed`, no second attempt; `npm test -- --run` ⇒ passes; `echo $(id)` ⇒ violation; a compound required check verbatim ⇒ passes | add a tool name for `network:true`; match the whole string against the prefix without splitting; treat a required check as a violation; put `tool-rule-violated` in `RETRYABLE_CAUSES`; report `detected` as `enforced` |
| T6 | report + collect (`tests/control/toolRulesCollect.test.ts`, real worker on fake agents): `run/tool-rules.json` mode `0600`; `commands-closed` row present with `commands: []`; collect returns the report top-level, not inside the protocol-4 terminal; `secretEnv` `present` true/false from a test-set env, and **no value bytes** anywhere under `sourceDir` (scan the tree for the test value) | write the value instead of the name; put the report inside `terminal`; omit `present`; skip `commands-closed` when `commands` is empty |
| T7 | identity (`tests/control/toolRulesIdentity.test.ts`): an allowance continuation whose contract differs from the sealed one **only** in `toolRules`, with the **same** `contractHash` handed in ⇒ `control-allowance-authority-mismatch` (exercises ccloop's own `semanticContract` check); `agentConfigHash` unchanged by `toolRules` | strip `toolRules` in `semanticContract`; add `toolRules` to `agentConfigHash` |

Rule 9 / methodology §1–3 apply: every new branch gets the mutation that deletes **that branch** seen red; no assertion
placed before the call it is meant to observe. The saved-result case is not a ccloop criterion: it rests on Orca's
`contractHash` (§6, §9).

**Existing criteria changed:** none. (If the human chooses Q1 (b), two `toEqual` lines change — they would have to be
named by the human, CLAUDE.md Rule 15.)

## 9. Orca side (Orca Rule 16: ccloop assumes none of it; listed so the repin round builds it)

- Orca's collect parse adds optional `toolRules` (strict shape as §5) and the cause value `tool-rule-violated`.
- Orca maps step `tools` → `toolRules` exactly (`{exact}` → `{kind:"exact"}`, `secrets` → `secretEnv`, filling
  `network:false`, `commands:[]`, `secretEnv:[]`), and **omits** `toolRules` entirely for a step without `tools` (C17).
- Orca's `contractHash` must cover the whole contract including `toolRules` (saved-result recovery relies on it, §6).
- Support detection: the exact ccloop pin; an older ccloop refuses the contract at accept (`control-request-invalid`).
- Secrets: if Orca wants a secret held back from steps that did not name it, the place is the environment Orca spawns
  `ccloop control` with (§4) — Orca's own design question.
- Display per Orca §16.2: `detected`, `recorded-only` network and `refused` rows red; `secretEnv` `present:false` shown.

## 10. Open questions for the human (only these; the rest are reversible calls above)

- **Q1 — advertise support in `control features`?** (a) **default, no change**: Orca detects support by its exact pin, and an
  old ccloop refuses the contract at accept, so nothing is ever silently ignored; no existing criterion changes. (b) add
  `toolRules: "v1"` to the features answer: needs `tests/control/protocol4.test.ts:13` and
  `tests/control/savedResultEvidence.test.ts:110` rewritten (human must name them, Rule 15) and Orca's strict features
  schema (`Orca/src/control/ccloopPort.ts:205`) relaxed in the same repin. The writer proceeds with (a) unless told
  otherwise; (b) can be added later without changing anything else here.

Flagged for the human to overrule if wanted (reversible, not questions): secrets recorded-only with no filtering (§4);
"grants inside the mode" reading of never-widen, including refusing `network:true` against the person's explicit codex
`network_access = false` (§3.2); a tool-rule violation ending the run (§4).

## Correction (Orca session `7753e97d`, 2026-10-27; spec `2026-10-27-plan-phase-tools-design.md`)

§4 says `tool-rule-violated` is classified only from the decode error code `omp-tool-rule-violated`. From the commit
`fix(omp): name the plan phase's tools and classify a forbidden one as tool-rule-violated` on, it is **also** classified
from the phase fold's `omp-phase-tool-forbidden` when the fold names a tool the phase does not have (any omp phase; the
sample is a plan `write` to `xd://…`, Orca issue 60). It stays terminal. The text above is kept as written (Rule 16).
