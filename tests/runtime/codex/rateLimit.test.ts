import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter, CodexPhaseAborted } from "../../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { classifyRateLimit } from "../../../src/runtime/codex/rateLimit.js";
import { observedTokensOf } from "../../../src/runtime/types.js";
import { codexFixture } from "./fixture.js";

// Spec docs/superpowers/specs/2026-10-13-codex-rate-limit-backoff-design.md (Orca session 7f37d261). Additive only:
// no existing criterion is changed (ccloop Rule 15).
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const settle = (promise: Promise<unknown>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
// The tester's real stdout, verbatim (Orca orca_archived_files/recommendations-1-events.jsonl).
const SAMPLE = [
  '{"type":"thread.started","thread_id":"01a13431-3db4-73a1-afd1-154f0477282d"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"exceeded retry limit, last status: 429 Too Many Requests"}',
  '{"type":"turn.failed","error":{"message":"exceeded retry limit, last status: 429 Too Many Requests"}}',
];
const DELAYS = [40, 80, 120];

async function adapter(mode: string, options: { delays?: number[]; timeoutMs?: number } = {}) {
  const f = await codexFixture(mode);
  dirs.push(f.dir);
  if (options.timeoutMs !== undefined) f.config.timeoutMs = options.timeoutMs;
  const a = new CodexAdapter(parseCodexConfig(f.config), undefined, undefined, { rateLimitDelaysMs: options.delays ?? DELAYS });
  return { ...f, a, calls: async () => (await readFile(f.marker + ".argv", "utf8")).trim().split("\n").length,
    callDirs: async () => (await readdir(join(f.runDir, "codex", "1", "plan"))).sort() };
}

describe("classifyRateLimit", () => {
  it("names a 429 before any item, after an item, and nothing else", () => {
    expect(classifyRateLimit(SAMPLE.join("\n") + "\n")).toBe("before-work");
    expect(classifyRateLimit([SAMPLE[0], SAMPLE[1], '{"type":"item.started","item":{"id":"i"}}', SAMPLE[2], SAMPLE[3]].join("\n"))).toBe("after-work");
    expect(classifyRateLimit([...SAMPLE, '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'].join("\n"))).toBeNull();
    expect(classifyRateLimit(SAMPLE.map(line => line.replaceAll("429 Too Many Requests", "500 Internal Server Error")).join("\n"))).toBeNull();
    expect(classifyRateLimit([...SAMPLE, "not json"].join("\n"))).toBe("after-work");
    expect(classifyRateLimit(SAMPLE.filter(line => !line.includes("turn.started")).join("\n"))).toBe("after-work");
    expect(classifyRateLimit([SAMPLE[0], SAMPLE[1], SAMPLE[3]].join("\n"))).toBe("before-work");
    expect(classifyRateLimit([SAMPLE[0], SAMPLE[1], SAMPLE[2]].join("\n"))).toBe("before-work");
    expect(classifyRateLimit("")).toBeNull();
  });
});

describe("a codex phase rejected by 429 before any work backs off inside the phase", () => {
  it("retries once and returns the success; the rejected call keeps its evidence", async () => {
    const f = await adapter("rate-limit-1");
    const out = await settle(f.a.plan(f.context));
    expect(out).toHaveProperty("value");
    expect(await f.calls()).toBe(2);
    // mkdtemp names the call directories at random, so they are told apart by their contents, not their order.
    const records = await Promise.all((await f.callDirs()).map(dir => readFile(join(f.runDir, "codex", "1", "plan", dir, "rate-limit.json"), "utf8").then(JSON.parse, () => null)));
    expect(records.filter(record => record === null)).toHaveLength(1);
    expect(records.filter(record => record !== null)).toEqual([{ classification: "before-work", call: 1, nextDelayMs: 40 }]);
  });

  it("gives up after the bounded retries as codex-rate-limited, booking 0", async () => {
    const f = await adapter("rate-limit-all");
    const out = await settle(f.a.plan(f.context)) as { error: Error };
    expect(String(out.error.message)).toMatch(/^codex-rate-limited: /);
    expect(observedTokensOf(out.error)).toBe(0);
    expect(await f.calls()).toBe(4);
    const records = await Promise.all((await f.callDirs()).map(async dir => JSON.parse(await readFile(join(f.runDir, "codex", "1", "plan", dir, "rate-limit.json"), "utf8"))));
    expect(records.sort((a, b) => a.call - b.call)).toEqual([40, 80, 120, null].map((nextDelayMs, i) => ({ classification: "before-work", call: i + 1, nextDelayMs })));
  });

  it("treats a zero-exit replay with no final message as the same rejection", async () => {
    const f = await adapter("rate-limit-all-exit0", { delays: [10] });
    const out = await settle(f.a.verify(f.context)) as { error: Error };
    expect(String(out.error.message)).toMatch(/^codex-rate-limited: /);
    expect(observedTokensOf(out.error)).toBe(0);
    expect(await f.calls()).toBe(2);
  });

  it("does not retry a 429 after an item and keeps its usage unknown", async () => {
    const f = await adapter("rate-limit-after-item");
    const out = await settle(f.a.plan(f.context)) as { error: Error };
    expect(String(out.error.message)).toMatch(/^codex-rate-limited: /);
    expect(observedTokensOf(out.error)).toBeNull();
    expect(await f.calls()).toBe(1);
  });

  it("an abort during the wait ends the phase without waiting out the delay", async () => {
    const f = await adapter("rate-limit-all", { delays: [3_000] });
    const controller = new AbortController();
    const started = Date.now();
    const pending = settle(f.a.plan({ ...f.context, abortSignal: controller.signal }));
    await expect.poll(async () => { try { return (await f.callDirs()).length; } catch { return 0; } }, { timeout: 5_000 }).toBe(1);
    await expect.poll(async () => { try { return JSON.parse(await readFile(join(f.runDir, "codex", "1", "plan", (await f.callDirs())[0]!, "rate-limit.json"), "utf8")).nextDelayMs; } catch { return undefined; } }, { timeout: 5_000 }).toBe(3_000);
    controller.abort();
    const out = await pending as { error: unknown };
    expect(out.error).toBeInstanceOf(CodexPhaseAborted);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await f.calls()).toBe(1);
  }, 20_000);

  it("does not classify a phase that timed out, even with 429 rows in its stdout", async () => {
    const f = await adapter("rate-limit-hang", { timeoutMs: 1_000 });
    const out = await settle(f.a.plan(f.context)) as { error: Error };
    expect(String(out.error.message)).toMatch(/^codex-timeout: /);
    expect(await f.calls()).toBe(1);
  });

  it("gives a retried call only the time the phase has left", async () => {
    // First call rejected, the retry hangs: it must time out at the phase's remaining time (10 s minus the 6 s wait),
    // about 10 s in, not after a fresh 10 s (about 16 s). The 13 s bound leaves 3 s each way for a loaded machine.
    const f = await adapter("rate-limit-1-hang", { delays: [6_000], timeoutMs: 60_000 });
    const context = { ...f.context, state: { ...f.context.state, budgetSnapshot: { ...f.context.state.budgetSnapshot, timeRemainingMs: 10_000 } } };
    const started = Date.now();
    const out = await settle(f.a.plan(context)) as { error: Error };
    const elapsed = Date.now() - started;
    expect(String(out.error.message)).toMatch(/^codex-timeout: /);
    expect(await f.calls()).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(9_500);
    expect(elapsed).toBeLessThan(13_000);
  }, 40_000);

  it("stops retrying when the next wait would pass the phase's time limit", async () => {
    const f = await adapter("rate-limit-all", { delays: [5_000], timeoutMs: 3_000 });
    const started = Date.now();
    const out = await settle(f.a.plan(f.context)) as { error: Error };
    expect(String(out.error.message)).toMatch(/^codex-rate-limited: /);
    expect(observedTokensOf(out.error)).toBe(0);
    expect(await f.calls()).toBe(1);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
