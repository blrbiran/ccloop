import { PROBE_CAP_MS, probeTimeoutMs, runProbe } from "./catalogProbe.js";
import type { CatalogRowV1, InstallationV1 } from "./types.js";

export function canonicalOmpSelector(input: string, selectors: readonly string[]): string | null {
  if (selectors.includes(input)) return input;
  const matches = selectors.filter((selector) => selector.slice(selector.indexOf("/") + 1) === input);
  return matches.length === 1 ? matches[0]! : null;
}

async function runOmpJson(installation: InstallationV1, args: string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
  const profile = installation.profile as string | null;
  const env: NodeJS.ProcessEnv = { ...process.env, OMP_PROFILE: profile ?? "default" };
  if (installation.configDir !== null) env.PI_CODING_AGENT_DIR = installation.configDir;
  const stdout = await runProbe("omp-model-catalog-unavailable", installation.command[0], ["--no-extensions", "--profile", profile ?? "default", ...args], env, options);
  try { return JSON.parse(stdout) as unknown; } catch { throw new Error("omp-model-catalog-invalid"); }
}

const positiveSafe = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

/**
 * OMP single call (Orca spec 2026-10-14 §3.1): the catalog's rows from its one spawn, read under the same structured
 * profile/configuration as a phase. A number is kept only when it is a positive safe integer. This never sends a model prompt.
 */
export async function readOmpCatalog(installation: InstallationV1, options: { timeoutMs?: number; deadline?: number; signal?: AbortSignal } = {}): Promise<CatalogRowV1[]> {
  const parsed = await runOmpJson(installation, ["models", "--json"], { timeoutMs: options.timeoutMs ?? probeTimeoutMs(options.deadline), signal: options.signal });
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) throw new Error("omp-model-catalog-invalid");
  const rows = (parsed as { models: unknown[] }).models.map((row): CatalogRowV1 => {
    if (row === null || typeof row !== "object") throw new Error("omp-model-catalog-invalid");
    const value = row as Record<string, unknown>;
    if (typeof value.provider !== "string" || typeof value.id !== "string" || typeof value.selector !== "string"
      || value.selector !== `${value.provider}/${value.id}` || value.selector.length > 200) throw new Error("omp-model-catalog-invalid");
    return { selector: value.selector, provider: value.provider, contextWindow: positiveSafe(value.contextWindow), maxTokens: positiveSafe(value.maxTokens) };
  });
  if (new Set(rows.map((row) => row.selector)).size !== rows.length) throw new Error("omp-model-catalog-invalid");
  return rows;
}

/** Read the catalog under the same structured profile/configuration as a phase. This never sends a model prompt. */
export async function readOmpModels(installation: InstallationV1): Promise<string[]> {
  return (await readOmpCatalog(installation)).map((row) => row.selector);
}

/**
 * OMP single call (Orca spec 2026-10-14 §2, §3.2): "v1" only when the row declares the cap pi-ai sends (maxTokens) and its
 * provider is not openrouter, for which pi-ai sends no cap unless one is given explicitly.
 */
export function ompSingleCallExecution(row: CatalogRowV1 | undefined): "v1" | null {
  return row !== undefined && row.maxTokens !== null && row.provider !== "openrouter" ? "v1" : null;
}

export async function readOmpConfiguredDefault(installation: InstallationV1): Promise<string | null> {
  const parsed = await runOmpJson(installation, ["config", "get", "modelRoles", "--json"], { timeoutMs: PROBE_CAP_MS });
  if (parsed === null || typeof parsed !== "object") return null;
  const value = (parsed as { value?: unknown }).value;
  if (value === null || typeof value !== "object") return null;
  const model = (value as { default?: unknown }).default;
  return typeof model === "string" && model.length > 0 ? model : null;
}
