import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function createAttemptWorkspace(repoPath: string, runDir: string, attempt: number): Promise<{ worktreePath: string }> {
  const worktreePath = join(runDir, "worktrees", `attempt-${attempt}`);
  await mkdir(join(runDir, "worktrees"), { recursive: true });

  if (await pathExists(worktreePath)) {
    throw new Error(`attempt workspace path already exists: ${worktreePath}`);
  }

  await execFileAsync("git", ["worktree", "add", "--detach", worktreePath], { cwd: repoPath });
  return { worktreePath };
}

export async function cleanupAttemptWorkspace(repoPath: string, worktreePath: string): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
}
