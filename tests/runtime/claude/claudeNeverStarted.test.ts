// Crash resume (2026-10-02), spec §3.2 (R-A), adapter end: the runner's never-started answer becomes ClaudeNeverStartedError
// (or ClaudePhaseAborted when the call was aborted), both observed as 0 spent; runLoop books that 0. A claude that
// started and then failed keeps today's usage (null without observation), never a forced 0.
import { mkdtemp, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { runLoop, type RunControlHooks } from "../../../src/controller/runLoop.js";
import { ClaudeAgentAdapter, ClaudeNeverStartedError, ClaudePhaseAborted } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { observedTokensOf, SingleCallOutputInvalid, type RuntimeAdapter, type SingleCallRequest } from "../../../src/runtime/types.js";
import { codexFixture } from "../codex/fixture.js";

type Observation = Parameters<NonNullable<RunControlHooks["onPhaseSettled"]>>[0];
const DELAY = "CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS";
let savedDelay: string | undefined;
const dirs: string[] = [];
beforeEach(() => { savedDelay = process.env[DELAY]; process.env[DELAY] = "10"; });
afterEach(async () => {
  if (savedDelay === undefined) delete process.env[DELAY]; else process.env[DELAY] = savedDelay;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function world(command: (dir: string) => Promise<[string, ...string[]]>) {
  const f = await codexFixture("unused");
  dirs.push(f.dir);
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: await command(f.dir), version: "9.9.9", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
  };
  return { ...f, adapter: new ClaudeAgentAdapter(config) };
}
const missing = async (dir: string): Promise<[string, ...string[]]> => [join(dir, "no-such-claude")];
const exitsOne = async (dir: string): Promise<[string, ...string[]]> => {
  const script = join(dir, "exit-one.mjs");
  await writeFile(script, "process.exit(1);\n");
  return [process.execPath, script];
};
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("resolved"); }, (e: unknown) => e);
const singleCallRequest = (f: { dir: string; runDir: string; repo: string }, extra: Partial<SingleCallRequest> = {}): SingleCallRequest =>
  ({ prompt: "p", responseSchema: { type: "object" }, maxOutputTokens: 100, cwd: f.repo, runDir: f.runDir, timeoutMs: 20_000, ...extra });

describe("claude never started books 0 (spec 2026-10-02 §3.2)", () => {
  it("execute with a missing claude throws ClaudeNeverStartedError whose observed usage is 0", async () => {
    const f = await world(missing);
    const error = await rejection(f.adapter.execute(f.context));
    expect(error).toBeInstanceOf(ClaudeNeverStartedError);
    expect((error as ClaudeNeverStartedError).spawnError).toMatch(/^ENOENT: /);
    expect((error as Error).message).toContain("claude-never-started: ENOENT");
    expect(observedTokensOf(error)).toBe(0);
  }, 30_000);

  it("singleCall with a missing claude throws ClaudeNeverStartedError, not SingleCallOutputInvalid", async () => {
    const f = await world(missing);
    const error = await rejection(f.adapter.singleCall(singleCallRequest(f)));
    expect(error).toBeInstanceOf(ClaudeNeverStartedError);
    expect(error).not.toBeInstanceOf(SingleCallOutputInvalid);
    expect(observedTokensOf(error)).toBe(0);
  }, 30_000);

  it("exit after start keeps today's usage (null without observation), never a forced 0", async () => {
    const f = await world(exitsOne);
    const error = await rejection(f.adapter.plan(f.context));
    expect(error).not.toBeInstanceOf(ClaudeNeverStartedError);
    expect((error as Error).message).toContain("claude-exit-error");
    expect(observedTokensOf(error)).toBeNull();
  }, 30_000);

  it("an abort during the retry wait throws ClaudePhaseAborted that still observes 0", async () => {
    process.env[DELAY] = "5000";
    const f = await world(missing);
    const controller = new AbortController();
    const started = Date.now();
    // The runner has its first ENOENT within a fraction of a second and is then waiting 5 s; abort inside that wait.
    setTimeout(() => controller.abort(), 1500);
    const error = await rejection(f.adapter.plan({ ...f.context, abortSignal: controller.signal }));
    expect(error).toBeInstanceOf(ClaudePhaseAborted);
    expect(Date.now() - started).toBeLessThan(4500);
    expect(observedTokensOf(error)).toBe(0);
  }, 30_000);

  // execute() keeps its existing abort contract (an aborted execute with no observed usage answers null; spec §3.2 leaves it
  // unchanged), so this is where the after-stop branch would otherwise return the never-started answer as the phase's result.
  it("an abort during the retry wait of execute answers null, not the never-started JSON as a result", async () => {
    process.env[DELAY] = "5000";
    const f = await world(missing);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1500);
    expect(await f.adapter.execute({ ...f.context, abortSignal: controller.signal })).toBeNull();
  }, 30_000);

  it("runLoop books 0 for a never-started execute and ends failed (T5)", async () => {
    const f = await world(missing);
    const adapter: RuntimeAdapter = {
      plan: async () => ({ summary: "plan", primaryTargetPaths: ["answer.txt"], tokenUsage: 1 }),
      execute: (context) => f.adapter.execute(context),
      verify: async () => { throw new Error("verify must not run"); },
    };
    const observed: Observation[] = [];
    const state = await runLoop(f.contract, f.runDir, adapter, { onPhaseSettled: async (value) => { observed.push(value); } });
    expect(state.status).toBe("failed");
    expect(state.stopReason).toContain("claude-never-started");
    expect(observed.find((o) => o.phase === "execute")).toMatchObject({ tokenUsage: 0, completedWithResult: false });
    expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(999);
  }, 30_000);
});
