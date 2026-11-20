// Tester #369 (Orca issue): `run abandon` lowers the live ceiling to the observed work tokens, but ccloop compares the
// ceiling only inside onObservedUsage -- a provider that has gone silent emits no usage, so the stop waited for the idle
// watchdog (10 minutes) or the phase timeout. The same predicate is now evaluated on a 1 s tick, so a lowered ceiling
// stops a silent phase within about a second. No new kill authority: the phase stops through the abort it already uses.
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { canonicalJson } from "../../src/control/protocol.js";
import { runLoop } from "../../src/controller/runLoop.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { OmpAdapter } from "../../src/runtime/omp/ompAdapter.js";
import { buildExecutorPrompt } from "../../src/runtime/claude/prompts.js";
import type { LiveCeiling } from "../../src/budget/liveCeiling.js";
import { dispose, FAKE_CLAUDE, RAW_CONTRACT, world, type CaptureModules, type World } from "../fixtures/toolRules/argvCapture.js";

const STOP_REASON = "live token ceiling reached";
const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await dispose(w); });

const group = (tokens: number, revision = 1): LiveCeiling => ({ protocol: 1, revision, tokens, cause: "group" });

describe("a live ceiling lowered while the phase emits nothing (#369)", () => {
  it("stops the silent phase within about a second of the reduction", async () => {
    const w = await world(m); worlds.push(w);
    const contract = loopContractSchema.parse({ ...RAW_CONTRACT, context: { ...RAW_CONTRACT.context, repoPath: w.repo },
      executionPolicy: { ...RAW_CONTRACT.executionPolicy, tokenBudget: null },
      verification: { ...RAW_CONTRACT.verification, requiredChecks: ["test -f answer.txt"] } });
    const adapter = new ClaudeAgentAdapter({ schema: "ccloop-agent-config-v1", kind: "claude",
      installation: { kind: "claude", command: [process.execPath, FAKE_CLAUDE, "hang", w.marker, "--strict-mcp-config", "--disable-slash-commands"], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
      selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } } as never);
    let ceiling = group(1_000_000);
    const live = { current: () => ceiling, baseTokens: 0 };
    const started = Date.now();
    const running = runLoop(contract as never, w.runDir, adapter, { liveCeiling: live, onPhaseSettled: async () => undefined });
    // Orca's abandon, a moment after the phase started and went quiet: the ceiling drops to the observed total (0).
    setTimeout(() => { ceiling = group(0, 2); }, 400);
    const state = await running;
    // mutation: drop the 1 s tick (evaluate only in onObservedUsage) -> the phase times out instead, red
    expect(state.status).toBe("exhausted");
    expect(state.stopReason).toBe(STOP_REASON);
    expect(state.liveCeilingStop?.at).toBe("mid-call");
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 30_000);
});
