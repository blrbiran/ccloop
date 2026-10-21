# Per-contract tool rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contracts may carry `executionPolicy.toolRules`; each agent kind maps them to its own mechanisms without ever widening, and ccloop reports a per-rule status (`enforced | detected | recorded-only | refused`).

**Architecture:** One pure module `src/runtime/toolRules.ts` owns validation helpers, the per-kind mapping and the report builder. The three adapters ask it for argv pieces; the control worker writes `run/tool-rules.json` once per run; `control collect` returns it top-level; omp gets an after-exit command check whose violation is the terminal cause `tool-rule-violated`.

**Tech Stack:** TypeScript, zod, vitest; existing fakes `tests/fixtures/fake-codex.mjs`, `tests/fixtures/fake-omp.mjs`, the claude fake runner (`CCLOOP_CLAUDE_EXTRA_ARGS`).

**Spec:** `docs/superpowers/specs/2026-10-22-per-contract-tool-rules-design.md` (read it whole; this plan only adds the §7 measurements and the build order).

Author: Orca session `b37f7ce9`, 2026-10-22. Branch `feat/per-contract-tool-rules`, worktree `/private/tmp/orca-b37f7ce9/ccloop-wt` (node_modules is a symlink to the main tree's — `unlink` it before removing the worktree). Base `638c3d8`; `git diff --stat 2a2ae53 638c3d8 -- src tests` is empty, so every spec anchor still holds. Ledger: `Orca/.superpowers/sdd/2026-10-22-session-b37f7ce9/progress.md`.

## Global Constraints

- Absent `toolRules` ⇒ contract, envelope, every argv, every prompt, every evidence file and collect bytes identical to `2a2ae53` (spec §2, T1).
- `toolRules` is `.strict()` at every level, all three keys required, no `.default()` inside it; `commands` 0..64, `value` 1..4096 UTF-8 bytes (`Buffer.byteLength`), no NUL, no duplicate `(kind,value)`; `secretEnv` 0..32 names `^[A-Za-z_][A-Za-z0-9_]{0,127}$`, unique (spec §2).
- Never widen (spec §3.2): ccloop never adds/changes `--permission-mode`, `--dangerously-skip-permissions`, `--settings`, `--setting-sources`, `--sandbox`, or omp's `--tools`.
- Grants on execute only; restrictions on every phase incl. saved-result verify (spec §4).
- Required checks are always allowed in addition; `requiredCheckAllowRules` stays byte-for-byte the same function.
- `tool-rule-violated` ∈ `FAILURE_CAUSES`, ∉ `RETRYABLE_CAUSES`; classified only from decode error code `omp-tool-rule-violated`.
- `agentConfigHash` unchanged; Q1 = (a): `control features` unchanged.
- Report file `<sourceDir>/run/tool-rules.json`, mode `0600`, atomic replace; secret **values** never written anywhere.
- Mutations only in a built `git clone --local` copy under `/private/tmp/orca-b37f7ce9/`; every run redirected to a file and read back whole (CLAUDE.md Rule 14/17).
- Existing criteria: none changed (spec §8). If one must change, the human authorised necessary rewrites this round (Orca ledger, session `b37f7ce9`, "这次批准改写所有必要的判据") — name it in the commit with a `Ruling:` line.

## Measurements this plan rests on (spec §7; full evidence in `/private/tmp/orca-b37f7ce9/measure-{claude,codex,omp}.md`)

- **claude 2.1.306** (static read): prefix form is `Bash(<value> *)` — regex `^value( .*)?$`, only when that trailing ` *` is the rule's only `*`; never matches `npm testx`. claude also strips wrappers (`timeout N`, `nice`, `nohup`, …), safe env assignments and redirections, and admits `xargs <value> …` for prefix rules (exact rules strip the same wrappers today). `--disallowedTools` is variadic (must be followed by another option — place before `--model`); deny beats allow and every mode, `bypassPermissions` included. `-p`: an "ask" becomes deny unless `--permission-prompt-tool`/`--sdk-url`. `manual` is an alias of `default`. `acceptEdits` additionally auto-allows Bash `mkdir touch rm rmdir mv cp sed`. Inline `--settings` = trimmed value starts with `{` and ends with `}`. A settings `sandbox` key turns on `autoAllowBashIfSandboxed` (widening). Network: Bash, MCP, Skill `!` lines etc. also reach the network ⇒ claude `network:false` stays `recorded-only`. The `claudeAgentAdapter.ts:110-119` note ("every `*` is a wildcard with no escape") is stale for wildcard rules (`\*` is a literal there); exact rules keep the backslash, so refusing `*` and `\` stays right — ERRATUM appended in Task 3.
- **codex 0.163.0**: `-c sandbox_workspace_write.network_access=<bool>` after `exec` overrides `config.toml` (3×3 matrix proven with `codex sandbox -c sandbox_mode="workspace-write" -- curl`); a misspelt key is silently ignored ⇒ tests assert the exact string. Web search is ON by default; off is `-c web_search="disabled"` (`tools.web_search=false` is a no-op). `features.apps` (codex_apps connectors) is network-capable and not reached by MCP-by-name ⇒ `-c features.apps=false`. No TOML parser in deps; no safe subcommand prints effective config. Layers above `-c`: managed/MDM/system/cloud only.
- **omp 18.10.1** (== tag `v18.10.1` for the 8 relevant files): `tool_execution_start.args.command` carries the bash command for every call (incl. blocked). `write` to a path `xd://…` (e.g. `xd://bash`) runs bash **without** a bash event (`tools.xdev` default on) ⇒ any `write` whose `args.path` starts with `xd://` is a violation. `read` fetches http(s) ⇒ omp `network:false` stays `recorded-only`. `decodeOmpPhase` runs only on `completed` outcomes ⇒ the check is a separate pure function also run on the failure path.

## Controller calls (reversible; recorded in the Orca ledger)

- claude `prefix` ⇒ `Bash(<value> *)`, `enforced`, when `value` passes `requiredCheckAllowRules`' refusals and §3.1's separators; else `refused`.
- claude `commands-closed` ⇒ `enforced` iff mode ∈ {`acceptEdits`, `default`, `manual`} (flag, else inline-settings `permissions.defaultMode`), no skip-permissions flag, no `--permission-prompt-tool`/`--sdk-url`, no inline-settings `sandbox` key, and every installation Bash allow is exact. `baseline` names: acceptEdits' file commands (when acceptEdits), the read-only built-in set, wrapper/xargs stripping, unread `.claude/settings*.json`.
- codex `network:false` ⇒ execute gets `-c sandbox_workspace_write.network_access=false`; **every** phase gets `-c web_search="disabled"` and `-c features.apps=false` ⇒ `enforced` (only managed layers sit above `-c`; named in `baseline`). Plan/verify already run `read-only` (no network).
- codex `network:true` refusal (§3.2.2b) via a narrow fail-closed reader of the person's `config.toml` (the file the private `CODEX_HOME` links): accepts `[sandbox_workspace_write]` + `network_access = true|false`, top-level dotted `sandbox_workspace_write.network_access = …`, inline table `sandbox_workspace_write = { network_access = … }`; any other line mentioning `network_access`, or a non-boolean ⇒ unparseable ⇒ `refused`; unreadable (other than ENOENT) ⇒ `refused`; ENOENT ⇒ absent. `baseline` names managed layers, `--profile` in the installation command, trusted repo `.codex/config.toml`.
- omp check is built (`commands-closed` = `detected`).

## Review Focus

1. A required check that is itself compound (`npm test && npm run lint`) still runs on every kind — omp must admit it verbatim, claude keeps today's behaviour. (Task 5 test.)
2. A `toolRules` with `commands: []` still emits `commands-closed` and still restricts (claude passes no extra allow; omp flags every non-required-check bash). (Tasks 3, 5, 6.)
3. Multi-byte `value` at exactly 4096 bytes accepted, 4097 refused; byte counting, not UTF-16. (Task 1.)
4. An omp execute that violates and then times out ends `failed` + `tool-rule-violated`, not retried as `stalled`/`budget-exhausted`. (Task 5.)
5. A codex config with `network_access` in a comment or another table (`[profiles.x.sandbox_workspace_write]`) is not misread as the effective value — comment lines ignored; any non-comment mention outside the three spellings ⇒ refused. (Task 4.)

---

### Task 0: Goldens from `2a2ae53`

**Files:**
- Create: `tests/fixtures/toolRules/golden-2a2ae53/{claude,codex,omp}-{plan,execute,verify}.json`, `executor-prompt.txt`, `contract.json`, `README.md` (how they were captured: clone commit, command, date).

- [ ] **Step 1:** `git clone --local /Users/biran/code/skills/orca/ccloop /private/tmp/orca-b37f7ce9/golden-2a2ae53 && cd … && git checkout 2a2ae53 && ln -s <main>/node_modules node_modules && npm run build`.
- [ ] **Step 2:** In that clone run a scratch capture script (kept in `/private/tmp/orca-b37f7ce9/scripts/`, not committed) that drives each adapter's plan/execute/verify against the existing fakes for one fixed contract (two required checks, no `toolRules`) and records: claude `extraArgs` (from `outcome.json`), codex `args`, omp `args`, and `buildExecutorPrompt` output. Normalise only per-run paths (evidence dirs, worktree path, temp HOME) to fixed placeholders; record the normaliser in `README.md`.
- [ ] **Step 3:** Copy outputs into the worktree fixture dir; commit `test(toolRules): goldens captured from 2a2ae53`.

### Task 1: Schema + `toolRules.ts` core

**Files:**
- Modify: `src/contract/schema.ts` (`executionPolicy` gains optional `toolRules`)
- Create: `src/runtime/toolRules.ts`
- Test: `tests/contract/toolRulesSchema.test.ts` (T2), `tests/contract/toolRulesAbsent.test.ts` (T1 contract part)

**Interfaces (produces):**
```ts
export type ToolCommandRuleV1 = { kind: "exact" | "prefix"; value: string };
export type ToolRulesV1 = { commands: ToolCommandRuleV1[]; network: boolean; secretEnv: string[] };
export type ToolRuleStatus = "enforced" | "detected" | "recorded-only" | "refused";
export type ToolRulePhase = "plan" | "execute" | "verify";
export type ToolRuleRowV1 = {
  rule: { kind: "commands-closed" } | ToolCommandRuleV1 | { kind: "network"; value: boolean } | { kind: "secretEnv"; name: string };
  status: ToolRuleStatus; reason: string | null; phases: ToolRulePhase[]; present?: boolean };
export type ToolRulesReportV1 = { schema: "ccloop-tool-rules-report-v1"; agentKind: "claude" | "codex" | "omp"; baseline: string; rules: ToolRuleRowV1[] };
export const toolRulesSchema: z.ZodType<ToolRulesV1>;
export function separatorRefusal(value: string): string | null;   // "&", "|", ";", "\n" ⇒ "a compound command cannot be one rule"
export function boundedText(text: string, maxBytes: number): string; // reuse causeDetail's code-point-safe cut
```
- [ ] Write T2 exactly as spec §8 row T2 (each case through `parseControlRequest("accept")` ⇒ `control-request-invalid`; boundaries 64 commands, 4096 bytes with a 3-byte char ending at byte 4096, 32 names accepted).
- [ ] Write T1 contract part: a contract without `toolRules` parses to canonical bytes equal to `golden-2a2ae53/contract.json`.
- [ ] See both red; implement; green. Mutations (clone): drop `.strict()` on `toolRules`; `.max` in UTF-16 units; drop the duplicate refine; add `.default()` to `toolRules` — each red.
- [ ] Commit `feat(contract): optional executionPolicy.toolRules`.

### Task 2: claude mapping (T3)

**Files:** Modify `src/runtime/claude/claudeAgentAdapter.ts` (argv at `:184-186`; comment block `:110-119` gains an ERRATUM at its end); Modify `src/runtime/toolRules.ts`; Test `tests/runtime/claude/claudeToolRules.test.ts`.

**Interfaces:**
```ts
export function claudeToolRuleArgs(rules: ToolRulesV1 | undefined, phase: ToolRulePhase, requiredCheckRules: readonly string[]): { allow: string[]; disallow: string[] };
export function claudeToolRuleRows(rules: ToolRulesV1, installationCommand: readonly string[]): { rows: ToolRuleRowV1[]; baseline: string };
```
argv order: `["--allowedTools", ...allow]` (if any) then `["--disallowedTools", ...disallow]` (if any) then `this.extraArgs` (which starts with `--model`). `allow` = required-check rules (existing) + exact/prefix grants on execute, de-duplicated; `disallow` = `WebFetch`, `WebSearch` on every phase when `network:false`; `network:true` adds `WebFetch`, `WebSearch` to execute's `allow`.
- [ ] Write T3 exactly as spec §8 row T3, plus: `manual` mode ⇒ `enforced`; `--permission-prompt-tool x` / `--sdk-url x` / inline settings with `sandbox` ⇒ `commands-closed` `recorded-only`; prefix `npm test` ⇒ arg `Bash(npm test *)`; prefix value containing `*` ⇒ `refused`.
- [ ] T1 claude part: no `toolRules` ⇒ argv equals goldens for plan/execute/verify; `claudeSkillPluginDir.test.ts` `goldenArgv` byte-unmodified (`git diff --exit-code` on that file).
- [ ] Red, implement, green. Mutations per spec T3 + "drop the `sandbox` check" + "prefix emitted as `Bash(v:*)`" (the latter must be seen red by the exact-arg assertion).
- [ ] Append ERRATUM to the `:110-119` comment (2.1.306: `\*` is a literal star inside a wildcard rule; exact rules keep the backslash, so the refusals stand; prefix form is `Bash(<v> *)`). Commit `feat(claude): map tool rules to allow/deny lists without widening`.

### Task 3: codex mapping (T4)

**Files:** Modify `src/runtime/codex/runCodexPhase.ts` (the `-c` pairs join `isolated.args` before the trailing `-`); Create `src/agents/codexNetworkConfig.ts`; Modify `src/runtime/toolRules.ts`; Test `tests/runtime/codex/codexToolRules.test.ts`, `tests/agents/codexNetworkConfig.test.ts`.

**Interfaces:**
```ts
export type CodexNetworkSetting = { kind: "absent" } | { kind: "value"; value: boolean } | { kind: "unparseable"; reason: string };
export function readCodexNetworkAccess(configTomlPath: string): Promise<CodexNetworkSetting>;
export function codexToolRuleArgs(rules: ToolRulesV1 | undefined, phase: ToolRulePhase, sandbox: "read-only" | "workspace-write", setting: CodexNetworkSetting): string[];
export function codexToolRuleRows(rules: ToolRulesV1, sandbox: "read-only" | "workspace-write", setting: CodexNetworkSetting): { rows: ToolRuleRowV1[]; baseline: string };
```
Exact strings: `sandbox_workspace_write.network_access=true`, `sandbox_workspace_write.network_access=false`, `web_search="disabled"`, `features.apps=false`. The config path is the one the private `CODEX_HOME` links (read `codexIsolation.ts` for how it resolves `installation.configDir` / `CODEX_HOME` / `~/.codex`); legacy path without `installation` uses the same resolution.
- [ ] `codexNetworkConfig.test.ts`: the three spellings × true/false; comment-only mention ⇒ absent; `[profiles.x.sandbox_workspace_write]` + `network_access` ⇒ unparseable; `network_access = "no"` ⇒ unparseable; ENOENT ⇒ absent; EACCES (chmod 000 in a temp dir) ⇒ unparseable.
- [ ] `codexToolRules.test.ts` = spec T4 with the exact strings above, plus `network:false` ⇒ plan and verify argv contain `web_search="disabled"` and `features.apps=false` but not `network_access`; status `enforced`. T1 codex part: no rules ⇒ argv equals goldens.
- [ ] Red, implement, green. Mutations per spec T4 + "misspell `network_access`" + "omit `features.apps=false`" + "reader treats the profiles table as effective". Commit `feat(codex): tool rules switch network inside workspace-write, never the sandbox`.

### Task 4: omp check + terminal cause (T5)

**Files:** Modify `src/runtime/omp/runOmpPhase.ts` (nothing for `--tools`), `src/runtime/omp/ompAdapter.ts` (`:25-50`, `:67-73`), `src/runtime/failureCause.ts` (`FAILURE_CAUSES`), `src/runtime/toolRules.ts`, `tests/fixtures/fake-omp.mjs` (optional `<marker>.tools.json` `[{toolName,args}]`, execute only, start/end pairs before the final `message_end`; absent ⇒ byte-identical output — code in `measure-omp.md` Q5); Test `tests/runtime/omp/ompToolRules.test.ts`.

**Interfaces:**
```ts
export function ompToolRuleViolation(events: string, rules: ToolRulesV1, requiredChecks: readonly string[]): string | null; // null = clean; string = bounded detail
export function ompToolRuleRows(rules: ToolRulesV1): ToolRuleRowV1[];
```
Algorithm = spec §4 steps 1–3 over every execute `tool_execution_start` with `toolName === "bash"` (`args.command`), plus: `toolName === "write"` and `args.path` starting `xd://` ⇒ violation; a bash event without a string `args.command` ⇒ violation. Run it in the execute phase's error path **and** success path before classification; a violation throws `omp-tool-rule-violated` with classification `{cause:"tool-rule-violated", workObserved:true, detail}` (so `retrySafe` is false and no in-phase retry).
- [ ] T5 exactly as spec §8 row T5, plus: violation then process timeout ⇒ run `failed`, cause `tool-rule-violated`; `write` to `xd://bash` ⇒ violation; compound required check verbatim ⇒ passes; T1 omp part (no rules ⇒ argv equals goldens; fake output byte-identical without `.tools.json`).
- [ ] Red, implement, green. Mutations per spec T5 + "skip `xd://` writes" + "run the check only on completed outcomes". Commit `feat(omp): detect commands outside the tool rules after the call; a violation ends the run`.

### Task 5: Report, collect, secrets, prompt (T6)

**Files:** Modify `src/control/worker.ts` (compute + write the report after `config` is parsed and before `runLoop`, also on the verify-saved-result path), `src/control/collect.ts` (`:41`, `:86`, `:152` pattern), `src/runtime/claude/prompts.ts` (`buildExecutorPrompt` `:146`), `src/runtime/toolRules.ts`; Test `tests/control/toolRulesCollect.test.ts`, `tests/runtime/claude/phasePrompts.test.ts` (add cases only).

**Interfaces:**
```ts
export function buildToolRulesReport(input: { rules: ToolRulesV1; kind: "claude"|"codex"|"omp"; installation: InstallationV1; codexNetwork: CodexNetworkSetting | null; env: NodeJS.ProcessEnv }): ToolRulesReportV1;
export async function writeToolRulesReport(runDir: string, report: ToolRulesReportV1): Promise<void>; // atomic, 0600
export function toolRulesPromptSection(rules: ToolRulesV1): string; // "" when called never; executor only
```
Rows order: `commands-closed`, commands as given, `network`, `secretEnv` as given (`present` = name set and non-empty in `env`). `baseline` ≤1024 B, `reason` ≤512 B via `boundedText`. Collect: top-level `toolRules` iff contract has `toolRules` and the file exists; stripped from protocol-4 terminal like `failureCause`.
- [ ] T6 exactly as spec §8 row T6 (real worker on fake agents; scan every file under `sourceDir` for the secret test value ⇒ 0 hits). Prompt: section present iff `toolRules` present; absent ⇒ executor prompt equals `golden-2a2ae53/executor-prompt.txt`.
- [ ] Red, implement, green. Mutations per spec T6 + "prompt section always emitted". Commit `feat(control): report tool rule status per run and return it from collect`.

### Task 6: Identity (T7) + paid claude probe

**Files:** Test `tests/control/toolRulesIdentity.test.ts`.
- [ ] T7 exactly as spec §8 row T7. Mutations: strip `toolRules` in `semanticContract`; add `toolRules` to `agentConfigHash`. Commit `test(control): a changed tool rule set cannot ride an allowance continuation`.
- [ ] Paid probe (authorised this round, Orca ledger `b37f7ce9`): one real `claude -p` on the cheapest model in a throwaway git dir under `/private/tmp/orca-b37f7ce9/claude-probe/`, `--permission-mode default --allowedTools "Bash(echo probe *)" --disallowedTools WebFetch WebSearch --model <cheapest>`, asking it to run `echo probe one`, `touch x`, and fetch `https://example.com` via WebFetch; record which ran/denied from the stream-json and the tool-reported `total_cost_usd`. Expected: echo runs, touch denied, WebFetch denied. If not, change the mapping, not the expectation, and log it.

### Task 7: Gate and land

- [ ] `npm run typecheck`, `npm run build` in the worktree (redirect to files).
- [ ] Full suite in a built clone of the branch: `./node_modules/.bin/vitest run --reporter=json --outputFile=<s>/vitest.json > <s>/vitest.log 2>&1; echo $?` then `node scripts/check-known-reds.mjs <s>/vitest.json; echo $?` ⇒ RC 0. Reds: rerun the file alone, compare with Orca `docs/handoff/known-load-flakes.md` ccloop section.
- [ ] Independent review of the branch diff against the spec (fresh subagent); fix; re-run touched tests.
- [ ] `git rebase main` (if moved), `git merge --ff-only feat/per-contract-tool-rules` on main, `unlink` worktree `node_modules`, `git worktree remove`, `git branch -d`.
