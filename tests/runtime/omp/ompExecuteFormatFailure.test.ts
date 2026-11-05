// Orca tester issues 125 and 158 (session 3cfc2e73, batch I5). An omp execute answer the strict execute shape refuses
// (omp-result-invalid) used to end the run with failureCause {cause: unknown, detail: null} and no hint of where the finished
// work went. Now: the cause stays unknown and the error is unchanged, but failureCause.detail names what the shape refused
// (the first issue's path and message, bounded to 512 bytes like every other detail), and the run directory gets
// execute-format-failure.json naming the refs cleanup publishes the attempt under, the commit they build on, and the
// normalizer's issues. Diagnosis only: no capsule, no recovery, nothing in collect.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../../src/contract/schema.js";
import { canonicalJson } from "../../../src/control/protocol.js";
import { runLoop } from "../../../src/controller/runLoop.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { buildExecutorPrompt } from "../../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { OmpAdapter } from "../../../src/runtime/omp/ompAdapter.js";
import { decodeOmpPhase, executionFormatIssues } from "../../../src/runtime/omp/ompProtocol.js";
import { attemptRefNames, registerAttemptRefNamespace } from "../../../src/workspace/worktreeManager.js";
import { dispose, ompInstallation, RAW_CONTRACT, world, type CaptureModules, type World } from "../../fixtures/toolRules/argvCapture.js";

const exec = promisify(execFile);
const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await dispose(w); });

/** runLoop over the omp adapter and fake-omp; `reported` is merged into the fake's execute answer (<marker>.reported.json). */
async function run(reported?: Record<string, unknown>) {
  const w = await world(m); worlds.push(w);
  const contract = loopContractSchema.parse({ ...RAW_CONTRACT, context: { ...RAW_CONTRACT.context, repoPath: w.repo },
    verification: { ...RAW_CONTRACT.verification, requiredChecks: ["test -f answer.txt"] } });
  if (reported !== undefined) await writeFile(`${w.marker}.reported.json`, JSON.stringify(reported));
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: w.repo })).stdout.trim();
  const state = await runLoop(contract, w.runDir, new OmpAdapter(await ompInstallation(w) as never));
  return { w, state, head, diagnostics: join(w.runDir, "execute-format-failure.json") };
}

describe("an omp execute answer the strict shape refuses (runLoop over the omp adapter and fake-omp)", () => {
  it("flattened taskResult fields: failed, cause unknown with the refused keys as detail, and the work is findable under the named ref", async () => {
    const { w, state, head, diagnostics } = await run({ schema: "task-result-v1", goal: "Set answer.txt to 42" });
    expect(state.status).toBe("failed");
    expect(state.stopReason).toContain("omp-result-invalid");
    expect(state.failureCause).toEqual({ cause: "unknown", phase: "execute", retries: 0,
      detail: "execution-format-invalid: (top level): Unrecognized key(s) in object: 'schema', 'goal'" });
    const file = JSON.parse(await readFile(diagnostics, "utf8")) as Record<string, any>;
    expect(file).toMatchObject({ schema: "ccloop-omp-execute-format-failure-v1", attempt: 1, attemptRefs: ["refs/ccloop/run/attempts/1"], attemptBase: head,
      normalization: { reason: "execution-format-invalid", issues: [{ path: "", message: "Unrecognized key(s) in object: 'schema', 'goal'" }] } });
    expect(existsSync(join(file.evidenceDir, "events.jsonl"))).toBe(true);
    // The named ref holds the attempt's work (the fake wrote answer.txt = 42) on top of the named base.
    expect((await exec("git", ["rev-parse", "refs/ccloop/run/attempts/1^"], { cwd: w.repo })).stdout.trim()).toBe(head);
    expect((await exec("git", ["show", "refs/ccloop/run/attempts/1:answer.txt"], { cwd: w.repo })).stdout).toBe("42\n");
  }, 60_000);

  it("a required field of the wrong type: the detail names its path", async () => {
    const { state, diagnostics } = await run({ stdoutStderrLog: null });
    expect(state.failureCause).toEqual({ cause: "unknown", phase: "execute", retries: 0, detail: "execution-format-invalid: stdoutStderrLog: Expected string, received null" });
    expect(existsSync(diagnostics)).toBe(true);
  }, 60_000);

  it("the detail is bounded to 512 bytes, cut on a character boundary", async () => {
    const { state } = await run({ ["键".repeat(400)]: 1 });
    const detail = state.failureCause?.detail ?? "";
    expect(detail.startsWith("execution-format-invalid: (top level): Unrecognized key(s) in object: '键")).toBe(true);
    expect(Buffer.byteLength(detail, "utf8")).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(detail, "utf8")).toBeGreaterThan(500);
    expect(detail).not.toContain("�");
  }, 60_000);

  it("an accepted answer writes no diagnostics file", async () => {
    const { state, diagnostics } = await run();
    expect(state.status).toBe("succeeded");
    expect(existsSync(diagnostics)).toBe(false);
  }, 60_000);
});

const answerEvents = (text: string) => {
  const answer = { role: "assistant", content: [{ type: "text", text }], provider: "gateway", model: "model-a", stopReason: "stop",
    usage: { input: 8, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 14 } };
  return [{ type: "agent_start" }, { type: "message_end", message: answer }, { type: "agent_end", isTerminal: true, yielded: true }].map((row) => JSON.stringify(row)).join("\n");
};
const failureOf = (text: string) => { try { decodeOmpPhase("execute", answerEvents(text), "gateway/model-a"); } catch (error) { return error as Error & Record<string, any>; } throw new Error("expected a failure"); };
const fields = { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };

describe("the execute decode's failure detail (decodeOmpPhase)", () => {
  it("a final that is not one JSON object says so; the error and its tokens are unchanged", () => {
    const error = failureOf("Done: I set answer.txt to 42.");
    expect(error.message).toBe("omp-result-invalid");
    expect(error.observedTokens).toBe(14);
    expect(error.formatDetail).toBe("execution-format-invalid: the final message is not one JSON object");
    expect(error.formatNormalization).toMatchObject({ reason: "execution-format-invalid", issues: [] });
  });

  it("a partial answer is judged against the partial shape, not the complete one", () => {
    const error = failureOf(JSON.stringify({ ...fields, completionStatus: "partial", failureType: "error" }));
    expect(error.formatDetail).toBe("execution-format-invalid: failureMessage: Required");
    expect(executionFormatIssues(JSON.stringify({ result: { ...fields, completionStatus: "partial", failureType: "error" } }))).toEqual([{ path: "failureMessage", message: "Required" }]);
  });

  it("an accepted answer has no issues", () => {
    expect(executionFormatIssues(JSON.stringify(fields))).toEqual([]);
    expect(decodeOmpPhase("execute", answerEvents(JSON.stringify(fields)), "gateway/model-a")).toMatchObject({ ...fields, tokenUsage: 14 });
  });
});

// A control run's run directory is <sourceDir>/run, so the path-derived ref is shared by every control run in a repository;
// publishAttemptCommit also pins the claim's ref, and the diagnostics name both.
it("attemptRefNames names the claim's ref too when the run directory registered one", () => {
  registerAttemptRefNamespace("/i5-fixture/source/run", "claim-7");
  expect(attemptRefNames("/i5-fixture/source/run/worktrees/attempt-2")).toEqual(["refs/ccloop/run/attempts/2", "refs/ccloop/claim-7/attempts/2"]);
  expect(attemptRefNames("/i5-fixture/other/run/worktrees/attempt-2")).toEqual(["refs/ccloop/run/attempts/2"]);
});
