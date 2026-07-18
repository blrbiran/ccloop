# Evidence-First V1 Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exercise ccloop V1 through five explicit real-Claude scenarios, preserve reviewable local evidence, and identify confirmed product defects before any E2E automation or product change.

**Architecture:** Add a tracked validation kit under `validation/v1/` that creates a disposable Git fixture, renders strict V1 contracts, runs exactly one explicitly selected scenario, and derives evidence from the existing run directory. All generated fixtures, run directories, and evidence stay under ignored `.validation-runs/`; ccloop runtime code remains unchanged. If a real run confirms a product defect, stop this plan and create a defect-specific follow-up plan rather than guessing the fix here.

**Tech Stack:** Node.js ESM, TypeScript/Vitest for validation-kit tests, the existing TypeScript CLI, Git worktrees, and the installed Claude CLI.

## Global Constraints

- Read `docs/superpowers/specs/2026-07-17-evidence-first-v1-validation-design.md` before execution.
- Treat `docs/ccloop-v2-review-backlog.md` as review input only; do not implement its candidates.
- Run A-E manually and sequentially; do not build a suite that launches all real-Claude scenarios.
- Do not modify `src/`, production dependencies, or V1 behavior unless a real run confirms `FAIL / PRODUCT_DEFECT`.
- Use a disposable local fixture with no secrets, symlinks, submodules, or nested worktrees.
- Do not push, create a PR, alter shared infrastructure, or perform automatic merge operations.
- Never delete prior run directories, retained worktrees, stashes, or evidence. Every retry gets a new run ID.
- Use `scenarioVerdict: PASS | FAIL | INCONCLUSIVE` independently from `diagnosis: PRODUCT_DEFECT | RUNTIME_VARIANCE | ENVIRONMENT_FAILURE | CONTRACT_GAP | null`.
- Use `PRESENT`, `NOT_PRODUCED`, `NOT_RUN`, `MISSING`, and `INVALID` exactly as defined in the design.
- Before each real Claude call, show the scenario, `maxAttempts`, per-attempt timeout, total runtime budget, and token budget, then obtain explicit approval for that call.
- Commit checkpoints in this plan require explicit user approval at execution time. Do not commit merely because the step is listed.

---

## File Map

- Modify `.gitignore` — ignore generated validation fixtures, run directories, and evidence.
- Modify `tsconfig.json` — typecheck the tracked validation harness.
- Create `validation/v1/README.md` — operator procedure, scenario order, cost gate, verdict rules, and stop conditions.
- Create `validation/v1/fixture/package.json` — dependency-free fixture test command.
- Create `validation/v1/fixture/src/counter.js` — baseline production file.
- Create `validation/v1/fixture/test/counter.test.js` — deterministic baseline test.
- Create `validation/v1/lib/scenarios.ts` — A-E contract definitions and expected artifact semantics.
- Create `validation/v1/lib/evidence.ts` — fixed-path hashing, parsing, Git observations, and evidence status derivation.
- Create `validation/v1/scripts/create-fixture.ts` — copy the fixture and initialize one local Git baseline commit.
- Create `validation/v1/scripts/render-contract.ts` — render one strict contract with an absolute fixture path.
- Create `validation/v1/scripts/run-scenario.ts` — explicitly launch one ccloop run and collect process/runDir evidence; never select or chain scenarios itself.
- Create `validation/v1/scripts/finalize-review.ts` — validate and write the human verdict without deriving judgment from model output.
- Create `tests/validation/fixture.test.ts` — fixture creation tests.
- Create `tests/validation/contracts.test.ts` — strict contract and scenario-invariant tests.
- Create `tests/validation/evidence.test.ts` — evidence status, hashing, cleanup, and verdict tests with synthetic run directories.
- Create `docs/validation/ccloop-v1-evidence-report.md` only after A-E complete — tracked summary linking to local evidence paths without copying secrets or raw logs.

---

### Task 1: Disposable Fixture and Local Safety Boundary

**Files:**
- Modify: `.gitignore`
- Modify: `tsconfig.json`
- Create: `validation/v1/fixture/package.json`
- Create: `validation/v1/fixture/src/counter.js`
- Create: `validation/v1/fixture/test/counter.test.js`
- Create: `validation/v1/scripts/create-fixture.ts`
- Create: `tests/validation/fixture.test.ts`

**Interfaces:**
- Consumes: `node`, `git`, and a caller-provided empty output path.
- Produces: `createFixture(templateDir: string, outputDir: string): Promise<{ repoPath: string; baseCommit: string }>` exported by `validation/v1/scripts/create-fixture.ts`.
- Invariant: refuse an existing or non-empty output path; never clean or overwrite it.

- [ ] **Step 1: Add the generated-root ignore rule**

Append only this line to `.gitignore`, preserving the existing `reference/oh-my-openagent` entry:

```gitignore
.validation-runs/
```

Extend `tsconfig.json`'s `include` array so the harness is typechecked:

```json
"include": ["src/**/*.ts", "tests/**/*.ts", "validation/**/*.ts", "vitest.config.ts"]
```

- [ ] **Step 2: Write the fixture files**

`validation/v1/fixture/package.json`:

```json
{
  "name": "ccloop-validation-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

`validation/v1/fixture/src/counter.js`:

```js
export function next(value) {
  return value + 1
}
```

`validation/v1/fixture/test/counter.test.js`:

```js
import assert from "node:assert/strict"
import test from "node:test"
import { next } from "../src/counter.js"

test("next increments by one", () => {
  assert.equal(next(1), 2)
})
```

- [ ] **Step 3: Write the failing fixture tests**

In `tests/validation/fixture.test.ts`, create two tests:

```ts
it("creates a clean Git fixture at one baseline commit", async () => {
  const result = await createFixture(templateDir, outputDir)
  expect(result.repoPath).toBe(outputDir)
  expect(result.baseCommit).toMatch(/^[0-9a-f]{40}$/)
  expect(await git(outputDir, ["status", "--porcelain"])).toBe("")
  expect(await git(outputDir, ["rev-list", "--count", "HEAD"])).toBe("1")
})

it("refuses to overwrite an existing output directory", async () => {
  await mkdir(outputDir, { recursive: true })
  await expect(createFixture(templateDir, outputDir)).rejects.toThrow("fixture output already exists")
})
```

Use temporary directories from `node:os` and import the harness with the project's established `.js` ESM specifier convention, for example `../../validation/v1/scripts/create-fixture.js`. Run fixture tests with `npm test -- --run tests/validation/fixture.test.ts`.

- [ ] **Step 4: Verify the tests fail**

Run:

```bash
npm test -- --run tests/validation/fixture.test.ts
```

Expected: FAIL because `create-fixture.ts` or `createFixture` does not exist.

- [ ] **Step 5: Implement fixture creation**

Implement `createFixture()` with `fs.cp`, `fs.stat`, and `execFile("git", ...)`. It must:

1. reject if `outputDir` exists;
2. copy `validation/v1/fixture` recursively;
3. run `git init`, local `git config user.name ccloop-validation`, local `git config user.email ccloop-validation@example.invalid`, `git add` with explicit fixture paths, and `git commit -m "fixture: establish validation baseline"`;
4. run `npm test` inside the fixture;
5. return the absolute repository path and `git rev-parse HEAD`.

The direct CLI accepts exactly:

```text
npx --no-install tsx validation/v1/scripts/create-fixture.ts --output <path>
```

It prints one JSON object containing `repoPath` and `baseCommit`.

- [ ] **Step 6: Verify fixture behavior**

Run:

```bash
npm test -- --run tests/validation/fixture.test.ts
npx --no-install tsx validation/v1/scripts/create-fixture.ts --output .validation-runs/fixture-smoke
npm --prefix .validation-runs/fixture-smoke test
git -C .validation-runs/fixture-smoke status --short
```

Expected: tests PASS; the fixture test passes; Git status prints nothing.

Do not delete `.validation-runs/fixture-smoke`; it is ignored and may be inspected until the user approves cleanup.

- [ ] **Step 7: Optional commit checkpoint**

After explicit user approval:

```bash
git add .gitignore tsconfig.json validation/v1/fixture validation/v1/scripts/create-fixture.ts tests/validation/fixture.test.ts
git commit -m "test: add disposable V1 validation fixture"
```

---

### Task 2: Strict A-E Contract Renderer

**Files:**
- Create: `validation/v1/lib/scenarios.ts`
- Create: `validation/v1/scripts/render-contract.ts`
- Create: `tests/validation/contracts.test.ts`

**Interfaces:**
- Consumes: scenario ID `A | B | C | D | E`, absolute fixture path, and an explicit timeout for C/D.
- Produces: `renderScenario(id: ScenarioId, options: { repoPath: string; timeoutMs?: number }): LoopContract` and one strict JSON contract.
- Later tasks rely on `SCENARIO_IDS`, `getScenario(id: ScenarioId): ScenarioDefinition`, `renderScenario()`, and each scenario's `expectedArtifacts` map.

Define these types in `validation/v1/lib/scenarios.ts`:

```ts
export type ScenarioId = "A" | "B" | "C" | "D" | "E"
export type ArtifactExpectation = "PRESENT" | "NOT_PRODUCED" | "NOT_RUN"
export type ScenarioDefinition = {
  id: ScenarioId
  goal: string
  expectedArtifacts: Record<"plan" | "execution" | "verify" | "diff" | "log" | "requiredChecks", ArtifactExpectation>
}
```

- [ ] **Step 1: Write failing contract tests**

`tests/validation/contracts.test.ts` must assert:

```ts
expect(SCENARIO_IDS).toEqual(["A", "B", "C", "D", "E"])
for (const id of SCENARIO_IDS) {
  expect(() => loopContractSchema.parse(renderScenario(id, optionsFor(id)))).not.toThrow()
  expect(renderScenario(id, optionsFor(id)).executionPolicy.maxAttempts).toBe(1)
}
```

Add exact scenario assertions:

- A uses `verifierType: "agent"`, runs `npm test`, and allows only `src/**` and `test/**`.
- B targets `restricted.txt`, places it in both `targetPaths` and `denylistPaths`, and expects verification/checks `NOT_RUN`.
- C and D reject rendering without a positive `timeoutMs`; both set `partialOutcomeRecoveryWindowMs` to `3000`.
- E allows only `src/**`, denies `test/**`, requires `npm test`, and uses one attempt.
- all scenarios use the complete V1 terminal-state list and a `tokenBudget` of `50000`.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npm test -- --run tests/validation/contracts.test.ts
```

Expected: FAIL because `scenarios.ts` does not exist.

- [ ] **Step 3: Implement scenario definitions**

Use a shared base with:

```js
executionPolicy: {
  autonomyLevel: "L2",
  maxAttempts: 1,
  perAttemptTimeoutMs: 300000,
  totalRuntimeBudgetMs: 600000,
  tokenBudget: 50000,
  worktreeRequired: true,
  partialOutcomeRecoveryWindowMs: 3000,
}
```

Define these concrete goals:

- A: add `previous(value)` to `src/counter.js`, add a deterministic test, and pass `npm test`.
- B: create `restricted.txt` containing `gate probe`; deny that exact path.
- C: first create `src/partial-note.txt`, then add `sumTo(value)` to `src/counter.js`, then run tests and inspect the result. The timeout is supplied by the operator after A/B timing observations.
- D: inspect and reason through the fixture before changing `src/counter.js`; use an operator-supplied timeout intended to interrupt execute before a reported result. Do not claim that no worktree change occurred.
- E: change `next(1)` to return `3` without modifying tests; the existing deterministic test must fail.

For A, set `evidenceRequired: ["command output"]`. For B-E, use an empty evidence requirement. Use `rejectOn: ["required check failed"]` for all scenarios.

Each scenario defines expected artifact statuses used by evidence collection:

```js
A: { plan: "PRESENT", execution: "PRESENT", verify: "PRESENT", diff: "PRESENT", log: "PRESENT", requiredChecks: "PRESENT" }
B: { plan: "PRESENT", execution: "PRESENT", verify: "NOT_RUN", diff: "PRESENT", log: "PRESENT", requiredChecks: "NOT_RUN" }
C: { plan: "PRESENT", execution: "PRESENT", verify: "NOT_RUN", diff: "PRESENT", log: "PRESENT", requiredChecks: "NOT_RUN" }
D: { plan: "PRESENT", execution: "NOT_PRODUCED", verify: "NOT_RUN", diff: "NOT_PRODUCED", log: "NOT_PRODUCED", requiredChecks: "NOT_RUN" }
E: { plan: "PRESENT", execution: "PRESENT", verify: "PRESENT", diff: "PRESENT", log: "PRESENT", requiredChecks: "PRESENT" }
```

- [ ] **Step 4: Implement the renderer CLI**

Accept:

```text
npx --no-install tsx validation/v1/scripts/render-contract.ts \
  --scenario A \
  --repo .validation-runs/fixture \
  --output .validation-runs/contracts/A.json
```

Require `--timeout-ms <positive integer>` for C and D. Resolve the fixture with `realpath`, reject a non-Git directory, reject an existing output file, validate with `loopContractSchema`, then write formatted JSON.

- [ ] **Step 5: Verify all deterministic contract behavior**

Run:

```bash
npm test -- --run tests/validation/contracts.test.ts
npx --no-install tsx validation/v1/scripts/render-contract.ts --scenario A --repo .validation-runs/fixture-smoke --output .validation-runs/A-smoke.json
node dist/cli.js run --contract .validation-runs/A-smoke.json --run-dir .validation-runs/invalid-smoke --adapter invalid --adapter-config examples/v1/claude-adapter-config.json; test $? -eq 1
```

Expected: tests PASS; A contract is written; invalid adapter exits 1 without a Claude call.

- [ ] **Step 6: Optional commit checkpoint**

After explicit user approval:

```bash
git add validation/v1/lib/scenarios.ts validation/v1/scripts/render-contract.ts tests/validation/contracts.test.ts
git commit -m "test: define real-Claude validation scenarios"
```

---

### Task 3: Single-Scenario Evidence Harness

**Files:**
- Create: `validation/v1/lib/evidence.ts`
- Create: `validation/v1/scripts/run-scenario.ts`
- Create: `validation/v1/scripts/finalize-review.ts`
- Create: `tests/validation/evidence.test.ts`

**Interfaces:**
- Consumes: one rendered contract, one fresh run directory, one fresh evidence directory, fixture path, and Claude adapter config.
- Produces: `invocation.json`, `artifacts.json`, `git.json`, `processes.json`, `observations.json`, `stdout.log`, and `stderr.log` in the evidence directory.
- Produces after human review: `review.json` with a validated verdict and diagnosis.
- Must not decide PASS/FAIL, select another scenario, retry, or modify ccloop product files.

- [ ] **Step 1: Write failing synthetic evidence tests**

Create synthetic A, B, and D run directories and assert:

```ts
expect(await collectEvidence(inputA)).toMatchObject({
  artifacts: expect.arrayContaining([
    expect.objectContaining({ name: "plan", status: "PRESENT", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
  ]),
})

expect(await collectEvidence(inputB)).toMatchObject({
  requiredChecks: { status: "NOT_RUN" },
})

expect(await collectEvidence(inputD)).toMatchObject({
  artifacts: expect.arrayContaining([
    expect.objectContaining({ name: "execution", status: "NOT_PRODUCED" }),
  ]),
})
```

Also test:

- malformed `loop-state.json` becomes `INVALID`, not silently skipped;
- expected-present but absent becomes `MISSING`;
- artifact paths cannot escape `runDir`;
- `finalize-review.ts` rejects an unknown verdict or diagnosis;
- diagnosis string `null` is stored as JSON `null`.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npm test -- --run tests/validation/evidence.test.ts
```

Expected: FAIL because the evidence module does not exist.

- [ ] **Step 3: Implement deterministic evidence collection**

Export these exact interfaces and functions from `validation/v1/lib/evidence.ts`:

```ts
export type ArtifactStatus = "PRESENT" | "NOT_PRODUCED" | "NOT_RUN" | "MISSING" | "INVALID"
export type Review = {
  scenarioVerdict: "PASS" | "FAIL" | "INCONCLUSIVE"
  diagnosis: "PRODUCT_DEFECT" | "RUNTIME_VARIANCE" | "ENVIRONMENT_FAILURE" | "CONTRACT_GAP" | null
  summary: string
  reviewedAt: string
}

export async function sha256File(path: string): Promise<string> {}
export async function collectArtifacts(input: { scenario: ScenarioDefinition; runDir: string }): Promise<ArtifactRecord[]> {}
export async function collectGitObservation(input: GitObservationInput): Promise<GitObservation> {}
export async function collectEvidence(input: EvidenceInput): Promise<EvidenceRecord> {}
export function validateReview(review: unknown): Review {}
```

Define `ArtifactRecord`, `GitObservationInput`, `GitObservation`, `EvidenceInput`, and `EvidenceRecord` in the same file before their first use; keep them limited to fields asserted by the tests and written by the harness.

Requirements:

- hash only fixed known files under `runDir`; use `realpath`/`relative` to reject escapes;
- parse every JSON file explicitly and record parse errors;
- parse every non-empty `events.jsonl` line; one malformed line marks the event log invalid;
- derive artifact status from scenario expectation plus observed existence;
- never copy the fixture source tree into evidence;
- record only environment variable names passed to the child, never values;
- record the fixture HEAD/status before and after, run worktree listing, and whether main checkout changed;
- keep terminal outcome separate from cleanup outcome;
- record `claudeChildExited: "NOT_OBSERVABLE"` unless the runner tracked a descendant PID and confirmed its post-exit state.

- [ ] **Step 4: Implement the one-run wrapper**

`run-scenario.ts` accepts:

```text
--scenario <A-E>
--contract <path>
--fixture <path>
--run-dir <fresh path>
--evidence-dir <fresh path>
--adapter-config <path>
--pass-env <NAME>   # repeatable, optional
```

It must:

1. refuse existing run/evidence directories;
2. require a clean fixture and record its baseline HEAD/status;
3. run exactly `node dist/cli.js run --contract ... --run-dir ... --adapter claude --adapter-config ...`;
4. construct a child environment from `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`, plus explicitly named `--pass-env` variables that exist;
5. record passed variable names only;
6. capture child stdout/stderr to evidence logs;
7. record start/end ISO timestamps, duration, command arguments, and exit code;
8. every 250ms while ccloop runs, parse `ps -axo pid=,ppid=,command=` into a process tree rooted at the spawned ccloop PID and retain the observed descendant PIDs/commands; 250ms after ccloop exits, test only those retained PIDs with signal `0` and record survivors without sending a terminating signal;
9. call `collectEvidence()` after the process exits;
10. exit with the same code as ccloop after evidence writes finish.

The wrapper never retries and never maps the exit code to a scenario verdict.

- [ ] **Step 5: Implement human verdict finalization**

Accept:

```text
npx --no-install tsx validation/v1/scripts/finalize-review.ts \
  --evidence-dir <path> \
  --verdict PASS \
  --diagnosis null \
  --summary "Required checks and persisted state agree"
```

Validate exact enums, require a non-empty summary, refuse to overwrite `review.json`, and write:

```json
{
  "scenarioVerdict": "PASS",
  "diagnosis": null,
  "summary": "Required checks and persisted state agree",
  "reviewedAt": "<ISO timestamp>"
}
```

- [ ] **Step 6: Verify the harness without Claude**

Run:

```bash
npm test -- --run tests/validation/evidence.test.ts
npm test
npm run typecheck
npm run build
```

Expected: all tests and type checking PASS; build succeeds. No Claude process is launched.

- [ ] **Step 7: Optional commit checkpoint**

After explicit user approval:

```bash
git add validation/v1/lib/evidence.ts validation/v1/scripts/run-scenario.ts validation/v1/scripts/finalize-review.ts tests/validation/evidence.test.ts
git commit -m "test: add single-run evidence harness"
```

---

### Task 4: Operator Procedure and Preflight

**Files:**
- Create: `validation/v1/README.md`

**Interfaces:**
- Consumes: Tasks 1-3 CLIs.
- Produces: exact operator commands and stop gates; no product behavior.

- [ ] **Step 1: Write the operator procedure**

Document:

1. build/test/typecheck preflight;
2. fixture creation;
3. `claude --version` and `claude --help` checks without a model call;
4. A→B→C→D→E ordering;
5. new run/evidence directory for every invocation;
6. the cost-approval checkpoint before each call;
7. C/D timeout calibration from event timestamps, never by editing product code;
8. artifact status and verdict/diagnosis definitions;
9. immediate stop conditions: main checkout change, uncontrolled descendant, path escape, corrupt irreconcilable evidence;
10. no cleanup of retained worktrees or historical evidence;
11. defect gate: preserve evidence, stop, and create a defect-specific plan.

Use concrete command forms from Tasks 1-3. For run IDs, instruct the operator to choose a unique literal such as `A-01`; do not use destructive overwrite or cleanup commands.

- [ ] **Step 2: Run preflight**

Run:

```bash
npm ci
npm test
npm run typecheck
npm run build
claude --version
claude --help >/dev/null
npx --no-install tsx validation/v1/scripts/create-fixture.ts --output .validation-runs/fixture-01
```

Expected: dependency install succeeds; all tests pass; build succeeds; Claude reports a version and recognizes help; fixture creation prints JSON.

If authentication requires interactive action, stop and ask the user to run the exact login command themselves. Do not copy credentials into files or prompts.

- [ ] **Step 3: Verify generated fixture safety**

Run:

```bash
git -C .validation-runs/fixture-01 status --short
git -C .validation-runs/fixture-01 rev-list --count HEAD
find .validation-runs/fixture-01 -type l -print
```

Expected: status empty, commit count `1`, and no symlink output.

- [ ] **Step 4: Optional commit checkpoint**

After explicit user approval:

```bash
git add validation/v1/README.md
git commit -m "docs: add V1 evidence-run procedure"
```

---

### Task 5: Real Scenario A — Successful End-to-End Run

**Files:**
- Generate locally: `.validation-runs/contracts/A-01.json`
- Generate locally: `.validation-runs/runs/A-01/`
- Generate locally: `.validation-runs/evidence/A-01/`

**Interfaces:**
- Consumes: clean fixture, built ccloop, Claude adapter config.
- Produces: first real planner/executor/verifier evidence chain and timing baseline.

- [ ] **Step 1: Render A**

```bash
npx --no-install tsx validation/v1/scripts/render-contract.ts \
  --scenario A \
  --repo .validation-runs/fixture-01 \
  --output .validation-runs/contracts/A-01.json
```

Expected: strict contract written; `maxAttempts=1`, per-attempt timeout `300000ms`, total runtime budget `600000ms`, token budget `50000`.

- [ ] **Step 2: Obtain explicit cost approval**

Show the user: scenario A, one attempt, 5-minute phase timeout, 10-minute total runtime budget, and 50,000-token contract budget. Do not continue without approval for this call.

- [ ] **Step 3: Run A once**

```bash
npx --no-install tsx validation/v1/scripts/run-scenario.ts \
  --scenario A \
  --contract .validation-runs/contracts/A-01.json \
  --fixture .validation-runs/fixture-01 \
  --run-dir .validation-runs/runs/A-01 \
  --evidence-dir .validation-runs/evidence/A-01 \
  --adapter-config examples/v1/claude-adapter-config.json
```

Expected successful-path candidate: ccloop exit `0`, terminal state `succeeded`, required checks pass, verification is present, main fixture checkout remains clean, attempt worktree is removed.

Any other result is evidence, not permission to rerun or modify product code.

- [ ] **Step 4: Review and finalize A**

Inspect fixed evidence files plus the referenced run artifacts. Confirm target/allowlisted scope and absence of unrelated edits. Then run one exact verdict command, for example:

```bash
npx --no-install tsx validation/v1/scripts/finalize-review.ts \
  --evidence-dir .validation-runs/evidence/A-01 \
  --verdict PASS \
  --diagnosis null \
  --summary "Controller state, required checks, verifier evidence, Git diff, and cleanup agree"
```

Use FAIL or INCONCLUSIVE if the facts require it. If `FAIL / PRODUCT_DEFECT`, stop before Task 6 and follow Task 9's defect gate.

---

### Task 6: Real Scenario B — Pre-Verification Human Gate

**Files:**
- Generate locally: `.validation-runs/contracts/B-01.json`
- Generate locally: `.validation-runs/runs/B-01/`
- Generate locally: `.validation-runs/evidence/B-01/`

**Interfaces:**
- Produces: path-policy precedence and operator-handoff evidence.

- [ ] **Step 1: Render and approve B**

Render B using the same command shape as A with `--scenario B`. Show one attempt, 5-minute phase timeout, 10-minute total budget, and 50,000-token budget; obtain explicit approval.

- [ ] **Step 2: Run B once**

Use `run-scenario.ts` with literal paths `B-01`.

Expected candidate: exit `2`, `blocked_waiting_human`, stop reason identifies `restricted.txt`, worktree remains, execution/diff/log are present, verification and required checks are `NOT_RUN`, main checkout remains clean.

- [ ] **Step 3: Test handoff sufficiency**

Using only the run directory and Git commands, record whether an operator can identify run/attempt, stop reason, worktree path, baseline/current HEAD, changed files, plan/execution, verification/check status, and allowed next actions. Do not modify or remove the retained worktree.

- [ ] **Step 4: Finalize B**

Write PASS/FAIL/INCONCLUSIVE and diagnosis. If handoff facts are insufficient, classify the precise gap; only independently demonstrated unsafe or contradictory behavior is `PRODUCT_DEFECT`.

If `FAIL / PRODUCT_DEFECT`, stop before Task 7.

---

### Task 7: Real Scenarios C and D — Timeout Boundaries

**Files:**
- Generate locally: unique contracts, runs, and evidence directories for each calibration or final invocation.

**Interfaces:**
- C produces partial-outcome evidence.
- D documents the no-adapter-result boundary without claiming an unobservable clean worktree.

- [ ] **Step 1: Derive a timeout candidate**

Read A/B event timestamps to estimate plan duration. Choose a timeout greater than observed planning time but shorter than expected C execution. Record the calculation in a local text file under `.validation-runs/evidence/calibration/`; do not change ccloop source.

- [ ] **Step 2: Render and approve C**

Render C with the explicit timeout:

```bash
npx --no-install tsx validation/v1/scripts/render-contract.ts \
  --scenario C \
  --repo .validation-runs/fixture-01 \
  --timeout-ms <chosen-positive-integer> \
  --output .validation-runs/contracts/C-01.json
```

Before running, show one attempt, chosen timeout, resulting total runtime budget, 3-second recovery window, and 50,000-token budget; obtain explicit approval.

- [ ] **Step 3: Run and classify C once**

Run C with unique `C-01` paths. Expected candidate: non-success terminal state with a partial execution, replayable patch, untracked `src/partial-note.txt`, no forbidden path, no residual descendant, and cleaned non-human worktree.

If timing misses the intended window, classify `INCONCLUSIVE / ENVIRONMENT_FAILURE`. Do not silently rerun. Propose a new unique run ID and obtain approval before another paid call.

- [ ] **Step 4: Render, approve, and run D once**

Choose and record a D timeout using the same evidence-based method. Render D with that timeout, show its budget, obtain approval, and run with unique `D-01` paths.

Expected candidate: plan present; execution/diff/log `NOT_PRODUCED`; verification/checks `NOT_RUN`; non-success terminal state; main checkout clean. The review must not infer that the removed worktree contained no changes.

- [ ] **Step 5: Finalize C and D independently**

Write separate reviews. D defaults to `INCONCLUSIVE / CONTRACT_GAP` when current persisted evidence cannot distinguish no work from lost recoverable work. Report `PRODUCT_DEFECT` only if independent evidence proves a recoverable result existed and should have been persisted.

If either run confirms `FAIL / PRODUCT_DEFECT`, stop before Task 8.

---

### Task 8: Real Scenario E — Controller-Owned Verification Failure

**Files:**
- Generate locally: `.validation-runs/contracts/E-01.json`
- Generate locally: `.validation-runs/runs/E-01/`
- Generate locally: `.validation-runs/evidence/E-01/`

**Interfaces:**
- Produces: evidence that deterministic required-check failure overrides executor completion.

- [ ] **Step 1: Render and approve E**

Render E, show one attempt, 5-minute phase timeout, 10-minute total budget, and 50,000-token budget; obtain explicit approval.

- [ ] **Step 2: Run E once**

Use `run-scenario.ts` with `E-01` paths.

Expected candidate: exit `2`; implementation changes only `src/counter.js`; `npm test` fails against the unchanged test; verification records `required-check-failed`; final state is `exhausted` because the one-attempt limit takes precedence; worktree is cleaned; main checkout is unchanged.

- [ ] **Step 3: Finalize E**

PASS means the controller persisted the failed check and refused success. The intentionally failing task is not itself a product defect. A product defect requires success despite the failed required check, missing/contradictory controller evidence, unsafe path behavior, or uncontrolled resources.

---

### Task 9: Synthesis, Defect Gate, and Automation Handoff

**Files:**
- Create after runs: `docs/validation/ccloop-v1-evidence-report.md`
- Possibly create later: a defect-specific spec and plan only if confirmed evidence requires it.

**Interfaces:**
- Consumes: A-E `review.json`, evidence summaries, and local run paths.
- Produces: tracked evidence report and a bounded next-step decision.

- [ ] **Step 1: Write the evidence report**

Create `docs/validation/ccloop-v1-evidence-report.md` with:

- fixture baseline commit and tool versions;
- one row per actual invocation, including retries as separate rows;
- scenario verdict and diagnosis;
- local run/evidence paths;
- terminal and cleanup outcomes;
- confirmed findings with reproduction and evidence references;
- unresolved/inconclusive gaps;
- explicit statement that raw logs and generated artifacts remain local and ignored;
- deterministic automation candidates versus opt-in Claude integration candidates;
- V2 items deferred to `docs/ccloop-v2-review-backlog.md`.

Do not paste credentials, raw environment values, or unreviewed logs.

- [ ] **Step 2: Apply the product-defect gate**

For each `FAIL / PRODUCT_DEFECT`:

1. preserve the run and evidence unchanged;
2. stop broad execution;
3. invoke `superpowers:systematic-debugging` to establish root cause;
4. write a defect-specific design/plan naming exact product files and regression tests;
5. obtain approval before implementation;
6. after the fix, use a new run ID and repeat only the affected real scenario plus `npm test`, `npm run typecheck`, and `npm run build`.

Do not add speculative product tasks to this plan because the defect shape is not yet known.

- [ ] **Step 3: Verify report consistency**

Run:

```bash
for dir in .validation-runs/evidence/*-*; do
  test -f "$dir/review.json" || { printf 'missing review: %s\n' "$dir"; exit 1; }
done
grep -RIn -E 'ANTHROPIC_API_KEY=|sk-ant-|BEGIN .*PRIVATE KEY' docs/validation validation/v1 || true
git diff --check
npm test
npm run typecheck
npm run build
```

Expected: every actual scenario invocation has a review; secret scan prints nothing; diff check, tests, typecheck, and build pass. If the grep prints a match, stop and redact before staging anything.

- [ ] **Step 4: Optional final commit checkpoint**

After explicit user approval and review of staged content:

```bash
git add .gitignore validation/v1 tests/validation docs/validation/ccloop-v1-evidence-report.md
git diff --cached --check
git status --short
git commit -m "test: validate V1 with real Claude evidence"
```

Do not stage `.validation-runs/`, raw logs, credentials, or unrelated user changes.

- [ ] **Step 5: Decide the next phase**

If A-E evidence is complete and no product defect remains unresolved, start a separate brainstorming cycle for deterministic automation. If evidence instead shows recovery/ownership needs, review `docs/ccloop-v2-review-backlog.md` item by item and classify each candidate `ADOPT`, `MODIFY`, `REJECT`, or `STILL_DEFER` before creating a V2 design.
