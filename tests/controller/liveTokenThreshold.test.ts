// Live token threshold (ccloop issue #225; spec docs/superpowers/specs/2026-11-10-live-token-threshold-design.md). Human
// ruling R4 (Orca session, 2026-11-10): budgets are soft and no hard cap is promised, but where an adapter can stop a phase
// mid-call it should. claude and omp report usage as they stream, so runLoop stops their phase once its observed total
// passes ceil(remaining-before-phase x 1.2); the run ends exhausted (budget) with the observed lower bound booked. Codex
// reports usage only on turn.completed, so it is never stopped mid-phase. A run with no token ceiling is never stopped, a
// phase that stays under the threshold completes unchanged, and a run that can park on its allowance still parks.
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { canonicalJson } from "../../src/control/protocol.js";
import { runLoop } from "../../src/controller/runLoop.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { buildExecutorPrompt } from "../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../src/runtime/codex/protocol.js";
import { OmpAdapter } from "../../src/runtime/omp/ompAdapter.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { dispose, FAKE_CLAUDE, ompInstallation, RAW_CONTRACT, world, type CaptureModules, type World } from "../fixtures/toolRules/argvCapture.js";
import { codexFixture } from "../runtime/codex/fixture.js";
import { createContract, createRepo } from "./optionalFixture.js";

const BUDGET_EXHAUSTED_REASON = "runtime or token budget exhausted";
const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
const cleanups: string[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await dispose(w);
  for (const dir of cleanups.splice(0)) await dispose({ dir } as World);
});

type Settled = { phase: string; tokenUsage: number | null; completedWithResult: boolean };

/** A world whose contract has `tokenBudget` and one required check the fakes satisfy (answer.txt exists). */
async function budgetWorld(tokenBudget: number | null) {
  const w = await world(m); worlds.push(w);
  const contract = loopContractSchema.parse({ ...RAW_CONTRACT, context: { ...RAW_CONTRACT.context, repoPath: w.repo },
    executionPolicy: { ...RAW_CONTRACT.executionPolicy, tokenBudget },
    verification: { ...RAW_CONTRACT.verification, requiredChecks: ["test -f answer.txt"] } });
  return { w, contract };
}

async function run(w: World, contract: unknown, adapter: RuntimeAdapter) {
  const settled: Settled[] = [];
  const state = await runLoop(contract as never, w.runDir, adapter, { onPhaseSettled: async (e) => { settled.push({ phase: e.phase, tokenUsage: e.tokenUsage, completedWithResult: e.completedWithResult }); } });
  return { state, settled, stream: await readFile(`${w.marker}.usage-stream`, "utf8").then((text) => text.trim().split("\n"), () => [] as string[]) };
}

async function onlyCall(root: string): Promise<string> {
  const calls = (await readdir(root)).filter((name) => name.startsWith("call-"));
  expect(calls).toHaveLength(1);
  return join(root, calls[0]!);
}

/** What ccloop read from the omp call: the summed usage of every complete assistant message_end in its events.jsonl. */
async function ompEventTokens(callDir: string): Promise<number> {
  let total = 0;
  for (const line of (await readFile(join(callDir, "events.jsonl"), "utf8")).split("\n")) {
    let row: { type?: string; message?: { role?: string; usage?: { totalTokens?: number } } };
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "message_end" && row.message?.role === "assistant") total += row.message.usage?.totalTokens ?? 0;
  }
  return total;
}

function claudeAdapter(w: World): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter({ schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, FAKE_CLAUDE, "usage-stream", w.marker, "--strict-mcp-config", "--disable-slash-commands"], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } } as never);
}

describe("a phase whose live usage passes ceil(remaining x 1.2) is stopped mid-call", () => {
  it("omp execute: the fake is killed before it finishes, and the run ends exhausted with the observed tokens booked", async () => {
    // Plan spends the fake's 14 tokens, so execute starts with 986 remaining: threshold ceil(986 x 1.2) = 1184. The fake
    // would print 40 messages of 500 tokens (20,000) over about 4 s; the third one already passes the threshold.
    const { w, contract } = await budgetWorld(1000);
    await writeFile(`${w.marker}.usage-stream.json`, JSON.stringify({ phase: "execute", messages: 40, tokens: 500, intervalMs: 100 }));
    const { state, settled, stream } = await run(w, contract, new OmpAdapter(await ompInstallation(w) as never));
    expect(stream).toContain("terminated");
    expect(stream).not.toContain("done");
    expect(stream.filter((line) => /^\d+$/.test(line)).length).toBeLessThan(40);
    expect(state.status).toBe("exhausted");
    expect(state.stopReason).toBe(BUDGET_EXHAUSTED_REASON);
    expect(state.failureCause).toMatchObject({ cause: "budget-exhausted" });
    expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(0);
    expect((await readFile(`${w.marker}.calls`, "utf8")).trim().split("\n")).toEqual(["plan", "execute"]);
    // Booked: exactly what ccloop observed (a lower bound), past the threshold and short of the whole stream.
    const execute = settled.find((e) => e.phase === "execute")!;
    expect(settled.find((e) => e.phase === "plan")!.tokenUsage).toBe(14);
    expect(execute.completedWithResult).toBe(false);
    const call = await onlyCall(join(w.runDir, "omp", "1", "execute"));
    expect(execute.tokenUsage).toBe(await ompEventTokens(call));
    expect(execute.tokenUsage).toBeGreaterThan(1184);
    expect(execute.tokenUsage).toBeLessThan(40 * 500);
    // Booked, so not also left as a floor: usage-lower-bound.json (collect's usageLowerBound) counts only unbooked calls.
    expect(existsSync(join(call, "usage-lower-bound.json"))).toBe(false);
  }, 60_000);

  it("claude execute (via its runner): the fake is killed before it finishes, and the run ends exhausted with the observed tokens booked", async () => {
    const { w, contract } = await budgetWorld(5000);
    await writeFile(`${w.marker}.usage-stream.json`, JSON.stringify({ phase: "execute", messages: 40, tokens: 2000, intervalMs: 100 }));
    const { state, settled, stream } = await run(w, contract, claudeAdapter(w));
    const plan = settled.find((e) => e.phase === "plan")!;
    const threshold = Math.ceil((5000 - plan.tokenUsage!) * 1.2);
    expect(stream).toContain("terminated");
    expect(stream).not.toContain("done");
    expect(state.status).toBe("exhausted");
    expect(state.stopReason).toBe(BUDGET_EXHAUSTED_REASON);
    expect(state.failureCause).toMatchObject({ cause: "budget-exhausted" });
    expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(0);
    expect((await readFile(`${w.marker}.calls`, "utf8")).trim().split("\n")).toEqual(["plan", "execute"]);
    // Booked: the runner's own observation of what claude streamed before the stop (a lower bound).
    const execute = settled.find((e) => e.phase === "execute")!;
    const observed = JSON.parse(await readFile(join(await onlyCall(join(w.runDir, "claude", "1", "execute")), "observed-usage.json"), "utf8")) as { total: number };
    expect(execute.tokenUsage).toBe(observed.total);
    expect(execute.tokenUsage).toBeGreaterThan(threshold);
    expect(execute.tokenUsage).toBeLessThan(40 * 2000);
  }, 60_000);
});

describe("a phase the live threshold does not stop", () => {
  it("codex is never stopped mid-phase: its usage arrives only with turn.completed, so verify completes and the run succeeds", async () => {
    // high-usage spends 40,000 per phase. Verify starts with 100,000 - 80,000 = 20,000 remaining (threshold 24,000) and
    // spends 40,000: past the threshold, but codex reports it only as the turn completes.
    const f = await codexFixture("high-usage"); cleanups.push(f.dir);
    const contract = loopContractSchema.parse({ ...f.contract, executionPolicy: { ...f.contract.executionPolicy, tokenBudget: 100_000 } });
    const settled: Settled[] = [];
    const state = await runLoop(contract, f.runDir, new CodexAdapter(parseCodexConfig(f.config)), { onPhaseSettled: async (e) => { settled.push({ phase: e.phase, tokenUsage: e.tokenUsage, completedWithResult: e.completedWithResult }); } });
    expect(settled).toEqual([
      { phase: "plan", tokenUsage: 40_000, completedWithResult: true },
      { phase: "execute", tokenUsage: 40_000, completedWithResult: true },
      { phase: "verify", tokenUsage: 40_000, completedWithResult: true },
    ]);
    expect(state.status).toBe("succeeded");
    expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(0);
  }, 60_000);

  it("a run with no token ceiling: an omp verify streaming any amount completes and the run succeeds", async () => {
    const { w, contract } = await budgetWorld(null);
    await writeFile(`${w.marker}.usage-stream.json`, JSON.stringify({ phase: "verify", messages: 4, tokens: 280, intervalMs: 20 }));
    const { state, settled, stream } = await run(w, contract, new OmpAdapter(await ompInstallation(w) as never));
    expect(stream).toEqual(["0", "1", "2", "3", "done"]);
    expect(settled).toEqual([
      { phase: "plan", tokenUsage: 14, completedWithResult: true },
      { phase: "execute", tokenUsage: 14, completedWithResult: true },
      { phase: "verify", tokenUsage: 4 * 280 + 14, completedWithResult: true },
    ]);
    expect(state.status).toBe("succeeded");
    expect(state.budgetSnapshot.tokenBudgetRemaining).toBeNull();
  }, 60_000);

  it("a phase over its remainder but under the threshold: the omp verify completes unchanged and the run succeeds", async () => {
    // Plan and execute spend 14 each, so verify starts with exactly 1,000 remaining: threshold 1,200. It spends
    // 4 x 280 + 14 = 1,134 -- past the remainder, under the threshold.
    const { w, contract } = await budgetWorld(1028);
    await writeFile(`${w.marker}.usage-stream.json`, JSON.stringify({ phase: "verify", messages: 4, tokens: 280, intervalMs: 20 }));
    const { state, settled, stream } = await run(w, contract, new OmpAdapter(await ompInstallation(w) as never));
    expect(stream).toEqual(["0", "1", "2", "3", "done"]);
    expect(settled).toEqual([
      { phase: "plan", tokenUsage: 14, completedWithResult: true },
      { phase: "execute", tokenUsage: 14, completedWithResult: true },
      { phase: "verify", tokenUsage: 1134, completedWithResult: true },
    ]);
    expect(state.status).toBe("succeeded");
    expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(0);
  }, 60_000);

  it("a run that can park on its allowance (spend-cap) is not stopped: its plan completes and the run parks as before", async () => {
    // The allowance flow (blocked_waiting_human, token-allowance) waits for a person to renew and continues from the next
    // phase with the paid phase's evidence; stopping the phase would end that run exhausted instead.
    const repo = await createRepo(); cleanups.push(repo);
    const settled: Settled[] = [];
    const plan = { summary: "plan", primaryTargetPaths: [], tokenUsage: 50 };
    const adapter: RuntimeAdapter = {
      plan: async (context) => {
        context.onObservedUsage?.(50);
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (context.abortSignal?.aborted) throw Object.assign(new Error("plan aborted"), { observedTokens: 50 });
        return plan;
      },
      execute: async () => { throw new Error("execute must not run"); },
      verify: async () => { throw new Error("verify must not run"); },
    };
    const state = await runLoop(createContract(repo, ["true"], null), join(repo, "..", `${repo.split("/").at(-1)}-run`), adapter, {
      workGrant: { tokens: 10, activeMs: 10_000, attempts: 3, sessions: 1 },
      tokenPolicy: { authoredTokenCeiling: null, bindingCauses: ["spend-cap"], inheritedUsage: { tokens: 0, activeMs: 0, attempts: 0, sessions: 0 } },
      onPhaseSettled: async (e) => { settled.push({ phase: e.phase, tokenUsage: e.tokenUsage, completedWithResult: e.completedWithResult }); },
    });
    cleanups.push(join(repo, "..", `${repo.split("/").at(-1)}-run`));
    expect(settled).toEqual([{ phase: "plan", tokenUsage: 50, completedWithResult: true }]);
    expect(state).toMatchObject({ status: "blocked_waiting_human", waitingCause: "token-allowance", allowanceNextPhase: "execute" });
  }, 30_000);
});
