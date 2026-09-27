import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { ClaudeAgentAdapter, ClaudePhaseAborted, claudeRunnerPath } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { observedTokensOf, SingleCallOutputInvalid, type SingleCallRequest } from "../../../src/runtime/types.js";

// Orca single-call estimate (2026-09-27), spec §5.4 and §8.2 "adapter": ClaudeAgentAdapter.singleCall drives the claude CLI
// once through scripts/claude-phase-runner.mjs. As the stream-usage round's N7 did, these criteria read what the runner
// actually handed the CLI -- the fake records its argv, its cwd and CLAUDE_CODE_MAX_OUTPUT_TOKENS -- not the request.
const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const PROMPT = "Estimate the plan below.\n\n{\"planHash\":\"p\"}";
const dirs: string[] = [];
const groups: number[] = [];
afterEach(async () => {
  for (const pgid of groups.splice(0)) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function world(mode: "script" | "usage-then-hang" | "hang", script: unknown = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-single-call-"))); dirs.push(dir);
  const cwd = join(dir, "cwd"), runDir = join(dir, "run"), marker = join(dir, "marker.json"), scriptPath = join(dir, "script.json");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(runDir, { mode: 0o700 });
  await writeFile(scriptPath, JSON.stringify(script));
  const command: [string, ...string[]] = mode === "script" ? [process.execPath, fakeCli, mode, marker, scriptPath] : [process.execPath, fakeCli, mode, marker];
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command, version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
  };
  const registrations: Array<{ pid: number; pgid: number; startedAt: string; phase: string }> = [];
  const request = (extra: Partial<SingleCallRequest> = {}): SingleCallRequest => ({
    prompt: PROMPT, responseSchema: SCHEMA, maxOutputTokens: 2048, cwd, runDir, timeoutMs: 20_000,
    onProcessRegistered: async (registration) => { registrations.push(registration); groups.push(registration.pgid); },
    ...extra,
  });
  return { dir, cwd, runDir, marker, config, registrations, request };
}
const callDir = async (runDir: string) => {
  const root = join(runDir, "claude", "1", "single-call");
  const [call] = await readdir(root);
  return join(root, call!);
};
const argvOf = async (marker: string) => (await readFile(`${marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);

function runRunner(cwd: string, command: string[], request: unknown): Promise<{ code: number | null; stdout: string }> {
  const env: Record<string, string | undefined> = { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify(command), CCLOOP_CLAUDE_EXTRA_ARGS: "[]" };
  delete env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH;
  delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [claudeRunnerPath()], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(request));
  });
}

describe("ClaudeAgentAdapter.singleCall (Orca single-call estimate)", () => {
  it("S1: hands claude the request's schema, every tool off, the output cap and the empty cwd, and returns the answer with its usage", async () => {
    const w = await world("script", { "single-call": { output: { answer: "forty-two" } } });
    const result = await new ClaudeAgentAdapter(w.config).singleCall(w.request());
    expect(result).toMatchObject({ output: { answer: "forty-two" }, tokenUsage: 15 });
    const [argv] = await argvOf(w.marker);
    expect(JSON.parse(argv![argv!.indexOf("--json-schema") + 1]!)).toEqual(SCHEMA);
    expect(argv!.indexOf("--tools")).toBeGreaterThan(-1);
    expect(argv![argv!.indexOf("--tools") + 1]).toBe("");
    expect(argv!.at(-1)).toBe(PROMPT);
    const marker = JSON.parse(await readFile(w.marker, "utf8"));
    expect(marker.maxOutputTokensEnv).toBe("2048");
    expect(marker.cwd).toBe(w.cwd);
    expect(await readdir(w.cwd)).toEqual([]);
    expect(w.registrations.map((registration) => registration.phase)).toEqual(["single-call"]);
  }, 30_000);

  it("S2: an aborted call reports what claude streamed before the abort as its observed tokens", async () => {
    const w = await world("usage-then-hang");
    const abort = new AbortController();
    const running = new ClaudeAgentAdapter(w.config).singleCall(w.request({ signal: abort.signal })).then(() => null, (error: unknown) => error);
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(join(await callDir(w.runDir), "observed-usage.json"), "utf8")).openMessage === false; } catch { return false; }
    }, { timeout: 10_000 }).toBe(true);
    abort.abort();
    const error = await running;
    expect(error).toBeInstanceOf(ClaudePhaseAborted);
    expect(observedTokensOf(error)).toBe(1109);
  }, 30_000);

  it("S3: an aborted call that streamed nothing reports no observed tokens, not zero", async () => {
    const w = await world("hang");
    const abort = new AbortController();
    const running = new ClaudeAgentAdapter(w.config).singleCall(w.request({ signal: abort.signal })).then(() => null, (error: unknown) => error);
    await expect.poll(() => w.registrations.length, { timeout: 10_000 }).toBe(1);
    abort.abort();
    const error = await running;
    expect(error).toBeInstanceOf(ClaudePhaseAborted);
    expect(observedTokensOf(error)).toBeNull();
  }, 30_000);

  it("S4: a call that ends without a structured object is single-call-output-invalid and keeps its usage", async () => {
    const w = await world("script", { "single-call": { output: null } });
    const error = await new ClaudeAgentAdapter(w.config).singleCall(w.request()).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(SingleCallOutputInvalid);
    expect(error).toMatchObject({ code: "single-call-output-invalid", tokenUsage: 15 });
  }, 30_000);

  it("S5: stops at the request's time limit when it is shorter than the installation's", async () => {
    const w = await world("hang");
    const startedAt = Date.now();
    await expect(new ClaudeAgentAdapter(w.config).singleCall(w.request({ timeoutMs: 500 }))).rejects.toThrow(/^claude-timeout: /);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 30_000);

  // Final review of the single-call estimate (2026-09-28), C1: a call that ends any other way than completed or aborted
  // still spent what claude streamed before it ended; the error carries that observation so the worker can book it.
  it("S6: a call that times out after claude streamed a closed message reports that usage as its observed tokens", async () => {
    const w = await world("usage-then-hang");
    const error = await new ClaudeAgentAdapter(w.config).singleCall(w.request({ timeoutMs: 3_000 })).then(() => null, (e: unknown) => e);
    expect(String((error as Error).message)).toMatch(/^claude-timeout: /);
    expect(observedTokensOf(error)).toBe(1109);
  }, 30_000);

  it("S7: a call that exits with an error before streaming anything reports no observed tokens, not zero", async () => {
    const w = await world("script", {});
    const error = await new ClaudeAgentAdapter(w.config).singleCall(w.request()).then(() => null, (e: unknown) => e);
    expect(String((error as Error).message)).toMatch(/^claude-exit-error: /);
    expect(observedTokensOf(error)).toBeNull();
    expect((error as { observedTokens?: unknown }).observedTokens).toBeNull();
  }, 30_000);
});

describe("claude phase runner, single call (Orca single-call estimate)", () => {
  it("R1: starts claude in the request's cwd, not its own, with the cap from the request", async () => {
    const w = await world("script", { "single-call": { output: { answer: "a" } } });
    const elsewhere = join(w.dir, "elsewhere");
    await mkdir(elsewhere);
    const result = await runRunner(elsewhere, w.config.installation.command, { phase: "single-call", prompt: PROMPT, attempt: 1, runDir: w.runDir, cwd: w.cwd, schema: SCHEMA, maxOutputTokens: 7 });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ output: { answer: "a" }, outputError: null, tokenUsage: 15 });
    const marker = JSON.parse(await readFile(w.marker, "utf8"));
    expect(marker.cwd).toBe(w.cwd);
    expect(marker.maxOutputTokensEnv).toBe("7");
  }, 30_000);

  it("R2: gives a plan phase neither --tools nor an output cap", async () => {
    const w = await world("script", {});
    const result = await runRunner(w.cwd, [process.execPath, fakeCli, "ok", w.marker], { phase: "plan", prompt: "Plan one isolated L2 attempt for task t.", attempt: 1, runDir: w.runDir, worktreePath: w.cwd });
    expect(result.code).toBe(0);
    const [argv] = await argvOf(w.marker);
    expect(argv).not.toContain("--tools");
    expect(JSON.parse(await readFile(w.marker, "utf8")).maxOutputTokensEnv).toBeNull();
  }, 30_000);
});
