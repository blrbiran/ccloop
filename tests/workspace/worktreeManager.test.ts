import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanupAttemptWorkspace, createAttemptWorkspace } from "../../src/workspace/worktreeManager.js";

const execFileAsync = promisify(execFile);

describe("worktreeManager", () => {
  it("creates and removes a detached worktree", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "ccloop-repo-"));
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
    await writeFile(join(repoDir, "README.md"), "hello\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });

    const { worktreePath } = await createAttemptWorkspace(repoDir, runDir, 1);
    expect(worktreePath).toContain(runDir);

    const { stdout: headName } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
    expect(headName.trim()).toBe("HEAD");

    await cleanupAttemptWorkspace(repoDir, worktreePath);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoDir });
    expect(stdout).not.toContain(worktreePath);
  });
});
