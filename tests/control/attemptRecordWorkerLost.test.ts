// Change-sized runs P1 (Orca spec 2026-11-19-change-sized-runs-design.md §5.2.3; Orca #363 #366): `settle-lost-worker` does
// what the dead worker would have done at its end. Under work.attemptDelivery that is recording the hung attempt's live
// worktree as a commit and removing it -- not materializing <sourceDir>/repo. The fixture is tests/control/workerLost.test.ts's
// (Orca #273), copied with a protocol-4 envelope that carries the key; that file is unchanged.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { resolveAgent } from "../../src/agents/materialize.js";
import { canonicalHash, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { codexInstallation, writeAgentsTable } from "./agentsFixture.js";

const binary = resolve("dist/cli.js"), fakeCodex = resolve("tests/fixtures/fake-codex.mjs");
const roots: string[] = [], pids: number[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} try { process.kill(-pid, "SIGKILL"); } catch {} }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(mode: string, extra = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-worker-lost-"))); roots.push(root);
  const repo = join(root, "target"), sourceDir = join(root, "source"), marker = join(root, "codex-marker");
  await mkdir(repo, { mode: 0o700 }); await mkdir(sourceDir, { mode: 0o700 }); await mkdir(join(sourceDir, "input"), { mode: 0o700 });
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await run("git", args, undefined, repo);
  await writeFile(join(repo, "answer.txt"), "0\n"); await writeFile(join(repo, "check.cjs"), 'if(require("fs").readFileSync("answer.txt","utf8")!=="42\\n")process.exit(1);\n');
  await run("git", ["add", "."], undefined, repo); await run("git", ["commit", "-qm", "base"], undefined, repo);
  // Review I2: an extra repository (multi-dir run), so the extras path of the record is driven.
  const lib = join(root, "lib");
  if (extra) {
    await mkdir(lib, { mode: 0o700 }); await mkdir(join(lib, "lib"));
    for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await run("git", args, undefined, lib);
    await writeFile(join(lib, "lib", "lib.txt"), "lib\n"); await run("git", ["add", "."], undefined, lib); await run("git", ["commit", "-qm", "lib base"], undefined, lib);
  }
  const installation = await codexInstallation({ command: [process.execPath, fakeCodex, mode, marker], budgetMode: "soft", sandbox: "workspace-write", timeoutMs: 60000, killGraceMs: 50 });
  const { path: tablePath, table } = await writeAgentsTable({ codex: installation }, root);
  const { resolution } = await resolveAgent(table, { agent: "codex", model: "fixture" });
  const check = `${process.execPath} check.cjs`;
  const contract: LoopContract = { objective: { taskId: "task-1", goal: "Set answer.txt to 42", successCondition: "answer is 42", nonGoals: [] },
    context: { repoPath: repo, targetPaths: ["answer.txt"], relevantDocs: [], buildTestCommands: [check], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 60000, totalRuntimeBudgetMs: 120000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
    safetyPolicy: { allowlistPaths: ["answer.txt"], denylistPaths: [], maxFilesTouched: 2, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: [check], rejectOn: ["failure"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] } };
  const grant = { tokens: 2000, activeMs: 120000, attempts: 6, sessions: 3 };
  const envelope: LoopStartEnvelope = { protocol: 4, tokenPolicy: { authoredTokenCeiling: null, bindingCauses: [], inheritedUsage: { tokens: 0, activeMs: 0, attempts: 0, sessions: 0 } }, claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 2, targetVersion: 1,
    commandId: "command-1", configHash: resolution.configHash, agent: resolution.selection, grant: { work: grant, handoff: { tokens: 200, activeMs: 30000, attempts: 1, sessions: 1 } }, ownerToken: "owner-1" },
    contractHash: canonicalHash(contract), inputCheckpoint: null, work: { kind: "loop", contract, targetRepo: repo, base: "HEAD", sourceDir, attemptDelivery: "ref-v1" } };
  if (extra) {
    contract.context.repoKey = "app";
    contract.context.additionalRepos = [{ key: "lib", repoPath: lib, targetPaths: ["lib/**"] }];
    envelope.contractHash = canonicalHash(contract);
    envelope.work = { ...envelope.work, additionalRepos: [{ key: "lib", targetRepo: lib, base: "HEAD" }] } as LoopStartEnvelope["work"];
  }
  return { root, repo, lib, sourceDir, marker, tablePath, envelope };
}
type F = Awaited<ReturnType<typeof fixture>>;
function run(executable: string, args: string[], input?: string, cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }); let stdout = "", stderr = "";
    child.stdout.on("data", (b) => stdout += b); child.stderr.on("data", (b) => stderr += b); child.on("error", fail);
    child.on("exit", (code) => done({ code, stdout, stderr })); child.stdin.end(input);
  });
}
const call = (f: F, method: string, payload: unknown) => run(binary, ["control", method, "--agents", f.tablePath], JSON.stringify(payload));
async function collect(f: F) { const r = await call(f, "collect", { input: f.envelope, afterSeq: 0 }); expect(r.code, r.stderr).toBe(0); return JSON.parse(r.stdout); }
async function waitFor(what: string, test: () => Promise<boolean> | boolean) { for (let i = 0; i < 600; i++) { if (await test()) return; await sleep(50); } throw new Error(`timed out waiting for ${what}`); }

/** Accepts the run, waits until fake codex hangs in `phase`, and returns the worker's pid and the hung call's pid. */
async function hung(phase: "plan" | "execute", extra = false) {
  const f = await fixture(`hang-in-${phase}`, extra);
  const accepted = await call(f, "accept", f.envelope); expect(accepted.code, accepted.stderr).toBe(0);
  await waitFor("the hung call", () => readFile(`${f.marker}.hanging`, "utf8").then(() => true, () => false));
  const worker = JSON.parse(await readFile(join(f.sourceDir, "control", "accepted.json"), "utf8")).worker.pid as number;
  pids.push(worker);
  const registered = JSON.parse(await readFile(join(f.sourceDir, "control", "processes.json"), "utf8")) as Array<{ pid: number; phase: string }>;
  const agent = registered.at(-1)!.pid; pids.push(agent);
  return { f, worker, agent };
}
async function killWorker(pid: number) { process.kill(pid, "SIGKILL"); await waitFor("the worker to exit", () => !alive(pid)); }

it("a lost worker's hung attempt is recorded live and removed, and no result repository is made", { timeout: 180_000 }, async () => {
  const { f, worker } = await hung("execute");
  await killWorker(worker);
  const settled = await call(f, "settle-lost-worker", { input: f.envelope });
  expect(settled.code, settled.stderr).toBe(0);
  const done = await collect(f);
  expect(done.terminal).toMatchObject({ status: "failed" });
  expect(done.attempt).toMatchObject({ attempt: 1, capture: "live", worktree: "removed", ref: "refs/ccloop/run-1/attempts/1" });
  const head = (await run("git", ["rev-parse", "HEAD"], undefined, f.repo)).stdout.trim();
  expect(done.attempt.head).toBe(head);
  expect((await run("git", ["rev-parse", "refs/ccloop/run-1/attempts/1"], undefined, f.repo)).stdout.trim()).toBe(done.attempt.sha);
  expect(existsSync(join(f.sourceDir, "repo"))).toBe(false);
  expect(existsSync(join(f.sourceDir, "run", "worktrees", "attempt-1"))).toBe(false);
});

// Review I1: a recorded live tree whose removal fails stays (worktree "retained"). Nothing after the record may touch it: the
// legacy publishing cleanup would commit on its real index and move both refs off the recorded sha, so the commit Orca takes
// as the result would not be the one the record names. A locked worktree makes `worktree remove --force` fail, as a person's
// `git worktree lock` would.
it("I1: a recorded tree whose removal fails keeps both refs at the recorded sha and its own HEAD", { timeout: 180_000 }, async () => {
  const { f, worker } = await hung("execute");
  await killWorker(worker);
  const tree = join(f.sourceDir, "run", "worktrees", "attempt-1");
  const base = (await run("git", ["rev-parse", "HEAD"], undefined, f.repo)).stdout.trim();
  expect((await run("git", ["worktree", "lock", tree], undefined, f.repo)).code).toBe(0);
  const settled = await call(f, "settle-lost-worker", { input: f.envelope });
  expect(settled.code, settled.stderr).toBe(0);
  const done = await collect(f);
  expect(done.attempt).toMatchObject({ attempt: 1, capture: "live", worktree: "retained", head: base });
  for (const ref of ["refs/ccloop/run-1/attempts/1", "refs/ccloop/run/attempts/1"]) {
    expect((await run("git", ["rev-parse", ref], undefined, f.repo)).stdout.trim()).toBe(done.attempt.sha);
  }
  expect(existsSync(tree)).toBe(true);
  expect((await run("git", ["rev-parse", "HEAD"], undefined, tree)).stdout.trim()).toBe(base);
});

// Review I2: the extras path. A multi-dir key run's extra worktree is recorded into run/attempts/<n>/commits.json (collect's
// dirs[].attemptSha reads it), pinned in its own repository, removed, and no <sourceDir>/repos/<key> is made.
it("I2: a lost multi-dir key run records its extra into commits.json, removes it, and makes no repos/", { timeout: 180_000 }, async () => {
  const { f, worker } = await hung("execute", true);
  await killWorker(worker);
  const extraTree = join(f.sourceDir, "run", "dirs", "attempt-1", "lib");
  expect(existsSync(extraTree)).toBe(true);
  await writeFile(join(extraTree, "lib", "edit.txt"), "edited\n");
  const libBase = (await run("git", ["rev-parse", "HEAD"], undefined, f.lib)).stdout.trim();
  const settled = await call(f, "settle-lost-worker", { input: f.envelope });
  expect(settled.code, settled.stderr).toBe(0);
  const done = await collect(f);
  expect(done.attempt).toMatchObject({ attempt: 1, capture: "live", worktree: "removed" });
  const commits = JSON.parse(await readFile(join(f.sourceDir, "run", "attempts", "1", "commits.json"), "utf8"));
  expect(commits.app).toEqual({ sha: done.attempt.sha, base: done.attempt.base, ref: done.attempt.ref });
  expect(commits.lib).toMatchObject({ base: libBase, ref: "refs/ccloop/run/attempts/1" });
  for (const ref of ["refs/ccloop/run/attempts/1", "refs/ccloop/run-1/attempts/1"]) {
    expect((await run("git", ["rev-parse", ref], undefined, f.lib)).stdout.trim()).toBe(commits.lib.sha);
  }
  expect((await run("git", ["show", `${commits.lib.sha}:lib/edit.txt`], undefined, f.lib)).stdout).toBe("edited\n");
  expect(done.dirs).toEqual([expect.objectContaining({ key: "lib", attemptSha: commits.lib.sha })]);
  expect(existsSync(extraTree)).toBe(false);
  expect(existsSync(join(f.sourceDir, "repos"))).toBe(false);
  expect(existsSync(join(f.sourceDir, "repo"))).toBe(false);
});
