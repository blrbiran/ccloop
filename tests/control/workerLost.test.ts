// Orca #273 (spec Orca docs/superpowers/specs/2026-11-12-worker-lost-recovery-design.md §4; Orca session 7e164691,
// tester follow-up H). A machine restart or a killed worker used to leave an Orca run with no candidate and no terminal
// forever: collect said nothing about the worker. Now collect reports a worker that is not alive (`worker`, only while a
// claimed loop run has neither; an alive worker's in-flight answer is unchanged), and `settle-lost-worker` ends a run whose worker is confirmed dead as an ordinary failed
// terminal (cause `worker-lost`) with a stop proof Orca's terminal-closure checks accept. A live or undetermined worker
// is never settled. Driven through the built CLI over fake codex, whose `hang-in-<phase>` mode hangs mid-phase.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { resolveAgent } from "../../src/agents/materialize.js";
import { canonicalHash, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { settleLostWorker } from "../../src/control/settleLostWorker.js";
import { readAccepted, writeAccepted } from "../../src/control/store.js";
import { workerLiveness } from "../../src/control/workerLiveness.js";
import { codexInstallation, writeAgentsTable } from "./agentsFixture.js";

const binary = resolve("dist/cli.js"), fakeCodex = resolve("tests/fixtures/fake-codex.mjs");
const roots: string[] = [], pids: number[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} try { process.kill(-pid, "SIGKILL"); } catch {} }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(mode: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-worker-lost-"))); roots.push(root);
  const repo = join(root, "target"), sourceDir = join(root, "source"), marker = join(root, "codex-marker");
  await mkdir(repo, { mode: 0o700 }); await mkdir(sourceDir, { mode: 0o700 }); await mkdir(join(sourceDir, "input"), { mode: 0o700 });
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await run("git", args, undefined, repo);
  await writeFile(join(repo, "answer.txt"), "0\n"); await writeFile(join(repo, "check.cjs"), 'if(require("fs").readFileSync("answer.txt","utf8")!=="42\\n")process.exit(1);\n');
  await run("git", ["add", "."], undefined, repo); await run("git", ["commit", "-qm", "base"], undefined, repo);
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
  const envelope: LoopStartEnvelope = { protocol: 3, claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 2, targetVersion: 1,
    commandId: "command-1", configHash: resolution.configHash, agent: resolution.selection, grant: { work: grant, handoff: { tokens: 200, activeMs: 30000, attempts: 1, sessions: 1 } }, ownerToken: "owner-1" },
    contractHash: canonicalHash(contract), inputCheckpoint: null, work: { kind: "loop", contract, targetRepo: repo, base: "HEAD", sourceDir } };
  return { root, repo, sourceDir, marker, tablePath, envelope };
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
async function hung(phase: "plan" | "execute") {
  const f = await fixture(`hang-in-${phase}`);
  const accepted = await call(f, "accept", f.envelope); expect(accepted.code, accepted.stderr).toBe(0);
  await waitFor("the hung call", () => readFile(`${f.marker}.hanging`, "utf8").then(() => true, () => false));
  const worker = JSON.parse(await readFile(join(f.sourceDir, "control", "accepted.json"), "utf8")).worker.pid as number;
  pids.push(worker);
  const registered = JSON.parse(await readFile(join(f.sourceDir, "control", "processes.json"), "utf8")) as Array<{ pid: number; phase: string }>;
  const agent = registered.at(-1)!.pid; pids.push(agent);
  return { f, worker, agent };
}
async function killWorker(pid: number) { process.kill(pid, "SIGKILL"); await waitFor("the worker to exit", () => !alive(pid)); }

describe("a run whose ccloop worker died (Orca #273)", { timeout: 180_000 }, () => {
  for (const phase of ["plan", "execute"] as const) it(`dead mid-${phase}: collect reports lost, settle-lost-worker ends it as worker-lost with a stop proof`, async () => {
    const { f, worker, agent } = await hung(phase);
    const running = await collect(f);
    expect(running).toMatchObject({ candidate: null, terminal: null });
    expect(running).not.toHaveProperty("worker"); // alive: the in-flight answer is unchanged
    // A live worker is never settled.
    const refused = await call(f, "settle-lost-worker", { input: f.envelope });
    expect(refused.code).not.toBe(0); expect(refused.stderr).toContain("control-worker-not-lost");
    expect(alive(agent)).toBe(true);

    await killWorker(worker);
    const lost = await collect(f);
    expect(lost).toMatchObject({ candidate: null, terminal: null, worker: { state: "lost" } });
    expect(lost.worker.reason).toContain(String(worker));

    const settled = await call(f, "settle-lost-worker", { input: f.envelope });
    expect(settled.code, settled.stderr).toBe(0);
    const { candidate } = JSON.parse(settled.stdout);
    expect(candidate).toMatchObject({ runId: "run-1", result: "failed", terminalOutcome: "failed", stopProof: { isolated: true } });
    expect(alive(agent)).toBe(false); // the orphaned agent call was reaped

    const done = await collect(f);
    expect(done).not.toHaveProperty("worker");
    expect(done.terminal).toMatchObject({ status: "failed" });
    expect(done.terminal.stopReason).toMatch(/^worker-lost: /);
    expect(done.failureCause).toMatchObject({ cause: "worker-lost", phase, retries: 0 });
    expect(done.candidate).toEqual(candidate);
    // Orca's terminalRunClosure reads these two facts from the stop proof's evidence.
    const evidence = await call(f, "read-evidence", { input: f.envelope, ref: candidate.stopProof.source });
    expect(evidence.code, evidence.stderr).toBe(0);
    expect(JSON.parse(Buffer.from(JSON.parse(evidence.stdout).base64, "base64").toString("utf8"))).toMatchObject({ ownerLeaseReleased: true, workerSealed: true });
    // The killed call's usage is unknown: the last work event carries no cumulative total.
    expect(done.events.filter((e: { bucket: string }) => e.bucket === "work").at(-1).cumulative).toBeNull();
    // The dead attempt's worktree is published under its ref and removed.
    expect((await run("git", ["rev-parse", "--verify", "refs/ccloop/run-1/attempts/1"], undefined, f.repo)).code).toBe(0);

    // Idempotent: a second call answers the same candidate.
    const again = await call(f, "settle-lost-worker", { input: f.envelope });
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).candidate).toEqual(candidate);
  });

  it("an undetermined worker is reported as such and refused", async () => {
    const { f, worker } = await hung("plan");
    const accepted = await readAccepted(f.sourceDir);
    const unreadable = { readStart: async () => null };
    expect(await workerLiveness(accepted, unreadable)).toMatchObject({ state: "undetermined" });
    await expect(settleLostWorker(f.envelope, unreadable)).rejects.toThrow("control-worker-not-lost");
    expect(alive(worker)).toBe(true);
    // A worker whose identity names no live process and whose pid is gone is lost, never undetermined.
    expect(await workerLiveness(accepted, { liveness: () => ({ verdict: "dead" }) })).toMatchObject({ state: "lost" });
  });

  // The two liveness guards, each alone: the worker's own identity (a run whose loop wrote no owner record yet), and the
  // loop's owner record (the worker's identity says its pid was reused, the owner record says the loop was alive later).
  it("a live worker without an owner record is refused by the worker's own identity", async () => {
    const { f, worker, agent } = await hung("plan");
    const owner = join(f.sourceDir, "run", "owner-record.json"), bytes = await readFile(owner);
    await rm(owner);
    await expect(settleLostWorker(f.envelope)).rejects.toThrow("control-worker-not-lost");
    await writeFile(owner, bytes, { mode: 0o600 });
    expect(alive(worker) && alive(agent)).toBe(true);
  });

  it("a worker the owner record shows alive later than its pid's holder started is refused", async () => {
    const { f, worker, agent } = await hung("plan");
    const holderStart = new Date(Date.now() + 10_000), utc = holderStart.toUTCString().split(" "); // e.g. Thu, 12 Nov 2026 12:48:03 GMT
    const lstart = `${utc[0]!.slice(0, 3)} ${utc[2]} ${String(holderStart.getUTCDate()).padStart(2, " ")} ${utc[4]} ${utc[3]}`;
    const reused = { readStart: async () => lstart };
    expect(await workerLiveness(await readAccepted(f.sourceDir), reused)).toMatchObject({ state: "lost" }); // the worker identity alone says reused
    const owner = join(f.sourceDir, "run", "owner-record.json"), bytes = await readFile(owner);
    await writeFile(owner, JSON.stringify({ ...JSON.parse(bytes.toString()), lastAffirmedAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
    await expect(settleLostWorker(f.envelope, reused)).rejects.toThrow("control-worker-not-lost");
    await writeFile(owner, bytes, { mode: 0o600 });
    expect(alive(worker) && alive(agent)).toBe(true);
  });

  // Ruling (Orca session c8b75eac, 2026-11-13; asked to decide whether an old title must change, the human answered
  // 「点名允许改必要的测试」): since tester follow-up I, collect reports `worker` beside a candidate whose stop is NOT proved
  // (the describe below), so the old title "a run with a candidate never carries worker" claimed more than holds; what
  // this asserts is the stop-proved case only.
  it("a run whose candidate carries a stop proof never carries worker, and settle-lost-worker answers its candidate", async () => {
    const f = await fixture("integration");
    const accepted = await call(f, "accept", f.envelope); expect(accepted.code, accepted.stderr).toBe(0);
    let done: any;
    await waitFor("the run's terminal", async () => { done = await collect(f); return done.candidate?.stopProof != null && done.terminal !== null; });
    expect(done).not.toHaveProperty("worker");
    expect(done.terminal.status).toBe("succeeded");
    const answer = await call(f, "settle-lost-worker", { input: f.envelope });
    expect(answer.code, answer.stderr).toBe(0);
    expect(JSON.parse(answer.stdout).candidate).toEqual(done.candidate);
  });
});

// Orca tester follow-up I (Orca session d467cbd2, 2026-11-13; independent review of #273, findings 2 and 4). The worker's end
// is candidate -> seal -> lease release (worker.ts onRunSettledBeforeLeaseRelease, then runLoop's heartbeat.stop). A worker
// that died inside that sequence left a candidate whose stop could never be proved: collect said nothing about the worker,
// so Orca waited forever (the #273 symptom again). Now collect reports the dead worker beside such a candidate, and
// settle-lost-worker finishes what the worker did not -- seal, lease release, stop proof -- keeping the worker's own result.
describe("a worker that died after writing its candidate (Orca tester follow-up I)", { timeout: 180_000 }, () => {
  /** A run that succeeds, whose worker is stopped right after its candidate is fsynced (before seal and lease release). */
  async function stoppedAfterCandidate() {
    const f = await fixture("integration");
    const crash = join(f.root, "crash-candidate");
    const saved = { point: process.env.CCLOOP_CONTROL_TEST_CRASH_POINT, marker: process.env.CCLOOP_CONTROL_TEST_CRASH_MARKER };
    process.env.CCLOOP_CONTROL_TEST_CRASH_POINT = "candidate-fsynced"; process.env.CCLOOP_CONTROL_TEST_CRASH_MARKER = crash;
    try { const accepted = await call(f, "accept", f.envelope); expect(accepted.code, accepted.stderr).toBe(0); }
    finally {
      if (saved.point === undefined) delete process.env.CCLOOP_CONTROL_TEST_CRASH_POINT; else process.env.CCLOOP_CONTROL_TEST_CRASH_POINT = saved.point;
      if (saved.marker === undefined) delete process.env.CCLOOP_CONTROL_TEST_CRASH_MARKER; else process.env.CCLOOP_CONTROL_TEST_CRASH_MARKER = saved.marker;
    }
    await waitFor("the worker to stop after its candidate", () => readFile(crash, "utf8").then(() => true, () => false));
    const worker = (await readAccepted(f.sourceDir)).worker!.pid; pids.push(worker);
    return { f, worker };
  }
  async function settledKeepsTheWorkersResult(f: F) {
    const settled = await call(f, "settle-lost-worker", { input: f.envelope });
    expect(settled.code, settled.stderr).toBe(0);
    const { candidate } = JSON.parse(settled.stdout);
    // The worker's own outcome is kept: the run succeeded, it is not rewritten to worker-lost.
    expect(candidate).toMatchObject({ runId: "run-1", result: "complete", terminalOutcome: "succeeded", stopProof: { isolated: true } });
    const done = await collect(f);
    expect(done).not.toHaveProperty("worker");
    expect(done).not.toHaveProperty("failureCause");
    expect(done.terminal).toMatchObject({ status: "succeeded" });
    expect(done.candidate).toEqual(candidate);
    const evidence = await call(f, "read-evidence", { input: f.envelope, ref: candidate.stopProof.source });
    expect(evidence.code, evidence.stderr).toBe(0);
    expect(JSON.parse(Buffer.from(JSON.parse(evidence.stdout).base64, "base64").toString("utf8"))).toMatchObject({ ownerLeaseReleased: true, workerSealed: true });
    expect((await readAccepted(f.sourceDir)).launch).toBe("sealed");
    const again = await call(f, "settle-lost-worker", { input: f.envelope });
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).candidate).toEqual(candidate);
  }

  it("died before sealing: collect reports lost beside the unproved candidate; settling seals it and keeps the success", async () => {
    const { f, worker } = await stoppedAfterCandidate();
    // Alive (stopped at the crash point): the in-flight answer is unchanged, and it is never settled.
    const running = await collect(f);
    expect(running.candidate).toMatchObject({ result: "complete", stopProof: null });
    expect(running).not.toHaveProperty("worker");
    const refused = await call(f, "settle-lost-worker", { input: f.envelope });
    expect(refused.code).not.toBe(0); expect(refused.stderr).toContain("control-worker-not-lost");
    expect(alive(worker)).toBe(true);

    await killWorker(worker);
    const lost = await collect(f);
    // mutation: workerReportApplies ignores a candidate (the #273 trigger only) -> no `worker`, red
    expect(lost).toMatchObject({ candidate: { result: "complete", stopProof: null }, worker: { state: "lost" } });
    expect((await readAccepted(f.sourceDir)).launch).toBe("claimed");
    await settledKeepsTheWorkersResult(f);
  });

  it("died after sealing, before releasing its lease: collect reports lost; settling releases the lease and keeps the success", async () => {
    const { f, worker } = await stoppedAfterCandidate();
    await killWorker(worker);
    // The seal had been written: the state a worker leaves when it dies between sealAcceptedWorker and heartbeat.stop.
    await writeAccepted(f.sourceDir, { ...(await readAccepted(f.sourceDir)), launch: "sealed" });
    const lost = await collect(f);
    expect(lost).toMatchObject({ candidate: { result: "complete", stopProof: null }, worker: { state: "lost" } });
    // mutation: settle-lost-worker answers a sealed run only through proveStopped (no lease release) -> control-worker-not-stopped, red
    await settledKeepsTheWorkersResult(f);
  });

  it("a sealed run whose stop is proved is answered as it is, whatever its worker's liveness reads", async () => {
    const f = await fixture("integration");
    const accepted = await call(f, "accept", f.envelope); expect(accepted.code, accepted.stderr).toBe(0);
    let done: any;
    await waitFor("the run's terminal", async () => { done = await collect(f); return done.candidate?.stopProof != null && done.terminal !== null; });
    // The worker may outlive its lease release by a moment; an answer that read its liveness would refuse that moment.
    // mutation: no early answer for a proved sealed run -> the liveness check reads undetermined and refuses, red
    const answer = await settleLostWorker(f.envelope, { readStart: async () => null, liveness: () => ({ verdict: "alive" }) });
    expect(answer.candidate).toEqual(done.candidate);
  });
});

// Orca tester follow-up I (review of #273, missing test): settle-lost-worker stopped right after it wrote the worker-lost
// failed state, before the rest of its settlement. Run again, it completes the settlement, and the killed call's usage is
// still booked unknown -- the second call finds the state already terminal and must not take it for a run that ended by itself.
describe("a settle-lost-worker interrupted after writing the failed state (Orca tester follow-up I)", { timeout: 180_000 }, () => {
  it("is completed by running it again, the killed call's usage still unknown", async () => {
    const { f, worker } = await hung("execute");
    await killWorker(worker);
    const crash = join(f.root, "crash-settle");
    const child = spawn(binary, ["control", "settle-lost-worker", "--agents", f.tablePath], { stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, NODE_ENV: "test", CCLOOP_CONTROL_TEST_CRASH_POINT: "worker-lost-state-written", CCLOOP_CONTROL_TEST_CRASH_MARKER: crash } });
    pids.push(child.pid!); child.stdin.end(JSON.stringify({ input: f.envelope }));
    await waitFor("the settlement to stop after the failed state", () => readFile(crash, "utf8").then(() => true, () => false));
    child.kill("SIGKILL"); await waitFor("the settlement to exit", () => !alive(child.pid!));
    const interrupted = JSON.parse(await readFile(join(f.sourceDir, "run", "loop-state.json"), "utf8"));
    expect(interrupted).toMatchObject({ status: "failed", failureCause: { cause: "worker-lost", phase: "execute" } });
    expect((await collect(f)).candidate).toBeNull();
    // The killed process held accepted.lock; ccloop has no stale-lock recovery for it (reported, not changed here), so the
    // lock file it left is removed by hand, standing in for that recovery.
    await rm(join(f.sourceDir, "control", "accepted.lock"), { force: true });

    const settled = await call(f, "settle-lost-worker", { input: f.envelope });
    expect(settled.code, settled.stderr).toBe(0);
    expect(JSON.parse(settled.stdout).candidate).toMatchObject({ result: "failed", terminalOutcome: "failed", stopProof: { isolated: true } });
    const done = await collect(f);
    expect(done.failureCause).toMatchObject({ cause: "worker-lost", phase: "execute" });
    // mutation: the worker-lost observation appended only when the state is moved -> the re-run books none and the last
    // work event carries the earlier call's known total, red
    expect(done.events.filter((e: { bucket: string }) => e.bucket === "work").at(-1).cumulative).toBeNull();
  });
});
