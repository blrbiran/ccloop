import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyDScenarioBoundary,
  collectArtifacts,
  collectEvidence,
  mapDBoundaryToReview,
  sha256File,
} from "../../validation/v1/lib/evidence.js";
import { getScenario, renderScenario } from "../../validation/v1/lib/scenarios.js";
import { createFixture } from "../../validation/v1/scripts/create-fixture.js";

const execFileAsync = promisify(execFile);
const worktreeRoot = process.cwd();
const finalizeReviewScript = join(worktreeRoot, "validation", "v1", "scripts", "finalize-review.ts");
const runScenarioScript = join(worktreeRoot, "validation", "v1", "scripts", "run-scenario.ts");
const templateDir = join(worktreeRoot, "validation", "v1", "fixture");
const tsxBin = join(worktreeRoot, "node_modules", ".bin", "tsx");
const strayProcesses: Array<ReturnType<typeof spawn>> = [];

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureBuilt(): Promise<void> {
  if (await pathExists(join(worktreeRoot, "dist", "cli.js"))) {
    return;
  }

  await execFileAsync("npm", ["run", "build"], { cwd: worktreeRoot });
}

type SyntheticRunOptions = {
  scenarioId: "A" | "B" | "D";
  invalidLoopState?: boolean;
  invalidEvents?: boolean;
  omitPlan?: boolean;
  escapePlan?: boolean;
  events?: Array<{ type: string; at: string; detail: string }>;
  loopState?: {
    status: string;
    stopReason: string;
    waitingOnHuman: boolean;
  };
  artifacts?: Partial<Record<"plan" | "execution" | "verify" | "diff" | "log", "present" | "missing">>;
  verifyContents?: string;
};

async function createSyntheticRun(options: SyntheticRunOptions): Promise<{ runDir: string; evidenceDir: string }> {
  const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-evidence-"));
  const runDir = join(tempRoot, "run");
  const evidenceDir = join(tempRoot, "evidence");
  const scenario = getScenario(options.scenarioId);
  await mkdir(join(runDir, "attempts", "1"), { recursive: true });
  await mkdir(join(runDir, "worktrees"), { recursive: true });

  const contract =
    options.scenarioId === "D"
      ? renderScenario(options.scenarioId, { repoPath: "/tmp/fixture", timeoutMs: 1234 })
      : renderScenario(options.scenarioId, { repoPath: "/tmp/fixture" });

  const defaultLoopState = {
    status: options.scenarioId === "A" ? "succeeded" : options.scenarioId === "B" ? "blocked_waiting_human" : "exhausted",
    stopReason:
      options.scenarioId === "A"
        ? "success condition satisfied"
        : options.scenarioId === "B"
          ? "denylist match: restricted.txt"
          : "execute phase exceeded per-attempt timeout of 1234ms",
    waitingOnHuman: options.scenarioId === "B",
  };

  const loopState = {
    status: options.loopState?.status ?? defaultLoopState.status,
    currentAttempt: 1,
    attemptsUsed: 1,
    lastTransitionAt: "2026-07-17T00:00:00.000Z",
    waitingOnHuman: options.loopState?.waitingOnHuman ?? defaultLoopState.waitingOnHuman,
    stopReason: options.loopState?.stopReason ?? defaultLoopState.stopReason,
    budgetSnapshot: {
      attemptsRemaining: 0,
      timeRemainingMs: 500000,
      tokenBudgetRemaining: 49000,
    },
    recentFailures: [],
  };

  await writeFile(join(runDir, "loop-contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
  await writeFile(
    join(runDir, "loop-state.json"),
    options.invalidLoopState ? "{not json\n" : `${JSON.stringify(loopState, null, 2)}\n`,
  );

  const defaultEvents = [
    { type: "attempt_started", at: "2026-07-17T00:00:00.000Z", detail: "attempt 1" },
    { type: `loop_${loopState.status}`, at: "2026-07-17T00:01:00.000Z", detail: loopState.stopReason },
  ];
  const eventLines = options.invalidEvents
    ? ['{"type":"attempt_started"}', 'not json']
    : (options.events ?? defaultEvents).map((event) => JSON.stringify(event));
  await writeFile(join(runDir, "events.jsonl"), `${eventLines.join("\n")}\n`);

  const artifactMode = {
    plan: options.omitPlan ? "missing" : (options.artifacts?.plan ?? "present"),
    execution: options.artifacts?.execution ?? (scenario.expectedArtifacts.execution === "PRESENT" ? "present" : "missing"),
    verify: options.artifacts?.verify ?? (scenario.expectedArtifacts.verify === "PRESENT" ? "present" : "missing"),
    diff: options.artifacts?.diff ?? (scenario.expectedArtifacts.diff === "PRESENT" ? "present" : "missing"),
    log: options.artifacts?.log ?? (scenario.expectedArtifacts.log === "PRESENT" ? "present" : "missing"),
  } as const;

  if (artifactMode.plan === "present") {
    if (options.escapePlan) {
      const outsidePath = join(tempRoot, "outside-plan.json");
      await writeFile(outsidePath, '{"summary":"outside","primaryTargetPaths":[]}\n');
      await symlink(outsidePath, join(runDir, "attempts", "1", "plan.json"));
    } else {
      await writeFile(
        join(runDir, "attempts", "1", "plan.json"),
        '{"summary":"edit src/counter.js","primaryTargetPaths":["src/counter.js"]}\n',
      );
    }
  }

  if (artifactMode.execution === "present") {
    await writeFile(
      join(runDir, "attempts", "1", "execution.json"),
      '{"changedFiles":["src/counter.js"],"diffPatch":"diff --git a/src/counter.js b/src/counter.js","commandOutputs":["edited"],"stdoutStderrLog":"ok"}\n',
    );
  }

  if (artifactMode.verify === "present") {
    await writeFile(
      join(runDir, "attempts", "1", "verify.json"),
      options.verifyContents ??
        '{"approved":true,"rejectCategory":"","primaryTargetPaths":["src/counter.js"],"failingCommand":null,"safeToRetry":false,"evidence":["command output | required check passed: npm test"],"pauseSignals":[],"stopSignals":[]}\n',
    );
  }

  if (artifactMode.diff === "present") {
    await writeFile(join(runDir, "attempts", "1", "diff.patch"), "diff --git a/src/counter.js b/src/counter.js\n");
  }

  if (artifactMode.log === "present") {
    await writeFile(join(runDir, "attempts", "1", "stdout-stderr.log"), "ok\n");
  }

  return { runDir, evidenceDir };
}

function baseInput(runDir: string, evidenceDir: string) {
  return {
    evidenceDir,
    runDir,
    invocation: {
      startedAt: "2026-07-17T00:00:00.000Z",
      endedAt: "2026-07-17T00:00:01.000Z",
      durationMs: 1000,
      command: ["node", "dist/cli.js", "run"],
      exitCode: 0,
      envNames: ["PATH", "HOME"],
    },
    git: {
      before: { head: "abc123", status: "" },
      after: { head: "abc123", status: "" },
      worktreeList: "fixture /tmp/fixture\n",
      mainCheckoutChanged: false,
    },
    processes: {
      rootPid: 123,
      observedDescendants: [],
      survivorPids: [],
      claudeChildExited: "NOT_OBSERVABLE" as const,
    },
  };
}

afterEach(() => {
  for (const child of strayProcesses.splice(0)) {
    try {
      child.kill("SIGTERM");
    } catch {
      // no-op
    }
  }
});

describe("evidence collection", () => {
  it("collects synthetic scenario A evidence and writes evidence JSON files", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({ scenarioId: "A" });
    const evidence = await collectEvidence({
      scenario: getScenario("A"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(evidence).toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          name: "plan",
          status: "PRESENT",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ]),
      requiredChecks: expect.objectContaining({ status: "PRESENT" }),
      observations: {
        loopState: expect.objectContaining({ status: "PRESENT" }),
        events: expect.objectContaining({ status: "PRESENT", count: 2 }),
        terminalOutcome: expect.objectContaining({ status: "succeeded" }),
      },
    });

    expect(await pathExists(join(evidenceDir, "invocation.json"))).toBe(true);
    expect(await pathExists(join(evidenceDir, "artifacts.json"))).toBe(true);
    expect(await pathExists(join(evidenceDir, "git.json"))).toBe(true);
    expect(await pathExists(join(evidenceDir, "processes.json"))).toBe(true);
    expect(await pathExists(join(evidenceDir, "observations.json"))).toBe(true);
  });

  it("marks required checks as NOT_RUN for synthetic scenario B", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({ scenarioId: "B" });

    await expect(
      collectEvidence({
        scenario: getScenario("B"),
        ...baseInput(runDir, evidenceDir),
      }),
    ).resolves.toMatchObject({
      requiredChecks: { status: "NOT_RUN" },
    });
  });

  it("marks execution as NOT_PRODUCED for synthetic scenario D", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({ scenarioId: "D" });
    const evidence = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(evidence.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "execution", status: "NOT_PRODUCED" })]),
    );
  });


  it("classifies plan-only exhausted evidence as PRE_EXECUTE_EXHAUSTION", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({
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

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(classifyDScenarioBoundary(record)).toBe("PRE_EXECUTE_EXHAUSTION");
    expect(record.observations.events).toMatchObject({
      status: "PRESENT",
      types: ["loop_planning", "loop_exhausted"],
    });
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "INCONCLUSIVE",
      diagnosis: "RUNTIME_VARIANCE",
    });
  });

  it("classifies contradictory Layer A evidence as BOUNDARY_UNRESOLVED", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({
      scenarioId: "D",
      events: [{ type: "loop_exhausted", at: "2026-07-20T00:00:05.000Z", detail: "runtime or token budget exhausted" }],
      loopState: { status: "failed", stopReason: "boom", waitingOnHuman: false },
      artifacts: { plan: "present", execution: "present", verify: "missing", diff: "missing", log: "missing" },
    });

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(classifyDScenarioBoundary(record)).toBe("BOUNDARY_UNRESOLVED");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "INCONCLUSIVE",
      diagnosis: "CONTRACT_GAP",
    });
  });


  it("maps execute-entered evidence without recoverable proof to INCONCLUSIVE CONTRACT_GAP", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({
      scenarioId: "D",
      events: [
        { type: "attempt_started", at: "2026-07-20T00:00:00.000Z", detail: "attempt 1" },
        { type: "loop_exhausted", at: "2026-07-20T00:00:05.000Z", detail: "runtime or token budget exhausted" },
      ],
      loopState: {
        status: "exhausted",
        stopReason: "runtime or token budget exhausted",
        waitingOnHuman: false,
      },
      artifacts: { plan: "present", execution: "missing", verify: "missing", diff: "missing", log: "missing" },
    });

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(classifyDScenarioBoundary(record)).toBe("EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "INCONCLUSIVE",
      diagnosis: "CONTRACT_GAP",
    });
  });

  it("requires controller-owned recoverable evidence before classifying execute-entered evidence as recoverable", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({
      scenarioId: "D",
      events: [
        { type: "attempt_started", at: "2026-07-20T00:00:00.000Z", detail: "attempt 1" },
        { type: "execute_started", at: "2026-07-20T00:00:01.000Z", detail: "attempt 1 entered execute" },
        { type: "loop_exhausted", at: "2026-07-20T00:00:05.000Z", detail: "runtime or token budget exhausted" },
      ],
      loopState: {
        status: "exhausted",
        stopReason: "runtime or token budget exhausted",
        waitingOnHuman: false,
      },
      artifacts: { plan: "present", execution: "missing", verify: "missing", diff: "missing", log: "missing" },
    });

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(classifyDScenarioBoundary(record)).toBe("EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "INCONCLUSIVE",
      diagnosis: "CONTRACT_GAP",
    });
  });


  it("treats malformed execution-recovery.json as BOUNDARY_UNRESOLVED instead of recoverable evidence", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({
      scenarioId: "D",
      events: [
        { type: "attempt_started", at: "2026-07-20T00:00:00.000Z", detail: "attempt 1" },
        { type: "execute_started", at: "2026-07-20T00:00:01.000Z", detail: "attempt 1 entered execute" },
        { type: "loop_exhausted", at: "2026-07-20T00:00:05.000Z", detail: "runtime or token budget exhausted" },
      ],
      loopState: {
        status: "exhausted",
        stopReason: "runtime or token budget exhausted",
        waitingOnHuman: false,
      },
      artifacts: { plan: "present", execution: "missing", verify: "missing", diff: "missing", log: "missing" },
    });

    await writeFile(
      join(runDir, "attempts", "1", "execution-recovery.json"),
      JSON.stringify(
        {
          executeEntered: true,
          worktreeDiffObserved: false,
          diffPatchCaptured: false,
          stdoutStderrLogCaptured: false,
          changedPathsObserved: null,
          captureStatus: "complete",
          failureBoundary: "timeout",
        },
        null,
        2,
      ) + "\n",
    );

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(record.executionRecovery).toMatchObject({
      status: "INVALID",
      error: expect.stringMatching(/shape invalid/i),
    });
    expect(classifyDScenarioBoundary(record)).toBe("BOUNDARY_UNRESOLVED");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "INCONCLUSIVE",
      diagnosis: "CONTRACT_GAP",
    });
  });

  it("disqualifies PRE_EXECUTE_EXHAUSTION when verify.json proves later attempt handling began", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({
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
      artifacts: { plan: "present", execution: "missing", verify: "present", diff: "missing", log: "missing" },
      verifyContents:
        '{"approved":false,"rejectCategory":"timeout","primaryTargetPaths":["src/counter.js"],"failingCommand":null,"safeToRetry":true,"evidence":["verification started after execute boundary"],"pauseSignals":[],"stopSignals":[]}\n',
    });

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(record.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "verify", status: "INVALID" })]));
    expect(classifyDScenarioBoundary(record)).toBe("BOUNDARY_UNRESOLVED");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "INCONCLUSIVE",
      diagnosis: "CONTRACT_GAP",
    });
  });

  it("maps execute-entered recoverable evidence to PASS only when the stronger no-recoverable-work D shape is satisfied", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({
      scenarioId: "D",
      events: [
        { type: "attempt_started", at: "2026-07-20T00:00:00.000Z", detail: "attempt 1" },
        { type: "execute_started", at: "2026-07-20T00:00:01.000Z", detail: "attempt 1 entered execute" },
        { type: "loop_exhausted", at: "2026-07-20T00:00:05.000Z", detail: "runtime or token budget exhausted" },
      ],
      loopState: {
        status: "exhausted",
        stopReason: "runtime or token budget exhausted",
        waitingOnHuman: false,
      },
      artifacts: { plan: "present", execution: "missing", verify: "missing", diff: "missing", log: "missing" },
    });

    await writeFile(
      join(runDir, "attempts", "1", "execution-recovery.json"),
      JSON.stringify(
        {
          executeEntered: true,
          worktreeDiffObserved: false,
          diffPatchCaptured: false,
          stdoutStderrLogCaptured: false,
          changedPathsObserved: null,
          captureStatus: "complete",
          cleanupStatus: "removed",
          failureBoundary: "timeout",
        },
        null,
        2,
      ) + "\n",
    );

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(classifyDScenarioBoundary(record)).toBe("EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "PASS",
      diagnosis: null,
    });
  });

  it("does not award PASS for execute-entered recoverable evidence when standard D evidence shape is violated", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({
      scenarioId: "D",
      events: [
        { type: "attempt_started", at: "2026-07-20T00:00:00.000Z", detail: "attempt 1" },
        { type: "execute_started", at: "2026-07-20T00:00:01.000Z", detail: "attempt 1 entered execute" },
        { type: "loop_exhausted", at: "2026-07-20T00:00:05.000Z", detail: "runtime or token budget exhausted" },
      ],
      loopState: {
        status: "exhausted",
        stopReason: "runtime or token budget exhausted",
        waitingOnHuman: false,
      },
      artifacts: { plan: "present", execution: "present", verify: "missing", diff: "missing", log: "missing" },
    });

    await writeFile(
      join(runDir, "attempts", "1", "execution-recovery.json"),
      JSON.stringify(
        {
          executeEntered: true,
          worktreeDiffObserved: true,
          diffPatchCaptured: false,
          stdoutStderrLogCaptured: false,
          changedPathsObserved: ["src/counter.js"],
          captureStatus: "complete",
          cleanupStatus: "removed",
          failureBoundary: "timeout",
        },
        null,
        2,
      ) + "\n",
    );

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(classifyDScenarioBoundary(record)).toBe("EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "FAIL",
      diagnosis: "PRODUCT_DEFECT",
    });
  });

  it("surfaces malformed loop-state.json as INVALID", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({ scenarioId: "A", invalidLoopState: true });
    const evidence = await collectEvidence({
      scenario: getScenario("A"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(evidence.observations.loopState).toMatchObject({
      status: "INVALID",
      error: expect.stringMatching(/JSON/),
    });
  });

  it("surfaces malformed events.jsonl as INVALID", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({ scenarioId: "A", invalidEvents: true });
    const evidence = await collectEvidence({
      scenario: getScenario("A"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(evidence.observations.events).toMatchObject({
      status: "INVALID",
      error: expect.stringMatching(/line 2/i),
    });
  });

  it("marks an expected-present artifact as MISSING when absent", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({ scenarioId: "A", omitPlan: true });
    const evidence = await collectEvidence({
      scenario: getScenario("A"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(evidence.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "plan", status: "MISSING" })]));
  });

  it("rejects artifact paths that escape the run directory", async () => {
    const { runDir } = await createSyntheticRun({ scenarioId: "A", escapePlan: true });
    const artifacts = await collectArtifacts({
      scenario: getScenario("A"),
      runDir,
    });

    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "plan",
          status: "INVALID",
          error: expect.stringMatching(/escapes runDir/),
        }),
      ]),
    );
  });


  it("accepts legacy attempt artifacts that omit usageEvidence", async () => {
    const runDir = join(worktreeRoot, "tests", "fixtures", "legacy-attempt-artifacts");
    const evidenceDir = await mkdtemp(join(tmpdir(), "ccloop-evidence-legacy-"));
    const planPath = join(runDir, "attempts", "1", "plan.json");
    const executionPath = join(runDir, "attempts", "1", "execution.json");
    const verifyPath = join(runDir, "attempts", "1", "verify.json");

    const [planSha, executionSha, verifySha, plan, execution, verify, evidence] = await Promise.all([
      sha256File(planPath),
      sha256File(executionPath),
      sha256File(verifyPath),
      readFile(planPath, "utf8").then((contents) => JSON.parse(contents) as {
        summary: string;
        primaryTargetPaths: string[];
        tokenUsage: number;
        usageEvidence?: unknown;
      }),
      readFile(executionPath, "utf8").then((contents) => JSON.parse(contents) as {
        changedFiles: string[];
        tokenUsage: number;
        usageEvidence?: unknown;
      }),
      readFile(verifyPath, "utf8").then((contents) => JSON.parse(contents) as {
        approved: boolean;
        evidence: string[];
        tokenUsage: number;
        usageEvidence?: unknown;
      }),
      collectEvidence({
        scenario: getScenario("A"),
        ...baseInput(runDir, evidenceDir),
      }),
    ]);

    expect(plan).not.toHaveProperty("usageEvidence");
    expect(execution).not.toHaveProperty("usageEvidence");
    expect(verify).not.toHaveProperty("usageEvidence");
    expect(plan.summary).toBe("legacy plan without usage evidence");
    expect(plan.primaryTargetPaths).toEqual(["src/counter.js", "test/counter.test.js"]);
    expect(plan.tokenUsage).toBe(110);
    expect(execution.changedFiles).toEqual(["src/counter.js", "test/counter.test.js"]);
    expect(execution.tokenUsage).toBe(220);
    expect(verify.approved).toBe(true);
    expect(verify.evidence).toEqual(["command output | required check passed: npm test"]);
    expect(verify.tokenUsage).toBe(330);

    expect(
      evidence.artifacts
        .filter((artifact) => artifact.name === "plan" || artifact.name === "execution" || artifact.name === "verify")
        .map((artifact) => ({ name: artifact.name, status: artifact.status, sha256: artifact.sha256 })),
    ).toEqual([
      { name: "plan", status: "PRESENT", sha256: planSha },
      { name: "execution", status: "PRESENT", sha256: executionSha },
      { name: "verify", status: "PRESENT", sha256: verifySha },
    ]);
    expect(evidence.requiredChecks).toMatchObject({ status: "PRESENT" });
  });

  it("requires evidence for every required check declared in loop-contract.json", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({ scenarioId: "A" });
    const contractPath = join(runDir, "loop-contract.json");
    const contract = JSON.parse(await readFile(contractPath, "utf8")) as {
      verification: { requiredChecks: string[] };
    };
    contract.verification.requiredChecks = ["npm test", "npm run lint"];
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}
`);

    const evidence = await collectEvidence({
      scenario: getScenario("A"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(evidence.requiredChecks).toMatchObject({
      status: "MISSING",
      error: expect.stringMatching(/npm run lint/),
    });
  });
});

describe("finalize-review CLI", () => {
  it("rejects unknown verdicts and diagnoses", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-finalize-review-"));
    const evidenceDir = join(tempRoot, "evidence");
    await mkdir(evidenceDir, { recursive: true });

    await expect(
      execFileAsync(
        "npx",
        [
          "--no-install",
          "tsx",
          finalizeReviewScript,
          "--evidence-dir",
          evidenceDir,
          "--verdict",
          "MAYBE",
          "--diagnosis",
          "null",
          "--summary",
          "summary",
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/scenarioVerdict/) });

    await expect(
      execFileAsync(
        "npx",
        [
          "--no-install",
          "tsx",
          finalizeReviewScript,
          "--evidence-dir",
          evidenceDir,
          "--verdict",
          "PASS",
          "--diagnosis",
          "UNKNOWN",
          "--summary",
          "summary",
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/diagnosis/) });
  });

  it("stores diagnosis null as JSON null and refuses overwrite", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-finalize-review-"));
    const evidenceDir = join(tempRoot, "evidence");
    await mkdir(evidenceDir, { recursive: true });

    await execFileAsync(
      "npx",
      [
        "--no-install",
        "tsx",
        finalizeReviewScript,
        "--evidence-dir",
        evidenceDir,
        "--verdict",
        "PASS",
        "--diagnosis",
        "null",
        "--summary",
        "Required checks and persisted state agree",
      ],
      { cwd: worktreeRoot },
    );

    const review = JSON.parse(await readFile(join(evidenceDir, "review.json"), "utf8")) as {
      diagnosis: null;
      summary: string;
      reviewedAt: string;
    };
    expect(review.diagnosis).toBeNull();
    expect(review.summary).toBe("Required checks and persisted state agree");
    expect(review.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await expect(
      execFileAsync(
        "npx",
        [
          "--no-install",
          "tsx",
          finalizeReviewScript,
          "--evidence-dir",
          evidenceDir,
          "--verdict",
          "FAIL",
          "--diagnosis",
          "PRODUCT_DEFECT",
          "--summary",
          "second write",
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/review.json already exists/) });
  });
});

describe("run-scenario CLI", () => {
  it("records env names only and tracks descendants rooted at the spawned pid", async () => {
    await ensureBuilt();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-run-scenario-"));
    const fixtureDir = join(tempRoot, "fixture");
    const contractPath = join(tempRoot, "scenario-a.json");
    const adapterScriptPath = join(tempRoot, "fake-claude-runner.mjs");
    const adapterConfigPath = join(tempRoot, "adapter-config.json");
    const runDir = join(tempRoot, "run");
    const evidenceDir = join(tempRoot, "evidence");
    const fixture = await createFixture(templateDir, fixtureDir);
    const contract = renderScenario("A", { repoPath: fixture.repoPath });
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    await writeFile(
      adapterScriptPath,
      `import { spawn } from "node:child_process";\nconst chunks = [];\nfor await (const chunk of process.stdin) chunks.push(chunk);\nconst request = JSON.parse(Buffer.concat(chunks).toString("utf8"));\nif (!process.env.CCLOOP_SECRET) { console.error("missing CCLOOP_SECRET"); process.exit(1); }\nif (request.phase === "plan") { process.stdout.write(JSON.stringify({ summary: "probe env", primaryTargetPaths: ["src/counter.js"] })); } else if (request.phase === "execute") { process.stdout.write(JSON.stringify({ changedFiles: ["src/counter.js"], diffPatch: "diff --git a/src/counter.js b/src/counter.js", commandOutputs: ["edited"], stdoutStderrLog: "ok" })); } else { const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { stdio: "ignore" }); await new Promise((resolve) => setTimeout(resolve, 300)); process.stdout.write(JSON.stringify({ approved: true, rejectCategory: "", primaryTargetPaths: ["src/counter.js"], failingCommand: null, safeToRetry: false, evidence: ["synthetic verification"], pauseSignals: [], stopSignals: [] })); }\n`,
    );
    await writeFile(adapterConfigPath, `${JSON.stringify({ command: [process.execPath, adapterScriptPath] }, null, 2)}\n`);

    const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1200)"], { stdio: "ignore" });
    strayProcesses.push(unrelated);

    await execFileAsync(
      "npx",
      [
        "--no-install",
        "tsx",
        runScenarioScript,
        "--scenario",
        "A",
        "--contract",
        contractPath,
        "--fixture",
        fixture.repoPath,
        "--run-dir",
        runDir,
        "--evidence-dir",
        evidenceDir,
        "--adapter-config",
        adapterConfigPath,
        "--pass-env",
        "CCLOOP_SECRET",
      ],
      {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          CCLOOP_SECRET: "top-secret-value",
        },
      },
    );

    const invocation = JSON.parse(await readFile(join(evidenceDir, "invocation.json"), "utf8")) as {
      envNames: string[];
      command: string[];
    };
    const processes = JSON.parse(await readFile(join(evidenceDir, "processes.json"), "utf8")) as {
      observedDescendants: Array<{ pid: number; command: string }>;
      claudeChildExited: string;
      survivorPids: number[];
      rootPid: number;
    };
    const git = JSON.parse(await readFile(join(evidenceDir, "git.json"), "utf8")) as {
      before: { status: string };
      after: { status: string };
      mainCheckoutChanged: boolean;
    };
    const combinedEvidenceText = [
      await readFile(join(evidenceDir, "invocation.json"), "utf8"),
      await readFile(join(evidenceDir, "artifacts.json"), "utf8"),
      await readFile(join(evidenceDir, "git.json"), "utf8"),
      await readFile(join(evidenceDir, "processes.json"), "utf8"),
      await readFile(join(evidenceDir, "observations.json"), "utf8"),
    ].join("\n");

    expect(invocation.command).toEqual([
      "node",
      "dist/cli.js",
      "run",
      "--contract",
      contractPath,
      "--run-dir",
      runDir,
      "--adapter",
      "claude",
      "--adapter-config",
      adapterConfigPath,
    ]);
    expect(invocation.envNames).toEqual(expect.arrayContaining(["PATH", "HOME", "CCLOOP_SECRET"]));
    expect(combinedEvidenceText).not.toContain("top-secret-value");
    expect(processes.rootPid).toBeGreaterThan(0);
    expect(processes.observedDescendants.length).toBeGreaterThan(0);
    expect(processes.observedDescendants.map((entry) => entry.pid)).not.toContain(unrelated.pid ?? -1);
    expect(processes.claudeChildExited).toBe("NOT_OBSERVABLE");
    expect(processes.survivorPids).toEqual([]);
    expect(git.before.status).toBe("");
    expect(git.after.status).toBe("");
    expect(git.mainCheckoutChanged).toBe(false);
    expect(await pathExists(join(evidenceDir, "stdout.log"))).toBe(true);
    expect(await pathExists(join(evidenceDir, "stderr.log"))).toBe(true);
  });


  it("works when invoked outside the repo root", async () => {
    await ensureBuilt();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-run-scenario-cwd-"));
    const fixtureDir = join(tempRoot, "fixture");
    const contractPath = join(tempRoot, "scenario-a.json");
    const adapterScriptPath = join(tempRoot, "fake-claude-runner.mjs");
    const adapterConfigPath = join(tempRoot, "adapter-config.json");
    const runDir = join(tempRoot, "run");
    const evidenceDir = join(tempRoot, "evidence");
    const fixture = await createFixture(templateDir, fixtureDir);
    const contract = renderScenario("A", { repoPath: fixture.repoPath });
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}
`);
    await writeFile(
      adapterScriptPath,
      `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (request.phase === "plan") { process.stdout.write(JSON.stringify({ summary: "ok", primaryTargetPaths: ["src/counter.js"] })); } else if (request.phase === "execute") { process.stdout.write(JSON.stringify({ changedFiles: ["src/counter.js"], diffPatch: "diff --git a/src/counter.js b/src/counter.js", commandOutputs: ["edited"], stdoutStderrLog: "ok" })); } else { process.stdout.write(JSON.stringify({ approved: true, rejectCategory: "", primaryTargetPaths: ["src/counter.js"], failingCommand: null, safeToRetry: false, evidence: ["command output | required check passed: npm test"], pauseSignals: [], stopSignals: [] })); }
`,
    );
    await writeFile(adapterConfigPath, `${JSON.stringify({ command: [process.execPath, adapterScriptPath] }, null, 2)}
`);

    await execFileAsync(
      tsxBin,
      [
        runScenarioScript,
        "--scenario",
        "A",
        "--contract",
        contractPath,
        "--fixture",
        fixture.repoPath,
        "--run-dir",
        runDir,
        "--evidence-dir",
        evidenceDir,
        "--adapter-config",
        adapterConfigPath,
      ],
      { cwd: tempRoot },
    );

    const invocation = JSON.parse(await readFile(join(evidenceDir, "invocation.json"), "utf8")) as { exitCode: number };
    expect(invocation.exitCode).toBe(0);
  });

  it("runs when invoked through a canonical-path alias", async () => {
    await ensureBuilt();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-run-scenario-alias-"));
    const fixtureDir = join(tempRoot, "fixture");
    const contractPath = join(tempRoot, "scenario-a.json");
    const adapterScriptPath = join(tempRoot, "alias-claude-runner.mjs");
    const adapterConfigPath = join(tempRoot, "adapter-config.json");
    const runDir = join(tempRoot, "run");
    const evidenceDir = join(tempRoot, "evidence");
    const aliasedScriptPath = join(tempRoot, "run-scenario-alias.ts");
    const fixture = await createFixture(templateDir, fixtureDir);
    const contract = renderScenario("A", { repoPath: fixture.repoPath });
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}
`);
    await writeFile(
      adapterScriptPath,
      `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (request.phase === "plan") { process.stdout.write(JSON.stringify({ summary: "ok", primaryTargetPaths: ["src/counter.js"] })); } else if (request.phase === "execute") { process.stdout.write(JSON.stringify({ changedFiles: ["src/counter.js"], diffPatch: "diff --git a/src/counter.js b/src/counter.js", commandOutputs: ["edited"], stdoutStderrLog: "ok" })); } else { process.stdout.write(JSON.stringify({ approved: true, rejectCategory: "", primaryTargetPaths: ["src/counter.js"], failingCommand: null, safeToRetry: false, evidence: ["command output | required check passed: npm test"], pauseSignals: [], stopSignals: [] })); }
`,
    );
    await writeFile(adapterConfigPath, `${JSON.stringify({ command: [process.execPath, adapterScriptPath] }, null, 2)}
`);
    await symlink(await realpath(runScenarioScript), aliasedScriptPath);

    await execFileAsync(
      tsxBin,
      [
        aliasedScriptPath,
        "--scenario",
        "A",
        "--contract",
        contractPath,
        "--fixture",
        fixture.repoPath,
        "--run-dir",
        runDir,
        "--evidence-dir",
        evidenceDir,
        "--adapter-config",
        adapterConfigPath,
      ],
      { cwd: tempRoot },
    );

    const invocation = JSON.parse(await readFile(join(evidenceDir, "invocation.json"), "utf8")) as { exitCode: number };
    expect(invocation.exitCode).toBe(0);
  });


  it("creates a fresh nested evidence directory when its parent does not exist", async () => {
    await ensureBuilt();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-run-scenario-nested-evidence-"));
    const fixtureDir = join(tempRoot, "fixture");
    const contractDir = join(tempRoot, "contracts");
    const contractPath = join(contractDir, "A-01.json");
    const adapterScriptPath = join(tempRoot, "nested-evidence-runner.mjs");
    const adapterConfigPath = join(tempRoot, "adapter-config.json");
    const runDir = join(tempRoot, "runs", "A-01");
    const evidenceParentDir = join(tempRoot, "evidence");
    const evidenceDir = join(evidenceParentDir, "A-01");
    const fixture = await createFixture(templateDir, fixtureDir);
    const contract = renderScenario("A", { repoPath: fixture.repoPath });
    await mkdir(contractDir, { recursive: true });
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    await writeFile(
      adapterScriptPath,
      `const chunks = [];\nfor await (const chunk of process.stdin) chunks.push(chunk);\nconst request = JSON.parse(Buffer.concat(chunks).toString("utf8"));\nif (request.phase === "plan") { process.stdout.write(JSON.stringify({ summary: "ok", primaryTargetPaths: ["src/counter.js"] })); } else if (request.phase === "execute") { process.stdout.write(JSON.stringify({ changedFiles: ["src/counter.js"], diffPatch: "diff --git a/src/counter.js b/src/counter.js", commandOutputs: ["edited"], stdoutStderrLog: "ok" })); } else { process.stdout.write(JSON.stringify({ approved: true, rejectCategory: "", primaryTargetPaths: ["src/counter.js"], failingCommand: null, safeToRetry: false, evidence: ["command output | required check passed: npm test"], pauseSignals: [], stopSignals: [] })); }\n`,
    );
    await writeFile(adapterConfigPath, `${JSON.stringify({ command: [process.execPath, adapterScriptPath] }, null, 2)}\n`);

    expect(await pathExists(evidenceParentDir)).toBe(false);

    await execFileAsync(
      tsxBin,
      [
        runScenarioScript,
        "--scenario",
        "A",
        "--contract",
        contractPath,
        "--fixture",
        fixture.repoPath,
        "--run-dir",
        runDir,
        "--evidence-dir",
        evidenceDir,
        "--adapter-config",
        adapterConfigPath,
      ],
      { cwd: worktreeRoot },
    );

    expect(await pathExists(evidenceParentDir)).toBe(true);
    expect(await pathExists(evidenceDir)).toBe(true);
    expect(await pathExists(join(evidenceDir, "invocation.json"))).toBe(true);
    const invocation = JSON.parse(await readFile(join(evidenceDir, "invocation.json"), "utf8")) as { exitCode: number };
    expect(invocation.exitCode).toBe(0);
  });

  it("writes evidence files even when ccloop fails before creating the run directory", async () => {
    await ensureBuilt();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-run-scenario-early-failure-"));
    const fixtureDir = join(tempRoot, "fixture");
    const runDir = join(tempRoot, "run");
    const evidenceDir = join(tempRoot, "evidence");
    const fixture = await createFixture(templateDir, fixtureDir);
    const missingContractPath = join(tempRoot, "missing-contract.json");
    const adapterConfigPath = join(worktreeRoot, "examples", "v1", "claude-adapter-config.json");

    await expect(
      execFileAsync(
        tsxBin,
        [
          runScenarioScript,
          "--scenario",
          "A",
          "--contract",
          missingContractPath,
          "--fixture",
          fixture.repoPath,
          "--run-dir",
          runDir,
          "--evidence-dir",
          evidenceDir,
          "--adapter-config",
          adapterConfigPath,
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({});

    expect(await pathExists(join(evidenceDir, "invocation.json"))).toBe(true);
    expect(await pathExists(join(evidenceDir, "artifacts.json"))).toBe(true);
    expect(await pathExists(join(evidenceDir, "git.json"))).toBe(true);
    expect(await pathExists(join(evidenceDir, "processes.json"))).toBe(true);
    expect(await pathExists(join(evidenceDir, "observations.json"))).toBe(true);

    const observations = JSON.parse(await readFile(join(evidenceDir, "observations.json"), "utf8")) as {
      loopState: { status: string };
    };
    expect(observations.loopState.status).toBe("MISSING");
  });


  it("fails on an existing evidence directory without overwriting it", async () => {
    await ensureBuilt();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-run-scenario-existing-evidence-"));
    const fixtureDir = join(tempRoot, "fixture");
    const contractPath = join(tempRoot, "scenario-a.json");
    const runDir = join(tempRoot, "run");
    const evidenceDir = join(tempRoot, "evidence");
    const sentinelPath = join(evidenceDir, "artifacts.json");
    const adapterConfigPath = join(worktreeRoot, "examples", "v1", "claude-adapter-config.json");
    const fixture = await createFixture(templateDir, fixtureDir);
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(sentinelPath, '{"keep":"original"}\n');
    await writeFile(contractPath, `${JSON.stringify(renderScenario("A", { repoPath: fixture.repoPath }), null, 2)}\n`);

    await expect(
      execFileAsync(
        tsxBin,
        [
          runScenarioScript,
          "--scenario",
          "A",
          "--contract",
          contractPath,
          "--fixture",
          fixture.repoPath,
          "--run-dir",
          runDir,
          "--evidence-dir",
          evidenceDir,
          "--adapter-config",
          adapterConfigPath,
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/evidenceDir already exists/) });

    expect(await readFile(sentinelPath, "utf8")).toBe('{"keep":"original"}\n');
    expect(await pathExists(join(evidenceDir, "invocation.json"))).toBe(false);
    expect(await pathExists(runDir)).toBe(false);
  });

  it("fails on an existing run directory without creating evidence or harvesting stale run data", async () => {
    await ensureBuilt();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-run-scenario-existing-run-"));
    const fixtureDir = join(tempRoot, "fixture");
    const contractPath = join(tempRoot, "scenario-a.json");
    const runDir = join(tempRoot, "run");
    const evidenceDir = join(tempRoot, "evidence");
    const adapterConfigPath = join(worktreeRoot, "examples", "v1", "claude-adapter-config.json");
    const fixture = await createFixture(templateDir, fixtureDir);
    await mkdir(join(runDir, "attempts", "1"), { recursive: true });
    await writeFile(join(runDir, "loop-state.json"), '{"status":"succeeded"}\n');
    await writeFile(join(runDir, "events.jsonl"), '{"type":"loop_succeeded"}\n');
    await writeFile(join(runDir, "attempts", "1", "plan.json"), '{"summary":"stale"}\n');
    await writeFile(contractPath, `${JSON.stringify(renderScenario("A", { repoPath: fixture.repoPath }), null, 2)}\n`);

    await expect(
      execFileAsync(
        tsxBin,
        [
          runScenarioScript,
          "--scenario",
          "A",
          "--contract",
          contractPath,
          "--fixture",
          fixture.repoPath,
          "--run-dir",
          runDir,
          "--evidence-dir",
          evidenceDir,
          "--adapter-config",
          adapterConfigPath,
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/runDir already exists/) });

    expect(await pathExists(join(evidenceDir, "invocation.json"))).toBe(false);
    expect(await pathExists(evidenceDir)).toBe(false);
    expect(await readFile(join(runDir, "attempts", "1", "plan.json"), "utf8")).toContain("stale");
  });

  it("rejects a fixture path that does not match the rendered contract repoPath", async () => {
    await ensureBuilt();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-run-scenario-mismatch-"));
    const fixtureA = await createFixture(templateDir, join(tempRoot, "fixture-a"));
    const fixtureB = await createFixture(templateDir, join(tempRoot, "fixture-b"));
    const contractPath = join(tempRoot, "scenario-a.json");
    const runDir = join(tempRoot, "run");
    const evidenceDir = join(tempRoot, "evidence");
    const adapterConfigPath = join(worktreeRoot, "examples", "v1", "claude-adapter-config.json");
    await writeFile(contractPath, `${JSON.stringify(renderScenario("A", { repoPath: fixtureA.repoPath }), null, 2)}
`);

    await expect(
      execFileAsync(
        tsxBin,
        [
          runScenarioScript,
          "--scenario",
          "A",
          "--contract",
          contractPath,
          "--fixture",
          fixtureB.repoPath,
          "--run-dir",
          runDir,
          "--evidence-dir",
          evidenceDir,
          "--adapter-config",
          adapterConfigPath,
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/contract.*repoPath.*fixture/i) });
  });


  it("rejects a scenario that does not match contract objective.taskId before child launch", async () => {
    await ensureBuilt();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-run-scenario-taskid-mismatch-"));
    const fixtureDir = join(tempRoot, "fixture");
    const contractPath = join(tempRoot, "scenario-a.json");
    const adapterScriptPath = join(tempRoot, "launch-marker-runner.mjs");
    const adapterConfigPath = join(tempRoot, "adapter-config.json");
    const launchMarkerPath = join(tempRoot, "child-launched.txt");
    const runDir = join(tempRoot, "run");
    const evidenceDir = join(tempRoot, "evidence");
    const fixture = await createFixture(templateDir, fixtureDir);
    await writeFile(contractPath, `${JSON.stringify(renderScenario("A", { repoPath: fixture.repoPath }), null, 2)}\n`);
    await writeFile(
      adapterScriptPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(launchMarkerPath)}, "launched\n");\nprocess.stdout.write("{}\n");\n`,
    );
    await writeFile(adapterConfigPath, `${JSON.stringify({ command: [process.execPath, adapterScriptPath] }, null, 2)}\n`);

    await expect(
      execFileAsync(
        tsxBin,
        [
          runScenarioScript,
          "--scenario",
          "D",
          "--contract",
          contractPath,
          "--fixture",
          fixture.repoPath,
          "--run-dir",
          runDir,
          "--evidence-dir",
          evidenceDir,
          "--adapter-config",
          adapterConfigPath,
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/objective\.taskId|scenario/i) });

    expect(await pathExists(launchMarkerPath)).toBe(false);
    expect(await pathExists(runDir)).toBe(false);
    expect(await pathExists(join(evidenceDir, "invocation.json"))).toBe(true);
    const artifacts = JSON.parse(await readFile(join(evidenceDir, "artifacts.json"), "utf8")) as {
      artifacts: Array<{ name: string; status: string }>;
    };
    expect(artifacts.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "plan", status: "MISSING" })]),
    );
  });

  it("records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked", async () => {
    await ensureBuilt();
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-run-scenario-not-observable-"));
    const fixtureDir = join(tempRoot, "fixture");
    const contractPath = join(tempRoot, "scenario-a.json");
    const adapterScriptPath = join(tempRoot, "fast-claude-runner.mjs");
    const adapterConfigPath = join(tempRoot, "adapter-config.json");
    const runDir = join(tempRoot, "run");
    const evidenceDir = join(tempRoot, "evidence");
    const fixture = await createFixture(templateDir, fixtureDir);
    const contract = renderScenario("A", { repoPath: fixture.repoPath });
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}
`);
    await writeFile(
      adapterScriptPath,
      `import { spawn } from "node:child_process";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (request.phase === "plan") { process.stdout.write(JSON.stringify({ summary: "ok", primaryTargetPaths: ["src/counter.js"] })); } else if (request.phase === "execute") { process.stdout.write(JSON.stringify({ changedFiles: ["src/counter.js"], diffPatch: "diff --git a/src/counter.js b/src/counter.js", commandOutputs: ["edited"], stdoutStderrLog: "ok" })); } else { spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(JSON.stringify({ approved: true, rejectCategory: "", primaryTargetPaths: ["src/counter.js"], failingCommand: null, safeToRetry: false, evidence: ["command output | required check passed: npm test"], pauseSignals: [], stopSignals: [] })); }
`,
    );
    await writeFile(adapterConfigPath, `${JSON.stringify({ command: [process.execPath, adapterScriptPath] }, null, 2)}
`);

    await execFileAsync(
      tsxBin,
      [
        runScenarioScript,
        "--scenario",
        "A",
        "--contract",
        contractPath,
        "--fixture",
        fixture.repoPath,
        "--run-dir",
        runDir,
        "--evidence-dir",
        evidenceDir,
        "--adapter-config",
        adapterConfigPath,
      ],
      { cwd: worktreeRoot },
    );

    const processes = JSON.parse(await readFile(join(evidenceDir, "processes.json"), "utf8")) as {
      observedDescendants: Array<{ command: string }>;
      claudeChildExited: string;
    };
    expect(processes.observedDescendants.length).toBeGreaterThan(0);
    expect(processes.claudeChildExited).toBe("NOT_OBSERVABLE");
  });
});
