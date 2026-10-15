import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 1024 * 1024;
const STDERR_KEEP = 4096;
const STDERR_TAIL_BYTES = 400;

/**
 * Feedback #58: the last <= 400 bytes of a probe's stderr for its error message -- decoded as UTF-8 from a character
 * boundary, control characters as spaces, whitespace collapsed, cut on whole characters. Empty when nothing is left.
 */
export function stderrTail(kept: Buffer): string {
  let start = 0;
  while (start < kept.length && (kept[start]! & 0xc0) === 0x80) start += 1;
  const text = kept.subarray(start).toString("utf8").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = Array.from(text);
  let bytes = 0;
  let from = chars.length;
  while (from > 0 && bytes + Buffer.byteLength(chars[from - 1]!) <= STDERR_TAIL_BYTES) { from -= 1; bytes += Buffer.byteLength(chars[from]!); }
  return chars.slice(from).join("").trim();
}

/** Every-agent requirement chain (Orca spec 2026-10-15 §4.3, R6): the old fixed 10 s became min(caller deadline, 30 s). */
export const PROBE_CAP_MS = 30_000;
export type ProbeStage = "spawn" | "timeout" | "abort" | "exit" | "decode";
export class CatalogProbeError extends Error {
  constructor(readonly stage: ProbeStage, readonly elapsedMs: number, message: string) { super(message); this.name = "CatalogProbeError"; }
}
export function probeTimeoutMs(deadline: number | undefined, now = Date.now()): number {
  return deadline === undefined ? PROBE_CAP_MS : Math.max(0, Math.min(deadline - now, PROBE_CAP_MS));
}
export function probeFailure(code: string, reason: string, stage: ProbeStage, startedAt: number, tail = ""): CatalogProbeError {
  const elapsedMs = Date.now() - startedAt;
  return new CatalogProbeError(stage, elapsedMs, `${code}: ${reason} · stage ${stage} · elapsedMs ${elapsedMs}${tail === "" ? "" : ` · stderr: ${tail}`}`);
}

/** One catalog/feature probe in a private process group; resolves with stdout, or rejects naming why, the stage and the time. */
export function runProbe(code: string, command: string, args: string[], env: NodeJS.ProcessEnv, options: { timeoutMs: number; signal?: AbortSignal }): Promise<string> {
  const startedAt = Date.now();
  if (options.timeoutMs <= 0) return Promise.reject(probeFailure(code, "timeout 0ms", "timeout", startedAt));
  if (options.signal?.aborted) return Promise.reject(probeFailure(code, "aborted", "abort", startedAt));
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let bytes = 0; let stderr: Buffer = Buffer.alloc(0);
    let stopped: { reason: string; stage: ProbeStage } | null = null; let spawnError: NodeJS.ErrnoException | null = null;
    const kill = (reason: string, stage: ProbeStage): void => {
      if (stopped !== null) return; stopped = { reason, stage };
      if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const timer = setTimeout(() => kill(`timeout ${options.timeoutMs}ms`, "timeout"), options.timeoutMs);
    const onAbort = (): void => kill("aborted", "abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > OUTPUT_LIMIT) { kill("output-limit", "decode"); return; } chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length > OUTPUT_LIMIT) kill("output-limit", "decode");
      stderr = Buffer.concat([stderr, chunk.subarray(Math.max(0, chunk.length - STDERR_KEEP))]);
      if (stderr.length > STDERR_KEEP) stderr = stderr.subarray(stderr.length - STDERR_KEEP);
    });
    child.on("error", (error: NodeJS.ErrnoException) => { spawnError = error; });
    child.on("close", (exit, signal) => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
      // Feedback #58: the code stays the message's prefix (callers match it); the detail names why, never stdout or env.
      // Spec §4.3: stage and elapsed time follow the reason, and the stderr tail stays last.
      const failed = stopped ?? (spawnError !== null ? { reason: `spawn ${spawnError.code ?? spawnError.message}`, stage: "spawn" as const }
        : exit === null ? { reason: `signal ${signal ?? "unknown"}`, stage: "exit" as const } : exit !== 0 ? { reason: `exit ${exit}`, stage: "exit" as const } : null);
      if (failed !== null) { reject(probeFailure(code, failed.reason, failed.stage, startedAt, stderrTail(stderr))); return; }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
