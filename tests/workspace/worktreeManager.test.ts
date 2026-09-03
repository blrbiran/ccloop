import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  attemptRefName,
  cleanupAttemptWorkspace,
  createAttemptWorkspace,
  publishAttemptCommit,
} from "../../src/workspace/worktreeManager.js";

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

/**
 * Seeds a real git repo plus one attempt worktree. `configureIdentity` is a
 * parameter, not a constant, because one of the criteria below is precisely
 * that publishing works in a repo where no identity is configured — the
 * shape a throwaway sandbox repo or a CI container actually has.
 */
async function seedRepoAndWorktree(configureIdentity: boolean): Promise<{ repoDir: string; worktreePath: string }> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-p0-repo-"));
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-p0-run-"));

  await execFileAsync("git", ["init"], { cwd: repoDir });
  if (configureIdentity) {
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  }
  await writeFile(join(repoDir, "README.md"), "hello\n");
  await execFileAsync("git", ["-c", "user.name=seed", "-c", "user.email=seed@invalid", "add", "README.md"], { cwd: repoDir });
  await execFileAsync("git", ["-c", "user.name=seed", "-c", "user.email=seed@invalid", "commit", "-m", "init"], { cwd: repoDir });

  if (!configureIdentity) {
    // Measured: an unconfigured repository is not enough to reproduce the
    // failure this guard exists for. git auto-detects an identity from the OS
    // user and hostname and commits with a warning, so the criterion below
    // would pass with the identity flags deleted. Disabling auto-detection is
    // what actually reproduces a CI container, where the guessed address is
    // rejected ("unable to auto-detect email address"): with useConfigOnly and
    // no config anywhere, git exits 128 with "auto-detection is disabled".
    await execFileAsync("git", ["config", "user.useConfigOnly", "true"], { cwd: repoDir });
  }

  const { worktreePath } = await createAttemptWorkspace(repoDir, runDir, 1);
  return { repoDir, worktreePath };
}

describe("publishAttemptCommit", () => {
  it("keeps the attempt commit reachable through a ref after the worktree is removed", async () => {
    const { repoDir, worktreePath } = await seedRepoAndWorktree(true);
    await writeFile(join(worktreePath, "README.md"), "changed by the agent\n");

    const published = await publishAttemptCommit(worktreePath);
    await cleanupAttemptWorkspace(repoDir, worktreePath);

    // The ref is the only load-bearing assertion here. `git cat-file -e <sha>`
    // would stay green with no ref at all — the object lingers in the shared
    // object store until a gc that this test never runs. Asserting on the ref
    // is what makes deleting the update-ref call go red.
    const { stdout } = await execFileAsync("git", ["rev-parse", published.ref], { cwd: repoDir });
    expect(stdout.trim()).toBe(published.sha);
    expect(published.ref).toMatch(/^refs\/ccloop\/.+\/attempts\/1$/);
  });

  it("captures a modification to a tracked file in the published commit", async () => {
    const { repoDir, worktreePath } = await seedRepoAndWorktree(true);
    await writeFile(join(worktreePath, "README.md"), "changed by the agent\n");

    const published = await publishAttemptCommit(worktreePath);
    await cleanupAttemptWorkspace(repoDir, worktreePath);

    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", published.base, published.sha],
      { cwd: repoDir },
    );
    expect(stdout.trim().split("\n")).toEqual(["README.md"]);
  });

  it("captures a file the agent created but never added", async () => {
    const { repoDir, worktreePath } = await seedRepoAndWorktree(true);
    await writeFile(join(worktreePath, "brand-new.txt"), "untracked\n");

    const published = await publishAttemptCommit(worktreePath);
    await cleanupAttemptWorkspace(repoDir, worktreePath);

    const { stdout } = await execFileAsync(
      "git",
      ["show", `${published.sha}:brand-new.txt`],
      { cwd: repoDir },
    );
    expect(stdout).toBe("untracked\n");
  });

  it("captures a binary file byte for byte", async () => {
    const { repoDir, worktreePath } = await seedRepoAndWorktree(true);
    // Bytes chosen to include a NUL and a high byte so git classifies the blob
    // as binary. This is the case `diff.patch` provably cannot carry: its two
    // `git diff` invocations have no --binary, so a binary change lands as
    // "Binary files a/x and b/x differ", which `git apply` cannot apply.
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x42]);
    await writeFile(join(worktreePath, "blob.bin"), bytes);

    const published = await publishAttemptCommit(worktreePath);
    await cleanupAttemptWorkspace(repoDir, worktreePath);

    const extracted = join(await mkdtemp(join(tmpdir(), "ccloop-p0-out-")), "blob.bin");
    await execFileAsync("sh", ["-c", `git show ${published.sha}:blob.bin > ${extracted}`], { cwd: repoDir });
    expect(await readFile(extracted)).toEqual(bytes);
  });

  it("publishes in a repository that has no git identity configured", async () => {
    const { repoDir, worktreePath } = await seedRepoAndWorktree(false);
    await writeFile(join(worktreePath, "README.md"), "changed by the agent\n");

    // Measured, not assumed: without the two env vars below this criterion is
    // empty. The machine running the suite has a global git identity, so
    // `git commit` succeeds through ~/.gitconfig even when the repository
    // configures none — deleting ATTEMPT_IDENTITY from the implementation left
    // all eight criteria in this file green. Pointing git at empty config
    // files reproduces the environment the identity flags exist for: a
    // throwaway clone or a CI container with no identity anywhere.
    const saved = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_SYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    let published;
    try {
      published = await publishAttemptCommit(worktreePath);
    } finally {
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved.global;
      if (saved.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = saved.system;
    }
    await cleanupAttemptWorkspace(repoDir, worktreePath);

    const { stdout } = await execFileAsync("git", ["rev-parse", published.ref], { cwd: repoDir });
    expect(stdout.trim()).toBe(published.sha);
  });

  it("publishes a sha even when the agent changed nothing", async () => {
    const { repoDir, worktreePath } = await seedRepoAndWorktree(true);
    // Deliberately no writes. An attempt that reports success while producing
    // an empty tree is a named failure downstream; it can only be named if it
    // is distinguishable from "publishing failed", and a present sha with an
    // empty diff is exactly that distinction.
    const published = await publishAttemptCommit(worktreePath);
    await cleanupAttemptWorkspace(repoDir, worktreePath);

    const { stdout: refOut } = await execFileAsync("git", ["rev-parse", published.ref], { cwd: repoDir });
    expect(refOut.trim()).toBe(published.sha);

    const { stdout: diffOut } = await execFileAsync(
      "git",
      ["diff", "--name-only", published.base, published.sha],
      { cwd: repoDir },
    );
    expect(diffOut.trim()).toBe("");
  });
});

describe("attemptRefName", () => {
  it("refuses a path that is not an attempt worktree", () => {
    expect(() => attemptRefName("/tmp/some-run/worktrees/scratch")).toThrow(/not an attempt worktree path/);
  });
});

describe("publishAttemptCommit failure surface", () => {
  it("throws instead of returning a sentinel when the worktree is gone", async () => {
    const { repoDir, worktreePath } = await seedRepoAndWorktree(true);
    await cleanupAttemptWorkspace(repoDir, worktreePath);

    // Removing the worktree first is the cheapest real failure: the cwd no
    // longer exists, so `git rev-parse HEAD` cannot run. The point of the
    // assertion is the shape of the failure, not this particular cause —
    // a publish that fails must be loud, because a silently unpublished
    // attempt reads downstream exactly like an attempt that did nothing.
    await expect(publishAttemptCommit(worktreePath)).rejects.toThrow();
  });
});
