import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { usageEventSchema } from "../../src/control/command.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { appendUsageObservation, modelUsageSchema, readUsageEvents, type ModelUsageV1 } from "../../src/control/usage.js";
import { createByModelAccumulator, runControlWorker } from "../../src/control/worker.js";
import { codexModelUsage } from "../../src/runtime/codex/protocol.js";
import { decodeOmpPhase } from "../../src/runtime/omp/ompProtocol.js";
// @ts-expect-error -- plain ESM script without types
import { buildModelUsage, createUsageObserver } from "../../scripts/claude-stream.mjs";
import { claudeInstallation, sealClaude, singleCallEnvelope, startEnvelope } from "./agentsFixture.js";

// Orca raw usage detail (Orca spec 2026-11-13-raw-usage-detail-design.md, §3 and the controller's §8). The human:
// 「都要记录原始token，而不是等效token。需要详细分别记录 token 相关的一些状态」 and 「有些项目不是must have，有就记录，没有就留空」.
// So each sub-part rides on the per-model entry only when the provider reported it; absent is unknown, never 0 or a
// guess, because a later dollar conversion cannot tell a guessed split from a measured one.
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

const four = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): ModelUsageV1 => ({ model, input, output, cacheRead, cacheWrite });

describe("the per-model entry's optional sub-parts (spec §5)", () => {
  // Why: Orca books these as sub-parts of the four reconciling parts; a sub-part larger than its part would be a split
  // no provider could have measured, so ccloop's own schema refuses it rather than letting it reach the ledger.
  it("takes each sub-part when it fits inside its part, and refuses one that does not", () => {
    const base = four("m", 10, 5, 3, 4);
    expect(modelUsageSchema.safeParse({ ...base, reasoning: 5, cacheWrite5m: 1, cacheWrite1h: 3, requests: 2, maxRequestInput: 17 }).success).toBe(true);
    expect(modelUsageSchema.safeParse({ ...base, cacheWrite5m: 4 }).success).toBe(true);
    expect(modelUsageSchema.safeParse({ ...base, reasoning: 6 }).success).toBe(false);
    expect(modelUsageSchema.safeParse({ ...base, cacheWrite5m: 2, cacheWrite1h: 3 }).success).toBe(false);
    expect(modelUsageSchema.safeParse({ ...base, cacheWrite1h: 5 }).success).toBe(false);
    expect(modelUsageSchema.safeParse({ ...base, maxRequestInput: 18 }).success).toBe(false);
    expect(modelUsageSchema.safeParse({ ...base, requests: -1 }).success).toBe(false);
    expect(modelUsageSchema.safeParse({ ...base, requests: 1.5 }).success).toBe(false);
    expect(modelUsageSchema.safeParse({ ...base, cost: 1 }).success).toBe(false);
  });

  it("an observation with a violating sub-part is refused whole, so it never reaches the ledger", async () => {
    const sourceDir = await temp("ccloop-raw-usage-refuse-");
    await expect(appendUsageObservation(sourceDir, {
      runId: "run-1", generation: 1, bucket: "work", observationId: "p1", threadTotalTokens: 22, elapsedMs: 0, attempts: 1, sessions: 1, evidence: {},
      byModel: [{ ...four("m", 10, 5, 3, 4), reasoning: 6 }],
    })).rejects.toThrow("control-usage-invalid");
    expect(await readUsageEvents(sourceDir)).toEqual([]);
  });

  it("collect's event schema carries the sub-parts and a phase, and refuses a phase ccloop never writes", () => {
    const base = { runId: "run-1", generation: 1, eventSeq: 1, bucket: "work" as const, cumulative: null, source: { artifactId: "a1", hash: "a".repeat(64) } };
    const detailed = { ...four("m", 10, 5, 3, 4), reasoning: 2, cacheWrite5m: 1, cacheWrite1h: 3, requests: 2, maxRequestInput: 9 };
    expect(usageEventSchema.parse({ ...base, byModel: [detailed], phase: "setup" })).toMatchObject({ byModel: [detailed], phase: "setup" });
    expect(usageEventSchema.safeParse({ ...base, phase: "single-call" }).success).toBe(false);
    expect(usageEventSchema.safeParse({ ...base, byModel: [{ ...detailed, maxRequestInput: 18 }] }).success).toBe(false);
  });
});

describe("the worker's accumulator for sub-parts (spec §8.4, §8.5)", () => {
  // Why §8.4: once a phase spent on a model without a sub-part, any later sum of that sub-part misses that phase's share
  // yet would look measured -- the anti-goal. Why §8.5: maxRequestInput says whether a request of THIS phase crossed a
  // provider's long-context threshold, so it is the phase's own, never a run-wide max and never a sum.
  it("sums requests and sub-parts, keeps a field absent for good once a phase lacked it, and takes maxRequestInput per phase", () => {
    const acc = createByModelAccumulator();
    const plan = [{ ...four("a", 10, 4), reasoning: 1, requests: 2, maxRequestInput: 8 }, { ...four("b", 6, 2, 0, 2), cacheWrite1h: 2, requests: 1, maxRequestInput: 8 }];
    expect(acc.settle(24, plan, 24)).toEqual(plan);
    const execute = [{ ...four("a", 5, 2), requests: 1, maxRequestInput: 5 }];
    expect(acc.settle(7, execute, 31)).toEqual([
      { ...four("a", 15, 6), requests: 3, maxRequestInput: 5 },
      { ...four("b", 6, 2, 0, 2), cacheWrite1h: 2, requests: 1 },
    ]);
    const verify = [{ ...four("a", 3, 1), reasoning: 1, requests: 1, maxRequestInput: 3 }, { ...four("b", 1, 1), cacheWrite1h: 0 }];
    expect(acc.settle(6, verify, 37)).toEqual([
      { ...four("a", 18, 7), requests: 4, maxRequestInput: 3 },
      { ...four("b", 7, 3, 0, 2), cacheWrite1h: 2 },
    ]);
  });
});

describe("claude: sub-parts from the envelope, requests from a stream that reconciles (spec §8.2)", () => {
  const envelope = (value: Record<string, unknown>) => ({ modelUsage: { m: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, ...value } } });
  const streamed = (entry: Record<string, number> | null) => new Map([["m", entry]]);
  const seen = { input: 10, output: 5, cacheRead: 3, cacheWrite: 4, requests: 2, maxRequestInput: 12 };

  it("copies thinking and the cache-write buckets beside the four counts, and requests when the stream adds up", () => {
    expect(buildModelUsage(envelope({ thinkingTokens: 2, cacheCreationEphemeral5mInputTokens: 1, cacheCreationEphemeral1hInputTokens: 3 }), streamed(seen))).toEqual([
      { ...four("m", 10, 5, 3, 4), reasoning: 2, cacheWrite5m: 1, cacheWrite1h: 3, requests: 2, maxRequestInput: 12 },
    ]);
  });

  it("leaves requests out when the stream's four parts for the model differ from the envelope's, or the stream has none", () => {
    expect(buildModelUsage(envelope({}), streamed({ ...seen, output: 4 }))).toEqual([four("m", 10, 5, 3, 4)]);
    expect(buildModelUsage(envelope({}), streamed(null))).toEqual([four("m", 10, 5, 3, 4)]);
    expect(buildModelUsage(envelope({}), new Map())).toEqual([four("m", 10, 5, 3, 4)]);
    expect(buildModelUsage(envelope({}))).toEqual([four("m", 10, 5, 3, 4)]);
  });

  it("leaves out a sub-part larger than its part, or unreadable, without touching the four counts", () => {
    expect(buildModelUsage(envelope({ thinkingTokens: 6 }))).toEqual([four("m", 10, 5, 3, 4)]);
    expect(buildModelUsage(envelope({ thinkingTokens: "2" }))).toEqual([four("m", 10, 5, 3, 4)]);
    expect(buildModelUsage(envelope({ cacheCreationEphemeral5mInputTokens: 2, cacheCreationEphemeral1hInputTokens: 3 }))).toEqual([four("m", 10, 5, 3, 4)]);
    expect(buildModelUsage(envelope({ cacheCreationEphemeral1hInputTokens: 4 }))).toEqual([{ ...four("m", 10, 5, 3, 4), cacheWrite1h: 4 }]);
  });

  const start = (id: string, model: string | undefined, usage: Record<string, unknown>, parent: string | null = null) => ({ type: "stream_event", parent_tool_use_id: parent, event: { type: "message_start", message: { id, model, usage } } });
  const delta = (usage: Record<string, unknown>, parent: string | null = null) => ({ type: "stream_event", parent_tool_use_id: parent, event: { type: "message_delta", usage } });
  const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, extra: Record<string, unknown> = {}) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, ...extra });

  it("counts each streamed message once per model, by its latest usage, and the largest request's input", () => {
    const observer = createUsageObserver();
    for (const event of [
      start("1", "m", usage(2, 1, 0, 0)), delta(usage(2, 3, 0, 5)),
      start("2", "m", usage(1, 1, 7, 0)), delta(usage(1, 2, 7, 0)),
      start("3", "s", usage(4, 1, 0, 0), "tool-1"), delta(usage(4, 2, 0, 0), "tool-1"),
    ]) observer.observe(event);
    expect(observer.byModel()).toEqual(new Map([
      ["m", { input: 3, output: 5, cacheRead: 7, cacheWrite: 5, requests: 2, maxRequestInput: 8 }],
      ["s", { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, requests: 1, maxRequestInput: 4 }],
    ]));
  });

  it("knows no request detail for a model with an unreadable message or several iterations behind one, nor while a message is open or unnamed", () => {
    const of = (events: unknown[]) => { const observer = createUsageObserver(); for (const event of events) observer.observe(event); return observer.byModel(); };
    expect(of([start("1", "m", usage(1, 1, 0, 0)), delta({ output_tokens: 3 }), start("2", "m", usage(1, 1, 0, 0)), delta(usage(1, 1, 0, 0))])).toEqual(new Map([["m", null]]));
    expect(of([start("1", "m", usage(1, 1, 0, 0)), delta(usage(2, 2, 0, 0, { iterations: [{}, {}] }))])).toEqual(new Map([["m", null]]));
    expect(of([start("1", "m", usage(1, 1, 0, 0)), delta(usage(2, 2, 0, 0, { iterations: [{}] }))])).toEqual(new Map([["m", { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, requests: 1, maxRequestInput: 2 }]]));
    expect(of([start("1", "m", usage(1, 1, 0, 0))])).toBeNull();
    expect(of([start("1", undefined, usage(1, 1, 0, 0)), delta(usage(1, 1, 0, 0))])).toBeNull();
  });
});

describe("codex and omp producers (spec §3)", () => {
  const completed = (usage: Record<string, number>) => JSON.stringify({ type: "turn.completed", usage }) + "\n";
  it("codex: reasoning_output_tokens becomes reasoning; requests and maxRequestInput stay absent (turn totals only)", () => {
    expect(codexModelUsage(completed({ input_tokens: 15, cached_input_tokens: 5, output_tokens: 6, reasoning_output_tokens: 4 }), "gpt-x"))
      .toEqual([{ model: "gpt-x", input: 10, output: 6, cacheRead: 5, cacheWrite: 0, reasoning: 4 }]);
  });
  it("codex: no reasoning when codex did not report it, or reported more than its output", () => {
    expect(codexModelUsage(completed({ input_tokens: 15, output_tokens: 6 }), "gpt-x")).toEqual([{ model: "gpt-x", input: 15, output: 6, cacheRead: 0, cacheWrite: 0 }]);
    expect(codexModelUsage(completed({ input_tokens: 15, output_tokens: 6, reasoning_output_tokens: 7 }), "gpt-x")).toEqual([{ model: "gpt-x", input: 15, output: 6, cacheRead: 0, cacheWrite: 0 }]);
  });

  it("omp: each assistant message is one request; reasoning stays absent (omp's usage has no such count)", () => {
    const message = (input: number, cacheRead: number, stopReason: string, text: string) => ({ role: "assistant", provider: "gw", model: "m", stopReason,
      content: [{ type: "text", text }], usage: { input, output: 2, cacheRead, cacheWrite: 1, totalTokens: input + 2 + cacheRead + 1 } });
    const plan = JSON.stringify({ summary: "s", primaryTargetPaths: ["a.txt"] });
    const rows = [{ type: "message_end", message: message(5, 0, "toolUse", "thinking aloud") }, { type: "message_end", message: message(3, 9, "stop", plan) }, { type: "agent_end", isTerminal: true }];
    const result = decodeOmpPhase("plan", rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "gw/m");
    expect(result.modelUsage).toEqual([{ model: "gw/m", input: 8, output: 4, cacheRead: 9, cacheWrite: 2, requests: 2, maxRequestInput: 13 }]);
  });
});

/** A claude stand-in that streams message_start / message_delta per phase before its result envelope. */
const PHASES = {
  plan: {
    stream: [["p1", "opus", [20, 6, 8, 2]], ["p2", "opus", [10, 4, 0, 0]], ["p3", "haiku", [10, 5, 0, 0]]],
    modelUsage: {
      opus: { inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 8, cacheCreationInputTokens: 2, thinkingTokens: 3, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 2 },
      haiku: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0 },
    },
  },
  // The stream says output 5 where the envelope says 6: the stream missed something, so no request count for opus.
  execute: {
    stream: [["e1", "opus", [20, 5, 4, 0]]],
    modelUsage: { opus: { inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 4, cacheCreationInputTokens: 0, thinkingTokens: 1, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0 } },
  },
  // No thinkingTokens for haiku this phase: haiku's reasoning is unknown from here on.
  verify: {
    stream: [["v1", "haiku", [15, 5, 0, 0]]],
    modelUsage: { haiku: { inputTokens: 15, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  },
  single: {
    stream: [["s1", "opus", [30, 10, 8, 2]], ["s2", "haiku", [10, 5, 0, 0]], ["s3", "haiku", [0, 0, 0, 0]]],
    modelUsage: {
      opus: { inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 8, cacheCreationInputTokens: 2, thinkingTokens: 3, cacheCreationEphemeral5mInputTokens: 2, cacheCreationEphemeral1hInputTokens: 0 },
      haiku: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
  },
};
const STAND_IN = `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("9.9.9-probe\\n"); process.exit(0); }
const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
const phase = schema.properties?.answer ? "single" : schema.properties?.changedFiles ? "execute" : schema.properties?.approved ? "verify" : "plan";
const spec = ${JSON.stringify(PHASES)}[phase];
const body = {
  single: { answer: "x" },
  plan: { summary: "set answer", primaryTargetPaths: ["answer.txt"] },
  execute: { changedFiles: ["answer.txt"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" },
  verify: { approved: true, rejectCategory: "", primaryTargetPaths: ["answer.txt"], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] },
}[phase];
if (phase === "execute") writeFileSync("answer.txt", "42\\n");
const out = [];
const sum = [0, 0, 0, 0];
for (const [id, model, [i, o, r, w]] of spec.stream) {
  const usage = { input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w };
  out.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id, model, usage: { ...usage, output_tokens: 1 } } } });
  out.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage } });
}
const totals = Object.values(spec.modelUsage).reduce((t, v) => [t[0] + v.inputTokens, t[1] + v.outputTokens, t[2] + v.cacheReadInputTokens, t[3] + v.cacheCreationInputTokens], sum);
out.push({ type: "result", subtype: "success", is_error: false, structured_output: body, modelUsage: spec.modelUsage,
  usage: { input_tokens: totals[0], output_tokens: totals[1], cache_read_input_tokens: totals[2], cache_creation_input_tokens: totals[3] } });
process.stdout.write(out.map((row) => JSON.stringify(row)).join("\\n") + "\\n");
`;

async function world(kind: "loop" | "single"): Promise<{ sourceDir: string; worker: Promise<void> }> {
  const root = await temp("ccloop-raw-usage-world-");
  const repo = join(root, "target"), sourceDir = join(root, "source"), probe = join(root, "claude.mjs");
  await mkdir(repo);
  await mkdir(join(sourceDir, "input"), { recursive: true });
  await writeFile(probe, STAND_IN);
  const sealed = await sealClaude(await claudeInstallation([process.execPath, probe], { timeoutMs: 20_000, killGraceMs: 300 }));
  let envelope;
  if (kind === "single") envelope = singleCallEnvelope({ sourceDir, agent: sealed.selection, configHash: sealed.configHash });
  else {
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await execFileAsync("git", args, { cwd: repo });
    await writeFile(join(repo, "answer.txt"), "0\n");
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repo });
    const contract: LoopContract = {
      objective: { taskId: "task-1", goal: "Set answer.txt to 42", successCondition: "answer is 42", nonGoals: [] },
      context: { repoPath: repo, targetPaths: ["answer.txt"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
      executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 20_000, totalRuntimeBudgetMs: 60_000, tokenBudget: 1_000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
      safetyPolicy: { allowlistPaths: ["answer.txt"], denylistPaths: [], maxFilesTouched: 2, humanGateConditions: [] },
      verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["failure"], evidenceRequired: [] },
      escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
    };
    envelope = startEnvelope({ sourceDir, targetRepo: repo, contract, agent: sealed.selection, configHash: sealed.configHash });
  }
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

describe("raw usage detail through the real control worker and claude runner", { timeout: 60_000 }, () => {
  it("a loop run's work events name their phase and carry each model's detail under the absent-stays-absent rule", async () => {
    const w = await world("loop");
    await w.worker;
    const events = await readUsageEvents(w.sourceDir);
    const work = events.filter((event) => event.bucket === "work");
    expect(work.map((event) => event.phase)).toEqual(["plan", "execute", "verify"]);
    expect(events.filter((event) => event.bucket === "handoff").every((event) => !Object.hasOwn(event, "phase"))).toBe(true);
    expect(work.map((event) => event.byModel)).toEqual([
      [
        { ...four("haiku", 10, 5), reasoning: 0, requests: 1, maxRequestInput: 10 },
        { ...four("opus", 30, 10, 8, 2), reasoning: 3, cacheWrite5m: 0, cacheWrite1h: 2, requests: 2, maxRequestInput: 30 },
      ],
      [
        { ...four("haiku", 10, 5), reasoning: 0, requests: 1 },
        { ...four("opus", 50, 16, 12, 2), reasoning: 4, cacheWrite5m: 0, cacheWrite1h: 2 },
      ],
      [
        { ...four("haiku", 25, 10), requests: 2, maxRequestInput: 15 },
        { ...four("opus", 50, 16, 12, 2), reasoning: 4, cacheWrite5m: 0, cacheWrite1h: 2 },
      ],
    ]);
  });

  it("a single call's work event carries the detail and no phase", async () => {
    const w = await world("single");
    await w.worker;
    const [work, handoff] = await readUsageEvents(w.sourceDir);
    expect(Object.hasOwn(work!, "phase")).toBe(false);
    expect(Object.hasOwn(handoff!, "phase")).toBe(false);
    expect(work!.byModel).toEqual([
      { ...four("haiku", 10, 5), requests: 2, maxRequestInput: 10 },
      { ...four("opus", 30, 10, 8, 2), reasoning: 3, cacheWrite5m: 2, cacheWrite1h: 0, requests: 1, maxRequestInput: 40 },
    ]);
  });
});
