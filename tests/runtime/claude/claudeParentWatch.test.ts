// Crash resume (2026-10-02), spec §3.1, criteria T1, T2, T2b and Review Focus 4: a claude phase runner whose parent
// (ccloop) is SIGKILLed stops claude and kills its own process group, instead of running on and spending. The parent is
// tests/fixtures/runner-parent.mjs, which spawns the runner the way ClaudeAgentAdapter does. Every pid a test learns is
// registered and SIGKILLed in afterEach, so a red test leaves nothing running.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const runnerParent = fileURLToPath(new URL("../../fixtures/runner-parent.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const adapterParent = fileURLToPath(new URL("../../fixtures/adapter-parent.ts", import.meta.url));
const tsxLoader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pids = new Set<number>();
const parents: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) { try { parent.kill("SIGKILL"); } catch { /* gone */ } }
  for (const pid of [...pids]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  pids.clear();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function waitGone(list: number[], ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) if (list.every((pid) => !alive(pid))) return true;
  return list.every((pid) => !alive(pid));
}

async function waitForPidFile(path: string, read: (raw: string) => number): Promise<number> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(50)) {
    try {
      const pid = read(await readFile(path, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) { pids.add(pid); return pid; }
    } catch { /* not yet */ }
  }
  throw new Error(`no pid in ${path}`);
}

type ParentOptions = { mode: string; graceMs: number; lingerChild?: boolean; noRequest?: boolean; phase?: "plan" | "execute"; recoveryWindowMs?: number };

async function startParent(options: ParentOptions) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-parent-watch-")));
  dirs.push(dir);
  const marker = join(dir, "claude-marker.json");
  const request = {
    phase: options.phase ?? "plan", prompt: "Plan one isolated L2 attempt for task t.", attempt: 1, runDir: dir, worktreePath: dir,
    ...(options.recoveryWindowMs === undefined ? {} : { partialOutcomeRecoveryWindowMs: options.recoveryWindowMs }),
  };
  const config = { command: [process.execPath, fakeCli, options.mode, marker], graceMs: options.graceMs, cwd: dir, request, lingerChild: options.lingerChild, noRequest: options.noRequest };
  const child = spawn(process.execPath, [runnerParent, JSON.stringify(config)], { stdio: ["ignore", "pipe", "inherit"] });
  parents.push(child);
  if (child.pid !== undefined) pids.add(child.pid);
  const ready = new Promise<{ runner: number; linger: number | null }>((resolve, reject) => {
    let buffered = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = JSON.parse(buffered.slice(0, newline)) as { runner: number; linger: number | null };
      pids.add(line.runner);
      if (line.linger !== null) pids.add(line.linger);
      resolve(line);
    });
    child.on("exit", () => reject(new Error("runner-parent exited before it printed its pids")));
  });
  return { child, marker, ready, claudePid: () => waitForPidFile(marker, (raw) => (JSON.parse(raw) as { pid: number }).pid) };
}

describe("claude phase runner watches its parent over fd 3 (spec 2026-10-02 §3.1)", () => {
  // Control: a live parent never trips the watch -- the fd-3 socket must not read as closed while its other end is held.
  it("leaves a runner whose parent is alive running past the grace", async () => {
    const p = await startParent({ mode: "hang", graceMs: 200 });
    const { runner } = await p.ready;
    const claudePid = await p.claudePid();
    await sleep(1200);
    expect(alive(runner)).toBe(true);
    expect(alive(claudePid)).toBe(true);
  }, 20_000);

  it("T1: runner and claude die within the grace after the parent is SIGKILLed", async () => {
    const p = await startParent({ mode: "hang", graceMs: 500 });
    const { runner } = await p.ready;
    const claudePid = await p.claudePid();
    p.child.kill("SIGKILL");
    expect(await waitGone([runner, claudePid], 500 + 3000)).toBe(true);
  }, 20_000);

  // Spec §3.1 step 3: claude gets SIGTERM as soon as the parent is gone, not at the end of the grace. With a 3000 ms
  // grace, a claude gone within 1500 ms can only have been stopped by that SIGTERM.
  it("stops claude with SIGTERM at once, before the grace runs out", async () => {
    const p = await startParent({ mode: "hang", graceMs: 3000 });
    const { runner } = await p.ready;
    const claudePid = await p.claudePid();
    p.child.kill("SIGKILL");
    expect(await waitGone([claudePid], 1500)).toBe(true);
    expect(await waitGone([runner], 3000 + 3000)).toBe(true); // the runner itself waits out the grace timer
  }, 20_000);

  // Spec §3.1 step 4: a claude that ignores SIGTERM keeps the runner waiting on it; only the grace timer's group
  // SIGKILL ends them. The runner is still there halfway through the grace (the grace is honoured), and gone after it.
  it("kills its group at the end of the grace when claude ignores SIGTERM", async () => {
    const graceMs = 1500;
    const p = await startParent({ mode: "grandchild-ignore-term", graceMs });
    const { runner } = await p.ready;
    const claudePid = await p.claudePid();
    const grandchild = await waitForPidFile(`${p.marker}.grandchild`, Number);
    p.child.kill("SIGKILL");
    await sleep(graceMs / 2);
    expect(alive(runner) && alive(claudePid)).toBe(true);
    expect(await waitGone([runner, claudePid, grandchild], graceMs / 2 + 3000)).toBe(true);
  }, 20_000);

  it("T2: same while an unrelated child of the dead parent still lives", async () => {
    const p = await startParent({ mode: "hang", graceMs: 500, lingerChild: true });
    const { runner, linger } = await p.ready;
    const claudePid = await p.claudePid();
    p.child.kill("SIGKILL");
    expect(await waitGone([runner, claudePid], 3500)).toBe(true);
    expect(linger).not.toBeNull();
    expect(alive(linger!)).toBe(true);
    process.kill(linger!, "SIGKILL");
  }, 20_000);

  it("T2b: the TERM-ignoring grandchild in the runner's group dies too", async () => {
    const p = await startParent({ mode: "grandchild", graceMs: 500 });
    const { runner } = await p.ready;
    const claudePid = await p.claudePid();
    const grandchild = await waitForPidFile(`${p.marker}.grandchild`, Number);
    expect(alive(grandchild)).toBe(true);
    p.child.kill("SIGKILL");
    expect(await waitGone([runner, claudePid, grandchild], 500 + 3000)).toBe(true);
  }, 20_000);

  // Spec §3.1 step 5 (review I2): the runner is flushing an abort partial (the adapter's SIGTERM came first, claude
  // ignores it, the recovery window runs) when the parent dies. The flush ends in process.exit long before the grace
  // timer would fire, so only the exit hook can take the group -- here the TERM-ignoring grandchild -- with it.
  it("T2b (abort flush): the group dies when the runner exits inside the grace window", async () => {
    const graceMs = 4000;
    const p = await startParent({ mode: "grandchild-ignore-term", graceMs, phase: "execute", recoveryWindowMs: 1500 });
    const { runner } = await p.ready;
    const claudePid = await p.claudePid();
    const grandchild = await waitForPidFile(`${p.marker}.grandchild`, Number);
    process.kill(-runner, "SIGTERM"); // the adapter's stop signals the whole group
    await sleep(300);
    p.child.kill("SIGKILL");
    // Flush exit at ~1500 ms after the SIGTERM; the grace timer would fire at ~4300 ms. 2500 ms after the parent's death
    // is inside the grace, so the timer cannot be what killed the group.
    expect(await waitGone([runner, claudePid, grandchild], 2500)).toBe(true);
  }, 20_000);

  // The same as T1, with ClaudeAgentAdapter itself as the parent: pins the adapter's half (the fd-3 pipe and
  // CCLOOP_PARENT_WATCH_FD=3), which the fixture parent above only imitates.
  it("T1 through ClaudeAgentAdapter: runner and claude die after the adapter's process is SIGKILLed", async () => {
    const child = spawn(process.execPath, ["--import", tsxLoader, adapterParent], {
      stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, CCLOOP_PARENT_GONE_GRACE_MS: "500" },
    });
    parents.push(child);
    if (child.pid !== undefined) pids.add(child.pid);
    const { dir, marker, runDir } = await new Promise<{ dir: string; marker: string; runDir: string }>((resolve, reject) => {
      let buffered = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        buffered += chunk;
        const newline = buffered.indexOf("\n");
        if (newline >= 0) resolve(JSON.parse(buffered.slice(0, newline)));
      });
      child.on("exit", () => reject(new Error("adapter-parent exited before it printed its paths")));
    });
    dirs.push(dir);
    const claudePid = await waitForPidFile(marker, (raw) => (JSON.parse(raw) as { pid: number }).pid);
    const callRoot = join(runDir, "claude", "1", "plan");
    const [call] = await readdir(callRoot);
    const runner = await waitForPidFile(join(callRoot, call!, "process.json"), (raw) => (JSON.parse(raw) as { pid: number }).pid);
    expect(alive(runner)).toBe(true);
    child.kill("SIGKILL");
    expect(await waitGone([runner, claudePid], 500 + 3000)).toBe(true);
  }, 30_000);

  it("RF4: parent gone before the request arrives -- runner exits, no claude spawned", async () => {
    const p = await startParent({ mode: "hang", graceMs: 500, noRequest: true });
    const { runner } = await p.ready;
    p.child.kill("SIGKILL");
    expect(await waitGone([runner], 3500)).toBe(true);
    expect(existsSync(`${p.marker}.argv`)).toBe(false);
  }, 20_000);
});
