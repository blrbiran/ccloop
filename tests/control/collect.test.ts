import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { collectExecution } from "../../src/control/collect.js";
import { runControlCommand } from "../../src/control/command.js";
import { evidencePath, readEvidence, writeEvidence } from "../../src/control/evidence.js";
import { canonicalHash, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { FIXTURE_SELECTION } from "./agentsFixture.js";
import { appendUsageObservation } from "../../src/control/usage.js";

const execFileAsync = promisify(execFile);

async function fixture(): Promise<{ root: string; envelope: LoopStartEnvelope }> {
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
    // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): the fixture is a
    // protocol-2 envelope whose claim carries a selection; collection and evidence assertions are unchanged.
    // ERRATUM (human ruling S6, 2026-09-27, session f341f05f): the envelope named above is now protocol 3, work tagged kind "loop".
    // Human ruling S6 (2026-09-27, session f341f05f): protocol 3 envelope
    envelope: {
      protocol: 3,
      claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: canonicalHash(config), agent: FIXTURE_SELECTION, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
      contractHash: "b".repeat(64),
      inputCheckpoint: null,
      work: { kind: "loop", contract: loop, targetRepo: root, base: "main", sourceDir: root },
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

function loopState(status: string, over: Record<string, unknown> = {}) {
  return {
    status, currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-09-29T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 2, timeRemainingMs: 1_000, tokenBudgetRemaining: 1_000 }, recentFailures: [], ...over,
  };
}

async function writeLoopState(root: string, value: unknown): Promise<void> {
  await mkdir(join(root, "run"), { recursive: true });
  await writeFile(join(root, "run", "loop-state.json"), typeof value === "string" ? value : JSON.stringify(value));
}

// Orca labels and progress spec §3.2, criterion P1, §8 R17 (Orca plan 2026-09-29-labels-and-progress Task 6).
describe("collect's progress", () => {
  it("P1: answers the loop's progress while it runs, both attempt numbers from the same snapshot", async () => {
    const f = await fixture();
    await writeLoopState(f.root, loopState("executing", { currentAttempt: 2, attemptsUsed: 2, budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 1, tokenBudgetRemaining: 1 } }));
    expect((await collectExecution(f.envelope, 0)).progress).toEqual({
      status: "executing", currentAttempt: 2, attemptsUsed: 2, attemptsRemaining: 1, lastTransitionAt: "2026-09-29T00:00:00.000Z",
    });
  });

  it("P1: answers it once the loop ended too, and null before the loop wrote any state", async () => {
    const f = await fixture();
    expect((await collectExecution(f.envelope, 0)).progress).toBeNull();
    await writeLoopState(f.root, loopState("succeeded"));
    expect((await collectExecution(f.envelope, 0)).progress).toMatchObject({ status: "succeeded", attemptsRemaining: 2 });
  });

  it("R17: refuses a loop state that is not JSON, lacks a field progress takes, or names an unknown status", async () => {
    const f = await fixture();
    await writeLoopState(f.root, "{ not json");
    await expect(collectExecution(f.envelope, 0)).rejects.toThrow("control-terminal-invalid");
    const { budgetSnapshot: _dropped, ...withoutBudget } = loopState("executing");
    await writeLoopState(f.root, withoutBudget);
    await expect(collectExecution(f.envelope, 0)).rejects.toThrow("control-terminal-invalid");
    await writeLoopState(f.root, loopState("thinking"));
    await expect(collectExecution(f.envelope, 0)).rejects.toThrow("control-terminal-invalid");
  });

  it("P1: the control command's own strict response schema lets the progress through", async () => {
    const f = await fixture();
    await writeLoopState(f.root, loopState("verifying"));
    // A table path with nothing at it passes the shape check; collect never reads the table (spec §4.2, I4).
    const collected = await runControlCommand(["collect", "--agents", join(f.root, "agents.json")], JSON.stringify({ input: f.envelope, afterSeq: 0 }));
    expect(collected.code, collected.stderr).toBe(0);
    expect(JSON.parse(collected.stdout)).toMatchObject({ events: [], candidate: null, terminal: null, progress: { status: "verifying" } });
  });
});
