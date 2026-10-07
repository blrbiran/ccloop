import { spawn } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without types
import { buildModelUsage } from "../../../scripts/claude-stream.mjs";

// Orca accounts plan, Part B Task B2 (2026-10-07): claude's result envelope carries `modelUsage`, keyed by model. The
// runner turns it into a per-model breakdown so Orca can price a run per model; a breakdown it cannot read whole is no
// breakdown (null), because a partial one would silently under-report some model's spend.
const runner = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const MODEL_USAGE = {
  "claude-opus-5-5": { inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 8, cacheCreationInputTokens: 2, costUSD: 0.1 },
  "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
};
// The envelope's own usage totals the breakdown: 40 + 15 + 8 + 2 = 65.
const USAGE = { input_tokens: 40, output_tokens: 15, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 };
const EXPECTED = [
  { model: "claude-haiku-4-5", input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  { model: "claude-opus-5-5", input: 30, output: 10, cacheRead: 8, cacheWrite: 2 },
];

describe("buildModelUsage (Orca accounts plan B2)", () => {
  it("maps claude's per-model counts to entries sorted by model, dropping cost", () => {
    expect(buildModelUsage({ type: "result", modelUsage: MODEL_USAGE, usage: USAGE })).toEqual(EXPECTED);
  });

  it("answers null when any model's value is unreadable, rather than a breakdown missing that model", () => {
    expect(buildModelUsage({ modelUsage: { ...MODEL_USAGE, "claude-sonnet-4-6": "12" } })).toBeNull();
    expect(buildModelUsage({ modelUsage: { ...MODEL_USAGE, "claude-sonnet-4-6": { ...MODEL_USAGE["claude-haiku-4-5"], outputTokens: -1 } } })).toBeNull();
    expect(buildModelUsage({ modelUsage: { ...MODEL_USAGE, "claude-sonnet-4-6": { ...MODEL_USAGE["claude-haiku-4-5"], inputTokens: 1.5 } } })).toBeNull();
    expect(buildModelUsage({ modelUsage: { ...MODEL_USAGE, "claude-sonnet-4-6": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 } } })).toBeNull();
  });

  it("answers null when there is no map, or an empty one: absent means unknown, never an empty breakdown", () => {
    expect(buildModelUsage({ type: "result", usage: USAGE })).toBeNull();
    expect(buildModelUsage({ modelUsage: {} })).toBeNull();
    expect(buildModelUsage({ modelUsage: [] })).toBeNull();
    expect(buildModelUsage(null)).toBeNull();
  });
});

/** The fake `claude` binary on PATH, as tests/runtime/claude/claudePhaseRunner.test.ts builds it. */
async function createFakeClaudeBinary(source: string): Promise<string> {
  const binDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-claude-bin-")));
  dirs.push(binDir);
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, `#!/usr/bin/env node
${source}`);
  await chmod(claudePath, 0o755);
  return binDir;
}

async function runnerWith(request: Record<string, unknown>, envelope: Record<string, unknown>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const binDir = await createFakeClaudeBinary(`process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});`);
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    delete env.CCLOOP_CLAUDE_COMMAND;
    delete env.CCLOOP_CLAUDE_EXTRA_ARGS;
    const child = spawn(process.execPath, [runner], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(request));
  });
}

async function work(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-model-usage-")));
  dirs.push(dir);
  return dir;
}

const plan = (dir: string) => ({ phase: "plan", prompt: "Plan one isolated L2 attempt for task t.", attempt: 1, runDir: dir, worktreePath: dir, partialOutcomeRecoveryWindowMs: 100 });
const result = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", is_error: false, structured_output: { summary: "s", primaryTargetPaths: ["a.txt"] }, usage: USAGE, ...extra });

describe("the claude phase runner reports modelUsage (Orca accounts plan B2)", { timeout: 30_000 }, () => {
  it("carries both models beside a tokenUsage the breakdown adds up to", async () => {
    const outcome = await runnerWith(plan(await work()), result({ modelUsage: MODEL_USAGE }));
    expect(outcome.code, outcome.stderr).toBe(0);
    const answer = JSON.parse(outcome.stdout);
    expect(answer.tokenUsage).toBe(65);
    expect(answer.modelUsage).toEqual(EXPECTED);
    const sum = (answer.modelUsage as typeof EXPECTED).reduce((total, e) => total + e.input + e.output + e.cacheRead + e.cacheWrite, 0);
    expect(sum).toBe(answer.tokenUsage);
  });

  it("leaves modelUsage out when claude's envelope has none, so the answer is byte-for-byte what it was", async () => {
    const outcome = await runnerWith(plan(await work()), result({}));
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(Object.hasOwn(JSON.parse(outcome.stdout), "modelUsage")).toBe(false);
  });

  it("carries modelUsage on a single call's answer too", async () => {
    const dir = await work();
    const outcome = await runnerWith(
      { phase: "single-call", prompt: "Estimate.", attempt: 1, runDir: dir, cwd: dir, schema: { type: "object" }, maxOutputTokens: 100 },
      { type: "result", subtype: "success", is_error: false, structured_output: { answer: "x" }, usage: USAGE, modelUsage: MODEL_USAGE },
    );
    expect(outcome.code, outcome.stderr).toBe(0);
    const answer = JSON.parse(outcome.stdout);
    expect(answer.tokenUsage).toBe(65);
    expect(answer.modelUsage).toEqual(EXPECTED);
  });
});
