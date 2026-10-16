import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentCatalog } from "../../../src/agents/agentCatalog.js";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { OmpAdapter } from "../../../src/runtime/omp/ompAdapter.js";
import { OMP_SINGLE_CALL_OVERLAY, decodeOmpSingleCall, parseSingleCallObject, runOmpSingleCall } from "../../../src/runtime/omp/ompSingleCall.js";
import { observedTokensOf, SingleCallOutputInvalid, type SingleCallRequest } from "../../../src/runtime/types.js";

// OMP single call (Orca spec 2026-10-14-omp-single-call-design.md §3.3). Orca books the catalog cap as the call's output
// bound; omp cannot take a per-call cap, so a cap that rose above the request's must refuse the call before anything is
// sent (criterion 3), and the call must run with every tool, rule and LSP off, under the overlay that switches omp's own
// retries and model switches off (criterion 4) -- otherwise one booked request could become several, or a tool run.
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs");
const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
// Every-agent requirement chain (Task 4 fix round 1): the spawn-time re-check prints `ccloop-agent-catalog:` lines on the
// worker's stderr (plan issue 3); in-process calls here would print them into the test output, so each test captures them
// in `catalogLines` and passes every other write through.
let catalogLines: string[] = [];
beforeEach(() => {
  catalogLines = [];
  const write = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    if (String(chunk).startsWith("ccloop-agent-catalog:")) { catalogLines.push(String(chunk)); return true; }
    return write(chunk, ...rest);
  }) as typeof process.stderr.write);
});
afterEach(() => { vi.restoreAllMocks(); });

async function ompWorld(options: { catalog?: unknown; single?: unknown; installationTimeoutMs?: number } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-single-")));
  dirs.push(dir);
  const marker = join(dir, "omp-marker");
  if (options.catalog !== undefined) await writeFile(`${marker}.catalog.json`, JSON.stringify(options.catalog));
  if (options.single !== undefined) await writeFile(`${marker}.single.json`, JSON.stringify(options.single));
  const binary = join(dir, "omp");
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${marker}' "$@"\n`, { mode: 0o700 });
  const runDir = join(dir, "run");
  const cwd = join(runDir, "cwd");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "omp",
    installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: options.installationTimeoutMs ?? 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
    selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" },
  };
  const request = (over: Partial<SingleCallRequest> = {}): SingleCallRequest => ({
    prompt: "Estimate the plan below.", responseSchema: SCHEMA, maxOutputTokens: 8_192, cwd, runDir, timeoutMs: 60_000, ...over,
  });
  return { dir, marker, binary, config, request };
}
const modelA = (numbers: Record<string, unknown>) => ({ provider: "gateway", kind: "chat", id: "model-a", selector: "gateway/model-a", contextWindow: 200000, ...numbers });
const failureOf = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error);

describe("spawn-time check (§3.3.1, criterion 3)", () => {
  it("C3: refuses before spawning when the catalog cap exceeds the request's maxOutputTokens, booking 0", async () => {
    const w = await ompWorld({ catalog: [modelA({ maxTokens: 8192 })] });
    const failure = await failureOf(runOmpSingleCall(w.config, w.request({ maxOutputTokens: 4_096 })));
    expect(failure).toMatchObject({ code: "omp-single-call-cap-exceeded", neverStarted: true });
    expect(observedTokensOf(failure)).toBe(0);
    expect(existsSync(`${w.marker}.calls`)).toBe(false);
  });

  it("C3: runs when the catalog cap equals the request's maxOutputTokens", async () => {
    const w = await ompWorld({ catalog: [modelA({ maxTokens: 8192 })] });
    const outcome = await runOmpSingleCall(w.config, w.request({ maxOutputTokens: 8_192 }));
    expect(outcome).toMatchObject({ reason: "completed", neverStarted: false });
    expect(await readFile(`${w.marker}.calls`, "utf8")).toBe("single-call\n");
  });

  it("refuses as unavailable, never started, when the row lost its cap, the model left the catalog, or the catalog cannot be read", async () => {
    for (const catalog of [[modelA({})], [{ ...modelA({ maxTokens: 8192 }), id: "other", selector: "gateway/other" }], "not rows"]) {
      const w = await ompWorld({ catalog });
      const failure = await failureOf(runOmpSingleCall(w.config, w.request()));
      expect([catalog, failure]).toEqual([catalog, expect.objectContaining({ code: "omp-single-call-unavailable", neverStarted: true })]);
      expect(observedTokensOf(failure)).toBe(0);
      expect(existsSync(`${w.marker}.calls`)).toBe(false);
    }
  }, 20_000);

  // Controller ruling (Task 4, Review Focus 2): a catalog probe that exits non-zero or prints no JSON at spawn time is
  // the same refusal, and no model process is spawned -- proved by the fake's own call log, not only by the error code.
  it("refuses as unavailable, never started, when the catalog probe exits non-zero or prints bad JSON", async () => {
    for (const probe of ["exit 3", "printf 'not json\\n'; exit 0"]) {
      const w = await ompWorld();
      await writeFile(w.binary, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = models ]; then ${probe}; fi; done\nexec '${process.execPath}' '${FAKE_OMP}' '${w.marker}' "$@"\n`, { mode: 0o700 });
      const failure = await failureOf(runOmpSingleCall(w.config, w.request()));
      expect([probe, failure]).toEqual([probe, expect.objectContaining({ code: "omp-single-call-unavailable", neverStarted: true })]);
      expect(observedTokensOf(failure)).toBe(0);
      expect(existsSync(`${w.marker}.calls`)).toBe(false);
      expect(existsSync(`${w.marker}.argv`)).toBe(false);
    }
  }, 20_000);
});

describe("argv (§3.3.2-§3.3.4, criterion 4)", () => {
  it("C4: passes exactly the single-call argv: tools, rules and LSP off, no --tools list, the overlay, the request's cwd", async () => {
    const w = await ompWorld();
    const request = w.request();
    await runOmpSingleCall(w.config, request);
    const [argv] = (await readFile(`${w.marker}.argv`, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(argv).toEqual([
      "--profile", "default", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-tools",
      "--no-session", "--no-title", "--no-prewalk", "--model", "gateway/model-a", "--mode", "json", "-p",
      "--system-prompt", expect.stringMatching(/\/run\/omp\/1\/single-call\/call-[^/]+\/system-prompt\.md$/),
      "--cwd", request.cwd,
      "--config", expect.stringMatching(/\/run\/omp\/1\/single-call\/call-[^/]+\/config-overlay\.yml$/),
    ]);
    expect(argv).not.toContain("--tools");
    expect(JSON.parse(await readFile(argv![argv!.indexOf("--config") + 1]!, "utf8"))).toEqual(OMP_SINGLE_CALL_OVERLAY);
    const system = await readFile(argv![argv!.indexOf("--system-prompt") + 1]!, "utf8");
    expect(system).toContain("one ccloop single call");
    expect(system).toContain(JSON.stringify(SCHEMA));
  });
});

// Controller ruling (Task 4 review): an openrouter row has a cap but pi-ai sends none for it, so the spawn-time check
// must refuse it as unavailable even when its cap fits -- otherwise the booked bound would not bind the call.
describe("spawn-time check, openrouter (§3.3.1)", () => {
  it("refuses an openrouter row as unavailable, never started, even when its cap fits", async () => {
    const w = await ompWorld({ catalog: [{ provider: "openrouter", kind: "chat", id: "vendor/m", selector: "openrouter/vendor/m", contextWindow: 200000, maxTokens: 4096 }] });
    const config: MaterializedAgentConfigV1 = { ...w.config, selection: { ...w.config.selection, model: "openrouter/vendor/m" } };
    const failure = await failureOf(runOmpSingleCall(config, w.request({ maxOutputTokens: 8_192 })));
    expect(failure).toMatchObject({ code: "omp-single-call-unavailable", neverStarted: true });
    expect(observedTokensOf(failure)).toBe(0);
    expect(existsSync(`${w.marker}.calls`)).toBe(false);
  });
});

// Controller ruling (Task 4 review): the call's evidence holds the prompt's schema and the overlay; it is private to the
// operator, as every other evidence directory is -- the modes are set explicitly, never left to the umask.
describe("evidence modes (§3.3.2)", () => {
  it("keeps the call's evidence directory 0700 and its overlay and system prompt 0600", async () => {
    const w = await ompWorld();
    await runOmpSingleCall(w.config, w.request());
    const [argv] = (await readFile(`${w.marker}.argv`, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as string[]);
    const systemPath = argv![argv!.indexOf("--system-prompt") + 1]!;
    const overlayPath = argv![argv!.indexOf("--config") + 1]!;
    const mode = async (path: string) => (await stat(path)).mode & 0o777;
    expect([await mode(dirname(systemPath)), await mode(systemPath), await mode(overlayPath)]).toEqual([0o700, 0o600, 0o600]);
    expect(dirname(overlayPath)).toBe(dirname(systemPath));
  });
});

const usage = { input: 8, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (over: Record<string, unknown> = {}) => ({ role: "assistant", content: [{ type: "text", text: "{\"answer\":\"42\"}" }], provider: "gateway", model: "model-a", stopReason: "stop", usage, ...over });
const end = (m: unknown) => ({ type: "message_end", message: m });
const lines = (...rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const decodeFailure = (events: string): unknown => { try { decodeOmpSingleCall(events, "gateway/model-a", "/evidence"); return null; } catch (error) { return error; } };

describe("decode (§3.3.5, criterion 5): one request, no tool, the selected model", () => {
  it("decodes one complete answer with its usage and per-model breakdown", () => {
    expect(decodeOmpSingleCall(lines({ type: "agent_start" }, end(message()), { type: "agent_end", isTerminal: true }), "gateway/model-a", "/evidence")).toEqual({
      output: { answer: "42" }, tokenUsage: 14,
      usageEvidence: expect.objectContaining({ usageStatus: "present", normalizedTotal: 14 }),
      modelUsage: [{ model: "gateway/model-a", input: 8, output: 2, cacheRead: 3, cacheWrite: 1 }],
    });
  });

  it("C5: refuses two assistant messages as multiple requests, booking both", () => {
    expect(decodeFailure(lines(end(message()), end(message())))).toMatchObject({ message: "omp-single-call-multiple-requests", observedTokens: 28 });
  });

  it("C5: refuses a tool event even beside a complete answer, booking what was spent", () => {
    expect(decodeFailure(lines({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, end(message())))).toMatchObject({ message: "omp-phase-tool-forbidden", observedTokens: 14 });
  });

  it("C5: refuses an extension UI request or a subagent event like a tool event", () => {
    expect(decodeFailure(lines({ type: "extension_ui_request" }, end(message())))).toMatchObject({ message: "omp-phase-tool-forbidden", observedTokens: 14 });
    expect(decodeFailure(lines({ type: "subagent_start" }, end(message())))).toMatchObject({ message: "omp-phase-tool-forbidden", observedTokens: 14 });
  });

  it("C5: refuses an answer from a different model, booking what was spent", () => {
    expect(decodeFailure(lines(end(message({ model: "model-b" }))))).toMatchObject({ message: "omp-model-mismatch", observedTokens: 14 });
  });

  it("books null when there is no assistant message or its usage is not readable", () => {
    for (const events of [lines({ type: "agent_start" }), lines(end(message({ usage: { ...usage, totalTokens: 15 } }))), "not json\n"]) {
      expect(observedTokensOf(decodeFailure(events))).toBeNull();
    }
  });
});

describe("stop reasons (§3.3.5, criterion 6)", () => {
  it("C6: a length stop is an output-invalid answer that still books the observed usage", () => {
    const failure = decodeFailure(lines(end(message({ stopReason: "length", content: [{ type: "text", text: "{\"answer\":\"4\"}" }] }))));
    expect(failure).toBeInstanceOf(SingleCallOutputInvalid);
    expect(failure).toMatchObject({ code: "single-call-output-invalid", tokenUsage: 14, usageEvidence: expect.objectContaining({ normalizedTotal: 14 }) });
  });

  it("C6: another stop reason is the named failure, booking the observed usage", () => {
    for (const stopReason of ["error", "toolUse", "aborted"]) {
      expect([stopReason, decodeFailure(lines(end(message({ stopReason }))))]).toEqual([stopReason, expect.objectContaining({ code: `omp-single-call-stop:${stopReason}`, observedTokens: 14 })]);
    }
  });

  it("keeps the failure code bounded when the stop reason is not a short word", () => {
    for (const stopReason of [{ nested: true }, "x".repeat(33), "has space"]) {
      expect(decodeFailure(lines(end(message({ stopReason }))))).toMatchObject({ code: "omp-single-call-stop:invalid" });
    }
  });
});

describe("output rule (§3.3.6, criterion 7)", () => {
  it("C7: only one plain object, with at most one fence around it, is an answer", () => {
    expect(parseSingleCallObject("[{\"answer\":\"42\"}]")).toBeUndefined();
    expect(parseSingleCallObject("42")).toBeUndefined();
    expect(parseSingleCallObject("null")).toBeUndefined();
    expect(parseSingleCallObject("Here: {\"answer\":\"4\"} and {\"answer\":\"2\"}")).toBeUndefined();
    expect(parseSingleCallObject("```json\n{\"a\":1}\n```\n```json\n{\"a\":2}\n```")).toBeUndefined();
    expect(parseSingleCallObject("```json\n{\"answer\":\"42\"}\n```")).toEqual({ answer: "42" });
    expect(parseSingleCallObject("  {\"answer\":\"42\"}\n")).toEqual({ answer: "42" });
  });

  it("C7: an answer that is not one object is output-invalid and books what the call spent", () => {
    for (const text of ["[{\"answer\":\"42\"}]", "42", ""]) {
      const failure = decodeFailure(lines(end(message({ content: [{ type: "text", text }] }))));
      expect([text, failure instanceof SingleCallOutputInvalid, (failure as { tokenUsage?: unknown } | null)?.tokenUsage]).toEqual([text, true, 14]);
    }
  });
});

describe("OmpAdapter.singleCall (§3.3, §3.3.7)", () => {
  it("returns the fake's answer through the real process path", async () => {
    const w = await ompWorld();
    await expect(new OmpAdapter(w.config).singleCall(w.request())).resolves.toMatchObject({ output: { answer: "42" }, tokenUsage: 14 });
  });

  it("books null when omp exits non-zero after a complete message, and uses none of it", async () => {
    const w = await ompWorld({ single: { exitCode: 3 } });
    const failure = await failureOf(new OmpAdapter(w.config).singleCall(w.request()));
    expect((failure as Error).message).toMatch(/^omp-exit-error: /);
    expect(observedTokensOf(failure)).toBeNull();
  });

  // Ruling: human named this criterion in Orca session a852f96a, 2026-10-16 — the spawn-time re-check shares the call's
  // deadline (spec 2026-10-15 §4.3, R6), so a cold cache spends it; the cold case is pinned by the next criterion.
  // Rewritten whole: the cache is warmed first, so the 300 ms belong to the call itself, which must be spawned and stopped.
  it("stops the call at the request's time limit when it is below the installation's", async () => {
    const w = await ompWorld({ single: { hang: true }, installationTimeoutMs: 30_000 });
    expect((await readAgentCatalog(w.config.installation)).catalogError).toBeNull();
    const started = Date.now();
    const failure = await failureOf(new OmpAdapter(w.config).singleCall(w.request({ timeoutMs: 300 })));
    expect((failure as Error).message).toMatch(/^omp-timeout: /);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(observedTokensOf(failure)).toBeNull();
    expect(await readFile(`${w.marker}.calls`, "utf8")).toBe("single-call\n");
  });

  // Every-agent requirement chain (Orca spec 2026-10-15 §4.3, R6): on a cold cache the re-check's probes share the call's
  // own deadline; a probe that outlives it refuses the call before anything is sent, naming stage and elapsed time.
  it("refuses before spawning, naming stage and elapsed time, when a cold re-check outlives the call's deadline", async () => {
    const w = await ompWorld({ installationTimeoutMs: 30_000 });
    await writeFile(`${w.marker}.models.json`, JSON.stringify({ sleepMs: 10_000 }));
    const started = Date.now();
    const failure = await failureOf(runOmpSingleCall(w.config, w.request({ timeoutMs: 1_000 })));
    expect(failure).toMatchObject({ code: "omp-single-call-unavailable", neverStarted: true });
    expect((failure as Error).message).toMatch(/^omp-single-call-unavailable: catalog omp-model-catalog-unavailable: timeout \d+ms · stage timeout · elapsedMs \d+$/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(observedTokensOf(failure)).toBe(0);
    expect(existsSync(`${w.marker}.calls`)).toBe(false);
    expect(catalogLines).toEqual([
      expect.stringMatching(/^ccloop-agent-catalog: miss omp [0-9a-f]{12}\n$/),
      expect.stringMatching(/^ccloop-agent-catalog: probe-failed omp omp-model-catalog-unavailable: timeout \d+ms · stage timeout · elapsedMs \d+\n$/),
    ]);
  }, 20_000);

  // Task 4 fix round 1 (spec R6): the re-check and the call share ONE deadline. A cold re-check that takes over 2 s of a 6 s
  // limit leaves the hanging call the rest, so the whole call ends near 6 s -- not 2 s + another full 6 s (~8.5 s).
  it("stops a call after a slow cold re-check at the original deadline, not a fresh full limit", async () => {
    const w = await ompWorld({ single: { hang: true }, installationTimeoutMs: 30_000 });
    await writeFile(`${w.marker}.models.json`, JSON.stringify({ sleepMs: 2_000 }));
    const started = Date.now();
    const failure = await failureOf(new OmpAdapter(w.config).singleCall(w.request({ timeoutMs: 6_000 })));
    const elapsed = Date.now() - started;
    expect((failure as Error).message).toMatch(/^omp-timeout: /);
    expect(observedTokensOf(failure)).toBeNull();
    expect(await readFile(`${w.marker}.calls`, "utf8")).toBe("single-call\n");
    expect(elapsed).toBeGreaterThanOrEqual(5_900);
    expect(elapsed).toBeLessThan(7_500);
    expect(catalogLines).toEqual([expect.stringMatching(/^ccloop-agent-catalog: miss omp [0-9a-f]{12}\n$/)]);
  }, 20_000);
});

// Fix round 1 (Orca session 02f047f6, 2026-10-14). Real omp 18.10.1 (measured in Task 0) prints the assistant message
// three times -- message_start, message_end and turn_end all carry it with the same usage. Only message_end is the
// request; counting every event that carries an assistant message would book one call two or three times over (and
// refuse it as "multiple requests").
describe("decode, real omp event shape (§3.3.5, §3.3.7)", () => {
  it("decodes the real stream's one assistant message once, with its usage not doubled", () => {
    const user = { role: "user", content: [{ type: "text", text: "Estimate the plan below." }] };
    const answer = message();
    const events = lines(
      { type: "session", id: "s1" }, { type: "agent_start" }, { type: "turn_start" },
      { type: "message_start", message: user }, { type: "message_end", message: user },
      { type: "message_start", message: answer },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "{\"answer\":" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "\"42\"}" } },
      { type: "message_end", message: answer },
      { type: "turn_end", message: answer, toolResults: [] },
      { type: "agent_end", isTerminal: true, messages: [user, answer] },
    );
    expect(decodeOmpSingleCall(events, "gateway/model-a", "/evidence")).toEqual({
      output: { answer: "42" }, tokenUsage: 14,
      usageEvidence: expect.objectContaining({ usageStatus: "present", normalizedTotal: 14 }),
      modelUsage: [{ model: "gateway/model-a", input: 8, output: 2, cacheRead: 3, cacheWrite: 1 }],
    });
  });
});

// Fix round 1 (Orca session 02f047f6, 2026-10-14). Review Focus 3: an aborted call did not end cleanly, so even a
// complete assistant message already printed is neither booked (null, §3.3.7) nor used -- the stop was ours, and what
// omp would have printed next is unknown.
describe("OmpAdapter.singleCall, abort after a complete message (§3.3.7)", () => {
  it("books null and uses no output when the request is aborted after a complete message_end", async () => {
    const w = await ompWorld({ single: { holdOpen: true } });
    const controller = new AbortController();
    const root = join(w.request().runDir, "omp", "1", "single-call");
    const pending = failureOf(new OmpAdapter(w.config).singleCall(w.request({ signal: controller.signal })));
    // Abort only once ccloop itself has received the complete message (its events file holds the message_end).
    const received = async (): Promise<boolean> => {
      for (const name of existsSync(root) ? await readdir(root) : []) {
        const path = join(root, name, "events.jsonl");
        if (existsSync(path) && (await readFile(path, "utf8")).includes("\"message_end\"")) return true;
      }
      return false;
    };
    const deadline = Date.now() + 8_000;
    while (!(await received()) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
    expect(await received()).toBe(true);
    controller.abort();
    const failure = await pending;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^omp-aborted: /);
    expect(failure).not.toHaveProperty("output");
    expect(observedTokensOf(failure)).toBeNull();
  }, 15_000);
});

// Fix round 1 (Orca session 02f047f6, 2026-10-14). The diagnostic files are evidence only: a failed write of one must
// not replace the refusal it describes, or the booking that refusal carries would be lost (a model-mismatch spent 14).
describe("OmpAdapter.singleCall, diagnostic writes are best-effort", () => {
  it("keeps the decode refusal and its booking when decode-error.txt cannot be written", async () => {
    const answer = message({ model: "model-b" });
    const w = await ompWorld({ single: { blockFiles: ["decode-error.txt"], rows: [{ type: "agent_start" }, end(answer), { type: "agent_end", isTerminal: true, messages: [answer] }] } });
    const failure = await failureOf(new OmpAdapter(w.config).singleCall(w.request()));
    expect(failure).toMatchObject({ message: "omp-model-mismatch", observedTokens: 14 });
  });

  it("keeps the process refusal when usage-lower-bound.json cannot be written", async () => {
    const w = await ompWorld({ single: { exitCode: 3, blockFiles: ["usage-lower-bound.json"] } });
    const failure = await failureOf(new OmpAdapter(w.config).singleCall(w.request()));
    expect((failure as Error).message).toMatch(/^omp-exit-error: /);
    expect(observedTokensOf(failure)).toBeNull();
  });
});

// Final fix wave (Orca session 02f047f6, 2026-10-14). usage.json is evidence of an answer already decoded and observed:
// a failed write of it must not turn that good answer into a failure, which would book null instead of the 14 spent.
describe("OmpAdapter.singleCall, the usage evidence write is best-effort", () => {
  it("returns the decoded answer and its observed usage when usage.json cannot be written", async () => {
    const w = await ompWorld({ single: { blockFiles: ["usage.json"] } });
    await expect(new OmpAdapter(w.config).singleCall(w.request())).resolves.toMatchObject({
      output: { answer: "42" }, tokenUsage: 14, usageEvidence: expect.objectContaining({ usageStatus: "present", normalizedTotal: 14 }),
    });
  });
});
