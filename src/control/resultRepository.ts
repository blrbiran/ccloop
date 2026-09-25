import { execFile } from "node:child_process";
import { access, cp, copyFile, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { namespacedAttemptRefName } from "../workspace/worktreeManager.js";
import type { StartEnvelopeV2 } from "./protocol.js";

const exec = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", repo, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
}

async function cloneAt(source: string, destination: string, revision: string): Promise<void> {
  await exec("git", ["clone", "--no-checkout", source, destination], {
    maxBuffer: 8 * 1024 * 1024,
  });
  await git(destination, "checkout", "--detach", revision);
}

async function copyLiveWorkspace(source: string, destination: string): Promise<void> {
  const head = await git(source, "rev-parse", "HEAD");
  await cloneAt(source, destination, head);
  for (const name of await readdir(destination)) {
    if (name !== ".git") await rm(join(destination, name), { recursive: true, force: true });
  }
  for (const name of await readdir(source)) {
    if (name !== ".git") {
      await cp(join(source, name), join(destination, name), {
        recursive: true,
        preserveTimestamps: true,
        dereference: false,
      });
    }
  }
  let sourceIndex = await git(source, "rev-parse", "--git-path", "index");
  if (!isAbsolute(sourceIndex)) sourceIndex = resolve(source, sourceIndex);
  let destinationGit = await git(destination, "rev-parse", "--git-dir");
  if (!isAbsolute(destinationGit)) destinationGit = resolve(destination, destinationGit);
  await copyFile(await realpath(sourceIndex), join(await realpath(destinationGit), "index"));
}

export async function materializeResultRepository(
  envelope: StartEnvelopeV2,
  runDir: string,
  currentAttempt: number,
): Promise<string> {
  const destination = join(envelope.work.sourceDir, "repo");
  if (await exists(destination)) {
    const stat = await lstat(destination);
    if (!stat.isDirectory()) throw new Error("control-result-repository-invalid");
    try {
      await git(destination, "rev-parse", "--git-dir");
      return destination;
    } catch {
      throw new Error("control-result-repository-invalid");
    }
  }
  await mkdir(envelope.work.sourceDir, { recursive: true, mode: 0o700 });
  if (currentAttempt > 0) {
    const attempt = join(runDir, "worktrees", `attempt-${currentAttempt}`);
    if (await exists(attempt)) {
      await copyLiveWorkspace(attempt, destination);
      return destination;
    }
    const ref = namespacedAttemptRefName(attempt, envelope.claim.runId);
    const sha = await git(envelope.work.contract.context.repoPath, "rev-parse", ref);
    await cloneAt(envelope.work.contract.context.repoPath, destination, sha);
    return destination;
  }
  await cloneAt(envelope.work.targetRepo, destination, envelope.work.base);
  return destination;
}
