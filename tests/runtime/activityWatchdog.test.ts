import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { agentConfigHash } from "../../src/agents/materialize.js";
import { parseAgentsTable } from "../../src/agents/table.js";
import type { InstallationV1, MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../src/runtime/codex/protocol.js";
import { attachedCause } from "../../src/runtime/failureCause.js";
import { effectiveIdleTimeoutMs } from "../../src/runtime/idleWatch.js";
import { codexFixture } from "./codex/fixture.js";

// Activity watchdog (ccloop spec docs/superpowers/specs/2026-10-21-activity-watchdog-design.md). Human ruling: the wall clock
// stays the ceiling; a phase that shows no activity for the installation's idle limit is stopped as `stalled`, a transient
// cause the failure-cause retry loop may retry. A watchdog that misses activity kills healthy work; one that never fires
// leaves a hung agent to a 2 h wall clock -- so both directions are pinned here.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const settle = (promise: Promise<unknown>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
const codex: InstallationV1 = { kind: "codex", command: ["/opt/codex"], version: "0.163.0", configDir: null, timeoutMs: 300_000, killGraceMs: 5_000, sandbox: "workspace-write", budgetMode: "soft" };
const tableOf = (installation: unknown) => ({ schema: "ccloop-agents-table-v1", installations: { a: installation } });

describe("tests 1-2: the table field", () => {
  it("absent => min(10 min, timeoutMs); null => off; a number is used", () => {
    expect(effectiveIdleTimeoutMs(parseAgentsTable(tableOf(codex)).installations.a!)).toBe(300_000);
    expect(effectiveIdleTimeoutMs({ timeoutMs: 7_200_000 })).toBe(600_000);
    expect(effectiveIdleTimeoutMs(parseAgentsTable(tableOf({ ...codex, idleTimeoutMs: null })).installations.a!)).toBeNull();
    expect(effectiveIdleTimeoutMs(parseAgentsTable(tableOf({ ...codex, idleTimeoutMs: 1_000 })).installations.a!)).toBe(1_000);
  });
  it.each([0, -1, 1.5, 300_001])("refuses %s (including above timeoutMs)", (idleTimeoutMs) => {
    expect(() => parseAgentsTable(tableOf({ ...codex, idleTimeoutMs }))).toThrow(expect.objectContaining({ code: "agents-table-invalid" }));
  });
  it("is not part of configHash", () => {
    const config = (installation: InstallationV1): MaterializedAgentConfigV1 => ({ schema: "ccloop-agent-config-v1", kind: "codex", installation, selection: { agent: "a", model: "gpt-6-sol", contextWindow: "agent-default" } });
    expect(agentConfigHash(config({ ...codex, idleTimeoutMs: 1_000 }))).toBe(agentConfigHash(config(codex)));
  });
});

async function codexWith(script: object, idleTimeoutMs = 400) {
  const f = await codexFixture("idle-script");
  dirs.push(f.dir);
  await writeFile(`${f.marker}.idle-script.json`, JSON.stringify(script));
  const a = new CodexAdapter(parseCodexConfig({ ...f.config, timeoutMs: 15_000, idleTimeoutMs }), undefined, undefined, { rateLimitDelaysMs: [] });
  const contract = { ...f.context.contract, executionPolicy: { ...f.context.contract.executionPolicy, perAttemptTimeoutMs: 15_000 } };
  const outcomes = async (phase: string) => Promise.all((await readdir(join(f.runDir, "codex", "1", phase))).map(async (dir) => JSON.parse(await readFile(join(f.runDir, "codex", "1", phase, dir, "outcome.json"), "utf8"))));
  return { ...f, a, context: { ...f.context, contract }, outcomes };
}
const line = { type: "thread.started", thread_id: "t" };
const toolStart = { type: "item.started", item: { id: "tool_1", type: "command_execution", command: "npm test" } };
const toolEnd = { type: "item.completed", item: { id: "tool_1", type: "command_execution", command: "npm test", exit_code: 0 } };

describe("tests 3-5: codex", () => {
  it("test 3: one line then silence => stalled well before the wall clock, with the idle record", async () => {
    const f = await codexWith({ steps: [{ delayMs: 0, stdout: line }], end: "hang" });
    const started = Date.now();
    const out = await settle(f.a.plan(f.context)) as { error: Error };
    expect(String(out.error.message)).toMatch(/^codex-stalled: /);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(attachedCause(out.error)?.classification.cause).toBe("stalled");
    const [outcome] = await f.outcomes("plan");
    expect(outcome.reason).toBe("stalled");
    expect(outcome.idle).toMatchObject({ limitMs: 400, openTools: 0 });
  }, 30_000);

  it("test 4: stderr activity every 0.3 x idle for 3 x idle keeps the phase alive", async () => {
    const f = await codexWith({ steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => ({ delayMs: 120, stderr: "working" })), end: "answer" });
    expect(await settle(f.a.plan(f.context))).toHaveProperty("value");
  }, 30_000);

  it("test 5a: an open tool suspends the clock (2 x idle of silence, then the tool ends)", async () => {
    const f = await codexWith({ steps: [{ delayMs: 0, stdout: toolStart }, { delayMs: 800, stdout: toolEnd }], end: "answer" });
    expect(await settle(f.a.plan(f.context))).toHaveProperty("value");
  }, 30_000);

  it("test 5b: a tool open and silent is still stopped after 3 x idle, not at the wall clock", async () => {
    const f = await codexWith({ steps: [{ delayMs: 0, stdout: toolStart }], end: "hang" });
    const started = Date.now();
    const out = await settle(f.a.plan(f.context)) as { error: Error };
    const elapsed = Date.now() - started;
    expect(String(out.error.message)).toMatch(/^codex-stalled: /);
    expect(elapsed).toBeGreaterThanOrEqual(1_150);
    expect(elapsed).toBeLessThan(8_000);
  }, 30_000);
});

const fakeCli = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));
async function claudeWith(script: object, idleTimeoutMs = 600) {
  const f = await codexFixture("unused");
  dirs.push(f.dir);
  const marker = join(f.dir, "claude-marker.json");
  await writeFile(`${marker}.idle-script.json`, JSON.stringify(script));
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, fakeCli, "idle-script", marker], version: "9.9.9-fake", configDir: null, timeoutMs: 15_000, killGraceMs: 300, idleTimeoutMs },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
  };
  const contract = { ...f.context.contract, executionPolicy: { ...f.context.contract.executionPolicy, perAttemptTimeoutMs: 15_000, partialOutcomeRecoveryWindowMs: 300 } };
  return { ...f, a: new ClaudeAgentAdapter(config, { retryDelaysMs: [] }), context: { ...f.context, contract }, marker };
}
const chatter = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "." } } };

describe("tests 6-8: claude through the runner's fd-4 activity lines", () => {
  // The runner reports at most once a second while the open-tool count is unchanged (spec §2.2), so the idle limit here is
  // above that throttle: 1.5 s, with a chunk every 0.5 x idle for 3 x idle.
  it("test 6: a claude that keeps streaming (each gap 0.5 x idle) is not stopped", async () => {
    const f = await claudeWith({ steps: [0, 1, 2, 3, 4, 5].map(() => ({ delayMs: 750, event: chatter })), end: "answer" }, 1_500);
    expect(await settle(f.a.plan(f.context))).toHaveProperty("value");
  }, 30_000);

  it("test 6: an open tool (tool_use without its tool_result) suspends the clock up to 3 x idle", async () => {
    const toolUse = { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "npm test" } }] } };
    const toolResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "ok" }] } };
    const f = await claudeWith({ steps: [{ delayMs: 0, event: toolUse }, { delayMs: 1_200, event: toolResult }], end: "answer" });
    expect(await settle(f.a.plan(f.context))).toHaveProperty("value");
  }, 30_000);

  it("test 7: an execute that wrote a file and went silent comes back as the runner's partial, marked stalled", async () => {
    const f = await claudeWith({ steps: [{ delayMs: 0, writeFile: "answer.txt" }], end: "hang" });
    const out = await settle(f.a.execute(f.context)) as { value: { completionStatus?: string; failureMessage?: string } };
    expect(out.value.completionStatus).toBe("partial");
    expect(out.value.failureMessage).toMatch(/^claude-stalled: /);
    expect(attachedCause(out.value)?.classification.cause).toBe("stalled");
  }, 30_000);

  it("test 8: a silent single call throws claude-stalled once (its caller owns retries)", async () => {
    const f = await claudeWith({ steps: [], end: "hang" });
    const out = await settle(f.a.singleCall({ prompt: "p", responseSchema: { type: "object" }, maxOutputTokens: 100, cwd: f.repo, runDir: f.runDir, timeoutMs: 15_000 })) as { error: Error };
    expect(String(out.error.message)).toMatch(/^claude-stalled: /);
    expect(attachedCause(out.error)?.classification.cause).toBe("stalled");
    expect((await readFile(`${f.marker}.argv`, "utf8")).trim().split("\n")).toHaveLength(1);
  }, 30_000);
});
