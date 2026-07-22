import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { initializeRunFiles, appendEvent, writeAttemptArtifacts, writeBoundaryArtifacts, writeRunState } from "../../src/persistence/fileStore.js";
import type { LoopContract } from "../../src/contract/schema.js";
import type { RunState } from "../../src/state/types.js";

const contract: LoopContract = {
  objective: { taskId: "task-1", goal: "Fix test", successCondition: "tests pass", nonGoals: [] },
  context: { repoPath: "/tmp/repo", targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
  executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
  safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
  verification: { verifierType: "command", requiredChecks: ["npm test"], rejectOn: ["tests fail"], evidenceRequired: [] },
  escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
};

const state: RunState = {
  status: "queued",
  currentAttempt: 0,
  attemptsUsed: 0,
  lastTransitionAt: "2026-07-14T00:00:00.000Z",
  waitingOnHuman: false,
  stopReason: null,
  budgetSnapshot: { attemptsRemaining: 3, timeRemainingMs: 5000, tokenBudgetRemaining: 1000 },
  recentFailures: [],
};

describe("fileStore", () => {
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

  it("writes boundary-analysis and reconciliation records when present", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis: {
        status: "stale_confirmed",
        strongProgressAt: "2026-07-21T10:00:00.000Z",
        weakProgressAt: "2026-07-21T10:05:00.000Z",
        suspectReason: "healthy window exceeded",
        staleCandidateReason: "continuity evidence missing",
      },
      reconciliationRecord: {
        staleSuspicionBasis: ["healthy window exceeded", "state freshness mismatch"],
        staleConfirmed: true,
        lastTrustedBoundary: "execute",
        conflictingEvidence: [],
        takeoverPermission: {
          allowed: false,
          reason: "ownership not yet mechanically proven",
        },
      },
    });

    const analysis = JSON.parse(
      await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
    ) as { status: string };
    const reconciliation = JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as { staleConfirmed: boolean; takeoverPermission: { allowed: boolean } };

    expect(analysis.status).toBe("stale_confirmed");
    expect(reconciliation.staleConfirmed).toBe(true);
    expect(reconciliation.takeoverPermission.allowed).toBe(false);
  });

  it("writes contract, state, events, and attempt artifacts", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await initializeRunFiles(runDir, contract, state);
    await appendEvent(runDir, { type: "attempt_started", at: "2026-07-14T00:00:01.000Z", detail: "attempt 1" });
    await writeAttemptArtifacts(runDir, 1, {
      plan: { summary: "change src/index.ts" },
      execution: { changedFiles: ["src/index.ts"], commandOutputs: ["ok"] },
      verify: { approved: false, rejectCategory: "tests-failed" },
      diffPatch: "diff --git a/src/index.ts b/src/index.ts",
      stdoutStderrLog: "npm test\nFAIL",
    });
    await writeRunState(runDir, { ...state, status: "verifying", currentAttempt: 1, attemptsUsed: 1 });

    const savedState = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
    const savedEvents = await readFile(join(runDir, "events.jsonl"), "utf8");
    const savedPlan = JSON.parse(await readFile(join(runDir, "attempts", "1", "plan.json"), "utf8"));

    expect(savedState.status).toBe("verifying");
    expect(savedEvents).toContain("attempt_started");
    expect(savedPlan.summary).toBe("change src/index.ts");
  });
});
