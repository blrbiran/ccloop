# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-07-20

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->
- Prefer roadmap/milestone naming as `V1 / V2 / V3`; dislikes `V1.5` because it feels awkward and less clean.
- 后续与用户讨论 ccloop 时使用中文，除非用户明确要求其他语言。
- 在类似本次这种迭代修复把工作树弄脏、从而阻塞下一步验证时，可以主动创建本地 commit，不必每次都等用户手动提交。
- 后续本项目运行测试、validation script、scenario invocation 时，默认直接使用 `ECC_GATEGUARD=off`；这个 gate 不是必须，只是有人参与时防止 AI 误改文件的辅助机制。
- 后续本项目运行测试、validation script、scenario invocation 时，也默认直接使用 `DISABLE_OMC=1`，避免 oh-my-claudecode 在 attempt worktree 内写入 `.omc/**` 干扰 validation 场景。
- 如果只是临时绕开 OMC，优先用 `claude plugin disable oh-my-claudecode ; ... ; claude plugin enable oh-my-claudecode`；如果对 plugin / skill / hooks 完全没有要求，则优先考虑 `claude --bare`。


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
- A-04 approval truthfulness needs a separate repo-root main-checkout baseline captured before prepare starts; a dirty start must reject approval, and the final gate must compare both `rev-parse HEAD`/full `git status --porcelain` and a deterministic filesystem fingerprint (excluding only the intentionally allowed frozen-contract path) so ignored-file drift like `dist/**` is caught even though deterministic verification runs in a preserved isolated checkout.
- A-04 `usageEvidenceExpectations` should lock the approved semantics explicitly: up to three Claude-backed phases, standard phase `usageEvidence` with alias selection and `normalizedTotal`, `tokenUsage` iff that total is finite and positive and equal, and usage evidence improving auditability without defining PASS.
- The final A-04 pre-approval gate must re-read the frozen contract file from disk, schema-parse it, and recompute its sha256 before emitting the approval package; in-memory contract data alone is not trustworthy enough for approval output.
- A-04 approval output must preserve the isolated verified checkout instead of cleaning it up on success, and the emitted `workingDirectory` plus `exactCommand` must target that checkout's `validation/v1/scripts/run-scenario.ts` path so the approved runnable revision cannot drift from the revision that passed deterministic verification.
- A-04 approval must also copy the frozen contract into the preserved verified checkout and bind both `contractIdentity.path` and `exactCommand --contract` to that verified-checkout copy; hashing only the mutable main-checkout contract path is not approval-truthful enough.
- A-04 preserved verified checkouts must materialize their own `node_modules` tree when the source checkout already has dependencies; symlinking back to the operator checkout breaks the approval package's claim that the preserved runnable environment is frozen and mechanically truthful.
- A-04 spec 6.1 read-only inspection is intentionally lightweight but mandatory: before deterministic verification, confirm the retained `main` checkout, retained `evidence-first-v1` worktree, backup branch, stashes, and preserved `.validation-runs/` recovery evidence are still present and readable.
- In `validation/v1/lib/scenarios.ts`, `executionPolicyOverrides` is a Scenario A-only surface; non-A scenarios must reject it at runtime even if a caller bypasses TypeScript.

- A-04 path hardening must use `realpath` containment for frozen adapter configs in both the source repo and preserved verified checkout, and freshness checks must use `lstat` semantics so dangling symlinks count as occupied paths rather than fresh destinations.

- A-04 metadata-backed inspection now treats only the four required docs plus the retained backup branch and contradiction checks as hard blockers; retained stashes, the legacy evidence-first worktree, and its preserved `.validation-runs/` tree are soft signals only, so runtime checks must read current approved document text instead of reviving legacy evidence-path dependencies.
- A-04 metadata contradiction checks are literal contract points: `historicalA01ToA03Diagnoses` must use the usage-evidence phrase `Historical A-01 through A-03 artifacts remain immutable`, `paidCallStillRequiresExplicitApproval` must use the approved boundary/approval wording from the brief, retained stash presence comes only from filtered required-stash matches, and legacy soft-signal paths must report the actual discovered worktree location.

- Metadata-backed A-04 inspection must distinguish `UNREADABLE` required docs from `MISSING`, and a present backup branch must remain `PRESENT` even when `merge-base` reachability data is unavailable.
- On live `main`, `prepare-a04.ts` enforces a clean-checkout gate before preflight; after restoring the backup branch anchor, any remaining uncommitted file such as `docs/handover/ccloop-handover.md` blocks non-paid prepare before metadata verification continues.

- Historical D-01 evidence shape (`plan` present, no `attempt_started`, `tokenBudgetRemaining: 0`, and only the plan prompt visible in `processes.json`) matches `runLoop.ts`'s post-plan budget-exhausted branch more closely than the execute-timeout branches. That means current evidence most likely points to budget exhaustion before execute launch, even though the accepted `review.json` still remains `INCONCLUSIVE / CONTRACT_GAP` because the persisted D-01 evidence does not explicitly encode that boundary.

- Task 3 doc-alignment worktrees may lag approved 2026-07-19 metadata-backed governance docs from the main checkout; sync those tracked spec/plan files before adding supersession references so README/handover/anatomy do not point at missing paths.

- Some isolated implementation worktrees can contain a placeholder `node_modules/` with no local `.bin/tsx`; in that state, `tests/validation/evidence.test.ts` fails with spawn-ENOENT before exercising product code.

- Task 2 controller evidence now treats `execute_started` as the canonical execute-entry boundary, and interrupted execute exhaustion with no adapter result must persist controller-owned `execution-recovery.json` from a best-effort pre-cleanup git-status probe of the attempt worktree.
- Task 3 evidence-layer classification for scenario D reads only Layer A signals: parsed event types, terminal loop-state shape, and standard artifact presence/absence; `BOUNDARY_UNRESOLVED` stays the only route to `INCONCLUSIVE / CONTRACT_GAP`, and execute-entered PASS requires the stronger no-recoverable-work plus cleanup-and-standard-shape contract.
- For Task 3 D classification, `execute_started` alone is not sufficient for `EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE`; the evidence layer must also see a complete `execution.json` or controller-owned `execution-recovery.json`, and tests should model that explicitly.
- When interrupted execute recovery is written, `execution-recovery.json.cleanupStatus` must be finalized from the real cleanup outcome: write the pre-cleanup snapshot first, then keep `retained` on cleanup failure or update it to `removed` only after cleanup succeeds.
- Task 3 D-boundary classification must schema-validate `execution-recovery.json`; a merely parseable JSON file is not sufficient Layer A recovery evidence, and malformed/shape-invalid recovery must fall back to `BOUNDARY_UNRESOLVED`.
- Task 4 historical review preservation uses a richer `review-reclassified.json` artifact, not a plain alternate-name `Review`: it must include `original`, `reclassified`, `boundaryClassification`, `ruleVersion`, and exact Layer A `evidenceReferences`, while leaving `review.json` immutable.
- Historical `PRE_EXECUTE_EXHAUSTION` also requires `verify.json` to remain absent/`NOT_RUN`; any verify artifact is later Layer A attempt-handling evidence and disqualifies the historical pre-execute classification.
- Historical `PRE_EXECUTE_EXHAUSTION` also requires controller-owned `execution-recovery.json` to remain absent, while execute-entered recoverable classification must consult direct `execution.json` readability rather than Scenario D artifact-status normalization alone.
- Operator-facing D docs should state the implemented Layer A rule directly: historical reclassification is Layer A-only, `PRE_EXECUTE_EXHAUSTION` maps to `INCONCLUSIVE / RUNTIME_VARIANCE`, and any reinterpretation must be emitted separately so `review.json` remains immutable.
- Scenario D contradiction checks must use raw Layer A artifact observation, not only scenario-normalized artifact statuses; a physically present `execution.json`, `diff.patch`, or `stdout-stderr.log` that normalizes to `INVALID` is still contradiction evidence for `BOUNDARY_UNRESOLVED`.
- Scenario D contradiction checks must also treat controller-owned `execution-recovery.json` presence as Layer A boundary evidence; if recovery is present without `attempt_started`, or without `execute_started` after `attempt_started`, classification must be `BOUNDARY_UNRESOLVED`.
- Scenario D evidence collection must resolve the terminal attempt from `loop-state.json` (`currentAttempt` / `attemptsUsed`) before reading Layer A attempt artifacts; hard-coding `attempts/1` drops exhausted attempt-2+ `plan.json` and `execution-recovery.json` evidence.
- `git status --porcelain=v1 -z` rename/copy records arrive as `to\0from\0`; when collecting changed destination paths, keep the current entry path and skip the following source-path token.

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->
- [2026-07-17] When generating TypeScript via Python for this worktree, escape newline sequences inside JS/TS string literals as \\n; otherwise Vitest/esbuild will fail on unterminated strings.
- [2026-07-14] When running npm commands for the implementation worktree, use `npm --prefix /absolute/worktree/path ...` because this agent's own cwd is a different isolated worktree.

- [2026-07-15] When generating TypeScript files via Python in this implementation worktree, double-escape intended `\n` sequences so JSONL/template literals do not become accidental physical newlines.
- [2026-07-17] When a task brief says to preserve a specific ignore entry from the source checkout, explicitly add or verify that entry in the isolated worktree before claiming the ignore update is complete.
- [2026-07-18] For non-PDF Read calls, omit `pages` entirely; never pass an empty string. This has recurred despite prior buglog entries.
- [2026-07-18] Before the session's first Bash call, state the current request and exactly what the command verifies so GateGuard does not block it.
- [2026-07-20] Before the first Edit to any project doc or OpenWolf file under GateGuard, gather the impact facts first: where the file is referenced, whether it exports any public symbols, whether it defines any data schema, and the user's instruction verbatim. Skipping that order causes avoidable fact-forcing interruptions.
- [2026-07-18] The available reviewer agent is `ecc:code-reviewer`; the unnamespaced `code-reviewer` type is not registered in this environment.
- [2026-07-18] Validation CLI tests must create their own temporary Git repositories; never depend on ignored `.validation-runs/fixture-smoke`, which may exist in one worktree and not another. Compare canonical paths with `fs.realpath` on macOS because `/var` resolves through `/private/var`.
- [2026-07-20] Validation CLI entrypoint guards must compare canonical filesystem paths, not raw `import.meta.url` vs `process.argv[1]` URLs. On macOS preserved checkouts under `/var`, the module URL may resolve through `/private/var`; without `realpath`, the script can no-op with exit 0 and produce no artifacts.
- [2026-07-18] When searching Markdown literals containing backticks from Bash, avoid double-quoted `rg` patterns because the shell performs command substitution; use Node string checks or single-quoted patterns.

- [2026-07-18] In validation/v1 scenario rendering, never spread runtime `executionPolicyOverrides` directly into the contract; whitelist the four approved fields and keep an `as any` regression test proving blocked fields like `maxAttempts` are ignored.
- [2026-07-18] When narrowing `renderScenario(...)` by scenario id, do not use separate A/non-A overloads; use a generic conditional signature so existing callers with `ScenarioId` unions still typecheck while non-A overrides remain blocked.

- [2026-07-18] For A-04 path safety, do not rely on lexical containment or `stat()`-style existence checks; use `realpath` for adapter-config freeze guarantees and `lstat` for freshness so symlink escapes and dangling symlinks cannot pass pre-approval.

- [2026-07-20] Task briefs may mention Jest-style `--runInBand`, but this repository runs Vitest; use `npm test -- <test-path>` (or another Vitest-supported form) instead of assuming that flag exists.
- [2026-07-20] For Task 3 D-boundary evidence, never treat a merely parseable `execution-recovery.json` as sufficient; validate the full `ExecutionRecovery` shape and fall back to `BOUNDARY_UNRESOLVED` when malformed or shape-invalid.
- [2026-07-20] When inserting TypeScript fixtures via Python in this worktree, inspect the written file before running Vitest if the edit contains `"\n"`; a physical newline or duplicated `)` inside the generated string literal will break esbuild before tests collect.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
- [2026-07-18] Task 2 preflight ordering follows the approved A-04 spec resolution: deterministic verification runs before run/evidence freshness checks. Why: approval should be based on a freshly validated main checkout before freezing the contract and expected run envelope.
- [2026-07-14] V1 implementation stack: TypeScript CLI. Why: best fit for local orchestration, Claude adapter integration, JSON/JSONL state, and fast iteration in this repository.
- [2026-07-17] Next milestone uses an evidence-first sequence: manually exercise real Claude success, human-gate, and interrupted/partial-recovery paths before automating them. Why: automation should encode observed runtime behavior rather than assumptions.
- [2026-07-18] Claude usage evidence is persisted in standard phase artifacts, not a validation sidecar or full raw envelope. Why: controller accounting and audit evidence must stay phase/attempt-bound without retaining unnecessary or potentially sensitive response data.
- [2026-07-18] A-04 preparation uses a one-shot-completion-first envelope: `tokenBudget 550000`, `per-attempt timeout 600000ms`, `total runtime 1200000ms`, `recovery 5000ms`, full deterministic preflight, strict single approval, and single-run stop with no automatic next paid call. Why: the user explicitly prioritized maximizing the chance of one complete evidence-grade Scenario A run while preserving the evidence-first V1 boundary and explicit human approval before any real Claude invocation.
- [2026-07-19] A-04 takeover assessment should preserve existing branch work when possible and review committed branch surface before local drift. Why: the user explicitly chose retention over a clean re-prepare and wants merge readiness judged on product code, `validation/v1/README.md`, and related plan/report truthfulness rather than worktree tidiness alone.
