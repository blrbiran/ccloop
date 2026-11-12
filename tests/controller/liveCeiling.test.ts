// Live token ceiling (Orca tester follow-up G part 2; spec docs/superpowers/specs/2026-11-12-live-ceiling-design.md). In a
// finite Orca group the group's token limit is the one hard line: a run carries no token grant of its own, only a ceiling
// Orca derives from the group's remainder and keeps current while the run runs. ccloop must stop the run when its whole
// work total reaches that ceiling -- mid-call where the adapter reports usage as it streams (claude, omp), at the next phase
// boundary where it reports usage only as a turn ends (codex) -- and must let a phase go on when Orca raises the ceiling
// while it streams (the spec's open point: no restart needed). Helpers are copied from liveTokenThreshold.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveCeiling } from "../../src/budget/liveCeiling.js";
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
import { codexFixture, exec } from "../runtime/codex/fixture.js";

const STOP_REASON = "live token ceiling reached";
const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
const cleanups: string[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await dispose(w);
  for (const dir of cleanups.splice(0)) await dispose({ dir } as World);
});

type Settled = { phase: string; tokenUsage: number | null; completedWithResult: boolean };
type Ceiling = { current(): LiveCeiling; baseTokens: number };
const group = (tokens: number, revision = 1): LiveCeiling => ({ protocol: 1, revision, tokens, cause: "group" });
const fixed = (ceiling: LiveCeiling, baseTokens = 0): Ceiling => ({ current: () => ceiling, baseTokens });

/** A world whose contract has no token budget (Orca sends a null grant with a ceiling) and one check the fakes satisfy. */
async function budgetWorld() {
  const w = await world(m); worlds.push(w);
  const contract = loopContractSchema.parse({ ...RAW_CONTRACT, context: { ...RAW_CONTRACT.context, repoPath: w.repo },
    executionPolicy: { ...RAW_CONTRACT.executionPolicy, tokenBudget: null },
    verification: { ...RAW_CONTRACT.verification, requiredChecks: ["test -f answer.txt"] } });
  return { w, contract };
}

async function run(w: World, contract: unknown, adapter: RuntimeAdapter, liveCeiling: Ceiling) {
  const settled: Settled[] = [];
  const state = await runLoop(contract as never, w.runDir, adapter, { liveCeiling, onPhaseSettled: async (e) => { settled.push({ phase: e.phase, tokenUsage: e.tokenUsage, completedWithResult: e.completedWithResult }); } });
  return { state, settled, stream: await readFile(`${w.marker}.usage-stream`, "utf8").then((text) => text.trim().split("\n"), () => [] as string[]) };
}

async function onlyCall(root: string): Promise<string> {
  const calls = (await readdir(root)).filter((name) => name.startsWith("call-"));
  expect(calls).toHaveLength(1);
  return join(root, calls[0]!);
}

function claudeAdapter(w: World): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter({ schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, FAKE_CLAUDE, "usage-stream", w.marker, "--strict-mcp-config", "--disable-slash-commands"], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } } as never);
}

const total = (settled: Settled[]): number => settled.reduce((sum, e) => sum + (e.tokenUsage ?? 0), 0);

describe("a run is stopped mid-call when its total reaches the live ceiling", () => {
  it("omp execute is stopped mid-call at a group ceiling", async () => {
    // Plan spends the fake's 14 tokens, so execute may observe 986 before the run reaches 1,000; its messages are 500 each.
    const { w, contract } = await budgetWorld();
    await writeFile(`${w.marker}.usage-stream.json`, JSON.stringify({ phase: "execute", messages: 40, tokens: 500, intervalMs: 100 }));
    const { state, settled, stream } = await run(w, contract, new OmpAdapter(await ompInstallation(w) as never), fixed(group(1_000)));
    expect(stream).toContain("terminated");
    expect(stream).not.toContain("done");
    expect(state.status).toBe("exhausted");
    expect(state.stopReason).toBe(STOP_REASON);
    expect(state.liveCeilingStop).toEqual({ revision: 1, tokens: 1_000, cause: "group", observedTokens: total(settled), phase: "execute", at: "mid-call" });
    expect((await readFile(`${w.marker}.calls`, "utf8")).trim().split("\n")).toEqual(["plan", "execute"]);
    const execute = settled.find((e) => e.phase === "execute")!;
    expect(execute.completedWithResult).toBe(false);
    expect(total(settled)).toBeGreaterThanOrEqual(1_000);
    expect(execute.tokenUsage!).toBeLessThanOrEqual(1_000 + 500);
  }, 60_000);

  it("claude execute is stopped mid-call through its runner", async () => {
    const { w, contract } = await budgetWorld();
    await writeFile(`${w.marker}.usage-stream.json`, JSON.stringify({ phase: "execute", messages: 40, tokens: 2_000, intervalMs: 100 }));
    const { state, settled, stream } = await run(w, contract, claudeAdapter(w), fixed(group(3_000)));
    expect(stream).toContain("terminated");
    expect(stream).not.toContain("done");
    expect(state.status).toBe("exhausted");
    expect(state.stopReason).toBe(STOP_REASON);
    expect(state.liveCeilingStop).toMatchObject({ cause: "group", at: "mid-call", phase: "execute", tokens: 3_000, observedTokens: total(settled) });
    expect((await readFile(`${w.marker}.calls`, "utf8")).trim().split("\n")).toEqual(["plan", "execute"]);
    const execute = settled.find((e) => e.phase === "execute")!;
    const observed = JSON.parse(await readFile(join(await onlyCall(join(w.runDir, "claude", "1", "execute")), "observed-usage.json"), "utf8")) as { total: number };
    expect(execute.tokenUsage).toBe(observed.total);
    expect(total(settled)).toBeGreaterThanOrEqual(3_000);
    expect(execute.tokenUsage!).toBeLessThan(40 * 2_000);
  }, 60_000);

  it("a resumed run counts the tokens of its earlier invocation", async () => {
    // 900 tokens were recorded before this invocation: the plan is stopped at its first 100-token message.
    const { w, contract } = await budgetWorld();
    await writeFile(`${w.marker}.usage-stream.json`, JSON.stringify({ phase: "plan", messages: 2, tokens: 100, intervalMs: 300 }));
    const { state, settled, stream } = await run(w, contract, new OmpAdapter(await ompInstallation(w) as never), fixed(group(1_000), 900));
    expect(stream).toContain("terminated");
    expect(stream).not.toContain("done");
    expect(settled).toEqual([{ phase: "plan", tokenUsage: 100, completedWithResult: false }]);
    expect(state.stopReason).toBe(STOP_REASON);
    expect(state.liveCeilingStop).toEqual({ revision: 1, tokens: 1_000, cause: "group", observedTokens: 1_000, phase: "plan", at: "mid-call" });
  }, 60_000);

  it("a ceiling-stopped execute keeps the agent's file in the attempt's commit", async () => {
    // The fake omp writes answer.txt before it streams; the stop must not lose that edit (Orca continues the task with it).
    const { w, contract } = await budgetWorld();
    await writeFile(`${w.marker}.usage-stream.json`, JSON.stringify({ phase: "execute", messages: 40, tokens: 500, intervalMs: 100 }));
    const { state } = await run(w, contract, new OmpAdapter(await ompInstallation(w) as never), fixed(group(1_000)));
    expect(state.liveCeilingStop).toMatchObject({ phase: "execute", at: "mid-call" });
    expect((await exec("git", ["show", `refs/ccloop/${basename(w.runDir)}/attempts/1:answer.txt`], { cwd: w.repo })).stdout).toBe("42\n");
  }, 60_000);
});

describe("a run is stopped at a phase boundary when its total has reached the live ceiling", () => {
  it("codex is stopped between turns, never mid-phase", async () => {
    // high-usage spends 40,000 per phase and reports it only as the turn completes: plan finishes, execute never starts.
    const f = await codexFixture("high-usage"); cleanups.push(f.dir);
    const contract = loopContractSchema.parse({ ...f.contract, executionPolicy: { ...f.contract.executionPolicy, tokenBudget: null } });
    const settled: Settled[] = [];
    const state = await runLoop(contract, f.runDir, new CodexAdapter(parseCodexConfig(f.config)), { liveCeiling: fixed(group(10_000)),
      onPhaseSettled: async (e) => { settled.push({ phase: e.phase, tokenUsage: e.tokenUsage, completedWithResult: e.completedWithResult }); } });
    expect(settled).toEqual([{ phase: "plan", tokenUsage: 40_000, completedWithResult: true }]);
    expect(state.status).toBe("exhausted");
    expect(state.stopReason).toBe(STOP_REASON);
    expect(state.liveCeilingStop).toEqual({ revision: 1, tokens: 10_000, cause: "group", observedTokens: 40_000, phase: "execute", at: "boundary" });
  }, 60_000);

  it("a run whose earlier invocations already reached the ceiling starts no phase", async () => {
    const f = await codexFixture("high-usage"); cleanups.push(f.dir);
    const contract = loopContractSchema.parse({ ...f.contract, executionPolicy: { ...f.contract.executionPolicy, tokenBudget: null } });
    const state = await runLoop(contract, f.runDir, new CodexAdapter(parseCodexConfig(f.config)), { liveCeiling: fixed(group(10_000), 10_000) });
    expect(existsSync(`${f.marker}.calls`) ? (await readFile(`${f.marker}.calls`, "utf8")).trim() : "").toBe("");
    expect(state.attemptsUsed).toBe(0);
    expect(state.liveCeilingStop).toEqual({ revision: 1, tokens: 10_000, cause: "group", observedTokens: 10_000, phase: "plan", at: "boundary" });
  }, 60_000);

  it("codex is stopped before verify once execute reached the ceiling", async () => {
    const f = await codexFixture("high-usage"); cleanups.push(f.dir);
    const contract = loopContractSchema.parse({ ...f.contract, executionPolicy: { ...f.contract.executionPolicy, tokenBudget: null } });
    const settled: Settled[] = [];
    const state = await runLoop(contract, f.runDir, new CodexAdapter(parseCodexConfig(f.config)), { liveCeiling: fixed(group(50_000)),
      onPhaseSettled: async (e) => { settled.push({ phase: e.phase, tokenUsage: e.tokenUsage, completedWithResult: e.completedWithResult }); } });
    expect(settled.map((e) => e.phase)).toEqual(["plan", "execute"]);
    expect(state.liveCeilingStop).toEqual({ revision: 1, tokens: 50_000, cause: "group", observedTokens: 80_000, phase: "verify", at: "boundary" });
  }, 60_000);
});

describe("a ceiling Orca raises while the phase streams", () => {
  it("lets the phase finish", async () => {
    // Plan and execute spend 14 each, so verify may observe 972 under revision 1; its third 400-token message passes that.
    // Orca's raise (revision 2, 10,000) is visible once the fake has printed its second message.
    const { w, contract } = await budgetWorld();
    await writeFile(`${w.marker}.usage-stream.json`, JSON.stringify({ phase: "verify", messages: 4, tokens: 400, intervalMs: 150 }));
    const raised = (): boolean => { try { return readFileSync(`${w.marker}.usage-stream`, "utf8").trim().split("\n").length >= 2; } catch { return false; } };
    const ceiling: Ceiling = { current: () => (raised() ? group(10_000, 2) : group(1_000)), baseTokens: 0 };
    const { state, settled, stream } = await run(w, contract, new OmpAdapter(await ompInstallation(w) as never), ceiling);
    expect(stream).toEqual(["0", "1", "2", "3", "done"]);
    expect(settled.map((e) => [e.phase, e.completedWithResult])).toEqual([["plan", true], ["execute", true], ["verify", true]]);
    expect(state.status).toBe("succeeded");
    expect(state.liveCeilingStop).toBeUndefined();
  }, 60_000);
});
