# D Scenario Boundary Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement historical D reclassification plus future controller-owned execute boundary evidence so D-like runs distinguish pre-execute exhaustion from execute-entered interruption without any new paid run.

**Architecture:** Extend the existing controller/persistence pipeline with one new transition event (`execute_started`) and one new attempt artifact (`execution-recovery.json`), then add a small evidence-classification layer that derives D boundary classes and optional reclassification records from Layer A artifacts. Keep historical `review.json` immutable by writing any reinterpretation to a separate artifact instead of mutating accepted evidence.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, existing ccloop controller/persistence/evidence modules

## Global Constraints

- Applies only to D-scenario interpretation and the controller/evidence boundaries needed to classify D-like exhaustion paths.
- Do not change A/B/C/E scenario acceptance rules.
- Do not loosen token budgets, timeout budgets, retry policy, or stop precedence.
- Do not reinterpret historical evidence from raw terminal output alone.
- Do not treat observer/process evidence as a controller-of-record source of truth.
- Do not overwrite accepted historical artifacts in place.
- No new paid run is part of this implementation.
- Preserve original `review.json`; any reclassification must be a separate artifact or ledger entry.
- `PRE_EXECUTE_EXHAUSTION` maps to `INCONCLUSIVE / RUNTIME_VARIANCE`.
- True unresolved controller-boundary ambiguity remains the only path to `INCONCLUSIVE / CONTRACT_GAP`.
- Future controller runs must persist `execute_started` and `execution-recovery.json` at the specified boundaries.
- Follow existing controller/evidence architecture and deterministic tests.

---

## File Structure

- Modify: `src/runtime/types.ts` — add the controller-owned execution recovery type used by persistence and evidence classification.
- Modify: `src/persistence/fileStore.ts` — teach attempt artifact persistence to write `execution-recovery.json`.
- Modify: `src/controller/runLoop.ts` — append `execute_started` at the execute call boundary and persist recovery artifacts on interrupted execute paths before cleanup.
- Modify: `validation/v1/lib/evidence.ts` — add D-boundary classification, reclassification record schema, and helpers that use Layer A only.
- Modify: `validation/v1/scripts/finalize-review.ts` — optionally support writing a separate reclassification artifact without overwriting `review.json`.
- Modify: `tests/controller/runLoop.integration.test.ts` — add controller coverage for `execute_started` and `execution-recovery.json`.
- Modify: `tests/persistence/fileStore.test.ts` — verify the new recovery artifact persists at the expected path.
- Modify: `tests/validation/evidence.test.ts` — cover historical classification, unresolved fallbacks, verdict mapping, and separate reclassification output.
- Modify: `validation/v1/README.md` — document the new D interpretation and future evidence contract.
- Modify: `docs/handover/ccloop-handover.md` — record the accepted interpretation target for `D-01` once the deterministic rule exists.
- Modify: `.wolf/anatomy.md`, `.wolf/memory.md`, `.wolf/cerebrum.md`, `.wolf/buglog.json` — OpenWolf-required metadata updates while implementing.

### Task 1: Add controller-owned recovery artifact support

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/persistence/fileStore.ts`
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes: existing `AttemptArtifacts` persistence path `writeAttemptArtifacts(runDir: string, attempt: number, artifacts: AttemptArtifacts): Promise<void>`
- Produces:
  - `type ExecutionRecovery = { executeEntered: true; worktreeDiffObserved: true | false | "unknown"; diffPatchCaptured: boolean; stdoutStderrLogCaptured: boolean; changedPathsObserved: string[] | null; captureStatus: "complete" | "partial" | "failed"; cleanupStatus: "retained" | "removed"; failureBoundary: "timeout" | "token_exhausted" | "runtime_exhausted"; }`
  - `AttemptArtifacts["executionRecovery"]?: ExecutionRecovery`
  - persistence of `attempts/<n>/execution-recovery.json`

- [ ] **Step 1: Write the failing persistence test**

```ts
it("writes execution-recovery.json when execution recovery is present", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

  await writeAttemptArtifacts(runDir, 1, {
    plan: { summary: "plan", primaryTargetPaths: ["src/counter.js"] },
    executionRecovery: {
      executeEntered: true,
      worktreeDiffObserved: true,
      diffPatchCaptured: false,
      stdoutStderrLogCaptured: false,
      changedPathsObserved: ["src/counter.js"],
      captureStatus: "partial",
      cleanupStatus: "removed",
      failureBoundary: "token_exhausted",
    },
  });

  const contents = JSON.parse(
    await readFile(join(runDir, "attempts", "1", "execution-recovery.json"), "utf8"),
  ) as { executeEntered: true; failureBoundary: string };

  expect(contents.executeEntered).toBe(true);
  expect(contents.failureBoundary).toBe("token_exhausted");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/persistence/fileStore.test.ts --runInBand`
Expected: FAIL with `ENOENT` for `execution-recovery.json` or a TypeScript error because `executionRecovery` is not yet defined.

- [ ] **Step 3: Add the runtime type and persistence field**

```ts
export type ExecutionRecovery = {
  executeEntered: true;
  worktreeDiffObserved: true | false | "unknown";
  diffPatchCaptured: boolean;
  stdoutStderrLogCaptured: boolean;
  changedPathsObserved: string[] | null;
  captureStatus: "complete" | "partial" | "failed";
  cleanupStatus: "retained" | "removed";
  failureBoundary: "timeout" | "token_exhausted" | "runtime_exhausted";
};

export type AttemptArtifacts = {
  plan: unknown;
  execution?: unknown;
  verify?: unknown;
  diffPatch?: string;
  stdoutStderrLog?: string;
  executionRecovery?: ExecutionRecovery;
};

if (artifacts.executionRecovery !== undefined) {
  await writeFile(
    join(attemptDir, "execution-recovery.json"),
    JSON.stringify(artifacts.executionRecovery, null, 2),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/persistence/fileStore.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/types.ts src/persistence/fileStore.ts tests/persistence/fileStore.test.ts

git commit -m "feat: persist execution recovery artifacts"
```

### Task 2: Emit `execute_started` and recover interrupted execute boundaries

**Files:**
- Modify: `src/controller/runLoop.ts`
- Test: `tests/controller/runLoop.integration.test.ts`

**Interfaces:**
- Consumes:
  - `writeAttemptArtifacts(..., { executionRecovery })`
  - `appendTransitionEvent(runDir, state, type, detail)`
  - `ExecutionRecovery`
- Produces:
  - `execute_started` event emitted immediately before `adapter.execute(...)`
  - recovery persistence for interrupted execute paths with no complete `execution.json`

- [ ] **Step 1: Write the failing event-boundary test**

```ts
it("records execute_started before calling adapter.execute", async () => {
  const repoPath = await createRepo();
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  const contract = createContract(repoPath);
  const seenEventsBeforeExecute: string[][] = [];

  const adapter: RuntimeAdapter = {
    async plan() {
      return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
    },
    async execute(context) {
      seenEventsBeforeExecute.push(await readEventTypes(context.runDir));
      return {
        changedFiles: ["src/index.ts"],
        diffPatch: "diff --git a/src/index.ts b/src/index.ts",
        commandOutputs: ["edited"],
        stdoutStderrLog: "ok",
      };
    },
    async verify() {
      return {
        approved: true,
        rejectCategory: "",
        primaryTargetPaths: ["src/index.ts"],
        failingCommand: null,
        safeToRetry: false,
        evidence: ["done"],
        pauseSignals: [],
        stopSignals: [],
      };
    },
  };

  await runLoop(contract, runDir, adapter);

  expect(seenEventsBeforeExecute).toEqual([["loop_planning", "attempt_started", "execute_started"]]);
});
```

- [ ] **Step 2: Write the failing interrupted-execute recovery test**

```ts
it("persists execution-recovery.json when execute is entered but returns no result before exhaustion", async () => {
  const repoPath = await createRepo();
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  const baseContract = createContract(repoPath);
  const contract: LoopContract = {
    ...baseContract,
    executionPolicy: {
      ...baseContract.executionPolicy,
      perAttemptTimeoutMs: 20,
      totalRuntimeBudgetMs: 20,
      partialOutcomeRecoveryWindowMs: 10,
    },
  };

  const adapter: RuntimeAdapter = {
    async plan() {
      return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
    },
    async execute(context) {
      await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
      await waitForAbort(context.abortSignal);
      return null;
    },
    async verify() {
      throw new Error("verify should not run");
    },
  };

  await runLoop(contract, runDir, adapter);

  const recovery = JSON.parse(
    await readFile(join(runDir, "attempts", "1", "execution-recovery.json"), "utf8"),
  ) as { executeEntered: true; captureStatus: string; cleanupStatus: string };

  expect(recovery.executeEntered).toBe(true);
  expect(recovery.captureStatus).toBe("partial");
  expect(recovery.cleanupStatus).toBe("removed");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/controller/runLoop.integration.test.ts --runInBand`
Expected: FAIL because `execute_started` is missing and `execution-recovery.json` is not written.

- [ ] **Step 4: Implement the minimal controller changes**

```ts
await appendTransitionEvent(runDir, state, "attempt_started", `attempt ${attempt}`);
await writeRunState(runDir, state);
await appendTransitionEvent(runDir, state, "execute_started", `attempt ${attempt}`);

function buildExecutionRecovery(
  execution: ExecutionResult | null,
  changedPathsObserved: string[] | null,
  failureBoundary: ExecutionRecovery["failureBoundary"],
  cleanupStatus: ExecutionRecovery["cleanupStatus"],
): ExecutionRecovery {
  return {
    executeEntered: true,
    worktreeDiffObserved:
      execution === null ? (changedPathsObserved === null ? "unknown" : changedPathsObserved.length > 0) : execution.changedFiles.length > 0,
    diffPatchCaptured: execution?.diffPatch !== undefined,
    stdoutStderrLogCaptured: execution?.stdoutStderrLog !== undefined,
    changedPathsObserved,
    captureStatus: execution === null ? (changedPathsObserved === null ? "failed" : "partial") : "complete",
    cleanupStatus,
    failureBoundary,
  };
}

await writeAttemptArtifacts(runDir, attempt, {
  plan,
  executionRecovery: buildExecutionRecovery(null, changedPathsObserved, "token_exhausted", "removed"),
});
```

Implement `changedPathsObserved` using the existing worktree before cleanup with the smallest possible Git diff probe scoped to the attempt worktree.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/controller/runLoop.integration.test.ts --runInBand`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/controller/runLoop.ts tests/controller/runLoop.integration.test.ts

git commit -m "feat: record execute boundary recovery evidence"
```

### Task 3: Add historical D boundary classification and verdict mapping

**Files:**
- Modify: `validation/v1/lib/evidence.ts`
- Test: `tests/validation/evidence.test.ts`

**Interfaces:**
- Consumes: existing evidence reader inputs and `Review`
- Produces:
  - `type DBoundaryClassification = "PRE_EXECUTE_EXHAUSTION" | "EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE" | "EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE" | "BOUNDARY_UNRESOLVED"`
  - `function classifyDScenarioBoundary(record: EvidenceRecord): DBoundaryClassification`
  - `function mapDBoundaryToReview(boundary: DBoundaryClassification, record: EvidenceRecord): Pick<Review, "scenarioVerdict" | "diagnosis">`

- [ ] **Step 1: Write the failing classification tests**

```ts
it("classifies plan-only exhausted evidence as PRE_EXECUTE_EXHAUSTION", async () => {
  const input = createSyntheticRun({
    scenarioId: "D",
    events: [
      { type: "loop_planning", at: "2026-07-20T00:00:00.000Z", detail: "start" },
      { type: "loop_exhausted", at: "2026-07-20T00:00:05.000Z", detail: "runtime or token budget exhausted" },
    ],
    loopState: {
      status: "exhausted",
      stopReason: "runtime or token budget exhausted",
      waitingOnHuman: false,
    },
    artifacts: { plan: "present", execution: "missing", verify: "missing", diff: "missing", log: "missing" },
  });

  const record = await collectEvidence(input);

  expect(classifyDScenarioBoundary(record)).toBe("PRE_EXECUTE_EXHAUSTION");
  expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
    scenarioVerdict: "INCONCLUSIVE",
    diagnosis: "RUNTIME_VARIANCE",
  });
});

it("classifies contradictory Layer A evidence as BOUNDARY_UNRESOLVED", async () => {
  const input = createSyntheticRun({
    scenarioId: "D",
    events: [{ type: "loop_exhausted", at: "2026-07-20T00:00:05.000Z", detail: "runtime or token budget exhausted" }],
    loopState: { status: "failed", stopReason: "boom", waitingOnHuman: false },
    artifacts: { plan: "present", execution: "present", verify: "missing", diff: "missing", log: "missing" },
  });

  const record = await collectEvidence(input);

  expect(classifyDScenarioBoundary(record)).toBe("BOUNDARY_UNRESOLVED");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/validation/evidence.test.ts --runInBand`
Expected: FAIL because the new classifier and mapping helpers do not exist.

- [ ] **Step 3: Implement the classifier and mapping helpers**

```ts
export type DBoundaryClassification =
  | "PRE_EXECUTE_EXHAUSTION"
  | "EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE"
  | "EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE"
  | "BOUNDARY_UNRESOLVED";

export function classifyDScenarioBoundary(record: EvidenceRecord): DBoundaryClassification {
  const eventTypes = record.observations.events.status === "PRESENT" ? record.observations.events.types ?? [] : [];
  const hasAttemptStarted = eventTypes.includes("attempt_started");
  const hasExecuteStarted = eventTypes.includes("execute_started");
  const artifactStatus = Object.fromEntries(record.artifacts.map((artifact) => [artifact.name, artifact.status]));

  if (record.observations.events.status !== "PRESENT" || record.observations.loopState.status !== "PRESENT") {
    return "BOUNDARY_UNRESOLVED";
  }

  if (
    !hasAttemptStarted &&
    artifactStatus.plan === "PRESENT" &&
    artifactStatus.execution === "MISSING" &&
    artifactStatus.diff === "MISSING" &&
    artifactStatus.log === "MISSING" &&
    record.observations.terminalOutcome.status === "exhausted"
  ) {
    return "PRE_EXECUTE_EXHAUSTION";
  }

  if (hasExecuteStarted && artifactStatus.execution === "PRESENT") {
    return "EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE";
  }

  if (hasAttemptStarted) {
    return "EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE";
  }

  return "BOUNDARY_UNRESOLVED";
}

export function mapDBoundaryToReview(
  boundary: DBoundaryClassification,
  record: EvidenceRecord,
): Pick<Review, "scenarioVerdict" | "diagnosis"> {
  switch (boundary) {
    case "PRE_EXECUTE_EXHAUSTION":
      return { scenarioVerdict: "INCONCLUSIVE", diagnosis: "RUNTIME_VARIANCE" };
    case "EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE":
      return { scenarioVerdict: "INCONCLUSIVE", diagnosis: "CONTRACT_GAP" };
    case "EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE":
      return record.observations.cleanupOutcome.status === "WORKTREE_REMOVED"
        ? { scenarioVerdict: "PASS", diagnosis: null }
        : { scenarioVerdict: "FAIL", diagnosis: "PRODUCT_DEFECT" };
    default:
      return { scenarioVerdict: "INCONCLUSIVE", diagnosis: "CONTRACT_GAP" };
  }
}
```

Also extend event observation parsing so tests and classifier can inspect event types deterministically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/validation/evidence.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add validation/v1/lib/evidence.ts tests/validation/evidence.test.ts

git commit -m "feat: classify D scenario evidence boundaries"
```

### Task 4: Preserve historical reviews and add explicit reclassification output

**Files:**
- Modify: `validation/v1/lib/evidence.ts`
- Modify: `validation/v1/scripts/finalize-review.ts`
- Test: `tests/validation/evidence.test.ts`

**Interfaces:**
- Consumes: `Review`, `classifyDScenarioBoundary`, `mapDBoundaryToReview`
- Produces:
  - `type ReclassifiedReview = { original: Review; reclassified: Review; boundaryClassification: DBoundaryClassification; ruleVersion: string; evidenceReferences: string[] }`
  - CLI flag `--reclassify-from <review.json path>` or equivalent explicit input that writes `review-reclassified.json`

- [ ] **Step 1: Write the failing reclassification test**

```ts
it("writes review-reclassified.json without overwriting review.json", async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "ccloop-evidence-"));
  await writeFile(
    join(evidenceDir, "review.json"),
    JSON.stringify(
      {
        scenarioVerdict: "INCONCLUSIVE",
        diagnosis: "CONTRACT_GAP",
        summary: "Current persisted evidence cannot distinguish no work from lost recoverable work",
        reviewedAt: "2026-07-20T00:00:00.000Z",
      },
      null,
      2,
    ),
  );

  const exitCode = await main([
    "--evidence-dir",
    evidenceDir,
    "--verdict",
    "INCONCLUSIVE",
    "--diagnosis",
    "RUNTIME_VARIANCE",
    "--summary",
    "Reclassified as pre-execute exhaustion",
    "--output-name",
    "review-reclassified.json",
  ]);

  expect(exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(evidenceDir, "review.json"), "utf8"))).toMatchObject({
    diagnosis: "CONTRACT_GAP",
  });
  expect(JSON.parse(await readFile(join(evidenceDir, "review-reclassified.json"), "utf8"))).toMatchObject({
    diagnosis: "RUNTIME_VARIANCE",
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/validation/evidence.test.ts --runInBand`
Expected: FAIL because alternate output names or reclassification payloads are not yet supported.

- [ ] **Step 3: Implement separate reclassification output**

```ts
type ParsedArgs = {
  evidenceDir: string;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  diagnosis: "PRODUCT_DEFECT" | "RUNTIME_VARIANCE" | "ENVIRONMENT_FAILURE" | "CONTRACT_GAP" | null;
  summary: string;
  outputName: "review.json" | "review-reclassified.json";
};

const outputName = values.get("--output-name") === "review-reclassified.json"
  ? "review-reclassified.json"
  : "review.json";

const reviewPath = join(evidenceDir, outputName);
if (outputName === "review.json" && (await pathExists(reviewPath))) {
  throw new Error("review.json already exists");
}
```

If you choose to emit a richer reclassification object instead of a plain `Review`, define and validate that schema in `validation/v1/lib/evidence.ts` and update the test to assert the exact fields from the approved spec.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/validation/evidence.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add validation/v1/lib/evidence.ts validation/v1/scripts/finalize-review.ts tests/validation/evidence.test.ts

git commit -m "feat: preserve historical reviews during reclassification"
```

### Task 5: Align operator docs and handover with the implemented rule

**Files:**
- Modify: `validation/v1/README.md`
- Modify: `docs/handover/ccloop-handover.md`
- Modify: `.wolf/anatomy.md`
- Modify: `.wolf/memory.md`
- Modify: `.wolf/cerebrum.md`
- Modify: `.wolf/buglog.json`

**Interfaces:**
- Consumes: approved spec `docs/superpowers/specs/2026-07-20-d-scenario-boundary-classification-design.md`
- Produces:
  - operator-facing D interpretation note in `validation/v1/README.md`
  - handover note explaining the expected D-01 reclassification target once rule-based classification exists

- [ ] **Step 1: Write the doc diff before editing**

```md
- D historical runs may be reclassified from Layer A evidence only.
- `PRE_EXECUTE_EXHAUSTION` maps to `INCONCLUSIVE / RUNTIME_VARIANCE`.
- Future D runs will record `execute_started` and `execution-recovery.json`.
- Historical `review.json` artifacts remain immutable; any reinterpretation is separate.
```

- [ ] **Step 2: Update `validation/v1/README.md` with the D-boundary rule**

```md
## Scenario D interpretation

D evidence now distinguishes:
- `PRE_EXECUTE_EXHAUSTION` — plan persisted, no `attempt_started`, no execute artifacts, exhausted terminal state; maps to `INCONCLUSIVE / RUNTIME_VARIANCE`.
- `EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE` — execute path entered but controller-owned evidence still cannot prove whether recoverable work existed; maps to `INCONCLUSIVE / CONTRACT_GAP`.

Future D-class runs also persist `execute_started` and `execution-recovery.json`. Historical `review.json` files remain immutable; any reclassification must be emitted separately.
```

- [ ] **Step 3: Update `docs/handover/ccloop-handover.md` with the pending D-01 interpretation target**

```md
- Under the approved 2026-07-20 D-boundary classification design, `D-01` is expected to reclassify from `INCONCLUSIVE / CONTRACT_GAP` to `PRE_EXECUTE_EXHAUSTION`, which maps to `INCONCLUSIVE / RUNTIME_VARIANCE`, once the deterministic rule and separate reclassification artifact are implemented.
```

- [ ] **Step 4: Update OpenWolf records required by the project**

Append a `.wolf/memory.md` line in this format:

```md
| HH:MM | Implemented D boundary classification and recovery evidence plan/docs alignment | validation/v1/README.md, docs/handover/ccloop-handover.md, .wolf/anatomy.md, .wolf/memory.md, .wolf/cerebrum.md, .wolf/buglog.json | done | ~TOKENS |
```

Add a `.wolf/cerebrum.md` learning if implementation revealed any new D-boundary convention, and append `.wolf/buglog.json` only if a test/build failure or implementation bug occurred.

- [ ] **Step 5: Run focused verification and then full verification**

Run:

```bash
npm test -- tests/persistence/fileStore.test.ts --runInBand
npm test -- tests/controller/runLoop.integration.test.ts --runInBand
npm test -- tests/validation/evidence.test.ts --runInBand
npm test
npm run typecheck
npm run build
```

Expected: all commands PASS

- [ ] **Step 6: Commit**

```bash
git add validation/v1/README.md docs/handover/ccloop-handover.md .wolf/anatomy.md .wolf/memory.md .wolf/cerebrum.md .wolf/buglog.json

git commit -m "docs: align D boundary classification guidance"
```

## Self-Review

- **Spec coverage:**
  - Sections 1-3 are covered by Task 3’s Layer A classifier and Task 4’s separate reclassification output.
  - Sections 4-7 are covered by Task 2’s `execute_started` / `execution-recovery.json` changes and Task 3’s verdict mapping.
  - Section 8 is covered by Task 4’s immutable historical review handling.
  - Sections 9-11 are covered by Tasks 1-5 test and doc work.
- **Placeholder scan:** no `TBD`/`TODO` placeholders remain in task steps; every code step includes concrete snippets and commands.
- **Type consistency:** `ExecutionRecovery`, `DBoundaryClassification`, `classifyDScenarioBoundary`, and `mapDBoundaryToReview` are introduced before later tasks depend on them.

Plan complete and saved to `docs/superpowers/plans/2026-07-20-d-scenario-boundary-classification.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
