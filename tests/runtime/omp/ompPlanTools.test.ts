// omp plan phase tools (ccloop spec 2026-10-27-plan-phase-tools-design.md; Orca tester issue 60). Human direction: plan
// keeps read, grep and glob only -- no bash, no writes. A plan call that reaches for another tool (issue 60: `write` to an
// MCP `xd://` path to run `git log`) is refused as before, and the run now says why: cause `tool-rule-violated`, the phase
// and the tool in `detail`, so Orca can explain it instead of showing `unknown`. Terminal by the existing policy: the model
// chose a tool the phase lacks, a retry has no evidence of passing and costs a full plan call.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../../src/contract/schema.js";
import { canonicalJson } from "../../../src/control/protocol.js";
import { runLoop } from "../../../src/controller/runLoop.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { buildExecutorPrompt } from "../../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { OmpAdapter } from "../../../src/runtime/omp/ompAdapter.js";
import { decodeOmpPhase } from "../../../src/runtime/omp/ompProtocol.js";
import { dispose, ompInstallation, RAW_CONTRACT, world, type CaptureModules, type World } from "../../fixtures/toolRules/argvCapture.js";

const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await dispose(w); });

async function runWithPlanTools(planTools: unknown) {
  const w = await world(m); worlds.push(w);
  const contract = loopContractSchema.parse({ ...RAW_CONTRACT, context: { ...RAW_CONTRACT.context, repoPath: w.repo },
    executionPolicy: { ...RAW_CONTRACT.executionPolicy, maxAttempts: 2, perAttemptTimeoutMs: 15_000 },
    verification: { ...RAW_CONTRACT.verification, requiredChecks: ["test -f answer.txt"] } });
  await writeFile(`${w.marker}.plan-tools.json`, JSON.stringify(planTools));
  const state = await runLoop(contract, w.runDir, new OmpAdapter(await ompInstallation(w) as never));
  const calls = (await readFile(`${w.marker}.calls`, "utf8")).trim().split("\n");
  const root = join(w.runDir, "omp", "1", "plan");
  const [call] = (await readdir(root)).filter((name) => name.startsWith("call-"));
  const systemPrompt = await readFile(join(root, call!, "system-prompt.md"), "utf8");
  return { state, calls, systemPrompt };
}

describe("a plan phase that calls a tool it does not have (issue 60)", () => {
  it("fails the run with cause tool-rule-violated in plan, naming the tool and path, without another call", async () => {
    const { state, calls, systemPrompt } = await runWithPlanTools([{ toolName: "write", args: { path: "xd://mcp__rea_capture_process_scenario", content: "{\"command\":\"git log\"}" } }]);
    expect(state.status).toBe("failed");
    expect(state.stopReason).toContain("omp-phase-tool-forbidden");
    expect(state.failureCause).toEqual({ cause: "tool-rule-violated", phase: "plan", retries: 0, detail: expect.stringContaining("write") });
    expect(state.failureCause?.detail).toContain("xd://mcp__rea_capture_process_scenario");
    expect(state.failureCause?.detail).toContain("read, grep, glob");
    expect(calls).toEqual(["plan"]);
    // The model was told, in the prompt it ran under, which tools plan has and that MCP calls wait for execute.
    expect(systemPrompt).toContain("Tools available in this phase: read, grep, glob.");
    expect(systemPrompt).toContain("MCP calls (including xd:// paths) are unavailable until the execute phase");
  }, 60_000);

  it("a plan that only reads still succeeds (the tool set did not narrow)", async () => {
    const { state, calls } = await runWithPlanTools([{ toolName: "read", args: { path: "answer.txt" } }, { toolName: "grep", args: { pattern: "x" } }]);
    expect(state.status).toBe("succeeded");
    expect(calls).toEqual(["plan", "execute", "verify"]);
  }, 60_000);
});

// Only a tool choice is a tool-rule violation; a protocol anomaly in the same code family carries no detail, so the
// adapter cannot classify it as one (it stays unknown, as before).
it("attaches a detail only to a forbidden tool, not to an orphan tool end", () => {
  const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify({ summary: "p", primaryTargetPaths: [] }) }],
    provider: "gateway", model: "model-a", stopReason: "stop", usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } };
  const decode = (...rows: unknown[]) => { try { decodeOmpPhase("plan", rows.map((row) => JSON.stringify(row)).join("\n"), "gateway/model-a"); return null; } catch (error) { return error; } };
  const orphan = decode({ type: "agent_start" }, { type: "tool_execution_end", toolCallId: "h", toolName: "bash" }, { type: "message_end", message }, { type: "agent_end", isTerminal: true });
  expect(orphan).toMatchObject({ message: "omp-phase-tool-forbidden" });
  expect((orphan as { detail?: unknown }).detail).toBeUndefined();
  const duplicate = decode({ type: "agent_start" }, { type: "tool_execution_start", toolCallId: "t", toolName: "read" }, { type: "tool_execution_start", toolCallId: "t", toolName: "read" });
  expect(duplicate).toMatchObject({ message: "omp-phase-tool-forbidden" });
  expect((duplicate as { detail?: unknown }).detail).toBeUndefined();
  const subagent = decode({ type: "agent_start" }, { type: "subagent_start" });
  expect(subagent).toMatchObject({ message: "omp-phase-tool-forbidden", code: "omp-phase-tool-forbidden", detail: "plan phase allows read, grep, glob; the agent called subagent_start" });
});
