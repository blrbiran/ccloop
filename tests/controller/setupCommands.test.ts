import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { runSetupCommands, SETUP_GATE_SCRIPT, SETUP_LOG_TRUNCATED_MARKER } from "../../src/controller/setupCommands.js";
import { reapRunProcesses } from "../../src/ownership/reapRunProcesses.js";

// Task setup commands (spec 2026-11-04 §4.4): a contract's setup runs in the attempt worktree before the agent's first
// phase. It may only write ignored files (dependencies, caches): anything Git can see would become part of the agent's
// change, so a setup that writes one, exits non-zero or runs past its limit fails by name instead of handing the agent a
// half-prepared or polluted tree.
const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repo(): Promise<{ root: string; logDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "ccloop-setup-repo-"));
  const logs = await mkdtemp(join(tmpdir(), "ccloop-setup-logs-"));
  dirs.push(root, logs);
  for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) await execFileAsync("git", args, { cwd: root });
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd: root });
  return { root, logDir: join(logs, "attempts", "1") };
}

describe("runSetupCommands", () => {
  it("runs every command in order in the worktree", async () => {
    const { root, logDir } = await repo();
    const outcome = await runSetupCommands(["mkdir -p node_modules && echo one >> node_modules/out.txt", "echo two >> node_modules/out.txt"], root, logDir, undefined, 10_000);
    expect(outcome).toEqual({ ok: true });
    expect(await readFile(join(root, "node_modules", "out.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("a non-zero exit names the command", async () => {
    const { root, logDir } = await repo();
    expect(await runSetupCommands(["true", "exit 3"], root, logDir, undefined, 10_000)).toEqual({ ok: false, command: "exit 3", detail: "exit 3 exit=3" });
  });

  it("a command over its time limit is killed", async () => {
    const { root, logDir } = await repo();
    const started = Date.now();
    const outcome = await runSetupCommands(["sleep 5"], root, logDir, undefined, 200);
    const elapsed = Date.now() - started;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.detail).toBe("sleep 5 timeout");
    expect(elapsed).toBeLessThan(2000);
  });

  it("writing a tracked or untracked non-ignored file fails", async () => {
    const { root, logDir } = await repo();
    expect(await runSetupCommands(["echo x > new.txt"], root, logDir, undefined, 10_000))
      .toEqual({ ok: false, command: "echo x > new.txt", detail: "echo x > new.txt changed: new.txt" });
    const tracked = await repo();
    expect(await runSetupCommands(["echo more >> tracked.txt"], tracked.root, tracked.logDir, undefined, 10_000))
      .toEqual({ ok: false, command: "echo more >> tracked.txt", detail: "echo more >> tracked.txt changed: tracked.txt" });
  });

  it("a path already changed before setup is named only when setup changes it again", async () => {
    // A continuation starts from its predecessor's dirty tree: the comparison is before against after, not against HEAD.
    const { root, logDir } = await repo();
    await writeFile(join(root, "tracked.txt"), "predecessor\n");
    await writeFile(join(root, "untracked.txt"), "predecessor\n");
    expect(await runSetupCommands(["mkdir -p node_modules && touch node_modules/x"], root, logDir, undefined, 10_000)).toEqual({ ok: true });
    expect(await runSetupCommands(["echo again >> untracked.txt"], root, logDir, undefined, 10_000))
      .toEqual({ ok: false, command: "echo again >> untracked.txt", detail: "echo again >> untracked.txt changed: untracked.txt" });
  });

  it("stdin is closed", async () => {
    const { root, logDir } = await repo();
    const started = Date.now();
    expect(await runSetupCommands(["read x; echo got"], root, logDir, undefined, 3_000)).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await readFile(join(logDir, "setup-1.log"), "utf8")).toContain("got\n");
  });

  // Fix round 1 ruling (Orca session af2ceee1, 2026-11-05): each log is capped at 16 MiB; past the cap the output is
  // still drained (the command ends ok, it is not blocked on a full pipe) and one marker line says it was cut.
  it("20 MiB of output is streamed to the log, capped at 16 MiB with one marker", { timeout: 30_000 }, async () => {
    const { root, logDir } = await repo();
    expect(await runSetupCommands(["head -c 20971520 /dev/zero | tr '\\0' a"], root, logDir, undefined, 20_000)).toEqual({ ok: true });
    const path = join(logDir, "setup-1.log");
    const marker = `\n${SETUP_LOG_TRUNCATED_MARKER}\n`;
    expect(SETUP_LOG_TRUNCATED_MARKER).toBe("[ccloop: setup output truncated at 16777216 bytes]");
    const log = await stat(path);
    expect(log.size).toBe(16777216 + Buffer.byteLength(marker));
    expect(log.mode & 0o777).toBe(0o600);
    const bytes = await readFile(path);
    expect(bytes.subarray(-Buffer.byteLength(marker)).toString()).toBe(marker);
    expect(bytes.subarray(16777216 - 1, 16777216).toString()).toBe("a");
  });

  it("output under the cap has no marker", async () => {
    const { root, logDir } = await repo();
    expect(await runSetupCommands(["echo small"], root, logDir, undefined, 10_000)).toEqual({ ok: true });
    expect(await readFile(join(logDir, "setup-1.log"), "utf8")).not.toContain("truncated");
  });

  // Fix round 1 ruling: a command killed by a signal that is not the time limit is named by the signal.
  it("a command killed by a signal names the signal", async () => {
    const { root, logDir } = await repo();
    expect(await runSetupCommands(["kill -9 $$"], root, logDir, undefined, 10_000)).toEqual({ ok: false, command: "kill -9 $$", detail: "kill -9 $$ signal=SIGKILL" });
  });

  // Fix round 1 ruling: any other setup error is a setup failure by name, not an unknown controller failure.
  it("an error running a command is a setup failure naming the command", async () => {
    const { root, logDir } = await repo();
    await mkdir(join(logDir, "setup-1.log"), { recursive: true });
    const outcome = await runSetupCommands(["true"], root, logDir, undefined, 10_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.command).toBe("true");
    expect(outcome.ok === false && outcome.detail).toMatch(/^true error=EISDIR/);
  });

  it("an error before any command is a setup failure named setup", async () => {
    const { root, logDir } = await repo();
    const outcome = await runSetupCommands(["true"], join(root, "missing"), logDir, undefined, 10_000);
    expect(outcome.ok === false && outcome.detail).toMatch(/^setup error=/);
  });

  // Fix round 1: every command's group is registered while it is alive -- even one that exits at once -- so a worker
  // crash leaves no group a stop proof cannot see.
  it("each command's process group is registered before it runs", async () => {
    const { root, logDir } = await repo();
    const registered: Array<{ pid: number; pgid: number; startedAt: string; phase: string }> = [];
    expect(await runSetupCommands(["true", "mkdir -p node_modules && echo $$ > node_modules/pid"], root, logDir, undefined, 10_000, {
      onProcessRegistered: async (registration) => { registered.push(registration); },
    })).toEqual({ ok: true });
    expect(registered).toHaveLength(2);
    for (const entry of registered) expect([entry.phase, entry.pgid === entry.pid, typeof entry.startedAt, entry.startedAt.length > 0]).toEqual(["setup", true, "string", true]);
    // The registered pid is the one the command itself runs as.
    expect(Number((await readFile(join(root, "node_modules", "pid"), "utf8")).trim())).toBe(registered[1]!.pid);
  });

  // Fix round 2 ruling: the gate opens only on an explicit newline. If the controller dies between spawn and
  // registration its end of the gate closes with nothing written, and the command must not run unregistered. Measured on
  // the gate script runSetupCommands spawns, since the controller's own death cannot be staged in-process.
  it("the gate closed without a newline exits 125 and never runs the command", async () => {
    const { root } = await repo();
    const gated = (open: boolean) => new Promise<number | null>((resolve) => {
      const child = spawn("sh", ["-c", SETUP_GATE_SCRIPT, "sh", "touch ran"], { cwd: root, stdio: ["ignore", "ignore", "ignore", "pipe"] });
      (child.stdio[3] as Writable).end(open ? "\n" : "");
      child.once("close", resolve);
    });
    expect(await gated(false)).toBe(125);
    expect(existsSync(join(root, "ran"))).toBe(false);
    expect(await gated(true)).toBe(0);
    expect(existsSync(join(root, "ran"))).toBe(true);
  });

  it("a refused registration is rethrown and the command never runs", async () => {
    const { root, logDir } = await repo();
    const refusal = new Error("control-handoff-latched-before-prompt");
    await expect(runSetupCommands(["mkdir -p node_modules && touch node_modules/ran"], root, logDir, undefined, 10_000, {
      // The refusal comes late, so a command not held back until registration would have run by then.
      onProcessRegistered: async () => { await new Promise((resolve) => setTimeout(resolve, 500)); throw refusal; },
    })).rejects.toBe(refusal);
    expect(existsSync(join(root, "node_modules", "ran"))).toBe(false);
  });

  it("each command has its own log, stdout and stderr together", async () => {
    const { root, logDir } = await repo();
    expect(await runSetupCommands(["echo out; echo err >&2", "echo second"], root, logDir, undefined, 10_000)).toEqual({ ok: true });
    // toContain, not toBe: `sh -lc` reads the login profile, which may print on some machines.
    expect(await readFile(join(logDir, "setup-1.log"), "utf8")).toContain("out\nerr\n");
    expect(await readFile(join(logDir, "setup-2.log"), "utf8")).toContain("second\n");
    expect(await readFile(join(logDir, "setup-2.log"), "utf8")).not.toContain("out");
  });

  it("an abort rethrows, not a setup failure", async () => {
    const { root, logDir } = await repo();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await expect(runSetupCommands(["sleep 5"], root, logDir, controller.signal, 10_000)).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // Final-review I1: a command's background children die with it. A setup that leaves a daemon running hands the agent a
  // tree with a process nobody registered as live, holding files and ports past the attempt.
  it("nothing a command started in its group outlives the command", async () => {
    const { root, logDir } = await repo();
    let pgid = 0;
    expect(await runSetupCommands(["sleep 5 </dev/null >/dev/null 2>&1 & echo started"], root, logDir, undefined, 10_000, {
      onProcessRegistered: async (registration) => { pgid = registration.pgid; },
    })).toEqual({ ok: true });
    expect(pgid).toBeGreaterThan(0);
    // SIGKILL is delivered at once; the orphaned children are reaped by init a moment later.
    const deadline = Date.now() + 1000;
    let probe = "present";
    while (Date.now() < deadline) {
      try { process.kill(-pgid, 0); } catch (error) { probe = String((error as NodeJS.ErrnoException).code); if (probe === "ESRCH") break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(probe).toBe("ESRCH");
  });

  // Final-review M7: a timeout must end setup within a bounded time even when a process outside the group holds the
  // output pipe -- otherwise the attempt hangs as long as that process lives, past every limit.
  it("a timeout returns promptly though an escaped process holds the output pipe", async () => {
    const { root, logDir } = await repo();
    const started = Date.now();
    const escaped = join(root, "node_modules", "escaped.pid");
    try {
      const outcome = await runSetupCommands([`mkdir -p node_modules; perl -e 'use POSIX; setsid(); open(F, ">", "${escaped}"); print F $$; close F; sleep 30' & sleep 30`], root, logDir, undefined, 300);
      expect(outcome).toMatchObject({ ok: false, detail: expect.stringMatching(/ timeout$/) });
      expect(Date.now() - started).toBeLessThan(3500);
    } finally {
      // The escaped process is outside every group setup kills; the test ends it itself (before the repo is removed).
      const pid = Number(await readFile(escaped, "utf8").catch(() => "0"));
      if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  // Final-review M2 ruling: running out of the attempt's remaining time is the attempt being out of time; only the
  // per-command cap is the setup's own timeout. The loop tells them apart by this flag.
  it("a timeout at the attempt's remaining time is out of time; one at the cap is not", async () => {
    const { root, logDir } = await repo();
    expect(await runSetupCommands(["sleep 5"], root, logDir, undefined, 300, { commandTimeoutMs: 10_000 }))
      .toEqual({ ok: false, command: "sleep 5", detail: "sleep 5 timeout", outOfTime: true });
    expect(await runSetupCommands(["sleep 5"], root, logDir, undefined, 10_000, { commandTimeoutMs: 300 }))
      .toEqual({ ok: false, command: "sleep 5", detail: "sleep 5 timeout" });
  });

  // Final-review M4: a controller crash mid-setup leaves the command's group running; resume reaps only what a
  // process.json without an outcome.json names, so setup writes both where the reaper walks (the run directory).
  it("a running command is recorded for reaping, and reaping a leftover setup group kills it", async () => {
    const { root, logDir } = await repo();
    const runDir = join(logDir, "..", "..");
    let registered: { pid: number; pgid: number; startedAt: string; phase: string } | null = null;
    const running = runSetupCommands(["sleep 30"], root, logDir, undefined, 60_000, { onProcessRegistered: async (registration) => { registered = registration; } });
    for (let waited = 0; registered === null && waited < 5000; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      const processJson = JSON.parse(await readFile(join(logDir, "setup-1", "process.json"), "utf8"));
      expect(processJson).toEqual(registered);
      expect(existsSync(join(logDir, "setup-1", "outcome.json"))).toBe(false);
      const started = Date.now();
      expect(await reapRunProcesses(runDir, { graceMs: 2000 })).toEqual({ ok: true, reaped: 1 });
      expect((await running).ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(10_000);
      // Once ended, the command is finished for the reaper.
      expect(existsSync(join(logDir, "setup-1", "outcome.json"))).toBe(true);
    } finally {
      // A red run leaves the group alive; it is the test's to end.
      const pgid = (registered as { pgid: number } | null)?.pgid;
      if (pgid !== undefined) try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
      await running.catch(() => undefined);
    }
  });
});
