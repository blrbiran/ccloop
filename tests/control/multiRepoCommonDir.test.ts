// Multi-repo runs, review I1 (Orca spec 2026-10-24-multi-dir-projects §11.1): two worktrees of one repository are one
// repository -- they share its git common directory -- so at accept each working repository must have a common
// directory of its own; a linked worktree of the primary (or of another extra) as an extra repoPath, and a repoPath that
// is not a git working tree, are control-request-invalid. A symlinked targetRepo is compared by its real path.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlRequest } from "../../src/control/protocol.js";
import { fixture } from "./optionalFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

async function world() {
  const { root, envelope } = await fixture(); roots.push(root);
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "ccloop-common-dir-"))); roots.push(elsewhere);
  for (const path of [root, join(elsewhere, "lib")]) {
    await mkdir(path, { recursive: true });
    git(path, "init", "-q");
    git(path, "-c", "user.name=t", "-c", "user.email=t@invalid", "commit", "-q", "--allow-empty", "-m", "init");
  }
  const withExtra = (repoPath: string, targetRepo = join(elsewhere, "target-lib")) => ({ ...envelope, work: { ...envelope.work,
    contract: { ...envelope.work.contract, context: { ...envelope.work.contract.context, repoKey: "app", additionalRepos: [{ key: "lib", repoPath, targetPaths: ["lib/**"] }] } },
    additionalRepos: [{ key: "lib", targetRepo, base: "main" }] } });
  return { root, elsewhere, withExtra };
}

describe("one repository per directory, by git common directory (review I1)", () => {
  it("accepts two separate repositories", async () => {
    const w = await world();
    expect(() => parseControlRequest("accept", w.withExtra(join(w.elsewhere, "lib")))).not.toThrow();
  });

  it("refuses a linked worktree of the primary repository as an extra repoPath", async () => {
    const w = await world();
    const linked = join(w.elsewhere, "linked");
    git(w.root, "worktree", "add", "-q", "--detach", linked);
    expect(() => parseControlRequest("accept", w.withExtra(linked))).toThrow("control-request-invalid");
  });

  it("refuses an extra repoPath that is not a git working tree", async () => {
    const w = await world();
    await mkdir(join(w.elsewhere, "plain"));
    expect(() => parseControlRequest("accept", w.withExtra(join(w.elsewhere, "plain")))).toThrow("control-request-invalid");
  });

  it("refuses an extra targetRepo that is a symlink to the primary target", async () => {
    const w = await world();
    await symlink(w.root, join(w.elsewhere, "alias"));
    expect(() => parseControlRequest("accept", w.withExtra(join(w.elsewhere, "lib"), join(w.elsewhere, "alias")))).toThrow("control-request-invalid");
  });
});
