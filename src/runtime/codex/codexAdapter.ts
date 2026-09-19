import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../claude/prompts.js";
import type { AttemptContext, RuntimeAdapter } from "../types.js";
import { decodeCodexResult, parseCodexConfig, type CodexConfig, type CodexPhase, type PhaseResults } from "./protocol.js";
import { runCodexPhase } from "./runCodexPhase.js";

export class CodexAdapter implements RuntimeAdapter {
  private readonly config: CodexConfig;
  constructor(rawConfig: unknown) { this.config = parseCodexConfig(rawConfig); }

  private async phase<P extends CodexPhase>(phase: P, prompt: string, context: AttemptContext): Promise<PhaseResults[P]> {
    const outcome = await runCodexPhase(this.config, { phase, prompt, context });
    if (outcome.reason !== "completed" || outcome.final === null) {
      throw new Error(`codex-${outcome.reason}: ${outcome.evidenceDir}`);
    }
    try {
      const result = decodeCodexResult(phase, outcome.events, outcome.final);
      await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(result.usageEvidence, null, 2), { mode: 0o600 });
      return result;
    } catch (error) {
      await writeFile(join(outcome.evidenceDir, "decode-error.txt"), String(error), { mode: 0o600 });
      throw new Error(`${String(error)}: ${outcome.evidenceDir}`);
    }
  }

  plan(context: AttemptContext) { return this.phase("plan", buildPlannerPrompt(context.contract), context); }
  async execute(context: AttemptContext) {
    try { return await this.phase("execute", buildExecutorPrompt(context), context); }
    catch (error) { if (context.abortSignal?.aborted) return null; throw error; }
  }
  verify(context: AttemptContext) { return this.phase("verify", buildVerifierPrompt(context), context); }
}
