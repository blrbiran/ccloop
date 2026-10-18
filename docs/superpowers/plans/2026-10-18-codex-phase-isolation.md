# Codex Phase Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A codex loop phase (plan, execute, verify) runs in the installation's private `HOME`/`CODEX_HOME` pair with the operator's skills, `AGENTS.md`, hooks, MCP servers, `notify` and plugin/app blocks off, while the commands it runs keep the real `HOME`; a phase whose isolation cannot be set up is refused before spawn, final, booked 0.

**Architecture:** `runCodexPhase` gains an optional `installation`. With it (production, `codexDescriptor.createAdapter`), and only on the default phase argv (not a single call), it reads the catalog through the cache under the phase deadline, re-checks abort and deadline, then calls a new `codexPhaseIsolation` (new file `src/runtime/codex/codexPhaseIsolation.ts`) that builds the single call's per-installation pair (`codexSingleCallHome`, now with a phase-specific no-cache fallback dir) and the `-c` list, or throws a named `codex-phase-isolation-*` refusal that becomes the phase's `reason` and lands in `outcome.json`. `CodexAdapter.phase` turns that reason into an error carrying `neverStarted: true` (so `observedTokensOf` books 0), and `runLoop`'s existing `codex-skills-*` finality check is widened to the new family. Without an `installation` nothing changes.

**Tech Stack:** TypeScript (NodeNext, strict), vitest 2, Node fake CLI fixture `tests/fixtures/fake-codex.mjs`, codex-cli 0.163.0 for the free and paid checks.

**Spec:** `docs/superpowers/specs/2026-10-18-codex-phase-isolation-design.md` (ccloop `main`, commit subject `docs(spec): codex phase isolation design`).

Plan written by Orca session `a3b2a7a7` (Claude) on 2026-10-18 against the ccloop commit whose subject is `docs(spec): codex phase isolation design`. Line numbers below were read on that commit; re-measure before editing (ccloop Rule 14). Nothing in this plan was dry-run.

## Global Constraints

- Repo `W=/Users/biran/code/skills/orca/ccloop`, on a feature branch (not `main`). `SCRATCH` = the executor's session scratchpad; every verification output is redirected to a file under it and read back whole (ccloop Rule 14; `rtk proxy` for git/vitest so the rtk filter does not rewrite output). `export ECC_GATEGUARD=off DISABLE_OMC=1`.
- Test runner: `./node_modules/.bin/vitest run <files> --reporter=default --reporter=json --outputFile.json=$SCRATCH/<name>.json > $SCRATCH/<name>.out 2>&1; echo rc=$?`, then `node scripts/check-known-reds.mjs $SCRATCH/<name>.json` for any non-zero rc. Typecheck `npm run typecheck`; build `npm run build` (package.json).
- **No existing criterion is edited** (ccloop Rule 15). New tests only. Fixture changes are additive only (a new file written, never a changed answer). An existing test that turns red ⇒ stop and ask the human (see Task 4 Step 6).
- New tests that pass an `installation` set `CCLOOP_CACHE_DIR` to a fresh temp dir with `vi.stubEnv` (spec §3.3) — never the real `~/.cache/ccloop`. The global setup `tests/setup/relocateCatalogCache.ts` already relocates it; the stub is per-test on top.
- Phase `-c` constant (spec §3.3, with hooks folded in): `CODEX_PHASE_CONFIG = ["notify=[]", "features.plugins=false", "include_apps_instructions=false", "include_collaboration_mode_instructions=false", "features.hooks=false"]`. Never in the phase argv: `project_doc_max_bytes=0`, `include_environment_context=false`, `include_permissions_instructions=false`, any other `features.<tool>=…`.
- Per listed MCP server: `-c mcp_servers.<name>.enabled=false`; names must pass `addressableMcpServer` (`src/runtime/codex/codexSingleCall.ts:18`).
- Commands keep the real HOME (spec §3.4): `-c shell_environment_policy.set.HOME=<JSON.stringify(process.env.HOME)>` — exact form confirmed by Task 1; if Task 1 fails, stop.
- Refusal reasons (one family, spec §3.3 "builder's choice"): `codex-phase-isolation-no-mcp-list`, `codex-phase-isolation-mcp-unaddressable:<JSON name>`, `codex-phase-isolation-home-invalid:<path>`, `codex-phase-isolation-real-home-unknown`. All are final (not retried) and book usage 0 via `neverStarted` (spec §3.5).
- No-cache fallback pair for phases: `<runDir>/codex/<attempt>/phase-isolation/home-XXXXXX/{home,codex-home}` (spec §4: "builder names the exact path").
- Mutations only in a `git clone --local` copy under `$SCRATCH`, `npm run build` in the copy first, `cd` into the copy to run (ccloop Rule 17); restore proof = byte counts of `git diff` and `git diff --cached` in `$W`, before and after.
- `git add` explicit paths only. Commit messages English, conventional, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No push, no merge (ccloop Rule 13). Real codex: free commands only, except Task 7, which waits for the human's nod.

## Review Focus

1. **Hooks that run anyway, but write somewhere else.** ccmem's hook resolves its DB from `os.homedir()` (`ccmem/scripts/lib/paths.mjs:17`, `~/.claude/ccmem/global.db`). Under a private `HOME` a hook that still ran would write `<pair>/home/.claude/ccmem/global.db`, so "no row in the real DB" alone would stay green. Owner: Task 7 checks both the real DB and that `<pair>/home/.claude` and `<repo>/.ccmem` do not exist.
2. **An MCP server added mid-run.** The catalog cache key stamps `$CODEX_HOME/config.toml` (`catalogCache.ts` `configFilesOf`), so editing the installation's config.toml is a miss and the next phase must turn the new server off. Owner: Task 3 test `a server added to the installation's config.toml is off from the next phase on`.
3. **A refused phase must not touch the worktree.** Isolation is decided before `withCodexSkillLinks`; a refused phase with a `codexSkillsDir` must leave no `.agents/skills` link and no `<worktree>.codex-skills-pending`. Owner: Task 3 test `a refused phase links no skills`.
4. **Two codex phases at once on one installation** (two runs in parallel) share one pair; the links must stay intact and both must spawn isolated. Owner: Task 3 test `two concurrent phases share the pair and both run isolated`.
5. **An abort or deadline that lands during the catalog read** must read as aborted/timeout, not as a refusal (a probe cut short by the abort looks like "no MCP list"). Owner: Task 3 tests `an abort during the catalog read ends the phase as aborted` and `a catalog read that outlasts the phase deadline ends it as timeout`.

---

### Task 1: Baseline and the installed codex check (free; stop-and-ask exit)

**Files:** none in the repo. Scratch only: `$SCRATCH/baseline/*`, `$SCRATCH/probe/*`.

**Interfaces:**
- Produces: the confirmed `-c` value form for `shell_environment_policy.set.HOME` (default `shell_environment_policy.set.HOME="<real HOME>"`, a TOML basic string = `JSON.stringify(home)`), and confirmation that `features.hooks=false` is accepted, both on the installed codex. Recorded in `$SCRATCH/probe/result.md` with commands and the ccloop commit subject.

- [ ] **Step 1: Baseline** — run the handoff's "先跑这些" block (`docs/handoff/handoff.md` top): typecheck, build, full vitest with JSON report into `$SCRATCH/baseline/`, `check-known-reds` rc 0. Record total/passed/failed/skipped from the JSON (Task 5 compares against it).

- [ ] **Step 2: Version** — `codex --version > $SCRATCH/probe/version.txt 2>&1`. Expected `codex-cli 0.163.0` (spec §1.1). A different version is not a stop, but every later expectation is re-read against it and the version goes in the commit message of Task 3.

- [ ] **Step 3: Private pair and probe repo** (as spec §1.1): `P=$SCRATCH/probe`; `mkdir -m 700 -p $P/pair/home $P/pair/codex-home`; `ln -s ~/.codex/auth.json $P/pair/codex-home/auth.json`; `ln -s ~/.codex/config.toml $P/pair/codex-home/config.toml`; a fresh git repo `$P/repo` with `AGENTS.md` = `ORCA-PROBE-AGENTS-MARKER` and `.agents/skills/orca-probe-skill/SKILL.md` (frontmatter `name: orca-probe-skill`, description containing `ORCA-PROBE-SKILL-MARKER`). Let `PRIV="HOME=$P/pair/home CODEX_HOME=$P/pair/codex-home"`.

- [ ] **Step 4: MCP list under isolation** — `env $PRIV codex -c notify=[] -c features.plugins=false mcp list --json > $P/mcp.json 2> $P/mcp.err; echo rc=$? > $P/mcp.rc`. Build `MCP_ARGS` (one `-c mcp_servers.<name>.enabled=false` per name) by hand from the whole file.

- [ ] **Step 5: prompt-input, three runs** (cwd `$P/repo`, each `> $P/pi-<x>.json 2> $P/pi-<x>.err; echo rc=$?`):
  - A: `env $PRIV codex -c notify=[] -c features.plugins=false -c include_apps_instructions=false -c include_collaboration_mode_instructions=false -c features.hooks=false $MCP_ARGS debug prompt-input hi`
  - B: A plus `-c 'shell_environment_policy.set.HOME="'"$HOME"'"'`
  - C: the operator's real `HOME`/`CODEX_HOME`, `-c notify=[]` only (the §1.1 control row).
  Then, on the saved files only: `wc -c`, and `grep -c -E 'brainstorming|rtk'`, `grep -c ORCA-PROBE-AGENTS-MARKER`, `grep -c ORCA-PROBE-SKILL-MARKER` per file, each into its own output file.
  Expected: A and B rc 0, no config error in `.err`; personal-skill count 0 in A and B, ≥1 in C (the control proves the count can be non-zero); both markers ≥1 in A, B, C.

- [ ] **Step 6: Commands see the real HOME (free sandbox run)** — cwd `$P/repo`:
  - D: `env $PRIV codex -c 'shell_environment_policy.set.HOME="'"$HOME"'"' sandbox -- /bin/sh -c 'printf %s "$HOME"' > $P/sb-d.txt 2> $P/sb-d.err; echo rc=$?`
  - E: same without the `-c` (control).
  Expected: D prints the real `$HOME`, E prints `$P/pair/home`. If `codex sandbox` does not apply `shell_environment_policy` (D = E), record "inconclusive on the free path" — not a stop; Task 7 is the authority.

- [ ] **Step 7: Decide.** **STOP and ask the human (do not start Task 2)** if any of: A or B rc ≠ 0 or a config error naming `shell_environment_policy` or `features.hooks`; a personal-skill line in B; a marker missing in A or B; D prints something that is neither the real nor the private HOME. Otherwise write `$P/result.md`: the exact accepted `-c` form, the five rc values, the byte counts, the counts, D/E outputs, the commit subject.

---

### Task 2: The phase isolation module

**Files:**
- Modify: `src/agents/codexIsolation.ts` — add `CODEX_PHASE_CONFIG` after line 21; `codexSingleCallHome` (line 98) gains an optional fallback path; registration comment (lines 79–97) appended in Task 5.
- Create: `src/runtime/codex/codexPhaseIsolation.ts`
- Test: `tests/runtime/codex/codexPhaseIsolation.test.ts`

**Interfaces:**
- Consumes: `codexSingleCallHome`, `effectiveCodexHome` (`src/agents/codexIsolation.ts`), `addressableMcpServer` (`src/runtime/codex/codexSingleCall.ts:18`), `InstallationV1` (`src/agents/types.ts`).
- Produces:
  - `export const CODEX_PHASE_CONFIG: readonly string[]` (values in Global Constraints) in `src/agents/codexIsolation.ts`.
  - `codexSingleCallHome(input: { runDir: string; sourceCodexHome: string | null; executable: string; env: NodeJS.ProcessEnv; fallback?: readonly string[] })` — `fallback` defaults to `["codex", "1", "single-call"]` (today's path, unchanged for every existing caller).
  - `export type CodexPhaseIsolationReason = \`codex-phase-isolation-${string}\``
  - `export class CodexPhaseIsolationRefused extends Error { readonly neverStarted = true; constructor(readonly reason: CodexPhaseIsolationReason) }` — `message === reason`, `name = "CodexPhaseIsolationRefused"`.
  - `export function codexPhaseConfigArgs(mcpServers: readonly string[], realHome: string): string[]` — `["-c", v]` pairs for `CODEX_PHASE_CONFIG`, then each `mcp_servers.<name>.enabled=false`, then `shell_environment_policy.set.HOME=${JSON.stringify(realHome)}` (form per Task 1).
  - `export async function codexPhaseIsolation(input: { installation: InstallationV1; mcpServers: readonly string[] | null; runDir: string; attempt: number; env: NodeJS.ProcessEnv }): Promise<{ home: string; codexHome: string; args: string[] }>` — order: (1) pair via `codexSingleCallHome({ runDir, sourceCodexHome: effectiveCodexHome(installation, env), executable: installation.command[0], env, fallback: ["codex", String(attempt), "phase-isolation"] })`, an error with `code === "codex-single-call-home-invalid"` rethrown as `codex-phase-isolation-home-invalid:<path>`; (2) `mcpServers === null` ⇒ `no-mcp-list`; (3) first non-addressable ⇒ `mcp-unaddressable:${JSON.stringify(name)}`; (4) `env.HOME` empty or not absolute ⇒ `real-home-unknown`. Order (1) before (2) follows the single call's fix round 3 (a symlinked private dir is named as such).

- [ ] **Step 1: Write the failing tests** — `tests/runtime/codex/codexPhaseIsolation.test.ts`. Header comment: spec 2026-10-18 §3.3/§3.4/§3.5 — a dispatched codex phase must not carry the operator's personal setup, and must refuse rather than run unisolated. Fixture: temp dir, a source codex home with `auth.json` and `config.toml`, installation `{ kind: "codex", command: [process.execPath, <any>], version: "9.9.9-fake", configDir: <source>, timeoutMs: 10000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft" }`, `env = { HOME: <tmp>/real-home, CCLOOP_CACHE_DIR: <tmp>/cache }`.
  - `phase -c list holds exactly the five phase values, the MCP offs and the real HOME for commands` — `codexPhaseConfigArgs(["figma","ccmem_x"], "/h")` equals `["-c","notify=[]","-c","features.plugins=false","-c","include_apps_instructions=false","-c","include_collaboration_mode_instructions=false","-c","features.hooks=false","-c","mcp_servers.figma.enabled=false","-c","mcp_servers.ccmem_x.enabled=false","-c","shell_environment_policy.set.HOME=\"/h\""]`.
  - `quotes a real HOME with quotes and backslashes as a TOML string` — `codexPhaseConfigArgs([], '/t/a "b"\\c').at(-1)` is `'shell_environment_policy.set.HOME="/t/a \\"b\\"\\\\c"'`.
  - `uses the single call's pair for the same installation` — `codexPhaseIsolation(...)` returns `home`/`codexHome` equal to `codexSingleCallHome({ ..., runDir: "" })`'s for the same installation and env; `readlink(codexHome/auth.json)` = `<source>/auth.json`.
  - `without a cache dir the pair lives under the attempt's phase-isolation dir` — env `CCLOOP_CACHE_DIR: "relative"` (⇒ `catalogCacheDir` null), attempt 3: `home` starts with `join(runDir,"codex","3","phase-isolation","home-")`.
  - `refuses with no MCP list` — `mcpServers: null` rejects `{ reason: "codex-phase-isolation-no-mcp-list", neverStarted: true }`.
  - `refuses an MCP name -c cannot address` — `["ok","bad.name"]` rejects with reason `codex-phase-isolation-mcp-unaddressable:"bad.name"`.
  - `refuses a symlinked private dir, named as such` — pre-create the pair's parent then replace `home` with a symlink (pair path computed as in `tests/runtime/codex/codexSingleCall.test.ts:79`); rejects with reason `codex-phase-isolation-home-invalid:<that path>`, `neverStarted: true`; also with `mcpServers: null` the reason is still `home-invalid`.
  - `refuses when the real HOME is unknown` — `env.HOME` `""`, then `"rel"`: both reject `codex-phase-isolation-real-home-unknown`.

- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement** the Interfaces above. In `codexSingleCallHome` replace the literal `["codex", "1", "single-call"]` (line 103) by `input.fallback ?? [...]`; nothing else in that function changes.
- [ ] **Step 4: Run** the new file plus `tests/runtime/codex/codexSingleCall.test.ts` and `tests/agents` — all pass; typecheck rc 0.
- [ ] **Step 5: Named mutations** (run in Task 5): **M1** drop `"features.hooks=false"` from `CODEX_PHASE_CONFIG` → `phase -c list…` red. **M2** `JSON.stringify(realHome)` → `realHome` → `quotes a real HOME…` red. **M3** fallback ignored (always single-call parts) → `without a cache dir…` red. **M4** remove the `mcpServers === null` check → `refuses with no MCP list` red. **M5** remove the addressable check → `refuses an MCP name…` red. **M6** home-invalid error not mapped (rethrown as is) → `refuses a symlinked private dir…` red. **M7** swap steps (1) and (2) → the `mcpServers: null` half of the symlink test red. **M8** remove the real-HOME check → `refuses when the real HOME is unknown` red.
- [ ] **Step 6: Commit** `feat(codex): phase isolation module (private pair, -c list, named refusals)`.

---

### Task 3: `runCodexPhase` runs isolated when given an installation

**Files:**
- Modify: `src/runtime/codex/runCodexPhase.ts` (reason union line 15, signature line 22, argv lines 30–32, `persist` line 38, after the timeout check line 43, spawn env line 50, timer line 71)
- Modify (additive fixture): `tests/fixtures/fake-codex.mjs` — after the phase `writeFileSync(marker, …)` (currently line 81), also `writeFileSync(marker+".phase-env.json", JSON.stringify({HOME:process.env.HOME??null, CODEX_HOME:process.env.CODEX_HOME??null}))`, with a dated comment line in the header block. Nothing else in the fixture changes.
- Test: `tests/runtime/codex/phaseIsolation.test.ts`

**Interfaces:**
- Consumes: Task 2's `codexPhaseIsolation`, `CodexPhaseIsolationRefused`; `readAgentCatalog` (`src/agents/agentCatalog.ts:38`).
- Produces:
  - `runCodexPhase(config: CodexConfig, request: PhaseRequest, extraEnv?: Record<string,string>, codexSkillsDir?: string, installation?: InstallationV1): Promise<PhaseOutcome>`
  - `PhaseOutcome["reason"]` gains `` `codex-phase-isolation-${string}` ``.
  - `outcome.json` gains, only when isolation applied (installation given), `isolation: { home: string | null; codexHome: string | null; catalogError: string | null }` (paths only; null when refused before the pair existed). Without it, `outcome.json` is byte-identical to today.
- Isolation applies iff `installation !== undefined`. `CodexAdapter.singleCall` never passes one (it brings its own `spawn`), so no `request.spawn` guard is added (Rule 2).
- Behaviour, in order, only when isolation applies: after the existing abort and `timeout<=0` checks, `deadline = Date.now() + timeout`; `catalog = await readAgentCatalog(installation, { deadline, signal: context.abortSignal, log: line => process.stderr.write(line + "\n") })`; aborted ⇒ `reason "aborted"`, persist; `Date.now() >= deadline` ⇒ `reason "timeout"`, persist; `codexPhaseIsolation({ installation, mcpServers: catalog.codexMcpServers, runDir: context.runDir, attempt: context.attempt, env: process.env })`, a `CodexPhaseIsolationRefused` ⇒ `reason = error.reason`, persist (any other error propagates as today). On success: argv = today's default argv with the isolation `args` inserted before the final `"-"`; spawn env `{...process.env, ...extraEnv, HOME: home, CODEX_HOME: codexHome}`; the child timer gets `deadline - Date.now()` instead of `timeout`. All of this happens before `save("schema.json")` and before `withCodexSkillLinks`. Legacy path (no installation; this includes every single call): unchanged, timer still `timeout`.

- [ ] **Step 1: Write the failing tests** — fixture = `codexFixture("integration")` (`tests/runtime/codex/fixture.ts`) plus a source codex home dir with `auth.json`/`config.toml`, installation built from `f.config` (as Task 2, `command: f.config.command`, `configDir: <source>`), `vi.stubEnv("CCLOOP_CACHE_DIR", <fresh temp>)`, `<marker>.catalog.json` = `{ mcp: [{name:"figma",enabled:true},{name:"ccmem_x",enabled:true}] }`. Helpers: `args()` = `JSON.parse(read(marker)).args`, `cValues(args)` = values after each `-c`, `phaseEnv()` = `JSON.parse(read(marker+".phase-env.json"))`. Header comment: spec 2026-10-18 §3.3, §3.5, §5.
  - `an isolated phase runs with the installation's private HOME and CODEX_HOME` — `phaseEnv()` equals `{HOME: join(base,"home"), CODEX_HOME: join(base,"codex-home")}`, `base` computed as in `codexSingleCall.test.ts:79` from the stubbed cache dir and `<source>`.
  - for each value `v` of the five `CODEX_PHASE_CONFIG` values, `mcp_servers.figma.enabled=false`, `mcp_servers.ccmem_x.enabled=false`, and `shell_environment_policy.set.HOME=${JSON.stringify(process.env.HOME)}`: test `an isolated phase sends -c ${v}` — `cValues(args())` contains `v` (one `beforeAll` phase run shared by these; `for … of`, not `it.each`).
  - `an isolated phase keeps repo docs, environment context, permissions and tool flags` — `cValues` contains none of `project_doc_max_bytes=0`, `include_environment_context=false`, `include_permissions_instructions=false`, and no value matching `/^features\.(?!plugins=|hooks=)/`; `args().at(-1)` is `"-"`; the slice of `args()` before the first `"-c"` equals today's default argv for the phase.
  - `the execute phase keeps its sandbox under isolation` — execute phase: `args()` contains `"--sandbox","workspace-write"`.
  - `outcome.json records the isolation paths` — `JSON.parse(outcome.json).isolation` equals `{home, codexHome, catalogError: null}` of the first test.
  - `a phase with no MCP list is refused before spawn and leaves its evidence` — catalog.json `{ mcpExitCode: 1 }`: `reason === "codex-phase-isolation-no-mcp-list"`; `<marker>.argv` absent; `evidenceDir/outcome.json` `reason` equal and `isolation.home` a string; no `process.json` in `evidenceDir`.
  - `a phase with an unaddressable MCP name is refused before spawn` — `mcp: [{name:"bad.name",enabled:true}]` ⇒ reason `codex-phase-isolation-mcp-unaddressable:"bad.name"`, no `<marker>.argv`.
  - `a phase whose private home is a symlink is refused before spawn` — reason starts with `codex-phase-isolation-home-invalid:`, no `<marker>.argv`.
  - `a refused phase links no skills` (Review Focus 3) — refusal as above with `codexSkillsDir` holding `selected/SKILL.md`: no `<worktree>/.agents/skills/selected`, no `<worktree>.codex-skills-pending`.
  - `an isolated phase still links and removes Orca's skills` — mode `skill-integration` with a `codexSkillsDir`: completed, `<marker>.skills` contains the SKILL.md text, the link is gone after, and `phaseEnv().CODEX_HOME` is the pair's `codex-home`.
  - `an abort during the catalog read ends the phase as aborted` (Review Focus 5) — catalog.json `{ sleepMs: 2000 }`, abort when `<marker>.catalog-calls` exists: `reason === "aborted"`, no `<marker>.argv`.
  - `a catalog read that outlasts the phase deadline ends it as timeout` (Review Focus 5) — `timeRemainingMs: 300`, catalog.json `{ sleepMs: 1000 }`: `reason === "timeout"`, no `<marker>.argv`.
  - `a server added to the installation's config.toml is off from the next phase on` (Review Focus 2) — phase 1 completes; rewrite `<source>/config.toml` with different content and catalog.json `mcp` + `{name:"added"}`; phase 2's `cValues` contains `mcp_servers.added.enabled=false`.
  - `two concurrent phases share the pair and both run isolated` (Review Focus 4) — two fixtures with distinct markers but the same installation shape and source: `Promise.all` of two plan phases ⇒ both `completed`, both `phase-env.json` equal, `readlink(codex-home/auth.json)` still `<source>/auth.json`.
  - `without an installation a phase spawns exactly as before` — `runCodexPhase(config, req, {CODEX_HOME:"/x"})`: `phaseEnv().HOME === process.env.HOME`, `CODEX_HOME === "/x"`, no `"-c"` in `args()`, `outcome.json` has no `isolation` key.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per Interfaces/Behaviour.
- [ ] **Step 4: Run** the new file and `tests/runtime/codex` whole — all pass (known-reds roster only); typecheck rc 0.
- [ ] **Step 5: Named mutations:** **M9** spawn env without `HOME: home` → `…private HOME and CODEX_HOME` red. **M10** without `CODEX_HOME: codexHome` → same test red. **M11** isolation `args` not inserted → every `sends -c …` red. **M12** `CODEX_PHASE_CONFIG` replaced by `CODEX_SINGLE_CALL_CONFIG` in Task 2's `codexPhaseConfigArgs` → `keeps repo docs…` red. **M13** drop `isolation` from `outcome.json` → `outcome.json records…` red. **M14** refusal branch spawns anyway (catch and continue with `[]`) → the three `refused before spawn` tests red. **M15** isolation after `withCodexSkillLinks` → `a refused phase links no skills` red. **M16** remove the abort re-check → `an abort during the catalog read…` red. **M17** remove the deadline re-check → `…outlasts the phase deadline…` red. **M18** isolation skipped when `codexSkillsDir` is set → `an isolated phase still links and removes Orca's skills` red once it also asserts `phaseEnv().CODEX_HOME` is the pair's `codex-home` (add that assertion to the test).
- [ ] **Step 6: Commit** `feat(codex): run loop phases in the installation's private homes (spec 2026-10-18 §3.3)`.

---

### Task 4: Adapter, controller finality and zero booking

**Files:**
- Modify: `src/runtime/codex/codexAdapter.ts` — line 59 (pass `this.installation` as 5th arg), lines 80–84 (error for the new family), comment near line 43 (no installation ⇒ legacy unisolated spawn, spec §3.3).
- Modify: `src/controller/runLoop.ts:494-497` — `isCodexSkillFailure` regex `/^(?:Error: )?codex-(?:skills|phase-isolation)-/`, with a comment citing spec 2026-10-18 §3.5.
- Test: `tests/runtime/codex/phaseIsolationAdapter.test.ts`

**Interfaces:**
- Consumes: Task 3's `runCodexPhase(..., installation)` and reason family; `observedTokensOf` (`src/runtime/types.ts:174`).
- Produces: `CodexAdapter.phase` throws, for `outcome.reason` starting `codex-phase-isolation-`, `Object.assign(new Error(\`${reason}: ${evidenceDir}\`), { neverStarted: true })` — comment: "spec 2026-10-18 §3.5: refused before spawn, no process and no token; named exception to 'usage is never booked as 0'". `callWithBackoff` is unchanged (it only classifies `exit-error`/`io-error`, so a refusal returns on the first call).

- [ ] **Step 1: Write the failing tests** (fixture as Task 3; adapter `new CodexAdapter(f.config, {CODEX_HOME:<source>}, undefined, { installation, rateLimitDelaysMs: [10,10,10] })`):
  - `a refused phase throws neverStarted and books 0` — catalog.json `{ mcpExitCode: 1 }`: `adapter.plan(ctx)` rejects; error message starts `codex-phase-isolation-no-mcp-list: `; `observedTokensOf(error) === 0`; exactly one `call-*` dir under `runDir/codex/1/plan`.
  - `a run whose plan phase is refused fails with the refusal, books 0 and is not retried` — `f.contract.executionPolicy.maxAttempts = 2`; `runLoop(contract, runDir, adapter, { onPhaseSettled })` (pattern: `tests/runtime/codex/rateLimitRunLoop.test.ts`): `status "failed"`, `stopReason` matches `/codex-phase-isolation-no-mcp-list: /`, settled phases equal `[objectContaining({ phase: "plan", tokenUsage: 0 })]`, no `<marker>.argv`.
  - `a refusal under a handoff request still fails the run, not a handoff boundary` — catalog.json `{ sleepMs: 300, mcpExitCode: 1 }`; `stopRequested = createStopRequestSignal()`; set `requested = true` once `<marker>.catalog-calls` exists: `status "failed"`, `stopReason` contains `codex-phase-isolation-no-mcp-list`.
  - `the descriptor's adapter isolates codex phases` — `codexDescriptor.createAdapter(materialized)` with fake codex and `configDir: <source>`: `.plan(ctx)` resolves; `phase-env.json` `CODEX_HOME` is the pair's `codex-home`, not `<source>`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per Files/Interfaces.
- [ ] **Step 4: Run** the new file + `tests/runtime/codex` + `tests/controller` — pass.
- [ ] **Step 5: Named mutations:** **M19** drop `neverStarted: true` → first two tests red (`0` vs `null`). **M20** revert the `isCodexSkillFailure` regex → `a refusal under a handoff request…` red (handoff boundary). **M21** adapter does not pass `this.installation` → `the descriptor's adapter isolates…` red.
- [ ] **Step 6: Existing-criteria check — STOP point.** Run `tests/control tests/runtime tests/cli tests/controller` with the JSON report and `check-known-reds`. Prediction from reading (not run): **`tests/control/codexSkillsFailureWorker.test.ts` (both cases) turns red** — its fixture wrapper `tests/runtime/codex/skillsControllerFixture.ts` answers `--version` but crashes on `debug models`/`features list`/`mcp list` (it reads `--output-schema` from argv), so the worker's phase now refuses with `codex-phase-isolation-no-mcp-list` instead of reaching `codex-skills-cleanup-failed`. And **`tests/runtime/codex/extraEnv.test.ts` › "sets CODEX_HOME from the installation's configDir through the descriptor's adapter"** stays green only by accident (the last writer of `seen.json` becomes the catalog's `debug models` probe; the phase itself is refused), so its stated intent no longer holds under spec §3.3. If any existing test is red, or for the extraEnv one in any case: **do not edit; stop and report to the human** with the test's full name, the cause, and the proposed minimal change (for the wrapper: forward every call without `exec` to fake-codex unchanged), and wait for the human to name the test (ccloop Rule 15 (a)–(c)).
- [ ] **Step 7: Commit** `feat(codex): a phase refused before spawn is final and books 0 (spec 2026-10-18 §3.5)`.

---

### Task 5: Notes, registration, full gate and mutations

**Files:**
- Modify: `src/agents/codexIsolation.ts` registration comment (lines 79–97): append a dated paragraph (not rewriting): writer (3) every codex loop phase, every call (`runCodexPhase` with an installation), creates missing dirs and re-checks the two links; no-cache fallback `<runDir>/codex/<attempt>/phase-isolation/home-*`; residue unchanged. Orca session `a3b2a7a7`, spec 2026-10-18 §4.
- Modify: `src/agents/materialize.ts:76` — append below the line, not replacing it: `// *** 2026-10-18 (codex phase isolation spec §3.3, human ruling): loop phases now need the MCP server list; each codex phase reads the catalog itself and refuses when the list is missing. This note's "loop phases do not need it" no longer holds for codex phases; materialize still does not refuse. ***`

- [ ] **Step 1: Full gate** — typecheck, build, full vitest JSON report, `check-known-reds` rc 0. `total` = Task 1 baseline total + the new tests (count them from the three new files); `pending`/`todo` 0; any skip reported (Rule 12).
- [ ] **Step 2: Mutations M1–M21** in `git clone --local $W $SCRATCH/mut` (after committing Tasks 2–4; `npm run build` in the copy; `cd` into it). One mutation at a time: apply, run the named test file(s) with JSON report, record which named tests are red, restore with `git -C $SCRATCH/mut checkout -- .`. M0 = the unmutated copy, all named tests green. Pass: every mutation turns its named test(s) red. A mutation that stays green is a gap: add a test (never edit one) and rerun all mutations (Rule 17: code changed ⇒ rerun).
- [ ] **Step 3: Restore proof** — `rtk proxy git -C $W diff | wc -c` and `--cached` before Step 2 and after; equal.
- [ ] **Step 4: Commit** `docs(codex): register phase isolation as an out-of-repo writer; date the materialize note`.

---

### Task 6: Free acceptance on the real codex through ccloop's own path

**Files:** none in the repo. `$SCRATCH/accept/*`.

**Interfaces:**
- Consumes: built `dist/src/runtime/codex/codexPhaseIsolation.js` (`codexPhaseIsolation`, `codexPhaseConfigArgs`), `dist/src/agents/agentCatalog.js` (`readAgentCatalog`).

- [ ] **Step 1:** Write `$SCRATCH/accept/probe.mjs` (scratch, not committed): installation `{kind:"codex", command:[<which codex>], version:<Task 1>, configDir:null, …}`; `CCLOOP_CACHE_DIR=$SCRATCH/accept/cache` in its env (never the real cache); `catalog = readAgentCatalog(installation)`; `iso = codexPhaseIsolation({installation, mcpServers: catalog.codexMcpServers, runDir: $SCRATCH/accept/run, attempt: 1, env: process.env})`; spawn `codex ...iso.args debug prompt-input hi` with `{...process.env, HOME: iso.home, CODEX_HOME: iso.codexHome}`, cwd = Task 1's `$P/repo`; write stdout/stderr/rc to files.
- [ ] **Step 2:** On the saved output only: bytes, `grep -c -E 'brainstorming|rtk'` = 0, both markers ≥ 1, rc 0. Compare with Task 1's row C (personal skills ≥ 1). Record in `$SCRATCH/accept/result.md` with the commit subject. Any failure ⇒ stop and report.

---

### Task 7: The one paid check — **needs the human's nod before running**

**Files:** none in the repo. `$SCRATCH/paid/*`.

- [ ] **Step 0: Ask.** Put to the human: model (handoff: `gpt-6-luna` worked on 0.160.0; installed is 0.163.0), one execute-phase call, cost is unknown until the tool reports it. Do nothing below without an explicit yes.
- [ ] **Step 1: Before** — `sqlite3 -readonly ~/.claude/ccmem/global.db 'select count(*) from session_context' > $SCRATCH/paid/before.txt`.
- [ ] **Step 2: One call** — scratch script against the clone's `dist`: `runCodexPhase(config{command:[codex], model:<agreed>, sandbox:"workspace-write", budgetMode:"soft", timeoutMs:300000, killGraceMs:250}, {phase:"execute", prompt:<"Run exactly this one shell command and nothing else: printf '%s\n' \"$HOME\" > home-probe.txt — then answer per the schema with changedFiles [\"home-probe.txt\"].">, context}, undefined, undefined, installation)` in a fresh scratch git repo, `CCLOOP_CACHE_DIR=$SCRATCH/paid/cache`.
- [ ] **Step 3: After** — whole files only: `home-probe.txt` equals the real `$HOME` (spec §3.4); `outcome.json` has `isolation.home`/`codexHome`; session id = `thread_id` of `thread.started` in `events.jsonl`; `sqlite3 -readonly ~/.claude/ccmem/global.db "select count(*) from session_context where session_id='<id>'"` = 0 and the total equals Step 1's; `<isolation.home>/.claude` and `<repo>/.ccmem` do not exist (Review Focus 1); usage = what `usage.json` reports (Rule 14: no estimate).
- [ ] **Step 4:** Record in `$SCRATCH/paid/result.md` (command, commit subject, outputs). Any failed check ⇒ report; no fix without a new round.

---

## Not in this plan (Orca side, for the controller)

- Orca spec 2026-10-15 §11 (out-of-repo writers) names the new writer: an appended, dated correction section (Orca Rule 13), done in the Orca repo, not by this plan's executor.
- ccloop `docs/handoff/handoff.md` closing the "codex 阶段调用仍带着操作者的 skills／AGENTS.md" item, after the human merges.
