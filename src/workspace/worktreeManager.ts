import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

/**
 * Author and committer are passed per-invocation instead of read from the
 * environment: the repositories this runs against are frequently throwaway
 * clones or CI checkouts with no user.email set, where `git commit` fails
 * outright. Depending on ambient config would make publishing break in
 * exactly the setups it exists to serve.
 */
const ATTEMPT_IDENTITY = ["-c", "user.name=ccloop", "-c", "user.email=ccloop@invalid"];

export interface AttemptCommit {
  /** The commit the attempt produced. */
  sha: string;
  /** The commit the worktree was created at, i.e. sha's parent. */
  base: string;
  /** The ref that makes sha reachable after the worktree is gone. */
  ref: string;
}

/**
 * Derived from the worktree path alone, because that is the only handle every
 * cleanup call site already holds. createAttemptWorkspace builds the path as
 * <runDir>/worktrees/attempt-<n>, so the run id is the run directory's
 * basename and <n> is the leaf's suffix.
 */
export function attemptRefName(worktreePath: string): string {
  const leaf = basename(worktreePath);
  const match = /^attempt-(.+)$/.exec(leaf);
  if (match === null) {
    throw new Error(`not an attempt worktree path: ${worktreePath}`);
  }
  const runId = basename(dirname(dirname(worktreePath)));
  return `refs/ccloop/${runId}/attempts/${match[1]}`;
}

/**
 * Commits whatever the attempt left in its worktree and pins it with a ref.
 *
 * The worktree shares an object database with repoPath, so the commit object
 * is already in the right store the moment it is written; the ref is what
 * stops it from being unreachable once `git worktree remove` runs. That single
 * `update-ref` is the whole mechanism — everything else here is bookkeeping.
 *
 * Throws on any failure. Callers decide whether a failed publish is fatal;
 * this function does not swallow, because a silently unpublished attempt is
 * indistinguishable downstream from an attempt that changed nothing.
 */
export async function publishAttemptCommit(worktreePath: string): Promise<AttemptCommit> {
  const ref = attemptRefName(worktreePath);

  const { stdout: baseOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  const base = baseOut.trim();

  await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
  await execFileAsync(
    "git",
    [...ATTEMPT_IDENTITY, "commit", "--allow-empty", "-m", `ccloop attempt: ${ref}`],
    { cwd: worktreePath },
  );

  const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  const sha = shaOut.trim();

  await execFileAsync("git", ["update-ref", ref, sha], { cwd: worktreePath });

  return { sha, base, ref };
}

export async function cleanupAttemptWorkspace(repoPath: string, worktreePath: string): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
}
