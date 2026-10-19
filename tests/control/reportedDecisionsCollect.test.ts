import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExecution } from "../../src/control/collect.js";
import { runControlCommand } from "../../src/control/command.js";
import { finalizeHandoffCandidate } from "../../src/control/handoff.js";
import { canonicalHash, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { runLoop } from "../../src/controller/runLoop.js";
import type { RunState } from "../../src/state/types.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { createContract, createRepo } from "../controller/optionalFixture.js";
import { FIXTURE_SELECTION } from "./agentsFixture.js";

// Reported decisions and debug (ccloop spec 2026-10-20 §4.3, §7 criteria 7-8). Orca writes a run's ledger from the
// decisions in its `control collect` answer, so collect must carry the decisions of the attempt the candidate collected --
// never another attempt's, which would put choices that did not land into the ledger -- and must leave every answer of a
// run that reported none byte-identical (Orca's parser of that answer is strict).
const major = { question: "Retry inside the client or the caller?", chose: "caller", alternatives: [{ option: "client", why_not: "hides failures" }], because: "the caller owns the budget", undo: { how: "restore the retry loop in src/client.ts", cost: "small", blast_radius: "src/client.ts" }, scope: "repo", kind: "interface", importance: "major" };
const minor = { ...major, question: "Name the helper?", chose: "retryOnce", scope: "file", kind: "implementation", importance: "minor" };
const core = { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "", tokenUsage: 1 };
const plan = { summary: "plan", primaryTargetPaths: [], tokenUsage: 1 };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function envelopeAt(protocol: 3 | 4 = 3): Promise<{ root: string; envelope: LoopStartEnvelope }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-reported-collect-"))); roots.push(root);
  await mkdir(join(root, "input"));
  const contract = createContract(root, ["true"], 1);
  const amount = { tokens: 1, activeMs: 1, attempts: 1, sessions: 1 };
  const envelope = {
    protocol, claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: "c".repeat(64), agent: FIXTURE_SELECTION, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: canonicalHash(contract), inputCheckpoint: null, work: { kind: "loop", contract, targetRepo: root, base: "main", sourceDir: root },
  } as LoopStartEnvelope;
  return { root, envelope };
}

function terminalState(currentAttempt: number, protocol: 3 | 4 = 3): RunState {
  return { status: "succeeded", currentAttempt, attemptsUsed: currentAttempt, lastTransitionAt: "2026-10-20T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 1_000, tokenBudgetRemaining: 1, ...(protocol === 4 ? { tokenRemainingStatus: "known" } : {}) }, recentFailures: [] } as RunState;
}

/** A settled run of `executions.length` attempts (attempt i executes executions[i-1]) and its candidate. */
async function settledRun(executions: Array<Record<string, unknown> | null>, protocol: 3 | 4 = 3) {
  const f = await envelopeAt(protocol);
  const run = join(f.root, "run"), state = terminalState(executions.length, protocol);
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "loop-state.json"), JSON.stringify(state));
  for (const [index, execution] of executions.entries()) {
    const attempt = join(run, "attempts", String(index + 1));
    await mkdir(attempt, { recursive: true });
    await writeFile(join(attempt, "plan.json"), JSON.stringify(plan));
    if (execution !== null) await writeFile(join(attempt, "execution.json"), JSON.stringify(execution, null, 2));
  }
  await finalizeHandoffCandidate(f.envelope, null, state, { result: "complete", usageHighWater: 0 });
  return f;
}

describe("criterion 7: collect answers the candidate attempt's reported decisions", () => {
  it("answers decisions and debug at the top level, as reported", async () => {
    const f = await settledRun([{ ...core, decisions: [major, minor], debug: { reproTests: ["t.test.ts"] } }]);
    const report = await collectExecution(f.envelope, 0) as unknown as Record<string, unknown>;
    expect(report.decisions).toEqual([major, minor]);
    expect(report.debug).toEqual({ reproTests: ["t.test.ts"] });
    expect(Object.keys(report)).toEqual(["events", "candidate", "terminal", "progress", "decisions", "debug"]);
  });

  it("answers exactly the four keys for a run that reported none, and for a candidate whose attempt never executed", async () => {
    for (const executions of [[core], [null]]) {
      const f = await settledRun(executions);
      const report = await collectExecution(f.envelope, 0);
      expect(report.candidate).not.toBeNull();
      expect(Object.keys(report)).toEqual(["events", "candidate", "terminal", "progress"]);
    }
  });

  it("with two attempts reporting different decisions, the candidate's attempt wins", async () => {
    const f = await settledRun([{ ...core, decisions: [major], debug: { choseInstead: "first" } }, { ...core, decisions: [minor] }]);
    const report = await collectExecution(f.envelope, 0) as unknown as Record<string, unknown>;
    expect(report.decisions).toEqual([minor]);
    expect(Object.hasOwn(report, "debug")).toBe(false);
  });

  it("reads the candidate's kept copy: an attempt file changed after the candidate was kept is not reported", async () => {
    const f = await settledRun([{ ...core, decisions: [major] }]);
    await writeFile(join(f.root, "run", "attempts", "1", "execution.json"), JSON.stringify({ ...core, decisions: [minor] }));
    expect(Object.keys(await collectExecution(f.envelope, 0))).toEqual(["events", "candidate", "terminal", "progress"]);
  });

  it("answers nothing extra before any candidate exists", async () => {
    const f = await envelopeAt();
    const run = join(f.root, "run"), attempt = join(run, "attempts", "1");
    await mkdir(attempt, { recursive: true });
    await writeFile(join(run, "loop-state.json"), JSON.stringify({ ...terminalState(1), status: "executing" }));
    await writeFile(join(attempt, "execution.json"), JSON.stringify({ ...core, decisions: [major] }));
    expect(Object.keys(await collectExecution(f.envelope, 0))).toEqual(["events", "candidate", "terminal", "progress"]);
  });

  it.each([3, 4] as const)("the control command's strict response schema lets them through for protocol %s", async (protocol) => {
    const f = await settledRun([{ ...core, decisions: [major], debug: { choseInstead: "x" } }], protocol);
    const collected = await runControlCommand(["collect", "--agents", join(f.root, "agents.json")], JSON.stringify({ input: f.envelope, afterSeq: 0 }));
    expect(collected.code, collected.stderr).toBe(0);
    expect(JSON.parse(collected.stdout)).toMatchObject({ decisions: [major], debug: { choseInstead: "x" } });
  });
});

describe("criterion 8: a token-allowance continuation reports its predecessor's decisions", () => {
  it("the successor run's collect answers the decisions of the execution it continued from", { timeout: 30_000 }, async () => {
    const f = await envelopeAt();
    const repo = await createRepo(); roots.push(repo);
    const contract = createContract(repo, ["true"], null); contract.verification.verifierType = "agent";
    const verified = { approved: true, rejectCategory: "", primaryTargetPaths: [], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [], tokenUsage: 0 };
    const adapter: RuntimeAdapter = { plan: async () => { throw new Error("planner replayed"); }, execute: async () => { throw new Error("execute replayed"); }, verify: async () => verified };
    const predecessor = { ...core, decisions: [major, minor], debug: { reproCommand: "npm test" } };
    const state = await runLoop(contract, join(f.root, "run"), adapter, { allowanceContinuation: { nextPhase: "verify", plan, execution: predecessor } });
    expect(state.status).toBe("succeeded");
    await finalizeHandoffCandidate(f.envelope, null, state, { result: "complete", usageHighWater: 0 });
    const report = await collectExecution(f.envelope, 0) as unknown as Record<string, unknown>;
    expect(report.decisions).toEqual([major, minor]);
    expect(report.debug).toEqual({ reproCommand: "npm test" });
  });
});
