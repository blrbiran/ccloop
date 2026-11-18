// omp launch isolation (ccloop spec docs/superpowers/specs/2026-11-18-omp-launch-isolation-design.md; Orca #369 (a), #375).
// Why these matter: a loop phase that leaves omp's own auto-retry and model fallback on can sit on a provider refusal that
// will never pass (a removed model's 404) until the idle watchdog or a person ends it, and then fails as `unknown`, so
// Orca can neither say why nor move on. Every omp call also waited up to 30 s for MCP servers it may never use, and loaded
// MCP configs from the target repository, which could start processes inside a run. Everything is per launch: no agent
// profile or config file on disk is ever edited (human, 2026-11-18).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../../src/contract/schema.js";
import { canonicalJson } from "../../../src/control/protocol.js";
import { collectionSchema } from "../../../src/control/command.js";
import { listTranscripts } from "../../../src/control/transcripts.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { buildExecutorPrompt } from "../../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { classifyOmpCall, OmpCallFold, RETRYABLE_CAUSES } from "../../../src/runtime/failureCause.js";
import { OmpAdapter } from "../../../src/runtime/omp/ompAdapter.js";
import { runOmpSingleCall } from "../../../src/runtime/omp/ompSingleCall.js";
import { jsonLine } from "../../../src/runtime/streamLines.js";
import { dispose, ompInstallation, PHASES, world, type CaptureModules, type World } from "../../fixtures/toolRules/argvCapture.js";

const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await dispose(w); });
const fresh = async () => { const w = await world(m); worlds.push(w); return w; };
const onlyCallDir = async (root: string) => {
  const calls = (await readdir(root)).filter((name) => name.startsWith("call-"));
  expect(calls).toHaveLength(1);
  return join(root, calls[0]!);
};
const outcomeOf = async (w: World, phase: string) => JSON.parse(await readFile(join(await onlyCallDir(join(w.runDir, "omp", "1", phase)), "outcome.json"), "utf8")) as Record<string, unknown>;
const failureOf = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error);

// Review fixes 2026-11-18 (spec §6, I1): omp's in-session retry stays on but bounded; only model fallback is off.
const PHASE_OVERLAY = { retry: { maxRetries: 3, maxDelayMs: 60_000, modelFallback: false }, mcp: { enableProjectConfig: false } };
const SINGLE_CALL_OVERLAY = {
  retry: { enabled: false, modelFallback: false }, model: { loopGuard: { enabled: false } }, advisor: { enabled: false },
  compaction: { enabled: false }, mcp: { enableProjectConfig: false },
};

const errored = (status: number | undefined, errorMessage: string) => ({
  role: "assistant", content: [], provider: "gateway", model: "model-a", stopReason: "error", errorMessage,
  ...(status === undefined ? {} : { errorStatus: status }),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const FIELD_404 = "404 data: {\"error\":{\"message\":\"模型已下架，建议更换新模型\"}}";

describe("Fix A/B: the per-launch overlay of every phase", () => {
  for (const phase of PHASES) {
    it(`${phase}: --config <evidence>/config-overlay.yml right after --cwd, with a bounded omp retry, no model fallback, no project MCP`, async () => {
      const w = await fresh();
      await new OmpAdapter(await ompInstallation(w) as never)[phase](w.context as never).catch(() => undefined);
      const callDir = await onlyCallDir(join(w.runDir, "omp", "1", phase));
      const args = (await outcomeOf(w, phase)).args as string[];
      const cwd = args.indexOf("--cwd");
      expect(args.slice(cwd, cwd + 4)).toEqual(["--cwd", w.repo, "--config", join(callDir, "config-overlay.yml")]);
      expect(JSON.parse(await readFile(join(callDir, "config-overlay.yml"), "utf8"))).toEqual(PHASE_OVERLAY);
    }, 30_000);
  }
});

describe("Fix B: the single call's overlay also turns project MCP configs off", () => {
  it("the overlay file is exactly the single-call keys plus mcp.enableProjectConfig false", async () => {
    const w = await fresh();
    const config = await ompInstallation(w) as never;
    const runDir = join(w.dir, "single");
    await mkdir(runDir, { recursive: true });
    await runOmpSingleCall(config, { prompt: "p", responseSchema: { type: "object" }, maxOutputTokens: 8_192, cwd: w.repo, runDir, timeoutMs: 20_000 });
    const callDir = await onlyCallDir(join(runDir, "omp", "1", "single-call"));
    expect(JSON.parse(await readFile(join(callDir, "config-overlay.yml"), "utf8"))).toEqual(SINGLE_CALL_OVERLAY);
  }, 30_000);
});

describe("Fix B: OMP_MCP_TIMEOUT_MS is a small positive number on every omp call, whatever the parent had", () => {
  it("a phase and a single call both see 2000 while the parent environment says 30000", async () => {
    const w = await fresh();
    await writeFile(`${w.marker}.record-env`, "");
    const before = process.env.OMP_MCP_TIMEOUT_MS;
    process.env.OMP_MCP_TIMEOUT_MS = "30000";
    try {
      const config = await ompInstallation(w) as never;
      await new OmpAdapter(config).plan(w.context as never);
      const runDir = join(w.dir, "single");
      await mkdir(runDir, { recursive: true });
      await runOmpSingleCall(config, { prompt: "p", responseSchema: { type: "object" }, maxOutputTokens: 8_192, cwd: w.repo, runDir, timeoutMs: 20_000 });
    } finally {
      if (before === undefined) delete process.env.OMP_MCP_TIMEOUT_MS; else process.env.OMP_MCP_TIMEOUT_MS = before;
    }
    const seen = (await readFile(`${w.marker}.env.jsonl`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(seen).toEqual([{ call: "plan", mcpTimeout: "2000" }, { call: "single-call", mcpTimeout: "2000" }]);
  }, 30_000);
});

describe("Fix A: an errored assistant message is classified by its typed status only", () => {
  const events = (...messages: object[]) => messages.map((message) => JSON.stringify({ type: "message_end", message })).join("\n");
  const cases: Array<[number | undefined, string, string]> = [
    // Review fixes (spec §6, I3): an omp 404 is model-unavailable whatever its text -- the field's says 「模型已下架」.
    [404, FIELD_404, "model-unavailable"],
    [404, "404 not found", "model-unavailable"],
    [404, "404 The model `x` does not exist", "model-unavailable"],
    [400, "400 bad request", "provider-error"],
    [422, "422 unprocessable", "provider-error"],
    [401, "401 unauthorized", "auth"],
    [403, "403 forbidden", "auth"],
    [402, "402 payment required", "quota"],
    [429, "429 too many requests", "rate-limited"],
    [503, "503 unavailable", "provider-5xx"],
    [408, "408 request timeout", "unknown"],
    // Model or provider text that merely mentions a status is never classified: only the typed errorStatus is read.
    [undefined, "404 model not found", "unknown"],
  ];
  for (const [status, message, cause] of cases) {
    it(`status ${status ?? "absent"} (${message}) ⇒ ${cause}`, () => {
      const classification = classifyOmpCall(events(errored(status, message)));
      expect(classification.cause).toBe(cause);
      expect(classification.detail).toBe(status === undefined ? message : `HTTP ${status}: ${message}`);
    });
  }

  it("provider-error is terminal (never retried in a phase)", () => {
    expect(RETRYABLE_CAUSES.has("provider-error" as never)).toBe(false);
  });

  it("the stop signal is a non-retryable 4xx only: not 408, 429, 5xx, a status-less error or a later success", () => {
    const status = (...messages: object[]) => {
      const fold = new OmpCallFold();
      for (const line of events(...messages).split("\n")) fold.push(jsonLine({ text: line, tooLarge: false }));
      return fold.terminalProviderStatus();
    };
    expect(status(errored(404, FIELD_404))).toBe(404);
    expect(status(errored(400, "x"))).toBe(400);
    for (const code of [408, 429, 500, 503, undefined]) expect([code, status(errored(code, "x"))]).toEqual([code, null]);
    // The call went on after the refusal (a later assistant message): it neither ends the call nor names its failure.
    const later = { ...errored(undefined, "unused"), stopReason: "toolUse", errorMessage: undefined, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } };
    expect(status(errored(404, FIELD_404), later)).toBeNull();
    expect(classifyOmpCall(events(errored(429, "429 x"), later)).cause).toBe("unknown");
    // Review fixes (spec §6, M5): nor does the earlier refusal's detail outlive it.
    expect(classifyOmpCall(events(errored(404, FIELD_404), later)).detail).toBeNull();
  });
});

describe("Fix A: a phase whose provider refuses with a non-retryable 4xx ends after a grace window, named", () => {
  // Review fixes (spec §6, C1): omp emits the errored message_end BEFORE it recovers in-session (a compaction after a context
  // overflow, a bounded retry), so the refusal ends the phase only when nothing continues it: a terminal agent_end, or
  // silence for the grace window. The window is injected short here (OmpAdapter's 4th argument); production uses 20 s.
  const turnEnd = (status: number, message: string) => ({ type: "turn_end", message: errored(status, message), toolResults: [] });

  it("404, its own turn_end, then silence: stopped as provider-error once the window ran out, cause model-unavailable", async () => {
    const w = await fresh();
    await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan", hang: true,
      rows: [{ type: "session", id: "s" }, { type: "agent_start" }, { type: "message_end", message: errored(404, FIELD_404) }, turnEnd(404, FIELD_404)] }));
    const started = Date.now();
    const failure = await failureOf(new OmpAdapter(await ompInstallation(w) as never, undefined, [5], 300).plan(w.context as never));
    // Not at once: the window was waited out (a lower bound only; timers never fire early).
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(failure).toMatchObject({ failureCause: { cause: "model-unavailable", retries: 0, detail: `HTTP 404: ${FIELD_404}` } });
    expect(String(failure)).toContain("omp-provider-error");
    // Event-based (review M4): only ccloop's own stop writes this reason -- not the 10 s call limit, not the watchdog.
    expect((await outcomeOf(w, "plan")).reason).toBe("provider-error");
    expect(await readFile(`${w.marker}.calls`, "utf8")).toBe("plan\n");
  }, 30_000);

  // Re-review I-1: omp writes the errored turn's placeholder tool results (tool_execution_start/end and a toolResult
  // message) before its turn_end (pi-agent-core agent-loop.ts createAbortedToolResult); they must not disarm the window.
  it("4xx with a tool call, its placeholder tool rows and turn_end, then silence: still stopped as provider-error", async () => {
    const w = await fresh();
    await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan", hang: true,
      rows: [{ type: "session", id: "s" }, { type: "agent_start" }, { type: "message_end", message: errored(400, "bad request") },
        { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} },
        { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: true },
        { type: "message_start", message: { role: "toolResult" } }, { type: "message_end", message: { role: "toolResult", content: [] } },
        turnEnd(400, "bad request")] }));
    const failure = await failureOf(new OmpAdapter(await ompInstallation(w) as never, undefined, [5], 300).plan(w.context as never));
    expect(String(failure)).toContain("omp-provider-error");
    expect((await outcomeOf(w, "plan")).reason).toBe("provider-error");
  }, 30_000);

  it("400 then a terminal agent_end: stopped at once, without waiting for the window", async () => {
    const w = await fresh();
    await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan", hang: true,
      rows: [{ type: "session", id: "s" }, { type: "agent_start" }, { type: "message_end", message: errored(400, "400 bad request") },
        turnEnd(400, "400 bad request"), { type: "agent_end", isTerminal: true, yielded: true, messages: [] }] }));
    // A 10-minute window: the 10 s call limit would end the phase first (reason timeout) unless the terminal agent_end did.
    const failure = await failureOf(new OmpAdapter(await ompInstallation(w) as never, undefined, [5], 600_000).plan(w.context as never));
    expect(failure).toMatchObject({ failureCause: { cause: "provider-error", retries: 0, detail: "HTTP 400: 400 bad request" } });
    expect((await outcomeOf(w, "plan")).reason).toBe("provider-error");
  }, 30_000);

  const OVERFLOW = "400 prompt is too long: 250000 tokens > 200000 maximum";
  const continuations: Array<[string, object]> = [
    ["auto_compaction_start", { type: "auto_compaction_start", reason: "overflow", action: "context-full" }],
    ["auto_retry_start", { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: OVERFLOW }],
    // omp 18.10.1's measured continuation shape (turn_end, then agent_start; plan 2026-10-26-omp-empty-stop).
    ["agent_start", { type: "agent_start" }],
  ];
  for (const [name, row] of continuations) {
    it(`400 (context overflow), its turn_end, then ${name} and a successful turn after the window: not stopped, the phase succeeds`, async () => {
      const w = await fresh();
      await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan", answerAfterMs: 1_200,
        rows: [{ type: "session", id: "s" }, { type: "agent_start" }, { type: "message_end", message: errored(400, OVERFLOW) }, turnEnd(400, OVERFLOW), row] }));
      const plan = await new OmpAdapter(await ompInstallation(w) as never, undefined, [5], 200).plan(w.context as never);
      expect(plan).toMatchObject({ summary: "Set answer to 42" });
      expect((await outcomeOf(w, "plan")).reason).toBe("completed");
      expect(await readFile(`${w.marker}.calls`, "utf8")).toBe("plan\n");
    }, 30_000);
  }

  for (const status of [429, 408]) {
    it(`${status} then a hanging omp is not stopped as provider-error (it runs to the call's own limit)`, async () => {
      const w = await fresh();
      await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan", hang: true,
        rows: [{ type: "session", id: "s" }, { type: "agent_start" }, { type: "message_end", message: errored(status, `${status} x`) }] }));
      const config = await ompInstallation(w) as { installation: Record<string, unknown> };
      config.installation.timeoutMs = 1_500;
      const started = Date.now();
      await failureOf(new OmpAdapter(config as never, undefined, []).plan(w.context as never));
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
      expect((await outcomeOf(w, "plan")).reason).not.toBe("provider-error");
    }, 30_000);
  }
});

describe("Fix B: omp's MCP readiness warnings are an observation in outcome.json and collect", () => {
  // Review fixes (spec §6, M1/M2): only omp's two MCP readiness shapes are kept, cut after the server's name and state -- the
  // failed-to-connect tail is the server's own error and can carry a URL with a token. Any other `Warning:` line is dropped.
  // ANSI escapes are stripped before matching (omp colours some stderr with chalk; FORCE_COLOR may be inherited).
  const NOT_READY = "Warning: MCP server \"rea\" not ready after 2000ms; its tools are unavailable for this run.";
  const FAILED = "Warning: MCP server \"db\" failed to connect: GET https://mcp.example/sse?token=SECRET-123 401; its tools are unavailable for this run.";
  const COLOURED = "\u001b[33mWarning: MCP server \"git\" not ready after 2000ms; its tools are unavailable for this run.\u001b[39m";
  const KEPT = ["Warning: MCP server \"rea\" not ready after 2000ms", "Warning: MCP server \"db\" failed to connect", "Warning: MCP server \"git\" not ready after 2000ms"];

  it("the MCP readiness lines (only those, cut after name and state) reach outcome.json and the collect entry, which collect's schema accepts", async () => {
    const w = await fresh();
    await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan",
      stderr: `${NOT_READY}\nsome other line\nWarning: session store at /x?token=SECRET-456 is slow\n${FAILED}\n${COLOURED}\n` }));
    await new OmpAdapter(await ompInstallation(w) as never).plan(w.context as never);
    expect((await outcomeOf(w, "plan")).warnings).toEqual(KEPT);
    expect(await readFile(join(await onlyCallDir(join(w.runDir, "omp", "1", "plan")), "outcome.json"), "utf8")).not.toContain("SECRET");
    const entries = await listTranscripts(w.dir, true);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.warnings).toEqual(KEPT);
    const parsed = collectionSchema.parse({ events: [], candidate: null, terminal: null, progress: null, transcripts: entries });
    expect(parsed.transcripts![0]!.warnings).toEqual(KEPT);
  }, 30_000);

  it("without an MCP readiness warning neither outcome.json nor the transcript entry has the key (no new bytes for a quiet call)", async () => {
    const w = await fresh();
    await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan", stderr: "Warning: something else\n" }));
    await new OmpAdapter(await ompInstallation(w) as never).plan(w.context as never);
    expect(Object.keys(await outcomeOf(w, "plan"))).not.toContain("warnings");
    const entries = await listTranscripts(w.dir, true);
    expect(Object.keys(entries[0]!)).not.toContain("warnings");
  }, 30_000);

  it("bounded: at most 16 lines, each at most 512 bytes", async () => {
    const w = await fresh();
    const lines = Array.from({ length: 20 }, (_, index) => `Warning: MCP server "s${index}${"é".repeat(index === 0 ? 400 : 1)}" not ready after 2000ms; x`);
    await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan", stderr: `${lines.join("\n")}\n` }));
    await new OmpAdapter(await ompInstallation(w) as never).plan(w.context as never);
    const warnings = (await outcomeOf(w, "plan")).warnings as string[];
    expect(warnings).toHaveLength(16);
    expect(warnings[1]).toBe("Warning: MCP server \"s1é\" not ready after 2000ms");
    expect(Buffer.byteLength(warnings[0]!)).toBeLessThanOrEqual(512);
    expect(lines[0]!.startsWith(warnings[0]!)).toBe(true);
  }, 30_000);
});
