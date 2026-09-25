import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { buildHandoffPacket, finalizeHandoffCandidate } from "../../src/control/handoff.js";
import { readEvidence } from "../../src/control/evidence.js";
import { canonicalHash, type HandoffRequestV1, type StartEnvelopeV1 } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import type { RunState } from "../../src/state/types.js";

// Orca handoff delivery (2026-09-25), ccloop changes C7 (spec §13.1 C-2, human ruling) and C6 (spec §12(1),
// §13.2 I-9). Additive only (ccloop Rule 15). C7: a handoff of a run that is not terminal lists as missing
// only the current attempt's phase files that the attempt ENTERED (plan once the attempt exists; execute on
// its `execute_started`; verify on its `execution_finished`); an entered phase whose file is absent is still
// missing; terminal runs require all three files exactly as before. C6: the candidate answers its request.
const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(): Promise<{ runDir: string; envelope: StartEnvelopeV1; request: HandoffRequestV1 }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-handoff-entered-")));
  roots.push(root);
  const repo = join(root, "repo"), sourceDir = join(root, "source"), runDir = join(sourceDir, "run");
  await mkdir(repo);
  await mkdir(join(sourceDir, "input"), { recursive: true });
  await mkdir(runDir);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  const contract: LoopContract = {
    objective: { taskId: "task-1", goal: "finish work", successCondition: "all checks pass", nonGoals: [] },
    context: { repoPath: repo, targetPaths: ["value.txt"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 2, perAttemptTimeoutMs: 2_000, totalRuntimeBudgetMs: 5_000, tokenBudget: 1_000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
    safetyPolicy: { allowlistPaths: ["value.txt"], denylistPaths: [], maxFilesTouched: 2, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["npm test"], rejectOn: ["failure"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
  const amount = { tokens: 10, activeMs: 20, attempts: 2, sessions: 1 };
  const config = { command: [process.execPath], model: "fixture", budgetMode: "soft", sandbox: "workspace-write", timeoutMs: 1_000, killGraceMs: 10 };
  const envelope: StartEnvelopeV1 = {
    protocol: 1,
    claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 2, graphVersion: 3, targetVersion: 4, commandId: "command-1", configHash: canonicalHash(config), grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: "b".repeat(64),
    inputCheckpoint: null,
    work: { contract, targetRepo: repo, base: "main", sourceDir },
  };
  await writeAccepted(sourceDir, {
    protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-fixture", configHash: envelope.claim.configHash,
    generation: envelope.claim.generation, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
  });
  const request: HandoffRequestV1 = { protocol: 1, requestId: "request-1", runId: "run-1", generation: 2, reason: "human", deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  return { runDir, envelope, request };
}

function state(status: RunState["status"], currentAttempt = 1): RunState {
  return {
    status, currentAttempt, attemptsUsed: currentAttempt, lastTransitionAt: new Date().toISOString(),
    waitingOnHuman: status === "blocked_waiting_human", stopReason: status === "blocked_waiting_human" ? "review" : null,
    budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 1_000, tokenBudgetRemaining: 100 }, recentFailures: [],
  };
}

/** The run directory as runLoop leaves it: events with runLoop's own types and `attempt <n>` details, plus the named phase files. */
async function runDirWith(runDir: string, events: Array<[type: string, attempt: number]>, runState: RunState, files: Record<number, string[]>): Promise<void> {
  await writeFile(join(runDir, "events.jsonl"), events.map(([type, attempt]) => `${JSON.stringify({ type, at: new Date().toISOString(), detail: `attempt ${attempt}` })}\n`).join(""));
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify(runState));
  await writeFile(join(runDir, "loop-contract.json"), "{}");
  for (const [attempt, names] of Object.entries(files)) {
    await mkdir(join(runDir, "attempts", attempt), { recursive: true });
    for (const name of names) await writeFile(join(runDir, "attempts", attempt, name), "{}");
  }
}

describe("handoff packet of a run stopped between phases (ccloop C7)", () => {
  it("does not list the execute and verify files of an attempt stopped at the boundary after plan", async () => {
    const f = await fixture();
    const runState = state("planning");
    await runDirWith(f.runDir, [], runState, { 1: ["plan.json"] });
    const built = await buildHandoffPacket(f.envelope, f.request, runState, 3);
    expect(built.missing).toEqual([]);
    expect(built.artifacts.length).toBeGreaterThanOrEqual(4);
  });

  it("does not list the verify file of an attempt stopped after execute, once execute was entered and wrote its file", async () => {
    const f = await fixture();
    const runState = state("executing");
    await runDirWith(f.runDir, [["attempt_started", 1], ["execute_started", 1]], runState, { 1: ["plan.json", "execution.json"] });
    expect((await buildHandoffPacket(f.envelope, f.request, runState, 3)).missing).toEqual([]);
  });

  it("still lists an entered phase whose file is absent: execute, and verify after execution_finished", async () => {
    const f = await fixture();
    const executing = state("executing");
    await runDirWith(f.runDir, [["attempt_started", 1], ["execute_started", 1]], executing, { 1: ["plan.json"] });
    expect((await buildHandoffPacket(f.envelope, f.request, executing, 3)).missing).toEqual(["attempts/1/execution.json"]);

    const g = await fixture();
    const verifying = state("verifying");
    await runDirWith(g.runDir, [["attempt_started", 1], ["execute_started", 1], ["execution_finished", 1]], verifying, { 1: ["plan.json", "execution.json"] });
    expect((await buildHandoffPacket(g.envelope, g.request, verifying, 3)).missing).toEqual(["attempts/1/verify.json"]);
  });

  it("counts only the current attempt's events as entered", async () => {
    const f = await fixture();
    const runState = state("planning", 2);
    // Attempt 1 entered execute and verify; attempt 2 was stopped after its plan.
    await runDirWith(f.runDir, [["attempt_started", 1], ["execute_started", 1], ["execution_finished", 1]], runState, { 1: ["plan.json", "execution.json", "verify.json"], 2: ["plan.json"] });
    expect((await buildHandoffPacket(f.envelope, f.request, runState, 3)).missing).toEqual([]);
  });

  it("keeps requiring all three phase files for terminal runs, with or without a request", async () => {
    const f = await fixture();
    const blocked = state("blocked_waiting_human");
    await runDirWith(f.runDir, [], blocked, { 1: ["plan.json"] });
    expect((await buildHandoffPacket(f.envelope, f.request, blocked, 3)).missing).toEqual(["attempts/1/execution.json", "attempts/1/verify.json"]);
    const succeeded = state("succeeded");
    await runDirWith(f.runDir, [], succeeded, { 1: ["plan.json"] });
    expect((await buildHandoffPacket(f.envelope, null, succeeded, 3)).missing).toEqual(["attempts/1/execution.json", "attempts/1/verify.json"]);
  });
});

describe("handoff candidate of a deadline-interrupted run (ccloop C6 with C7)", () => {
  it("answers its request: result stays partial, no unresolved request on candidate or packet, nothing missing", async () => {
    const f = await fixture();
    const runState = state("executing");
    await runDirWith(f.runDir, [["attempt_started", 1], ["execute_started", 1]], runState, { 1: ["plan.json", "execution.json"] });
    const candidate = await finalizeHandoffCandidate(f.envelope, f.request, runState, { result: "partial", usageHighWater: 9 });
    expect(candidate.result).toBe("partial");
    expect(candidate.terminalOutcome).toBe("executing");
    expect(candidate.unresolvedRequestIds).toEqual([]);
    expect(candidate.missing).toEqual([]);
    const packet = JSON.parse((await readEvidence(f.envelope.work.sourceDir, candidate.handoff)).toString("utf8"));
    expect(packet.request).toEqual(f.request);
    expect(packet.unresolvedRequestIds).toEqual([]);
  });
});
