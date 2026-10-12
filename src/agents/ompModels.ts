import { spawn } from "node:child_process";
import type { InstallationV1 } from "./types.js";

const OUTPUT_LIMIT = 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

export function canonicalOmpSelector(input: string, selectors: readonly string[]): string | null {
  if (selectors.includes(input)) return input;
  const matches = selectors.filter((selector) => selector.slice(selector.indexOf("/") + 1) === input);
  return matches.length === 1 ? matches[0]! : null;
}

/** Read the catalog under the same structured profile/configuration as a phase. This never sends a model prompt. */
export async function readOmpModels(installation: InstallationV1): Promise<string[]> {
  const profile = installation.profile as string | null;
  const env: NodeJS.ProcessEnv = { ...process.env, OMP_PROFILE: profile ?? "default" };
  if (installation.configDir !== null) env.PI_CODING_AGENT_DIR = installation.configDir;
  return await new Promise<string[]>((resolve, reject) => {
    const child = spawn(installation.command[0], ["--profile", profile ?? "default", "models", "--json", "--no-extensions"], {
      detached: true, env, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    let spawnError: Error | null = null;
    const kill = (): void => {
      if (aborted) return;
      aborted = true;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(kill, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { kill(); return; }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (chunk.length > OUTPUT_LIMIT) kill(); });
    child.on("error", (error: Error) => { spawnError = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (aborted || spawnError !== null || code !== 0) { reject(new Error("omp-model-catalog-unavailable")); return; }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) throw new Error("invalid catalog");
        const rows = (parsed as { models: unknown[] }).models;
        const selectors = rows.map((row) => {
          if (row === null || typeof row !== "object") throw new Error("invalid model row");
          const value = row as Record<string, unknown>;
          if (typeof value.provider !== "string" || typeof value.id !== "string" || typeof value.selector !== "string"
            || value.selector !== `${value.provider}/${value.id}` || value.selector.length > 200) throw new Error("invalid model selector");
          return value.selector;
        });
        if (new Set(selectors).size !== selectors.length) throw new Error("duplicate model selector");
        resolve(selectors);
      } catch { reject(new Error("omp-model-catalog-invalid")); }
    });
  });
}
