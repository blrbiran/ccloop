import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { probeFailure, probeTimeoutMs, runProbe } from "./catalogProbe.js";
import type { CatalogRowV1, InstallationV1 } from "./types.js";

/** Spec 2026-10-15 §2.4/§6.1: the tool flags a codex single call turns off, plus skip_host_skill_discovery (turned on). */
export const CODEX_SINGLE_CALL_FEATURES = ["apps", "image_generation", "multi_agent", "plugins", "shell_tool", "skip_host_skill_discovery", "unified_exec", "view_image"] as const;
const CODE = "agent-catalog-unavailable";
const positiveSafe = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

/** §6.1 "Window": a top-level `model_context_window = <n>` before the first `[table]` wins over the catalog. */
function configuredWindow(toml: string): number | null {
  const head = toml.split(/^\s*\[/m, 1)[0]!;
  const match = /^\s*model_context_window\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(head);
  return match === null ? null : positiveSafe(Number(match[1]));
}

/**
 * The flag names `codex features list` prints. codex-cli 0.160.0 prints `name<pad>stage<pad>enabled` and a stage can be
 * two words ("under development"), so the name is the first word and the line must end in true/false -- never a fixed
 * column count.
 */
export function codexFeatureNames(listed: string): Set<string> {
  const names = new Set<string>();
  for (const line of listed.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words.length >= 3 && (words.at(-1) === "true" || words.at(-1) === "false")) names.add(words[0]!);
  }
  return names;
}

/**
 * Task 8 fix round 2 (P1, codex-cli 0.160.0): the MCP server names `codex mcp list --json` prints (a JSON array of
 * `{name, enabled, ...}`), so a single call can turn each one off by name -- a whole-table `-c mcp_servers={}` is merged,
 * not replaced, and a name codex does not know breaks its config ("invalid transport"). Anything else is stage decode.
 */
export function codexMcpServerNames(listed: string): string[] {
  const parsed = JSON.parse(listed) as unknown;
  if (!Array.isArray(parsed)) throw new Error("not a list");
  const names = parsed.map((server) => {
    const name = server !== null && typeof server === "object" ? (server as { name?: unknown }).name : undefined;
    if (typeof name !== "string" || name.length === 0 || name.length > 200) throw new Error("bad name");
    return name;
  });
  if (new Set(names).size !== names.length) throw new Error("duplicate name");
  return names;
}

/**
 * The codex catalog (`codex debug models`), its installed feature flags (`codex features list`) and its configured MCP
 * servers (`codex mcp list --json`, Task 8 fix round 2), under one deadline.
 */
export async function readCodexCatalog(installation: InstallationV1, options: { deadline?: number; signal?: AbortSignal }): Promise<{ rows: CatalogRowV1[]; features: string[]; mcpServers: string[] }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(installation.configDir === null ? {} : { CODEX_HOME: installation.configDir }) };
  const deadline = options.deadline ?? Date.now() + 30_000;
  const startedAt = Date.now();
  const models = await runProbe(CODE, installation.command[0], [...installation.command.slice(1), "debug", "models"], env, { timeoutMs: probeTimeoutMs(deadline), signal: options.signal });
  let rows: CatalogRowV1[];
  try {
    const parsed = JSON.parse(models) as { models?: unknown };
    if (!Array.isArray(parsed.models)) throw new Error();
    rows = parsed.models.map((row) => {
      const value = row as Record<string, unknown>;
      if (typeof value.slug !== "string" || value.slug.length === 0 || value.slug.length > 200 || (value.visibility !== "list" && value.visibility !== "hide")) throw new Error();
      return { selector: value.slug, provider: "codex", contextWindow: positiveSafe(value.context_window), maxTokens: null, listed: value.visibility === "list" };
    });
    if (new Set(rows.map((row) => row.selector)).size !== rows.length) throw new Error();
  } catch { throw probeFailure(CODE, "decode", "decode", startedAt); }
  // An empty CODEX_HOME/HOME is treated as unset: joining "" would read a config.toml from the working directory.
  const codexHome = installation.configDir ?? (env.CODEX_HOME || (env.HOME ? join(env.HOME, ".codex") : null));
  const window = codexHome === null ? null : await readFile(join(codexHome, "config.toml"), "utf8").then(configuredWindow, () => null);
  if (window !== null) rows = rows.map((row) => ({ ...row, contextWindow: window }));
  const listed = await runProbe(CODE, installation.command[0], [...installation.command.slice(1), "features", "list"], env, { timeoutMs: probeTimeoutMs(deadline), signal: options.signal });
  const names = codexFeatureNames(listed);
  const mcpStartedAt = Date.now();
  const mcp = await runProbe(CODE, installation.command[0], [...installation.command.slice(1), "mcp", "list", "--json"], env, { timeoutMs: probeTimeoutMs(deadline), signal: options.signal });
  let mcpServers: string[];
  try { mcpServers = codexMcpServerNames(mcp); } catch { throw probeFailure(CODE, "decode", "decode", mcpStartedAt); }
  return { rows, features: CODEX_SINGLE_CALL_FEATURES.filter((name) => names.has(name)), mcpServers };
}
