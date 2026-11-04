import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runSetupCommands } from "../../src/controller/setupCommands.js";

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

  it("20 MiB of output is streamed to the log", { timeout: 30_000 }, async () => {
    const { root, logDir } = await repo();
    expect(await runSetupCommands(["head -c 20971520 /dev/zero | tr '\\0' a"], root, logDir, undefined, 20_000)).toEqual({ ok: true });
    const log = await stat(join(logDir, "setup-1.log"));
    expect(log.size).toBeGreaterThanOrEqual(20971520);
    expect(log.mode & 0o777).toBe(0o600);
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
});
