// Per-contract tool rules (ccloop spec 2026-10-22 §8 T1): drives each real adapter's plan/execute/verify against the
// existing fakes and records the argv it sent, normalised. The adapters come in as `modules`, so the same harness ran
// the code at 2a2ae53 in a clone (goldens under golden-2a2ae53/, see its README) and runs the code under test here.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fixtures = fileURLToPath(new URL("..", import.meta.url));
export const FAKE_CLAUDE = join(fixtures, "fake-claude-cli.mjs");
export const FAKE_CODEX = join(fixtures, "fake-codex.mjs");
export const FAKE_OMP = join(fixtures, "fake-omp.mjs");

/* eslint-disable @typescript-eslint/no-explicit-any */
export type CaptureModules = {
  loopContractSchema: { parse(value: unknown): any };
  canonicalJson(value: unknown): string;
  ClaudeAgentAdapter: new (config: any, options?: any) => any;
  CodexAdapter: new (raw: unknown, extraEnv?: Record<string, string>, codexSkillsDir?: string, options?: any) => any;
  OmpAdapter: new (config: any) => any;
  buildExecutorPrompt(context: any): string;
};
export type Phase = "plan" | "execute" | "verify";
export const PHASES: readonly Phase[] = ["plan", "execute", "verify"];

/** The one contract every golden is captured with: two required checks, no toolRules. */
export const RAW_CONTRACT = {
  objective: { taskId: "tool-rules-golden", goal: "Set answer.txt to 42", successCondition: "answer is 42" },
  context: { repoPath: "/repo", targetPaths: ["answer.txt"], buildTestCommands: ["npm test"] },
  executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 15000, totalRuntimeBudgetMs: 60000, tokenBudget: 100000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
  safetyPolicy: { allowlistPaths: ["answer.txt"], maxFilesTouched: 1 },
  verification: { verifierType: "agent", requiredChecks: ["npm test", "npm run lint"], rejectOn: ["answer differs"] },
  escalationAndExit: {},
};

export type World = { dir: string; repo: string; runDir: string; marker: string; contract: any; context: any };

/** A git repo with answer.txt, a run dir and a context for attempt 1 (the shape of tests/runtime/codex/fixture.ts). */
export async function world(m: CaptureModules, raw: unknown = RAW_CONTRACT): Promise<World> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tool-rules-")));
  const repo = join(dir, "repo"), runDir = join(dir, "run");
  await mkdir(repo);
  for (const args of [["init"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"]]) await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "answer.txt"), "0\n");
  await exec("git", ["add", "answer.txt"], { cwd: repo });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repo });
  const contract = m.loopContractSchema.parse(structuredClone(raw));
  const context = { contract, runDir, attempt: 1, worktreePath: repo,
    state: { status: "planning", currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-10-22T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
      budgetSnapshot: { attemptsRemaining: 0, timeRemainingMs: 60000, tokenBudgetRemaining: 100000 }, recentFailures: [] } };
  return { dir, repo, runDir, marker: join(dir, "marker"), contract, context };
}

export async function dispose(w: World): Promise<void> { await rm(w.dir, { recursive: true, force: true }); }

/** Fixture dir, HOME, call-dir suffixes and the prompt become placeholders; nothing else is touched. */
export function normalise(args: readonly string[], w: World, extra: Record<string, string> = {}): string[] {
  const home = process.env.HOME ?? "\u0000no-home";
  return args.map((arg) => {
    if (arg.includes(w.context.contract.objective.taskId) && arg.length > 200) return "<prompt>";
    let out = arg;
    for (const [from, to] of Object.entries(extra)) out = out.split(from).join(to);
    out = out.split(w.dir).join("<dir>").split(home).join("<home>");
    return out.replace(/call-[A-Za-z0-9]{6}/g, "call-<id>");
  });
}

async function onlyCall(root: string): Promise<string> {
  const calls = (await readdir(root)).filter((name) => name.startsWith("call-"));
  if (calls.length !== 1) throw new Error(`expected one call under ${root}, found ${calls.length}`);
  return join(root, calls[0]!);
}

export type ClaudeOptions = { installationArgs?: string[] };
/** claude: the argv the fake received (after its mode and marker) and outcome.json's extraArgs. */
export async function captureClaude(m: CaptureModules, phase: Phase, w: World, options: ClaudeOptions = {}): Promise<{ argv: string[]; extraArgs: string[]; outcome: Record<string, unknown> }> {
  const config = { schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, FAKE_CLAUDE, "ok", w.marker, ...(options.installationArgs ?? ["--strict-mcp-config", "--disable-slash-commands"])], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } };
  await new m.ClaudeAgentAdapter(config)[phase](w.context);
  const lines = (await readFile(`${w.marker}.argv`, "utf8")).trim().split("\n");
  const argv = JSON.parse(lines.at(-1)!) as string[];
  const outcome = JSON.parse(await readFile(join(await onlyCall(join(w.runDir, "claude", "1", phase)), "outcome.json"), "utf8")) as Record<string, unknown>;
  return { argv: normalise(argv, w), extraArgs: normalise(outcome.extraArgs as string[], w), outcome };
}

export type CodexOptions = { sandbox?: "read-only" | "workspace-write"; configToml?: string | null };
/**
 * codex: outcome.json's args from `exec` on, on the legacy path (no installation) and the isolated path (an installation,
 * private homes under a temp CCLOOP_CACHE_DIR; CODEX_HOME points at a source dir holding `configToml`, absent when null).
 */
export async function captureCodex(m: CaptureModules, phase: Phase, w: World, isolated: boolean, options: CodexOptions = {}): Promise<{ args: string[]; outcome: Record<string, unknown> }> {
  const sandbox = options.sandbox ?? "workspace-write";
  const source = join(w.dir, "source-codex-home");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "auth.json"), "{}");
  if (options.configToml !== null) await writeFile(join(source, "config.toml"), options.configToml ?? "");
  const cache = join(w.dir, "cache");
  const raw = { command: [process.execPath, FAKE_CODEX, "ok", w.marker], model: "fixture", budgetMode: "soft", sandbox, timeoutMs: 10000, killGraceMs: 50 };
  const before = { cache: process.env.CCLOOP_CACHE_DIR, codexHome: process.env.CODEX_HOME };
  process.env.CCLOOP_CACHE_DIR = cache;
  process.env.CODEX_HOME = source;
  try {
    await writeFile(`${w.marker}.catalog.json`, JSON.stringify({ mcp: [] }));
    const installation = { kind: "codex", command: raw.command, version: "9.9.9-fake", configDir: source, timeoutMs: 10_000, killGraceMs: 50, sandbox, budgetMode: "soft" };
    const adapter = isolated ? new m.CodexAdapter(raw, { CODEX_HOME: source }, undefined, { installation, rateLimitDelaysMs: [10, 10, 10] })
      : new m.CodexAdapter(raw, { CODEX_HOME: source }, undefined, { rateLimitDelaysMs: [10, 10, 10] });
    await adapter[phase](w.context).catch(() => undefined);
  } finally {
    if (before.cache === undefined) delete process.env.CCLOOP_CACHE_DIR; else process.env.CCLOOP_CACHE_DIR = before.cache;
    if (before.codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before.codexHome;
  }
  const outcome = JSON.parse(await readFile(join(await onlyCall(join(w.runDir, "codex", "1", phase)), "outcome.json"), "utf8")) as Record<string, unknown>;
  const args = outcome.args as string[];
  return { args: normalise(args.slice(args.indexOf("exec")), w), outcome };
}

/** omp: an installation whose command is a shell wrapper around fake-omp.mjs (tests/control/ompSkillsDir.test.ts). */
export async function ompInstallation(w: World): Promise<Record<string, unknown>> {
  const binary = join(w.dir, "omp");
  await writeFile(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_OMP)} ${JSON.stringify(w.marker)} "$@"\n`, { mode: 0o700 });
  return { schema: "ccloop-agent-config-v1", kind: "omp",
    installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
    selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" } };
}

/** omp: outcome.json's args. */
export async function captureOmp(m: CaptureModules, phase: Phase, w: World): Promise<{ args: string[]; outcome: Record<string, unknown> }> {
  await new m.OmpAdapter(await ompInstallation(w))[phase](w.context).catch(() => undefined);
  const outcome = JSON.parse(await readFile(join(await onlyCall(join(w.runDir, "omp", "1", phase)), "outcome.json"), "utf8")) as Record<string, unknown>;
  return { args: normalise(outcome.args as string[], w), outcome };
}

/** The executor prompt for RAW_CONTRACT with a fixed plan, as plain text. */
export function executorPrompt(m: CaptureModules, raw: unknown = RAW_CONTRACT): string {
  const contract = m.loopContractSchema.parse(structuredClone(raw));
  return m.buildExecutorPrompt({ contract, plan: { summary: "Set answer to 42", primaryTargetPaths: ["answer.txt"] } });
}

/** RAW_CONTRACT as parsed, in canonical JSON. */
export function contractBytes(m: CaptureModules, raw: unknown = RAW_CONTRACT): string {
  return m.canonicalJson(m.loopContractSchema.parse(structuredClone(raw)));
}
