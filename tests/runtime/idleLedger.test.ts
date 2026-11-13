import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../src/runtime/codex/protocol.js";
import { IDLE_CHARGE_LIMIT_MS, IdleLedger, IdleWatch } from "../../src/runtime/idleWatch.js";
import { codexFixture } from "./codex/fixture.js";

// Working time (Orca issue #262; human, Orca session d467cbd2, 2026-11-13: 「时间预算只算真正在干活的时间」). A network stall of
// ~600 s was charged in full against the run's time budget, so one stall could spend the budget. The ledger records, inside a
// watched agent process, the part of each silence (no tool open) beyond the limit; runLoop leaves it out of the phase's
// charge. Too little idle and a stall burns the budget again; too much and real work (a long model turn, a silent test run
// inside an open tool, ccloop's own work between processes) goes uncharged -- both directions are pinned here.
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A clock the test moves by hand: only Date is faked, so nothing else in the process changes. */
function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  return (ms: number) => vi.setSystemTime(Date.now() + ms);
}

describe("IdleLedger: what is idle", () => {
  it("the limit is two minutes", () => {
    expect(IDLE_CHARGE_LIMIT_MS).toBe(120_000);
  });

  it("a silence of exactly the limit is working time; one millisecond more is one millisecond idle", () => {
    const advance = clock();
    const ledger = new IdleLedger(1_000);
    ledger.start();
    advance(1_000);
    ledger.mark(0);
    expect(ledger.idleMs()).toBe(0);
    advance(1_001);
    ledger.mark(0);
    expect(ledger.idleMs()).toBe(1);
  });

  it("each gap counts on its own: many short gaps are working time, a long one only beyond the limit", () => {
    const advance = clock();
    const ledger = new IdleLedger(1_000);
    ledger.start();
    for (let i = 0; i < 10; i++) { advance(900); ledger.mark(0); }
    expect(ledger.idleMs()).toBe(0);
    advance(5_000);
    ledger.mark(0);
    expect(ledger.idleMs()).toBe(4_000);
  });

  it("the current gap of an open window counts before the next observation (a stall still in progress)", () => {
    const advance = clock();
    const ledger = new IdleLedger(1_000);
    ledger.start();
    advance(3_000);
    expect(ledger.idleMs()).toBe(2_000);
  });

  it("a silence with a tool open is working time (a test suite prints nothing while it runs)", () => {
    const advance = clock();
    const ledger = new IdleLedger(1_000);
    ledger.start();
    ledger.mark(1);
    advance(10_000);
    ledger.mark(0);
    expect(ledger.idleMs()).toBe(0);
  });

  it("time outside every window is ccloop's own work, never idle", () => {
    const advance = clock();
    const ledger = new IdleLedger(1_000);
    advance(10_000);
    ledger.mark(0);
    expect(ledger.idleMs()).toBe(0);
    ledger.start();
    ledger.stop();
    advance(10_000);
    ledger.mark(0);
    expect(ledger.idleMs()).toBe(0);
  });

  it("IdleWatch reports its process's start, activity, tool changes and stop to the ledger", () => {
    const advance = clock();
    const ledger = new IdleLedger(1_000);
    const watch = new IdleWatch(null, () => undefined, ledger);
    watch.start();
    advance(3_000);
    watch.activity();
    expect(ledger.idleMs()).toBe(2_000);
    watch.toolStarted("t");
    advance(5_000);
    watch.toolEnded("t");
    expect(ledger.idleMs()).toBe(2_000);
    watch.stop();
    advance(5_000);
    expect(ledger.idleMs()).toBe(2_000);
  });
});

const line = { type: "thread.started", thread_id: "t" };
describe("the adapters hand the phase's ledger to their watchdog", () => {
  it("codex: a 1.5 s silence inside the call is recorded beyond a 0.3 s limit", async () => {
    const f = await codexFixture("idle-script");
    dirs.push(f.dir);
    await writeFile(`${f.marker}.idle-script.json`, JSON.stringify({ steps: [{ delayMs: 0, stdout: line }, { delayMs: 1_500, stdout: line }], end: "answer" }));
    const a = new CodexAdapter(parseCodexConfig({ ...f.config, timeoutMs: 15_000, idleTimeoutMs: 10_000 }), undefined, undefined, { rateLimitDelaysMs: [] });
    const idleLedger = new IdleLedger(300);
    await a.plan({ ...f.context, idleLedger });
    expect(idleLedger.idleMs()).toBeGreaterThanOrEqual(1_000);
    expect(idleLedger.idleMs()).toBeLessThan(1_500);
  }, 30_000);

  it("claude: a 2.5 s silence between the runner's fd-4 lines is recorded beyond a 0.3 s limit", async () => {
    const fakeCli = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));
    const f = await codexFixture("unused");
    dirs.push(f.dir);
    const marker = join(f.dir, "claude-marker.json");
    const chatter = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "." } } };
    await writeFile(`${marker}.idle-script.json`, JSON.stringify({ steps: [{ delayMs: 0, event: chatter }, { delayMs: 2_500, event: chatter }], end: "answer" }));
    const config: MaterializedAgentConfigV1 = {
      schema: "ccloop-agent-config-v1", kind: "claude",
      installation: { kind: "claude", command: [process.execPath, fakeCli, "idle-script", marker], version: "9.9.9-fake", configDir: null, timeoutMs: 15_000, killGraceMs: 300, idleTimeoutMs: 10_000 },
      selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
    };
    const contract = { ...f.context.contract, executionPolicy: { ...f.context.contract.executionPolicy, perAttemptTimeoutMs: 15_000 } };
    const idleLedger = new IdleLedger(300);
    await new ClaudeAgentAdapter(config, { retryDelaysMs: [] }).plan({ ...f.context, contract, idleLedger });
    // The runner reports at most once a second while nothing changes, so the gap seen is between 2.5 s and 3.5 s.
    expect(idleLedger.idleMs()).toBeGreaterThanOrEqual(1_700);
    expect(idleLedger.idleMs()).toBeLessThan(3_500);
  }, 30_000);
});
