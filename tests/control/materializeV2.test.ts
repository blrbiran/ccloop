// Change-sized runs P1 (Orca spec 2026-11-19-change-sized-runs-design.md §5.5.3, criterion P1-6; Orca #363 #366): a
// continuation from an Orca snapshot v2 -- a commit pinned at refs/orca/runs/<predecessor> plus a range bundle
// <base>..<ref> -- materializes the predecessor's attempt with one worktree add instead of rewriting the tree file by file.
// Why it matters: the next run must start from exactly what the predecessor left: for a live capture HEAD stays the
// attempt's start and the attempt is the dirty tree (v1 restored the same), for a published one HEAD is the attempt.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeFirstWorkspace } from "../../src/control/materialize.js";
import type { InputCheckpointV1 } from "../../src/control/protocol.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).toString().trim();
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const artifact = (bytes: Buffer) => ({ artifactId: `sha256-${sha256(bytes)}`, hash: sha256(bytes) });

type Source = "ccloop-live" | "ccloop-published";
async function world(source: Source, tamper: (snapshot: Record<string, unknown>) => void = () => undefined) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-materialize-v2-")));
  roots.push(root);
  const target = join(root, "target"), producer = join(root, "producer"), repoPath = join(root, "c1"), sourceDir = join(root, "new-source"), runDir = join(sourceDir, "run");
  await mkdir(target); await mkdir(runDir, { recursive: true, mode: 0o700 });
  git(target, "init", "-q");
  await writeFile(join(target, "answer.txt"), "0\n"); await writeFile(join(target, "gone.txt"), "x\n");
  git(target, "add", "."); git(target, "commit", "-qm", "base");
  const base = git(target, "rev-parse", "HEAD");
  // The predecessor's attempt, made where Orca made it (a handle on the target), then pinned and bundled as a range.
  execFileSync("git", ["clone", "-q", "--local", target, producer]);
  await writeFile(join(producer, "answer.txt"), "42\n"); await writeFile(join(producer, "new.txt"), "n\n");
  git(producer, "rm", "-q", "gone.txt"); git(producer, "add", "-A"); git(producer, "commit", "-qm", "attempt");
  const attempt = git(producer, "rev-parse", "HEAD");
  git(producer, "update-ref", "refs/orca/runs/run-pred", attempt);
  const bundleFile = join(root, "range.bundle");
  git(producer, "bundle", "create", "-q", bundleFile, `${base}..refs/orca/runs/run-pred`);
  // A later commit in the target: the continuation's C1 is a no-checkout clone with HEAD put back at base (Orca P0).
  await writeFile(join(target, "answer.txt"), "later\n"); git(target, "commit", "-qam", "later");
  execFileSync("git", ["clone", "-q", "--local", "--no-checkout", target, repoPath]);
  git(repoPath, "update-ref", "--no-deref", "HEAD", base);

  const bundleBytes = await readFile(bundleFile), bundleRef = artifact(bundleBytes);
  const snapshot: Record<string, unknown> = { version: 2, objectFormat: "sha1", base, attempt, tree: git(producer, "rev-parse", `${attempt}^{tree}`),
    head: source === "ccloop-live" ? base : attempt, ref: "refs/orca/runs/run-pred", source, bundle: bundleRef, missing: [] };
  tamper(snapshot);
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot)), snapshotRef = artifact(snapshotBytes);
  const checkpointBytes = Buffer.from(JSON.stringify({ checkpointId: "cp1", snapshot: snapshotRef }));
  const checkpointRef = { artifactId: `checkpoint-cp1-${sha256(checkpointBytes)}`, hash: sha256(checkpointBytes) };
  const bundlePath = join(sourceDir, "input", "cp1");
  await mkdir(join(bundlePath, "artifacts"), { recursive: true, mode: 0o700 });
  await writeFile(join(bundlePath, "checkpoint.json"), checkpointBytes, { mode: 0o600 });
  const artifacts = [{ ref: checkpointRef, file: "checkpoint.json" }];
  for (const [ref, bytes] of [[bundleRef, bundleBytes], [snapshotRef, snapshotBytes]] as const) {
    const file = `artifacts/${ref.artifactId}.bin`; await writeFile(join(bundlePath, file), bytes, { mode: 0o600 }); artifacts.push({ ref, file });
  }
  const manifest = { protocol: 1, predecessorRunId: "run-pred", checkpointId: "cp1", checkpointHash: checkpointRef.hash, checkpoint: checkpointRef,
    snapshot: snapshotRef, artifacts, unfinished: [], pendingDecisions: [], awaitingHuman: [] };
  await writeFile(join(bundlePath, "resume-bundle.json"), JSON.stringify(manifest), { mode: 0o600 });
  const input: InputCheckpointV1 = { predecessorRunId: "run-pred", checkpointId: "cp1", checkpointHash: checkpointRef.hash, bundlePath };
  return { base, attempt, repoPath, runDir, input, snapshot };
}

describe("continuation from snapshot v2 (P1-6)", () => {
  it("a live capture comes back with HEAD at its start and the attempt as the dirty tree", async () => {
    const w = await world("ccloop-live");
    const { worktreePath } = await materializeFirstWorkspace(w.repoPath, w.runDir, 1, w.input);
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(w.base);
    expect(git(worktreePath, "status", "--porcelain", "--untracked-files=all").split("\n").map((line) => line.trim()).sort()).toEqual(["?? new.txt", "D gone.txt", "M answer.txt"]);
    expect(await readFile(join(worktreePath, "answer.txt"), "utf8")).toBe("42\n");
    // The pin itself is never written into repoPath: the fetch has no destination.
    expect(() => git(w.repoPath, "rev-parse", "-q", "--verify", "refs/orca/runs/run-pred")).toThrow();
  });

  it("a published capture comes back with HEAD at the attempt and a clean tree", async () => {
    const w = await world("ccloop-published");
    const { worktreePath } = await materializeFirstWorkspace(w.repoPath, w.runDir, 1, w.input);
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(w.attempt);
    expect(git(worktreePath, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(existsSync(join(worktreePath, "gone.txt"))).toBe(false);
  });

  it("a snapshot whose tree is not the attempt's, or whose head is neither the attempt nor its parent, is refused and leaves no worktree", async () => {
    const tree = await world("ccloop-live", (s) => { s.tree = (s.tree as string).replace(/^./, (c) => (c === "a" ? "b" : "a")); });
    await expect(materializeFirstWorkspace(tree.repoPath, tree.runDir, 1, tree.input)).rejects.toThrow("control-resume-tree-mismatch");
    expect(existsSync(join(tree.runDir, "worktrees", "attempt-1"))).toBe(false);
    const head = await world("ccloop-live", (s) => { s.head = "f".repeat(40); });
    await expect(materializeFirstWorkspace(head.repoPath, head.runDir, 1, head.input)).rejects.toThrow("control-resume-snapshot-invalid");
  });

  it("a repoPath without the predecessor's base is refused by name", async () => {
    const w = await world("ccloop-published");
    const empty = join(w.runDir, "..", "empty");
    git(w.runDir, "init", "-q", empty);
    await expect(materializeFirstWorkspace(empty, w.runDir, 1, w.input)).rejects.toThrow("control-resume-base-unavailable");
  });
});
