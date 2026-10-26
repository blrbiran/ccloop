import { z } from "zod";
import type { ModelUsageV1 } from "../../control/usage.js";
import { normalizeExecutionFinal } from "../executionNormalizer.js";
import type { UsageEvidence } from "../types.js";
import { phaseFinalAccepts, scanFinalMessage, verificationSchema, type PhaseResults } from "../codex/protocol.js";
import type { OmpPhase } from "./phasePrompt.js";
import { foldText, type JsonLine } from "../streamLines.js";

const planSchema = z.object({ summary: z.string(), primaryTargetPaths: z.array(z.string()) }).strict();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Mirrors omp's isActionableContent (messages.ts:544) for the stop branch: thinking is actionable only when signed.
const ALWAYS_ACTIONABLE_BLOCKS = new Set(["toolCall", "image", "redactedThinking", "anthropicServerTool"]);
function actionableStop(message: Record<string, unknown>): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    if (!record(block) || typeof block.type !== "string") return false;
    if (ALWAYS_ACTIONABLE_BLOCKS.has(block.type)) return true;
    if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
    if (block.type === "thinking") return typeof block.thinkingSignature === "string" && block.thinkingSignature.trim().length > 0;
    return false;
  });
}

export function assistantUsage(message: Record<string, unknown>): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } {
  if (!record(message.usage)) throw new Error("omp-usage-invalid");
  const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
  if (!safe(input) || !safe(output) || !safe(cacheRead) || !safe(cacheWrite) || !safe(totalTokens)
    || input + output + cacheRead + cacheWrite !== totalTokens) throw new Error("omp-usage-invalid");
  return { input, output, cacheRead, cacheWrite, total: totalTokens };
}

/** The diagnostic lower bound never becomes a ccloop usage observation. */
export function ompUsageLowerBound(events: string): number | null {
  return foldText(events, new OmpLowerBoundFold()).value();
}

/** Live transcript (Orca spec 2026-10-23 §10.2.3): ompUsageLowerBound as a fold. */
export class OmpLowerBoundFold {
  private total = 0;
  push(line: JsonLine): void {
    if (line.kind !== "row") return;
    const row = line.row;
    if (!record(row) || row.type !== "message_end" || !record(row.message) || row.message.role !== "assistant") return;
    try { this.total += assistantUsage(row.message).total; } catch { /* incomplete row */ }
  }
  value(): number | null { return Number.isSafeInteger(this.total) && this.total > 0 ? this.total : null; }
}

/**
 * The assistant messages' summed usage, read one message at a time. Any unreadable usage is omp-usage-invalid, as is a
 * total that is not a positive safe integer -- the checks decodeOmpPhase and decodeOmpSingleCall made over their message
 * lists, without keeping the list.
 */
export class OmpUsageSum {
  private invalid = false;
  private readonly sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  add(message: Record<string, unknown>): void {
    if (this.invalid) return;
    let usage: ReturnType<typeof assistantUsage>;
    try { usage = assistantUsage(message); } catch { this.invalid = true; return; }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) this.sums[key] += usage[key];
  }
  checked(): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } {
    if (this.invalid || !Object.values(this.sums).every(Number.isSafeInteger) || this.sums.total === 0) throw new Error("omp-usage-invalid");
    return { ...this.sums };
  }
}

export function decodeOmpPhase<P extends OmpPhase>(phase: P, events: string, expectedSelector: string): PhaseResults[P] {
  return foldText(events, new OmpPhaseFold(phase, expectedSelector)).value() as PhaseResults[P];
}

/**
 * Live transcript (Orca spec 2026-10-23 §10.2.3): decodeOmpPhase as a fold. The first failing line decides and later lines
 * are not read, as the loop's first throw did. Of the assistant messages it keeps only what the verdicts read: their summed
 * usage, whether any named another model, and the last one (the answer). A line too large to keep is
 * `omp-events-line-too-large`.
 */
export class OmpPhaseFold {
  private error: string | null = null;
  private readonly allowed: Set<string>;
  private readonly pendingTools = new Map<string, string>();
  private ended = false;
  private terminalCount = 0;
  private messages = 0;
  private readonly usage = new OmpUsageSum();
  private wrongModel = false;
  private last: Record<string, unknown> | undefined;

  constructor(private readonly phase: OmpPhase, private readonly expectedSelector: string) {
    this.allowed = new Set(phase === "execute" ? ["read", "grep", "glob", "edit", "write", "bash"] : ["read", "grep", "glob"]);
  }

  push(line: JsonLine): void {
    if (this.error !== null || line.kind === "blank") return;
    if (line.kind === "too-large") { this.error = "omp-events-line-too-large"; return; }
    if (line.kind === "unparsed") { this.error = "omp-events-invalid"; return; }
    const raw = line.row;
    if (!record(raw) || typeof raw.type !== "string") { this.error = "omp-events-invalid"; return; }
    if (this.ended && raw.type === "tool_execution_start") { this.error = "omp-phase-tool-forbidden"; return; }
    if (this.ended && raw.type !== "turn_end" && raw.type !== "agent_end") { this.error = "omp-phase-continuation"; return; }
    if (raw.type === "extension_ui_request" || raw.type.includes("subagent")) { this.error = "omp-phase-tool-forbidden"; return; }
    if (raw.type === "tool_execution_start") {
      if (this.ended || typeof raw.toolCallId !== "string" || typeof raw.toolName !== "string" || !this.allowed.has(raw.toolName)
        || this.pendingTools.has(raw.toolCallId)) { this.error = "omp-phase-tool-forbidden"; return; }
      this.pendingTools.set(raw.toolCallId, raw.toolName);
    }
    if (raw.type === "tool_execution_end") {
      if (typeof raw.toolCallId !== "string" || typeof raw.toolName !== "string" || this.pendingTools.get(raw.toolCallId) !== raw.toolName) {
        this.error = "omp-phase-tool-forbidden"; return;
      }
      this.pendingTools.delete(raw.toolCallId);
    }
    if (raw.type === "message_end" && record(raw.message) && raw.message.role === "assistant") {
      this.messages += 1;
      this.last = raw.message;
      this.usage.add(raw.message);
      if (`${raw.message.provider}/${raw.message.model}` !== this.expectedSelector) this.wrongModel = true;
      // omp's isEmptyAssistantStop retries an empty stop (measured: thinking-only, unsigned), so it is not this phase's answer.
      if (raw.message.stopReason === "stop" && actionableStop(raw.message)) this.ended = true;
    }
    if (raw.type === "agent_end") {
      this.terminalCount += 1;
      if (raw.isTerminal === false || raw.willContinue === true || this.terminalCount > 1) { this.error = "omp-phase-continuation"; return; }
    }
  }

  value(): PhaseResults[OmpPhase] {
    const { phase, expectedSelector } = this;
    if (this.error !== null) throw new Error(this.error);
    if (this.pendingTools.size !== 0) throw new Error("omp-phase-tool-forbidden");
    if (this.terminalCount !== 1 || this.messages === 0) throw new Error("omp-no-completion");
    const totals = this.usage.checked();
    const usageEvidence: UsageEvidence = {
      usageStatus: "present",
      fields: {
        input_tokens: { status: "absent" }, output_tokens: { status: "absent" },
        inputTokens: { status: "finite", value: totals.input }, outputTokens: { status: "finite", value: totals.output },
      },
      cacheFields: {
        cache_creation_input_tokens: { status: "finite", value: totals.cacheWrite },
        cache_read_input_tokens: { status: "finite", value: totals.cacheRead },
      },
      selectedInputField: "inputTokens", selectedOutputField: "outputTokens", normalizedTotal: totals.total,
    };
    const modelUsage: ModelUsageV1[] = [{ model: expectedSelector, input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite }];
    if (this.wrongModel) throw Object.assign(new Error("omp-model-mismatch"), { observedTokens: totals.total });
    const final = this.last!;
    if (!this.ended || final.stopReason !== "stop" || !Array.isArray(final.content)) throw Object.assign(new Error("omp-no-completion"), { observedTokens: totals.total });
    const text = final.content.filter((item): item is { type: "text"; text: string } => record(item) && item.type === "text" && typeof item.text === "string").map((item) => item.text).join("");
    if (!text.trim()) throw Object.assign(new Error("omp-result-invalid"), { observedTokens: totals.total });
    let result: unknown;
    if (phase === "execute") {
      const normalized = normalizeExecutionFinal(text);
      if (normalized.status !== "available") throw Object.assign(new Error("omp-result-invalid"), { observedTokens: totals.total });
      result = normalized.execution;
    } else {
      const { extraction } = scanFinalMessage(text, phaseFinalAccepts(phase));
      let raw: unknown;
      try { raw = extraction.method === "candidate" ? extraction.value : JSON.parse(text); }
      catch { throw Object.assign(new Error("omp-result-invalid"), { observedTokens: totals.total }); }
      const parsed = (phase === "plan" ? planSchema : verificationSchema).safeParse(raw);
      if (!parsed.success) throw Object.assign(new Error("omp-result-invalid"), { observedTokens: totals.total });
      result = parsed.data;
    }
    return { ...(result as object), tokenUsage: totals.total, usageEvidence, modelUsage } as PhaseResults[OmpPhase];
  }
}
