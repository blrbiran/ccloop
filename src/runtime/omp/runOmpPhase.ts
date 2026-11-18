import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MaterializedAgentConfigV1 } from "../../agents/types.js";
import type { AttemptContext, HandoffDirs } from "../types.js";
import { causeDetail } from "../failureCause.js";
import { effectiveIdleTimeoutMs, IdleWatch, ompToolRow, type IdleSnapshotV1 } from "../idleWatch.js";
import { attachOutcomeStream, CappedLineFile, jsonLine, LineSplitter, ObservedTranscriptFile, STDOUT_HARD_LIMIT } from "../streamLines.js";
import { OmpStream, type OmpStreamPurpose } from "./ompStream.js";
import { ompSkillsPromptBlock } from "./ompSkills.js";
import { ompPhaseTools, phaseSystemPrompt, type OmpPhase } from "./phasePrompt.js";

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 16 * 1024 * 1024;

/**
 * omp launch isolation (spec 2026-11-18-omp-launch-isolation-design.md §3.1, §4.2; Orca #369 (a), #375): the `--config`
 * overlay of every loop phase, written into the call's own evidence directory -- no profile or config file on disk is
 * touched. omp's own auto-retry and model fallback are off (a refusal must reach ccloop, whose bounded transient retry
 * owns retries), and MCP configs of the target repository are never loaded. Keys read from omp 18.17.0's source (§2).
 */
export const OMP_PHASE_OVERLAY = {
  // Review fixes (spec §6, I1): "auto-retry ... off" above no longer holds -- omp's in-session retry stays as the profile has
  // it (on by default) but bounded: at most 3 attempts, and a provider that asks for a longer wait than 60 s fails fast
  // instead of sleeping (omp 18.17.0 `retry.maxRetries`, `retry.maxDelayMs`). Only the model fallback is off: a phase must
  // run on the model the run selected.
  retry: { maxRetries: 3, maxDelayMs: 60_000, modelFallback: false },
  mcp: { enableProjectConfig: false },
} as const;

/**
 * Review fixes (spec §6, C1): omp writes an errored assistant `message_end` BEFORE it decides whether to recover in-session
 * (a compaction after a context overflow, a bounded retry). A non-retryable 4xx therefore ends a phase only when nothing
 * continues it: at a terminal `agent_end`, or after this long without a continuation row (omp announces a recovery with a
 * local event before any network call, so the gap is omp's own bookkeeping; 20 s leaves room for a heavily loaded machine
 * while a dead phase still ends in seconds, not at the 10-minute watchdog).
 */
export const OMP_PROVIDER_ERROR_GRACE_MS = 20_000;

/**
 * Review fixes (spec §6, C1): rows by which omp shows it goes on after an errored message (omp 18.17.0 agent-session /
 * session-maintenance / turn-recovery and the agent loop). The errored turn's own `turn_end` and its placeholder tool-result
 * messages are not among them: the loop always writes those after the error. A non-terminal `agent_end` is not either: omp
 * holds `agent_end` while the prompt runs and prints only the last one (agent-session.ts `#emitSessionEvent`), and the phase
 * fold refuses a non-terminal one anyway (`omp-phase-continuation`).
 */
function ompContinuationRow(row: { type?: unknown; message?: { role?: unknown } }): boolean {
  switch (row.type) {
    case "auto_compaction_start": case "auto_retry_start": case "agent_start": case "turn_start": case "tool_execution_start": return true;
    case "message_start": return row.message?.role === "assistant";
    default: return false;
  }
}

/**
 * Spec §4.1 (#375): omp's wait for MCP servers before the first turn (its default is 30 000 ms; 0 would mean no timeout). A
 * phase may never call an MCP tool, so the wait buys the run nothing; 2 s still tells a healthy server from a dead one for
 * the warning omp prints. Set on every omp call, over any inherited value.
 */
export const OMP_MCP_TIMEOUT_MS = "2000";

/** Spec §4.3: omp's stderr `Warning: ` lines kept as the call's observation (outcome.json `warnings`), bounded. */
const MAX_WARNINGS = 16;
/**
 * Review fixes (spec §6, M1/M2): "`Warning: ` lines" above narrows to omp 18.17.0's two MCP readiness shapes (print-mode.ts
 * `evaluateReadiness`), kept only up to the server's name and state: the failed-to-connect tail is the server's own error and
 * can carry a URL with a token, and any other `Warning:` line (session store notices, ...) may carry paths or secrets, so it is
 * dropped. ANSI escapes are stripped before matching (omp colours some stderr; FORCE_COLOR may be inherited).
 */
const MCP_READINESS_WARNING = /^Warning: MCP server "[^"]*" (?:not ready(?: after \d+ms)?|failed to connect)/;
// CSI sequences (colours, cursor moves) and two-byte ESC sequences.
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

export interface OmpPhaseOutcome {
  // "provider-error" (Orca #369 (a), spec 2026-11-18 §3.3): a phase stopped by ccloop on a non-retryable 4xx refusal.
  reason: "completed" | "aborted" | "timeout" | "stalled" | "spawn-error" | "exit-error" | "output-limit" | "io-error" | "provider-error";
  code: number | null;
  signal: NodeJS.Signals | null;
  evidenceDir: string;
  /** Live transcript (Orca spec 2026-10-23 §10.2.3): the call's stdout folded line by line; not enumerable. */
  readonly stream: OmpStream;
  /** The recorded events.jsonl evidence (≤ 16 MiB, cut at a line end), read from disk on access (plan D4); not enumerable. */
  readonly events: string;
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
  /** Live transcript: which decoder folds the stdout (the phase's with its tool rules, or the single call's). */
  purpose: OmpStreamPurpose;
  /** Live token threshold (issue #225): the call's summed message_end usage, reported each time it grows; phases only. */
  onObservedUsage?: AttemptContext["onObservedUsage"];
  /** Working time (Orca issue #262): the phase's idle ledger; phases only. */
  idleLedger?: AttemptContext["idleLedger"];
  /** Review fixes (spec 2026-11-18 §6, C1): the grace window after a non-retryable 4xx; OMP_PROVIDER_ERROR_GRACE_MS when absent. */
  providerErrorGraceMs?: number;
}

/** Task handoffs (Orca follow-up G §10.2): the handoff directories, after the extra worktrees. Saved-result capture
 * expects exactly these arguments from the source envelope's work.handoff (Orca V11 regression). */
export function ompHandoffArgs(handoff: HandoffDirs | undefined): string[] {
  return handoff === undefined ? [] : [`--add-dir=${handoff.inputDir}`, `--add-dir=${handoff.outputDir}`];
}

export async function runOmpPhase(
  config: MaterializedAgentConfigV1, phase: OmpPhase, prompt: string, context: AttemptContext, options: { skillsDir?: string; providerErrorGraceMs?: number } = {},
): Promise<OmpPhaseOutcome> {
  // OMP skill injection (spec 2026-10-13): checked before anything is spawned; OMP's own discovery stays off below.
  const skills = options.skillsDir === undefined ? "" : await ompSkillsPromptBlock(options.skillsDir, context.worktreePath);
  const root = join(context.runDir, "omp", String(context.attempt), phase);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const evidenceDir = await mkdtemp(join(root, "call-"));
  const systemPath = join(evidenceDir, "system-prompt.md");
  const overlayPath = join(evidenceDir, "config-overlay.yml");
  await Promise.all([
    writeFile(systemPath, skills === "" ? phaseSystemPrompt(phase) : `${phaseSystemPrompt(phase)}\n\n${skills}`, { mode: 0o600 }),
    writeFile(overlayPath, `${JSON.stringify(OMP_PHASE_OVERLAY)}\n`, { mode: 0o600 }),
  ]);
  const tools = ompPhaseTools(phase).join(",");
  const profile = config.installation.profile as string | null;
  const args = ["--profile", profile ?? "default", "--no-extensions", "--no-skills", "--no-tools", "--tools", tools,
    "--no-session", "--no-title", "--no-prewalk", "--model", config.selection.model,
    "--mode", "json", "-p", "--system-prompt", systemPath, "--cwd", context.worktreePath,
    // omp launch isolation (spec 2026-11-18 §3.1): the per-launch overlay, before the extra worktrees and handoff dirs.
    "--config", overlayPath,
    // Multi-repo runs (spec 2026-10-24-multi-dir-projects §11.5, §19.2 P5): the extra worktrees, on every phase.
    ...(context.extraWorktrees ?? []).map((extra) => `--add-dir=${extra.worktreePath}`),
    ...ompHandoffArgs(context.handoff)];
  const toolRules = phase === "execute" ? context.contract?.executionPolicy?.toolRules : undefined;
  return runOmpProcess(config, {
    args, prompt, cwd: context.worktreePath, evidenceDir, phase,
    purpose: { phase, selector: config.selection.model, ...(toolRules === undefined ? {} : { toolRules: { rules: toolRules, requiredChecks: context.contract.verification.requiredChecks } }) },
    timeoutMs: Math.min(config.installation.timeoutMs, context.state.budgetSnapshot.timeRemainingMs),
    abortSignal: context.abortSignal, onProcessRegistered: context.onProcessRegistered, onObservedUsage: context.onObservedUsage,
    idleLedger: context.idleLedger,
    ...(options.providerErrorGraceMs === undefined ? {} : { providerErrorGraceMs: options.providerErrorGraceMs }),
  });
}

export async function runOmpProcess(config: MaterializedAgentConfigV1, input: OmpProcessInput): Promise<OmpPhaseOutcome> {
  const { args, evidenceDir } = input;
  const eventsPath = join(evidenceDir, "events.jsonl");
  const stderrPath = join(evidenceDir, "stderr.log");
  const transcriptPath = join(evidenceDir, "transcript.jsonl");
  await Promise.all([writeFile(eventsPath, "", { mode: 0o600 }), writeFile(transcriptPath, "", { mode: 0o600 }), writeFile(stderrPath, "", { mode: 0o600 })]);
  const stream = new OmpStream(input.purpose);
  const result = attachOutcomeStream({ reason: "completed", code: null, signal: null, evidenceDir, neverStarted: false } as OmpPhaseOutcome, evidenceDir, stream);
  // Live transcript (spec §10.2.2): omp's outcome.json now labels a truncated events.jsonl as codex's does.
  let stdoutTruncated = false;
  let transcriptTruncatedAt: number | null = null;
  let transcriptError: string | undefined;
  // Activity watchdog (spec 2026-10-21 §2.3): recorded in outcome.json when the call was stopped as stalled.
  let idle: IdleSnapshotV1 | null = null;
  // Spec 2026-11-18 §4.3 (#375): omp's stderr `Warning: ` lines, in order; written only when there is one.
  const warnings: string[] = [];
  const persist = async (): Promise<OmpPhaseOutcome> => {
    await writeFile(join(evidenceDir, "outcome.json"), JSON.stringify({ reason: result.reason, code: result.code, signal: result.signal, neverStarted: result.neverStarted, executable: config.installation.command[0], args, stdoutTruncated, transcriptTruncatedAt, transcriptError, ...(result.reason === "stalled" && idle !== null ? { idle } : {}), ...(warnings.length === 0 ? {} : { warnings }) }, null, 2), { mode: 0o600 });
    return result;
  };
  if (input.abortSignal?.aborted) { result.reason = "aborted"; result.neverStarted = true; return persist(); }
  const timeoutMs = input.timeoutMs;
  if (timeoutMs <= 0) { result.reason = "timeout"; result.neverStarted = true; return persist(); }
  const profile = config.installation.profile as string | null;
  // Spec 2026-11-18 §4.1 (#375): the bounded MCP wait, per launch, over any inherited value.
  const env: NodeJS.ProcessEnv = { ...process.env, OMP_PROFILE: profile ?? "default", OMP_MCP_TIMEOUT_MS };
  if (config.installation.configDir !== null) env.PI_CODING_AGENT_DIR = config.installation.configDir;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  // Live transcript (spec §10.2.1-§10.2.3, §11.1): stdout goes to the 16 MiB evidence file and the 128 MiB transcript, each
  // cut at a line end, and through the line folds; only the 1 GiB hard limit stops the agent for its output.
  // Review I1: both records are opened before anything is spawned; a record that cannot be opened is io-error with no child.
  let events: CappedLineFile, transcript: ObservedTranscriptFile;
  try { events = new CappedLineFile(eventsPath, OUTPUT_LIMIT); } catch { result.reason = "io-error"; result.neverStarted = true; return persist(); }
  try { transcript = new ObservedTranscriptFile(transcriptPath); } catch { events.close(); result.reason = "io-error"; result.neverStarted = true; return persist(); }
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
    // Review fixes (spec §6, C1): armed by a non-retryable 4xx assistant message, disarmed by a continuation row.
    let graceTimer: NodeJS.Timeout | undefined;
    const disarmGrace = (): void => { clearTimeout(graceTimer); graceTimer = undefined; };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    // Activity watchdog (spec 2026-10-21 §2.2 omp): stdout/stderr bytes are activity; tool executions suspend the clock.
    const watch = new IdleWatch(effectiveIdleTimeoutMs(config.installation), () => { idle = watch.snapshot(); stop("stalled"); }, input.idleLedger);
    let observed: number | null = null;
    const splitter = new LineSplitter((line) => {
      const parsed = jsonLine(line); stream.push(parsed); if (parsed.kind === "row") ompToolRow(parsed.row, watch);
      // Orca #369 (a) (spec 2026-11-18 §3.3): a phase ends on a refusal that no retry would pass; the single call is unchanged.
      // Review fixes (spec §6, C1): not at the refusal itself -- at a terminal agent_end, or when the grace window runs out
      // with no continuation row in between.
      if (input.purpose.phase !== "single-call" && parsed.kind === "row" && parsed.row !== null && typeof parsed.row === "object" && !Array.isArray(parsed.row)) {
        const row = parsed.row as { type?: unknown; isTerminal?: unknown; message?: { role?: unknown } };
        const refused = stream.call.terminalProviderStatus() !== null;
        if (refused && row.type === "message_end" && row.message?.role === "assistant") {
          disarmGrace();
          graceTimer = setTimeout(() => { graceTimer = undefined; stop("provider-error"); }, input.providerErrorGraceMs ?? OMP_PROVIDER_ERROR_GRACE_MS);
        } else if (refused && row.type === "agent_end" && row.isTerminal !== false) {
          disarmGrace(); stop("provider-error");
        } else if (ompContinuationRow(row)) disarmGrace();
      }
      // Live token threshold (issue #225): every assistant message_end carries its usage, so the running sum is observed.
      const total = input.onObservedUsage === undefined ? null : stream.lowerBound.value();
      if (total !== null && total !== observed) { observed = total; input.onObservedUsage!(total); }
    });
    watch.start();
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (closed) return;
      stdoutBytes += chunk.length;
      watch.activity();
      if (stdoutBytes > STDOUT_HARD_LIMIT) { stdoutTruncated = true; stop("output-limit"); return; }
      // Review I2: each record in its own try; losing the transcript only stops recording it (named in outcome.json).
      try { events.write(chunk); } catch { stop("io-error"); }
      try { transcript.write(chunk); } catch (error) { transcriptError ??= String(error); }
      splitter.write(chunk);
    });
    const stderrLines = new LineSplitter((line) => {
      if (warnings.length >= MAX_WARNINGS || line.tooLarge) return;
      const kept = MCP_READINESS_WARNING.exec(line.text.replace(ANSI_ESCAPE, ""));
      if (kept !== null) warnings.push(causeDetail(kept[0]));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < OUTPUT_LIMIT) stderrLines.write(chunk);
      const kept = chunk.subarray(0, Math.max(0, OUTPUT_LIMIT - stderrBytes));
      stderrBytes += chunk.length;
      try { appendFileSync(stderrPath, kept); } catch { stop("io-error"); }
      watch.activity();
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
      disarmGrace();
      watch.stop();
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      input.abortSignal?.removeEventListener("abort", abort);
      splitter.end(); stderrLines.end();
      events.close(); try { transcript.close(); } catch (error) { transcriptError ??= String(error); }
      stdoutTruncated ||= events.truncatedAt !== null;
      transcriptTruncatedAt = transcript.truncatedAt;
      resolve();
    });
    if (input.abortSignal?.aborted) abort();
  });
  return persist();
}
