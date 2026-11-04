/**
 * Task setup commands (Orca spec docs/superpowers/specs/2026-11-04-task-setup-and-check-retry-design.md §4.4): a
 * contract's `context.setupCommands` run in the attempt worktree, in order, before the agent's first phase. Each runs like
 * a required check (`sh -lc`, cwd the worktree, the inherited environment, the phase abort signal) but its output is
 * streamed to a capped file rather than buffered -- an install can print far more than a check's buffer -- and stdin is
 * closed so a command that waits for input ends instead of hanging the attempt.
 *
 * Setup may write only ignored files: the worktree is fingerprinted before the first command and after the last, and any
 * difference fails the attempt naming the paths, because a change Git can see would become part of the agent's work.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, writeSync } from "node:fs";
import { lstat, mkdir, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import { readProcessStart } from "../ownership/ownerLiveness.js";
import { observedChangedPaths, worktreeSnapshot } from "../runtime/omp/worktreeSnapshot.js";

/** The controller's per-command limit (spec §4.4: at most 15 minutes), capped by the time left in the attempt. */
export const SETUP_COMMAND_TIMEOUT_MS = 900_000;
/** Each setup log keeps at most this many bytes of output (fix round 1 ruling); the rest is drained and dropped. */
export const SETUP_LOG_CAP_BYTES = 16_777_216;
export const SETUP_LOG_TRUNCATED_MARKER = `[ccloop: setup output truncated at ${SETUP_LOG_CAP_BYTES} bytes]`;

export type SetupOutcome = { ok: true } | { ok: false; command: string; detail: string };

export type SetupProcessRegistration = { pid: number; pgid: number; startedAt: string; phase: string };
export interface SetupHooks {
  /** The worker records each command's group, so a crash leaves nothing a stop proof cannot see. A throw is rethrown
   * after the group is killed: the loop, not setup, decides what a refused registration means. */
  onProcessRegistered?: (registration: SetupProcessRegistration) => Promise<void>;
}

type CommandEnd = { kind: "exit"; code: number | null; signal: NodeJS.Signals | null } | { kind: "timeout" };

/** Errors that are the controller's to handle (a refused registration), never a setup failure. */
const passThrough = new WeakSet<object>();

export async function runSetupCommands(
  commands: readonly string[],
  worktreePath: string,
  logDir: string,
  signal: AbortSignal | undefined,
  timeLeftMs: number,
  hooks: SetupHooks = {},
): Promise<SetupOutcome> {
  let current: string | null = null;
  try {
    const deadline = Date.now() + timeLeftMs;
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const beforeSnapshot = await worktreeSnapshot(worktreePath);
    const before = await pathStates(worktreePath);

    for (const [index, command] of commands.entries()) {
      current = command;
      const limitMs = Math.max(0, Math.min(SETUP_COMMAND_TIMEOUT_MS, deadline - Date.now()));
      const end = await runOne(command, worktreePath, join(logDir, `setup-${index + 1}.log`), signal, limitMs, hooks);
      if (end.kind === "timeout") return { ok: false, command, detail: `${command} timeout` };
      if (end.code === null && end.signal !== null) return { ok: false, command, detail: `${command} signal=${end.signal}` };
      if (end.code !== 0) return { ok: false, command, detail: `${command} exit=${end.code}` };
    }
    current = null;

    if (await worktreeSnapshot(worktreePath) === beforeSnapshot) return { ok: true };
    const after = await pathStates(worktreePath);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
    // A changed HEAD with an identical tree (setup committed) still changed the attempt's base.
    const command = commands.at(-1)!;
    return { ok: false, command, detail: `${command} changed: ${changed.length === 0 ? "HEAD" : changed.join(", ")}` };
  } catch (error) {
    if (isAbortError(error) || (typeof error === "object" && error !== null && passThrough.has(error))) throw error;
    // Fix round 1 ruling: any other setup error (spawn, log, snapshot) is still the setup's failure, by name.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, command: current ?? "setup", detail: `${current ?? "setup"} error=${message}` };
  }
}

async function runOne(command: string, cwd: string, logPath: string, signal: AbortSignal | undefined, limitMs: number, hooks: SetupHooks): Promise<CommandEnd> {
  signal?.throwIfAborted();
  const log = await open(logPath, "w", 0o600);
  try {
    // Its own process group, so the time limit and an abort take down whatever the command started, not only `sh`. The
    // command waits on a gate (fd 3) until its group is registered, so even a command that exits at once is registered
    // alive; `exec` keeps the registered pid and start time, and the command itself sees stdin closed and no fd 3.
    const child = spawn("sh", ["-c", 'read -r _ <&3; exec 3<&-; exec sh -lc "$1"', "sh", command],
      { cwd, stdio: ["ignore", "pipe", "pipe", "pipe"], detached: true });
    const gate = child.stdio[3] as import("node:stream").Writable;
    gate.on("error", () => undefined);
    // Streamed as it arrives, stdout and stderr interleaved; past the cap the pipes are still drained, so the command
    // never blocks on a full pipe.
    let written = 0;
    let dropped = false;
    const sink = (chunk: Buffer): void => {
      const kept = chunk.subarray(0, Math.max(0, SETUP_LOG_CAP_BYTES - written));
      if (kept.length > 0) { writeSync(log.fd, kept); written += kept.length; }
      if (kept.length < chunk.length) dropped = true;
    };
    child.stdout!.on("data", sink);
    child.stderr!.on("data", sink);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    void closed.catch(() => undefined);
    let timedOut = false;
    let aborted = false;
    const killGroup = (): void => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, limitMs);
    const onAbort = (): void => { aborted = true; killGroup(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    // An abort that landed between the check above and the listener would otherwise be missed.
    if (signal?.aborted) onAbort();
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      if (hooks.onProcessRegistered !== undefined) {
        try {
          const startedAt = await readProcessStart(child.pid!);
          if (!startedAt) throw new Error("setup-process-identity-unavailable");
          await hooks.onProcessRegistered({ pid: child.pid!, pgid: child.pid!, startedAt, phase: "setup" });
        } catch (error) {
          killGroup();
          await closed.catch(() => undefined);
          if (typeof error === "object" && error !== null) passThrough.add(error);
          throw error;
        }
      }
      gate.end("\n");
      const end = await closed;
      if (aborted) throw abortError(signal?.reason);
      if (dropped) writeSync(log.fd, `\n${SETUP_LOG_TRUNCATED_MARKER}\n`);
      return timedOut ? { kind: "timeout" } : { kind: "exit", ...end };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    await log.close();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** The loop recognises an abort by `name === "AbortError"`, as for a required check's aborted exec. */
function abortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error("The operation was aborted", { cause: reason });
  error.name = "AbortError";
  return error;
}

/** Per path Git reports as changed or untracked: its mode and bytes (or link target), so a path already dirty before
 * setup is named only when setup changed it again. */
async function pathStates(root: string): Promise<Map<string, string>> {
  const states = new Map<string, string>();
  for (const path of await observedChangedPaths(root)) {
    const hash = createHash("sha256");
    try {
      const metadata = await lstat(join(root, path));
      hash.update(`${metadata.mode}\0`);
      if (metadata.isSymbolicLink()) hash.update(await readlink(join(root, path)));
      else if (metadata.isFile()) for await (const chunk of createReadStream(join(root, path))) hash.update(chunk);
      else hash.update("special");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("absent");
    }
    states.set(path, hash.digest("hex"));
  }
  return states;
}
