import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { codexDescriptor } from "../../../src/agents/codex.js";
import type { InstallationV1, MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { createStopRequestSignal, runLoop } from "../../../src/controller/runLoop.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { observedTokensOf } from "../../../src/runtime/types.js";
import { codexFixture } from "./fixture.js";

// Codex phase isolation (ccloop spec 2026-10-18 §3.5, human's ruling): a codex phase refused before spawn started no process
// and sent no token, so its usage is booked 0 (`neverStarted`, a named exception to "usage is never booked as 0"); setting
// up the isolation fails the same way every time, so the refusal is final -- not retried, and not turned into a handoff
// boundary -- as a codex-skills-* setup failure is today.
async function world(catalog: unknown) {
  const f = await codexFixture("integration");
  const source = join(f.dir, "source-codex-home");
  await mkdir(source); await writeFile(join(source, "auth.json"), "{}"); await writeFile(join(source, "config.toml"), "");
  const cache = await realpath(await mkdtemp(join(tmpdir(), "ccloop-phase-iso-cache-")));
  vi.stubEnv("CCLOOP_CACHE_DIR", cache);
  await writeFile(`${f.marker}.catalog.json`, JSON.stringify(catalog));
  const installation: InstallationV1 = { kind: "codex", command: f.config.command as [string, ...string[]], version: "9.9.9-fake", configDir: source,
    timeoutMs: 10_000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft" };
  const adapter = new CodexAdapter(parseCodexConfig(f.config), { CODEX_HOME: source }, undefined, { installation, rateLimitDelaysMs: [10, 10, 10] });
  const base = join(cache, "codex-home", createHash("sha256").update(`${await realpath(process.execPath)}\0${source}`).digest("hex"));
  return { ...f, source, cache, installation, adapter, base };
}
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);

afterEach(() => { vi.unstubAllEnvs(); });

it("a refused phase throws neverStarted and books 0", async () => {
  const w = await world({ mcpExitCode: 1 });
  const error = await failure(w.adapter.plan(w.context));
  expect((error as Error).message.startsWith("codex-phase-isolation-no-mcp-list: ")).toBe(true);
  expect(observedTokensOf(error)).toBe(0);
  expect((await readdir(join(w.runDir, "codex", "1", "plan"))).filter((name) => name.startsWith("call-"))).toHaveLength(1);
}, 30_000);

it("a run whose plan phase is refused fails with the refusal, books 0 and is not retried", async () => {
  const w = await world({ mcpExitCode: 1 });
  w.contract.executionPolicy.maxAttempts = 2;
  const phases: { phase: string; tokenUsage?: number | null }[] = [];
  const state = await runLoop(w.contract, w.runDir, w.adapter, { onPhaseSettled: async (observation) => { phases.push(observation as never); } });
  expect(state.status).toBe("failed");
  expect(state.stopReason).toMatch(/codex-phase-isolation-no-mcp-list: /);
  expect(phases).toEqual([expect.objectContaining({ phase: "plan", tokenUsage: 0 })]);
  expect(existsSync(`${w.marker}.argv`)).toBe(false);
}, 30_000);

it("a refusal under a handoff request still fails the run, not a handoff boundary", async () => {
  const w = await world({ sleepMs: 300, mcpExitCode: 1 });
  const stopRequested = createStopRequestSignal();
  const watcher = setInterval(() => { if (existsSync(`${w.marker}.catalog-calls`)) stopRequested.requested = true; }, 5);
  try {
    const state = await runLoop(w.contract, w.runDir, w.adapter, { stopRequested });
    expect(state.status).toBe("failed");
    expect(state.stopReason).toContain("codex-phase-isolation-no-mcp-list");
  } finally { clearInterval(watcher); }
}, 30_000);

it("the descriptor's adapter isolates codex phases", async () => {
  const w = await world({ mcp: [] });
  const materialized: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: "codex", installation: w.installation,
    selection: { agent: "codex", model: "gpt-6-sol", contextWindow: "agent-default" } };
  await codexDescriptor.createAdapter(materialized).plan(w.context);
  const env = JSON.parse(readFileSync(`${w.marker}.phase-env.json`, "utf8")) as { CODEX_HOME: string };
  expect(env.CODEX_HOME).toBe(join(w.base, "codex-home"));
  expect(env.CODEX_HOME).not.toBe(w.source);
}, 30_000);
