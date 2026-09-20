import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { collectExecution } from "../../src/control/collect.js";
import { evidencePath, readEvidence, writeEvidence } from "../../src/control/evidence.js";
import { canonicalHash, type StartEnvelopeV1 } from "../../src/control/protocol.js";
import { appendUsageObservation } from "../../src/control/usage.js";

const execFileAsync = promisify(execFile);

async function fixture(): Promise<{ root: string; envelope: StartEnvelopeV1 }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-collect-")));
  await mkdir(join(root, "input"));
  const amount = { tokens: 1, activeMs: 1, attempts: 1, sessions: 1 };
  const loop = {
    objective: { taskId: "task-1", goal: "work", successCondition: "done", nonGoals: [] },
    context: { repoPath: root, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2" as const, maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalRuntimeBudgetMs: 1_000, tokenBudget: 1, worktreeRequired: true as const, partialOutcomeRecoveryWindowMs: 0 },
    safetyPolicy: { allowlistPaths: [], denylistPaths: [], maxFilesTouched: 1, humanGateConditions: [] },
    verification: { verifierType: "command" as const, requiredChecks: ["true"], rejectOn: ["failure"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] as Array<"succeeded" | "blocked_waiting_human" | "exhausted" | "cancelled" | "failed"> },
  };
  const config = { command: [process.execPath], model: "fixture", budgetMode: "soft", sandbox: "workspace-write", timeoutMs: 1_000, killGraceMs: 10 };
  return {
    root,
    envelope: {
      protocol: 1,
      claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: canonicalHash(config), grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
      contractHash: "b".repeat(64),
      inputCheckpoint: null,
      work: { contract: loop, targetRepo: root, base: "main", sourceDir: root },
    },
  };
}

function usage(id: string, total: number) {
  return { runId: "run-1", generation: 1, bucket: "work" as const, observationId: id, threadTotalTokens: total, elapsedMs: 1, attempts: 1, sessions: 1, evidence: { id, total } };
}

describe("control collection", () => {
  it("filters afterSeq without renumbering", async () => {
    const f = await fixture();
    await appendUsageObservation(f.root, usage("one", 1));
    await appendUsageObservation(f.root, usage("two", 2));
    const report = await collectExecution(f.envelope, 1);
    expect(report.events.map((event) => event.eventSeq)).toEqual([2]);
    expect(report.candidate).toBeNull();
    expect(report.terminal).toBeNull();
  });
});

describe("bounded evidence reads", () => {
  it("rechecks the content hash on every read", async () => {
    const f = await fixture();
    const ref = await writeEvidence(f.root, Buffer.from("original"));
    expect((await readEvidence(f.root, ref)).toString()).toBe("original");
    await writeFile(evidencePath(f.root, ref), "changed");
    await expect(readEvidence(f.root, ref)).rejects.toThrow("control-evidence-hash-mismatch");
  });

  it("rejects traversal, symlink, FIFO, and evidence over 16 MiB", async () => {
    const f = await fixture();
    await expect(readEvidence(f.root, { artifactId: "../escape", hash: "a".repeat(64) })).rejects.toThrow(
      "control-evidence-ref-invalid",
    );

    const target = join(f.root, "target");
    await writeFile(target, "x");
    const symlinkRef = { artifactId: "evidence-symlink", hash: "a".repeat(64) };
    await mkdir(join(f.root, "control", "evidence"), { recursive: true });
    await symlink(target, evidencePath(f.root, symlinkRef));
    await expect(readEvidence(f.root, symlinkRef)).rejects.toThrow("control-evidence-invalid");

    const fifoRef = { artifactId: "evidence-fifo", hash: "a".repeat(64) };
    await execFileAsync("mkfifo", [evidencePath(f.root, fifoRef)]);
    await expect(readEvidence(f.root, fifoRef)).rejects.toThrow("control-evidence-invalid");

    const large = Buffer.alloc(16 * 1024 * 1024 + 1);
    const largeRef = { artifactId: "evidence-large", hash: "b".repeat(64) };
    await writeFile(evidencePath(f.root, largeRef), large);
    await expect(readEvidence(f.root, largeRef)).rejects.toThrow("control-evidence-too-large");
  });
});
