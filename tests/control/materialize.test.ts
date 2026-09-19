import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { materializeFirstWorkspace, prepareContinuationContract } from "../../src/control/materialize.js";
import type { InputCheckpointV1 } from "../../src/control/protocol.js";
import { runLoop } from "../../src/controller/runLoop.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";

function git(repo: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Control Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Control Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  });
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function artifact(bytes: Buffer): { artifactId: string; hash: string } {
  const hash = sha256(bytes); return { artifactId: `sha256-${hash}`, hash };
}

interface BundleFixture {
  root: string;
  sourceRepo: string;
  targetRepo: string;
  sourceDir: string;
  runDir: string;
  input: InputCheckpointV1;
  manifestPath: string;
  manifest: Record<string, unknown> & { artifacts: Array<{ref:{artifactId:string;hash:string};file:string}> };
  snapshot: Record<string, unknown>;
}

async function treeEntries(root: string): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = [];
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      if (dir === root && name === ".git") continue;
      const path = join(dir, name), rel = relative(root, path), stat = await lstat(path), mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) result.push({ path: rel, kind: "symlink", mode, target: await readlink(path) });
      else if (stat.isDirectory()) { result.push({ path: rel, kind: "directory", mode }); await walk(path); }
      else if (stat.isFile()) { const bytes = await readFile(path); result.push({ path: rel, kind: "file", mode, ref: artifact(bytes) }); }
    }
  }
  await walk(root); return result;
}

async function buildBundle(): Promise<BundleFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-materialize-")));
  const sourceRepo = join(root, "source"), targetRepo = join(root, "target"), sourceDir = join(root, "new-source"), runDir = join(sourceDir, "run");
  await mkdir(sourceRepo); await mkdir(targetRepo); await mkdir(runDir, { recursive: true });
  git(sourceRepo, "init", "-q");
  await writeFile(join(sourceRepo, "tracked.txt"), "HEAD\n");
  await writeFile(join(sourceRepo, "deleted.txt"), "delete me\n");
  await writeFile(join(sourceRepo, "conflict.txt"), "base\n");
  await writeFile(join(sourceRepo, ".gitignore"), "ignored.txt\n");
  git(sourceRepo, "add", "."); git(sourceRepo, "commit", "-qm", "base"); git(sourceRepo, "checkout", "--detach", "-q");
  await writeFile(join(sourceRepo, "tracked.txt"), "INDEX\n"); git(sourceRepo, "add", "tracked.txt"); await writeFile(join(sourceRepo, "tracked.txt"), "WORKTREE\n");
  await unlink(join(sourceRepo, "deleted.txt"));
  await writeFile(join(sourceRepo, "binary.bin"), Buffer.from([0, 255, 128, 1]));
  await writeFile(join(sourceRepo, "executable.sh"), "#!/bin/sh\nexit 0\n"); await chmod(join(sourceRepo, "executable.sh"), 0o755);
  await symlink("/outside/not-followed", join(sourceRepo, "link"));
  await writeFile(join(sourceRepo, "ignored.txt"), "ignored but preserved\n");
  await mkdir(join(sourceRepo, "empty"), { mode: 0o700 });
  const conflictBlobs = ["base-conflict\n", "ours-conflict\n", "theirs-conflict\n"].map(text => git(sourceRepo, "hash-object", "-w", "--stdin").toString().trim());
  // Feed the intended bytes separately: hash-object above consumed empty stdin, so replace them with real object ids.
  for (let i = 0; i < conflictBlobs.length; i++) {
    conflictBlobs[i] = spawnSync("git", ["-C", sourceRepo, "hash-object", "-w", "--stdin"], { input: ["base-conflict\n", "ours-conflict\n", "theirs-conflict\n"][i] }).stdout.toString().trim();
  }
  const zero = "0".repeat(40);
  const indexInfo = [`0 ${zero} 0\tconflict.txt`, ...conflictBlobs.map((oid, i) => `100644 ${oid} ${i + 1}\tconflict.txt`)].join("\n") + "\n";
  const update = spawnSync("git", ["-C", sourceRepo, "update-index", "--index-info"], { input: indexInfo });
  if (update.status !== 0) throw new Error(update.stderr.toString());
  await writeFile(join(sourceRepo, "conflict.txt"), "<<<<<<< ours\n=======\n>>>>>>> theirs\n");

  const bundleFile = join(root, "repo.bundle"); git(sourceRepo, "bundle", "create", bundleFile, "--all", "HEAD");
  const bundleBytes = await readFile(bundleFile), bundleRef = artifact(bundleBytes);
  const index = [] as Array<{path:string;mode:string;oid:string;stage:number;ref:{artifactId:string;hash:string}}>; const blobs = new Map<string, Buffer>();
  for (const raw of git(sourceRepo, "ls-files", "--stage", "-z").toString().split("\0").filter(Boolean)) {
    const tab = raw.indexOf("\t"), path = raw.slice(tab + 1), [mode, oid, stage] = raw.slice(0, tab).split(" ");
    const bytes = git(sourceRepo, "cat-file", "blob", oid!), ref = artifact(bytes); blobs.set(ref.artifactId, bytes);
    index.push({ path, mode: mode!, oid: oid!, stage: Number(stage), ref });
  }
  const tree = await treeEntries(sourceRepo);
  for (const entry of tree) if (entry.kind === "file") blobs.set((entry.ref as {artifactId:string}).artifactId, await readFile(join(sourceRepo, entry.path as string)));
  const paths = new Set(tree.map(entry => entry.path));
  const snapshot = { version: 1, head: git(sourceRepo, "rev-parse", "HEAD").toString().trim(), bundle: bundleRef, index, tree, deleted: index.filter(entry => !paths.has(entry.path)).map(entry => entry.path), missing: [] };
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot)), snapshotRef = artifact(snapshotBytes);
  const checkpoint = { checkpointId: "cp1", snapshot: snapshotRef }, checkpointBytes = Buffer.from(JSON.stringify(checkpoint));
  const checkpointRef = { artifactId: `checkpoint-cp1-${sha256(checkpointBytes)}`, hash: sha256(checkpointBytes) };
  const evidenceBytes = Buffer.from("nested evidence\n");
  const evidenceRef = artifact(evidenceBytes);
  const artifactBytes = new Map<string, Buffer>([[bundleRef.artifactId, bundleBytes], [snapshotRef.artifactId, snapshotBytes], [evidenceRef.artifactId, evidenceBytes], ...blobs]);
  const bundlePath = join(sourceDir, "input", "cp1"), artifactsDir = join(bundlePath, "artifacts"); await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  const artifacts = [{ ref: checkpointRef, file: "checkpoint.json" }]; await writeFile(join(bundlePath, "checkpoint.json"), checkpointBytes, { mode: 0o600 });
  for (const [artifactId, bytes] of [...artifactBytes].sort(([a], [b]) => a.localeCompare(b))) {
    const ref = artifact(bytes), file = `artifacts/${artifactId}.bin`; await writeFile(join(bundlePath, file), bytes, { mode: 0o600 }); artifacts.push({ ref, file });
  }
  const manifest = { protocol: 1, predecessorRunId: "old-run", checkpointId: "cp1", checkpointHash: checkpointRef.hash, checkpoint: checkpointRef, snapshot: snapshotRef, artifacts, unfinished: ["finish the recovery"], pendingDecisions: ["choose validation depth"], awaitingHuman: ["approval remains pending"] };
  const manifestPath = join(bundlePath, "resume-bundle.json"); await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

  git(targetRepo, "init", "-q"); await writeFile(join(targetRepo, "different.txt"), "target head\n"); git(targetRepo, "add", "."); git(targetRepo, "commit", "-qm", "different");
  return { root, sourceRepo, targetRepo, sourceDir, runDir, input: { predecessorRunId: "old-run", checkpointId: "cp1", checkpointHash: checkpointRef.hash, bundlePath }, manifestPath, manifest, snapshot };
}

async function comparableTree(root: string): Promise<Array<Record<string, unknown>>> { return treeEntries(root); }

describe("committed continuation materialization", { timeout: 30_000 }, () => {
  it("reproduces HEAD, all index stages, worktree bytes, modes, symlinks and status", async () => {
    const h = await buildBundle();
    const { worktreePath } = await materializeFirstWorkspace(h.targetRepo, h.runDir, 1, h.input);
    expect(git(worktreePath, "rev-parse", "HEAD")).toEqual(git(h.sourceRepo, "rev-parse", "HEAD"));
    expect(git(worktreePath, "ls-files", "--stage", "-z")).toEqual(git(h.sourceRepo, "ls-files", "--stage", "-z"));
    expect(await comparableTree(worktreePath)).toEqual(await comparableTree(h.sourceRepo));
    expect(git(worktreePath, "status", "--porcelain=v2", "-z")).toEqual(git(h.sourceRepo, "status", "--porcelain=v2", "-z"));
  });

  it("writes immutable structured continuation input and augments a copied contract", async () => {
    const h = await buildBundle();
    const contract = { context: { relevantDocs: [], constraints: [] } } as unknown as LoopContract;
    const prepared = await prepareContinuationContract(contract, h.runDir, h.input);
    expect(prepared).not.toBe(contract); expect(contract.context.relevantDocs).toEqual([]); expect(contract.context.constraints).toEqual([]);
    const path = join(h.runDir, "continuation-input.json");
    expect(prepared.context.relevantDocs).toContain(path);
    expect(prepared.context.constraints).toContain("Treat continuation input fields unfinished, pendingDecisions, and awaitingHuman as required planning inputs.");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ unfinished: ["finish the recovery"], pendingDecisions: ["choose validation depth"], awaitingHuman: ["approval remains pending"] });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("verifies the continuation workspace before constructing the runtime adapter", async () => {
    const h = await buildBundle();
    const contract: LoopContract = {
      objective: { taskId: "resume", goal: "continue", successCondition: "done", nonGoals: [] },
      context: { repoPath: h.targetRepo, targetPaths: ["tracked.txt"], relevantDocs: [], buildTestCommands: ["true"], constraints: [] },
      executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalRuntimeBudgetMs: 5_000, tokenBudget: 100, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 0 },
      safetyPolicy: { allowlistPaths: [], denylistPaths: [], maxFilesTouched: 20, humanGateConditions: [] },
      verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["failure"], evidenceRequired: [] },
      escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
    };
    const prepared = await prepareContinuationContract(contract, h.runDir, h.input);
    let constructedAfterSnapshot = false;
    const factory = (): RuntimeAdapter => {
      const worktree = join(h.runDir, "worktrees", "attempt-1");
      constructedAfterSnapshot = git(worktree, "rev-parse", "HEAD").toString().trim() === h.snapshot.head;
      return {
        plan: async () => { throw new Error("stop after construction check"); },
        execute: async () => { throw new Error("execute should not run"); },
        verify: async () => { throw new Error("verify should not run"); },
      };
    };
    await runLoop(prepared, h.runDir, factory, { firstWorkspaceInput: h.input });
    expect(constructedAfterSnapshot).toBe(true);
  });

  it.each(["traversal", "absolute", "duplicate", "missing", "hash", "extra", "symlink", "fifo", "checkpoint", "predecessor"])("rejects hostile bundle: %s", async kind => {
    const h = await buildBundle(); const manifest = structuredClone(h.manifest); const first = manifest.artifacts[1]!;
    if (kind === "traversal") { const bytes = await readFile(join(h.input.bundlePath, first.file)); await unlink(join(h.input.bundlePath, first.file)); first.file = "../escape"; await writeFile(join(h.input.bundlePath, first.file), bytes, { mode: 0o600 }); }
    if (kind === "absolute") first.file = join(h.root, "outside");
    if (kind === "duplicate") manifest.artifacts.push({ ref: { artifactId: first.ref.artifactId, hash: "f".repeat(64) }, file: "artifacts/conflict.bin" });
    if (kind === "missing") await unlink(join(h.input.bundlePath, first.file));
    if (kind === "hash") { const evidence = manifest.artifacts.find(entry => entry.ref.hash === sha256(Buffer.from("nested evidence\n")))!; await writeFile(join(h.input.bundlePath, evidence.file), "tampered", { mode: 0o600 }); }
    if (kind === "extra") await writeFile(join(h.input.bundlePath, "extra"), "not manifested", { mode: 0o600 });
    if (kind === "symlink") { await unlink(join(h.input.bundlePath, first.file)); await symlink("../checkpoint.json", join(h.input.bundlePath, first.file)); }
    if (kind === "fifo") { await unlink(join(h.input.bundlePath, first.file)); execFileSync("mkfifo", [join(h.input.bundlePath, first.file)]); }
    if (kind === "checkpoint") h.input.checkpointHash = "0".repeat(64);
    if (kind === "predecessor") h.input.predecessorRunId = "wrong-run";
    if (["traversal", "absolute", "duplicate"].includes(kind)) await writeFile(h.manifestPath, JSON.stringify(manifest));
    await expect(materializeFirstWorkspace(h.targetRepo, h.runDir, 1, h.input)).rejects.toThrow(/control-resume-/);
  });

  it("refuses a source bundle that changes during validation", async () => {
    const h = await buildBundle(); const first = h.manifest.artifacts[1]!;
    await expect(materializeFirstWorkspace(h.targetRepo, h.runDir, 1, h.input, {
      afterValidation: async () => { await writeFile(join(h.input.bundlePath, first.file), "changed", { mode: 0o600 }); },
    })).rejects.toThrow("control-resume-source-changed");
  });
});
