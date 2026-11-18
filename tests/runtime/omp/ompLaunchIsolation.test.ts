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

const PHASE_OVERLAY = { retry: { enabled: false, modelFallback: false }, mcp: { enableProjectConfig: false } };
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
    it(`${phase}: --config <evidence>/config-overlay.yml right after --cwd, with no omp retry, no model fallback, no project MCP`, async () => {
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
    [404, FIELD_404, "provider-error"],
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
  });
});

describe("Fix A: a phase whose provider refuses with a non-retryable 4xx ends at once, named", () => {
  it("404 then a hanging omp: the plan phase fails within seconds as provider-error, one call, outcome reason provider-error", async () => {
    const w = await fresh();
    await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan", hang: true,
      rows: [{ type: "session", id: "s" }, { type: "agent_start" }, { type: "message_end", message: errored(404, FIELD_404) }] }));
    const started = Date.now();
    const failure = await failureOf(new OmpAdapter(await ompInstallation(w) as never, undefined, [5]).plan(w.context as never));
    const elapsed = Date.now() - started;
    // The installation allows 10 s and the idle watchdog min(10 min, 10 s): ending well before either is this fix.
    expect(elapsed).toBeLessThan(5_000);
    expect(failure).toMatchObject({ failureCause: { cause: "provider-error", retries: 0, detail: `HTTP 404: ${FIELD_404}` } });
    expect(String(failure)).toContain("omp-provider-error");
    expect((await outcomeOf(w, "plan")).reason).toBe("provider-error");
    expect(await readFile(`${w.marker}.calls`, "utf8")).toBe("plan\n");
  }, 30_000);

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

describe("Fix B: omp's stderr Warning: lines are an observation in outcome.json and collect", () => {
  const MCP_WARNING = "Warning: MCP server \"rea\" not ready after 2000ms; its tools are unavailable for this run.";

  it("the Warning: lines (only those) reach outcome.json and the call's collect transcript entry, which collect's schema accepts", async () => {
    const w = await fresh();
    await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan", stderr: `${MCP_WARNING}\nsome other line\nWarning: second\n` }));
    await new OmpAdapter(await ompInstallation(w) as never).plan(w.context as never);
    expect((await outcomeOf(w, "plan")).warnings).toEqual([MCP_WARNING, "Warning: second"]);
    const entries = await listTranscripts(w.dir, true);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.warnings).toEqual([MCP_WARNING, "Warning: second"]);
    const parsed = collectionSchema.parse({ events: [], candidate: null, terminal: null, progress: null, transcripts: entries });
    expect(parsed.transcripts![0]!.warnings).toEqual([MCP_WARNING, "Warning: second"]);
  }, 30_000);

  it("without a warning neither outcome.json nor the transcript entry has the key (no new bytes for a quiet call)", async () => {
    const w = await fresh();
    await new OmpAdapter(await ompInstallation(w) as never).plan(w.context as never);
    expect(Object.keys(await outcomeOf(w, "plan"))).not.toContain("warnings");
    const entries = await listTranscripts(w.dir, true);
    expect(Object.keys(entries[0]!)).not.toContain("warnings");
  }, 30_000);

  it("bounded: at most 16 lines, each at most 512 bytes", async () => {
    const w = await fresh();
    const lines = Array.from({ length: 20 }, (_, index) => `Warning: ${index} ${"é".repeat(index === 0 ? 400 : 1)}`);
    await writeFile(`${w.marker}.phase-script.json`, JSON.stringify({ phase: "plan", stderr: `${lines.join("\n")}\n` }));
    await new OmpAdapter(await ompInstallation(w) as never).plan(w.context as never);
    const warnings = (await outcomeOf(w, "plan")).warnings as string[];
    expect(warnings).toHaveLength(16);
    expect(warnings[1]).toBe(lines[1]);
    expect(Buffer.byteLength(warnings[0]!)).toBeLessThanOrEqual(512);
    expect(lines[0]!.startsWith(warnings[0]!)).toBe(true);
  }, 30_000);
});
