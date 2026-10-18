# Codex phases: stop carrying the operator's skills, AGENTS.md, hooks and MCP servers

Orca session `a3b2a7a7`, 2026-10-18. Closes the gap registered in Orca spec
`docs/superpowers/specs/2026-10-15-every-agent-requirement-chain-design.md` §2.5 and §10 ("the codex phase adapter
still carries the person's skills and AGENTS.md") and in this repo's handoff ("codex 阶段调用仍带着操作者的
skills／AGENTS.md").

## 1. Problem

A codex loop phase (plan, execute, verify; `src/runtime/codex/runCodexPhase.ts`, default argv branch) spawns codex
with the operator's own `HOME` and, through `extraEnv`, the installation's `CODEX_HOME`. Codex then injects into every
phase prompt whatever that machine holds for that person: the skills under `~/.agents/skills` and `$CODEX_HOME/skills`,
`$CODEX_HOME/AGENTS.md`, the hooks in `$CODEX_HOME/hooks.json` (since 2026-10-17 that includes ccmem's three hooks),
the MCP servers and `notify` program in `config.toml`, the recommended-plugins block. None of it belongs to the target
repo or to the run, so the same task gives different prompts on different machines or on different days, and Orca's
rule that a run is reproducible does not hold for codex phases. The codex **single call** already runs isolated
(`src/agents/codexIsolation.ts`, `CodexAdapter.singleCall`); the phases do not.

### 1.1 Measurement (free; codex-cli 0.163.0, `codex debug prompt-input hi`, no request sent)

A fresh git repo holding a marker `AGENTS.md` and a marker skill at `.agents/skills/orca-probe-skill/SKILL.md` (the
place `withCodexSkillLinks` links Orca's skills into); private dirs made like `codexSingleCallHome` (empty `home`,
`codex-home` with `auth.json` and `config.toml` symlinked to `~/.codex`). Bytes are the whole `prompt-input` output.
"Personal skills" = lines matching `brainstorming|rtk` (two of the operator's personal skills).

| setup | bytes | repo skill | repo `AGENTS.md` | personal skills |
|---|---|---|---|---|
| the operator's real `HOME` and `CODEX_HOME`, `-c notify=[]` | 68018 | present | present | present (2 lines) |
| private `HOME` + private `CODEX_HOME`, `-c notify=[] -c features.plugins=false` | 13269 | present | present | absent |
| same + `-c features.skip_host_skill_discovery=true` | 13272 | present | present | absent |

So private homes alone remove everything personal and keep both things the run should keep; `skip_host_skill_discovery`
neither helps nor hurts the repo skill (not needed here). Script and outputs: Orca session scratchpad
`/private/tmp/claude-501/-Users-biran-code-skills-orca-Orca/a3b2a7a7-fc30-4a71-8a6d-f89b666d217f/scratchpad/skillprobe/`
(temporary; the numbers above are the record).

## 2. Ruling

The Orca controller recommended, in chat on 2026-10-18, the split in §3 and asked whether any personal skill should
still travel with dispatched codex calls. The human answered, verbatim: 「没有，个人 skills 都不带，按你的建议来」.
That answer is the ruling for §3.1 and §3.2. §3.3 onwards is design.

After a builder check of this document the controller put three more questions to the human in one message, each with
a recommendation: (1) commands inside the phase keep the operator's real `HOME` (§3.4); (2) a phase refused before
spawn is final, not retried, and books usage 0 (§3.5); (3) an unreadable codex catalog refuses codex phases (§3.3,
"Where the MCP list comes from"). The human answered, verbatim: 「按建议」. That answer is the ruling for §3.4, §3.5
and the refusal on an unreadable catalog.

## 3. What a codex phase carries

The test for each item: does it travel with **this repo and this run**, or with **this machine and this person**?

### 3.1 Kept

1. **The target repo's own files**, including its `AGENTS.md` and any repo-level codex config codex reads from the
   worktree. They are versioned with the code, identical for the same commit, and they are the repo owner's rules for
   agents working there (Orca Rule 16: Orca never loosens a target repo's rules). So `project_doc_max_bytes` is **not**
   set to 0 here (unlike the single call).
2. **The skills Orca hands over** through `codexSkillsDir` (linked into `<worktree>/.agents/skills` for the call and
   removed after; unchanged). Frozen per run, recorded.
3. **Credentials and provider config**: `auth.json` and `config.toml` of the installation's effective CODEX_HOME,
   reached through symlinks, never copied (as the single call).
4. **What comes with the codex version**: its bundled skills, its environment context (cwd, shell), its permissions
   instructions (the execute phase runs in a writable sandbox and the model needs to be told so). These depend on the
   codex build, which the run already records, not on the operator.

### 3.2 Dropped

1. The operator's personal skills (`~/.agents/skills`, `$CODEX_HOME/skills`) and `$CODEX_HOME/AGENTS.md`.
2. The operator's codex hooks (`$CODEX_HOME/hooks.json`), ccmem's included. A dispatched run must not be recorded as the
   person's own session or receive per-session memory context; Orca's way to write to ccmem is an explicit channel
   (Orca handoff item 11), not hooks.
3. MCP servers defined in the linked `config.toml`, the `notify` program, the recommended-plugins block, the apps and
   collaboration-mode instructions.

No allow-list of personal skills: a skill the person wants a dispatched codex to use goes through `codexSkillsDir`.

### 3.3 Mechanism

- **Homes**: the phase spawn gets `HOME=<private home>` and `CODEX_HOME=<private codex-home>` from the same function the
  single call uses (`codexSingleCallHome`, `src/agents/codexIsolation.ts`), fed with the same source CODEX_HOME. Today
  the phase's source CODEX_HOME is `extraEnv.CODEX_HOME` (the installation's `configDir`); with an `installation` the
  source is `effectiveCodexHome(installation, process.env)`, which already prefers `configDir`. Without an
  `installation` (legacy config path) the builder derives the same order from `extraEnv` and `process.env`.
  Reusing the single call's per-installation pair is the controller's call (codex keeps ~2.4 MB of its own state there,
  measured in the every-agent Task 0; one pair per installation was the human's ruling for the single call). Concurrent
  codex processes on one CODEX_HOME are what a person's own `~/.codex` sees every day.
- **`-c` overrides for phases** (a new constant beside `CODEX_SINGLE_CALL_CONFIG`, not that one, which also turns off
  project docs, environment context and permissions instructions that phases keep):
  `notify=[]`, `features.plugins=false`, `include_apps_instructions=false`,
  `include_collaboration_mode_instructions=false`, and `mcp_servers.<name>.enabled=false` for every MCP server the
  installation's catalog lists (`readAgentCatalog(...).codexMcpServers`, the same probe the single call uses).
  Tool feature flags are **not** touched: phases need their tools.
- **Refusals before spawn** follow the single call: no MCP server list (`codexMcpServers === null`), or a server name
  `-c` cannot address (`addressableMcpServer`), or a private dir that is not a real directory of this user, refuse the
  phase without spawning. The error codes are the builder's, named in the same family (`codex-phase-isolation-*` or
  reuse of `codex-single-call-home-invalid` for the home check, builder's choice, recorded in the plan).
- **Hooks off explicitly** (controller's call): phases also send `-c features.hooks=false`, as the single call does.
  Not linking `hooks.json` is not enough: codex also reads hook definitions from the config layer, and the linked
  `config.toml` carries `hooks.state` entries naming absolute paths under the real `~/.codex`. `hooks` is not a tool
  flag, so §3.3's "tool flags untouched" does not cover it.
- **Where the MCP list comes from** (controller's call): `readAgentCatalog` on every phase, as the single call, through
  the catalog cache (30-minute lifetime; a miss runs the isolated probes inside the phase's deadline). The list is what
  to turn **off**, so reading it fresh is the safe direction: a server added mid-run is off from the next phase on. A
  missing **feature** list does not refuse a phase (phases do not touch tool flags). A missing **MCP server** list
  does refuse it (human's ruling, §2): while the catalog probe is broken every codex phase fails, with an error naming
  that cause, rather than running with the operator's MCP servers on. This supersedes, for codex phases,
  the `materialize.ts:76` note "a codex catalog that cannot be read is not a refusal here (plan issue 5): loop phases do
  not need it" -- written when phases did not need it; the plan appends a dated note there rather than rewriting it.
- **No `installation`** (controller's call): production always passes one (`src/agents/codex.ts`). An adapter built
  without one (about 14 existing test files, the legacy path) keeps today's unisolated spawn, unchanged, so those tests
  stay byte-identical (Rule 15). The adapter's comment says so, and §7's "never silently unisolated" applies to the
  production path. New tests that pass an `installation` set `CCLOOP_CACHE_DIR` to a temp dir so the private pair never
  lands in the real `~/.cache/ccloop` (Rule 17-equivalent for tests).
- **Where the refusal is decided** (controller's call): inside `runCodexPhase` before spawn, so the refused phase still
  leaves its evidence dir and an `outcome.json` naming the refusal.
- **Unchanged**: the default argv otherwise (`exec --json --ephemeral … --sandbox <phase sandbox> -C <worktree>
  --output-schema … -o … -`), `withCodexSkillLinks`, rate-limit backoff, saved-result recovery, evidence files.
  `outcome.json` already records `args`; it should also record that the phase ran isolated and which private dirs it
  used (paths only), so a reader of the evidence can tell isolated runs from older ones.

### 3.4 The commands codex runs inside the phase (human's ruling, §2)

Codex passes its own environment to the shell commands it runs, so with §3.3 alone a command in the execute phase
would see the private `HOME`: no `~/.gitconfig` (author identity), no `~/.npm` cache, no `~/.ssh`. That would change
how the target repo's own tooling behaves, which is not what this round is about: §3 is about what is **injected into
the prompt**. The ruling: commands keep today's environment, the operator's real `HOME`, set back for them
through codex's `shell_environment_policy` (`-c shell_environment_policy.set.HOME=<real HOME>` or the equivalent the
installed codex supports). The builder must verify on the installed codex that this works and that it does not bring the
personal skills back (it should not: skill discovery happens in codex itself, before any command). If the installed
codex cannot do it, stop and ask; do not ship phases whose commands silently lose the real HOME.

### 3.5 What a phase refused before spawn means (human's ruling, §2)

A phase refused by §3.3's checks is a **final** failure, not retried: setting up isolation fails the same way every
time, so a retry only spends attempts. This is how a `codex-skills-*` setup failure is handled today. Its usage is
booked as **0** with the never-started marker the single-call refusal already uses: no process started and no token
was sent, and an unknown usage would hold Orca's group until someone settles it by hand. This is a named exception to
"usage is never booked as 0"; the plan cites this section where it books it.

## 4. Out-of-repo writes

The private pair is the single call's (`codexIsolation.ts` registration). This round adds **one writer**: every codex
loop phase, on every call, creates the missing dirs and re-checks the two symlinks, and codex writes its own state
there. The registration comment in `codexIsolation.ts` and Orca spec §11 (out-of-repo writers) are updated to name it.
Residue is unchanged (one `.<uuid>.link` temp link at most, displaced regular files kept, codex's own state).
Without a cache dir the pair falls back to the run directory as for the single call; for phases that is
`<runDir>/codex/<attempt>/…`, the builder names the exact path.

## 5. Verification

- Unit (fake codex that records argv and env, no real codex): a phase spawn carries the private `HOME` and
  `CODEX_HOME`, the four `-c` values, one `mcp_servers.<name>.enabled=false` per listed server, and does **not** carry
  `project_doc_max_bytes=0` or `include_environment_context=false`. Each assertion named against the mutation that
  removes its own line, seen red (ccloop Rule 9 practice, mutations in a `git clone --local` copy, Rule 17).
- Refusals: no MCP list, an unaddressable name, a symlinked private dir; each never spawns, is not retried, books
  usage 0 through `neverStarted` (§3.5), and leaves an `outcome.json` naming the refusal.
- `codexSkillsDir` still reaches the worktree and is cleaned up (existing tests stay green unchanged; Rule 15: no
  existing criterion is edited unless the human names it).
- Free acceptance on the real codex, the §1.1 table rerun through ccloop's own spawn path (`debug prompt-input` with the
  argv and env the adapter would use): personal skills absent, repo `AGENTS.md` and repo skill present.
- One paid check on the real codex (one phase-like call, human's nod first) covers what `debug prompt-input` cannot
  see: a command run inside the execute sandbox prints the expected `HOME` (§3.4), and no hook ran -- ccmem's
  `session_context` table (read-only `sqlite3`) gains no row for that call's session id.
- The argv assertion list above includes `features.hooks=false`, with its own mutation.

## 6. Non-goals

- The claude and omp phase adapters. OMP phases already run with `--no-skills`/`--no-extensions`; whether claude
  phases carry the operator's `~/.claude` skills and CLAUDE.md is not measured here and is a separate question.
- Codex subagents, a per-call output cap for codex, the tool environment beyond `HOME` (§3.4).
- Changing the single call.

## 7. Anti-goals

- Copying any credential. Links only, re-checked every call, as the single call.
- Breaking the person's own codex login: token rotation through the linked `auth.json` is the single call's known
  residual (this repo's handoff) and is inherited, not widened.
- A phase that silently runs unisolated when isolation cannot be set up: it refuses instead.
