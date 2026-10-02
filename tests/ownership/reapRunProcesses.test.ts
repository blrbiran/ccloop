import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessStart } from "../../src/ownership/ownerLiveness.js";
import { reapRunProcesses } from "../../src/ownership/reapRunProcesses.js";

const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

// Resolves only after the child has installed its SIGTERM disposition (it writes a marker),
// otherwise a fast reap would hit it before the handler exists and the SIGKILL path would go untested.
async function spawnGroup(ignoreTerm: boolean): Promise<number> {
  const marker = join(await mkdtemp(join(tmpdir(), "reap-ready-")), "ready");
  const code = `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""} require('fs').writeFileSync(${JSON.stringify(marker)},'1'); setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
  child.unref();
  pids.push(child.pid!);
  for (let i = 0; i < 200; i++) {
    if (await readFile(marker, "utf8").then(() => true, () => false)) return child.pid!;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("test child never became ready");
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function callDir(runDir: string, rel = "claude/1/execute/call-x"): Promise<string> {
  const dir = join(runDir, rel);
  await mkdir(dir, { recursive: true });
  return dir;
}
async function register(dir: string, pid: number, startedAt?: string, withRequest = true): Promise<void> {
  const at = startedAt ?? (await readProcessStart(pid))!;
  await writeFile(join(dir, "process.json"), JSON.stringify({ pid, pgid: pid, startedAt: at, phase: "execute" }));
  if (withRequest) await writeFile(join(dir, "request.json"), "{}");
}
const events = (runDir: string) => readFile(join(runDir, "events.jsonl"), "utf8").catch(() => "");
const newRun = () => mkdtemp(join(tmpdir(), "reap-"));

describe("reapRunProcesses (spec 4.2: reap only what is certainly ours, refuse otherwise)", () => {
  it("reaps an unfinished call's live group with a matching lstart, TERM honoured", async () => {
    const run = await newRun();
    const pid = await spawnGroup(false);
    await register(await callDir(run), pid);
    expect(await reapRunProcesses(run, { graceMs: 2000 })).toEqual({ ok: true, reaped: 1 });
    expect(alive(pid)).toBe(false);
    const lines = (await events(run)).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("orphan_process_group_reaped");
    expect(lines[0].detail).toBe(`pid ${pid} pgid ${pid} phase execute`);
  });

  it("falls through to SIGKILL when the group ignores SIGTERM", async () => {
    const run = await newRun();
    const pid = await spawnGroup(true);
    await register(await callDir(run), pid);
    expect(await reapRunProcesses(run, { graceMs: 200 })).toEqual({ ok: true, reaped: 1 });
    expect(alive(pid)).toBe(false);
  });

  it("leaves a finished call (outcome.json present) alone", async () => {
    const run = await newRun();
    const pid = await spawnGroup(false);
    const dir = await callDir(run);
    await register(dir, pid);
    await writeFile(join(dir, "outcome.json"), "{}");
    expect(await reapRunProcesses(run)).toEqual({ ok: true, reaped: 0 });
    expect(alive(pid)).toBe(true);
    expect(await events(run)).toBe("");
  });

  it("refuses when the leader's lstart differs from the recorded one", async () => {
    const run = await newRun();
    const pid = await spawnGroup(false);
    await register(await callDir(run), pid, "Thu Jan  1 00:00:00 1970");
    const r = await reapRunProcesses(run);
    expect(r.ok).toBe(false);
    expect(alive(pid)).toBe(true);
    expect(await events(run)).toBe("");
  });

  it("refuses when the group is present but its leader is absent", async () => {
    const run = await newRun();
    await register(await callDir(run), 999999, "x");
    const r = await reapRunProcesses(run, { probeGroup: () => "present", readStart: async () => null, signalGroup: () => {}, sleep: async () => {} });
    expect(r.ok === false && r.reason).toContain("its leader 999999 is gone");
    expect(await events(run)).toBe("");
  });

  it("refuses when the group probe errors (EPERM)", async () => {
    const run = await newRun();
    await register(await callDir(run), 999999, "x");
    const r = await reapRunProcesses(run, { probeGroup: () => ({ error: "EPERM" }), signalGroup: () => {}, sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(await events(run)).toBe("");
  });

  it("refuses when the group outlives the timeout", async () => {
    const run = await newRun();
    const pid = await spawnGroup(false);
    await register(await callDir(run), pid);
    const r = await reapRunProcesses(run, { signalGroup: () => {}, graceMs: 50, timeoutMs: 300, pollMs: 20 });
    expect(r.ok).toBe(false);
    expect(await events(run)).toBe("");
  });

  it("refuses an unparseable process.json when the call had a request", async () => {
    const run = await newRun();
    const dir = await callDir(run);
    await writeFile(join(dir, "process.json"), "{not json");
    await writeFile(join(dir, "request.json"), "{}");
    expect((await reapRunProcesses(run)).ok).toBe(false);
    expect(await events(run)).toBe("");
  });

  it("skips an unparseable process.json when the call never had a request", async () => {
    const run = await newRun();
    const dir = await callDir(run);
    await writeFile(join(dir, "process.json"), "{not json");
    expect(await reapRunProcesses(run)).toEqual({ ok: true, reaped: 0 });
  });

  it("ignores process.json under worktrees/", async () => {
    const run = await newRun();
    const pid = await spawnGroup(false);
    await register(await callDir(run, "worktrees/w1/claude/1/execute/call-y"), pid);
    expect(await reapRunProcesses(run)).toEqual({ ok: true, reaped: 0 });
    expect(alive(pid)).toBe(true);
  });

  it("identifies every call before signalling any: one doubtful call spares the certain one", async () => {
    const run = await newRun();
    const pid = await spawnGroup(false);
    await register(await callDir(run, "claude/1/execute/call-a"), pid);
    const other = await spawnGroup(false);
    await register(await callDir(run, "claude/1/execute/call-b"), other, "Thu Jan  1 00:00:00 1970");
    expect((await reapRunProcesses(run, { graceMs: 2000 })).ok).toBe(false);
    expect(alive(pid)).toBe(true);
    expect(alive(other)).toBe(true);
    expect(await events(run)).toBe("");
  });

  it("is idempotent: the second call finds nothing to reap and adds no event", async () => {
    const run = await newRun();
    const pid = await spawnGroup(false);
    await register(await callDir(run), pid);
    expect(await reapRunProcesses(run, { graceMs: 2000 })).toEqual({ ok: true, reaped: 1 });
    expect(await reapRunProcesses(run, { graceMs: 2000 })).toEqual({ ok: true, reaped: 0 });
    const lines = (await events(run)).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).type).toBe("orphan_process_group_reaped");
  });

  it("refuses when a directory cannot be read (fail closed), but a missing run dir is fine", async () => {
    const run = await newRun();
    const locked = await callDir(run, "claude/locked");
    await chmod(locked, 0o000);
    try {
      const r = await reapRunProcesses(run);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain(locked);
    } finally { await chmod(locked, 0o755); }
    expect(await reapRunProcesses(join(run, "does-not-exist"))).toEqual({ ok: true, reaped: 0 });
    expect(await events(run)).toBe("");
  });

  it("refuses without signalling when the leader's lstart changed after identification", async () => {
    const run = await newRun();
    const pid = await spawnGroup(false);
    await register(await callDir(run), pid);
    const real = (await readProcessStart(pid))!;
    let calls = 0;
    const r = await reapRunProcesses(run, { readStart: async () => (++calls === 1 ? real : "Thu Jan  1 00:00:00 1970") });
    expect(r.ok).toBe(false);
    expect(calls).toBe(2);
    expect(alive(pid)).toBe(true);
    expect(await events(run)).toBe("");
  });
});
