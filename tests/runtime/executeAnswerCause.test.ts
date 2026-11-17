// Orca tester #347 (issue-20261023, board-dogfood-20261117-1): a codex execute ended after one sentence ("I'll start by
// reading the handoff context ... before implementing.", 22 output tokens) and the run recorded failureCause
// {cause: "unknown"} beside `ExecutionFormatFailure: SyntaxError ... is not valid JSON`. Orca then retried it silently.
// Why it matters: "said what it would do and stopped" and "did the work but wrote a malformed answer" need different
// handling (the first needs a plain hint on the retry), and `unknown` hid both. Now an execute final the strict decode
// refuses is classified by its structure and by the work the adapter observed in the same call:
// - narration-only: no answer (blank, or prose holding no JSON) and no tool, command or file change observed;
// - execution-not-json: a final that is not JSON (or brace text that does not parse), or no answer after work;
// - execution-shape: JSON that is not exactly one accepted execute answer (the refused field stays the detail, #274).
// "No work" is an observation, not a token count: codex work items, claude tool_use blocks, omp tool_execution_start rows.
// None of the three is retried inside the phase (Orca retries at task level).
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { loopContractSchema } from "../../src/contract/schema.js";
import { canonicalJson } from "../../src/control/protocol.js";
import { runLoop } from "../../src/controller/runLoop.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { buildExecutorPrompt } from "../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { executeAnswerForm } from "../../src/runtime/executionNormalizer.js";
import { CodexCallFold, EXECUTE_ANSWER_CAUSES, FAILURE_CAUSES, RETRYABLE_CAUSES, executeAnswerCause, withExecuteAnswerCause } from "../../src/runtime/failureCause.js";
import { OmpAdapter } from "../../src/runtime/omp/ompAdapter.js";
import { decodeOmpPhase } from "../../src/runtime/omp/ompProtocol.js";
import { foldText } from "../../src/runtime/streamLines.js";
import { dispose, ompInstallation, RAW_CONTRACT, world, type CaptureModules, type World } from "../fixtures/toolRules/argvCapture.js";
import { codexFixture } from "./codex/fixture.js";

const SENTENCE = "I’ll start by reading the handoff context and the existing board model/tests before implementing.";
const BYTES = Buffer.byteLength(SENTENCE, "utf8");
const NARRATION_DETAIL = `the call ended after a ${BYTES}-byte final message that is not an execute answer; no tool, command or file change was observed`;
const fields = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: ["ran"], stdoutStderrLog: "log" };

const dirs: string[] = [], worlds: World[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  for (const w of worlds.splice(0)) await dispose(w);
});

describe("executeAnswerForm: the structure of a refused final, never its words", () => {
  it("tells absent, prose, json and broken apart", () => {
    expect(executeAnswerForm(null, null)).toEqual({ form: "absent", bytes: 0 });
    expect(executeAnswerForm(" \n", null)).toEqual({ form: "absent", bytes: 2 });
    expect(executeAnswerForm(SENTENCE, null)).toEqual({ form: "prose", bytes: BYTES });
    expect(executeAnswerForm(JSON.stringify({ result: { ...fields, commandOutputs: "x" } }), null).form).toBe("json");
    expect(executeAnswerForm("[1,2]", null).form).toBe("json");
    // A decorated answer: an object holding an execute key inside prose.
    expect(executeAnswerForm(`Done: ${JSON.stringify({ result: { ...fields, commandOutputs: "x" } })}`, null).form).toBe("json");
    // Brace text that does not parse: an answer may have been attempted, so it is not narration.
    expect(executeAnswerForm('Here it is: {"changedFiles": ["a"', null).form).toBe("broken");
    expect(executeAnswerForm("I will edit the {name} template.", null).form).toBe("broken");
  });
});

describe("executeAnswerCause: the rule", () => {
  const prose = { form: "prose" as const, bytes: BYTES }, absent = { form: "absent" as const, bytes: 0 };
  it("narration-only needs both: no answer and no work", () => {
    // mutation M1 (ignore toolObserved: prose is always narration-only) -> the second assertion red.
    expect(executeAnswerCause(prose, false, null)).toEqual({ cause: "narration-only", detail: NARRATION_DETAIL });
    expect(executeAnswerCause(prose, true, null)).toEqual({ cause: "execution-not-json", detail: `the final message (${BYTES} bytes) is not JSON` });
    expect(executeAnswerCause(absent, false, null)).toEqual({ cause: "narration-only", detail: "the call ended without a final answer; no tool, command or file change was observed" });
    expect(executeAnswerCause(absent, true, null)).toEqual({ cause: "execution-not-json", detail: "the call ended without a final answer after using tools" });
  });
  it("json is execution-shape and broken is execution-not-json whatever the work; the refused field stays the detail", () => {
    // mutation M2 (json classified as execution-not-json) -> red.
    expect(executeAnswerCause({ form: "json", bytes: 9 }, false, "execution-format-invalid: commandOutputs: expected array, received string"))
      .toEqual({ cause: "execution-shape", detail: "execution-format-invalid: commandOutputs: expected array, received string" });
    // mutation M3 (broken treated as prose) -> narration-only, red.
    expect(executeAnswerCause({ form: "broken", bytes: 9 }, false, null).cause).toBe("execution-not-json");
  });
  it("is terminal: none of the three is retried inside the phase", () => {
    for (const cause of EXECUTE_ANSWER_CAUSES) {
      expect(FAILURE_CAUSES).toContain(cause);
      expect(RETRYABLE_CAUSES.has(cause)).toBe(false);
    }
  });
  it("refines only an unknown classification, and only an error that carries a form", () => {
    const error = { executeAnswer: { form: "absent", bytes: 0 } };
    // mutation M4 (no unknown guard) -> a claude rate limit that also left no answer would read narration-only, red.
    expect(withExecuteAnswerCause({ cause: "rate-limited", workObserved: false, detail: "429" }, error, false)).toEqual({ cause: "rate-limited", workObserved: false, detail: "429" });
    expect(withExecuteAnswerCause({ cause: "unknown", workObserved: true, detail: null }, new Error("x"), false)).toEqual({ cause: "unknown", workObserved: true, detail: null });
    // workObserved (retry safety) is kept as the adapter saw it.
    expect(withExecuteAnswerCause({ cause: "unknown", workObserved: true, detail: null }, error, false)).toMatchObject({ cause: "narration-only", workObserved: true });
  });
});

describe("CodexCallFold.toolObserved: codex work items", () => {
  const fold = (rows: unknown[]) => foldText(rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n"), new CodexCallFold()).toolObserved();
  const item = (type: string) => ({ type: "item.completed", item: { id: "i", type } });
  it("messages, reasoning and codex's error items are not work; any other item, or an unparsed line, is", () => {
    // The #347 stream: an agent message and turn.completed; codex 0.167.0 also emits error items for config warnings.
    expect(fold([{ type: "thread.started" }, { type: "turn.started" }, item("reasoning"), item("error"), item("agent_message"), { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 22 } }])).toBe(false);
    // mutation M5 (toolObserved = any item.*, the retry-safety flag) -> the line above red.
    for (const type of ["command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list", "some_future_item"]) expect(fold([item(type)])).toBe(true);
    expect(fold([{ type: "item.started", item: { id: "c", type: "command_execution" } }])).toBe(true);
    expect(fold(["not json"])).toBe(true);
    expect(fold([{ type: "item.completed" }])).toBe(true);
  });
});

/** The codex fake answers the execute phase with `final` verbatim, after `items` as item.completed rows. */
async function codexRun(final: string, items: unknown[] = []) {
  const f = await codexFixture("final-text");
  dirs.push(f.dir);
  const finals = join(f.dir, "finals.json");
  await writeFile(finals, JSON.stringify({ execute: final, executeItems: items }));
  const state = await runLoop(f.contract, f.runDir, new CodexAdapter({ ...f.config, command: [...f.config.command, finals] }));
  const root = join(f.runDir, "codex", "1", "execute"), [call] = await readdir(root);
  return { state, call: join(root, call!) };
}

describe("codex: the #347 run, end to end through runLoop", () => {
  it("one sentence and no work item: narration-only, the stop reason unchanged", async () => {
    const { state } = await codexRun(SENTENCE);
    expect(state.status).toBe("failed");
    expect(state.stopReason).toMatch(/^ExecutionFormatFailure: SyntaxError: .* is not valid JSON/);
    // mutation M6 (codex failedTry does not apply withExecuteAnswerCause) -> cause unknown, red here.
    expect(state.failureCause).toEqual({ cause: "narration-only", phase: "execute", retries: 0, detail: NARRATION_DETAIL });
  }, 60_000);

  it("the same sentence after a command ran: execution-not-json", async () => {
    const { state } = await codexRun(SENTENCE, [{ id: "c1", type: "command_execution", command: "ls", aggregated_output: "", exit_code: 0, status: "completed" }]);
    expect(state.failureCause).toEqual({ cause: "execution-not-json", phase: "execute", retries: 0, detail: `the final message (${BYTES} bytes) is not JSON` });
  }, 60_000);
});

const fakeClaude = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));
async function claudeRun(mode: "no-answer" | "no-answer-tool") {
  const f = await codexFixture("unused");
  dirs.push(f.dir);
  const config: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, fakeClaude, mode, join(f.dir, "claude-marker.json")], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } };
  return runLoop(f.contract, f.runDir, new ClaudeAgentAdapter(config, { retryDelaysMs: [] }));
}

describe("claude: an execute call that ended without the structured answer", () => {
  it("no tool use: narration-only", async () => {
    const state = await claudeRun("no-answer");
    expect(state.status).toBe("failed");
    expect(state.stopReason).toContain("claude-exit-error");
    // mutation M7 (the runner's missing-answer error not recognised) -> cause unknown, red here.
    expect(state.failureCause).toEqual({ cause: "narration-only", phase: "execute", retries: 0, detail: "the call ended without a final answer; no tool, command or file change was observed" });
  }, 60_000);

  it("after a tool use: execution-not-json", async () => {
    const state = await claudeRun("no-answer-tool");
    expect(state.failureCause).toEqual({ cause: "execution-not-json", phase: "execute", retries: 0, detail: "the call ended without a final answer after using tools" });
  }, 60_000);
});

const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
async function ompRun(final: string, tools?: unknown[]) {
  const w = await world(m); worlds.push(w);
  const contract = loopContractSchema.parse({ ...RAW_CONTRACT, context: { ...RAW_CONTRACT.context, repoPath: w.repo },
    verification: { ...RAW_CONTRACT.verification, requiredChecks: ["test -f answer.txt"] } });
  await writeFile(`${w.marker}.final.txt`, final);
  if (tools !== undefined) await writeFile(`${w.marker}.tools.json`, JSON.stringify(tools));
  return runLoop(contract, w.runDir, new OmpAdapter(await ompInstallation(w) as never));
}

describe("omp: an execute final that is not an answer", () => {
  it("no tool_execution_start: narration-only", async () => {
    const state = await ompRun(SENTENCE);
    expect(state.status).toBe("failed");
    expect(state.stopReason).toContain("omp-result-invalid");
    // mutation M8 (the omp adapter does not apply withExecuteAnswerCause) -> cause unknown, red here.
    expect(state.failureCause).toEqual({ cause: "narration-only", phase: "execute", retries: 0, detail: NARRATION_DETAIL });
  }, 60_000);

  it("after a tool ran: execution-not-json, with omp's own detail kept", async () => {
    const state = await ompRun(SENTENCE, [{ toolName: "bash", args: { command: "ls" } }]);
    expect(state.failureCause).toEqual({ cause: "execution-not-json", phase: "execute", retries: 0, detail: "execution-format-invalid: the final message is not one JSON object" });
  }, 60_000);

  it("a stop with no text (a signed thinking block only) carries the absent form; plan's does not", () => {
    // A blank text alone is not an actionable stop (omp retries it, omp-no-completion); a signed thinking block is.
    const answer = { role: "assistant", content: [{ type: "thinking", thinking: "plan", thinkingSignature: "sig" }, { type: "text", text: " " }], provider: "gateway", model: "model-a",
      stopReason: "stop", usage: { input: 8, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 14 } };
    const events = [{ type: "agent_start" }, { type: "message_end", message: answer }, { type: "agent_end", isTerminal: true, yielded: true }].map((row) => JSON.stringify(row)).join("\n");
    const failure = (phase: "execute" | "plan") => { try { decodeOmpPhase(phase, events, "gateway/model-a"); } catch (error) { return error as Error & Record<string, unknown>; } throw new Error("expected a failure"); };
    expect(failure("execute").message).toBe("omp-result-invalid");
    // mutation M9 (the blank-final throw carries no form) -> undefined, red here.
    expect(failure("execute").executeAnswer).toEqual({ form: "absent", bytes: 1 });
    expect(failure("plan").executeAnswer).toBeUndefined();
  });
});
