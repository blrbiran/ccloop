import { normalizeExecutionFinal, ExecutionFormatFailure } from "../executionNormalizer.js";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAgentCatalog } from "../../agents/agentCatalog.js";
import type { InstallationV1 } from "../../agents/types.js";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../claude/prompts.js";
import type { AttemptContext, RuntimeAdapter, SingleCallRequest, SingleCallResult } from "../types.js";
import { addressableMcpServer, CodexConfigFileMissing, codexConfigFileArgs, codexSingleCallArgs, codexSingleCallHome, effectiveCodexHome } from "./codexSingleCall.js";
import { SingleCallSchemaUnsupported, strictSingleCallSchema, stripOptionalNulls } from "./strictSingleCall.js";
import { codexResultOf, parseCodexConfig, phaseFinalAccepts, scanFinalMessage, type CodexConfig, type CodexPhase, type PhaseResults } from "./protocol.js";
import { runCodexPhase, type PhaseOutcome } from "./runCodexPhase.js";
import { codexToolRuleNetworkSetting } from "../../agents/codexNetworkConfig.js";
import { codexToolRuleRows } from "../toolRules.js";
import { attachedCause, causeDetail, singleCallCauseOf, type CallClassification } from "../failureCause.js";
import { phaseLimitMs, runWithTransientRetry, tryContext, type TryObservation, type TryResult } from "../transientRetry.js";

/** Codex rate-limit spec §3.2: waits before each retry of a phase rejected by 429 before any work (three retries). */
export const RATE_LIMIT_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000];
export interface CodexAdapterOptions {
  rateLimitDelaysMs?: readonly number[];
  /** Every-agent requirement chain (Orca spec 2026-10-15 §6.1): the installation a single call re-reads its catalog for. */
  installation?: InstallationV1;
}

/** Orca handoff delivery C-3: an aborted phase, carrying the usage its stdout showed before the kill (or null). */
export class CodexPhaseAborted extends Error {
  constructor(readonly evidenceDir: string, readonly observedTokens: number | null) {
    super(`codex-aborted: ${evidenceDir}`);
    this.name = "CodexPhaseAborted";
  }
}

/**
 * Spec §3 codex: the cause of a call that did not complete, or null for an aborted one. One classification for the phase
 * path (failedTry) and the single call (Orca spec 2026-11-06 quota probe §4 step 2), so both name the same stream alike.
 */
function classifyOutcome(outcome: PhaseOutcome): CallClassification | null {
  if (outcome.reason === "aborted") return null;
  if (outcome.reason === "timeout") return { cause: "budget-exhausted", workObserved: true, detail: null };
  // Activity watchdog (spec 2026-10-21 §2.3): a stalled call is transient; it is retried when no work was seen or the phase is read-only.
  if (outcome.reason === "stalled") return { cause: "stalled", workObserved: outcome.stream.call.value()?.workObserved ?? true, detail: null };
  if (outcome.reason === "spawn-error") return { cause: outcome.spawnErrno === "ENOENT" ? "executable-missing" : "unknown", workObserved: false, detail: outcome.spawnErrno ?? null };
  if (outcome.reason.startsWith("codex-skills-") || outcome.reason.startsWith("codex-phase-isolation-")) return { cause: "unknown", workObserved: false, detail: outcome.refusalDetail === undefined ? outcome.reason : causeDetail(`${outcome.reason}: ${outcome.refusalDetail}`) };
  return outcome.stream.call.value() ?? { cause: "unknown", workObserved: true, detail: null };
}

/**
 * Orca #122: a provider that cannot take `--output-schema` answers the call with a 400 about the response format. The text test
 * is Orca's own (Orca src/control/structuredOutputHint.ts), read from the call's error rows as classified above (never model
 * text). Such a call that did no work is sent once more in prompt mode (`structuredOutput: "prompt"` for that call only); the
 * person's agents table is never written, so `structured-output-fallback.json` beside the second call records that it fell back.
 */
const FORMAT_FIELD = /text\.format|response_format|output_schema|json_schema/i;
const BAD_REQUEST = /\b400\b|bad request|invalid_request_error/i;
function refusedOutputSchema(classification: CallClassification | null): classification is CallClassification & { detail: string } {
  return classification !== null && !classification.workObserved && classification.detail !== null && FORMAT_FIELD.test(classification.detail) && BAD_REQUEST.test(classification.detail);
}
async function recordPromptFallback(evidenceDir: string, refused: { evidenceDir: string; detail: string }): Promise<void> {
  await writeFile(join(evidenceDir, "structured-output-fallback.json"), JSON.stringify({ schema: "ccloop-structured-output-fallback-v1",
    refusedEvidenceDir: refused.evidenceDir, detail: refused.detail }), { mode: 0o600 });
}

/** Orca issue #262: the error carries a classified cause that is neither a timeout nor unknown. */
function ownCause(error: unknown): boolean {
  const cause = attachedCause(error)?.classification.cause;
  return cause !== undefined && cause !== "budget-exhausted" && cause !== "unknown";
}

export class CodexAdapter implements RuntimeAdapter {
  private readonly config: CodexConfig;
  // Agent selection (2026-09-26): extraEnv carries the installation's config directory (CODEX_HOME) to the CLI.
  // Codex phase isolation (spec 2026-10-18 §3.3): with an installation (production, codexDescriptor.createAdapter) every
  // phase runs isolated in the installation's private homes; an adapter built without one keeps the legacy unisolated spawn.
  private readonly rateLimitDelaysMs: readonly number[];
  private readonly installation: InstallationV1 | undefined;
  constructor(rawConfig: unknown, private readonly extraEnv?: Record<string, string>, private readonly codexSkillsDir?: string, options: CodexAdapterOptions = {}) {
    this.config = parseCodexConfig(rawConfig);
    this.rateLimitDelaysMs = options.rateLimitDelaysMs ?? RATE_LIMIT_DELAYS_MS;
    this.installation = options.installation;
  }

  /**
   * Spec §3.2–3.3 (2026-10-13): a call rejected by 429 before any work is called again after a bounded, abortable wait,
   * within the phase's time limit. Each call keeps its own evidence directory; a rejected one also records rate-limit.json.
   * *** Failure causes (ccloop spec 2026-10-21-failure-causes-and-transient-retries-design.md §4): the loop is now the
   * shared runWithTransientRetry, which also retries a provider-5xx / network failure of a read-only phase (plan, verify)
   * or of a call that observed no work. The 429 predicate is exactly today's (before-work), rate-limit.json is unchanged,
   * and the phase limit now also respects the contract's perAttemptTimeoutMs (each try gets the limit minus what has
   * elapsed). ***
   */
  private async phase<P extends CodexPhase>(phase: P, prompt: string, context: AttemptContext): Promise<PhaseResults[P]> {
    // Orca #122: the call whose --output-schema the provider refused; the phase's next call goes in prompt mode, at once.
    let refused: { evidenceDir: string; detail: string } | null = null;
    return runWithTransientRetry<PhaseResults[P]>({
      limitMs: phaseLimitMs(this.config.timeoutMs, context), delaysMs: this.rateLimitDelaysMs, signal: context.abortSignal,
      attempt: async (tryLimitMs) => {
        const outcome = await runCodexPhase(this.config, { phase, prompt, context: tryContext(context, tryLimitMs), ...(refused === null ? {} : { promptSchema: true as const }) },
          this.extraEnv, this.codexSkillsDir, this.installation);
        if (refused !== null) await recordPromptFallback(outcome.evidenceDir, refused);
        try {
          return { ok: true, value: await this.decodePhase(phase, outcome), evidenceDir: outcome.evidenceDir };
        } catch (error) {
          const failed = this.failedTry<PhaseResults[P]>(phase, outcome, error as Error);
          if (failed.ok || refused !== null || this.installation?.structuredOutput === "prompt" || !refusedOutputSchema(failed.classification)) return failed;
          refused = { evidenceDir: outcome.evidenceDir, detail: failed.classification.detail };
          return { ...failed, immediateRetry: true };
        }
      },
    });
  }

  /** Spec §3 codex and §4 retry-safety: the cause of a failed call and whether retrying it could not have changed the worktree. */
  private failedTry<T>(phase: CodexPhase, outcome: PhaseOutcome, error: Error): TryResult<T> {
    const rateLimited = outcome.reason === "exit-error" || outcome.reason === "io-error" ? outcome.stream.rateLimit.value() : null;
    const classification = classifyOutcome(outcome);
    // The 429 row keeps exactly the 2026-10-13 predicate; every other retryable cause needs a read-only phase or no work seen.
    const retrySafe = classification?.cause === "rate-limited" ? rateLimited === "before-work"
      : classification !== null && (phase !== "execute" || !classification.workObserved);
    const observedTokens = (error as { observedTokens?: unknown }).observedTokens;
    const observation: TryObservation = (error as { rateLimitedBeforeWork?: unknown }).rateLimitedBeforeWork === true || (error as { neverStarted?: unknown }).neverStarted === true ? { kind: "rule0" }
      : typeof observedTokens === "number" && observedTokens > 0 ? { kind: "tokens", tokens: observedTokens } : { kind: "null" };
    return {
      ok: false, error, evidenceDir: outcome.evidenceDir, classification, retrySafe, observation,
      onDecided: rateLimited === "before-work"
        ? async (call, nextDelayMs) => { await writeFile(join(outcome.evidenceDir, "rate-limit.json"), JSON.stringify({ classification: rateLimited, call, nextDelayMs }), { mode: 0o600 }); }
        : undefined,
    };
  }

  get awaitAbortedPhaseCleanup(): boolean { return this.codexSkillsDir !== undefined; }

  /** One call's outcome as the phase's result, or the error it fails with (unchanged from before the shared loop). */
  private async decodePhase<P extends CodexPhase>(phase: P, outcome: PhaseOutcome): Promise<PhaseResults[P]> {
    const rateLimited = outcome.reason === "exit-error" || outcome.reason === "io-error" ? outcome.stream.rateLimit.value() : null;
    // Orca issue #262 (as omp's, Orca #116): a call that ended without a final after codex reported turn usage leaves that
    // usage as a floor (collect's usageLowerBound). Best-effort: a failed write must not replace the call's own failure.
    const lowerBound = outcome.reason === "completed" ? null : outcome.stream.turnUsage.value();
    if (lowerBound !== null && lowerBound > 0) await writeFile(join(outcome.evidenceDir, "usage-lower-bound.json"), JSON.stringify({ tokens: lowerBound }), { mode: 0o600 }).catch(() => undefined);
    if (outcome.reason === "aborted") throw new CodexPhaseAborted(outcome.evidenceDir, outcome.observedTokens);
    // Spec §3.3: named; a rejection before any work books 0 (rateLimitedBeforeWork, observedTokensOf), any other keeps
    // the usage its stdout showed, or null.
    if (rateLimited !== null) {
      throw Object.assign(new Error(`codex-rate-limited: ${outcome.evidenceDir}`), rateLimited === "before-work" ? { rateLimitedBeforeWork: true } : { observedTokens: outcome.observedTokens });
    }
    if (outcome.reason.startsWith("codex-phase-isolation-")) {
      // Spec 2026-10-18 §3.5: refused before spawn, no process and no token; named exception to "usage is never booked as 0".
      throw Object.assign(new Error(`${outcome.reason}: ${outcome.evidenceDir}${outcome.refusalDetail === undefined ? "" : `: ${causeDetail(outcome.refusalDetail)}`}`), { neverStarted: true });
    }
    if (outcome.reason !== "completed" || outcome.final === null) {
      // Orca ruling 26 (session c85d2c4e, 2026-09-28): as the aborted path, a phase that timed out or failed carries the
      // turn usage its stdout showed (runCodexPhase observes it for every outcome but completed), null when none.
      throw Object.assign(new Error(`${outcome.reason.startsWith("codex-skills-") ? outcome.reason : `codex-${outcome.reason}`}: ${outcome.evidenceDir}`), { observedTokens: outcome.observedTokens });
    }
    if (phase === "execute") {
      // Completion and usage are independent facts; invalid finals must not erase actual spend.
      let usage:ReturnType<typeof outcome.stream.uniqueUsage.value>;
      try { usage=outcome.stream.uniqueUsage.value(); }
      catch(error) {
        await writeFile(join(outcome.evidenceDir,"decode-error.txt"),String(error),{mode:0o600});
        // Tester follow-up E §1 (Orca issue #249): as ruling 26 above, the failed phase carries the turn usage its stdout
        // showed (a mid-stream error row before a completed turn), null when none; the failure itself is unchanged.
        throw Object.assign(new Error(`${String(error)}: ${outcome.evidenceDir}`),{observedTokens:outcome.stream.turnUsage.value()});
      }
      const modelUsage=outcome.stream.modelUsage.value(this.config.model) ?? undefined;
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
      const result = codexResultOf(phase, outcome.stream.usage.value(), final);
      await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(result.usageEvidence, null, 2), { mode: 0o600 });
      // Orca accounts plan B3: codex runs one model, so the whole usage belongs to it.
      const modelUsage = outcome.stream.modelUsage.value(this.config.model);
      return modelUsage === null ? result : { ...result, modelUsage };
    } catch (error) {
      await writeFile(join(outcome.evidenceDir, "decode-error.txt"), String(error), { mode: 0o600 });
      // Tester follow-up E §1 (Orca issue #249): as the execute path above, the turn usage the stdout showed, null when none.
      throw Object.assign(new Error(`${String(error)}: ${outcome.evidenceDir}`), { observedTokens: outcome.stream.turnUsage.value() });
    }
  }

  plan(context: AttemptContext) { return this.phase("plan", buildPlannerPrompt(context.contract, context.lastFailure, context.priorFailures, context.operatorNote, context), context); }
  async execute(context: AttemptContext) {
    // Per-contract tool rules (spec 2026-10-22 §5 "Prompt"; review round 1 M6): the prompt states this kind's final status.
    const toolRules = context.contract.executionPolicy.toolRules;
    const toolRuleRows = toolRules === undefined ? undefined
      : codexToolRuleRows(toolRules, this.config.sandbox, await codexToolRuleNetworkSetting(toolRules.network, "execute", this.config.sandbox, this.installation, this.extraEnv)).rows;
    try { return await this.phase("execute", buildExecutorPrompt(context, { schemaNeedsNull: true, ...(toolRuleRows === undefined ? {} : { toolRuleRows }) }) + "\nWrap the complete or partial result in a single object with the sole key result, as required by the output schema.", context); }
    catch (error) {
      // An aborted execute that was observed spending tokens throws, so runLoop can settle that usage;
      // one that was not keeps answering null exactly as before.
      if (error instanceof Error && error.message.startsWith("codex-skills-")) throw error;
      // Orca issue #262: a call that had already ended for a cause of its own (stalled, network, ...) before the abort
      // reached it throws that cause too, so runLoop does not book the timeout as budget-exhausted.
      if (context.abortSignal?.aborted && !(error instanceof CodexPhaseAborted && error.observedTokens !== null) && !ownCause(error)) return null;
      throw error;
    }
  }
  verify(context: AttemptContext) { return this.phase("verify", buildVerifierPrompt(context), context); }

  /**
   * Every-agent requirement chain (Orca spec 2026-10-15 §6.1, R2, R9): one structured call, tools off, in a private HOME and
   * CODEX_HOME. Codex cannot cap the output; the bound is checked by Orca after the fact. Refused before spawning when the
   * installed feature list is unknown, since the tool flags could not be turned off (plan spec issue 9). As omp's (R6), the
   * re-check lives inside the call's deadline, computed once; the spawn gets only what the re-check left.
   */
  async singleCall(request: SingleCallRequest): Promise<SingleCallResult> {
    if (this.installation === undefined) throw new Error("single-call-unsupported");
    // The provider demands a strict schema; a caller's schema that leaves keys optional is projected on the wire only,
    // and a shape strict mode cannot express is refused before the spawn rather than sent and refused by the provider.
    let wireSchema: Record<string, unknown>;
    try { wireSchema = strictSingleCallSchema(request.responseSchema); }
    catch (error) {
      if (error instanceof SingleCallSchemaUnsupported) throw Object.assign(error, { neverStarted: true });
      throw error;
    }
    const deadline = Date.now() + Math.min(request.timeoutMs, this.config.timeoutMs);
    const catalog = await readAgentCatalog(this.installation, { deadline, signal: request.signal, log: (line) => { process.stderr.write(`${line}\n`); } });
    if (catalog.codexFeatures === null) {
      throw Object.assign(new Error(`codex-single-call-unavailable: ${catalog.catalogError ?? "no feature list"}`), { code: "codex-single-call-unavailable", neverStarted: true });
    }
    const features = catalog.codexFeatures;
    // Fix round 3: the private homes are checked before the MCP list's absence is reported, so a symlinked private dir (which
    // also made the isolated MCP probe fail) is named as such, not as a missing list.
    const source = effectiveCodexHome(this.installation, process.env);
    const isolated = await codexSingleCallHome({ runDir: request.runDir, sourceCodexHome: source, executable: this.config.command[0], env: process.env });
    // Orca tester issue 121: a missing catalog file (which also failed the MCP probe) is named before the missing list.
    let configFileArgs: string[];
    try { configFileArgs = await codexConfigFileArgs(source); }
    catch (error) {
      if (error instanceof CodexConfigFileMissing) throw Object.assign(new Error(`codex-single-call-unavailable: ${error.message}`), { code: "codex-single-call-unavailable", neverStarted: true });
      throw error;
    }
    // Task 8 fix round 2: the MCP server names are needed as much as the feature list (their servers would start otherwise).
    if (catalog.codexMcpServers === null) {
      // Orca tester issue 125: the probe's own reason, bounded, so the refusal says why the list is missing.
      throw Object.assign(new Error(`codex-single-call-unavailable: no MCP server list${catalog.mcpError === undefined ? "" : `: ${causeDetail(catalog.mcpError)}`}`), { code: "codex-single-call-unavailable", neverStarted: true });
    }
    const mcpServers = catalog.codexMcpServers;
    const unaddressable = mcpServers.find((name) => !addressableMcpServer(name));
    if (unaddressable !== undefined) {
      throw Object.assign(new Error(`codex-single-call-unavailable: MCP server ${JSON.stringify(unaddressable)} cannot be turned off by -c`), { code: "codex-single-call-unavailable", neverStarted: true });
    }
    const context = { runDir: request.runDir, attempt: 1, worktreePath: request.cwd, abortSignal: request.signal, onProcessRegistered: request.onProcessRegistered,
      state: { budgetSnapshot: { timeRemainingMs: Math.max(1, deadline - Date.now()) } } } as unknown as AttemptContext;
    const call = (promptSchema: boolean, timeRemainingMs: number) => runCodexPhase(this.config, { phase: "single-call", prompt: request.prompt,
      context: { ...context, state: { budgetSnapshot: { timeRemainingMs } } } as unknown as AttemptContext, spawn: {
        schema: wireSchema, env: { ...process.env, HOME: isolated.home, CODEX_HOME: isolated.codexHome }, promptSchema,
        args: ({ schemaPath, finalPath }) => codexSingleCallArgs({ model: this.config.model, cwd: request.cwd, schemaPath, finalPath, features, mcpServers, configFileArgs, promptSchema }),
      } });
    let outcome = await call(this.installation.structuredOutput === "prompt", context.state.budgetSnapshot.timeRemainingMs);
    // Orca #122: a refused --output-schema is sent once more in prompt mode, within the same deadline. A refusal never has a
    // completed turn (refusedOutputSchema needs an unclassified-as-completed call), so the refused call observed no usage.
    let fellBack = false;
    const refusal = outcome.reason === "completed" || this.installation.structuredOutput === "prompt" ? null : classifyOutcome(outcome);
    if (refusedOutputSchema(refusal) && Date.now() < deadline && !request.signal?.aborted) {
      const refused = { evidenceDir: outcome.evidenceDir, detail: refusal.detail };
      outcome = await call(true, Math.max(1, deadline - Date.now()));
      fellBack = true;
      await recordPromptFallback(outcome.evidenceDir, refused);
    }
    if (outcome.reason !== "completed") {
      // Fix round 1 (repo convention, omp "Ruling m4", claude): runCodexPhase writes the prompt only after process.json is
      // saved, so a call that ended without it -- aborted before or at spawn, a spawn error, a deadline hit first -- never
      // sent anything: neverStarted, booked 0. The codex phase path is unchanged.
      // Orca #122: after a fallback the refused call had started, so the pair never books 0 by this rule.
      const neverStarted = !fellBack && !(await access(join(outcome.evidenceDir, "process.json")).then(() => true, () => false));
      const error = outcome.reason === "aborted" ? new CodexPhaseAborted(outcome.evidenceDir, outcome.observedTokens)
        : Object.assign(new Error(`codex-${outcome.reason}: ${outcome.evidenceDir}`), { observedTokens: outcome.observedTokens },
          // Activity watchdog (spec 2026-10-21 §2.4): a stalled single call names its cause; its caller owns retries.
          outcome.reason === "stalled" ? { failureCause: { cause: "stalled", workObserved: false, detail: null, retries: 0 } } : {},
          // Orca spec 2026-11-06 quota probe §4 step 2: the cause the phase path computes for the same stream, for the record.
          singleCallCauseOf(classifyOutcome(outcome)));
      throw neverStarted ? Object.assign(error, { neverStarted: true }) : error;
    }
    const result = outcome.stream.singleCall.value(outcome.final, this.config.model, outcome.evidenceDir);
    // The projection made the caller's optional keys required-and-nullable, so a null for one is an absent key, not an
    // answer; the caller's schema decides which ones (strictSingleCall.ts).
    return { ...result, output: stripOptionalNulls(result.output, request.responseSchema) };
  }
}
