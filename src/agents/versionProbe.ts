import { spawn } from "node:child_process";

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[\w.]+)?/;
const VERSION_OUTPUT_LIMIT = 64 * 1024;
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Runs `<command> --version` once (spec §4.2 / §12 C6) and answers the first `x.y.z[-tag]` in its stdout, or
 * null when it cannot be run, exits non-zero, prints no version, prints too much, or outlives the timeout.
 * Every-agent requirement chain (Orca spec 2026-10-15 §4.3): also null when the caller's `signal` aborts it.
 */
export function probeVersion(command: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let aborted = false;
    let output = "";
    // A private process group lets timeout/overflow reap descendants that a CLI leaves behind.
    const child = spawn(command[0]!, [...command.slice(1), "--version"], { stdio: ["ignore", "pipe", "ignore"], env: process.env, detached: true });
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortTree);
      resolve(value);
    };
    const abortTree = (): void => {
      if (aborted) return;
      aborted = true;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => {
      abortTree();
    }, options.timeoutMs ?? VERSION_TIMEOUT_MS);
    options.signal?.addEventListener("abort", abortTree, { once: true });
    if (options.signal?.aborted) abortTree();
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > VERSION_OUTPUT_LIMIT) {
        abortTree();
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(!aborted && code === 0 ? (VERSION_PATTERN.exec(output)?.[0] ?? null) : null));
  });
}
