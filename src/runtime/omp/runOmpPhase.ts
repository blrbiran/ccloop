import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MaterializedAgentConfigV1 } from "../../agents/types.js";
import type { AttemptContext } from "../types.js";
import { ompSkillsPromptBlock } from "./ompSkills.js";
import { phaseSystemPrompt, type OmpPhase } from "./phasePrompt.js";

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 16 * 1024 * 1024;

export interface OmpPhaseOutcome {
  reason: "completed" | "aborted" | "timeout" | "spawn-error" | "exit-error" | "output-limit" | "io-error";
  code: number | null;
  signal: NodeJS.Signals | null;
  events: string;
  evidenceDir: string;
  neverStarted: boolean;
  /** Failure causes (ccloop spec 2026-10-21 §3 "Every kind"): the errno of a spawn that failed (ENOENT ⇒ executable-missing). */
  spawnErrno?: string;
}

/**
 * OMP single call (Orca spec 2026-10-14 §3.3): what one omp process needs. A phase and a single call differ only in these:
 * their argv, cwd, evidence directory, time limit and the name written into the process registration.
 * Precondition: evidenceDir must already exist; runOmpProcess never creates it (each caller mkdtemps its own, mode 0700).
 */
export interface OmpProcessInput {
  args: string[];
  prompt: string;
  cwd: string;
  evidenceDir: string;
  timeoutMs: number;
  phase: string;
  abortSignal?: AbortSignal;
  onProcessRegistered?: AttemptContext["onProcessRegistered"];
}

export async function runOmpPhase(
  config: MaterializedAgentConfigV1, phase: OmpPhase, prompt: string, context: AttemptContext, options: { skillsDir?: string } = {},
): Promise<OmpPhaseOutcome> {
  // OMP skill injection (spec 2026-10-13): checked before anything is spawned; OMP's own discovery stays off below.
  const skills = options.skillsDir === undefined ? "" : await ompSkillsPromptBlock(options.skillsDir, context.worktreePath);
  const root = join(context.runDir, "omp", String(context.attempt), phase);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const evidenceDir = await mkdtemp(join(root, "call-"));
  const systemPath = join(evidenceDir, "system-prompt.md");
  await writeFile(systemPath, skills === "" ? phaseSystemPrompt(phase) : `${phaseSystemPrompt(phase)}\n\n${skills}`, { mode: 0o600 });
  const tools = phase === "execute" ? "read,grep,glob,edit,write,bash" : "read,grep,glob";
  const profile = config.installation.profile as string | null;
  const args = ["--profile", profile ?? "default", "--no-extensions", "--no-skills", "--no-tools", "--tools", tools,
    "--no-session", "--no-title", "--no-prewalk", "--model", config.selection.model,
    "--mode", "json", "-p", "--system-prompt", systemPath, "--cwd", context.worktreePath];
  return runOmpProcess(config, {
    args, prompt, cwd: context.worktreePath, evidenceDir, phase,
    timeoutMs: Math.min(config.installation.timeoutMs, context.state.budgetSnapshot.timeRemainingMs),
    abortSignal: context.abortSignal, onProcessRegistered: context.onProcessRegistered,
  });
}

export async function runOmpProcess(config: MaterializedAgentConfigV1, input: OmpProcessInput): Promise<OmpPhaseOutcome> {
  const { args, evidenceDir } = input;
  const eventsPath = join(evidenceDir, "events.jsonl");
  const stderrPath = join(evidenceDir, "stderr.log");
  await Promise.all([writeFile(eventsPath, "", { mode: 0o600 }), writeFile(stderrPath, "", { mode: 0o600 })]);
  const result: OmpPhaseOutcome = { reason: "completed", code: null, signal: null, events: "", evidenceDir, neverStarted: false };
  const persist = async (): Promise<OmpPhaseOutcome> => {
    await writeFile(join(evidenceDir, "outcome.json"), JSON.stringify({ reason: result.reason, code: result.code, signal: result.signal, neverStarted: result.neverStarted, executable: config.installation.command[0], args }, null, 2), { mode: 0o600 });
    return result;
  };
  if (input.abortSignal?.aborted) { result.reason = "aborted"; result.neverStarted = true; return persist(); }
  const timeoutMs = input.timeoutMs;
  if (timeoutMs <= 0) { result.reason = "timeout"; result.neverStarted = true; return persist(); }
  const profile = config.installation.profile as string | null;
  const env: NodeJS.ProcessEnv = { ...process.env, OMP_PROFILE: profile ?? "default" };
  if (config.installation.configDir !== null) env.PI_CODING_AGENT_DIR = config.installation.configDir;
  const chunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  await new Promise<void>((resolve) => {
    const child = spawn(config.installation.command[0], args, { cwd: input.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stopped = false;
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    };
    const stop = (reason: OmpPhaseOutcome["reason"]): void => {
      if (stopped || closed) return;
      stopped = true;
      result.reason = reason;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), config.installation.killGraceMs);
    };
    const abort = (): void => stop("aborted");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, OUTPUT_LIMIT - stdoutBytes));
      stdoutBytes += chunk.length;
      try { appendFileSync(eventsPath, kept); } catch { stop("io-error"); }
      chunks.push(kept);
      if (stdoutBytes > OUTPUT_LIMIT) stop("output-limit");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, OUTPUT_LIMIT - stderrBytes));
      stderrBytes += chunk.length;
      try { appendFileSync(stderrPath, kept); } catch { stop("io-error"); }
      if (stderrBytes > OUTPUT_LIMIT) stop("output-limit");
    });
    child.stdin.on("error", () => { if (!closed && !stopped) stop("io-error"); });
    child.on("error", (error: NodeJS.ErrnoException) => { result.neverStarted = true; if (typeof error.code === "string") result.spawnErrno = error.code; stop("spawn-error"); });
    child.once("spawn", () => {
      void (async () => {
        try {
          const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(child.pid)], { env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, timeout: 1000 });
          if (!stdout.trim()) throw new Error("process identity unavailable");
          const registration = { pid: child.pid!, pgid: child.pid!, startedAt: stdout.trim(), phase: input.phase };
          await writeFile(join(evidenceDir, "process.json"), JSON.stringify(registration), { mode: 0o600 });
          await input.onProcessRegistered?.(registration);
          if (!closed && !stopped) child.stdin.end(input.prompt);
        } catch { stop("io-error"); }
      })();
    });
    child.on("exit", (code, signal) => {
      result.code = code;
      result.signal = signal;
      if (!stopped && (code !== 0 || signal !== null)) result.reason = "exit-error";
      drainTimer = setTimeout(() => { kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy(); }, 1000);
    });
    child.on("close", () => {
      closed = true;
      kill("SIGKILL");
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      input.abortSignal?.removeEventListener("abort", abort);
      result.events = Buffer.concat(chunks).toString("utf8");
      resolve();
    });
    if (input.abortSignal?.aborted) abort();
  });
  return persist();
}
