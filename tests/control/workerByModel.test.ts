import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { runLoop } from "../../src/controller/runLoop.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { appendUsageObservation, byModelSchema, readUsageEvents, type ModelUsageV1, type UsageEventV1 } from "../../src/control/usage.js";
import { createByModelAccumulator, runControlWorker } from "../../src/control/worker.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { claudeInstallation, sealClaude, singleCallEnvelope, startEnvelope } from "./agentsFixture.js";

// Orca accounts plan, Part B Task B2 (2026-10-07): the control worker adds each phase's per-model breakdown into a
// run-wide one beside its cumulative token count, and puts it on the usage event only while it is known to be whole:
// every phase that spent tokens reported one, and the entries add up to the event's cumulative tokens. Orca prices a
// run per model from this, so a breakdown that leaves out a share would under-charge without anyone seeing it.
const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    try {
      for (const registered of JSON.parse(await readFile(join(dir, "control", "processes.json"), "utf8")) as Array<{ pgid: number }>) {
        try { process.kill(-registered.pgid, "SIGKILL"); } catch {}
      }
    } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** The fixture of tests/control/worker.test.ts: a one-attempt contract over a committed repository. */
async function runFixture(verifierType: "agent" | "command" = "agent") {
  const root = await temp("ccloop-worker-by-model-");
  const repo = join(root, "repo");
  const runDir = join(root, "run");
  await mkdir(repo);
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "value.txt"), "0\n");
  await execFileAsync("git", ["add", "value.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repo });
  const contract: LoopContract = {
    objective: { taskId: "hook-test", goal: "observe phases", successCondition: "done", nonGoals: [] },
    context: { repoPath: repo, targetPaths: ["value.txt"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalRuntimeBudgetMs: 5_000, tokenBudget: 1_000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
    safetyPolicy: { allowlistPaths: ["value.txt"], denylistPaths: [], maxFilesTouched: 2, humanGateConditions: [] },
    verification: { verifierType, requiredChecks: ["true"], rejectOn: ["failure"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
  return { runDir, contract, sourceDir: await temp("ccloop-worker-by-model-source-") };
}

type Phase = { tokens: number; modelUsage?: ModelUsageV1[] };
const entry = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): ModelUsageV1 => ({ model, input, output, cacheRead, cacheWrite });
const total = (entries: ModelUsageV1[]) => entries.reduce((sum, e) => sum + e.input + e.output + e.cacheRead + e.cacheWrite, 0);

function adapter([plan, execute, verify]: [Phase, Phase, Phase]): RuntimeAdapter {
  return {
    plan: async () => ({ summary: "plan", primaryTargetPaths: ["value.txt"], tokenUsage: plan.tokens, modelUsage: plan.modelUsage }),
    execute: async () => ({ changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "", tokenUsage: execute.tokens, modelUsage: execute.modelUsage }),
    verify: async () => ({ approved: true, rejectCategory: "", primaryTargetPaths: ["value.txt"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [], tokenUsage: verify.tokens, modelUsage: verify.modelUsage }),
  };
}

/** Mirrors src/control/worker.ts's onPhaseSettled for the "work" bucket, with the worker's own accumulator. */
async function runWorkBucket(phases: [Phase, Phase, Phase], verifierType: "agent" | "command" = "agent"): Promise<UsageEventV1[]> {
  const f = await runFixture(verifierType);
  const accumulator = createByModelAccumulator();
  let cumulativeTokens = 0;
  const result = await runLoop(f.contract, f.runDir, adapter(phases), {
    onPhaseSettled: async (observation) => {
      let byModel: ModelUsageV1[] | undefined;
      if (observation.tokenUsage !== null) {
        cumulativeTokens += observation.tokenUsage;
        byModel = accumulator.settle(observation.tokenUsage, observation.modelUsage, cumulativeTokens);
      }
      await appendUsageObservation(f.sourceDir, {
        runId: "run-1",
        generation: 1,
        bucket: "work",
        observationId: `attempt-${observation.attempt}-${observation.phase}`,
        threadTotalTokens: observation.tokenUsage === null ? null : cumulativeTokens,
        elapsedMs: observation.elapsedMs,
        attempts: observation.attempt,
        sessions: 1,
        evidence: observation,
        ...(byModel === undefined ? {} : { byModel }),
      });
    },
  });
  expect(result.status).toBe("succeeded");
  return await readUsageEvents(f.sourceDir);
}

/** Every event that carries a breakdown reconciles to its own cumulative tokens. */
function expectReconciled(events: UsageEventV1[]): void {
  for (const event of events) {
    if (event.byModel !== undefined) expect(total(event.byModel), `event ${event.eventSeq}`).toBe(event.cumulative?.tokens);
  }
}

describe("the worker's per-model breakdown (Orca accounts plan B2)", { timeout: 30_000 }, () => {
  it("sums each model across phases, reconciles to cumulative tokens, and drops out for good once a phase spends unseen", async () => {
    const events = await runWorkBucket([
      { tokens: 65, modelUsage: [entry("claude-haiku-4-5", 10, 5), entry("claude-opus-5-5", 30, 10, 8, 2)] },
      { tokens: 30, modelUsage: [entry("claude-opus-5-5", 20, 6, 4, 0)] },
      { tokens: 20 },
    ]);
    expect(events).toHaveLength(3);
    expect(events[1]!.byModel).toEqual([entry("claude-haiku-4-5", 10, 5), entry("claude-opus-5-5", 50, 16, 12, 2)]);
    expect(total(events[1]!.byModel!)).toBe(events[1]!.cumulative!.tokens);
    expect(events[1]!.cumulative!.tokens).toBe(95);
    expect(Object.hasOwn(events[2]!, "byModel")).toBe(false);
    expect(events[2]!.cumulative!.tokens).toBe(115);
    expectReconciled(events);
  });

  it("keeps the breakdown through a phase that spent nothing (a command verifier's explicit zero)", async () => {
    const events = await runWorkBucket([
      { tokens: 15, modelUsage: [entry("claude-opus-5-5", 10, 5)] },
      { tokens: 7, modelUsage: [entry("claude-haiku-4-5", 4, 3)] },
      { tokens: 999 },
    ], "command");
    expect(events.map((event) => event.cumulative?.tokens)).toEqual([15, 22, 22]);
    expect(events[2]!.byModel).toEqual([entry("claude-haiku-4-5", 4, 3), entry("claude-opus-5-5", 10, 5)]);
    expectReconciled(events);
  });

  it("never emits a breakdown that does not add up to the cumulative tokens", async () => {
    const events = await runWorkBucket([
      { tokens: 66, modelUsage: [entry("claude-opus-5-5", 50, 15)] },
      { tokens: 30, modelUsage: [entry("claude-opus-5-5", 20, 10)] },
      { tokens: 4, modelUsage: [entry("claude-opus-5-5", 2, 2)] },
    ]);
    expectReconciled(events);
    expect(events.filter((event) => Object.hasOwn(event, "byModel"))).toEqual([]);
  });

  // Final fix wave (partB-final-review Minor 1, 2026-10-07): a phase whose models do not add up to its own tokens has a
  // wrong split; a later opposite error could make the run total agree again, so the breakdown stops for good there.
  it("stops the breakdown for good at a phase whose models do not add up to its own tokens, even when a later error cancels it", async () => {
    const events = await runWorkBucket([
      { tokens: 60, modelUsage: [entry("claude-opus-5-5", 50, 15)] },
      { tokens: 30, modelUsage: [entry("claude-haiku-4-5", 20, 5)] },
      { tokens: 10, modelUsage: [entry("claude-haiku-4-5", 6, 4)] },
    ]);
    expect(events.map((event) => event.cumulative?.tokens)).toEqual([60, 90, 100]);
    expect(events.filter((event) => Object.hasOwn(event, "byModel"))).toEqual([]);
  });

  it("does not let a later breakdown vouch for a share spent unseen, even when the totals happen to agree", () => {
    const accumulator = createByModelAccumulator();
    expect(accumulator.settle(65, [entry("claude-opus-5-5", 50, 15)], 65)).toEqual([entry("claude-opus-5-5", 50, 15)]);
    expect(accumulator.settle(10, undefined, 75)).toBeUndefined();
    // This phase's breakdown over-reports by exactly the unseen 10, so the run-wide sums agree (65 + 15 = 80).
    expect(accumulator.settle(5, [entry("claude-haiku-4-5", 10, 5)], 80)).toBeUndefined();
  });

  it("refuses an empty breakdown: absent is how unknown is written", async () => {
    expect(byModelSchema.safeParse([]).success).toBe(false);
    const sourceDir = await temp("ccloop-worker-by-model-empty-");
    await expect(appendUsageObservation(sourceDir, {
      runId: "run-1", generation: 1, bucket: "work", observationId: "p1", threadTotalTokens: 0, elapsedMs: 0, attempts: 1, sessions: 1, evidence: {}, byModel: [],
    })).rejects.toThrow("control-usage-invalid");
  });
});

/** A claude stand-in for a single call: answers --version, else prints one result envelope. */
async function singleCallWorld(envelopeExtra: Record<string, unknown>): Promise<{ sourceDir: string; worker: Promise<void> }> {
  const sourceDir = await temp("ccloop-worker-by-model-single-");
  const aux = await temp("ccloop-worker-by-model-aux-");
  const probe = join(aux, "claude.mjs");
  const result = { type: "result", subtype: "success", is_error: false, structured_output: { answer: "x" }, usage: { input_tokens: 40, output_tokens: 15, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 }, ...envelopeExtra };
  await writeFile(probe, `if (process.argv.includes("--version")) process.stdout.write("9.9.9-probe\\n"); else process.stdout.write(${JSON.stringify(`${JSON.stringify(result)}\n`)});\n`);
  const sealed = await sealClaude(await claudeInstallation([process.execPath, probe], { timeoutMs: 20_000, killGraceMs: 300 }));
  const envelope = singleCallEnvelope({ sourceDir, agent: sealed.selection, configHash: sealed.configHash });
  const controlDir = join(sourceDir, "control");
  await ensurePrivateDirectory(sourceDir, controlDir);
  await atomicReplacePrivateFile(sourceDir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(sourceDir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(sourceDir, {
    protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
  });
  return { sourceDir, worker: runControlWorker(["--source-dir", sourceDir, "--execution-id", "execution-1", "--nonce", "nonce-1"]) };
}

describe("a single call's per-model breakdown through the control worker (Orca accounts plan B2)", { timeout: 30_000 }, () => {
  const MODEL_USAGE = {
    "claude-opus-5-5": { inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 8, cacheCreationInputTokens: 2 },
    "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  };

  it("puts claude's breakdown on the work event when it adds up to the call's tokens", async () => {
    const world = await singleCallWorld({ modelUsage: MODEL_USAGE });
    await world.worker;
    const [work, handoff] = await readUsageEvents(world.sourceDir);
    expect(work!.cumulative!.tokens).toBe(65);
    expect(work!.byModel).toEqual([entry("claude-haiku-4-5", 10, 5), entry("claude-opus-5-5", 30, 10, 8, 2)]);
    expect(Object.hasOwn(handoff!, "byModel")).toBe(false);
  });

  it("leaves it off when it does not add up", async () => {
    const world = await singleCallWorld({ modelUsage: { ...MODEL_USAGE, "claude-haiku-4-5": { ...MODEL_USAGE["claude-haiku-4-5"], outputTokens: 6 } } });
    await world.worker;
    const [work] = await readUsageEvents(world.sourceDir);
    expect(work!.cumulative!.tokens).toBe(65);
    expect(Object.hasOwn(work!, "byModel")).toBe(false);
  });
});

// Fix round 1 of B2 (2026-10-07, review Important 2): the loop path through the real runControlWorker, so the worker's
// own onPhaseSettled -- not a copy of it -- is what puts byModel on the events.
const PHASE_USAGE = {
  plan: { usage: { input_tokens: 40, output_tokens: 15, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 }, modelUsage: {
    "claude-opus-5-5": { inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 8, cacheCreationInputTokens: 2 },
    "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  } },
  execute: { usage: { input_tokens: 20, output_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 }, modelUsage: {
    "claude-opus-5-5": { inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 4, cacheCreationInputTokens: 0 },
  } },
  verify: { usage: { input_tokens: 15, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {
    "claude-haiku-4-5": { inputTokens: 15, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  } },
};

/** A claude stand-in for a loop run: answers --version; else tells the phase by its --json-schema, as the shared fake does. */
async function loopWorld(): Promise<{ sourceDir: string; worker: Promise<void> }> {
  const root = await temp("ccloop-worker-by-model-loop-");
  const repo = join(root, "target"), sourceDir = join(root, "source"), probe = join(root, "claude.mjs");
  await mkdir(repo);
  await mkdir(join(sourceDir, "input"), { recursive: true });
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await execFileAsync("git", args, { cwd: repo });
  await writeFile(join(repo, "answer.txt"), "0\n");
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repo });
  await writeFile(probe, `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("9.9.9-probe\\n"); process.exit(0); }
const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
const phase = schema.properties?.changedFiles ? "execute" : schema.properties?.approved ? "verify" : "plan";
const usage = ${JSON.stringify(PHASE_USAGE)}[phase];
const body = {
  plan: { summary: "set answer", primaryTargetPaths: ["answer.txt"] },
  execute: { changedFiles: ["answer.txt"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" },
  verify: { approved: true, rejectCategory: "", primaryTargetPaths: ["answer.txt"], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] },
}[phase];
if (phase === "execute") writeFileSync("answer.txt", "42\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: body, ...usage }) + "\\n");
`);
  const sealed = await sealClaude(await claudeInstallation([process.execPath, probe], { timeoutMs: 20_000, killGraceMs: 300 }));
  const contract: LoopContract = {
    objective: { taskId: "task-1", goal: "Set answer.txt to 42", successCondition: "answer is 42", nonGoals: [] },
    context: { repoPath: repo, targetPaths: ["answer.txt"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 20_000, totalRuntimeBudgetMs: 60_000, tokenBudget: 1_000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
    safetyPolicy: { allowlistPaths: ["answer.txt"], denylistPaths: [], maxFilesTouched: 2, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["failure"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
  const envelope = startEnvelope({ sourceDir, targetRepo: repo, contract, agent: sealed.selection, configHash: sealed.configHash });
  const controlDir = join(sourceDir, "control");
  await ensurePrivateDirectory(sourceDir, controlDir);
  await atomicReplacePrivateFile(sourceDir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(sourceDir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(sourceDir, {
    protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
  });
  return { sourceDir, worker: runControlWorker(["--source-dir", sourceDir, "--execution-id", "execution-1", "--nonce", "nonce-1"]) };
}

describe("a loop run's per-model breakdown through the control worker (Orca accounts plan B2, fix round 1)", { timeout: 60_000 }, () => {
  it("puts the summed breakdown on each work event, reconciled to its cumulative tokens", async () => {
    const world = await loopWorld();
    await world.worker;
    const events = await readUsageEvents(world.sourceDir);
    const work = events.filter((event) => event.bucket === "work");
    expect(work.map((event) => event.cumulative?.tokens)).toEqual([65, 95, 115]);
    expect(work.map((event) => event.byModel)).toEqual([
      [entry("claude-haiku-4-5", 10, 5), entry("claude-opus-5-5", 30, 10, 8, 2)],
      [entry("claude-haiku-4-5", 10, 5), entry("claude-opus-5-5", 50, 16, 12, 2)],
      [entry("claude-haiku-4-5", 25, 10), entry("claude-opus-5-5", 50, 16, 12, 2)],
    ]);
    expectReconciled(events);
    expect(events.filter((event) => event.bucket === "handoff").every((event) => !Object.hasOwn(event, "byModel"))).toBe(true);
  });
});
