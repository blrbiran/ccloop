// Crash resume (2026-10-02), spec §3.2 (R-A): a claude that never started is answered as such, and a missing binary
// (a reinstall in progress) is retried. Helpers are copied from claudePhaseRunner.test.ts on purpose (no cross-test imports).
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const phaseRunnerPath = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));

const FAKE_EXECUTE_SOURCE = `
process.stdout.write(JSON.stringify({
  structured_output: { changedFiles: ["answer.txt"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" },
  usage: { input_tokens: 1, output_tokens: 1 }
}));
`;

function spawnPhaseRunner(request: Record<string, unknown>, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn("node", [phaseRunnerPath], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...extraEnv } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.end(JSON.stringify(request));
  return {
    child,
    result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    }),
  };
}

async function createWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccloop-neverstarted-repo-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "a");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

const executeRequest = (worktreePath: string) => ({
  phase: "execute", prompt: "run execute", attempt: 1, runDir: worktreePath, worktreePath, partialOutcomeRecoveryWindowMs: 1000,
});

async function missingCommand(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "ccloop-missing-")), "claude"); // never created
}

describe("claude phase runner: claude never started (spec 2026-10-02 §3.2)", () => {
  it("answers claudeNeverStarted with exit 0 when the claude command does not exist, after three spawns", async () => {
    const worktree = await createWorktree();
    const missing = await missingCommand();
    const started = Date.now();
    // Task 3 (folding in Task 1's review): the delay was 200 ms with only a lower bound, which a fourth spawn also met.
    // At 700 ms, three spawns take two waits (>= 1400 ms) plus startup, and a fourth spawn adds a third wait (>= 2100 ms,
    // timers never fire early), so an upper bound of 2050 ms tells them apart and leaves ~650 ms for startup under load.
    const { result } = spawnPhaseRunner(executeRequest(worktree), {
      CCLOOP_CLAUDE_COMMAND: JSON.stringify([missing]), CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: "700",
    });
    const r = await result;
    const elapsed = Date.now() - started;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ claudeNeverStarted: true, spawnError: expect.stringMatching(/^ENOENT: /) });
    expect(elapsed).toBeGreaterThanOrEqual(1400); // two waits => three spawns, not fewer
    expect(elapsed).toBeLessThan(2050); // not a third wait => not four spawns
  });

  it("starts claude on the second spawn when the command appears during the retry wait", async () => {
    const worktree = await createWorktree();
    const late = join(await mkdtemp(join(tmpdir(), "ccloop-late-")), "claude");
    const { result } = spawnPhaseRunner(executeRequest(worktree), {
      CCLOOP_CLAUDE_COMMAND: JSON.stringify([late]), CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: "600",
    });
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(late, `#!/usr/bin/env node\n${FAKE_EXECUTE_SOURCE}`);
    await chmod(late, 0o755);
    const r = await result;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).changedFiles).toEqual(["answer.txt"]);
  });

  it("does not retry a spawn failure other than ENOENT", async () => {
    const worktree = await createWorktree();
    const noexec = join(await mkdtemp(join(tmpdir(), "ccloop-noexec-")), "claude");
    await writeFile(noexec, "#!/bin/sh\n");
    await chmod(noexec, 0o644); // EACCES
    const started = Date.now();
    const r = await spawnPhaseRunner(executeRequest(worktree), {
      CCLOOP_CLAUDE_COMMAND: JSON.stringify([noexec]), CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: "2000",
    }).result;
    expect(JSON.parse(r.stdout)).toEqual({ claudeNeverStarted: true, spawnError: expect.stringMatching(/^EACCES: /) });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("answers once, never-started, when SIGTERM arrives during the retry wait (T5b)", async () => {
    const worktree = await createWorktree();
    const missing = await missingCommand();
    const { child, result } = spawnPhaseRunner(executeRequest(worktree), {
      CCLOOP_CLAUDE_COMMAND: JSON.stringify([missing]), CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: "3000",
    });
    await new Promise((r) => setTimeout(r, 500));
    child.kill("SIGTERM");
    const r = await result;
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({ claudeNeverStarted: true, spawnError: expect.stringMatching(/^ENOENT: /) });
  });

  it("never-started applies to a single call too", async () => {
    const missing = await missingCommand();
    const cwd = await mkdtemp(join(tmpdir(), "ccloop-single-cwd-"));
    const r = await spawnPhaseRunner(
      { phase: "single-call", prompt: "estimate", schema: { type: "object" }, cwd, maxOutputTokens: 256 },
      { CCLOOP_CLAUDE_COMMAND: JSON.stringify([missing]), CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: "50" },
    ).result;
    expect(JSON.parse(r.stdout)).toEqual({ claudeNeverStarted: true, spawnError: expect.stringMatching(/^ENOENT: /) });
  });
});
