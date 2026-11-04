/**
 * Task setup commands (ccloop spec docs: Orca 2026-11-04-task-setup-and-check-retry-design.md §4.4): a contract's
 * `context.setupCommands` run in the attempt worktree, in order, before the agent's first phase. Each runs like a required
 * check (`sh -lc`, cwd the worktree, the inherited environment, the phase abort signal) but its output is streamed to a
 * file rather than buffered -- an install can print far more than a check's buffer -- and stdin is closed so a command
 * that waits for input ends instead of hanging the attempt.
 *
 * Setup may write only ignored files: the worktree is fingerprinted before the first command and after the last, and any
 * difference fails the attempt naming the paths, because a change Git can see would become part of the agent's work.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import { observedChangedPaths, worktreeSnapshot } from "../runtime/omp/worktreeSnapshot.js";

/** The controller's per-command limit (spec §4.4: at most 15 minutes), capped by the time left in the attempt. */
export const SETUP_COMMAND_TIMEOUT_MS = 900_000;

export type SetupOutcome = { ok: true } | { ok: false; command: string; detail: string };

type CommandEnd = { kind: "exit"; code: number | null; signal: NodeJS.Signals | null } | { kind: "timeout" };

export async function runSetupCommands(
  commands: readonly string[],
  worktreePath: string,
  logDir: string,
  signal: AbortSignal | undefined,
  timeLeftMs: number,
): Promise<SetupOutcome> {
  const deadline = Date.now() + timeLeftMs;
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const beforeSnapshot = await worktreeSnapshot(worktreePath);
  const before = await pathStates(worktreePath);

  for (const [index, command] of commands.entries()) {
    const limitMs = Math.max(0, Math.min(SETUP_COMMAND_TIMEOUT_MS, deadline - Date.now()));
    const end = await runOne(command, worktreePath, join(logDir, `setup-${index + 1}.log`), signal, limitMs);
    if (end.kind === "timeout") return { ok: false, command, detail: `${command} timeout` };
    if (end.code !== 0) return { ok: false, command, detail: `${command} exit=${end.code ?? end.signal}` };
  }

  if (await worktreeSnapshot(worktreePath) === beforeSnapshot) return { ok: true };
  const after = await pathStates(worktreePath);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
  // A changed HEAD with an identical tree (setup committed) still changed the attempt's base.
  const command = commands.at(-1)!;
  return { ok: false, command, detail: `${command} changed: ${changed.length === 0 ? "HEAD" : changed.join(", ")}` };
}

async function runOne(command: string, cwd: string, logPath: string, signal: AbortSignal | undefined, limitMs: number): Promise<CommandEnd> {
  signal?.throwIfAborted();
  const log = await open(logPath, "w", 0o600);
  try {
    return await new Promise<CommandEnd>((resolve, reject) => {
      // Its own process group, so the time limit and an abort take down whatever the command started, not only `sh`.
      const child = spawn("sh", ["-lc", command], { cwd, stdio: ["ignore", log.fd, log.fd], detached: true });
      let timedOut = false;
      let aborted: unknown = null;
      const killGroup = (): void => {
        try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      };
      const timer = setTimeout(() => { timedOut = true; killGroup(); }, limitMs);
      const onAbort = (): void => { aborted = signal!.reason ?? new DOMException("This operation was aborted", "AbortError"); killGroup(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const settle = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      child.once("error", (error) => { settle(); reject(error); });
      child.once("close", (code, exitSignal) => {
        settle();
        if (aborted !== null) reject(abortError(aborted));
        else resolve(timedOut ? { kind: "timeout" } : { kind: "exit", code, signal: exitSignal });
      });
    });
  } finally {
    await log.close();
  }
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
