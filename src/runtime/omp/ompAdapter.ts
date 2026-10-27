import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MaterializedAgentConfigV1 } from "../../agents/types.js";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../claude/prompts.js";
import type { AttemptContext, RuntimeAdapter, SingleCallRequest, SingleCallResult } from "../types.js";
import type { PhaseResults } from "../codex/protocol.js";
import { runOmpPhase } from "./runOmpPhase.js";
import { runOmpSingleCall } from "./ompSingleCall.js";
import type { OmpPhase } from "./phasePrompt.js";
import { observedChangedPaths, worktreeHead, worktreeSnapshot } from "./worktreeSnapshot.js";
import type { CallClassification } from "../failureCause.js";
import { phaseLimitMs, runWithTransientRetry, TRANSIENT_RETRY_DELAYS_MS, tryContext, type TryObservation } from "../transientRetry.js";
import type { OmpPhaseOutcome } from "./runOmpPhase.js";

/**
 * Per-contract tool rules (spec 2026-10-22 §4 "omp after-exit check"): an execute call ran a command outside the
 * contract's tool rules. Classified by its `code` alone (never by text) as the terminal cause `tool-rule-violated`.
 */
export class OmpToolRuleViolated extends Error {
  readonly code = "omp-tool-rule-violated";
  constructor(evidenceDir: string, readonly detail: string) {
    super(`omp-tool-rule-violated: ${evidenceDir}`);
    this.name = "OmpToolRuleViolated";
  }
}

/** The phase fold's named refusal of a tool the phase lacks (ompProtocol.ts `forbidTool`); null for any other error. */
function forbiddenPhaseTool(error: unknown): string | null {
  const { code, detail } = (error ?? {}) as { code?: unknown; detail?: unknown };
  return code === "omp-phase-tool-forbidden" && typeof detail === "string" ? detail : null;
}

export class OmpAdapter implements RuntimeAdapter {
  constructor(private readonly config: MaterializedAgentConfigV1, private readonly skillsDir?: string, private readonly retryDelaysMs: readonly number[] = TRANSIENT_RETRY_DELAYS_MS) {}

  /**
   * Failure causes (ccloop spec 2026-10-21-failure-causes-and-transient-retries-design.md §3 omp, §4): omp has no provider
   * error sample, so a failed call classifies `unknown` (never retried) unless it never spawned (ENOENT ⇒ executable-missing)
   * or timed out; the shared loop is in place for the causes later rounds can name. Read-only phases are retry-safe.
   */
  private async phase<P extends OmpPhase>(phase: P, prompt: string, context: AttemptContext): Promise<PhaseResults[P]> {
    return runWithTransientRetry<PhaseResults[P]>({
      limitMs: phaseLimitMs(this.config.installation.timeoutMs, context), delaysMs: this.retryDelaysMs, signal: context.abortSignal,
      attempt: async (tryLimitMs) => {
        const seen: { outcome?: OmpPhaseOutcome } = {};
        try {
          const value = await this.phaseOnce(phase, prompt, tryContext(context, tryLimitMs), seen);
          return { ok: true, value, evidenceDir: seen.outcome?.evidenceDir ?? context.runDir };
        } catch (error) {
          const outcome = seen.outcome;
          let classification: CallClassification | null;
          if (error instanceof OmpToolRuleViolated) classification = { cause: "tool-rule-violated", workObserved: true, detail: error.detail };
          // Plan phase tools (spec 2026-10-27-plan-phase-tools): a tool the phase does not have, by its code and named detail.
          else if (forbiddenPhaseTool(error) !== null) classification = { cause: "tool-rule-violated", workObserved: true, detail: forbiddenPhaseTool(error) };
          else if (outcome === undefined || String(error).includes("omp-read-only-phase-mutated")) classification = { cause: "unknown", workObserved: true, detail: null };
          else if (outcome.reason === "aborted") classification = null;
          else if (outcome.reason === "timeout") classification = { cause: "budget-exhausted", workObserved: true, detail: null };
          // Activity watchdog (spec 2026-10-21 §2.3): transient; retried when the phase is read-only or no tool ran.
          else if (outcome.reason === "stalled") classification = { cause: "stalled", workObserved: outcome.stream.call.value().workObserved, detail: null };
          else if (outcome.reason === "spawn-error") classification = { cause: outcome.spawnErrno === "ENOENT" ? "executable-missing" : "unknown", workObserved: false, detail: outcome.spawnErrno ?? null };
          else classification = outcome.stream.call.value();
          const observed = (error as { observedTokens?: unknown }).observedTokens;
          const observation: TryObservation = (error as { neverStarted?: unknown }).neverStarted === true ? { kind: "rule0" }
            : typeof observed === "number" && observed > 0 ? { kind: "tokens", tokens: observed } : { kind: "null" };
          return { ok: false, error: error as Error, evidenceDir: outcome?.evidenceDir ?? context.runDir, classification,
            retrySafe: classification !== null && (phase !== "execute" || !classification.workObserved), observation };
        }
      },
    });
  }

  private async phaseOnce<P extends OmpPhase>(phase: P, prompt: string, context: AttemptContext, seen: { outcome?: OmpPhaseOutcome }): Promise<PhaseResults[P]> {
    // Multi-repo runs (spec 2026-10-24-multi-dir-projects §11.3): a read-only phase is checked in every worktree.
    const watched = [{ key: null as string | null, path: context.worktreePath }, ...(context.extraWorktrees ?? []).map((extra) => ({ key: extra.key as string | null, path: extra.worktreePath }))];
    const before = phase === "execute" ? null : await Promise.all(watched.map((tree) => worktreeSnapshot(tree.path)));
    const outcome = await runOmpPhase(this.config, phase, prompt, context, this.skillsDir === undefined ? {} : { skillsDir: this.skillsDir });
    seen.outcome = outcome;
    // Per-contract tool rules (spec 2026-10-22 §4; plan Task 4): checked on every execute outcome, before any other reading,
    // so a violation followed by a timeout, a crash or a bad answer still ends the run as tool-rule-violated.
    const toolRules = phase === "execute" ? context.contract?.executionPolicy?.toolRules : undefined;
    // Live transcript (Orca spec 2026-10-23 §10.2.3): runOmpPhase folded the check with the same rules while the call ran.
    const violation = toolRules === undefined ? null : outcome.stream.toolRule?.value() ?? null;
    if (violation !== null) {
      await writeFile(join(outcome.evidenceDir, "tool-rule-violation.txt"), violation, { mode: 0o600 });
      let observedTokens: number | null = null;
      if (outcome.reason === "completed") {
        try { observedTokens = (outcome.stream.phase!.value() as PhaseResults[P]).tokenUsage ?? null; } catch { /* keep unknown */ }
      }
      throw Object.assign(new OmpToolRuleViolated(outcome.evidenceDir, violation), observedTokens === null ? {} : { observedTokens });
    }
    if (before !== null) {
      const afterAll = await Promise.all(watched.map((tree) => worktreeSnapshot(tree.path)));
      const changed = afterAll.findIndex((after, index) => after !== before[index]);
      if (changed >= 0) {
        const [snapshotBefore, after, key] = [before[changed], afterAll[changed], watched[changed]!.key];
        await writeFile(join(outcome.evidenceDir, "worktree-mutation.json"), JSON.stringify(key === null ? { before: snapshotBefore, after } : { key, before: snapshotBefore, after }), { mode: 0o600 });
        let observedTokens: number | null = null;
        if (outcome.reason === "completed") {
          try { observedTokens = (outcome.stream.phase!.value() as PhaseResults[P]).tokenUsage ?? null; } catch { /* keep unknown */ }
        }
        throw Object.assign(new Error(`omp-read-only-phase-mutated: ${outcome.evidenceDir}`), observedTokens === null ? {} : { observedTokens });
      }
    }
    if (outcome.reason !== "completed") {
      const lowerBound = outcome.stream.lowerBound.value();
      if (lowerBound !== null) await writeFile(join(outcome.evidenceDir, "usage-lower-bound.json"), JSON.stringify({ tokens: lowerBound }), { mode: 0o600 });
      throw Object.assign(new Error(`omp-${outcome.reason}: ${outcome.evidenceDir}`), { neverStarted: outcome.neverStarted });
    }
    try {
      const result = outcome.stream.phase!.value() as PhaseResults[P];
      await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(result.usageEvidence), { mode: 0o600 });
      return result;
    } catch (error) {
      await writeFile(join(outcome.evidenceDir, "decode-error.txt"), String(error), { mode: 0o600 });
      throw error;
    }
  }

  plan(context: AttemptContext) { return this.phase("plan", buildPlannerPrompt(context.contract, context.lastFailure, context.priorFailures, context.operatorNote, context), context); }
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
      // Per-contract tool rules (spec 2026-10-22 §4): a violation is terminal, so an abort never turns it into "no result".
      if (context.abortSignal?.aborted && !(error instanceof OmpToolRuleViolated) && !(error !== null && typeof error === "object" && "observedTokens" in error)) return null;
      throw error;
    }
  }
  verify(context: AttemptContext) { return this.phase("verify", buildVerifierPrompt(context), context); }

  /**
   * OMP single call (Orca spec 2026-10-14 §3.3): one read-only structured call bounded by the catalog cap, refused before
   * spawning when that cap exceeds the request's. A process that did not end cleanly books null even after a complete
   * message (§3.3.7); its observed total stays diagnostic, as for a phase.
   */
  async singleCall(request: SingleCallRequest): Promise<SingleCallResult> {
    const outcome = await runOmpSingleCall(this.config, request);
    if (outcome.reason !== "completed") {
      const lowerBound = outcome.stream.lowerBound.value();
      // Best-effort diagnostic: a failed write must not replace the refusal below and its booking.
      if (lowerBound !== null) await writeFile(join(outcome.evidenceDir, "usage-lower-bound.json"), JSON.stringify({ tokens: lowerBound }), { mode: 0o600 }).catch(() => undefined);
      // Ruling m4: a pre-spawn abort, a timeoutMs <= 0 or a spawn error is neverStarted (books 0, as types.ts observedTokensOf).
      // Activity watchdog (spec 2026-10-21 §2.4): a stalled single call names its cause; its caller owns retries.
      throw Object.assign(new Error(`omp-${outcome.reason}: ${outcome.evidenceDir}`), { neverStarted: outcome.neverStarted },
        outcome.reason === "stalled" ? { failureCause: { cause: "stalled", workObserved: false, detail: null, retries: 0 } } : {});
    }
    try {
      const result = outcome.stream.singleCall!.value(outcome.evidenceDir);
      // Best-effort evidence: a failed write must not turn the decoded, observed answer into a null-booked failure.
      await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(result.usageEvidence), { mode: 0o600 }).catch(() => undefined);
      return result;
    } catch (error) {
      // Best-effort diagnostic: a failed write must not replace the decode refusal and its booking.
      await writeFile(join(outcome.evidenceDir, "decode-error.txt"), String(error), { mode: 0o600 }).catch(() => undefined);
      throw error;
    }
  }
}
