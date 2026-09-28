import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../src/runtime/codex/protocol.js";
import { observedTokensOf } from "../../src/runtime/types.js";
import { codexFixture } from "./codex/fixture.js";

// Orca ruling 26 (Orca ledger 2026-09-27-single-call-estimate §3.21; session c85d2c4e, 2026-09-28): a loop phase that
// times out -- the installation's timeoutMs or the run's remaining time -- used to throw a bare error, so runLoop booked
// its usage as unknown even when the agent had been seen spending tokens. Both adapters now carry that observation on the
// error, as they already did for an aborted phase; none observed stays null, never 0. Additive only (ccloop Rule 15).
const fakeClaude = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));
const dirs: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const settle = (promise: Promise<unknown>) => promise.then(() => { throw new Error("the phase did not fail"); }, (error: unknown) => error);

async function claude(mode: "usage-then-hang" | "hang") {
  const f = await codexFixture("unused");
  dirs.push(f.dir);
  const marker = join(f.dir, "claude-marker.json");
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, fakeClaude, mode, marker], version: "9.9.9-fake", configDir: null, timeoutMs: 3_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
  };
  const remember = async () => { try { pids.push(JSON.parse(await readFile(marker, "utf8")).pid as number); } catch {} };
  return { adapter: new ClaudeAgentAdapter(config), context: { ...f.context, plan: { summary: "p", primaryTargetPaths: ["answer.txt"] } }, remember };
}

async function codex(usageBeforeDelay: boolean) {
  const f = await codexFixture("script");
  dirs.push(f.dir);
  const scriptPath = join(f.dir, "script.json");
  await writeFile(scriptPath, JSON.stringify({ "codex-test": { files: { "answer.txt": "42\n" }, delayMs: { plan: 10_000, execute: 10_000, verify: 10_000 }, usageBeforeDelay } }));
  f.config.command.push(scriptPath);
  f.config.timeoutMs = 2_000;
  return { adapter: new CodexAdapter(parseCodexConfig(f.config)), context: { ...f.context, plan: { summary: "p", primaryTargetPaths: ["answer.txt"] } } };
}

describe("a loop phase that times out books what the agent was seen spending (ruling 26)", () => {
  it("claude: plan, execute and verify time out carrying the streamed usage", async () => {
    for (const phase of ["plan", "execute", "verify"] as const) {
      const c = await claude("usage-then-hang");
      const error = await settle(c.adapter[phase](c.context));
      await c.remember();
      expect(String((error as Error).message), phase).toMatch(/^claude-timeout: /);
      expect(observedTokensOf(error), phase).toBe(1109);
    }
  }, 60_000);

  it("claude: a phase that timed out before streaming anything reports no usage, not zero", async () => {
    const c = await claude("hang");
    const error = await settle(c.adapter.plan(c.context));
    await c.remember();
    expect(String((error as Error).message)).toMatch(/^claude-timeout: /);
    expect((error as { observedTokens?: unknown }).observedTokens).toBeNull();
  }, 30_000);

  it("codex: plan, execute and verify time out carrying the last turn's usage", async () => {
    for (const phase of ["plan", "execute", "verify"] as const) {
      const c = await codex(true);
      const error = await settle(c.adapter[phase](c.context));
      expect(String((error as Error).message), phase).toMatch(/^codex-timeout: /);
      expect(observedTokensOf(error), phase).toBe(15);
    }
  }, 60_000);

  it("codex: a phase that timed out before any turn completed reports no usage, not zero", async () => {
    const c = await codex(false);
    const error = await settle(c.adapter.plan(c.context));
    expect(String((error as Error).message)).toMatch(/^codex-timeout: /);
    expect((error as { observedTokens?: unknown }).observedTokens).toBeNull();
  }, 30_000);
});
