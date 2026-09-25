import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import {
  buildHandoffPacket,
  finalizeHandoffCandidate,
  readHandoffRequest,
  requestHandoff,
} from "../../src/control/handoff.js";
import {
  canonicalJson,
  canonicalHash,
  type HandoffRequestV1,
  type StartEnvelopeV2,
} from "../../src/control/protocol.js";
import { parseCodexConfig } from "../../src/runtime/codex/protocol.js";
import { FIXTURE_SELECTION, sealCodex } from "./agentsFixture.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { readEvidence } from "../../src/control/evidence.js";
import { collectExecution } from "../../src/control/collect.js";
import { readAccepted, writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import {
  createStopRequestSignal,
  runLoop,
} from "../../src/controller/runLoop.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import type { RunState } from "../../src/state/types.js";
import { codexFixture } from "../runtime/codex/fixture.js";

const execFileAsync = promisify(execFile);

async function fixture(): Promise<{
  root: string;
  runDir: string;
  envelope: StartEnvelopeV2;
  request: HandoffRequestV1;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-handoff-")));
  const repo = join(root, "repo");
  const sourceDir = join(root, "source");
  const runDir = join(sourceDir, "run");
  await mkdir(repo);
  await mkdir(sourceDir);
  await mkdir(join(sourceDir, "input"));
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "value.txt"), "0\n");
  await execFileAsync("git", ["add", "value.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repo });
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
  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): every criterion reading
  // this fixture gets a protocol-2 envelope whose claim carries a selection; no provider runs here, so nothing
  // resolves it and its assertions are unchanged.
  const envelope: StartEnvelopeV2 = {
    protocol: 2,
    claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 2, graphVersion: 3, targetVersion: 4, commandId: "command-1", configHash: canonicalHash(config), agent: FIXTURE_SELECTION, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: "b".repeat(64),
    inputCheckpoint: null,
    work: { contract, targetRepo: repo, base: "main", sourceDir },
  };
  const request: HandoffRequestV1 = {
    protocol: 1,
    requestId: "request-1",
    runId: "run-1",
    generation: 2,
    reason: "human",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await writeAccepted(sourceDir, {
    protocol: 1,
    envelopeHash: canonicalHash(envelope),
    executionId: "execution-fixture",
    configHash: envelope.claim.configHash,
    generation: envelope.claim.generation,
    acceptedAt: new Date().toISOString(),
    launch: "intended",
    worker: null,
  });
  return { root, runDir, envelope, request };
}

function adapter(overrides: Partial<RuntimeAdapter> = {}): RuntimeAdapter {
  return {
    plan: async () => ({ summary: "plan", primaryTargetPaths: ["value.txt"], tokenUsage: 1 }),
    execute: async () => ({ changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "", tokenUsage: 1 }),
    verify: async () => ({ approved: true, rejectCategory: "", primaryTargetPaths: ["value.txt"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [], tokenUsage: 1 }),
    ...overrides,
  };
}

function state(status: RunState["status"], stopReason: string | null = null): RunState {
  return {
    status,
    currentAttempt: 1,
    attemptsUsed: 1,
    lastTransitionAt: new Date().toISOString(),
    waitingOnHuman: status === "blocked_waiting_human",
    stopReason,
    budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 1_000, tokenBudgetRemaining: 100 },
    recentFailures: [],
  };
}

describe("named handoff request", () => {
  it("fsyncs before an idempotent ack and rejects changed or stale identity", async () => {
    const f = await fixture();
    expect(await requestHandoff(f.envelope, f.request)).toEqual({ kind: "latched", requestId: "request-1" });
    expect(await readHandoffRequest(f.envelope.work.sourceDir)).toEqual(f.request);
    expect(await requestHandoff(f.envelope, f.request)).toEqual({ kind: "latched", requestId: "request-1" });
    await expect(requestHandoff(f.envelope, { ...f.request, reason: "shutdown" })).rejects.toThrow("control-handoff-conflict");
    await expect(requestHandoff(f.envelope, { ...f.request, requestId: "request-2", generation: 1 })).rejects.toThrow("control-handoff-identity-mismatch");
    await expect(requestHandoff(f.envelope, { ...f.request, requestId: "request-3", runId: "run-2" })).rejects.toThrow("control-handoff-identity-mismatch");
    await expect(requestHandoff({ ...f.envelope, contractHash: "d".repeat(64) }, f.request)).rejects.toThrow("control-envelope-conflict");
  });

  it("starts no phase when already latched and starts no next phase after a cooperative boundary", async () => {
    const before = await fixture();
    const stopped = createStopRequestSignal();
    stopped.requested = true;
    const plan = vi.fn(adapter().plan);
    const result = await runLoop(before.envelope.work.contract, before.runDir, adapter({ plan }), { stopRequested: stopped });
    expect(result.attemptsUsed).toBe(0);
    expect(plan).not.toHaveBeenCalled();

    const during = await fixture();
    const boundary = createStopRequestSignal();
    let releasePlan!: () => void;
    const planStarted = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    let letPlanFinish!: () => void;
    const planMayFinish = new Promise<void>((resolve) => {
      letPlanFinish = resolve;
    });
    const execute = vi.fn();
    const pending = runLoop(during.envelope.work.contract, during.runDir, adapter({
      plan: async () => {
        releasePlan();
        await planMayFinish;
        return { summary: "plan", primaryTargetPaths: ["value.txt"], tokenUsage: 1 };
      },
      execute,
    }), { stopRequested: boundary });
    await planStarted;
    boundary.requested = true;
    letPlanFinish();
    const boundaryResult = await pending;
    expect(boundaryResult.attemptsUsed).toBe(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("persists an external deadline abort as handoff interruption rather than failure or exhaustion", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const observed = vi.fn();
    const pending = runLoop(f.envelope.work.contract, f.runDir, adapter({
      plan: async ({ abortSignal }) => {
        await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("external-abort");
      },
    }), { phaseSignal: abort.signal, onPhaseSettled: observed });
    abort.abort();
    const result = await pending;
    expect(["planning", "executing", "verifying"]).toContain(result.status);
    expect(result.stopReason).toBeNull();
    expect(observed).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.runDir, "events.jsonl"), "utf8")).toContain("handoff_interrupted");
  });

  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): the worker now reads the
  // sealed materialized agent config (codex installation + selection) and a protocol-2 envelope whose configHash is
  // that config's hash, and builds its adapter through the codex descriptor; the deadline, packet, zero handoff usage,
  // seal and released-lease assertions are unchanged.
  it("watches a latched deadline through packet, zero handoff usage, seal, and released lease", async () => {
    const runtime = await codexFixture("hang");
    await mkdir(join(runtime.dir, "input"));
    const sealed = await sealCodex(parseCodexConfig(runtime.config));
    const amount = { tokens: 100, activeMs: 10_000, attempts: 1, sessions: 1 };
    const envelope: StartEnvelopeV2 = {
      protocol: 2,
      claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
      contractHash: "c".repeat(64),
      inputCheckpoint: null,
      work: { contract: runtime.contract, targetRepo: runtime.repo, base: "main", sourceDir: runtime.dir },
    };
    const controlDir = join(runtime.dir, "control");
    await ensurePrivateDirectory(runtime.dir, controlDir);
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
    await writeAccepted(runtime.dir, {
      protocol: 1,
      envelopeHash: canonicalHash(envelope),
      executionId: "execution-1",
      configHash: envelope.claim.configHash,
      generation: 1,
      acceptedAt: new Date().toISOString(),
      launch: "intended",
      worker: null,
    });

    const worker = runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
    await expect.poll(async () => {
      try { return (await readFile(runtime.marker, "utf8")).length; } catch { return 0; }
    }, { timeout: 2_000 }).toBeGreaterThan(0);
    const request: HandoffRequestV1 = { protocol: 1, requestId: "request-1", runId: "run-1", generation: 1, reason: "shutdown", deadlineAt: new Date(Date.now() + 150).toISOString() };
    expect(await requestHandoff(envelope, request)).toEqual({ kind: "latched", requestId: "request-1" });
    await worker;

    expect((await readAccepted(runtime.dir)).launch).toBe("sealed");
    const owner = JSON.parse(await readFile(join(runtime.runDir, "owner-record.json"), "utf8"));
    expect(owner.leaseAffirmedAt).toBeNull();
    const collected = await collectExecution(envelope, 0);
    expect(collected.candidate).toMatchObject({ result: "partial", handoff: { artifactId: expect.stringMatching(/^evidence-/) } });
    expect(collected.candidate?.stopProof).toMatchObject({ isolated: true });
    const packet = JSON.parse((await readEvidence(runtime.dir, collected.candidate!.handoff)).toString("utf8"));
    expect(packet.rawLogs.length).toBeGreaterThanOrEqual(3);
    expect(collected.events.map((event) => [event.bucket, event.cumulative?.tokens ?? null])).toEqual([
      ["work", null],
      ["handoff", 0],
    ]);
  });
});

describe("mechanical handoff packet", () => {
  it("derives blocked facts and explicit logs without an LLM call", async () => {
    const f = await fixture();
    await mkdir(f.runDir, { recursive: true });
    await writeFile(join(f.runDir, "events.jsonl"), `${JSON.stringify({ type: "attempt_started", at: new Date().toISOString(), detail: "attempt 1" })}\n`);
    await writeFile(join(f.runDir, "loop-state.json"), JSON.stringify(state("blocked_waiting_human", "choose a dependency")));
    const built = await buildHandoffPacket(f.envelope, f.request, state("blocked_waiting_human", "choose a dependency"), 7);
    expect(built.packet.identity).toMatchObject({ runId: "run-1", generation: 2, targetVersion: 4 });
    expect(built.packet.awaitingHuman).toEqual(["choose a dependency"]);
    expect(built.packet.pendingDecisions).toContain("choose a dependency");
    expect(built.packet.validationCommands).toEqual(["npm test"]);
    expect(built.packet.rawLogs.length).toBeGreaterThan(0);
    expect(built.packet.usageHighWater).toBe(7);
    expect(built.missing).toContain("attempts/1/execution.json");
  });

  // Agent selection (2026-09-26), wave-1 review I-2: the adapter's per-call evidence reaches the packet's raw logs for
  // every agent kind, not only codex's: a claude run's run/claude/<attempt>/<phase>/call-*/ files are retained the way
  // run/codex/'s are. request.json carries the prompt and stays out, as codex's evidence carries no prompt either.
  it("retains the claude adapter's per-call evidence in the raw logs, as it retains codex's", async () => {
    const f = await fixture();
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const claudeCall = join(f.runDir, "claude", "1", "plan", "call-abc");
    const codexCall = join(f.runDir, "codex", "1", "plan");
    await mkdir(claudeCall, { recursive: true });
    await mkdir(codexCall, { recursive: true });
    await writeFile(join(f.runDir, "events.jsonl"), "");
    const claudeFiles: Record<string, string> = {
      "process.json": '{"pid":11,"pgid":11,"phase":"plan","kind":"claude"}',
      "outcome.json": '{"reason":"completed","kind":"claude"}',
      "stdout.json": '{"structured_output":{"summary":"claude"}}',
      "stderr.log": "claude stderr\n",
      "usage.json": '{"input_tokens":12,"output_tokens":3}',
      "decode-error.txt": "claude decode error",
    };
    for (const [name, text] of Object.entries(claudeFiles)) await writeFile(join(claudeCall, name), text);
    await writeFile(join(claudeCall, "request.json"), '{"prompt":"the claude prompt"}');
    await writeFile(join(codexCall, "process.json"), '{"pid":22,"pgid":22,"phase":"plan","kind":"codex"}');

    const built = await buildHandoffPacket(f.envelope, f.request, state("blocked_waiting_human", "review"), 1);
    const hashes = built.packet.rawLogs.map((ref) => ref.hash);
    for (const text of Object.values(claudeFiles)) expect(hashes).toContain(sha(text));
    expect(hashes).toContain(sha('{"pid":22,"pgid":22,"phase":"plan","kind":"codex"}'));
    expect(hashes).not.toContain(sha('{"prompt":"the claude prompt"}'));
  });

  // ccloop ruling 88: rewrite authorized 2026-09-25 by the human through the Orca controller session e5f56bfe (Orca handoff delivery spec §12(1), §13.1, §13.2 I-9); whole-criterion rewrite, not weaker: a candidate answers the request it was built for, so neither the candidate nor its packet lists that request as unresolved, for every result.
  it("allows request:null only for natural terminal runs and retains handoff refs for every result", async () => {
    const f = await fixture();
    await mkdir(f.runDir, { recursive: true });
    await writeFile(join(f.runDir, "events.jsonl"), "");
    await writeFile(join(f.runDir, "loop-state.json"), JSON.stringify(state("succeeded")));
    expect((await buildHandoffPacket(f.envelope, null, state("succeeded"), 0)).packet.request).toBeNull();
    await expect(buildHandoffPacket(f.envelope, null, state("planning"), 0)).rejects.toThrow("control-handoff-request-required");

    for (const result of ["complete", "partial", "failed"] as const) {
      const candidate = await finalizeHandoffCandidate(f.envelope, f.request, state("blocked_waiting_human", "review"), {
        result,
        usageHighWater: 9,
      });
      expect(candidate.result).toBe(result);
      expect(candidate.handoff).toMatchObject({ artifactId: expect.stringMatching(/^evidence-/) });
      expect(candidate.artifacts).toContainEqual(candidate.handoff);
      expect(candidate.stopProof).toBeNull();
      expect(candidate.unresolvedRequestIds).toEqual([]);
      const packet = JSON.parse((await readEvidence(f.envelope.work.sourceDir, candidate.handoff)).toString("utf8"));
      expect(packet.unresolvedRequestIds).toEqual([]);
      // The request is answered, not dropped: the packet still names it.
      expect(packet.request).toEqual(f.request);
    }
  });
});
