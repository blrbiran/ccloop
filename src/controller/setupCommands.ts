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
import { lstat, mkdir, open, readlink, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readProcessStart } from "../ownership/ownerLiveness.js";
import { observedChangedPaths, worktreeSnapshot } from "../runtime/omp/worktreeSnapshot.js";

/** The controller's per-command limit (spec §4.4: at most 15 minutes), capped by the time left in the attempt. */
export const SETUP_COMMAND_TIMEOUT_MS = 900_000;
/** Each setup log keeps at most this many bytes of output (fix round 1 ruling); the rest is drained and dropped. */
export const SETUP_LOG_CAP_BYTES = 16_777_216;
export const SETUP_LOG_TRUNCATED_MARKER = `[ccloop: setup output truncated at ${SETUP_LOG_CAP_BYTES} bytes]`;
/** After a command's shell exits (on its own, at its limit or on an abort), its pipes get this long to drain before the
 * group is killed and the pipes are closed: a process that left the group (setsid) may hold them open indefinitely. */
export const SETUP_DRAIN_MS = 2_000;
/** Written to the log when the drain had to be cut, so a log that stops early says why (human ruling 2026-11-05). */
export const SETUP_DRAIN_CUT_MARKER = `[ccloop: setup output cut ${SETUP_DRAIN_MS} ms after the command ended; a process outside its group still held the output]`;

/** The gate opens only on an explicit newline (fix round 2 ruling): if the controller dies between spawn and registration
 * the pipe closes without one, and the command exits 125 instead of running unregistered. */
export const SETUP_GATE_SCRIPT = 'read -r _ <&3 || exit 125; exec 3<&-; exec sh -lc "$1"';

/** `outOfTime`: the command ran out of the attempt's remaining time rather than its own 15-minute cap (final-review M2
 * ruling), so the loop ends the run out of time, as for a phase, instead of setup-failed. */
export type SetupOutcome = { ok: true } | { ok: false; command: string; detail: string; outOfTime?: true };

export type SetupProcessRegistration = { pid: number; pgid: number; startedAt: string; phase: string };
export interface SetupHooks {
  /** The worker records each command's group, so a crash leaves nothing a stop proof cannot see. A throw is rethrown
   * after the group is killed: the loop, not setup, decides what a refused registration means. */
  onProcessRegistered?: (registration: SetupProcessRegistration) => Promise<void>;
  /** The per-command cap; only tests shorten it from SETUP_COMMAND_TIMEOUT_MS. */
  commandTimeoutMs?: number;
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

    const capMs = hooks.commandTimeoutMs ?? SETUP_COMMAND_TIMEOUT_MS;
    for (const [index, command] of commands.entries()) {
      current = command;
      const leftMs = Math.max(0, deadline - Date.now());
      const limitMs = Math.min(capMs, leftMs);
      const end = await runOne(command, worktreePath, logDir, index + 1, signal, limitMs, hooks);
      if (end.kind === "timeout") {
        return leftMs < capMs ? { ok: false, command, detail: `${command} timeout`, outOfTime: true } : { ok: false, command, detail: `${command} timeout` };
      }
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

async function runOne(command: string, cwd: string, logDir: string, index: number, signal: AbortSignal | undefined, limitMs: number, hooks: SetupHooks): Promise<CommandEnd> {
  signal?.throwIfAborted();
  const log = await open(join(logDir, `setup-${index}.log`), "w", 0o600);
  // Final-review M4: like a saved-result check's, the group is recorded in process.json before the command runs and
  // outcome.json once it has ended, so resume's reaping (which walks the run directory for a process.json without an
  // outcome.json) finds and kills a setup group a controller crash left behind.
  const processDir = join(logDir, `setup-${index}`);
  try {
    // Its own process group, so the time limit and an abort take down whatever the command started, not only `sh`. The
    // command waits on a gate (fd 3) until its group is registered, so even a command that exits at once is registered
    // alive; `exec` keeps the registered pid and start time, and the command itself sees stdin closed and no fd 3.
    const child = spawn("sh", ["-c", SETUP_GATE_SCRIPT, "sh", command],
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
    const killGroup = (): void => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    // Final-review M7: the end is the shell's exit plus a bounded drain, not the pipes' close -- a process that escaped
    // the group can hold them open past any kill. Final-review I1: the group is killed once the command has ended, so
    // nothing it started in the background outlives setup.
    // Human ruling 2026-11-05: the verdict is taken at the shell's exit; the drain only collects output, so the limit
    // timer is ignored once the shell has exited, and a drain that had to be cut is marked in the log.
    let exited = false;
    let drainCut = false;
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let drain: NodeJS.Timeout | undefined;
      child.once("error", (error) => { clearTimeout(drain); reject(error); });
      child.once("exit", () => {
        exited = true;
        drain = setTimeout(() => { drainCut = true; killGroup(); child.stdout!.destroy(); child.stderr!.destroy(); gate.destroy(); }, SETUP_DRAIN_MS);
      });
      child.once("close", (code, exitSignal) => { clearTimeout(drain); resolve({ code, signal: exitSignal }); });
    }).finally(killGroup);
    void ended.catch(() => undefined);
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => { if (exited) return; timedOut = true; killGroup(); }, limitMs);
    const onAbort = (): void => { aborted = true; killGroup(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    // An abort that landed between the check above and the listener would otherwise be missed.
    if (signal?.aborted) onAbort();
    let recorded = false;
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      try {
        const startedAt = await readProcessStart(child.pid!);
        if (!startedAt) throw new Error("setup-process-identity-unavailable");
        const registration = { pid: child.pid!, pgid: child.pid!, startedAt, phase: "setup" };
        await writePrivateJson(processDir, "process.json", registration);
        recorded = true;
        if (hooks.onProcessRegistered !== undefined) {
          try {
            await hooks.onProcessRegistered(registration);
          } catch (error) {
            if (typeof error === "object" && error !== null) passThrough.add(error);
            throw error;
          }
        }
      } catch (error) {
        killGroup();
        const end = await ended.catch(() => null);
        if (recorded) await writePrivateJson(processDir, "outcome.json", { code: end?.code ?? null, signal: end?.signal ?? null, refused: true });
        throw error;
      }
      gate.end("\n");
      const end = await ended;
      await writePrivateJson(processDir, "outcome.json", { code: end.code, signal: end.signal, timedOut, aborted });
      if (aborted) throw abortError(signal?.reason);
      if (dropped) writeSync(log.fd, `\n${SETUP_LOG_TRUNCATED_MARKER}\n`);
      if (drainCut) writeSync(log.fd, `\n${SETUP_DRAIN_CUT_MARKER}\n`);
      return timedOut ? { kind: "timeout" } : { kind: "exit", ...end };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    await log.close();
  }
}

/** Written whole or not at all (temporary file, then rename), mode 0600 in a 0700 directory. */
async function writePrivateJson(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.${name}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, join(dir, name));
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
