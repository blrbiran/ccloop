// Change-sized runs P1 (Orca spec 2026-11-19-change-sized-runs-design.md §5.2.2, criteria P1-1, P1-4, P1-5; Orca #363 #366):
// under work.attemptDelivery the worker records the attempt's end as a commit pinned by both attempt refs. Why it matters:
// Orca stops copying the repository and takes this commit as the run's result, so (a) a kept live worktree must be
// captured exactly as the agent left it, minus ignored files, without disturbing the worktree's own index or HEAD; (b) a
// failure must be named in the record, never thrown, because the worker is releasing its lease; (c) leftovers are removed
// only when their content is provably pinned by a ref.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readAttemptRecord, recordAttemptEnd, recordLiveWorktree } from "../../src/control/attemptRecord.js";
import type { LoopStartEnvelope } from "../../src/control/protocol.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd })).stdout.trim();
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-attempt-record-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q");
  await writeFile(join(repo, "answer.txt"), "0\n");
  await writeFile(join(repo, "staged.txt"), "s0\n");
  await git(repo, "add", "answer.txt", "staged.txt");
  await git(repo, "commit", "-qm", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  const sourceDir = join(root, "source");
  await mkdir(join(sourceDir, "run"), { recursive: true, mode: 0o700 });
  const envelope = {
    protocol: 4, claim: { runId: "run-mine" }, contractHash: "0".repeat(64), inputCheckpoint: null,
    work: { kind: "loop", contract: { context: { repoPath: repo } }, targetRepo: repo, base, sourceDir, attemptDelivery: "ref-v1" },
  } as unknown as LoopStartEnvelope;
  return { repo, base, sourceDir, runDir: join(sourceDir, "run"), envelope };
}

/** A live attempt worktree as an agent leaves it: a tracked edit, a staged edit, an untracked file and an ignored one. */
async function liveWorktree(f: Awaited<ReturnType<typeof fixture>>, attempt = 1): Promise<string> {
  const worktree = join(f.runDir, "worktrees", `attempt-${attempt}`);
  await mkdir(join(f.runDir, "worktrees"), { recursive: true });
  await git(f.repo, "worktree", "add", "-q", "--detach", worktree, f.base);
  await writeFile(join(worktree, "answer.txt"), "42\n");
  await writeFile(join(worktree, "staged.txt"), "s1\n");
  await git(worktree, "add", "staged.txt");
  await writeFile(join(worktree, "untracked.txt"), "u\n");
  await writeFile(join(worktree, ".gitignore"), "x.log\n");
  await writeFile(join(worktree, "x.log"), "ignored\n");
  return worktree;
}

async function treePaths(repo: string, sha: string): Promise<string[]> {
  return (await git(repo, "ls-tree", "-r", "--name-only", sha)).split("\n").filter(Boolean).sort();
}

describe("recording a live attempt worktree (P1-1)", () => {
  it("commits the worktree's content on its HEAD without changing its index bytes or HEAD", async () => {
    const f = await fixture();
    const worktree = await liveWorktree(f);
    const indexPath = join(f.repo, ".git", "worktrees", "attempt-1", "index");
    const indexBefore = await readFile(indexPath);
    const statusBefore = await git(worktree, "status", "--porcelain");
    const refs = ["refs/ccloop/run/attempts/1", "refs/ccloop/run-mine/attempts/1"];
    const recorded = await recordLiveWorktree(worktree, f.runDir, refs, refs[0]!);
    // Measured directly: the worktree's own index file and HEAD are what they were.
    expect((await readFile(indexPath)).equals(indexBefore)).toBe(true);
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(f.base);
    expect(await git(worktree, "status", "--porcelain")).toBe(statusBefore);
    expect(recorded.base).toBe(f.base);
    expect(await git(f.repo, "rev-parse", `${recorded.sha}^`)).toBe(f.base);
    expect(await git(f.repo, "rev-parse", `${recorded.sha}^{tree}`)).toBe(recorded.tree);
    expect(await treePaths(f.repo, recorded.sha)).toEqual([".gitignore", "answer.txt", "staged.txt", "untracked.txt"]);
    expect(await git(f.repo, "show", `${recorded.sha}:answer.txt`)).toBe("42");
    for (const ref of refs) expect(await git(f.repo, "rev-parse", ref)).toBe(recorded.sha);
    expect(existsSync(join(f.runDir, "attempt-record.index"))).toBe(false);
  });

  it("recordAttemptEnd records a kept worktree as live (head = its start), sets both refs and removes it", async () => {
    const f = await fixture();
    const worktree = await liveWorktree(f);
    const record = await recordAttemptEnd(f.envelope, f.runDir, 1);
    expect(record).toMatchObject({ attempt: 1, base: f.base, head: f.base, capture: "live", worktree: "removed", ref: "refs/ccloop/run-mine/attempts/1" });
    if (record.sha === null) throw new Error("no sha");
    expect(existsSync(worktree)).toBe(false);
    expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain("attempt-1");
    expect(await git(f.repo, "rev-parse", "refs/ccloop/run-mine/attempts/1")).toBe(record.sha);
    expect(await git(f.repo, "rev-parse", "refs/ccloop/run/attempts/1")).toBe(record.sha);
    expect(await treePaths(f.repo, record.sha)).not.toContain("x.log");
    expect(await readAttemptRecord(f.sourceDir)).toEqual(record);
    expect((await stat(join(f.runDir, "attempt-record.json"))).mode & 0o777).toBe(0o600);
    // Idempotent: a second settle keeps the same commit and makes no other.
    expect(await recordAttemptEnd(f.envelope, f.runDir, 1)).toEqual(record);
  });
});

describe("the other ends of an attempt", () => {
  it("a published attempt (worktree gone) is read from its ref; a retained published worktree makes no new commit", async () => {
    const f = await fixture();
    const worktree = await liveWorktree(f, 2);
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "-qm", "published");
    const sha = await git(worktree, "rev-parse", "HEAD");
    await git(f.repo, "update-ref", "refs/ccloop/run-mine/attempts/2", sha);
    const record = await recordAttemptEnd(f.envelope, f.runDir, 2);
    expect(record).toEqual({ attempt: 2, sha, base: f.base, tree: await git(f.repo, "rev-parse", `${sha}^{tree}`), ref: "refs/ccloop/run-mine/attempts/2",
      head: sha, capture: "published", worktree: "removed" });
    expect(existsSync(worktree)).toBe(false);
    expect(await git(f.repo, "rev-parse", "refs/ccloop/run-mine/attempts/2")).toBe(sha);
  });

  it("no attempt is not-started; pending skills cleanup is named and publishes nothing", async () => {
    const f = await fixture();
    expect(await recordAttemptEnd(f.envelope, f.runDir, 0)).toEqual({ attempt: 0, sha: null, reason: "not-started" });
    const worktree = await liveWorktree(f);
    await writeFile(`${worktree}.codex-skills-pending`, "snapshot");
    expect(await recordAttemptEnd(f.envelope, f.runDir, 1)).toEqual({ attempt: 1, sha: null, reason: "skills-cleanup-pending" });
    expect(existsSync(worktree)).toBe(true);
    await expect(git(f.repo, "rev-parse", "-q", "--verify", "refs/ccloop/run-mine/attempts/1")).rejects.toBeDefined();
  });

  it("P1-4: a recording that fails is the record record-failed with an event, never a throw, and the worktree stays", async () => {
    const f = await fixture();
    const worktree = await liveWorktree(f);
    // A held ref lock makes update-ref fail, as a concurrent git in the person's repository would.
    await mkdir(join(f.repo, ".git", "refs", "ccloop", "run", "attempts"), { recursive: true });
    await writeFile(join(f.repo, ".git", "refs", "ccloop", "run", "attempts", "1.lock"), "");
    const record = await recordAttemptEnd(f.envelope, f.runDir, 1);
    expect(record).toMatchObject({ attempt: 1, sha: null, reason: "record-failed" });
    expect((record as { detail?: string }).detail).toMatch(/lock/);
    expect(existsSync(worktree)).toBe(true);
    const events = (await readFile(join(f.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["attempt_record_failed"]);
    expect(await readAttemptRecord(f.sourceDir)).toEqual(record);
  });

  it("P1-5: an older worktree whose ref equals its HEAD is removed; one whose ref does not is left and reported retained", async () => {
    const f = await fixture();
    const published = await liveWorktree(f, 1);
    await git(published, "add", "-A");
    await git(published, "commit", "-qm", "attempt 1");
    await git(f.repo, "update-ref", "refs/ccloop/run-mine/attempts/1", await git(published, "rev-parse", "HEAD"));
    const unpinned = await liveWorktree(f, 2);
    const current = await git(f.repo, "commit-tree", "-p", f.base, "-m", "attempt 3", `${f.base}^{tree}`);
    await git(f.repo, "update-ref", "refs/ccloop/run-mine/attempts/3", current);
    const record = await recordAttemptEnd(f.envelope, f.runDir, 3);
    expect(record).toMatchObject({ attempt: 3, sha: current, capture: "published", worktree: "removed" });
    expect(existsSync(published)).toBe(false);
    expect(existsSync(unpinned)).toBe(true);
    expect(await readFile(join(unpinned, "answer.txt"), "utf8")).toBe("42\n");
    const events = (await readFile(join(f.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "workspace_cleanup_failed", detail: expect.stringContaining("attempt-2 retained") });
  });
});
