## Global Constraints

- Constants (spec, verbatim values): `PARENT_GONE_GRACE_MS = 5000`, `CLAUDE_SPAWN_ATTEMPTS = 3`, `CLAUDE_SPAWN_RETRY_DELAY_MS = 2000`, `OWNER_START_MARGIN_S = 2`, `REAP_GRACE_MS = 5000`, `REAP_TIMEOUT_MS = 15000`, `LEASE_TTL_MS` (existing, 90,000).
- Env variables read by the runner only: `CCLOOP_PARENT_WATCH_FD` (`"3"`), `CCLOOP_PARENT_GONE_GRACE_MS`, `CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS`. All three are stripped by `claudeEnv()`.
- Event types (new): `orphan_process_group_reaped`, `owner_crash_adopted`, `partial_execute_sent_to_verify`.
- Never-started answer on runner stdout: exactly `{"claudeNeverStarted": true, "spawnError": "<code>: <message>"}`, exit 0.
- `ps` in new code: `/bin/ps -o lstart= -p <pid>`, env `TZ=UTC LC_ALL=C`, timeout 1000 ms, maxBuffer 16 KiB.
- Repository rules (`CLAUDE.md`): no push, no merge, no branch/worktree deletion; never rewrite an existing criterion without recording it in the ledger as `Ruling (controller, pending human ratification)` with the ruling-88 three conditions; published comments get an appended `*** ERRATUM (crash resume, 2026-10-02, Orca session ece96b67) -- … ***`, never an in-place edit; `.superpowers/sdd/**` is append-only and new files there need `git add -f`.
- Verification runs only in a `git clone --local` copy under the session scratchpad (`/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/`), `node_modules` symlinked, `npm run build` first, HOME and `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME` redirected into the scratchpad, `TMPDIR=$(mktemp -d /private/tmp/cl-XXXX)`, `ECC_GATEGUARD=off DISABLE_OMC=1`. Output redirected to a file and read back whole; never piped through grep/tail/head.
- Single-file test runs in the main tree are allowed (`./node_modules/.bin/vitest run <file>`); the full suite and builds run only in the clone.
- Mutations only in a clone; restore proof = `git diff | wc -c` and `git diff --cached | wc -c` both 0.
- Commit style: conventional subject, body explains why, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A run killed before its first heartbeat affirm** (`leaseAffirmedAt: null`): `resume` must still adopt it once the owner is confirmed dead (sweep does not take it, R2). Test in Task 6 (`adopts a killed run whose lease was never affirmed`).
2. **A transient `ps` failure while the owner is really dead** (the pid vanished between `kill(0)` and `ps`): must refuse (undetermined), never adopt on a guess. Test in Task 4 (`readStart null ⇒ undetermined`).
3. **The operator runs `resume` twice in a row on a killed run** (second after the first already adopted and finished): second must be a clean refusal, not a second adoption. Test in Task 6 (`a second resume after adoption takes today's path`).
4. **Parent dies while the runner is still reading stdin** (before claude was ever spawned): runner must exit, no claude spawned. Test in Task 3 (`parent gone before the request arrives`).
5. **A claude that exits non-zero after having started** (real failure, not never-started): usage must stay as today (observed or null), never forced to 0. Test in Task 2 (`exit after start keeps today's usage`).

---

## Session facts for every implementer
- Repo: /Users/biran/code/skills/loop/ccloop, branch main. Commit locally only. Never push, merge, reset, or delete branches/worktrees.
- This machine: `rm` and `cp` are aliased with -i; use `/bin/rm -f` and `cat a > b`.
- Use `/usr/bin/git` for git commands (a wrapper rewrites `git`).
- Run single test files in the main tree: `ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run <file> > <scratch>/x.txt 2>&1; echo RC=$? >> <scratch>/x.txt` then read the file whole. Scratch dir: /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/ (make a subdir per task).
- `npx tsc --noEmit -p .` (or `npm run typecheck`) is fine to run in the main tree; do NOT run `npm run build` or the full suite in the main tree.
- Mutations: in a clone only — `git clone --local /Users/biran/code/skills/loop/ccloop <scratch>/tN-mut`, `ln -s /Users/biran/code/skills/loop/ccloop/node_modules <clone>/node_modules`, copy your committed files are already there (clone is of committed state). Apply the mutation, run the one test file, record the red line, `git -C <clone> checkout -- .`, prove `git diff | wc -c` = 0. Leave the clone in place (deleting scratch is fine with /bin/rm -rf only inside your scratch subdir).
- Known load flakes when running other files: `agentsControl` "reads the table only for capabilities and accept…", `evidence` "finalize-review CLI stores diagnosis null…", and the stable red `tests/control/stopProof.test.ts` "does not treat leader exit as group quiet…". Rerun a file alone before calling it a regression.
- Existing criteria: if a change breaks an existing test, do NOT loosen it. Either keep behaviour, or rewrite that test whole to assert the new behaviour and list it in your report under "Existing criteria rewritten" with: test name, file, why the old expectation is obsolete, and that it encodes spec 2026-10-02 crash-resume (pending human ratification).
- Published comments (anything already in git before 2026-10-02's spec commits) are never edited in place; append `*** ERRATUM (crash resume, 2026-10-02, Orca session ece96b67) -- … ***`.
- Code comments in English; match surrounding style.
