import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAcceptedLock } from "../../src/control/store.js";
import { readProcessStartedAt } from "../../src/control/workerLauncher.js";

// Orca follow-up J (Orca session c8b75eac, 2026-11-13; the controller's decision, reversible): a settle-lost-worker killed
// while holding control/accepted.lock left it behind, and every later claim / seal / settle answered control-accepted-busy
// forever. The lock names its holder (pid + process start); a provably dead holder's lock is removed by the next taker;
// a live or undeterminable holder keeps it.
async function source() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-accepted-lock-")));
  await mkdir(join(dir, "control"), { mode: 0o700 });
  return { dir, lock: join(dir, "control", "accepted.lock") };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const children: number[] = [];
afterEach(() => { for (const pid of children.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL"); vi.restoreAllMocks(); });
const busy = (dir: string) => withAcceptedLock(dir, async () => "entered").then(() => { throw new Error("expected control-accepted-busy"); }, (error: Error) => error.message);

describe("control/accepted.lock stale recovery (Orca follow-up J)", { timeout: 30_000 }, () => {
  it("a lock left by a killed holder is removed by the next taker, which proceeds", async () => {
    const { dir, lock } = await source();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); children.push(child.pid!);
    let startedAt: string | null = null;
    for (let i = 0; i < 50 && startedAt === null; i += 1) { startedAt = await readProcessStartedAt(child.pid!); if (startedAt === null) await new Promise((r) => setTimeout(r, 20)); }
    expect(startedAt).not.toBeNull();
    await writeFile(lock, JSON.stringify({ pid: child.pid, startedAt, nonce: "killed-holder" }), { mode: 0o600 });
    // While the holder lives, the lock is its.
    expect(await busy(dir)).toBe("control-accepted-busy");
    child.kill("SIGKILL"); await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // mutation: no recovery (a contender always waits) -> control-accepted-busy, red
    expect(await withAcceptedLock(dir, async () => "entered")).toBe("entered");
    expect(existsSync(lock)).toBe(false);
    expect((await readdir(join(dir, "control"))).sort()).toEqual([]);
  });

  it("a lock whose live holder is this process stays, and the taker answers control-accepted-busy", async () => {
    const { dir, lock } = await source();
    const content = JSON.stringify({ pid: process.pid, startedAt: await readProcessStartedAt(process.pid), nonce: "live-holder" });
    await writeFile(lock, content, { mode: 0o600 });
    // mutation: any lock with an identity taken for stale -> entered, red
    expect(await busy(dir)).toBe("control-accepted-busy");
    expect(await readFile(lock, "utf8")).toBe(content);
  });

  it("a lock whose pid now belongs to a later-started process (pid reuse) is recovered", async () => {
    const { dir, lock } = await source();
    // This process holds the pid now; the recorded holder started an hour before it, so the pid was reused.
    const own = Date.parse((await readProcessStartedAt(process.pid))!);
    await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date(own - 3_600_000).toISOString(), nonce: "reused-pid" }), { mode: 0o600 });
    // mutation: only a gone pid counts as dead (start time ignored) -> control-accepted-busy, red
    expect(await withAcceptedLock(dir, async () => "entered")).toBe("entered");
  });

  it.each([
    ["an empty lock (as older ccloop wrote)", ""],
    ["a lock without a start time", JSON.stringify({ pid: 999_999, startedAt: null, nonce: "no-start" })],
  ])("an undeterminable holder keeps the lock: %s", async (_what, content) => {
    const { dir, lock } = await source();
    await writeFile(lock, content, { mode: 0o600 });
    expect(await busy(dir)).toBe("control-accepted-busy");
    expect(await readFile(lock, "utf8")).toBe(content);
  });

  it("of contenders racing to recover one stale lock, exactly one removes it and no two hold the lock at once", async () => {
    const { dir, lock } = await source();
    const own = Date.parse((await readProcessStartedAt(process.pid))!);
    await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date(own - 3_600_000).toISOString(), nonce: "raced" }), { mode: 0o600 });
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
    let inside = 0, most = 0, entered = 0;
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => withAcceptedLock(dir, async () => {
      inside += 1; entered += 1; most = Math.max(most, inside);
      await new Promise((r) => setTimeout(r, 40));
      inside -= 1;
    })));
    vi.restoreAllMocks();
    // mutation: remove a judged-stale lock without the exclusive stale-<nonce> claim -> a late recoverer removes a fresh
    // holder's lock, so two hold it at once (most 2) or the stale lock is reported removed more than once, red
    expect(lines.filter((line) => line.includes("held by dead pid"))).toHaveLength(1);
    expect(most).toBe(1);
    // Every contender either entered or answered busy; none failed otherwise.
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.message).every((m: string) => m === "control-accepted-busy")).toBe(true);
    expect(entered).toBeGreaterThanOrEqual(1);
    expect((await readdir(join(dir, "control"))).sort()).toEqual([]);
  });
});
