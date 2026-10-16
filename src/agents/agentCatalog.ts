import { catalogCacheDir, catalogKey, entryFileName, readCatalogEntry, writeCatalogEntry, type CatalogEntryV1 } from "./catalogCache.js";
import { PROBE_CAP_MS, probeTimeoutMs } from "./catalogProbe.js";
import { readCodexCatalog } from "./codexCatalog.js";
import { readOmpCatalog } from "./ompModels.js";
import type { CatalogRowV1, InstallationV1 } from "./types.js";
import { probeVersion } from "./versionProbe.js";

/**
 * Every-agent requirement chain (Orca spec 2026-10-15 §4.1, R4/R6/R8): every catalog and version read goes through here.
 * A hit within 30 minutes answers without spawning; a miss probes `--version` and, for omp and codex, the catalog, under
 * one deadline (the caller's, else 30 s from now; plan issue 4), and writes an entry only when every probe answered.
 * `log` gets the `ccloop-agent-catalog: miss|probe-failed ...` lines; `control` passes none (plan issue 3).
 */
export interface AgentCatalogV1 {
  source: "cache" | "probe"; observedAt: string; version: string | null;
  rows: CatalogRowV1[] | null; codexFeatures: string[] | null; catalogError: string | null;
}
export interface ReadAgentCatalogOptions {
  deadline?: number; signal?: AbortSignal; refresh?: boolean; env?: NodeJS.ProcessEnv; log?: (line: string) => void; now?: () => number;
}

const numberOrNull = (value: unknown): boolean => value === null || typeof value === "number";
/** Task 2 deferred item: readCatalogEntry checks only that the lists are arrays; an element of the wrong shape is a miss. */
function wellFormed(entry: CatalogEntryV1): boolean {
  const rows = entry.rows === null || entry.rows.every((row: unknown) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
    const value = row as Record<string, unknown>;
    return typeof value.selector === "string" && typeof value.provider === "string" && numberOrNull(value.contextWindow)
      && numberOrNull(value.maxTokens) && (value.listed === undefined || typeof value.listed === "boolean");
  });
  return rows && (entry.codexFeatures === null || entry.codexFeatures.every((name: unknown) => typeof name === "string"));
}

export async function readAgentCatalog(installation: InstallationV1, options: ReadAgentCatalogOptions = {}): Promise<AgentCatalogV1> {
  const env = options.env ?? process.env, now = options.now ?? Date.now, log = options.log ?? (() => undefined);
  const deadline = options.deadline ?? now() + PROBE_CAP_MS;
  const dir = catalogCacheDir(env);
  const key = await catalogKey(installation, env);
  if (dir !== null && options.refresh !== true) {
    const hit = await readCatalogEntry(dir, key, now());
    if (hit !== null && wellFormed(hit)) return { source: "cache", observedAt: hit.observedAt, version: hit.version, rows: hit.rows, codexFeatures: hit.codexFeatures, catalogError: null };
    log(`ccloop-agent-catalog: miss ${installation.kind} ${entryFileName(key).slice(0, 12)}`);
  }
  // The probes measure the deadline on the real clock, as runProbe does; `now` only dates the entry and its age.
  const version = await probeVersion(installation.command, { timeoutMs: Math.min(10_000, probeTimeoutMs(deadline)), signal: options.signal });
  let rows: CatalogRowV1[] | null = null, codexFeatures: string[] | null = null, catalogError: string | null = null;
  try {
    if (installation.kind === "omp") rows = await readOmpCatalog(installation, { deadline, signal: options.signal });
    else if (installation.kind === "codex") ({ rows, features: codexFeatures } = await readCodexCatalog(installation, { deadline, signal: options.signal }));
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error);
    log(`ccloop-agent-catalog: probe-failed ${installation.kind} ${catalogError}`);
  }
  const observedAt = new Date(now()).toISOString();
  if (dir !== null && version !== null && catalogError === null) {
    await writeCatalogEntry(dir, { schema: "ccloop-agent-catalog-v1", key, observedAt, version, rows, codexFeatures });
  }
  return { source: "probe", observedAt, version, rows, codexFeatures, catalogError };
}
