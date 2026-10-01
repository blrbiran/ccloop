import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  classifyDScenarioBoundary,
  collectArtifacts,
  collectEvidence,
  mapDBoundaryToReview,
  sha256File,
} from "../../validation/v1/lib/evidence.js";
import { getScenario, renderScenario } from "../../validation/v1/lib/scenarios.js";
import { main as finalizeReviewMain } from "../../validation/v1/scripts/finalize-review.js";

const execFileAsync = promisify(execFile);
const worktreeRoot = process.cwd();
const finalizeReviewScript = join(worktreeRoot, "validation", "v1", "scripts", "finalize-review.ts");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type SyntheticRunOptions = {
  scenarioId: "A" | "B" | "D";
  invalidLoopState?: boolean;
  invalidEvents?: boolean;
  omitPlan?: boolean;
  escapePlan?: boolean;
  attemptNumber?: number;
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
  const attemptNumber = options.attemptNumber ?? 1;
  const attemptDir = join(runDir, "attempts", String(attemptNumber));
  await mkdir(attemptDir, { recursive: true });
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
    currentAttempt: attemptNumber,
    attemptsUsed: attemptNumber,
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
    { type: "attempt_started", at: "2026-07-17T00:00:00.000Z", detail: `attempt ${attemptNumber}` },
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
      await symlink(outsidePath, join(attemptDir, "plan.json"));
    } else {
      await writeFile(
        join(attemptDir, "plan.json"),
        '{"summary":"edit src/counter.js","primaryTargetPaths":["src/counter.js"]}\n',
      );
    }
  }

  if (artifactMode.execution === "present") {
    await writeFile(
      join(attemptDir, "execution.json"),
      '{"changedFiles":["src/counter.js"],"diffPatch":"diff --git a/src/counter.js b/src/counter.js","commandOutputs":["edited"],"stdoutStderrLog":"ok"}\n',
    );
  }

  if (artifactMode.verify === "present") {
    await writeFile(
      join(attemptDir, "verify.json"),
      options.verifyContents ??
        '{"approved":true,"rejectCategory":"","primaryTargetPaths":["src/counter.js"],"failingCommand":null,"safeToRetry":false,"evidence":["command output | required check passed: npm test"],"pauseSignals":[],"stopSignals":[]}\n',
    );
  }

  if (artifactMode.diff === "present") {
    await writeFile(join(attemptDir, "diff.patch"), "diff --git a/src/counter.js b/src/counter.js\n");
  }

  if (artifactMode.log === "present") {
    await writeFile(join(attemptDir, "stdout-stderr.log"), "ok\n");
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

  it("treats execution-recovery.json without attempt_started as contradictory Layer A boundary evidence", async () => {
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

    expect(record.executionRecovery).toMatchObject({ status: "PRESENT" });
    expect(classifyDScenarioBoundary(record)).toBe("BOUNDARY_UNRESOLVED");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "INCONCLUSIVE",
      diagnosis: "CONTRACT_GAP",
    });
  });

  it("treats execution-recovery.json without execute_started as contradictory Layer A boundary evidence", async () => {
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

    expect(record.executionRecovery).toMatchObject({ status: "PRESENT" });
    expect(classifyDScenarioBoundary(record)).toBe("BOUNDARY_UNRESOLVED");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "INCONCLUSIVE",
      diagnosis: "CONTRACT_GAP",
    });
  });

  it("treats raw Layer A diff presence as contradictory even when Scenario D normalizes it to INVALID", async () => {
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
      artifacts: { plan: "present", execution: "missing", verify: "missing", diff: "present", log: "missing" },
    });

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(record.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "diff", status: "INVALID" })]));
    expect(classifyDScenarioBoundary(record)).toBe("BOUNDARY_UNRESOLVED");
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
        '{"approved":false,"rejectCategory":"","primaryTargetPaths":["src/counter.js"],"failingCommand":null,"safeToRetry":true,"evidence":["command output | required check passed: npm test"],"pauseSignals":[],"stopSignals":[]}\n',
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

  it("disqualifies PRE_EXECUTE_EXHAUSTION when valid execution-recovery.json proves execute handling began", async () => {
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

    expect(record.executionRecovery).toMatchObject({ status: "PRESENT" });
    expect(classifyDScenarioBoundary(record)).toBe("BOUNDARY_UNRESOLVED");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "INCONCLUSIVE",
      diagnosis: "CONTRACT_GAP",
    });
  });

  it("treats execution.json-only as sufficient recoverable execute evidence", async () => {
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

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(record.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "execution", status: "INVALID" })]));
    expect(record.observations.executionJson).toMatchObject({ status: "PRESENT" });
    expect(record.executionRecovery).toMatchObject({ status: "MISSING" });
    expect(classifyDScenarioBoundary(record)).toBe("EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE");
    expect(mapDBoundaryToReview(classifyDScenarioBoundary(record), record)).toEqual({
      scenarioVerdict: "FAIL",
      diagnosis: "PRODUCT_DEFECT",
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

  it("reads terminal attempt D evidence from attempt 2 instead of assuming attempt 1", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({
      scenarioId: "D",
      attemptNumber: 2,
      events: [
        { type: "attempt_started", at: "2026-07-20T00:00:00.000Z", detail: "attempt 2" },
        { type: "execute_started", at: "2026-07-20T00:00:01.000Z", detail: "attempt 2 entered execute" },
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
      join(runDir, "attempts", "2", "execution-recovery.json"),
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

    expect(record.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "plan",
          status: "PRESENT",
          path: expect.stringMatching(/attempts\/2\/plan\.json$/),
        }),
      ]),
    );
    expect(record.executionRecovery).toMatchObject({
      status: "PRESENT",
      path: expect.stringMatching(/attempts\/2\/execution-recovery\.json$/),
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

  it("surfaces valid run-root boundary artifacts as PRESENT with parsed values", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({ scenarioId: "D" });
    const boundaryAnalysis = {
      status: "stale_candidate",
      strongProgressAt: "2026-07-21T00:00:00.000Z",
      weakProgressAt: "2026-07-21T00:05:00.000Z",
      suspectReason: "missing strong progress signal",
      staleCandidateReason: "run exceeded stale threshold",
    };
    const reconciliationRecord = {
      staleSuspicionBasis: ["no verify progress", "boundary age exceeded threshold"],
      staleConfirmed: false,
      lastTrustedBoundary: "verify",
      conflictingEvidence: [],
      takeoverPermission: {
        allowed: false,
        reason: "human review required before takeover",
      },
    };

    await writeFile(join(runDir, "boundary-analysis.json"), JSON.stringify(boundaryAnalysis, null, 2) + "\n");
    await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify(reconciliationRecord, null, 2) + "\n");

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(record.observations.boundaryAnalysis).toMatchObject({
      status: "PRESENT",
      value: boundaryAnalysis,
    });
    expect(record.observations.reconciliationRecord).toMatchObject({
      status: "PRESENT",
      value: reconciliationRecord,
    });
  });

  it("accepts a reconciliation-record.json that carries owner-transfer fields", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({ scenarioId: "D" });
    const boundaryAnalysis = {
      status: "stale_confirmed",
      strongProgressAt: "2026-07-21T00:00:00.000Z",
      weakProgressAt: "2026-07-21T00:05:00.000Z",
      suspectReason: "missing strong progress signal",
      staleCandidateReason: "run exceeded stale threshold",
    };
    const reconciliationRecord = {
      staleSuspicionBasis: ["owner transfer already published"],
      staleConfirmed: true,
      ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: {
        allowed: true,
        reason: "strict owner-loss conditions satisfied; continuation still requires a later transfer step",
      },
      priorOwnerEpoch: 1,
      newOwnerEpoch: 2,
      eligibleForContinuation: true,
    };

    await writeFile(join(runDir, "boundary-analysis.json"), JSON.stringify(boundaryAnalysis, null, 2) + "\n");
    await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify(reconciliationRecord, null, 2) + "\n");

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(record.observations.reconciliationRecord).toMatchObject({
      status: "PRESENT",
      value: reconciliationRecord,
    });
  });

  it("marks malformed reconciliation-record.json as INVALID instead of trusting it", async () => {
    const { runDir, evidenceDir } = await createSyntheticRun({ scenarioId: "D" });
    const boundaryAnalysis = {
      status: "stale_candidate",
      strongProgressAt: "2026-07-21T00:00:00.000Z",
      weakProgressAt: "2026-07-21T00:05:00.000Z",
      suspectReason: "missing strong progress signal",
      staleCandidateReason: "run exceeded stale threshold",
    };

    await writeFile(join(runDir, "boundary-analysis.json"), JSON.stringify(boundaryAnalysis, null, 2) + "\n");
    await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify({ staleConfirmed: "yes" }, null, 2) + "\n");

    const record = await collectEvidence({
      scenario: getScenario("D"),
      ...baseInput(runDir, evidenceDir),
    });

    expect(record.observations.boundaryAnalysis).toMatchObject({
      status: "PRESENT",
      value: boundaryAnalysis,
    });
    expect(record.observations.reconciliationRecord.status).toBe("INVALID");
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
    const attemptDir = join(runDir, "attempts", "1");
    const planPath = join(attemptDir, "plan.json");
    const executionPath = join(attemptDir, "execution.json");
    const verifyPath = join(attemptDir, "verify.json");

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
  it("writes review-reclassified.json without overwriting review.json", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-finalize-review-"));
    const evidenceDir = join(tempRoot, "evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      join(evidenceDir, "review.json"),
      `${JSON.stringify(
        {
          scenarioVerdict: "INCONCLUSIVE",
          diagnosis: "CONTRACT_GAP",
          summary: "Current persisted evidence cannot distinguish no work from lost recoverable work",
          reviewedAt: "2026-07-20T00:00:00.000Z",
        },
        null,
        2,
      )}
`,
    );

    const exitCode = await finalizeReviewMain([
      "--evidence-dir",
      evidenceDir,
      "--verdict",
      "INCONCLUSIVE",
      "--diagnosis",
      "RUNTIME_VARIANCE",
      "--summary",
      "Reclassified as pre-execute exhaustion",
      "--reclassify-from",
      join(evidenceDir, "review.json"),
      "--boundary-classification",
      "PRE_EXECUTE_EXHAUSTION",
      "--rule-version",
      "2026-07-20-d-boundary-classification-v1",
      "--evidence-reference",
      "events.jsonl",
      "--evidence-reference",
      "loop-state.json",
      "--evidence-reference",
      "attempts/1/plan.json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(evidenceDir, "review.json"), "utf8"))).toMatchObject({
      diagnosis: "CONTRACT_GAP",
    });
    expect(JSON.parse(await readFile(join(evidenceDir, "review-reclassified.json"), "utf8"))).toMatchObject({
      original: {
        diagnosis: "CONTRACT_GAP",
      },
      reclassified: {
        diagnosis: "RUNTIME_VARIANCE",
        summary: "Reclassified as pre-execute exhaustion",
      },
      boundaryClassification: "PRE_EXECUTE_EXHAUSTION",
      ruleVersion: "2026-07-20-d-boundary-classification-v1",
      evidenceReferences: ["events.jsonl", "loop-state.json", "attempts/1/plan.json"],
    });
  });

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
