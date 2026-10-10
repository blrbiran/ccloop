import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runLoop } from "../../src/controller/runLoop.js";
import { decodeCodexResult } from "../../src/runtime/codex/protocol.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { codexFixture } from "../runtime/codex/fixture.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const events = '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}\n';
const core = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "log" };
// Break: invalid optional report must never skip the actual verifier or spend a business retry/usage budget.
describe("controller outcome independent of explanation", () => {
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
