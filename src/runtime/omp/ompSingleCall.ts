import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAgentCatalog } from "../../agents/agentCatalog.js";
import { ompSingleCallExecution } from "../../agents/ompModels.js";
import type { CatalogRowV1, MaterializedAgentConfigV1 } from "../../agents/types.js";
import type { ModelUsageV1 } from "../../control/usage.js";
import { SingleCallOutputInvalid, type SingleCallRequest, type SingleCallResult, type UsageEvidence } from "../types.js";
import { OmpUsageSum } from "./ompProtocol.js";
import { foldText, type JsonLine } from "../streamLines.js";
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
 *
 * *** ERRATUM (Orca spec 2026-10-15 §4.1, R8) -- "re-reads" now reads through the catalog cache (30-minute lifetime,
 * config-stamped key); a cap raised on the provider side without a config change is not seen until the entry expires. ***
 */
export async function runOmpSingleCall(config: MaterializedAgentConfigV1, request: SingleCallRequest): Promise<OmpPhaseOutcome> {
  // Every-agent requirement chain (Orca spec 2026-10-15 §4.1, §4.3, R6, R8): the re-check reads through the same cache key
  // and the call's own deadline and signal; a provider-side cap change without a config change is the accepted risk.
  // The worker's stderr is not the control wire, so it says whether the cache missed or the probe failed (plan issue 3).
  // Spec R6: the re-check lives inside the call's deadline, computed once; the spawn gets only what the re-check left.
  const deadline = Date.now() + Math.min(request.timeoutMs, config.installation.timeoutMs);
  const catalog = await readAgentCatalog(config.installation, {
    deadline, signal: request.signal,
    log: (line) => { process.stderr.write(`${line}\n`); },
  });
  if (catalog.catalogError !== null || catalog.rows === null) throw new OmpSingleCallRefused("omp-single-call-unavailable", `catalog ${catalog.catalogError ?? "absent"}`);
  const rows: CatalogRowV1[] = catalog.rows;
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
    timeoutMs: Math.max(1, deadline - Date.now()),
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
function observedUsage(sum: OmpUsageSum, selector: string): { total: number; usageEvidence: UsageEvidence; modelUsage: ModelUsageV1[] } {
  const totals = sum.checked();
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
  return foldText(events, new OmpSingleCallFold(expectedSelector)).value(evidenceDir);
}

/**
 * Live transcript (Orca spec 2026-10-23 §10.2.3): decodeOmpSingleCall as a fold. It keeps the first assistant message (the
 * answer, when it is the only one), how many there were, and their summed usage. A line too large to keep is
 * `omp-events-line-too-large`.
 */
export class OmpSingleCallFold {
  private error: string | null = null;
  private toolEvent = false;
  private messages = 0;
  private first: Record<string, unknown> | undefined;
  private readonly usage = new OmpUsageSum();
  constructor(private readonly expectedSelector: string) {}
  push(line: JsonLine): void {
    if (this.error !== null || line.kind === "blank") return;
    if (line.kind === "too-large") { this.error = "omp-events-line-too-large"; return; }
    // Ruling m4: an unparseable line is not a readable usage, so this refusal books null (not observed), never 0.
    if (line.kind === "unparsed") { this.error = "omp-events-invalid"; return; }
    const raw = line.row;
    if (!record(raw) || typeof raw.type !== "string") { this.error = "omp-events-invalid"; return; }
    if (raw.type.startsWith("tool_execution_") || raw.type === "extension_ui_request" || raw.type.includes("subagent")) this.toolEvent = true;
    if (raw.type === "message_end" && record(raw.message) && raw.message.role === "assistant") {
      this.messages += 1;
      if (this.first === undefined) this.first = raw.message;
      this.usage.add(raw.message);
    }
  }
  value(evidenceDir: string): SingleCallResult {
    const expectedSelector = this.expectedSelector;
    if (this.error !== null) throw new Error(this.error);
    if (this.messages === 0) throw new Error("omp-no-completion");
    const usage = observedUsage(this.usage, expectedSelector);
    const observed = { observedTokens: usage.total };
    if (this.messages > 1) throw Object.assign(new Error("omp-single-call-multiple-requests"), observed);
    if (this.toolEvent) throw Object.assign(new Error("omp-phase-tool-forbidden"), observed);
    const message = this.first!;
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
}
