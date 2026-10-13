import { normalizeExecutionFinal, ExecutionFormatFailure } from "../executionNormalizer.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../claude/prompts.js";
import type { AttemptContext, RuntimeAdapter } from "../types.js";
import { codexModelUsage, decodeCodexUsage, decodeCodexResult, parseCodexConfig, phaseFinalAccepts, scanFinalMessage, type CodexConfig, type CodexPhase, type PhaseResults } from "./protocol.js";
import { runCodexPhase, type PhaseOutcome } from "./runCodexPhase.js";
import { classifyRateLimit } from "./rateLimit.js";

/** Codex rate-limit spec §3.2: waits before each retry of a phase rejected by 429 before any work (three retries). */
export const RATE_LIMIT_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000];
export interface CodexAdapterOptions { rateLimitDelaysMs?: readonly number[] }

/** Resolves after ms, or at once when the signal aborts (the next call then reports the abort through today's path). */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Orca handoff delivery C-3: an aborted phase, carrying the usage its stdout showed before the kill (or null). */
export class CodexPhaseAborted extends Error {
  constructor(readonly evidenceDir: string, readonly observedTokens: number | null) {
    super(`codex-aborted: ${evidenceDir}`);
    this.name = "CodexPhaseAborted";
  }
}

export class CodexAdapter implements RuntimeAdapter {
  private readonly config: CodexConfig;
  // Agent selection (2026-09-26): extraEnv carries the installation's config directory (CODEX_HOME) to the CLI.
  private readonly rateLimitDelaysMs: readonly number[];
  constructor(rawConfig: unknown, private readonly extraEnv?: Record<string, string>, private readonly codexSkillsDir?: string, options: CodexAdapterOptions = {}) {
    this.config = parseCodexConfig(rawConfig);
    this.rateLimitDelaysMs = options.rateLimitDelaysMs ?? RATE_LIMIT_DELAYS_MS;
  }

  /**
   * Spec §3.2–3.3: a call rejected by 429 before any work is called again after a bounded, abortable wait, within the
   * phase's time limit. Each call keeps its own evidence directory; a rejected one also records rate-limit.json.
   */
  private async callWithBackoff(phase: CodexPhase, prompt: string, context: AttemptContext): Promise<PhaseOutcome & { rateLimited: "before-work" | "after-work" | null }> {
    const startedAt = Date.now(), limitMs = Math.min(this.config.timeoutMs, context.state.budgetSnapshot.timeRemainingMs);
    for (let call = 1; ; call++) {
      const elapsed = Date.now() - startedAt;
      const callContext = call === 1 ? context : { ...context, state: { ...context.state, budgetSnapshot: { ...context.state.budgetSnapshot, timeRemainingMs: context.state.budgetSnapshot.timeRemainingMs - elapsed } } };
      const outcome = await runCodexPhase(this.config, { phase, prompt, context: callContext }, this.extraEnv, this.codexSkillsDir);
      const rateLimited = outcome.reason === "exit-error" || outcome.reason === "io-error" ? classifyRateLimit(outcome.events) : null;
      if (rateLimited !== "before-work") return { ...outcome, rateLimited };
      const delay = this.rateLimitDelaysMs[call - 1];
      const next = delay !== undefined && Date.now() - startedAt + delay < limitMs && !context.abortSignal?.aborted ? delay : null;
      await writeFile(join(outcome.evidenceDir, "rate-limit.json"), JSON.stringify({ classification: rateLimited, call, nextDelayMs: next }), { mode: 0o600 });
      if (next === null) return { ...outcome, rateLimited };
      await wait(next, context.abortSignal);
    }
  }

  get awaitAbortedPhaseCleanup(): boolean { return this.codexSkillsDir !== undefined; }

  private async phase<P extends CodexPhase>(phase: P, prompt: string, context: AttemptContext): Promise<PhaseResults[P]> {
    const outcome = await this.callWithBackoff(phase, prompt, context);
    if (outcome.reason === "aborted") throw new CodexPhaseAborted(outcome.evidenceDir, outcome.observedTokens);
    // Spec §3.3: named; a rejection before any work books 0 (rateLimitedBeforeWork, observedTokensOf), any other keeps
    // the usage its stdout showed, or null.
    if (outcome.rateLimited !== null) {
      throw Object.assign(new Error(`codex-rate-limited: ${outcome.evidenceDir}`), outcome.rateLimited === "before-work" ? { rateLimitedBeforeWork: true } : { observedTokens: outcome.observedTokens });
    }
    if (outcome.reason !== "completed" || outcome.final === null) {
      // Orca ruling 26 (session c85d2c4e, 2026-09-28): as the aborted path, a phase that timed out or failed carries the
      // turn usage its stdout showed (runCodexPhase observes it for every outcome but completed), null when none.
      throw Object.assign(new Error(`${outcome.reason.startsWith("codex-skills-") ? outcome.reason : `codex-${outcome.reason}`}: ${outcome.evidenceDir}`), { observedTokens: outcome.observedTokens });
    }
    if (phase === "execute") {
      // Completion and usage are independent facts; invalid finals must not erase actual spend.
      let usage:ReturnType<typeof decodeCodexUsage>;
      try { usage=decodeCodexUsage(outcome.events,true); }
      catch(error) {
        await writeFile(join(outcome.evidenceDir,"decode-error.txt"),String(error),{mode:0o600});
        throw new Error(`${String(error)}: ${outcome.evidenceDir}`);
      }
      const modelUsage=codexModelUsage(outcome.events,this.config.model) ?? undefined;
      await writeFile(join(outcome.evidenceDir,"usage.json"),JSON.stringify(usage.usageEvidence,null,2),{mode:0o600});
      const normalization=normalizeExecutionFinal(outcome.final);
      await writeFile(join(outcome.evidenceDir,"execution-normalization.json"),JSON.stringify(normalization),{mode:0o600});
      if (normalization.diagnostic.method !== "whole" && (normalization.diagnostic.candidates>0 || normalization.diagnostic.hidden)) {
        await writeFile(join(outcome.evidenceDir,"final-extraction.json"),JSON.stringify(normalization.diagnostic),{mode:0o600});
      }
      if (normalization.status === "unavailable") {
        // Preserve historical parse diagnostics while adding an independent typed classification.
        let original:unknown;
        try { JSON.parse(outcome.final); original=new Error("codex-result-invalid"); } catch(error) { original=error; }
        await writeFile(join(outcome.evidenceDir,"decode-error.txt"),String(original),{mode:0o600});
        throw new ExecutionFormatFailure(`${String(original)}: ${outcome.evidenceDir}`,outcome.evidenceDir,usage.tokenUsage,usage.usageEvidence,modelUsage,normalization);
      }
      return {...normalization.execution,...usage,...(modelUsage===undefined?{}:{modelUsage})} as PhaseResults[P];
    }
    try {
      // Codex phase output hardening (2026-10-08), spec §3.2 as corrected by §7: a decorated final message yields its answer
      // when it holds exactly one distinct answer-shaped node and that node is accepted (verify: a rejection only); a
      // whole-JSON answer, and any other message, take today's path with the original text unchanged.
      // Spec §7 rule 4: the evidence also records hidden text, and is written for it even when nothing parsed.
      const { extraction, hidden } = scanFinalMessage(outcome.final, phaseFinalAccepts(phase));
      if (extraction.method === "candidate" || (extraction.method === "none" && (extraction.candidates > 0 || hidden))) {
        await writeFile(join(outcome.evidenceDir, "final-extraction.json"), JSON.stringify({ method: extraction.method, candidates: extraction.candidates, valid: extraction.valid, hidden, originalBytes: Buffer.byteLength(outcome.final, "utf8") }), { mode: 0o600 });
      }
      const final = extraction.method === "candidate" ? JSON.stringify(extraction.value) : outcome.final;
      const result = decodeCodexResult(phase, outcome.events, final);
      await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(result.usageEvidence, null, 2), { mode: 0o600 });
      // Orca accounts plan B3: codex runs one model, so the whole usage belongs to it.
      const modelUsage = codexModelUsage(outcome.events, this.config.model);
      return modelUsage === null ? result : { ...result, modelUsage };
    } catch (error) {
      await writeFile(join(outcome.evidenceDir, "decode-error.txt"), String(error), { mode: 0o600 });
      throw new Error(`${String(error)}: ${outcome.evidenceDir}`);
    }
  }

  plan(context: AttemptContext) { return this.phase("plan", buildPlannerPrompt(context.contract), context); }
  async execute(context: AttemptContext) {
    try { return await this.phase("execute", buildExecutorPrompt(context) + "\nWrap the complete or partial result in a single object with the sole key result, as required by the output schema.", context); }
    catch (error) {
      // An aborted execute that was observed spending tokens throws, so runLoop can settle that usage;
      // one that was not keeps answering null exactly as before.
      if (error instanceof Error && error.message.startsWith("codex-skills-")) throw error;
      if (context.abortSignal?.aborted && !(error instanceof CodexPhaseAborted && error.observedTokens !== null)) return null;
      throw error;
    }
  }
  verify(context: AttemptContext) { return this.phase("verify", buildVerifierPrompt(context), context); }
}
