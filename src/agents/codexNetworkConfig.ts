import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { effectiveCodexHome } from "./codexIsolation.js";
import type { InstallationV1 } from "./types.js";

/**
 * Per-contract tool rules (ccloop spec 2026-10-22 §3.2.2(b); plan Task 3 "Controller calls"; codex 0.163.0 measurements
 * Orca session b37f7ce9, measure-codex.md Q3): what the person's own config.toml -- the file the private CODEX_HOME links --
 * says about `sandbox_workspace_write.network_access`. ccloop has no TOML parser (dependencies: zod only), so this is a
 * narrow reader of the three spellings codex was measured to honour; any other non-comment line that names the key or the
 * table is `unparseable`, which refuses `network:true` (fail closed: a misread "absent" would become a widening).
 */
export type CodexNetworkSetting = { kind: "absent" } | { kind: "value"; value: boolean } | { kind: "unparseable"; reason: string };

const TABLE = "sandbox_workspace_write", KEY = "network_access";
const bare = (name: string) => name.trim().replace(/^"(.*)"$/, "$1");
const BOOL = String.raw`(true|false)\s*(#.*)?$`;
const IN_TABLE = new RegExp(String.raw`^\s*"?${KEY}"?\s*=\s*${BOOL}`);
const DOTTED = new RegExp(String.raw`^\s*"?${TABLE}"?\s*\.\s*"?${KEY}"?\s*=\s*${BOOL}`);
const QUOTED_KEY = new RegExp(String.raw`["']${KEY}["']`);
const ESCAPED_KEY = /"(?:[^"\\]|\\.)*\\(?:[^"\\]|\\.)*"\s*[=.\]]/;
const INLINE = new RegExp(String.raw`^\s*"?${TABLE}"?\s*=\s*\{(.*)\}\s*(#.*)?$`);

export async function readCodexNetworkAccess(configTomlPath: string): Promise<CodexNetworkSetting> {
  let text: string;
  try { text = await readFile(configTomlPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unparseable", reason: `config.toml could not be read: ${(error as NodeJS.ErrnoException).code ?? String(error)}` };
  }
  let table: string | null = null;
  const values: boolean[] = [];
  const refuse = (line: number): CodexNetworkSetting => ({ kind: "unparseable", reason: `config.toml line ${line} names ${TABLE}/${KEY} in a form ccloop does not read` });
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().startsWith("#")) continue;
    // Review round 1 (Orca session b37f7ce9, M4): a quoted spelling of the key, or a quoted key with an escape (which can
    // spell it, e.g. "network\u005Faccess"), is not read: refused wherever it stands.
    if (QUOTED_KEY.test(line) || ESCAPED_KEY.test(line)) return refuse(index + 1);
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (header !== null) {
      table = header[1]!.split(".").map(bare).join(".");
      if (line.includes(TABLE) && table !== TABLE) return refuse(index + 1);
      continue;
    }
    if (!line.includes(KEY) && !line.includes(TABLE)) continue;
    let match: RegExpExecArray | null;
    if (table === TABLE && (match = IN_TABLE.exec(line)) !== null) values.push(match[1] === "true");
    else if (table === null && (match = DOTTED.exec(line)) !== null) values.push(match[1] === "true");
    else if (table === null && (match = INLINE.exec(line)) !== null) {
      const inner = [...match[1]!.matchAll(new RegExp(String.raw`(^|,)\s*"?${KEY}"?\s*=\s*([^,]*)`, "g"))];
      if (inner.length !== 1 || !/^(true|false)\s*$/.test(inner[0]![2]!)) return refuse(index + 1);
      values.push(inner[0]![2]!.trim() === "true");
    } else return refuse(index + 1);
  }
  if (values.length > 1) return { kind: "unparseable", reason: `config.toml sets ${TABLE}.${KEY} more than once` };
  return values.length === 0 ? { kind: "absent" } : { kind: "value", value: values[0]! };
}

/**
 * The config.toml a codex phase reads: the installation's effective CODEX_HOME (codexIsolation.ts), or on the legacy path
 * (no installation) the CODEX_HOME the adapter's extraEnv carries, else the inherited one / <HOME>/.codex. Null: none.
 */
export function codexConfigTomlPath(installation: InstallationV1 | undefined, extraEnv: Record<string, string> | undefined, env: NodeJS.ProcessEnv): string | null {
  const home = installation !== undefined ? effectiveCodexHome(installation, env)
    : effectiveCodexHome({ configDir: extraEnv?.CODEX_HOME ?? null } as InstallationV1, env);
  return home === null ? null : join(home, "config.toml");
}

/**
 * What a codex phase's tool rules read from config.toml (spec 2026-10-22 §4 codex): only network:true on a workspace-write
 * execute decides anything; otherwise `absent`. Shared by runCodexPhase (the -c pairs) and the executor prompt (review
 * round 1, Orca session b37f7ce9, M6), so both state the same network status.
 */
export async function codexToolRuleNetworkSetting(network: boolean, phase: string, sandbox: "read-only" | "workspace-write", installation: InstallationV1 | undefined, extraEnv: Record<string, string> | undefined): Promise<CodexNetworkSetting> {
  if (!(network && phase === "execute" && sandbox === "workspace-write")) return { kind: "absent" };
  const path = codexConfigTomlPath(installation, extraEnv, process.env);
  return path === null ? { kind: "absent" } : readCodexNetworkAccess(path);
}
