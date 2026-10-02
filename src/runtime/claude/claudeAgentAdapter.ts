import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertContextOption, type MaterializedAgentConfigV1 } from "../../agents/types.js";
import { claudeDescriptor, claudeModelArgument } from "../../agents/claude.js";
import { observedTokensOf, SingleCallOutputInvalid, type AttemptContext, type AttemptPlan, type ExecutePhaseResult, type ExecutionResult, type RuntimeAdapter, type SingleCallRequest, type SingleCallResult, type VerificationResult } from "../types.js";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "./prompts.js";
import type { ClaudePhaseRequest } from "./types.js";

// Orca agent selection (2026-09-26), spec §4.7: the claude adapter that ccloop control can run. Its process
// handling follows runCodexPhase: the phase runner is the leader of its own process group (the claude CLI
// and anything that CLI starts without detaching stay in it), the group is registered BEFORE the prompt is
// written, and stopping signals the whole group. SubprocessClaudeAdapter stays as it was (spec §11).
// *** ERRATUM (consolidation step 1, 2026-10-01, Orca session be653b22, ruling R5) -- "SubprocessClaudeAdapter stays
// as it was (spec §11)" no longer holds: ccloop spec 2026-10-01-claude-adapter-consolidation-step1-design.md deletes it
// in this consolidation step (its task 2 lands the deletion), and this adapter now also returns the execute result the
// runner writes after a stop (abort or its own timeout), with the usage observed before the stop. ***
const LIMIT = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/** scripts/ is not copied by the build: from dist/src/runtime/claude/ the source tree is one level higher. */
export function claudeRunnerPath(): string {
  const up = fileURLToPath(new URL("../../../", import.meta.url));
  const root = basename(up) === "dist" ? dirname(up) : up;
  return join(root, "scripts", "claude-phase-runner.mjs");
}

/**
 * A phase stopped by the abort signal. Orca claude stream usage (2026-09-27), spec §3.2: the runner writes the usage
 * claude streamed before the stop (a lower bound: a message still open counts its opening snapshot) to the call's
 * evidence directory, and that total is carried here; no observation stays null, never 0.
 */
export class ClaudePhaseAborted extends Error {
  constructor(readonly evidenceDir: string, readonly observedTokens: number | null = null) {
    super(`claude-aborted: ${evidenceDir}`);
    this.name = "ClaudePhaseAborted";
  }
}

const OBSERVED_USAGE_FILE = "observed-usage.json";

/** Crash resume (2026-10-02), spec §3.2: the claude command never existed in this call, so nothing was spent. */
export class ClaudeNeverStartedError extends Error {
  readonly neverStarted = true;
  constructor(readonly spawnError: string, readonly evidenceDir: string) {
    super(`claude-never-started: ${spawnError} (${evidenceDir})`);
    this.name = "ClaudeNeverStartedError";
  }
}

/**
 * Consolidation step 1 (2026-10-01, ccloop spec 2026-10-01-claude-adapter-consolidation-step1-design.md §5.3): on execute
 * the group gets this long past the recovery window before SIGKILL, so the runner can stop claude, read git and print
 * its partial. Mirrored by Orca src/control/driverHandoff.ts (PARTIAL_FLUSH_MARGIN_MS), whose handoff grace waits it.
 */
export const PARTIAL_FLUSH_MARGIN_MS = 5_000;

/** A JSON object, or undefined for anything else (consolidation step 1, spec §5.1). */
const parseObject = (text: string): object | undefined => {
  try { const v: unknown = JSON.parse(text); return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
};

// Spec §3.2: the runner's dedicated answer when claude never existed in this call. Checked before every other reading of
// stdout, because the after-stop branch below returns any JSON object printed with exit 0 as the phase's result.
function neverStartedOf(outcome: Outcome): string | null {
  if (outcome.code !== 0 || outcome.signal !== null) return null;
  const written = parseObject(outcome.stdout) as { claudeNeverStarted?: unknown; spawnError?: unknown } | undefined;
  // Exactly the two keys: the success path prints claude's structured output merged with usageEvidence, never this shape.
  return written !== undefined && Object.keys(written).length === 2 && written.claudeNeverStarted === true && typeof written.spawnError === "string" ? written.spawnError : null;
}

function throwIfNeverStarted(outcome: Outcome): void {
  const spawnError = neverStartedOf(outcome);
  if (spawnError === null) return;
  if (outcome.reason === "aborted") throw Object.assign(new ClaudePhaseAborted(outcome.evidenceDir, null), { neverStarted: true as const });
  throw new ClaudeNeverStartedError(spawnError, outcome.evidenceDir);
}

/** The runner's observation, or null when there is none it can vouch for (missing, corrupt, foreign, not > 0). */
export async function readObservedTokens(path: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { schema?: unknown; total?: unknown };
    return parsed.schema === "ccloop-claude-observed-usage-v1" && Number.isSafeInteger(parsed.total) && (parsed.total as number) > 0 ? parsed.total as number : null;
  } catch { return null; }
}

type Outcome = {
  reason: "completed" | "aborted" | "timeout" | "spawn-error" | "exit-error" | "output-limit" | "io-error";
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  evidenceDir: string;
};

/** What one runner call needs from its caller: a phase's AttemptContext, or a single call's request (Orca single-call estimate). */
type ClaudeCall = {
  runDir: string;
  attempt: number;
  cwd: string;
  timeLimitMs: number;
  abortSignal?: AbortSignal;
  onProcessRegistered?: AttemptContext["onProcessRegistered"];
  /** Consolidation step 1 (spec §5.3): the SIGTERM-to-SIGKILL delay for this call; installation.killGraceMs when absent. */
  stopGraceMs?: number;
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

  private async run(request: ClaudePhaseRequest, call: ClaudeCall): Promise<Outcome> {
    const installation = this.config.installation;
    const phase = request.phase;
    const root = join(call.runDir, "claude", String(call.attempt), phase);
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
        ioError, stdoutTruncated, stderrTruncated, observedUsagePath: join(evidenceDir, OBSERVED_USAGE_FILE),
      }, null, 2));
      return result;
    };
    if (call.abortSignal?.aborted) { result.reason = "aborted"; return persist(); }
    const timeout = Math.min(installation.timeoutMs, call.timeLimitMs);
    if (timeout <= 0) { result.reason = "timeout"; return persist(); }
    // Pre-create the raw logs with private permissions; the streams append to them.
    await save("stdout.json", ""); await save("stderr.log", "");
    // The environment is not recorded in request.json (spec M6); outcome.json names the command and arguments.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CCLOOP_CLAUDE_COMMAND: JSON.stringify(installation.command),
      CCLOOP_CLAUDE_EXTRA_ARGS: JSON.stringify(this.extraArgs),
      CCLOOP_CLAUDE_OBSERVED_USAGE_PATH: join(evidenceDir, OBSERVED_USAGE_FILE),
    };
    if (installation.configDir !== null) env.CLAUDE_CONFIG_DIR = installation.configDir;
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [runner], {
        cwd: call.cwd, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"],
        // Crash resume (2026-10-02), spec §3.1: fd 3 is a pipe this process never writes; its end closes only when this
        // process dies (or finish() destroys it), which is how the runner learns that its parent is gone.
        env: { ...env, CCLOOP_PARENT_WATCH_FD: "3" },
      });
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
        call.abortSignal?.removeEventListener("abort", abort);
        result.stdout += out.end(); stderr += err.end();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        (child.stdio[3] as { destroy?: () => void } | null)?.destroy?.();
        resolve();
      };
      const stop = (reason: Outcome["reason"]) => {
        if (done || killTimer) return;
        if (result.reason === "completed") result.reason = reason;
        kill("SIGTERM");
        killTimer = setTimeout(() => { kill("SIGKILL"); finish(); }, call.stopGraceMs ?? installation.killGraceMs);
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
      call.abortSignal?.addEventListener("abort", abort, { once: true });
      if (call.abortSignal?.aborted) abort();
      child.once("spawn", () => {
        void (async () => {
          try {
            const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(child.pid)], { env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, timeout: 1000 });
            if (!stdout.trim()) throw new Error("process identity unavailable");
            const registration = { pid: child.pid!, pgid: child.pid!, startedAt: stdout.trim(), phase };
            await save("process.json", JSON.stringify(registration, null, 2));
            // Registered before the prompt exists anywhere the runner can read it (spec §4.7, §9 criterion 4).
            await call.onProcessRegistered?.(registration);
            if (!done && result.reason === "completed") await writeRequest();
          } catch (e) { ioError = String(e); stop("io-error"); }
        })();
      });
    });
    return persist();
  }

  private async phase<T>(request: ClaudePhaseRequest, context: AttemptContext, afterStop?: { stopGraceMs: number }): Promise<T> {
    const outcome = await this.run(request, { ...this.call(context), ...(afterStop ? { stopGraceMs: afterStop.stopGraceMs } : {}) });
    throwIfNeverStarted(outcome);
    // Consolidation step 1 (spec §5.1, §5.2): after a stop, an execute runner that exited cleanly and printed a JSON object
    // printed the phase's result (its post-SIGTERM partial, or a complete answer it already had). A result without
    // tokenUsage carries the usage observed before the stop; no observation leaves it absent, never 0.
    if (afterStop !== undefined && (outcome.reason === "aborted" || outcome.reason === "timeout") && outcome.code === 0 && outcome.signal === null) {
      const written = parseObject(outcome.stdout);
      if (written !== undefined) {
        const usageEvidence = (written as { usageEvidence?: unknown }).usageEvidence;
        if (usageEvidence !== undefined) await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(usageEvidence, null, 2), { mode: 0o600 });
        if ((written as { tokenUsage?: unknown }).tokenUsage === undefined) {
          const observed = await readObservedTokens(join(outcome.evidenceDir, OBSERVED_USAGE_FILE));
          if (observed !== null) (written as { tokenUsage?: number }).tokenUsage = observed;
        }
        return written as T;
      }
    }
    if (outcome.reason === "aborted") throw new ClaudePhaseAborted(outcome.evidenceDir, await readObservedTokens(join(outcome.evidenceDir, OBSERVED_USAGE_FILE)));
    if (outcome.reason !== "completed") {
      // Orca ruling 26 (Orca ledger 2026-09-27-single-call-estimate §3.21; session c85d2c4e, 2026-09-28): a phase that
      // timed out or failed still spent what claude streamed before it ended, as singleCall already reports; the error
      // carries that observation (observedTokensOf) so runLoop books it, null when there is none -- never 0.
      throw Object.assign(new Error(`claude-${outcome.reason}: ${outcome.evidenceDir}`), {
        observedTokens: await readObservedTokens(join(outcome.evidenceDir, OBSERVED_USAGE_FILE)),
      });
    }
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

  private call(context: AttemptContext): ClaudeCall {
    return {
      runDir: context.runDir, attempt: context.attempt, cwd: context.worktreePath,
      timeLimitMs: context.state.budgetSnapshot.timeRemainingMs,
      abortSignal: context.abortSignal, onProcessRegistered: context.onProcessRegistered,
    };
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
      }, context, { stopGraceMs: Math.max(this.config.installation.killGraceMs, context.contract.executionPolicy.partialOutcomeRecoveryWindowMs + PARTIAL_FLUSH_MARGIN_MS) });
    } catch (error) {
      // As CodexAdapter (Orca claude stream usage, 2026-09-27): an aborted execute that was observed spending tokens
      // throws, so runLoop can settle that usage; one that was not keeps answering null exactly as before.
      if (context.abortSignal?.aborted && !(error instanceof ClaudePhaseAborted && (error.observedTokens !== null || observedTokensOf(error) === 0))) return null;
      throw error;
    }
  }

  verify(context: AttemptContext): Promise<VerificationResult> {
    return this.phase<VerificationResult>({ phase: "verify", prompt: buildVerifierPrompt(context), ...this.base(context) }, context);
  }

  /**
   * Orca single-call estimate (2026-09-27), spec §5.4: one call with the request's schema, every tool off and the output
   * capped (the runner's single-call branch), registered before its prompt is written, like every phase. An abort
   * carries the usage claude streamed before it; an answer with no structured object carries the usage it spent.
   */
  async singleCall(request: SingleCallRequest): Promise<SingleCallResult> {
    const outcome = await this.run(
      { phase: "single-call", prompt: request.prompt, attempt: 1, runDir: request.runDir, cwd: request.cwd, schema: request.responseSchema, maxOutputTokens: request.maxOutputTokens },
      { runDir: request.runDir, attempt: 1, cwd: request.cwd, timeLimitMs: request.timeoutMs, abortSignal: request.signal, onProcessRegistered: request.onProcessRegistered },
    );
    throwIfNeverStarted(outcome);
    if (outcome.reason === "aborted") throw new ClaudePhaseAborted(outcome.evidenceDir, await readObservedTokens(join(outcome.evidenceDir, OBSERVED_USAGE_FILE)));
    if (outcome.reason !== "completed") {
      // Final review of the single-call estimate (2026-09-28): a call that timed out or failed still spent what claude
      // streamed before it ended; that observation rides on the error (observedTokensOf), null when there is none.
      throw Object.assign(new Error(`claude-${outcome.reason}: ${outcome.evidenceDir}`), {
        observedTokens: await readObservedTokens(join(outcome.evidenceDir, OBSERVED_USAGE_FILE)),
      });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(outcome.stdout); } catch { parsed = undefined; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      await writeFile(join(outcome.evidenceDir, "decode-error.txt"), "runner stdout is not a JSON object", { mode: 0o600 });
      throw new Error(`claude-result-invalid: ${outcome.evidenceDir}`);
    }
    const answer = parsed as { output?: unknown; outputError?: unknown; usageEvidence?: unknown; tokenUsage?: unknown };
    const usageEvidence = answer.usageEvidence ?? null;
    if (usageEvidence !== null) await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(usageEvidence, null, 2), { mode: 0o600 });
    const tokenUsage = typeof answer.tokenUsage === "number" && Number.isSafeInteger(answer.tokenUsage) && answer.tokenUsage >= 0 ? answer.tokenUsage : null;
    const output = answer.output;
    if (answer.outputError !== null || output === null || typeof output !== "object" || Array.isArray(output)) {
      throw new SingleCallOutputInvalid(outcome.evidenceDir, tokenUsage, usageEvidence);
    }
    return { output, tokenUsage, usageEvidence };
  }
}
