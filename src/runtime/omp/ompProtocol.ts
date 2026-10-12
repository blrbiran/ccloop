import { z } from "zod";
import type { ModelUsageV1 } from "../../control/usage.js";
import { normalizeExecutionFinal } from "../executionNormalizer.js";
import type { UsageEvidence } from "../types.js";
import { phaseFinalAccepts, scanFinalMessage, verificationSchema, type PhaseResults } from "../codex/protocol.js";
import type { OmpPhase } from "./phasePrompt.js";

const planSchema = z.object({ summary: z.string(), primaryTargetPaths: z.array(z.string()) }).strict();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function assistantUsage(message: Record<string, unknown>): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } {
  if (!record(message.usage)) throw new Error("omp-usage-invalid");
  const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
  if (!safe(input) || !safe(output) || !safe(cacheRead) || !safe(cacheWrite) || !safe(totalTokens)
    || input + output + cacheRead + cacheWrite !== totalTokens) throw new Error("omp-usage-invalid");
  return { input, output, cacheRead, cacheWrite, total: totalTokens };
}

/** The diagnostic lower bound never becomes a ccloop usage observation. */
export function ompUsageLowerBound(events: string): number | null {
  let total = 0;
  for (const line of events.split("\n")) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!record(row) || row.type !== "message_end" || !record(row.message) || row.message.role !== "assistant") continue;
    try { total += assistantUsage(row.message).total; } catch { /* incomplete row */ }
  }
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

export function decodeOmpPhase<P extends OmpPhase>(phase: P, events: string, expectedSelector: string): PhaseResults[P] {
  const allowed = new Set(phase === "execute" ? ["read", "grep", "glob", "edit", "write", "bash"] : ["read", "grep", "glob"]);
  const messages: Record<string, unknown>[] = [];
  const pendingTools = new Map<string, string>();
  let ended = false;
  let terminalCount = 0;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new Error("omp-events-invalid"); }
    if (!record(raw) || typeof raw.type !== "string") throw new Error("omp-events-invalid");
    if (ended && raw.type === "tool_execution_start") throw new Error("omp-phase-tool-forbidden");
    if (ended && raw.type !== "turn_end" && raw.type !== "agent_end") throw new Error("omp-phase-continuation");
    if (raw.type === "extension_ui_request" || raw.type.includes("subagent")) throw new Error("omp-phase-tool-forbidden");
    if (raw.type === "tool_execution_start") {
      if (ended || typeof raw.toolCallId !== "string" || typeof raw.toolName !== "string" || !allowed.has(raw.toolName)
        || pendingTools.has(raw.toolCallId)) throw new Error("omp-phase-tool-forbidden");
      pendingTools.set(raw.toolCallId, raw.toolName);
    }
    if (raw.type === "tool_execution_end") {
      if (typeof raw.toolCallId !== "string" || typeof raw.toolName !== "string" || pendingTools.get(raw.toolCallId) !== raw.toolName) {
        throw new Error("omp-phase-tool-forbidden");
      }
      pendingTools.delete(raw.toolCallId);
    }
    if (raw.type === "message_end" && record(raw.message) && raw.message.role === "assistant") {
      messages.push(raw.message);
      if (raw.message.stopReason === "stop") ended = true;
    }
    if (raw.type === "agent_end") {
      terminalCount += 1;
      if (raw.isTerminal === false || raw.willContinue === true || terminalCount > 1) throw new Error("omp-phase-continuation");
    }
  }
  if (pendingTools.size !== 0) throw new Error("omp-phase-tool-forbidden");
  if (terminalCount !== 1 || messages.length === 0) throw new Error("omp-no-completion");
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let wrongModel = false;
  for (const message of messages) {
    const usage = assistantUsage(message);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) totals[key] += usage[key];
    if (`${message.provider}/${message.model}` !== expectedSelector) wrongModel = true;
  }
  if (!Object.values(totals).every(Number.isSafeInteger) || totals.total === 0) throw new Error("omp-usage-invalid");
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
  if (wrongModel) throw Object.assign(new Error("omp-model-mismatch"), { observedTokens: totals.total });
  const final = messages.at(-1)!;
  if (!ended || final.stopReason !== "stop" || !Array.isArray(final.content)) throw Object.assign(new Error("omp-no-completion"), { observedTokens: totals.total });
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
  return { ...(result as object), tokenUsage: totals.total, usageEvidence, modelUsage } as PhaseResults[P];
}
