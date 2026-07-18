# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-07-18

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->
- Prefer roadmap/milestone naming as `V1 / V2 / V3`; dislikes `V1.5` because it feels awkward and less clean.
- 后续与用户讨论 ccloop 时使用中文，除非用户明确要求其他语言。


## Key Learnings

- **Project:** ccloop
- This worktree keeps OpenWolf enabled but may omit `.wolf/anatomy.md`, `.wolf/buglog.json`, and `.wolf/memory.md` initially; create those metadata files before following the workflow.
- The CLI bootstrap for V1 uses a minimal TypeScript/Vitest workspace under `src/` and `tests/cli/` with ESM-style `.js` import specifiers in TypeScript source/tests.
- When this agent must modify the separate implementation worktree, Read can inspect it directly but file creation/edits need Bash with absolute paths because Edit/Write are scoped to the agent's own isolated worktree.
- Task 1 CLI build output lands under `dist/src/` with the current `tsconfig.json` (`rootDir: "."` plus `outDir: "dist"`), so any published `bin` path must target `dist/src/cli.js` unless the compiler layout changes.
- Task 4 persistence stores run metadata with camelCase JSON in `loop-contract.json`, `loop-state.json`, newline-delimited `events.jsonl`, and per-attempt files under `attempts/<n>/`.
- Task 5 workspaces are created as detached git worktrees at `runDir/worktrees/attempt-<n>` and cleaned up with `git worktree remove --force` from the repo root.
- Task briefs may show extensionless example imports, but this TypeScript ESM worktree still expects `.js` import specifiers in source and test files to match the established Vitest/Node convention.
- Task 7 path policy uses intentionally minimal matching semantics: `pattern/**` means prefix match on that directory, `**` matches anything, denylist checks run before allowlist checks, and max-files overflow triggers a human gate.
- Task 8 controller orchestration preserves the current attempt worktree on `blocked_waiting_human`, but cleans up retryable and terminal non-human attempts after artifact/state persistence.
- V1 already covers the core Loop Engineering safety primitives (isolated worktrees, maker/checker separation, explicit stop budgets, durable run evidence); the next reliability boundary is real Claude E2E validation followed by resume/reconciliation before any durable scheduler.
- Evidence-grade completion must combine independent verifier output, structured artifact validation, required-event completeness, typed termination reasons, and immutable attempt lineage; a completion token or process exit code is only a signal, never sufficient proof.
- Artifact lifecycle must distinguish mutable staging, validated attempt artifacts, and a sealed evidence bundle; promotion requires manifest validation, final bundles are immutable, cleanup leaves tombstones, and the last recoverable copy cannot be deleted before durable publication is confirmed.
- Keep evidence-harness concerns separate from V1 product behavior: first derive manifests, terminal summaries, hashes, and cleanup observations from existing runDir artifacts; only promote a mechanism into ccloop after a real run proves a product gap.

- Evidence-first validation harness files for V1 live under `validation/v1/**` with matching focused Vitest coverage under `tests/validation/**`, and the disposable smoke repo root stays under ignored `.validation-runs/` with a strict do-not-overwrite boundary.

- A-04 mechanical preflight is intentionally non-paid: prepare-a04 runs deterministic repo checks first, freezes a contract plus approval package, prints JSON only, and must not create run/evidence directories or invoke run-scenario.
- A-04 approval is valid only for the fixed envelope `550000/600000/1200000/5000`, and `mainCheckoutMustRemainUnchanged: true` must be backed by running deterministic verification in an isolated temporary checkout created from the verified `main` revision; git status alone is insufficient because ignored files like `dist/**` can still be rewritten on disk.
- A-04 approval gating must also mechanically enforce the frozen one-shot Scenario A contract invariants (`autonomyLevel: "L2"`, `maxAttempts: 1`, `worktreeRequired: true`) instead of assuming `renderScenario("A")` never drifts.
- A-04 pre-approval must compare full repo-root `git status --porcelain` before and after deterministic preflight, re-check fixture HEAD/status immediately before contract write, and reject contract paths nested under run/evidence directories because `mkdir(dirname(contractPath))` can materialize forbidden pre-approval directories.
- A-04 preparation is now intentionally bound to the `main` checkout and its phase order is explicit: read-only preservation inspection -> main deterministic verification -> freshness check -> contract render -> focused evidence-chain regressions -> final pre-approval gate.
- The final A-04 pre-approval gate must re-read the frozen contract file from disk, schema-parse it, and recompute its sha256 before emitting the approval package; in-memory contract data alone is not trustworthy enough for approval output.
- A-04 approval output must preserve the isolated verified checkout instead of cleaning it up on success, and the emitted `workingDirectory` plus `exactCommand` must target that checkout's `validation/v1/scripts/run-scenario.ts` path so the approved runnable revision cannot drift from the revision that passed deterministic verification.
- A-04 preserved verified checkouts must materialize their own `node_modules` tree when the source checkout already has dependencies; symlinking back to the operator checkout breaks the approval package's claim that the preserved runnable environment is frozen and mechanically truthful.
- A-04 spec 6.1 read-only inspection is intentionally lightweight but mandatory: before deterministic verification, confirm the retained `main` checkout, retained `evidence-first-v1` worktree, backup branch, stashes, and preserved `.validation-runs/` recovery evidence are still present and readable.
- In `validation/v1/lib/scenarios.ts`, `executionPolicyOverrides` is a Scenario A-only surface; non-A scenarios must reject it at runtime even if a caller bypasses TypeScript.

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->
- [2026-07-17] When generating TypeScript via Python for this worktree, escape newline sequences inside JS/TS string literals as \\n; otherwise Vitest/esbuild will fail on unterminated strings.
- [2026-07-14] When running npm commands for the implementation worktree, use `npm --prefix /absolute/worktree/path ...` because this agent's own cwd is a different isolated worktree.

- [2026-07-15] When generating TypeScript files via Python in this implementation worktree, double-escape intended `\n` sequences so JSONL/template literals do not become accidental physical newlines.
- [2026-07-17] When a task brief says to preserve a specific ignore entry from the source checkout, explicitly add or verify that entry in the isolated worktree before claiming the ignore update is complete.
- [2026-07-18] For non-PDF Read calls, omit `pages` entirely; never pass an empty string. This has recurred despite prior buglog entries.
- [2026-07-18] Before the session's first Bash call, state the current request and exactly what the command verifies so GateGuard does not block it.
- [2026-07-18] The available reviewer agent is `ecc:code-reviewer`; the unnamespaced `code-reviewer` type is not registered in this environment.
- [2026-07-18] Validation CLI tests must create their own temporary Git repositories; never depend on ignored `.validation-runs/fixture-smoke`, which may exist in one worktree and not another. Compare canonical paths with `fs.realpath` on macOS because `/var` resolves through `/private/var`.
- [2026-07-18] When searching Markdown literals containing backticks from Bash, avoid double-quoted `rg` patterns because the shell performs command substitution; use Node string checks or single-quoted patterns.

- [2026-07-18] In validation/v1 scenario rendering, never spread runtime `executionPolicyOverrides` directly into the contract; whitelist the four approved fields and keep an `as any` regression test proving blocked fields like `maxAttempts` are ignored.
- [2026-07-18] When narrowing `renderScenario(...)` by scenario id, do not use separate A/non-A overloads; use a generic conditional signature so existing callers with `ScenarioId` unions still typecheck while non-A overrides remain blocked.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
- [2026-07-18] Task 2 preflight ordering follows the approved A-04 spec resolution: deterministic verification runs before run/evidence freshness checks. Why: approval should be based on a freshly validated main checkout before freezing the contract and expected run envelope.
- [2026-07-14] V1 implementation stack: TypeScript CLI. Why: best fit for local orchestration, Claude adapter integration, JSON/JSONL state, and fast iteration in this repository.
- [2026-07-17] Next milestone uses an evidence-first sequence: manually exercise real Claude success, human-gate, and interrupted/partial-recovery paths before automating them. Why: automation should encode observed runtime behavior rather than assumptions.
- [2026-07-18] Claude usage evidence is persisted in standard phase artifacts, not a validation sidecar or full raw envelope. Why: controller accounting and audit evidence must stay phase/attempt-bound without retaining unnecessary or potentially sensitive response data.
- [2026-07-18] A-04 preparation uses a one-shot-completion-first envelope: `tokenBudget 550000`, `per-attempt timeout 600000ms`, `total runtime 1200000ms`, `recovery 5000ms`, full deterministic preflight, strict single approval, and single-run stop with no automatic next paid call. Why: the user explicitly prioritized maximizing the chance of one complete evidence-grade Scenario A run while preserving the evidence-first V1 boundary and explicit human approval before any real Claude invocation.
