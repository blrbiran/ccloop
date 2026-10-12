import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 16 * 1024 * 1024;

/** Digest tracked changes and untracked file bytes without writing to the target repository. */
export async function worktreeSnapshot(root: string): Promise<string> {
  const hash = createHash("sha256");
  const { stdout: diff } = await execFileAsync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: OUTPUT_LIMIT });
  hash.update(diff);
  const { stdout: other } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: OUTPUT_LIMIT });
  const paths = other.split("\0").filter(Boolean).sort();
  for (const path of paths) {
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("omp-worktree-path-invalid");
    const metadata = await lstat(target);
    hash.update(`${path}\0${metadata.mode}\0`);
    if (metadata.isSymbolicLink()) hash.update(await readlink(target));
    else if (metadata.isFile()) for await (const chunk of createReadStream(target)) hash.update(chunk);
    else hash.update("special");
  }
  return hash.digest("hex");
}

/** Actual Git-visible paths after execute; the agent's `changedFiles` is never the authority for this list. */
export async function observedChangedPaths(root: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    execFileAsync("git", ["diff", "--name-only", "--no-renames", "-z", "HEAD"], { cwd: root, maxBuffer: OUTPUT_LIMIT }),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: OUTPUT_LIMIT }),
  ]);
  return [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean))].sort();
}
