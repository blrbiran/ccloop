import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ompSingleCallExecution, readOmpCatalog } from "../../agents/ompModels.js";
import type { CatalogRowV1, MaterializedAgentConfigV1 } from "../../agents/types.js";
import type { SingleCallRequest } from "../types.js";
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
