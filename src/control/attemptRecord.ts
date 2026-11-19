import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, readFile, readdir, rm } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { appendEvent } from "../persistence/fileStore.js";
import { codexSkillsPendingPath } from "../runtime/codex/codexSkills.js";
import {
  ATTEMPT_IDENTITY, attemptCommitMessageArgs, attemptRefName, cleanupAttemptWorkspace, extraWorktreePath, namespacedAttemptRefName,
  removeEmptyExtraDirs, runGoal,
} from "../workspace/worktreeManager.js";
import { atomicReplacePrivateFile, readPrivateFile } from "./paths.js";
import type { LoopStartEnvelope } from "./protocol.js";

/**
 * Change-sized runs P1 (Orca spec 2026-11-19-change-sized-runs-design.md §5.2, §6.1; Orca #363 #366). Under the envelope key
 * `work.attemptDelivery: "ref-v1"` the control worker (and `settle-lost-worker`) records how the run's current attempt ended as
 * a commit pinned by the attempt refs, instead of materializing <sourceDir>/repo. A live worktree (kept at a handoff boundary,
 * an allowance park, a human block, or after a failed removal) is recorded with a temporary index, so its own index and HEAD
 * are never touched, and is then removed. collect answers the record as its top-level `attempt`.
 */
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const attemptRecordSchema = z.union([
  z.object({ attempt: safe.refine((n) => n >= 1), sha: oid, base: oid, tree: oid, ref: z.string().regex(/^refs\/ccloop\/[^/]+\/attempts\/\d+$/), head: oid,
    capture: z.enum(["published", "live"]), worktree: z.enum(["removed", "retained"]) }).strict(),
  z.object({ attempt: safe, sha: z.null(), reason: z.enum(["not-started", "skills-cleanup-pending", "record-failed"]), detail: z.string().max(512).optional() }).strict(),
]);
export type AttemptRecordV1 = z.infer<typeof attemptRecordSchema>;

const exec = promisify(execFile);
const RECORD_FILE = "attempt-record.json";
const DETAIL_MAX = 512;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return (await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, ...(env === undefined ? {} : { env }) })).stdout.trim();
}
/** `git update-ref --stdin`: every ref is set in one transaction, so a failure leaves none of them moved (review minor). */
function updateRefs(cwd: string, refs: string[], sha: string): Promise<void> {
  return new Promise((done, failed) => {
    const child = execFile("git", ["update-ref", "--stdin"], { cwd }, (error) => (error === null ? done() : failed(error)));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(refs.map((ref) => `update ${ref} ${sha}\n`).join(""));
  });
}
async function revParseOptional(cwd: string, name: string): Promise<string | null> {
  try { return await git(cwd, ["rev-parse", "-q", "--verify", `${name}^{commit}`]); } catch { return null; }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function detailOf(error: unknown): string {
  return Array.from(error instanceof Error ? error.message : String(error)).slice(0, DETAIL_MAX).join("");
}

/**
 * Commits a live worktree's content -- tracked changes and untracked non-ignored files (`add -A` honours .gitignore) -- on top
 * of its HEAD without touching its index or HEAD: the index is copied to <runDir>/attempt-record.index (0600) and staged there
 * (spec Appendix A check 7). Every ref in `refs` is set to the commit, then read back with its tree. The temp index is removed.
 */
export async function recordLiveWorktree(worktree: string, runDir: string, refs: string[], messageRef: string): Promise<{ sha: string; base: string; tree: string }> {
  const temp = join(runDir, "attempt-record.index");
  let index = await git(worktree, ["rev-parse", "--git-path", "index"]);
  if (!isAbsolute(index)) index = resolve(worktree, index);
  await rm(temp, { force: true });
  try {
    await copyFile(index, temp);
    await chmod(temp, 0o600);
    const env = { ...process.env, GIT_INDEX_FILE: temp };
    const base = await git(worktree, ["rev-parse", "HEAD"]);
    await git(worktree, ["add", "-A"], env);
    const tree = await git(worktree, ["write-tree"], env);
    const sha = await git(worktree, [...ATTEMPT_IDENTITY, "commit-tree", tree, "-p", base, ...attemptCommitMessageArgs(messageRef, await runGoal(runDir))]);
    await updateRefs(worktree, refs, sha);
    for (const ref of refs) if (await git(worktree, ["rev-parse", ref]) !== sha) throw new Error(`attempt-ref-mismatch: ${ref}`);
    if (await git(worktree, ["rev-parse", `${sha}^{tree}`]) !== tree) throw new Error("attempt-tree-mismatch");
    return { sha, base, tree };
  } finally {
    await rm(temp, { force: true });
  }
}

type Recorded = { sha: string; base: string; tree: string; head: string; capture: "published" | "live" };

/** A worktree whose HEAD is already the attempt ref is a published attempt whose removal failed; anything else is live. */
async function recordWorktree(repo: string, worktree: string, runDir: string, refs: string[], messageRef: string): Promise<Recorded> {
  const head = await git(worktree, ["rev-parse", "HEAD"]);
  if (await revParseOptional(repo, refs.at(-1)!) === head) {
    return { sha: head, base: await git(repo, ["rev-parse", `${head}^`]), tree: await git(repo, ["rev-parse", `${head}^{tree}`]), head, capture: "published" };
  }
  const recorded = await recordLiveWorktree(worktree, runDir, refs, messageRef);
  return { ...recorded, head, capture: "live" };
}

async function writeRecord(sourceDir: string, runDir: string, record: AttemptRecordV1): Promise<AttemptRecordV1> {
  await atomicReplacePrivateFile(sourceDir, join(runDir, RECORD_FILE), Buffer.from(JSON.stringify(attemptRecordSchema.parse(record))));
  return record;
}

/** The record the worker wrote, or null when there is none; a record that does not parse is an Error. */
export async function readAttemptRecord(sourceDir: string): Promise<AttemptRecordV1 | null> {
  let bytes: Buffer;
  try { bytes = await readPrivateFile(sourceDir, join(sourceDir, "run", RECORD_FILE)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return attemptRecordSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/**
 * Spec §5.2.2: records the current attempt's end, removes its worktree (and every older published leftover whose ref equals
 * its HEAD), and records each extra repository's worktree into run/attempts/<n>/commits.json. Never throws (it runs in the
 * worker's lease-release hook; review minor): a recording failure is the record `record-failed` (with an
 * `attempt_record_failed` event) and the worktree stays; a record that cannot even be written is still returned, and collect
 * then reports `record-failed` (attempt-record-missing). Idempotent: a record already written for this attempt whose ref
 * still holds its sha is kept, and only the removal is retried.
 */
export async function recordAttemptEnd(envelope: LoopStartEnvelope, runDir: string, currentAttempt: number): Promise<AttemptRecordV1> {
  const event = (type: string, detail: string) => appendEvent(runDir, { type, at: new Date().toISOString(), detail }).catch(() => undefined);
  try {
    return await recordAttemptEndOrThrow(envelope, runDir, currentAttempt, event);
  } catch (error) {
    await event("attempt_record_failed", `attempt-${currentAttempt}: ${detailOf(error)}`);
    const record: AttemptRecordV1 = { attempt: Math.max(0, currentAttempt), sha: null, reason: "record-failed", detail: detailOf(error) };
    return writeRecord(envelope.work.sourceDir, runDir, record).catch(() => record);
  }
}

/** Review minor: a current attempt with no worktree, no ref and no failed publish never had anything to record. */
async function publishFailed(runDir: string): Promise<boolean> {
  let text: string;
  try { text = await readFile(join(runDir, "events.jsonl"), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return text.split("\n").some((line) => { try { return (JSON.parse(line) as { type?: unknown }).type === "attempt_commit_publish_failed"; } catch { return false; } });
}

async function recordAttemptEndOrThrow(envelope: LoopStartEnvelope, runDir: string, currentAttempt: number, event: (type: string, detail: string) => Promise<unknown>): Promise<AttemptRecordV1> {
  const sourceDir = envelope.work.sourceDir, repo = envelope.work.contract.context.repoPath, runId = envelope.claim.runId;
  if (currentAttempt < 1) return writeRecord(sourceDir, runDir, { attempt: currentAttempt, sha: null, reason: "not-started" });
  const worktree = join(runDir, "worktrees", `attempt-${currentAttempt}`);
  const ref = namespacedAttemptRefName(worktree, runId);
  let record: AttemptRecordV1;
  if (await exists(codexSkillsPendingPath(worktree))) {
    // Spec §5.2.2: nothing is published while skills cleanup is pending, as the base-only result repository did before --
    // the extra repositories' worktrees included (review minor): they are neither recorded nor removed.
    record = await writeRecord(sourceDir, runDir, { attempt: currentAttempt, sha: null, reason: "skills-cleanup-pending" });
    await removeOlderPublished(repo, runDir, runId, currentAttempt, event).catch((error) => event("workspace_cleanup_failed", `attempt record: ${detailOf(error)}`));
    return record;
  } else {
    let prior: AttemptRecordV1 | null = null;
    try { prior = await readAttemptRecord(sourceDir); } catch { prior = null; }
    const live = await exists(worktree);
    try {
      let recorded: Recorded;
      if (prior !== null && prior.sha !== null && prior.attempt === currentAttempt && await revParseOptional(repo, ref) === prior.sha) {
        recorded = prior;
      } else if (live) {
        recorded = await recordWorktree(repo, worktree, runDir, [attemptRefName(worktree), ref], attemptRefName(worktree));
      } else {
        const sha = await revParseOptional(repo, ref);
        if (sha === null && !(await publishFailed(runDir))) return writeRecord(sourceDir, runDir, { attempt: currentAttempt, sha: null, reason: "not-started" });
        if (sha === null) throw new Error(`attempt-ref-missing: ${ref}`);
        recorded = { sha, base: await git(repo, ["rev-parse", `${sha}^`]), tree: await git(repo, ["rev-parse", `${sha}^{tree}`]), head: sha, capture: "published" };
      }
      const { sha, base, tree, head, capture } = recorded;
      record = await writeRecord(sourceDir, runDir, { attempt: currentAttempt, sha, base, tree, ref, head, capture, worktree: live ? "retained" : "removed" });
    } catch (error) {
      await event("attempt_record_failed", `attempt-${currentAttempt}: ${detailOf(error)}`);
      const failed: AttemptRecordV1 = { attempt: currentAttempt, sha: null, reason: "record-failed", detail: detailOf(error) };
      return writeRecord(sourceDir, runDir, failed).catch(() => failed);
    }
    if (live) {
      try {
        await cleanupAttemptWorkspace(repo, worktree);
        record = await writeRecord(sourceDir, runDir, { ...record, worktree: "removed" } as AttemptRecordV1);
      } catch (error) {
        await event("workspace_cleanup_failed", `attempt record: attempt-${currentAttempt}: ${detailOf(error)}`);
      }
    }
  }
  // Review minor: past the record these are cleanup; a failure is an event, never a throw, and the record stands.
  await removeOlderPublished(repo, runDir, runId, currentAttempt, event).catch((error) => event("workspace_cleanup_failed", `attempt record: ${detailOf(error)}`));
  await recordExtras(envelope, runDir, currentAttempt, record, event).catch((error) => event("attempt_record_failed", `attempt-${currentAttempt}: extras: ${detailOf(error)}`));
  return record;
}

/** Review minor 7: an older attempt's worktree is a published attempt whose removal failed; removed iff its ref equals its HEAD. */
async function removeOlderPublished(repo: string, runDir: string, runId: string, currentAttempt: number, event: (type: string, detail: string) => Promise<unknown>): Promise<void> {
  let names: string[] = [];
  try { names = await readdir(join(runDir, "worktrees")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const name of names) {
    const match = /^attempt-(\d+)$/.exec(name);
    if (match === null || Number(match[1]) >= currentAttempt) continue;
    const worktree = join(runDir, "worktrees", name);
    try {
      const head = await git(worktree, ["rev-parse", "HEAD"]);
      if (await revParseOptional(repo, namespacedAttemptRefName(worktree, runId)) !== head) throw new Error("not published at its HEAD");
      await cleanupAttemptWorkspace(repo, worktree);
    } catch (error) {
      await event("workspace_cleanup_failed", `attempt record: ${name} retained: ${detailOf(error)}`);
    }
  }
}

/** Spec §5.2.2 extras: the same per <runDir>/dirs/attempt-<n>/<key>, merged into run/attempts/<n>/commits.json (collect reads it). */
async function recordExtras(envelope: LoopStartEnvelope, runDir: string, attempt: number, primary: AttemptRecordV1, event: (type: string, detail: string) => Promise<unknown>): Promise<void> {
  const context = envelope.work.contract.context;
  if (context.additionalRepos === undefined || attempt < 1) return;
  const sourceDir = envelope.work.sourceDir, file = join(runDir, "attempts", String(attempt), "commits.json");
  let commits: Record<string, unknown> = {};
  try { commits = JSON.parse((await readPrivateFile(sourceDir, file)).toString("utf8")) as Record<string, unknown>; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const merged: Record<string, unknown> = primary.sha !== null && context.repoKey !== undefined && commits[context.repoKey] === undefined
    ? { [context.repoKey]: { sha: primary.sha, base: primary.base, ref: primary.ref } } : {};
  Object.assign(merged, commits);
  let changed = Object.keys(merged).length !== Object.keys(commits).length;
  const shared = `refs/ccloop/${basename(runDir)}/attempts/${attempt}`, own = `refs/ccloop/${envelope.claim.runId}/attempts/${attempt}`;
  for (const extra of context.additionalRepos) {
    const worktree = extraWorktreePath(runDir, attempt, extra.key);
    if (!(await exists(worktree))) continue;
    try {
      const recorded = await recordWorktree(extra.repoPath, worktree, runDir, [shared, own], shared);
      merged[extra.key] = { sha: recorded.sha, base: recorded.base, ref: shared };
      changed = true;
    } catch (error) {
      await event("attempt_record_failed", `attempt-${attempt}: ${extra.key}: ${detailOf(error)}`);
      continue;
    }
    try { await cleanupAttemptWorkspace(extra.repoPath, worktree); } catch (error) {
      await event("workspace_cleanup_failed", `attempt record: ${extra.key}: ${detailOf(error)}`);
    }
  }
  if (changed) await atomicReplacePrivateFile(sourceDir, file, Buffer.from(JSON.stringify(merged, null, 2)));
  await removeEmptyExtraDirs(runDir, attempt).catch(() => undefined);
}
