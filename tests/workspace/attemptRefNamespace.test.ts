import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createAttemptWorkspace, namespacedAttemptRefName, publishAttemptCommit, registerAttemptRefNamespace } from "../../src/workspace/worktreeManager.js";

// Orca execution driver (2026-09-25), ccloop change C2, additive: the shared path-derived ref is still
// published exactly as before; a registered run directory ALSO pins its attempt under its own name.
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd })).stdout.trim();

async function repository(): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-ref-ns-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q");
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(repo, "add", "a.txt");
  await git(repo, "commit", "-qm", "base");
  return { root, repo };
}

describe("attempt refs under a registered control run (Orca execution driver C2)", () => {
  it("names the namespaced ref after the attempt leaf", () => {
    expect(namespacedAttemptRefName("/x/source/run/worktrees/attempt-3", "run-orca-7")).toBe("refs/ccloop/run-orca-7/attempts/3");
    expect(() => namespacedAttemptRefName("/x/source/run/worktrees/scratch", "run-orca-7")).toThrow(/not an attempt worktree path/);
  });

  it("publishes the shared ref and, once registered, the run's own ref at the same commit", async () => {
    const { root, repo } = await repository();
    const runDir = join(root, "control-source", "run");
    const { worktreePath } = await createAttemptWorkspace(repo, runDir, 1);
    await writeFile(join(worktreePath, "a.txt"), "changed\n");
    registerAttemptRefNamespace(runDir, "run-orca-1");
    const published = await publishAttemptCommit(worktreePath);
    expect(await git(repo, "rev-parse", "refs/ccloop/run/attempts/1")).toBe(published.sha);
    expect(await git(repo, "rev-parse", "refs/ccloop/run-orca-1/attempts/1")).toBe(published.sha);
  });

  it("publishes only the shared ref for a run directory nobody registered", async () => {
    const { root, repo } = await repository();
    const runDir = join(root, "other-source", "run");
    const { worktreePath } = await createAttemptWorkspace(repo, runDir, 1);
    await publishAttemptCommit(worktreePath);
    expect((await git(repo, "for-each-ref", "--format=%(refname)", "refs/ccloop/")).split("\n")).toEqual(["refs/ccloop/run/attempts/1"]);
  });
});
