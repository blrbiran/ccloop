import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MaterializedAgentConfigV1 } from "../../agents/types.js";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../claude/prompts.js";
import type { AttemptContext, RuntimeAdapter } from "../types.js";
import type { PhaseResults } from "../codex/protocol.js";
import { decodeOmpPhase, ompUsageLowerBound } from "./ompProtocol.js";
import { runOmpPhase } from "./runOmpPhase.js";
import type { OmpPhase } from "./phasePrompt.js";
import { observedChangedPaths, worktreeHead, worktreeSnapshot } from "./worktreeSnapshot.js";

export class OmpAdapter implements RuntimeAdapter {
  constructor(private readonly config: MaterializedAgentConfigV1, private readonly skillsDir?: string) {}

  private async phase<P extends OmpPhase>(phase: P, prompt: string, context: AttemptContext): Promise<PhaseResults[P]> {
    const before = phase === "execute" ? null : await worktreeSnapshot(context.worktreePath);
    const outcome = await runOmpPhase(this.config, phase, prompt, context, this.skillsDir === undefined ? {} : { skillsDir: this.skillsDir });
    if (before !== null) {
      const after = await worktreeSnapshot(context.worktreePath);
      if (before !== after) {
        await writeFile(join(outcome.evidenceDir, "worktree-mutation.json"), JSON.stringify({ before, after }), { mode: 0o600 });
        let observedTokens: number | null = null;
        if (outcome.reason === "completed") {
          try { observedTokens = decodeOmpPhase(phase, outcome.events, this.config.selection.model).tokenUsage ?? null; } catch { /* keep unknown */ }
        }
        throw Object.assign(new Error(`omp-read-only-phase-mutated: ${outcome.evidenceDir}`), observedTokens === null ? {} : { observedTokens });
      }
    }
    if (outcome.reason !== "completed") {
      const lowerBound = ompUsageLowerBound(outcome.events);
      if (lowerBound !== null) await writeFile(join(outcome.evidenceDir, "usage-lower-bound.json"), JSON.stringify({ tokens: lowerBound }), { mode: 0o600 });
      throw Object.assign(new Error(`omp-${outcome.reason}: ${outcome.evidenceDir}`), { neverStarted: outcome.neverStarted });
    }
    try {
      const result = decodeOmpPhase(phase, outcome.events, this.config.selection.model);
      await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(result.usageEvidence), { mode: 0o600 });
      return result;
    } catch (error) {
      await writeFile(join(outcome.evidenceDir, "decode-error.txt"), String(error), { mode: 0o600 });
      throw error;
    }
  }

  plan(context: AttemptContext) { return this.phase("plan", buildPlannerPrompt(context.contract), context); }
  async execute(context: AttemptContext) {
    try {
      const headBefore = await worktreeHead(context.worktreePath);
      const execution = await this.phase("execute", buildExecutorPrompt(context), context);
      if (await worktreeHead(context.worktreePath) !== headBefore) {
        throw Object.assign(new Error("omp-head-mutated"), { observedTokens: execution.tokenUsage });
      }
      const actual = await observedChangedPaths(context.worktreePath);
      const reported = execution.changedFiles;
      if (new Set(reported).size !== reported.length || JSON.stringify([...reported].sort()) !== JSON.stringify(actual)) {
        throw Object.assign(new Error(`omp-changed-files-mismatch: actual=${JSON.stringify(actual)} reported=${JSON.stringify(reported)}`), { observedTokens: execution.tokenUsage });
      }
      return execution;
    }
    catch (error) {
      if (context.abortSignal?.aborted && !(error !== null && typeof error === "object" && "observedTokens" in error)) return null;
      throw error;
    }
  }
  verify(context: AttemptContext) { return this.phase("verify", buildVerifierPrompt(context), context); }
}
