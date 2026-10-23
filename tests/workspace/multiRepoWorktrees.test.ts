// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.2, §16.1 C3; reviews 7 and N4): attempt n makes one
// worktree per extra repository at <runDir>/dirs/attempt-<n>/<key>, from that repository's HEAD; worktrees/ holds only
// the primary's. After the run each repository holds the attempt ref (and the claim's namespaced ref) at a commit with
// exactly that worktree's change, commits.json lists every commit primary first, and no worktree or dirs/ is left.
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import type { AttemptContext, RuntimeAdapter } from "../../src/runtime/types.js";
import { registerAttemptRefNamespace } from "../../src/workspace/worktreeManager.js";
import { git, multiRepoWorld } from "../controller/multiRepoFixture.js";

const exists = (path: string) => stat(path).then(() => true, () => false);

describe("extra worktrees and attempt refs (C3)", () => {
  it("makes one worktree per extra repo under dirs/, pins each attempt in its own repo, and leaves nothing behind", async () => {
    const { primary, repos, contract } = await multiRepoWorld([{ key: "lib" }, { key: "docs" }]);
    const runDir = join(await mkdtemp(join(tmpdir(), "ccloop-run-")), "run-mr");
    registerAttemptRefNamespace(runDir, "claim-run-7");
    const seen: { worktrees?: string[]; extras?: AttemptContext["extraWorktrees"]; heads?: Record<string, string>; files?: Record<string, string[]> } = {};
    const adapter: RuntimeAdapter = {
      async plan() { return { summary: "s", primaryTargetPaths: [] }; },
      async execute(context) {
        seen.worktrees = await readdir(join(runDir, "worktrees"));
        seen.extras = context.extraWorktrees;
        seen.heads = {}; seen.files = {};
        for (const extra of context.extraWorktrees ?? []) {
          seen.heads[extra.key] = await git(extra.worktreePath, "rev-parse", "HEAD");
          seen.files[extra.key] = (await readdir(extra.worktreePath)).filter((name) => name !== ".git").sort();
          await mkdir(join(extra.worktreePath, extra.key), { recursive: true });
          await writeFile(join(extra.worktreePath, extra.key, "new.txt"), `${extra.key} change\n`);
        }
        await mkdir(join(context.worktreePath, "src"), { recursive: true });
        await writeFile(join(context.worktreePath, "src", "a.txt"), "a\n");
        return { changedFiles: ["src/a.txt"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
      },
      async verify() { throw new Error("command verifier"); },
    };
    const state = await runLoop(contract, runDir, adapter);
    expect(state.status).toBe("succeeded");

    expect(seen.worktrees).toEqual(["attempt-1"]);
    expect(seen.extras?.map(({ key, worktreePath }) => [key, worktreePath])).toEqual([
      ["lib", join(runDir, "dirs", "attempt-1", "lib")], ["docs", join(runDir, "dirs", "attempt-1", "docs")]]);
    for (const key of ["lib", "docs"]) {
      expect(seen.heads![key]).toBe(await git(repos[key]!, "rev-parse", "HEAD"));
      expect(seen.files![key]).toEqual([key]);
    }

    expect(await exists(join(runDir, "dirs", "attempt-1"))).toBe(false);
    expect(await exists(join(runDir, "dirs"))).toBe(false);
    const commits = JSON.parse(await readFile(join(runDir, "attempts", "1", "commits.json"), "utf8")) as Record<string, { sha: string; base: string; ref: string }>;
    expect(Object.keys(commits)).toEqual(["app", "lib", "docs"]);
    expect(((await stat(join(runDir, "attempts", "1", "commits.json"))).mode & 0o777)).toBe(0o600);
    const ref = `refs/ccloop/${basename(runDir)}/attempts/1`;
    for (const key of ["lib", "docs"]) {
      const repo = repos[key]!;
      const sha = await git(repo, "rev-parse", ref);
      expect(await git(repo, "rev-parse", "refs/ccloop/claim-run-7/attempts/1")).toBe(sha);
      expect(commits[key]).toEqual({ sha, base: await git(repo, "rev-parse", "HEAD"), ref });
      expect(await git(repo, "diff", "--name-only", `${sha}^`, sha)).toBe(`${key}/new.txt`);
      expect((await git(repo, "worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree ")).length).toBe(1);
    }
    expect(commits.app!.sha).toBe(await git(primary, "rev-parse", ref));
    expect(await git(primary, "diff", "--name-only", `${commits.app!.sha}^`, commits.app!.sha)).toBe("src/a.txt");
  }, 30_000);
});
