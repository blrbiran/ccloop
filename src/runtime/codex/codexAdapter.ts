import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../claude/prompts.js";
import type { AttemptContext, RuntimeAdapter } from "../types.js";
import { decodeCodexResult, parseCodexConfig, type CodexConfig, type CodexPhase, type PhaseResults } from "./protocol.js";
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
  constructor(rawConfig: unknown, private readonly extraEnv?: Record<string, string>) { this.config = parseCodexConfig(rawConfig); }

  private async phase<P extends CodexPhase>(phase: P, prompt: string, context: AttemptContext): Promise<PhaseResults[P]> {
    const outcome = await runCodexPhase(this.config, { phase, prompt, context }, this.extraEnv);
    if (outcome.reason === "aborted") throw new CodexPhaseAborted(outcome.evidenceDir, outcome.observedTokens);
    if (outcome.reason !== "completed" || outcome.final === null) {
      throw new Error(`codex-${outcome.reason}: ${outcome.evidenceDir}`);
    }
    try {
      const result = decodeCodexResult(phase, outcome.events, phase === "execute" ? JSON.stringify(z.object({result:z.unknown()}).strict().parse(JSON.parse(outcome.final)).result) : outcome.final);
      await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(result.usageEvidence, null, 2), { mode: 0o600 });
      return result;
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
      if (context.abortSignal?.aborted && !(error instanceof CodexPhaseAborted && error.observedTokens !== null)) return null;
      throw error;
    }
  }
  verify(context: AttemptContext) { return this.phase("verify", buildVerifierPrompt(context), context); }
}
