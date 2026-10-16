import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { canonicalHash } from "../control/protocol.js";
import type { CatalogRowV1, InstallationV1 } from "./types.js";

/**
 * Every-agent requirement chain (Orca spec 2026-10-15 §4.1-§4.2, ruling R4): the agent catalog and `--version` answer,
 * cached in one file per key. Out-of-repo write registered in that spec §4.2: path below, writer = any ccloop process
 * that probes, residue on failure = at most one temp file (removed when possible); a corrupt entry is a miss.
 */
export const CATALOG_LIFETIME_MS = 1_800_000;
export interface CatalogStampV1 { path: string; mtimeMs: number | null; size: number | null }
export interface CatalogKeyV1 {
  schema: "ccloop-agent-catalog-key-v1"; kind: string; command: string[]; files: CatalogStampV1[];
  profile: string | null; configDir: string | null; inheritedConfigDir: string | null; configFiles: CatalogStampV1[];
}
export interface CatalogEntryV1 {
  schema: "ccloop-agent-catalog-v1"; key: CatalogKeyV1; observedAt: string; version: string;
  rows: CatalogRowV1[] | null; codexFeatures: string[] | null;
  /** Task 8 fix round 2: codex's configured MCP server names; an entry without them is a miss for codex (agentCatalog.ts). */
  codexMcpServers?: string[] | null;
}

export function catalogCacheDir(env: NodeJS.ProcessEnv): string | null {
  if (env.CCLOOP_CACHE_DIR !== undefined && env.CCLOOP_CACHE_DIR !== "") return isAbsolute(env.CCLOOP_CACHE_DIR) ? env.CCLOOP_CACHE_DIR : null;
  if (env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME)) return join(env.XDG_CACHE_HOME, "ccloop", "agent-catalog");
  if (env.HOME && isAbsolute(env.HOME)) return join(env.HOME, ".cache", "ccloop", "agent-catalog");
  return null;
}

async function stamp(path: string): Promise<CatalogStampV1> {
  try {
    const real = await realpath(path);
    const info = await stat(real);
    return { path: real, mtimeMs: info.mtimeMs, size: info.size };
  } catch { return { path, mtimeMs: null, size: null }; }
}

const ENV_OF_KIND: Record<string, string> = { omp: "PI_CODING_AGENT_DIR", codex: "CODEX_HOME" };

/**
 * Spec issue 7(d). omp 18.10.1 `pi-utils/src/dirs.ts`: `normalizeProfileName` maps a trimmed ""/"default" to the default
 * profile; a NAMED profile always uses `<HOME>/.omp/profiles/<name>/agent` (the `DirResolver` constructor drops
 * `agentDirOverride` and `resolveActiveAgentDirOverride` returns undefined when a profile is active); only the default
 * profile honours `PI_CODING_AGENT_DIR` (ccloop's configDir, else the inherited one). codex: `$CODEX_HOME/config.toml`
 * (default `~/.codex`). An inherited dir that is empty or relative is treated as unset, never joined cwd-relative.
 */
function configFilesOf(installation: InstallationV1, env: NodeJS.ProcessEnv): string[] {
  const raw = ENV_OF_KIND[installation.kind] === undefined ? undefined : env[ENV_OF_KIND[installation.kind]!];
  const inherited = raw && isAbsolute(raw) ? raw : null;
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : null;
  if (installation.kind === "omp") {
    const profile = (installation.profile as string | null | undefined)?.trim();
    const named = profile && profile !== "default" ? profile : null;
    const agentDir = named !== null
      ? (home === null ? null : join(home, ".omp", "profiles", named, "agent"))
      : installation.configDir ?? inherited ?? (home === null ? null : join(home, ".omp", "agent"));
    return agentDir === null ? [] : [join(agentDir, "config.yml"), join(agentDir, "models.yaml")];
  }
  if (installation.kind === "codex") {
    const codexHome = installation.configDir ?? inherited ?? (home === null ? null : join(home, ".codex"));
    return codexHome === null ? [] : [join(codexHome, "config.toml")];
  }
  return [];
}

export async function catalogKey(installation: InstallationV1, env: NodeJS.ProcessEnv): Promise<CatalogKeyV1> {
  const argvFiles: CatalogStampV1[] = [];
  for (const part of installation.command) {
    const s = await stamp(part);
    if (s.mtimeMs !== null) argvFiles.push(s);
  }
  const variable = ENV_OF_KIND[installation.kind];
  return {
    schema: "ccloop-agent-catalog-key-v1", kind: installation.kind, command: [...installation.command], files: argvFiles,
    profile: (installation.profile as string | null | undefined) ?? null, configDir: installation.configDir,
    inheritedConfigDir: installation.configDir === null && variable !== undefined ? env[variable] ?? null : null,
    configFiles: await Promise.all(configFilesOf(installation, env).map(stamp)),
  };
}

export const entryFileName = (key: CatalogKeyV1): string => `${canonicalHash(key)}.json`;

export async function readCatalogEntry(dir: string, key: CatalogKeyV1, now: number): Promise<CatalogEntryV1 | null> {
  try {
    const value = JSON.parse(await readFile(join(dir, entryFileName(key)), "utf8")) as CatalogEntryV1;
    if (value === null || typeof value !== "object" || value.schema !== "ccloop-agent-catalog-v1" || typeof value.version !== "string"
      || canonicalHash(value.key) !== canonicalHash(key) || !(value.rows === null || Array.isArray(value.rows))
      || !(value.codexFeatures === null || Array.isArray(value.codexFeatures))) return null;
    const age = now - Date.parse(value.observedAt);
    return Number.isFinite(age) && age >= 0 && age < CATALOG_LIFETIME_MS ? value : null;
  } catch { return null; }
}

/** Creates each missing directory with 0700 set explicitly (not from umask); an existing one is left alone. */
async function ensureDir(dir: string): Promise<void> {
  const missing: string[] = [];
  for (let at = dir; ; at = dirname(at)) {
    try { if ((await stat(at)).isDirectory()) break; throw new Error("not a directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing.unshift(at); if (dirname(at) === at) break; }
  }
  for (const path of missing) { await mkdir(path, { mode: 0o700 }); await chmod(path, 0o700); }
}

export async function writeCatalogEntry(dir: string, entry: CatalogEntryV1): Promise<void> {
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  try {
    await ensureDir(dir);
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, join(dir, entryFileName(entry.key)));
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
