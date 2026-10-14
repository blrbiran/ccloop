import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ompSingleCallExecution, readOmpCatalog } from "../../agents/ompModels.js";
import type { CatalogRowV1, MaterializedAgentConfigV1 } from "../../agents/types.js";
import type { ModelUsageV1 } from "../../control/usage.js";
import { SingleCallOutputInvalid, type SingleCallRequest, type SingleCallResult, type UsageEvidence } from "../types.js";
import { assistantUsage } from "./ompProtocol.js";
import { singleCallSystemPrompt } from "./phasePrompt.js";
import { runOmpProcess, type OmpPhaseOutcome } from "./runOmpPhase.js";

/**
 * OMP single call (Orca spec 2026-10-14 §3.3.3): switches off session auto-retry, model fallback, the loop guard, the
 * advisor and auto-compaction. Keys confirmed against omp 18.10.1 in plan Task 0 (spec §7), applied on top of the
 * operator's config.yml: omp deep-merges a --config file (YAML; JSON is YAML) after its own configuration.
 */
export const OMP_SINGLE_CALL_OVERLAY = {
  retry: { enabled: false, modelFallback: false },
  model: { loopGuard: { enabled: false } },
  advisor: { enabled: false },
  compaction: { enabled: false },
} as const;

/** §3.3.1: refused before anything was spawned, so nothing was sent; observedTokensOf books 0 for it. */
export class OmpSingleCallRefused extends Error {
  readonly neverStarted = true;
  constructor(readonly code: "omp-single-call-cap-exceeded" | "omp-single-call-unavailable", detail: string) {
    super(`${code}: ${detail}`);
    this.name = "OmpSingleCallRefused";
  }
}

/**
 * §3.3.1-§3.3.4: re-reads the selected catalog row immediately before spawning and runs only when it still answers "v1"
 * and its cap is at most the request's maxOutputTokens; then one `omp -p` with tools, rules and LSP off under the overlay.
 */
export async function runOmpSingleCall(config: MaterializedAgentConfigV1, request: SingleCallRequest): Promise<OmpPhaseOutcome> {
  let rows: CatalogRowV1[];
  try { rows = await readOmpCatalog(config.installation); }
  catch (error) { throw new OmpSingleCallRefused("omp-single-call-unavailable", `catalog ${error instanceof Error ? error.message : String(error)}`); }
  const row = rows.find((candidate) => candidate.selector === config.selection.model);
  if (row === undefined || row.maxTokens === null || ompSingleCallExecution(row) !== "v1") throw new OmpSingleCallRefused("omp-single-call-unavailable", config.selection.model);
  if (row.maxTokens > request.maxOutputTokens) throw new OmpSingleCallRefused("omp-single-call-cap-exceeded", `catalog maxTokens ${row.maxTokens} > maxOutputTokens ${request.maxOutputTokens}`);
  const root = join(request.runDir, "omp", "1", "single-call");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const evidenceDir = await mkdtemp(join(root, "call-"));
  const systemPath = join(evidenceDir, "system-prompt.md");
  const overlayPath = join(evidenceDir, "config-overlay.yml");
  await Promise.all([
    writeFile(systemPath, singleCallSystemPrompt(request.responseSchema), { mode: 0o600 }),
    writeFile(overlayPath, `${JSON.stringify(OMP_SINGLE_CALL_OVERLAY)}\n`, { mode: 0o600 }),
  ]);
  const profile = config.installation.profile as string | null;
  const args = ["--profile", profile ?? "default", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-tools",
    "--no-session", "--no-title", "--no-prewalk", "--model", config.selection.model, "--mode", "json", "-p",
    "--system-prompt", systemPath, "--cwd", request.cwd, "--config", overlayPath];
  return runOmpProcess(config, {
    args, prompt: request.prompt, cwd: request.cwd, evidenceDir, phase: "single-call",
    timeoutMs: Math.min(request.timeoutMs, config.installation.timeoutMs),
    abortSignal: request.signal, onProcessRegistered: request.onProcessRegistered,
  });
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** §3.3.6: the trimmed text, with at most one surrounding fenced block removed, must parse to a plain non-array object. */
export function parseSingleCallObject(text: string): Record<string, unknown> | undefined {
  let body = text.trim();
  const fenced = /^```[A-Za-z0-9_-]*\n([\s\S]*)\n```$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  let value: unknown;
  try { value = JSON.parse(body); } catch { return undefined; }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** §3.3.7: the assistant messages' usage with the per-model breakdown; unreadable usage is "not observed" (null). */
function observedUsage(messages: Record<string, unknown>[], selector: string): { total: number; usageEvidence: UsageEvidence; modelUsage: ModelUsageV1[] } {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const message of messages) {
    const usage = assistantUsage(message);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) totals[key] += usage[key];
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
  return { total: totals.total, usageEvidence, modelUsage: [{ model: selector, input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite }] };
}

/**
 * §3.3.5-§3.3.7, fail closed: exactly one assistant message, no tool event, the selected model, a "stop" with one object.
 * Every refusal after the usage was read books that observed total; "length" is a truncated answer (output-invalid).
 */
export function decodeOmpSingleCall(events: string, expectedSelector: string, evidenceDir: string): SingleCallResult {
  const messages: Record<string, unknown>[] = [];
  let toolEvent = false;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    // Ruling m4: an unparseable line is not a readable usage, so this refusal books null (not observed), never 0.
    try { raw = JSON.parse(line); } catch { throw new Error("omp-events-invalid"); }
    if (!record(raw) || typeof raw.type !== "string") throw new Error("omp-events-invalid");
    if (raw.type.startsWith("tool_execution_") || raw.type === "extension_ui_request" || raw.type.includes("subagent")) toolEvent = true;
    if (raw.type === "message_end" && record(raw.message) && raw.message.role === "assistant") messages.push(raw.message);
  }
  if (messages.length === 0) throw new Error("omp-no-completion");
  const usage = observedUsage(messages, expectedSelector);
  const observed = { observedTokens: usage.total };
  if (messages.length > 1) throw Object.assign(new Error("omp-single-call-multiple-requests"), observed);
  if (toolEvent) throw Object.assign(new Error("omp-phase-tool-forbidden"), observed);
  const message = messages[0]!;
  if (`${message.provider}/${message.model}` !== expectedSelector) throw Object.assign(new Error("omp-model-mismatch"), observed);
  if (message.stopReason === "length") throw new SingleCallOutputInvalid(evidenceDir, usage.total, usage.usageEvidence);
  if (message.stopReason !== "stop") {
    const reason = typeof message.stopReason === "string" && /^[A-Za-z]{1,32}$/.test(message.stopReason) ? message.stopReason : "invalid";
    throw Object.assign(new Error(`omp-single-call-stop:${reason}`), { code: `omp-single-call-stop:${reason}`, ...observed });
  }
  const text = Array.isArray(message.content)
    ? message.content.filter((item): item is { type: "text"; text: string } => record(item) && item.type === "text" && typeof item.text === "string").map((item) => item.text).join("")
    : "";
  const output = parseSingleCallObject(text);
  if (output === undefined) throw new SingleCallOutputInvalid(evidenceDir, usage.total, usage.usageEvidence);
  return { output, tokenUsage: usage.total, usageEvidence: usage.usageEvidence, modelUsage: usage.modelUsage };
}
