import { readAgentCatalog } from "./agentCatalog.js";
import { ompSingleCallExecution } from "./ompModels.js";
import { readAgentsTable } from "./table.js";
import { AgentError } from "./types.js";

/** Every-agent requirement chain (Orca spec 2026-10-15 §3, part A): one installation's models, for Orca's drop-down. */
export interface AgentModelV1 { model: string; contextWindowTokens: number | null; maxOutputTokens: number | null; singleCallExecution: "v1" | "v1-soft" | null }
export interface AgentModelsV1 { schema: "ccloop-models-v1"; installation: string; kind: string; source: "cache" | "probe" | "none"; observedAt: string | null; models: AgentModelV1[] }

/**
 * Sorted by model in code-unit order; codex lists only its `visibility: "list"` rows; a kind with no catalog command
 * (claude) answers no models and spawns nothing. A catalog failure throws the kind's own message (omp-model-catalog-*,
 * agent-catalog-unavailable), which names the stage and the elapsed time.
 */
export async function listAgentModels(tablePath: string, id: string, options: { refresh?: boolean; log?: (line: string) => void } = {}): Promise<AgentModelsV1> {
  const table = await readAgentsTable(tablePath);
  const installation = Object.hasOwn(table.installations, id) ? table.installations[id] : undefined;
  if (installation === undefined) throw new AgentError("agent-installation-missing", id);
  const empty: AgentModelsV1 = { schema: "ccloop-models-v1", installation: id, kind: installation.kind, source: "none", observedAt: null, models: [] };
  if (installation.kind !== "omp" && installation.kind !== "codex") return empty;
  const catalog = await readAgentCatalog(installation, { refresh: options.refresh, log: options.log });
  if (catalog.catalogError !== null || catalog.rows === null) throw new Error(catalog.catalogError ?? "agent-catalog-unavailable: no rows");
  const codex = installation.kind === "codex";
  const models = catalog.rows.filter((row) => !codex || row.listed === true).map((row): AgentModelV1 => ({
    model: row.selector, contextWindowTokens: row.contextWindow, maxOutputTokens: codex ? null : row.maxTokens,
    singleCallExecution: codex ? "v1-soft" : ompSingleCallExecution(row),
  })).sort((left, right) => (left.model < right.model ? -1 : left.model > right.model ? 1 : 0));
  return { ...empty, source: catalog.source, observedAt: catalog.observedAt, models };
}
