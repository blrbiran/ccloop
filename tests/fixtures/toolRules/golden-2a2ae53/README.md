# Goldens captured from ccloop `2a2ae53` (per-contract tool rules, spec 2026-10-22 §8 T1)

Captured 2026-10-22 by the implementer subagent of Orca session `b37f7ce9` (plan Task 0). These files are the
"absent `toolRules` ⇒ identical" oracle: they come from running the **2a2ae53** code, never from the code under test.

- Clone: `git clone --local /Users/biran/code/skills/orca/ccloop /private/tmp/orca-b37f7ce9/golden-2a2ae53`,
  `git checkout 2a2ae53`, `node_modules` symlinked to the main tree's, `npm run build` (RC 0).
- Harness: `tests/fixtures/toolRules/argvCapture.ts` of the branch (its adapters are passed in, so the same harness drives
  either tree). The three fakes (`tests/fixtures/fake-{claude-cli,codex,omp}.mjs`) were byte-identical between the clone
  and the branch at capture time (`cmp`).
- Command, from the clone:
  `./node_modules/.bin/tsx /private/tmp/orca-b37f7ce9/scripts/capture-goldens.mts <clone> <branch>/tests/fixtures/toolRules/argvCapture.ts <out>`
  (RC 0). The script sets a temp `CCLOOP_CACHE_DIR` and an empty `CODEX_HOME` first, as `tests/setup/relocateCatalogCache.ts`
  does, imports the clone's `ClaudeAgentAdapter`, `CodexAdapter`, `OmpAdapter`, `buildExecutorPrompt`,
  `loopContractSchema`, `canonicalJson`, and for each phase writes:
  - `claude-<phase>.json`: `argv` (what fake-claude-cli received after its mode and marker; installation command
    `--strict-mcp-config --disable-slash-commands`) and `extraArgs` (the call's `outcome.json`).
  - `codex-<phase>.json`: `outcome.json` `args` from `exec` on, `legacy` (no installation) and `isolated` (an
    installation, `sandbox: "workspace-write"`, empty MCP list, private homes under the temp cache).
  - `omp-<phase>.json`: `outcome.json` `args` (installation command = a shell wrapper around fake-omp.mjs).
  - `executor-prompt.txt`: `buildExecutorPrompt` for `RAW_CONTRACT` with a fixed plan.
  - `contract.json`: `canonicalJson(loopContractSchema.parse(RAW_CONTRACT))` plus a newline.
- Normaliser (`normalise` in the harness), and nothing else: the fixture temp dir ⇒ `<dir>`, `$HOME` ⇒ `<home>`,
  `call-XXXXXX` ⇒ `call-<id>`, the prompt argument (contains the task id, > 200 chars) ⇒ `<prompt>`.
