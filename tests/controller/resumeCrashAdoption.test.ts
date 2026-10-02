import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resumeLoop, ResumeNotEligibleError } from "../../src/controller/resumeLoop.js";
import { adoptCrashedRun } from "../../src/controller/adoptCrashedRun.js";
import { readOwnerRecord, readRunState } from "../../src/persistence/fileStore.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import { buildProcessInstanceId } from "../../src/runtime/processIdentity.js";
import { readProcessStart } from "../../src/ownership/ownerLiveness.js";
import { LEASE_TTL_MS } from "../../src/ownership/lease.js";
import type { LoopContract } from "../../src/contract/schema.js";

// Spec 2026-10-02 crash-resume §4.3: before this design, `resume` refused a SIGKILLed run with
// "cannot read run artifacts: ENOENT … owner-transfer.json", because only a live loop writes that
// file. These criteria pin the adoption path (no transfer record, owner confirmed dead), the
// reaping step every path now takes, and the Orca control-run guard.

const execFileAsync = promisify(execFile);

// Every real child this file starts; SIGKILLed (group and pid) after each test so a red test never
// leaves a `setInterval` process behind.
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

function createContract(repoPath: string): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix", successCondition: "pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["tests fail"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

function successFrame() {
  return {
    plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
    execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
    verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [] },
  };
}

// The id of a process that really existed and has really exited: what a SIGKILLed owner leaves.
async function deadOwnerId(): Promise<string> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return `pid:${child.pid}:${Date.now() - 1000}`;
}

const expiredLease = () => new Date(Date.now() - LEASE_TTL_MS - 1000).toISOString();

// The shape of resumeLoop.integration.test.ts' seedEligibleRun, WITHOUT owner-transfer.json and
// reconciliation-record.json: exactly what a run killed before any transfer leaves on disk.
async function seedKilledRun(
  runDir: string,
  contract: LoopContract,
  owner: { id: string; leaseAffirmedAt: string | null },
) {
  await mkdir(join(runDir, "attempts"), { recursive: true });
  await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
  await writeFile(join(runDir, "events.jsonl"), "");
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify({
    status: "executing", currentAttempt: 1, attemptsUsed: 1,
    lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 2, timeRemainingMs: 5000, tokenBudgetRemaining: 1000 },
    recentFailures: [],
  }));
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
    runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
    currentProcessInstanceId: owner.id, lastAffirmedAt: "2026-07-25T00:00:00.000Z",
    ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: owner.leaseAffirmedAt,
  }));
}

// resumeLoop.integration.test.ts' seedEligibleRun, verbatim in content: a run that already carries
// a loop-published transfer (controller ruling R1 keeps today's lease-only rule for it).
async function seedEligibleRun(runDir: string, contract: LoopContract) {
  await seedKilledRun(runDir, contract, { id: "pid:100", leaseAffirmedAt: null });
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
    runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:100", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
    ownerStatus: "current", supersededByEpoch: null,
  }));
  await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify({
    priorOwnerEpoch: 1, newOwnerEpoch: 2, priorProcessInstanceId: "pid:100",
    newProcessInstanceId: "pid:100", transferredAt: "2026-07-25T00:00:00.000Z",
    reason: "owner lost", eligibleForContinuation: true,
  }));
  await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify({
    staleSuspicionBasis: [], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute", conflictingEvidence: [],
    takeoverPermission: { allowed: true, reason: "ok" },
    priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true,
  }));
}

// A detached, SIGTERM-honouring node child registered as an unfinished claude call of this run
// (process.json, request.json, no outcome.json): the orphan a SIGKILLed loop leaves behind.
// Resolves only after the child is up, so its lstart can be read and recorded.
async function seedOrphanGroup(runDir: string): Promise<number> {
  const marker = join(await mkdtemp(join(tmpdir(), "adopt-ready-")), "ready");
  const code = `require('fs').writeFileSync(${JSON.stringify(marker)},'1'); setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
  child.unref();
  pids.push(child.pid!);
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {
    ready = await readFile(marker, "utf8").then(() => true, () => false);
    if (!ready) await new Promise((r) => setTimeout(r, 25));
  }
  if (!ready) throw new Error("test child never became ready");
  const dir = join(runDir, "claude", "1", "execute", "call-orphan");
  await mkdir(dir, { recursive: true });
  const startedAt = await readProcessStart(child.pid!);
  if (startedAt === null) throw new Error("could not read the test child's start time");
  await writeFile(join(dir, "process.json"), JSON.stringify({ pid: child.pid, pgid: child.pid, startedAt, phase: "execute" }));
  await writeFile(join(dir, "request.json"), "{}");
  return child.pid!;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function readEvents(runDir: string): Promise<Array<{ type: string; detail: string }>> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; detail: string });
}
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

// Every file under runDir except events.jsonl, as relative path -> content.
async function snapshot(runDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (relative(runDir, path) !== "events.jsonl") out[relative(runDir, path)] = await readFile(path, "utf8");
    }
  }
  await walk(runDir);
  return out;
}

async function refusalOf(promise: Promise<unknown>): Promise<ResumeNotEligibleError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ResumeNotEligibleError);
  return error as ResumeNotEligibleError;
}

async function newRunDir(): Promise<{ runDir: string; contract: LoopContract }> {
  const contract = createContract(await createRepo());
  return { runDir: await mkdtemp(join(tmpdir(), "ccloop-run-")), contract };
}

describe("resume adopts a killed run (spec 2026-10-02 crash-resume §4.3)", () => {
  it("T6: adopts a killed run and continues it to succeeded", async () => {
    const { runDir, contract } = await newRunDir();
    const ownerId = await deadOwnerId();
    await seedKilledRun(runDir, contract, { id: ownerId, leaseAffirmedAt: expiredLease() });

    const finalState = await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    expect(finalState.status).toBe("succeeded");
    const types = (await readEvents(runDir)).map((e) => e.type);
    expect(types.filter((t) => t === "owner_crash_adopted")).toHaveLength(1);
    expect(types.indexOf("owner_crash_adopted")).toBeLessThan(types.indexOf("resume_adopted"));
    expect(types).not.toContain("resume_denied");
    const adoptedEvent = (await readEvents(runDir)).find((e) => e.type === "owner_crash_adopted")!;
    expect(adoptedEvent.detail.startsWith(`epoch 2 -> 3: ${ownerId} confirmed dead (`)).toBe(true);

    const owner = await readJson(join(runDir, "owner-record.json"));
    expect(owner.currentOwnerEpoch).toBe(3);
    expect(owner.currentProcessInstanceId).toBe(buildProcessInstanceId());
    const transfer = await readJson(join(runDir, "owner-transfer.json"));
    expect(transfer).toMatchObject({
      priorOwnerEpoch: 2, newOwnerEpoch: 3, priorProcessInstanceId: ownerId,
      newProcessInstanceId: buildProcessInstanceId(), reason: "owner process confirmed dead by resume",
      eligibleForContinuation: true,
    });
    const reconciliation = await readJson(join(runDir, "reconciliation-record.json"));
    expect(reconciliation).toMatchObject({
      staleConfirmed: true, ownershipVerdict: "OWNER_LOST", lastTrustedBoundary: "execute",
      conflictingEvidence: [], takeoverPermission: { allowed: true, reason: "owner process confirmed dead by resume" },
      priorOwnerEpoch: 2, newOwnerEpoch: 3, eligibleForContinuation: true,
    });
    const basis = reconciliation.staleSuspicionBasis as string[];
    expect(basis).toHaveLength(2);
    expect(basis[0]!.startsWith("lease not fresh (leaseAffirmedAt ")).toBe(true);
  });

  it("adopts a killed run whose lease was never affirmed (Review Focus 1)", async () => {
    const { runDir, contract } = await newRunDir();
    await seedKilledRun(runDir, contract, { id: await deadOwnerId(), leaseAffirmedAt: null });

    const finalState = await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    expect(finalState.status).toBe("succeeded");
    expect((await readEvents(runDir)).map((e) => e.type)).toContain("owner_crash_adopted");
    const basis = (await readJson(join(runDir, "reconciliation-record.json"))).staleSuspicionBasis as string[];
    expect(basis[0]).toBe("lease not fresh (leaseAffirmedAt null)");
  });

  it("refuses when the owner is alive (pid = this process)", async () => {
    const { runDir, contract } = await newRunDir();
    await seedKilledRun(runDir, contract, { id: buildProcessInstanceId(), leaseAffirmedAt: expiredLease() });
    const before = await snapshot(runDir);

    const refusal = await refusalOf(resumeLoop(runDir, new ScriptedAdapter([successFrame()])));

    expect(refusal.message).toContain("alive");
    expect(refusal.message.startsWith("no owner transfer and the owner is alive: ")).toBe(true);
    expect(await snapshot(runDir)).toEqual(before);
    const events = await readEvents(runDir);
    expect(events.map((e) => e.type)).not.toContain("owner_crash_adopted");
    expect(events.filter((e) => e.type === "resume_denied").map((e) => e.detail)).toEqual([refusal.message]);
  });

  // Controller ruling, Task 6 fix round 1: on the adoption path the owner is classified BEFORE reaping. A resume
  // that refuses because the owner may be alive (stalled heartbeat, SIGSTOP, wake from sleep) must not have
  // SIGTERMed that live owner's claude call on the way.
  it("refuses a no-transfer run whose owner is alive without reaping its registered group", async () => {
    const { runDir, contract } = await newRunDir();
    await seedKilledRun(runDir, contract, { id: buildProcessInstanceId(), leaseAffirmedAt: expiredLease() });
    const group = await seedOrphanGroup(runDir);
    const before = await snapshot(runDir);

    const refusal = await refusalOf(resumeLoop(runDir, new ScriptedAdapter([successFrame()])));

    expect(refusal.message.startsWith("no owner transfer and the owner is alive: ")).toBe(true);
    expect(alive(group)).toBe(true);
    const types = (await readEvents(runDir)).map((e) => e.type);
    expect(types).not.toContain("orphan_process_group_reaped");
    expect(types).not.toContain("owner_crash_adopted");
    expect(await snapshot(runDir)).toEqual(before);
  });

  it("refuses a legacy owner id", async () => {
    const { runDir, contract } = await newRunDir();
    await seedKilledRun(runDir, contract, { id: "pid:100", leaseAffirmedAt: expiredLease() });
    const before = await snapshot(runDir);

    const refusal = await refusalOf(resumeLoop(runDir, new ScriptedAdapter([successFrame()])));

    expect(refusal.message.startsWith("no owner transfer and the owner is undetermined: ")).toBe(true);
    expect(await snapshot(runDir)).toEqual(before);
  });

  it("T9: two concurrent resumes adopt exactly once", async () => {
    const { runDir, contract } = await newRunDir();
    await seedKilledRun(runDir, contract, { id: await deadOwnerId(), leaseAffirmedAt: expiredLease() });

    const results = await Promise.allSettled([
      resumeLoop(runDir, new ScriptedAdapter([successFrame()])),
      resumeLoop(runDir, new ScriptedAdapter([successFrame()])),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ResumeNotEligibleError);
    const types = (await readEvents(runDir)).map((e) => e.type);
    expect(types.filter((t) => t === "owner_crash_adopted")).toHaveLength(1);
    expect(types.filter((t) => t === "resume_adopted")).toHaveLength(1);
    expect((await readJson(join(runDir, "owner-record.json"))).currentOwnerEpoch).toBe(3);
  });

  it("T9b: replaces a reconciliation record left without a transfer and says so", async () => {
    const { runDir, contract } = await newRunDir();
    await seedKilledRun(runDir, contract, { id: await deadOwnerId(), leaseAffirmedAt: expiredLease() });
    // What a contended earlier transfer leaves: a reconciliation verdict with no epoch to name.
    await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify({
      staleSuspicionBasis: ["lease expired"], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute", conflictingEvidence: [],
      takeoverPermission: { allowed: false, reason: "transfer contended" },
      priorOwnerEpoch: 2, newOwnerEpoch: null, eligibleForContinuation: false,
    }));

    const finalState = await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    expect(finalState.status).toBe("succeeded");
    const adopted = (await readEvents(runDir)).filter((e) => e.type === "owner_crash_adopted");
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.detail).toContain("replaced");
    expect(await readJson(join(runDir, "reconciliation-record.json"))).toMatchObject({ newOwnerEpoch: 3, eligibleForContinuation: true });
  });

  it("T9c: a run with a transfer and a live unfinished registered group: reaped, then resumed", async () => {
    const { runDir, contract } = await newRunDir();
    await seedEligibleRun(runDir, contract);
    const orphan = await seedOrphanGroup(runDir);
    expect(alive(orphan)).toBe(true);

    const finalState = await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    expect(finalState.status).toBe("succeeded");
    expect(alive(orphan)).toBe(false);
    const events = await readEvents(runDir);
    const types = events.map((e) => e.type);
    expect(events.filter((e) => e.type === "orphan_process_group_reaped").map((e) => e.detail))
      .toEqual([`pid ${orphan} pgid ${orphan} phase execute`]);
    expect(types.indexOf("orphan_process_group_reaped")).toBeLessThan(types.indexOf("resume_adopted"));
    // R1: a run that already carries a transfer never meets the owner check (its owner is pid:100).
    expect(types).not.toContain("owner_crash_adopted");
  });

  it("T6b: a killed run with a live orphan group: reaped, orphan_process_group_reaped recorded, then adopted", async () => {
    const { runDir, contract } = await newRunDir();
    await seedKilledRun(runDir, contract, { id: await deadOwnerId(), leaseAffirmedAt: expiredLease() });
    const orphan = await seedOrphanGroup(runDir);

    const finalState = await resumeLoop(runDir, new ScriptedAdapter([successFrame()]));

    expect(finalState.status).toBe("succeeded");
    expect(alive(orphan)).toBe(false);
    const types = (await readEvents(runDir)).map((e) => e.type);
    expect(types.filter((t) => t === "orphan_process_group_reaped")).toHaveLength(1);
    expect(types.indexOf("orphan_process_group_reaped")).toBeLessThan(types.indexOf("owner_crash_adopted"));
    expect(types.indexOf("owner_crash_adopted")).toBeLessThan(types.indexOf("resume_adopted"));
  });

  it("T9d: refuses an Orca control run", async () => {
    const contract = createContract(await createRepo());
    const sourceDir = await mkdtemp(join(tmpdir(), "ccloop-orca-source-"));
    await mkdir(join(sourceDir, "control"));
    const runDir = join(sourceDir, "run");
    await seedKilledRun(runDir, contract, { id: await deadOwnerId(), leaseAffirmedAt: expiredLease() });
    // An orphan in the control run too: the guard comes before reaping, so Orca's group is left
    // for Orca's own recovery.
    const orphan = await seedOrphanGroup(runDir);
    const before = await snapshot(runDir);

    const refusal = await refusalOf(resumeLoop(runDir, new ScriptedAdapter([successFrame()])));

    expect(refusal.message).toBe("run directory belongs to an Orca control store; Orca recovers it");
    expect(alive(orphan)).toBe(true);
    expect(await snapshot(runDir)).toEqual(before);
    const events = await readEvents(runDir);
    expect(events.map((e) => e.type)).toEqual(["resume_requested", "lease_expired_observed", "resume_denied"]);
    expect(events[2]!.detail).toBe(refusal.message);
  });

  it("a second resume after adoption takes today's path (Review Focus 3)", async () => {
    const { runDir, contract } = await newRunDir();
    await seedKilledRun(runDir, contract, { id: await deadOwnerId(), leaseAffirmedAt: expiredLease() });
    expect((await resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).status).toBe("succeeded");

    const refusal = await refusalOf(resumeLoop(runDir, new ScriptedAdapter([successFrame()])));

    expect(refusal.message).toBe("run status succeeded is not resumable");
    expect((await readEvents(runDir)).filter((e) => e.type === "owner_crash_adopted")).toHaveLength(1);
  });

  // Task 6 fix round 1: once the transfer write has committed, a failure to record owner_crash_adopted is its own
  // refusal, not a lock/CAS failure (which would claim no write happened).
  it("reports an event failure after a committed adoption write as its own refusal", async () => {
    const { runDir, contract } = await newRunDir();
    await seedKilledRun(runDir, contract, { id: await deadOwnerId(), leaseAffirmedAt: expiredLease() });
    await rm(join(runDir, "events.jsonl"));
    await mkdir(join(runDir, "events.jsonl")); // appendFile on a directory fails with EISDIR

    const result = await adoptCrashedRun(runDir, await readOwnerRecord(runDir), await readRunState(runDir), "owner pid 1 does not exist");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason.startsWith("adoption committed but its event could not be recorded: ")).toBe(true);
    expect((await readJson(join(runDir, "owner-transfer.json"))).newOwnerEpoch).toBe(3);
  });
});
