// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.6, §16.1 C8): each extra repository gets a result
// repository at <sourceDir>/repos/<key> holding that repository's attempt tree (a live copy of its extra worktree, or
// its attempt ref, or its target at base), and collect carries `dirs` in contract order with ccloop's observed
// changedPaths; a single-repo collect has no `dirs` key.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExecution } from "../../src/control/collect.js";
import { materializeExtraResultRepositories } from "../../src/control/resultRepository.js";
import type { LoopStartEnvelope } from "../../src/control/protocol.js";
import { cleanupAttemptWorkspace, createExtraWorktree, publishExtraAttemptCommit, registerAttemptRefNamespace } from "../../src/workspace/worktreeManager.js";
import { createKeyedRepo, git } from "../controller/multiRepoFixture.js";
import { fixture } from "./optionalFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function world() {
  const { root, envelope } = await fixture(); roots.push(root);
  const repos = { app: await createKeyedRepo("app"), lib: await createKeyedRepo("lib"), docs: await createKeyedRepo("docs") };
  roots.push(repos.app, repos.lib, repos.docs);
  const keys = ["lib", "docs"] as const;
  // The primary is a repository of its own, so a result repository made from it is told apart by its files.
  const contract = { ...envelope.work.contract, context: { ...envelope.work.contract.context, repoPath: repos.app, repoKey: "app",
    additionalRepos: keys.map((key) => ({ key, repoPath: repos[key], targetPaths: [`${key}/**`] })) } };
  const bases = { lib: await git(repos.lib, "rev-parse", "HEAD"), docs: await git(repos.docs, "rev-parse", "HEAD") };
  const work = { ...envelope.work, contract, additionalRepos: keys.map((key) => ({ key, targetRepo: repos[key], base: bases[key] })) };
  return { root, runDir: join(root, "run"), repos, envelope: { ...envelope, work } as LoopStartEnvelope };
}
const files = async (repo: string) => (await git(repo, "ls-files")).split("\n");

describe("extra result repositories (C8)", () => {
  it("copies a live extra worktree, takes an attempt ref when the worktree is gone, and clones the target at base before any attempt", async () => {
    const w = await world();
    registerAttemptRefNamespace(w.runDir, w.envelope.claim.runId);
    const lib = await createExtraWorktree(w.repos.lib, w.runDir, 1, "lib");
    await writeFile(join(lib.worktreePath, "lib", "live.txt"), "live\n");
    const docs = await createExtraWorktree(w.repos.docs, w.runDir, 1, "docs");
    await writeFile(join(docs.worktreePath, "docs", "pinned.txt"), "pinned\n");
    await publishExtraAttemptCommit(docs.worktreePath, w.runDir, 1);
    await cleanupAttemptWorkspace(w.repos.docs, docs.worktreePath);

    await materializeExtraResultRepositories(w.envelope, w.runDir, 1);
    expect(await readFile(join(w.root, "repos", "lib", "lib", "live.txt"), "utf8")).toBe("live\n");
    expect(await readFile(join(w.root, "repos", "lib", "lib", "lib.txt"), "utf8")).toBe("lib\n");
    expect(await files(join(w.root, "repos", "docs"))).toEqual(["docs/docs.txt", "docs/pinned.txt"]);

    const fresh = await world();
    await materializeExtraResultRepositories(fresh.envelope, fresh.runDir, 0);
    expect(await files(join(fresh.root, "repos", "lib"))).toEqual(["lib/lib.txt"]);
    expect(await git(join(fresh.root, "repos", "docs"), "rev-parse", "HEAD")).toBe(await git(fresh.repos.docs, "rev-parse", "HEAD"));
  }, 30_000);

  it("collect carries dirs in contract order with the observed changedPaths; a single-repo collect has no dirs", async () => {
    const w = await world();
    await mkdir(join(w.runDir, "attempts", "1"), { recursive: true });
    await writeFile(join(w.runDir, "loop-state.json"), JSON.stringify({ status: "executing", currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-10-24T00:00:00Z",
      waitingOnHuman: false, stopReason: null, budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 10, tokenBudgetRemaining: 10 }, recentFailures: [] }), { mode: 0o600 });
    expect((await collectExecution(w.envelope, 0)).dirs).toEqual([
      { key: "lib", resultRepo: "repos/lib", changedPaths: [], attemptSha: null }, { key: "docs", resultRepo: "repos/docs", changedPaths: [], attemptSha: null }]);
    await writeFile(join(w.runDir, "attempts", "1", "dirs.json"), JSON.stringify([{ key: "lib", changedPaths: ["lib/a.txt"] }, { key: "docs", changedPaths: ["docs/b.txt", "docs/c.txt"] }]), { mode: 0o600 });
    expect((await collectExecution(w.envelope, 0)).dirs).toEqual([
      { key: "lib", resultRepo: "repos/lib", changedPaths: ["lib/a.txt"], attemptSha: null }, { key: "docs", resultRepo: "repos/docs", changedPaths: ["docs/b.txt", "docs/c.txt"], attemptSha: null }]);
    // Review M7 (Orca spec §7.3): each repository's attempt commit, from the attempt's commits.json once it is published.
    await writeFile(join(w.runDir, "attempts", "1", "commits.json"), JSON.stringify({ app: { sha: "a".repeat(40), base: "b", ref: "r" }, lib: { sha: "1".repeat(40), base: "b", ref: "r" } }), { mode: 0o600 });
    expect((await collectExecution(w.envelope, 0)).dirs!.map((dir) => dir.attemptSha)).toEqual(["1".repeat(40), null]);

    const { root, envelope } = await fixture(); roots.push(root);
    await mkdir(join(root, "run"));
    await writeFile(join(root, "run", "loop-state.json"), await readFile(join(w.runDir, "loop-state.json")), { mode: 0o600 });
    expect(Object.keys(await collectExecution(envelope, 0))).not.toContain("dirs");
  }, 30_000);
});
