# Multi-repo ccloop (several repositories in one run) Implementation Plan

> **For agentic workers:** implement task by task, TDD, one commit per task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One ccloop run may carry extra repositories (`context.repoKey` + `context.additionalRepos` in the contract,
`work.additionalRepos` in the start envelope). ccloop makes one worktree per extra repository, tracks each one's diff
itself, judges each against its own path policy, runs each one's checks there, tells every agent about the extra
worktrees, and returns per-repository result repositories and `dirs` in collect. Without the new fields, every byte
(contract, envelope hash, argv, prompts, collect, events) is as before.

**Spec:** Orca repository, `docs/superpowers/specs/2026-10-24-multi-dir-projects-design.md` §11 (ccloop part), §16.1
(C1–C13), §18 (K1–K7). §21.1 and §21.2 take precedence over earlier text. §19.2 P1–P7 are proposals the Orca controller
accepted under the human's standing instruction 「如果有问题，先按你的建议执行」; they are flagged for the human's review
and are **not** rulings (ccloop Rule 18). They are implemented as written.

**The human's ruling this implements (verbatim, Orca session `ffec7b28`, 2026-10-24; spec §1 item 4):**
「ccloop 原生支持多仓」 — ccloop's contract carries several repository paths. ccloop creates one worktree per repository
and tracks each repository's diff itself. Nothing else here is a ruling.

Author: implementer subagent of Orca session `ffec7b28`, 2026-10-24. Branch `feat/multi-repo` from local `main` at
`f4de340` (not pushed; fine). Worktree `/private/tmp/orca-ffec7b28/ccloop-mr` (`node_modules` is a symlink to the main
tree's — `unlink` it before removing the worktree). Mutations in `git clone --local` copies under
`/private/tmp/orca-ffec7b28/`, log `/private/tmp/orca-ffec7b28/mr-mutations.log`. `CCLOOP_CACHE_DIR` is always
`/private/tmp/orca-ffec7b28/ccloop-cache`. Fake agents only; no paid run.

**Coordination:** the live-transcript ccloop work (`docs/superpowers/plans/2026-10-24-live-transcript-ccloop.md`, branch
`feat/live-transcript`, worktree `/private/tmp/orca-ffec7b28/ccloop-lt`) touches the same adapters. If it lands on `main`
first, this branch rebases onto it before merging.

## Global constraints

- **C12 / ccloop Rule 15:** no existing test file changes. `git diff --name-status main...HEAD -- tests` must list only `A`
  lines. New fakes are new files.
- Absent `additionalRepos` ⇒ every existing code path runs exactly as before (the new code is entered only behind
  `contract.context.additionalRepos !== undefined`).
- Every new comment cites the spec as `spec 2026-10-24-multi-dir-projects §n`.

## Shapes (what Orca must accept)

```ts
// contract.context (optional, no default)
repoKey?: string                 // /^[a-z0-9_](?:[a-z0-9._-]*[a-z0-9_])?$/, present iff additionalRepos is
additionalRepos?: Array<{ key: string; repoPath: string; targetPaths: string[] /* min 1 */;
  allowlistPaths?: string[]; denylistPaths?: string[]; requiredChecks?: string[] }>   // 1..7, keys unique, ≠ repoKey
// start envelope work (protocol 3 and 4, optional)
additionalRepos?: Array<{ key: string; targetRepo: string; base: string }>           // same keys, same order
// collect (top level, only when the contract has additionalRepos)
dirs?: Array<{ key: string; resultRepo: `repos/${string}`; changedPaths: string[] }>
// run files
run/attempts/<n>/commits.json   // { [repoKey|key]: { sha, base, ref } }, primary first, 0600
run/attempts/<n>/dirs.json      // [{ key, changedPaths }] the §11.3 observation, 0600 (read by collect)
```

Refusal codes: `control-request-invalid` (schema/path), `control-multi-repo-continuation-unsupported` (accept with a
non-null `inputCheckpoint`), `control-multi-repo-recovery-unsupported` (accept in `verify-saved-result` mode; both
eligibility methods answer `{status:"unavailable", reason:<that code>}`). Human gates: `extra-repo-head-moved: <key>`,
`diff unobservable: <key>`, `allowlist miss: <key>:<path>`, `denylist match: <key>:<path>`, `max files exceeded: <total>`.

## Tasks

- [ ] **K1** contract + envelope schema + accept path checks (C1 `tests/contract/multiRepoAbsent.test.ts`,
  C2 `tests/contract/multiRepoSchema.test.ts`, `tests/control/multiRepoEnvelope.test.ts`).
  Mutations: default `additionalRepos: []`; default `repoKey`; drop the key-order refine; accept nested repos.
- [ ] **K2** worktrees `<runDir>/dirs/attempt-<n>/<key>`, start sha, refs in each repo, `commits.json`, publish/cleanup
  after the primary, empty `dirs/` removed, fresh-run `(dirs)` guard, `cleanupResidualExtraWorktrees` on resume
  (C3 `tests/workspace/multiRepoWorktrees.test.ts`, C10 `tests/controller/multiRepoResume.test.ts`).
  Mutations: extra worktrees from the primary repo; skip the extra publish; place them under `worktrees/`; leave empty
  `dirs/attempt-<n>`; resume cleans the primary only; drop the `dirs/` guard.
- [ ] **K3** per-repo observation and path policy (C4 `tests/controller/multiRepoPathPolicy.test.ts`,
  C9 `tests/runtime/omp/multiRepoSnapshot.test.ts`, C13 `tests/runtime/omp/multiRepoChangedFiles.test.ts`, new fake
  `tests/fixtures/fake-omp-multi.mjs`). Mutations: primary allowlist for extras; `changedFiles` for extras; count only
  the primary; `git status` only; drop the HEAD check; snapshot primary only; keyed `changedFiles` prompt.
- [ ] **K4** required checks per repo (C5 `tests/controller/multiRepoChecks.test.ts`). Mutations: extra checks with the
  primary cwd; drop the label.
- [ ] **K5** argv and prompts (C6 `tests/runtime/multiRepoArgv.test.ts`, C7 `tests/runtime/multiRepoPrompts.test.ts`).
  Mutations: omit codex `--add-dir` on execute; claude list after the prompt; `--add-dir` without extras; always emit the
  Directories section; leave an extra out of the verifier prompt.
- [ ] **K6** result repositories and collect `dirs` (C8 `tests/control/multiRepoCollect.test.ts`). Mutations:
  materialize extras from the primary; `dirs: []` for single repos.
- [ ] **K7** refusals (C11 `tests/control/multiRepoRefusals.test.ts`; mutation: accept a continuation), then C12, then
  the gate in a clean clone. **No merge, no push** (the controller's brief for this round).

## Success criteria (each a command with an exit code)

- per task: `./node_modules/.bin/vitest run <new files> > $S/kN.log 2>&1; echo $?` ⇒ 0, and each named mutation red in a
  clone (`mr-mutations.log`), restore proven by `git diff | wc -c` and `git diff --cached | wc -c` both 0.
- final, in a clean `git clone --local` of the branch tip: `npm run typecheck`, `npm run build`,
  `vitest run --reporter=json --outputFile=$S/vitest.json`, `node scripts/check-known-reds.mjs $S/vitest.json` ⇒ RC 0;
  any red not on the roster shown red on untouched `f4de340` too, or green alone.
- C12: `git diff --name-status f4de340...HEAD -- tests > $S/tests-diff.txt`, every line `A`.
