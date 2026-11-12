// Orca tester issue #277 (Orca session 7e164691, tester follow-up H): attempt commits land in the target repository's
// history, where `ccloop attempt: refs/ccloop/run/attempts/1` tells a reader of `git log` or `git blame` nothing. The
// subject is now the run's goal (loop-contract.json objective.goal) on one line, at most 72 characters, and the ref moves
// to an `Attempt-Ref:` trailer in the body. A run without a readable goal keeps today's subject (an existing criterion in
// worktreeManager.test.ts pins it), with the trailer added.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { ATTEMPT_SUBJECT_MAX, attemptCommitMessageArgs, createAttemptWorkspace, createExtraWorktree, publishAttemptCommit, publishExtraAttemptCommit } from "../../src/workspace/worktreeManager.js";
import { codexFixture } from "../runtime/codex/fixture.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const REF = "refs/ccloop/run/attempts/1";

async function world(goal?: string) {
  const root = await mkdtemp(join(tmpdir(), "ccloop-attempt-msg-")); dirs.push(root);
  const repo = join(root, "repo"), runDir = join(root, "run");
  await exec("git", ["init", repo]);
  await writeFile(join(repo, "a.txt"), "a\n");
  await exec("git", ["-c", "user.name=seed", "-c", "user.email=seed@invalid", "add", "a.txt"], { cwd: repo });
  await exec("git", ["-c", "user.name=seed", "-c", "user.email=seed@invalid", "commit", "-m", "init"], { cwd: repo });
  const { worktreePath } = await createAttemptWorkspace(repo, runDir, 1);
  if (goal !== undefined) await writeFile(join(runDir, "loop-contract.json"), JSON.stringify({ objective: { taskId: "t", goal, successCondition: "s" } }));
  return { repo, runDir, worktreePath };
}
const message = async (repo: string, sha: string) => ({
  subject: (await exec("git", ["log", "-1", "--format=%s", sha], { cwd: repo })).stdout.trim(),
  trailers: (await exec("git", ["log", "-1", "--format=%(trailers:only,unfold)", sha], { cwd: repo })).stdout.trim(),
});

describe("attemptCommitMessageArgs (#277)", () => {
  it("uses the goal as the subject and the ref as a trailer", () => {
    expect(attemptCommitMessageArgs(REF, "Add cycle-safe traversal")).toEqual(["-m", "Add cycle-safe traversal", "-m", `Attempt-Ref: ${REF}`]);
  });
  it("keeps a goal of exactly 72 characters and truncates a longer one to 72 with an ellipsis", () => {
    const exact = "x".repeat(ATTEMPT_SUBJECT_MAX);
    expect(attemptCommitMessageArgs(REF, exact)[1]).toBe(exact);
    const long = attemptCommitMessageArgs(REF, `${"界".repeat(70)} and more words`)[1]!;
    expect(ATTEMPT_SUBJECT_MAX).toBe(72);
    expect(Array.from(long)).toHaveLength(72);
    expect(long).toBe(`${"界".repeat(69)}...`);
  });
  it("puts a multi-line goal on one line", () => {
    expect(attemptCommitMessageArgs(REF, "  Fix the parser\n\nso that  it\r\nhandles tabs\t ")[1]).toBe("Fix the parser so that it handles tabs");
  });
  it("falls back to today's subject when there is no goal or it is blank", () => {
    for (const goal of [null, "", " \n "]) expect(attemptCommitMessageArgs(REF, goal)).toEqual(["-m", `ccloop attempt: ${REF}`, "-m", `Attempt-Ref: ${REF}`]);
  });
});

describe("attempt commits in the target repository (#277)", () => {
  it("publishAttemptCommit reads the run's goal and writes the trailer", async () => {
    const w = await world("Set answer.txt to 42\nand keep README");
    const published = await publishAttemptCommit(w.worktreePath);
    expect(await message(w.repo, published.sha)).toEqual({ subject: "Set answer.txt to 42 and keep README", trailers: `Attempt-Ref: ${published.ref}` });
  });

  it("publishAttemptCommit without a loop contract keeps today's subject, with the trailer", async () => {
    const w = await world();
    const published = await publishAttemptCommit(w.worktreePath);
    expect(await message(w.repo, published.sha)).toEqual({ subject: `ccloop attempt: ${published.ref}`, trailers: `Attempt-Ref: ${published.ref}` });
  });

  it("publishExtraAttemptCommit (multi-repo) uses the same goal and trailer", async () => {
    const w = await world("Update the second repository");
    const extra = await createExtraWorktree(w.repo, w.runDir, 1, "second");
    const published = await publishExtraAttemptCommit(extra.worktreePath, w.runDir, 1);
    expect(await message(w.repo, published.sha)).toEqual({ subject: "Update the second repository", trailers: `Attempt-Ref: ${published.ref}` });
  });

  it("a real run's attempt commit carries the contract's goal (runLoop over the codex adapter)", async () => {
    const f = await codexFixture("integration"); dirs.push(f.dir);
    await runLoop(f.contract, f.runDir, new CodexAdapter(f.config));
    const sha = (await exec("git", ["rev-parse", REF], { cwd: f.repo })).stdout.trim();
    expect(await message(f.repo, sha)).toEqual({ subject: "Set answer.txt to 42", trailers: `Attempt-Ref: ${REF}` });
  }, 60_000);
});
