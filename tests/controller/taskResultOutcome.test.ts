import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { runLoop } from "../../src/controller/runLoop.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { buildVerifierPrompt } from "../../src/runtime/claude/prompts.js";
import { decodeCodexResult } from "../../src/runtime/codex/protocol.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { codexFixture } from "../runtime/codex/fixture.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const events = '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}\n';
const core = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "log" };
// Break: invalid optional report must never skip the actual verifier or spend a business retry/usage budget.
describe("controller outcome independent of explanation", () => {
  it.each(["codex", "claude"])("%s: invokes the real verifier once with baseline prompt even when optional report accessor throws", async kind => {
    const observations = [];
    for (const accessor of [false, true]) {
      const f = await codexFixture("ok"); dirs.push(f.dir);
      const verifier = kind === "codex" ? new CodexAdapter(f.config) : new ClaudeAgentAdapter({
        schema: "ccloop-agent-config-v1", kind: "claude",
        installation: { kind: "claude", command: [process.execPath, fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url)), "ok", f.marker], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
        selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
      });
      let expectedPrompt = "";
      const adapter: RuntimeAdapter = {
        async plan() { return { summary: "Set answer", primaryTargetPaths: ["answer.txt"], tokenUsage: 15 }; },
        async execute(context) {
          await writeFile(join(context.worktreePath,"answer.txt"),"42\n");
          const execution = { ...core, tokenUsage: 15 };
          expectedPrompt = buildVerifierPrompt({ ...context, execution });
          return accessor ? Object.defineProperty(execution, "taskResult", { enumerable: true, get() { throw new Error("optional report accessor executed"); } }) : execution;
        },
        verify(context) { return verifier.verify(context); },
      };
      const state = await runLoop(f.contract, f.runDir, adapter);
      // Real fixture marker exists only if prompt construction reached the external fake CLI verification call.
      expect(state.status).toBe("succeeded");
      expect(await readFile(f.marker + ".calls", "utf8")).toBe("verify\n");
      const actual = JSON.parse(await readFile(f.marker,"utf8"));
      expect(actual.prompt).toBe(expectedPrompt);
      observations.push({ status: state.status, attempts: state.attemptsUsed, tokens: state.budgetSnapshot.tokenBudgetRemaining });
      const saved = JSON.parse(await readFile(join(f.runDir,"attempts","1","execution.json"),"utf8"));
      expect(saved).toMatchObject({ ...core, tokenUsage: 15 });
      if (accessor) expect(saved.taskResult.schema).toBe("ccloop-task-result-invalid-v1");
    }
    expect(observations).toEqual(Array(2).fill({ status: "succeeded", attempts: 1, tokens: 955 }));
  });
  for (const partial of [false, true]) it(`preserves real ${partial ? "partial" : "complete"} outcome, attempts, usage and verification count`, async () => {
    const observations = [];
    for (const metadata of [undefined, { result: 0 }, "x".repeat(65535)]) {
      const f = await codexFixture("unused"); dirs.push(f.dir);
      let verifies = 0;
      const adapter: RuntimeAdapter = {
        async plan() { return { summary: "Set answer", primaryTargetPaths: ["answer.txt"], tokenUsage: 15 }; },
        async execute(context) {
          await writeFile(join(context.worktreePath,"answer.txt"),"42\n");
          const body = partial ? { ...core, completionStatus: "partial", failureType: "error", failureMessage: "interrupted" } : core;
          return decodeCodexResult("execute", events, JSON.stringify({ ...body, ...(metadata === undefined ? {} : { taskResult: metadata }) }));
        },
        async verify() { verifies++; return { approved: true, rejectCategory: "", primaryTargetPaths: ["answer.txt"], failingCommand: null, safeToRetry: false, evidence: ["answer is 42"], pauseSignals: [], stopSignals: [], tokenUsage: 15 }; },
      };
      const state = await runLoop(f.contract, f.runDir, adapter);
      const saved = JSON.parse(await readFile(join(f.runDir,"attempts","1","execution.json"),"utf8"));
      expect(saved).toMatchObject({ ...core, tokenUsage: 15 });
      if (partial) expect(saved).toMatchObject({ completionStatus: "partial", failureType: "error", failureMessage: "interrupted" });
      const value = { status: state.status, attempts: state.attemptsUsed, tokens: state.budgetSnapshot.tokenBudgetRemaining, verifies };
      observations.push(value);
    }
    // Existing controller policy verifies recognizable partial work; the approving verifier determines the final state.
    expect(observations).toEqual(Array(3).fill({ status: "succeeded", attempts: 1, tokens: 955, verifies: 1 }));
  });
});
