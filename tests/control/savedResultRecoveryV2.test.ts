// Change-sized runs P1 (Orca spec 2026-11-19-change-sized-runs-design.md §5.5.4, criterion P1-7; Orca #363 #366): a saved
// result whose archive holds an Orca snapshot v2 -- the attempt pinned at refs/orca/runs/<source> plus a range bundle
// <base>..<ref> -- is recovered as `legacy-published-candidate-v2`.
// Why it matters: a range bundle carries no base, so it can only be verified where the base is: the recovery run's repoPath
// (a handle on the target), never an empty bare repository (review C1). The bundle must name exactly the recorded attempt,
// and verifying must not write the person's repository.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { savedRecoveryFixture } from "./savedRecoveryFixture.js";
import { canonicalJson } from "../../src/control/protocol.js";
import { runLoop } from "../../src/controller/runLoop.js";
import { verified } from "./taskResultFixture.js";

afterEach(() => vi.unstubAllEnvs());

const git = (repo: string, ...args: string[]) =>
  execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const gitIn = (repo: string, input: string | Buffer, ...args: string[]) =>
  execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString().trim();

/**
 * Review I2-I4: `attempt` replaces the recorded attempt with another commit made in the producer (it returns the commit and
 * the snapshot's head); `tamper` edits the snapshot before it is archived.
 */
type V2Options = { attempt?: (producer: string, base: string, recorded: string) => { attempt: string; head: string }; tamper?: (snapshot: Record<string, unknown>) => void };

/** The genuine v1 fixture, re-archived as Orca P2 archives it: the attempt pinned and bundled as a range over the base. */
async function v2Fixture(bundledCommit: "attempt" | "other" = "attempt", options: V2Options = {}) {
  const f = await savedRecoveryFixture();
  const runId = f.source.claim.runId, ref = `refs/orca/runs/${runId}`, base = f.source.work.base;
  const v1 = JSON.parse(f.bytes.get(f.archive.snapshot.artifactId)!.toString());
  const producer = join(f.root, "producer"), v1Bundle = join(f.root, "v1.bundle"), range = join(f.root, "range.bundle");
  await writeFile(v1Bundle, f.bytes.get(v1.bundle.artifactId)!);
  git(f.root, "init", "-q", "--bare", producer);
  git(producer, "fetch", "-q", v1Bundle, `refs/ccloop/${runId}/attempts/1:${ref}`);
  const custom = options.attempt?.(producer, base, git(producer, "rev-parse", ref));
  if (custom !== undefined) git(producer, "update-ref", ref, custom.attempt);
  const attempt = git(producer, "rev-parse", ref), tree = git(producer, "rev-parse", `${attempt}^{tree}`);
  if (bundledCommit === "other") git(producer, "update-ref", ref, git(producer, "commit-tree", tree, "-p", base, "-m", "not the recorded attempt"));
  git(producer, "bundle", "create", range, `${base}..${ref}`);
  // The recovery run's repoPath holds the base (it is a handle on the target) but not the attempt.
  git(producer, "update-ref", "refs/heads/base", base);
  git(f.repo, "fetch", "-q", producer, "refs/heads/base:refs/heads/source-base");
  const snapshot: Record<string, unknown> = { version: 2, objectFormat: "sha1", base, attempt, tree, head: custom?.head ?? attempt, ref, source: "ccloop-published", bundle: await f.put(await readFile(range)), missing: [] };
  options.tamper?.(snapshot);
  // Only the v2 closure is packaged: the v1 snapshot and its self-contained bundle are not.
  const dropped = new Set([f.manifest.source.artifactId, f.archive.snapshot.artifactId, v1.bundle.artifactId]);
  for (const entry of f.manifest.artifacts.filter((e) => dropped.has(e.ref.artifactId))) await rm(join(f.input.savedResultRecovery!.packagePath, entry.file));
  // In place: the fixture's put() appends to this same array.
  for (let i = f.manifest.artifacts.length - 1; i >= 0; i--) if (dropped.has(f.manifest.artifacts[i]!.ref.artifactId)) f.manifest.artifacts.splice(i, 1);
  f.archive.snapshot = await f.put(snapshot);
  const archiveRef = await f.put(f.archive);
  f.manifest.source = archiveRef;
  f.manifest.authorityKind = "legacy-published-candidate-v2" as never;
  f.admission.recoveryOf.capsuleHash = archiveRef.hash;
  f.admission.recoveryOf.snapshotHash = f.archive.snapshot.hash;
  await f.seal();
  return { ...f, attempt, base, ref };
}
const repositoryState = (repo: string) => [git(repo, "for-each-ref"), git(repo, "count-objects", "-v")];

it("verifies a v2 candidate in the recovery run's repoPath, without writing it", async () => {
  const f = await v2Fixture();
  try {
    expect(() => git(f.repo, "cat-file", "-e", `${f.attempt}^{commit}`)).toThrow();
    const before = repositoryState(f.repo);
    const result = await f.rpc("saved-result-eligibility", { input: f.input });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "eligible", authorityKind: "legacy-published-candidate-v2", normalizedExecutionHash: f.admission.recoveryOf.normalizedExecutionHash });
    expect(repositoryState(f.repo)).toEqual(before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("refuses a v2 bundle whose head is not the recorded attempt", async () => {
  const f = await v2Fixture("other");
  try {
    const result = await f.rpc("saved-result-eligibility", { input: f.input });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "unavailable", reason: "saved-result-snapshot-head-mismatch" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("restores the v2 candidate and verifies it once, as the v1 archive does", async () => {
  const f = await v2Fixture();
  try {
    const marker = join(f.root, "checks"); vi.stubEnv("CCLOOP_RECOVERY_CHECK_MARKER", marker);
    let verifications = 0;
    const state = await runLoop(f.input.work.contract, f.runDir, {
      plan: async () => { throw Error("planner replayed"); }, execute: async () => { throw Error("executor replayed"); },
      verify: async (context) => { verifications++; expect(await readFile(join(context.worktreePath, "answer.txt"), "utf8")).toBe("saved candidate\n"); return { ...verified, tokenUsage: 7 }; },
    }, { savedResultRecovery: f.input, tokenPolicy: f.input.tokenPolicy } as never);
    expect(state.status, state.stopReason ?? "").toBe("succeeded");
    expect(verifications).toBe(1);
    expect(await readFile(marker, "utf8")).toBe("check\n");
    // The recovery run's own published attempt sits on the source attempt, which materialize fetched into repoPath.
    expect(git(f.repo, "rev-parse", `refs/ccloop/${f.input.claim.runId}/attempts/1^`)).toBe(f.attempt);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("source-only eligibility verifies a v2 candidate in the source's target repository", async () => {
  const f = await v2Fixture();
  // The genuine source envelope names its own target; its hash binds the path, so the test makes that path exist.
  const target = f.source.work.targetRepo, top = dirname(dirname(target));
  await mkdir(top); // throws EEXIST rather than touch a directory this test did not make
  try {
    await mkdir(dirname(target));
    git(f.root, "clone", "-q", "--no-checkout", f.repo, target);
    const packagePath = join(f.root, "source-probe"); await mkdir(packagePath, { mode: 0o700 });
    const { admission: _admission, ...rest } = f.manifest;
    const manifest = { ...rest, schema: "ccloop-saved-result-source-package-v1" };
    for (const e of manifest.artifacts) await cp(join(f.input.savedResultRecovery!.packagePath, e.file), join(packagePath, e.file));
    const bytes = Buffer.from(canonicalJson(manifest)); await writeFile(join(packagePath, "package.json"), bytes, { mode: 0o600 });
    const input = { source: f.source, sourceAttempt: 1, packagePath, packageHash: createHash("sha256").update(bytes).digest("hex") };
    const before = repositoryState(target);
    const result = await f.rpc("saved-result-source-eligibility", { input });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "eligible", authorityKind: "legacy-published-candidate-v2", rawExecutionTokens: 15, recoveryOf: f.admission.recoveryOf });
    expect(repositoryState(target)).toEqual(before);
  } finally { await rm(top, { recursive: true, force: true }); await rm(f.root, { recursive: true, force: true }); }
}, 30000);

// Review I2: one refusal per v2 recovery check that nothing pinned. Each is a recovery of a snapshot that is well-formed but
// does not describe an attempt on the source's base, so Orca must not verify it as that source's result.
async function eligibility(f: Awaited<ReturnType<typeof v2Fixture>>) {
  try {
    const result = await f.rpc("saved-result-eligibility", { input: f.input });
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}

it("refuses a v2 snapshot whose base is not the source envelope's base", async () => {
  const f = await v2Fixture("attempt", { tamper: (s) => { s.base = "e".repeat(40); } });
  expect(await eligibility(f)).toEqual({ status: "unavailable", reason: "saved-result-original-base-unavailable" });
}, 30000);

it("refuses a v2 snapshot whose head is neither the attempt nor the base", async () => {
  const f = await v2Fixture("attempt", { tamper: (s) => { s.head = "e".repeat(40); } });
  expect(await eligibility(f)).toEqual({ status: "unavailable", reason: "saved-result-snapshot-head-mismatch" });
}, 30000);

// Review I3 (controller ruling, reversible: v2 keeps v1's strict rule). The agent committed inside its worktree, so the
// recorded attempt's parent is the agent's commit, not the run's base; the live capture's head is that commit
// (report.attempt.head), the published one's the attempt. Recovery refuses both by name.
const agentCommitted = (head: "agent" | "attempt") => (producer: string, base: string, recorded: string) => {
  const agent = git(producer, "commit-tree", `${recorded}^{tree}`, "-p", base, "-m", "the agent's own commit");
  const attempt = git(producer, "commit-tree", `${recorded}^{tree}`, "-p", agent, "-m", "attempt");
  return { attempt, head: head === "agent" ? agent : attempt };
};
it("refuses an agent-commit attempt (live or published capture) as saved-result-attempt-not-on-base", async () => {
  for (const head of ["agent", "attempt"] as const) {
    const f = await v2Fixture("attempt", { attempt: agentCommitted(head) });
    expect(await eligibility(f)).toEqual({ status: "unavailable", reason: "saved-result-attempt-not-on-base" });
  }
}, 60000);

// Review I4: the v1 caps (10,000 entries, a packaged file's size) refuse an attempt before any blob is read; the trees are
// synthetic (one empty blob 10,001 times; one blob of zeros over the limit), so they cost nothing to bundle.
it("refuses a v2 attempt over 10,000 files or with a blob over the package's per-file limit", async () => {
  const many = await v2Fixture("attempt", { attempt: (producer, base) => {
    const empty = gitIn(producer, "", "hash-object", "-w", "--stdin");
    const inner = gitIn(producer, Array.from({ length: 10001 }, (_, i) => `100644 blob ${empty}\tf${i}\n`).join(""), "mktree");
    const top = gitIn(producer, `040000 tree ${inner}\td\n`, "mktree");
    const attempt = git(producer, "commit-tree", top, "-p", base, "-m", "many");
    return { attempt, head: attempt };
  } });
  expect(await eligibility(many)).toEqual({ status: "unavailable", reason: "saved-result-snapshot-too-large" });
  const big = await v2Fixture("attempt", { attempt: (producer, base) => {
    const blob = gitIn(producer, Buffer.alloc(12 * 1024 * 1024 - 1024 + 1), "hash-object", "-w", "--stdin");
    const top = gitIn(producer, `100644 blob ${blob}\tbig.bin\n`, "mktree");
    const attempt = git(producer, "commit-tree", top, "-p", base, "-m", "big");
    return { attempt, head: attempt };
  } });
  expect(await eligibility(big)).toEqual({ status: "unavailable", reason: "saved-result-snapshot-too-large" });
}, 120000);
