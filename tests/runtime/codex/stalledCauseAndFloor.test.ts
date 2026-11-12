import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../../src/controller/runLoop.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { attachedCause } from "../../../src/runtime/failureCause.js";
import { codexFixture } from "./fixture.js";

// Orca issue #262. (1) A codex execute the idle watchdog stopped, still dying when runLoop's phase timeout aborted it,
// answered null -- the stall was lost and the run booked budget-exhausted. It now throws the stall. (2) Codex left no
// usage-lower-bound.json for a call that ended without a final after reporting turn usage (only omp did), so Orca's
// approximate floor was null. Both are the producer's facts (Orca spec §5.2.8), so both are fixed here.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const settle = (promise: Promise<unknown>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));

async function codex(mode: string, overrides: object) {
  const f = await codexFixture(mode);
  dirs.push(f.dir);
  const adapter = new CodexAdapter(parseCodexConfig({ ...f.config, timeoutMs: 15_000, ...overrides }), undefined, undefined, { rateLimitDelaysMs: [] });
  const contract = { ...f.context.contract, executionPolicy: { ...f.context.contract.executionPolicy, perAttemptTimeoutMs: 15_000 } };
  const calls = async () => { const root = join(f.runDir, "codex", "1", "execute"); return (await readdir(root)).map(call => join(root, call)); };
  return { ...f, adapter, context: { ...f.context, contract }, calls };
}

describe("Orca #262 (1): an aborted codex execute whose call had already stalled", () => {
  it("throws the stall instead of answering null", async () => {
    // ignore-term: silent after its first stderr line, and it ignores SIGTERM, so the call stopped as stalled is still alive
    // (for killGraceMs) when the abort arrives -- the order the tester's run took. The idle limit is above node's start-up
    // time, so the SIGTERM handler is in place before the watchdog fires; the wall clock is far above both, so the SIGTERM
    // seen is the watchdog's and not codex's own timeout (seen under heavy load).
    const f = await codex("ignore-term", { idleTimeoutMs: 2_000, killGraceMs: 10_000, timeoutMs: 60_000 });
    const abort = new AbortController();
    const pending = settle(f.adapter.execute({ ...f.context, abortSignal: abort.signal, plan: { summary: "p", primaryTargetPaths: ["answer.txt"] } }));
    await expect.poll(async () => readFile(`${f.marker}.term`, "utf8").catch(() => ""), { timeout: 40_000 }).toContain("TERM");
    abort.abort();
    const out = await pending as { error?: Error; value?: unknown };
    // Precondition first: under heavy load the runner's 1 s `ps` identity probe can time out and stop the call as io-error
    // (classified unknown), which is not the case under test; that reads here as a precondition failure, not a pass.
    const [call] = await f.calls();
    expect(JSON.parse(await readFile(join(call!, "outcome.json"), "utf8")).reason, "precondition: the call stopped as stalled").toBe("stalled");
    expect(out).not.toHaveProperty("value");
    expect(String(out.error?.message)).toMatch(/^codex-stalled: /);
    expect(attachedCause(out.error)?.classification.cause).toBe("stalled");
  }, 90_000);
});

it("Orca #262 end to end: runLoop with the codex adapter books the stall, not budget-exhausted", async () => {
  // The idle limit (2 s) fires first; the phase timeout (6 s) aborts the call while it ignores SIGTERM; SIGKILL at about 12 s.
  const f = await codex("ignore-term", { idleTimeoutMs: 2_000, killGraceMs: 10_000, timeoutMs: 60_000 });
  const contract = { ...f.contract, executionPolicy: { ...f.contract.executionPolicy, perAttemptTimeoutMs: 6_000, totalRuntimeBudgetMs: 60_000 } };
  // Plan answered without a process: ignore-term would stall every phase, and the plan is not what this criterion is about.
  const adapter = { plan: async () => ({ summary: "p", primaryTargetPaths: ["answer.txt"] }), execute: f.adapter.execute.bind(f.adapter), verify: f.adapter.verify.bind(f.adapter) };
  const state = await runLoop(contract, f.runDir, adapter);
  expect(state.status).toBe("exhausted");
  expect(state.failureCause).toMatchObject({ cause: "stalled", phase: "execute" });
}, 90_000);

describe("Orca #262 (2): a codex call that ended without a final leaves its observed turn usage as a floor", () => {
  const usage = { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } };
  it("writes usage-lower-bound.json with the shape omp writes, from the turn usage it saw", async () => {
    const f = await codex("idle-script", { idleTimeoutMs: 300 });
    await writeFile(`${f.marker}.idle-script.json`, JSON.stringify({ steps: [{ delayMs: 0, stdout: { type: "thread.started", thread_id: "t" } }, { delayMs: 0, stdout: usage }], end: "hang" }));
    const out = await settle(f.adapter.execute({ ...f.context, plan: { summary: "p", primaryTargetPaths: ["answer.txt"] } })) as { error?: Error };
    expect(String(out.error?.message)).toMatch(/^codex-stalled: /);
    const [call] = await f.calls();
    expect(JSON.parse(await readFile(join(call!, "usage-lower-bound.json"), "utf8"))).toEqual({ tokens: 15 });
  }, 30_000);

  it("writes none when no turn usage was seen", async () => {
    const f = await codex("idle-script", { idleTimeoutMs: 300 });
    await writeFile(`${f.marker}.idle-script.json`, JSON.stringify({ steps: [{ delayMs: 0, stdout: { type: "thread.started", thread_id: "t" } }], end: "hang" }));
    const out = await settle(f.adapter.execute({ ...f.context, plan: { summary: "p", primaryTargetPaths: ["answer.txt"] } })) as { error?: Error };
    expect(String(out.error?.message)).toMatch(/^codex-stalled: /);
    const [call] = await f.calls();
    expect(existsSync(join(call!, "outcome.json"))).toBe(true);
    expect(existsSync(join(call!, "usage-lower-bound.json"))).toBe(false);
  }, 30_000);
});
