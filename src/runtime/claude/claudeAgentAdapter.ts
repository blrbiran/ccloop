import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertContextOption, type MaterializedAgentConfigV1 } from "../../agents/types.js";
import { claudeDescriptor, claudeModelArgument } from "../../agents/claude.js";
import type { AttemptContext, AttemptPlan, ExecutePhaseResult, ExecutionResult, RuntimeAdapter, VerificationResult } from "../types.js";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "./prompts.js";
import type { ClaudePhaseRequest } from "./types.js";

// Orca agent selection (2026-09-26), spec §4.7: the claude adapter that ccloop control can run. Its process
// handling follows runCodexPhase: the phase runner is the leader of its own process group (the claude CLI
// and anything that CLI starts without detaching stay in it), the group is registered BEFORE the prompt is
// written, and stopping signals the whole group. SubprocessClaudeAdapter stays as it was (spec §11).
const LIMIT = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/** scripts/ is not copied by the build: from dist/src/runtime/claude/ the source tree is one level higher. */
export function claudeRunnerPath(): string {
  const up = fileURLToPath(new URL("../../../", import.meta.url));
  const root = basename(up) === "dist" ? dirname(up) : up;
  return join(root, "scripts", "claude-phase-runner.mjs");
}

/** A phase stopped by the abort signal. The runner reports usage only at phase end, so nothing was observed. */
export class ClaudePhaseAborted extends Error {
  readonly observedTokens: null = null;
  constructor(readonly evidenceDir: string) {
    super(`claude-aborted: ${evidenceDir}`);
    this.name = "ClaudePhaseAborted";
  }
}

type Outcome = {
  reason: "completed" | "aborted" | "timeout" | "spawn-error" | "exit-error" | "output-limit" | "io-error";
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  evidenceDir: string;
};

export class ClaudeAgentAdapter implements RuntimeAdapter {
  private readonly extraArgs: string[];

  constructor(private readonly config: MaterializedAgentConfigV1) {
    // §12 I11 (P19): reuses T1's own validation and 1M-suffix spelling (src/agents/claude.ts) rather than
    // re-deriving them here, so there is exactly one place that knows claude's context options and exactly
    // one place that spells the [1m] suffix. Kept here too (not only in the descriptor's validateSelection)
    // so a directly constructed adapter still fails closed on an unexpressable context window (spec W2-9).
    assertContextOption(claudeDescriptor.contextOptions, config.selection);
    this.extraArgs = ["--model", claudeModelArgument(config.selection)];
  }

  private async run(request: ClaudePhaseRequest, context: AttemptContext): Promise<Outcome> {
    const installation = this.config.installation;
    const phase = request.phase;
    const root = join(context.runDir, "claude", String(context.attempt), phase);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const evidenceDir = await mkdtemp(join(root, "call-"));
    const save = async (name: string, data: string) => writeFile(join(evidenceDir, name), data, { mode: 0o600 });
    const runner = claudeRunnerPath();
    const result: Outcome = { reason: "completed", code: null, signal: null, stdout: "", evidenceDir };
    let stderr = "", ioError: string | undefined, stdoutTruncated = false, stderrTruncated = false;
    const persist = async (): Promise<Outcome> => {
      await save("outcome.json", JSON.stringify({
        reason: result.reason, code: result.code, signal: result.signal, evidenceDir,
        runner, claudeCommand: installation.command, extraArgs: this.extraArgs, configDir: installation.configDir,
        ioError, stdoutTruncated, stderrTruncated,
      }, null, 2));
      return result;
    };
    if (context.abortSignal?.aborted) { result.reason = "aborted"; return persist(); }
    const timeout = Math.min(installation.timeoutMs, context.state.budgetSnapshot.timeRemainingMs);
    if (timeout <= 0) { result.reason = "timeout"; return persist(); }
    // Pre-create the raw logs with private permissions; the streams append to them.
    await save("stdout.json", ""); await save("stderr.log", "");
    // The environment is not recorded in request.json (spec M6); outcome.json names the command and arguments.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CCLOOP_CLAUDE_COMMAND: JSON.stringify(installation.command),
      CCLOOP_CLAUDE_EXTRA_ARGS: JSON.stringify(this.extraArgs),
    };
    if (installation.configDir !== null) env.CLAUDE_CONFIG_DIR = installation.configDir;
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [runner], { cwd: context.worktreePath, detached: true, stdio: ["pipe", "pipe", "pipe"], env });
      const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
      let outBytes = 0, errBytes = 0, done = false, exited = false;
      let killTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, signal); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") { ioError = String(e); result.reason = "io-error"; } }
      };
      const finish = () => {
        if (done) return;
        done = true;
        kill("SIGKILL");
        clearTimeout(timer); clearTimeout(killTimer); clearTimeout(drainTimer);
        context.abortSignal?.removeEventListener("abort", abort);
        result.stdout += out.end(); stderr += err.end();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        resolve();
      };
      const stop = (reason: Outcome["reason"]) => {
        if (done || killTimer) return;
        if (result.reason === "completed") result.reason = reason;
        kill("SIGTERM");
        killTimer = setTimeout(() => { kill("SIGKILL"); finish(); }, installation.killGraceMs);
      };
      const abort = () => stop("aborted");
      const timer = setTimeout(() => stop("timeout"), timeout);
      const writeRequest = async () => {
        await save("request.json", JSON.stringify(request, null, 2));
        child.stdin.end(JSON.stringify(request));
      };
      child.on("error", () => { result.reason = "spawn-error"; finish(); });
      child.stdin.on("error", (e) => { ioError = String(e); if (!exited) stop("io-error"); });
      child.stdout.on("data", (b: Buffer) => {
        const kept = b.subarray(0, Math.max(0, LIMIT - outBytes)); outBytes += b.length;
        try { appendFileSync(join(evidenceDir, "stdout.json"), kept); } catch (e) { ioError = String(e); stop("io-error"); }
        result.stdout += out.write(kept);
        if (outBytes > LIMIT) { stdoutTruncated = true; stop("output-limit"); }
      });
      child.stderr.on("data", (b: Buffer) => {
        const kept = b.subarray(0, Math.max(0, LIMIT - errBytes)); errBytes += b.length;
        try { appendFileSync(join(evidenceDir, "stderr.log"), kept); } catch (e) { ioError = String(e); stop("io-error"); }
        stderr += err.write(kept);
        if (errBytes > LIMIT) { stderrTruncated = true; stop("output-limit"); }
      });
      child.on("exit", (code, signal) => {
        exited = true; result.code = code; result.signal = signal;
        if (result.reason === "completed" && (code !== 0 || signal !== null)) result.reason = "exit-error";
        if (!done) drainTimer = setTimeout(finish, 1000);
      });
      child.on("close", finish);
      context.abortSignal?.addEventListener("abort", abort, { once: true });
      if (context.abortSignal?.aborted) abort();
      child.once("spawn", () => {
        void (async () => {
          try {
            const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(child.pid)], { env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, timeout: 1000 });
            if (!stdout.trim()) throw new Error("process identity unavailable");
            const registration = { pid: child.pid!, pgid: child.pid!, startedAt: stdout.trim(), phase };
            await save("process.json", JSON.stringify(registration, null, 2));
            // Registered before the prompt exists anywhere the runner can read it (spec §4.7, §9 criterion 4).
            await context.onProcessRegistered?.(registration);
            if (!done && result.reason === "completed") await writeRequest();
          } catch (e) { ioError = String(e); stop("io-error"); }
        })();
      });
    });
    return persist();
  }

  private async phase<T>(request: ClaudePhaseRequest, context: AttemptContext): Promise<T> {
    const outcome = await this.run(request, context);
    if (outcome.reason === "aborted") throw new ClaudePhaseAborted(outcome.evidenceDir);
    if (outcome.reason !== "completed") throw new Error(`claude-${outcome.reason}: ${outcome.evidenceDir}`);
    let parsed: unknown;
    try { parsed = JSON.parse(outcome.stdout); } catch { parsed = undefined; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      await writeFile(join(outcome.evidenceDir, "decode-error.txt"), "runner stdout is not a JSON object", { mode: 0o600 });
      throw new Error(`claude-result-invalid: ${outcome.evidenceDir}`);
    }
    const usageEvidence = (parsed as { usageEvidence?: unknown }).usageEvidence;
    if (usageEvidence !== undefined) await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(usageEvidence, null, 2), { mode: 0o600 });
    return parsed as T;
  }

  private base(context: AttemptContext) {
    return { attempt: context.attempt, runDir: context.runDir, worktreePath: context.worktreePath };
  }

  plan(context: AttemptContext): Promise<AttemptPlan> {
    return this.phase<AttemptPlan>({ phase: "plan", prompt: buildPlannerPrompt(context.contract), ...this.base(context) }, context);
  }

  async execute(context: AttemptContext): Promise<ExecutePhaseResult> {
    try {
      return await this.phase<ExecutionResult>({
        phase: "execute", prompt: buildExecutorPrompt(context), ...this.base(context),
        partialOutcomeRecoveryWindowMs: context.contract.executionPolicy.partialOutcomeRecoveryWindowMs,
      }, context);
    } catch (error) {
      // As CodexAdapter: an aborted execute with no observed usage answers null. Claude never observes any.
      if (context.abortSignal?.aborted) return null;
      throw error;
    }
  }

  verify(context: AttemptContext): Promise<VerificationResult> {
    return this.phase<VerificationResult>({ phase: "verify", prompt: buildVerifierPrompt(context), ...this.base(context) }, context);
  }
}
