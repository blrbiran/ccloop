import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../claude/prompts.js";
import type { AttemptContext, RuntimeAdapter } from "../types.js";
import { codexModelUsage, decodeCodexResult, parseCodexConfig, phaseFinalAccepts, scanFinalMessage, type CodexConfig, type CodexPhase, type PhaseResults } from "./protocol.js";
import { runCodexPhase } from "./runCodexPhase.js";

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
  constructor(rawConfig: unknown, private readonly extraEnv?: Record<string, string>, private readonly codexSkillsDir?: string) { this.config = parseCodexConfig(rawConfig); }

  get awaitAbortedPhaseCleanup(): boolean { return this.codexSkillsDir !== undefined; }

  private async phase<P extends CodexPhase>(phase: P, prompt: string, context: AttemptContext): Promise<PhaseResults[P]> {
    const outcome = await runCodexPhase(this.config, { phase, prompt, context }, this.extraEnv, this.codexSkillsDir);
    if (outcome.reason === "aborted") throw new CodexPhaseAborted(outcome.evidenceDir, outcome.observedTokens);
    if (outcome.reason !== "completed" || outcome.final === null) {
      // Orca ruling 26 (session c85d2c4e, 2026-09-28): as the aborted path, a phase that timed out or failed carries the
      // turn usage its stdout showed (runCodexPhase observes it for every outcome but completed), null when none.
      throw Object.assign(new Error(`${outcome.reason.startsWith("codex-skills-") ? outcome.reason : `codex-${outcome.reason}`}: ${outcome.evidenceDir}`), { observedTokens: outcome.observedTokens });
    }
    try {
      // Codex phase output hardening (2026-10-08), spec §3.2: a decorated final message yields its one schema-valid object;
      // a whole-JSON answer, and one without exactly one valid object, take today's path with the original text unchanged.
      // Spec §7 rule 4: the evidence also records hidden text, and is written for it even when nothing parsed.
      const { extraction, hidden } = scanFinalMessage(outcome.final, phaseFinalAccepts(phase));
      if (extraction.method === "candidate" || (extraction.method === "none" && (extraction.candidates > 0 || hidden))) {
        await writeFile(join(outcome.evidenceDir, "final-extraction.json"), JSON.stringify({ method: extraction.method, candidates: extraction.candidates, valid: extraction.valid, hidden, originalBytes: Buffer.byteLength(outcome.final, "utf8") }), { mode: 0o600 });
      }
      const final = extraction.method === "candidate" ? JSON.stringify(extraction.value) : outcome.final;
      const result = decodeCodexResult(phase, outcome.events, phase === "execute" ? JSON.stringify(z.object({result:z.unknown()}).strict().parse(JSON.parse(final)).result) : final);
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
