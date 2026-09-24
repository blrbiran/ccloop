import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { materializeResultRepository } from "../../src/control/resultRepository.js";
import type { StartEnvelopeV1 } from "../../src/control/protocol.js";

// Orca execution driver (2026-09-25), ccloop changes C1 and C2. Additive criteria only (Rule 15):
// the existing `refs/ccloop/run/attempts/1` assertion in tests/control/endToEnd.test.ts is untouched.
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd })).stdout.trim();
}

/** A repository with two sibling commits, as two control runs sharing one target repository leave them. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-result-repo-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q");
  await writeFile(join(repo, "answer.txt"), "0\n");
  await git(repo, "add", "answer.txt");
  await git(repo, "commit", "-qm", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "answer.txt"), "mine\n");
  await git(repo, "commit", "-qam", "mine");
  const mine = await git(repo, "rev-parse", "HEAD");
  await git(repo, "checkout", "-q", "--detach", base);
  await writeFile(join(repo, "answer.txt"), "theirs\n");
  await git(repo, "commit", "-qam", "theirs");
  const theirs = await git(repo, "rev-parse", "HEAD");
  await git(repo, "checkout", "-q", "--detach", base);
  const sourceDir = join(root, "source");
  await mkdir(sourceDir, { mode: 0o700 });
  // Only the fields materializeResultRepository reads on the attempt>0, worktree-gone path.
  const envelope = {
    protocol: 1, claim: { runId: "run-mine" }, contractHash: "0".repeat(64), inputCheckpoint: null,
    work: { contract: { context: { repoPath: repo } }, targetRepo: repo, base, sourceDir },
  } as unknown as StartEnvelopeV1;
  return { repo, mine, theirs, sourceDir, envelope, runDir: join(sourceDir, "run") };
}

describe("the result repository a control run materializes (Orca execution driver C1/C2)", () => {
  it("C2 reads its own run's attempt ref, not the shared path-derived one a later run overwrote", async () => {
    const f = await fixture();
    await git(f.repo, "update-ref", "refs/ccloop/run-mine/attempts/1", f.mine);
    // Another control run in the same target repository published last under the shared name.
    await git(f.repo, "update-ref", "refs/ccloop/run/attempts/1", f.theirs);
    const destination = await materializeResultRepository(f.envelope, f.runDir, 1);
    expect(await git(destination, "rev-parse", "HEAD")).toBe(f.mine);
    expect((await exec("cat", [join(destination, "answer.txt")])).stdout).toBe("mine\n");
  });

  it("C1 shares the object store by hard links instead of copying it", async () => {
    const f = await fixture();
    await git(f.repo, "update-ref", "refs/ccloop/run-mine/attempts/1", f.mine);
    const destination = await materializeResultRepository(f.envelope, f.runDir, 1);
    // The commit object is loose in the source (nothing ran gc); a hard-linked clone gives the same
    // inode a second name, a copying clone gives it exactly one.
    const object = join(".git", "objects", f.mine.slice(0, 2), f.mine.slice(2));
    expect((await stat(join(destination, object))).nlink).toBeGreaterThanOrEqual(2);
    expect((await stat(join(destination, object))).ino).toBe((await stat(join(f.repo, object))).ino);
  });
});
