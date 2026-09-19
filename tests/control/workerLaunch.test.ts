import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { inspectStart } from "../../src/control/accept.js";
import { canonicalHash, type StartEnvelopeV1 } from "../../src/control/protocol.js";
import { readProcessStartedAt } from "../../src/control/workerLauncher.js";
import { writeAccepted } from "../../src/control/store.js";

async function fixture(): Promise<{ root: string; envelope: StartEnvelopeV1 }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-worker-")));
  await mkdir(join(root, "input"));
  const amount = { tokens: 0, activeMs: 0, attempts: 0, sessions: 0 };
  const loop: LoopContract = {
    objective: { taskId: "task-1", goal: "work", successCondition: "done", nonGoals: [] },
    context: { repoPath: root, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2" as const, maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalRuntimeBudgetMs: 1_000, tokenBudget: 1, worktreeRequired: true as const, partialOutcomeRecoveryWindowMs: 0 },
    safetyPolicy: { allowlistPaths: [], denylistPaths: [], maxFilesTouched: 1, humanGateConditions: [] },
    verification: { verifierType: "command" as const, requiredChecks: ["npm test"], rejectOn: ["failure"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
  const envelope: StartEnvelopeV1 = {
    protocol: 1,
    claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: "a".repeat(64), grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: "b".repeat(64),
    inputCheckpoint: null,
    work: { contract: loop, targetRepo: root, base: "main", sourceDir: root },
  };
  return { root, envelope };
}

describe("worker process identity", () => {
  it("does not accept a recycled live PID with a mismatched UTC start identity", async () => {
    const f = await fixture();
    const actual = await readProcessStartedAt(process.pid);
    expect(actual).not.toBeNull();
    await writeAccepted(f.root, {
      protocol: 1,
      envelopeHash: canonicalHash(f.envelope),
      executionId: "execution-1",
      configHash: f.envelope.claim.configHash,
      generation: 1,
      acceptedAt: new Date().toISOString(),
      launch: "claimed",
      worker: { pid: process.pid, startedAt: "1970-01-01T00:00:00.000Z", nonce: "nonce-1" },
    });
    expect(await inspectStart(f.envelope)).toEqual({ kind: "unknown" });
  });
});
