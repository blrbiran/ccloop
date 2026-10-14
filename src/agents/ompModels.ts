import { spawn } from "node:child_process";
import type { CatalogRowV1, InstallationV1 } from "./types.js";

const OUTPUT_LIMIT = 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const STDERR_KEEP = 4096;
const STDERR_TAIL_BYTES = 400;

/**
 * Feedback #58: the last <= 400 bytes of a probe's stderr for its error message -- decoded as UTF-8 from a character
 * boundary, control characters as spaces, whitespace collapsed, cut on whole characters. Empty when nothing is left.
 */
function stderrTail(kept: Buffer): string {
  let start = 0;
  while (start < kept.length && (kept[start]! & 0xc0) === 0x80) start += 1;
  const text = kept.subarray(start).toString("utf8").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = Array.from(text);
  let bytes = 0;
  let from = chars.length;
  while (from > 0 && bytes + Buffer.byteLength(chars[from - 1]!) <= STDERR_TAIL_BYTES) { from -= 1; bytes += Buffer.byteLength(chars[from]!); }
  return chars.slice(from).join("").trim();
}

export function canonicalOmpSelector(input: string, selectors: readonly string[]): string | null {
  if (selectors.includes(input)) return input;
  const matches = selectors.filter((selector) => selector.slice(selector.indexOf("/") + 1) === input);
  return matches.length === 1 ? matches[0]! : null;
}

async function runOmpJson(installation: InstallationV1, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<unknown> {
  const profile = installation.profile as string | null;
  const env: NodeJS.ProcessEnv = { ...process.env, OMP_PROFILE: profile ?? "default" };
  if (installation.configDir !== null) env.PI_CODING_AGENT_DIR = installation.configDir;
  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(installation.command[0], ["--no-extensions", "--profile", profile ?? "default", ...args], {
      detached: true, env, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let bytes = 0;
    let aborted: string | null = null;
    let spawnError: NodeJS.ErrnoException | null = null;
    let stderr: Buffer = Buffer.alloc(0);
    const kill = (reason: string): void => {
      if (aborted !== null) return;
      aborted = reason;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => kill(`timeout ${timeoutMs}ms`), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { kill("output-limit"); return; }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length > OUTPUT_LIMIT) kill("output-limit");
      stderr = Buffer.concat([stderr, chunk.subarray(Math.max(0, chunk.length - STDERR_KEEP))]);
      if (stderr.length > STDERR_KEEP) stderr = stderr.subarray(stderr.length - STDERR_KEEP);
    });
    child.on("error", (error: NodeJS.ErrnoException) => { spawnError = error; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Feedback #58: the code stays the message's prefix (callers match it); the detail names why, never stdout or env.
      const reason = aborted ?? (spawnError !== null ? `spawn ${spawnError.code ?? spawnError.message}`
        : code === null ? `signal ${signal ?? "unknown"}` : code !== 0 ? `exit ${code}` : null);
      if (reason !== null) {
        const tail = stderrTail(stderr);
        reject(new Error(`omp-model-catalog-unavailable: ${reason}${tail === "" ? "" : ` · stderr: ${tail}`}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as unknown);
      } catch { reject(new Error("omp-model-catalog-invalid")); }
    });
  });
}

const catalogMemo = new Map<string, CatalogRowV1[]>();

const positiveSafe = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

/**
 * OMP single call (Orca spec 2026-10-14 §3.1): the catalog's rows from its one spawn, read under the same structured
 * profile/configuration as a phase. A number is kept only when it is a positive safe integer. This never sends a model prompt.
 */
export async function readOmpCatalog(installation: InstallationV1, options: { fresh?: boolean; timeoutMs?: number } = {}): Promise<CatalogRowV1[]> {
  // Feedback #58: one ccloop process (a control call, a run, a worker) reads each installation's catalog once; only a
  // successful read is kept. `fresh` (the single call's spawn-time re-read, §3.3.1) always spawns.
  const key = JSON.stringify([installation.command, installation.profile ?? null, installation.configDir]);
  const memoised = options.fresh === true ? undefined : catalogMemo.get(key);
  if (memoised !== undefined) return memoised;
  const parsed = await runOmpJson(installation, ["models", "--json"], options.timeoutMs);
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) throw new Error("omp-model-catalog-invalid");
  const rows = (parsed as { models: unknown[] }).models.map((row): CatalogRowV1 => {
    if (row === null || typeof row !== "object") throw new Error("omp-model-catalog-invalid");
    const value = row as Record<string, unknown>;
    if (typeof value.provider !== "string" || typeof value.id !== "string" || typeof value.selector !== "string"
      || value.selector !== `${value.provider}/${value.id}` || value.selector.length > 200) throw new Error("omp-model-catalog-invalid");
    return { selector: value.selector, provider: value.provider, contextWindow: positiveSafe(value.contextWindow), maxTokens: positiveSafe(value.maxTokens) };
  });
  if (new Set(rows.map((row) => row.selector)).size !== rows.length) throw new Error("omp-model-catalog-invalid");
  catalogMemo.set(key, rows);
  return rows;
}

/** Read the catalog under the same structured profile/configuration as a phase. This never sends a model prompt. */
export async function readOmpModels(installation: InstallationV1, options: { fresh?: boolean } = {}): Promise<string[]> {
  return (await readOmpCatalog(installation, options)).map((row) => row.selector);
}

/**
 * OMP single call (Orca spec 2026-10-14 §2, §3.2): "v1" only when the row declares the cap pi-ai sends (maxTokens) and its
 * provider is not openrouter, for which pi-ai sends no cap unless one is given explicitly.
 */
export function ompSingleCallExecution(row: CatalogRowV1 | undefined): "v1" | null {
  return row !== undefined && row.maxTokens !== null && row.provider !== "openrouter" ? "v1" : null;
}

export async function readOmpConfiguredDefault(installation: InstallationV1): Promise<string | null> {
  const parsed = await runOmpJson(installation, ["config", "get", "modelRoles", "--json"]);
  if (parsed === null || typeof parsed !== "object") return null;
  const value = (parsed as { value?: unknown }).value;
  if (value === null || typeof value !== "object") return null;
  const model = (value as { default?: unknown }).default;
  return typeof model === "string" && model.length > 0 ? model : null;
}
