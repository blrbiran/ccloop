import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../src/runtime/codex/protocol.js";
import { attachedCause, classifyClaudeCall, classifyCodexCall, classifyOmpCall, claudeErrorCause, type ClaudeSignalsV1 } from "../../src/runtime/failureCause.js";
import { runWithTransientRetry, type TryResult } from "../../src/runtime/transientRetry.js";
import { observedTokensOf } from "../../src/runtime/types.js";
import { codexFixture } from "./codex/fixture.js";

// Failure causes (ccloop spec docs/superpowers/specs/2026-10-21-failure-causes-and-transient-retries-design.md). Orca keys
// its next-step text, agent fallback and escalation on these causes, and a transient retry spends money and time: a wrong
// class either retries a failure that cannot pass (auth, quota) or hides the real reason. So classification reads only
// typed fields and the CLI's own error rows -- model text that merely mentions a status must never be classified.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const settle = (promise: Promise<unknown>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
const codexRows = (message: string, extra: object[] = []) => [
  { type: "thread.started", thread_id: "t" }, { type: "turn.started" }, ...extra, { type: "error", message }, { type: "turn.failed", error: { message } },
].map(row => JSON.stringify(row)).join("\n") + "\n";
const signals = (fields: Partial<ClaudeSignalsV1>): ClaudeSignalsV1 => ({ schema: "ccloop-claude-signals-v1", assistantError: null, errorText: null, toolUses: 0, assistantMessages: 1, ...fields });

describe("test 1: classifier sample sets", () => {
  it.each([
    ["exceeded retry limit, last status: 429 Too Many Requests", "rate-limited"],
    ["exceeded retry limit, last status: 401 Unauthorized", "auth"],
    ["exceeded retry limit, last status: 403 Forbidden", "auth"],
    ["exceeded retry limit, last status: 402 Payment Required", "quota"],
    ["exceeded retry limit, last status: 503 Service Unavailable", "provider-5xx"],
    ["You've hit your usage limit. Upgrade to Pro", "quota"],
    ["Quota exceeded. Check your plan and billing details.", "quota"],
    ["Selected model is at capacity. Please try a different model.", "provider-5xx"],
    ["stream disconnected before completion: error sending request", "network"],
    ["Connection failed: tcp connect error", "network"],
    ["Error while reading the server response", "network"],
  ])("codex must-match: %s => %s", (message, cause) => {
    expect(classifyCodexCall(codexRows(message))?.cause).toBe(cause);
  });

  it("codex must-not-match: the same wording in an agent message, after turn.completed, or nowhere typed", () => {
    const inMessage = [{ type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: "last status: 429" } }, { type: "turn.failed", error: { message: "something else" } }]
      .map(row => JSON.stringify(row)).join("\n");
    expect(classifyCodexCall(inMessage)).toEqual({ cause: "unknown", workObserved: true, detail: "something else" });
    expect(classifyCodexCall(codexRows("exceeded retry limit, last status: 429", [])+JSON.stringify({ type: "turn.completed", usage: {} }))).toBeNull();
    const onlyModelText = [{ type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: "exceeded retry limit, last status: 429" } }].map(row => JSON.stringify(row)).join("\n");
    expect(classifyCodexCall(onlyModelText)).toEqual({ cause: "unknown", workObserved: true, detail: null });
    expect(classifyCodexCall("")).toEqual({ cause: "unknown", workObserved: false, detail: null });
    expect(classifyCodexCall(codexRows("an unrecognised failure"))?.cause).toBe("unknown");
  });

  it("codex workObserved: an item row or an unparseable line", () => {
    expect(classifyCodexCall(codexRows("last status: 503"))?.workObserved).toBe(false);
    expect(classifyCodexCall(codexRows("last status: 503", [{ type: "item.started", item: { id: "i" } }]))?.workObserved).toBe(true);
    expect(classifyCodexCall("not json\n" + codexRows("last status: 503"))?.workObserved).toBe(true);
  });

  it.each([
    ["authentication_failed", null, "auth"], ["oauth_org_not_allowed", null, "auth"], ["account_on_hold", null, "auth"],
    ["verification_required", null, "auth"], ["cloud_credential_error", null, "auth"], ["billing_error", null, "quota"],
    ["rate_limit", "Claude AI usage limit reached|1760000000", "quota"], ["rate_limit", "Your usage credit limit reached", "quota"],
    ["rate_limit", "Monthly spend limit reached", "quota"], ["rate_limit", "Rate limited, retry later", "rate-limited"],
    ["overloaded", null, "provider-5xx"], ["server_error", null, "provider-5xx"],
    ["invalid_request", "Prompt is too long: 250000 tokens > 200000 maximum", "context-overflow"],
    ["invalid_request", "input is too long for requested model", "context-overflow"],
    ["invalid_request", "messages: field required", "unknown"], ["max_output_tokens", null, "unknown"], ["a_new_value", null, "unknown"],
  ])("claude must-match/must-not-match: %s + %s => %s", (assistantError, errorText, cause) => {
    expect(claudeErrorCause(assistantError, errorText)).toBe(cause);
  });

  it("claude: no typed error is unknown even when other text names a limit; a missing signals file assumes work", () => {
    expect(classifyClaudeCall(signals({ errorText: "usage limit reached" })).cause).toBe("unknown");
    expect(classifyClaudeCall(signals({ assistantError: "overloaded", toolUses: 1 }))).toEqual({ cause: "provider-5xx", workObserved: true, detail: null });
    expect(classifyClaudeCall(null)).toEqual({ cause: "unknown", workObserved: true, detail: null });
  });

  it("omp v1: unknown, with the error message as detail and tool starts as work", () => {
    const events = [{ type: "tool_execution_start" }, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider 500" } }].map(row => JSON.stringify(row)).join("\n");
    expect(classifyOmpCall(events)).toEqual({ cause: "unknown", workObserved: true, detail: "provider 500" });
  });
});

describe("test 3/4: the shared retry loop (bounded, safe, and booking every try)", () => {
  const transient = (tokens: number | null, extra: object = {}): TryResult<{ tokenUsage?: number }> => ({
    ok: false, error: Object.assign(new Error("transient"), tokens === null ? {} : { observedTokens: tokens }, extra), evidenceDir: "/nonexistent",
    classification: { cause: "provider-5xx", workObserved: false, detail: null }, retrySafe: true,
    observation: (extra as { rateLimitedBeforeWork?: boolean }).rateLimitedBeforeWork ? { kind: "rule0" } : tokens === null ? { kind: "null" } : { kind: "tokens", tokens },
  });
  const run = (tries: Array<TryResult<{ tokenUsage?: number }>>, options: { limitMs?: number; delays?: number[]; signal?: AbortSignal } = {}) => {
    let calls = 0;
    const promise = runWithTransientRetry({ limitMs: options.limitMs ?? 60_000, delaysMs: options.delays ?? [5, 5, 5], signal: options.signal, attempt: async () => tries[calls++]! });
    return { promise, calls: () => calls };
  };

  it("retries a transient failure once and books both tries (7 + 5 = 12)", async () => {
    const r = run([transient(7), { ok: true, value: { tokenUsage: 5 }, evidenceDir: "/nonexistent" }]);
    expect(await r.promise).toEqual({ tokenUsage: 12 });
    expect(r.calls()).toBe(2);
  });

  it("gives up after three retries with the cause attached and the sum observed", async () => {
    const r = run([transient(1), transient(2), transient(3), transient(4)]);
    const out = await settle(r.promise) as { error: Error };
    expect(r.calls()).toBe(4);
    expect(attachedCause(out.error)).toEqual({ classification: { cause: "provider-5xx", workObserved: false, detail: null }, retries: 3 });
    expect(observedTokensOf(out.error)).toBe(10);
  });

  it("does not retry an unsafe try, a non-transient cause, or a delay that would pass the limit", async () => {
    const unsafe = run([{ ...transient(1), retrySafe: false } as TryResult<{ tokenUsage?: number }>, transient(1)]);
    await settle(unsafe.promise); expect(unsafe.calls()).toBe(1);
    const auth = run([{ ...transient(1), classification: { cause: "auth", workObserved: false, detail: null } } as TryResult<{ tokenUsage?: number }>, transient(1)]);
    await settle(auth.promise); expect(auth.calls()).toBe(1);
    const late = run([transient(1), transient(1)], { limitMs: 100, delays: [500] });
    await settle(late.promise); expect(late.calls()).toBe(1);
  });

  it("an abort during the wait stops the loop without waiting the delay", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    const aborted = runWithTransientRetry({ limitMs: 60_000, delaysMs: [10_000], signal: controller.signal, attempt: async (_limit, call) => (call === 1 ? transient(1) : { ...transient(1), classification: null }) });
    await settle(aborted);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("usage edge cases: all unobserved => null; spend then 429-before-work => the spend, without the zero flag", async () => {
    const allNull = await settle(run([transient(null), transient(null), transient(null), transient(null)]).promise) as { error: Error };
    expect(observedTokensOf(allNull.error)).toBeNull();
    // The raw field, not only observedTokensOf (which also reads 0 as unobserved): an all-unobserved phase is null, never 0.
    expect((allNull.error as { observedTokens?: unknown }).observedTokens).toBeNull();
    const spendThen429 = await settle(run([transient(7), transient(null, { rateLimitedBeforeWork: true }), transient(null, { rateLimitedBeforeWork: true }), transient(null, { rateLimitedBeforeWork: true })]).promise) as { error: Error & { rateLimitedBeforeWork?: boolean } };
    expect(observedTokensOf(spendThen429.error)).toBe(7);
    expect(spendThen429.error.rateLimitedBeforeWork).toBeUndefined();
    const all429 = await settle(run([transient(null, { rateLimitedBeforeWork: true }), transient(null, { rateLimitedBeforeWork: true })], { delays: [5] }).promise) as { error: Error };
    expect(observedTokensOf(all429.error)).toBe(0);
  });
});

describe("adapters: transient failures are retried only where the call could not have changed the worktree", () => {
  async function codex(mode: string, perAttemptTimeoutMs?: number) {
    const f = await codexFixture(mode);
    dirs.push(f.dir);
    if (perAttemptTimeoutMs !== undefined) f.config.timeoutMs = 60_000;
    const a = new CodexAdapter(parseCodexConfig(f.config), undefined, undefined, { rateLimitDelaysMs: [300, 300, 300] });
    const contract = perAttemptTimeoutMs === undefined ? f.context.contract : { ...f.context.contract, executionPolicy: { ...f.context.contract.executionPolicy, perAttemptTimeoutMs } };
    return { ...f, a, context: { ...f.context, contract }, calls: async () => (await readFile(f.marker + ".argv", "utf8")).trim().split("\n").length };
  }

  it("codex plan: a 503 is retried and the call records failure-cause.json", async () => {
    const f = await codex("error-503-1");
    expect(await settle(f.a.plan(f.context))).toHaveProperty("value");
    expect(await f.calls()).toBe(2);
    const callDirs = await readdir(join(f.runDir, "codex", "1", "plan"));
    const records = await Promise.all(callDirs.map(dir => readFile(join(f.runDir, "codex", "1", "plan", dir, "failure-cause.json"), "utf8").then(JSON.parse, () => null)));
    expect(records.filter(Boolean)).toEqual([{ cause: "provider-5xx", workObserved: false, call: 1, nextDelayMs: 300, detail: "exceeded retry limit, last status: 503 Service Unavailable", usageObserved: false }]);
  });

  it("codex execute after observed work: one call, the run ends with the cause", async () => {
    const f = await codex("error-503-after-item");
    const out = await settle(f.a.execute(f.context)) as { error: Error };
    expect(await f.calls()).toBe(1);
    expect(attachedCause(out.error)?.classification.cause).toBe("provider-5xx");
  });

  it("codex: the second try's timer is perAttemptTimeoutMs minus what elapsed, not a fresh installation timeout", async () => {
    const f = await codex("rate-limit-1-hang", 2_500);
    const started = Date.now();
    const out = await settle(f.a.plan(f.context)) as { error: Error };
    const elapsed = Date.now() - started;
    expect(String(out.error.message)).toMatch(/^codex-timeout: /);
    expect(await f.calls()).toBe(2);
    expect(elapsed).toBeLessThan(4_500);
  }, 30_000);

  const fakeCli = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));
  async function claude(mode: string, errorText?: string) {
    const f = await codexFixture("unused");
    dirs.push(f.dir);
    const marker = join(f.dir, "claude-marker.json");
    if (errorText !== undefined) await writeFile(`${marker}.error-text`, errorText);
    const config: MaterializedAgentConfigV1 = {
      schema: "ccloop-agent-config-v1", kind: "claude",
      installation: { kind: "claude", command: [process.execPath, fakeCli, mode, marker], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
      selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
    };
    return { ...f, a: new ClaudeAgentAdapter(config, { retryDelaysMs: [200, 200, 200] }), calls: async () => (await readFile(`${marker}.argv`, "utf8")).trim().split("\n").length };
  }

  it("claude plan: an overloaded answer with no tool use is retried", async () => {
    const f = await claude("api-error-overloaded-once");
    expect(await settle(f.a.plan(f.context))).toHaveProperty("value");
    expect(await f.calls()).toBe(2);
  }, 30_000);

  it("claude plan: a tool use before the error means work observed -- one call, cause kept", async () => {
    const f = await claude("api-error-overloaded-tool");
    const out = await settle(f.a.plan(f.context)) as { error: Error };
    expect(await f.calls()).toBe(1);
    expect(attachedCause(out.error)?.classification).toMatchObject({ cause: "provider-5xx", workObserved: true });
  }, 30_000);

  it("claude: auth is never retried; rate_limit with a plan-limit phrase is quota", async () => {
    const auth = await claude("api-error-authentication_failed-all");
    const authOut = await settle(auth.a.plan(auth.context)) as { error: Error };
    expect([await auth.calls(), attachedCause(authOut.error)?.classification.cause]).toEqual([1, "auth"]);
    const quota = await claude("api-error-rate_limit-all", "Claude AI usage limit reached|1760000000");
    const quotaOut = await settle(quota.a.plan(quota.context)) as { error: Error };
    expect([await quota.calls(), attachedCause(quotaOut.error)?.classification.cause]).toEqual([1, "quota"]);
  }, 30_000);
});
