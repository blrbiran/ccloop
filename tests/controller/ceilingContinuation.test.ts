// A live-ceiling stop keeps its paid work (Orca #478; Orca spec docs/superpowers/specs/2026-11-25-ceiling-stop-keeps-work-design.md
// §5.1, criteria §6 1-5). A run Orca stops at its live ceiling for a cause Orca can lift (group, pause-line) has paid for its
// plan and often for an execute that already wrote files. If the stop's candidate lists the interrupted phase's file as
// missing and carries no allowance continuation, Orca cannot continue it and the next run re-pays the plan from scratch
// (the tester paid 2.97M tokens for nothing). So a resumable stop must still end `exhausted` with `liveCeilingStop` (Orca's
// ceiling settle keys on both), carry exactly the paid evidence for the phase it resumes at, list nothing of the
// interrupted phase as missing, and its continuation must resume that phase -- in the same attempt, so a task on its last
// attempt is not refused -- with one note when the phase was cut mid-call. A stop that is not resumable stays as before.
//
// The worker is mirrored in `stopRun` (usage observations per settled phase, the ledger capture, the packet); the reader and
// the workspace restore are the real ones, fed a resume bundle shaped as Orca's archive builds it (snapshot v2 pinned at
// refs/orca/runs/<predecessor>).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveCeiling } from "../../src/budget/liveCeiling.js";
import type { TokenPolicy } from "../../src/budget/tokenPolicy.js";
import { readEvidence } from "../../src/control/evidence.js";
import { buildHandoffPacket, type HandoffPacketV1 } from "../../src/control/handoff.js";
import { readAllowanceContinuation } from "../../src/control/materialize.js";
import type { ArtifactRefV1, InputCheckpointV1, LoopStartEnvelope } from "../../src/control/protocol.js";
import { appendUsageObservation, captureKnownWorkUsageLedger, readUsageEvents } from "../../src/control/usage.js";
import { runLoop, type RunControlHooks } from "../../src/controller/runLoop.js";
import type { AttemptContext, RuntimeAdapter } from "../../src/runtime/types.js";
import type { RunState } from "../../src/state/types.js";
import { registerAttemptRefNamespace } from "../../src/workspace/worktreeManager.js";
import { fixture } from "../control/optionalFixture.js";
import { createContract, createRepo } from "./optionalFixture.js";

const STOP_REASON = "live token ceiling reached";
const CEILING_RESUME_NOTE = "The previous run of this phase stopped at the token ceiling before it finished. The worktree already holds its changes: review them and finish the phase; do not start over.";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const PLAN = { summary: "edit", primaryTargetPaths: ["src/a.ts"], tokenUsage: 10 };
const EXECUTION = { changedFiles: ["src/a.ts"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "", tokenUsage: 10 };
const APPROVED = { approved: true, rejectCategory: "", primaryTargetPaths: ["src/a.ts"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [], tokenUsage: 10 };
const REJECTED = { ...APPROVED, approved: false, rejectCategory: "fix", safeToRetry: true, evidence: ["still red"] };

/** A phase that streams `tokens` and keeps running until the ceiling stops it. */
async function streamUntilStopped(context: AttemptContext, tokens: number): Promise<void> {
  context.onObservedUsage!(tokens);
  const signal = context.abortSignal!;
  if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}
const write = (context: AttemptContext, text = "export const a = 1;\n") => writeFile(join(context.worktreePath, "src", "a.ts"), text);

type Stopped = {
  root: string; repo: string; runId: string; state: RunState; envelope: LoopStartEnvelope; contract: ReturnType<typeof createContract>;
  packet: HandoffPacketV1; handoff: ArtifactRefV1; missing: string[]; events: Array<{ type: string; detail: string }>;
  tokens: number; activeMs: number; tokenPolicy: TokenPolicy | undefined;
};

type RunOptions = {
  repo?: string; runId?: string; ceiling: number; baseTokens?: number; cause?: LiveCeiling["cause"]; maxAttempts?: number;
  tokenPolicy?: TokenPolicy | null; protocol?: 3 | 4; contract?: (contract: ReturnType<typeof createContract>) => void;
  continueFrom?: { input: InputCheckpointV1; root: string }; hooks?: Partial<RunControlHooks>;
};

const POLICY: TokenPolicy = { authoredTokenCeiling: null, bindingCauses: ["group"], inheritedUsage: { tokens: 0, activeMs: 0, attempts: 0, sessions: 0 } };

/** Runs the loop as the control worker does and builds the candidate's packet from what it left. */
async function stopRun(adapter: RuntimeAdapter, options: RunOptions): Promise<Stopped> {
  const repo = options.repo ?? await realpath(await createRepo());
  if (options.repo === undefined) roots.push(repo);
  const runId = options.runId ?? "run-a";
  let root: string;
  let envelope: LoopStartEnvelope;
  if (options.continueFrom === undefined) {
    const f = await fixture(); root = f.root; envelope = f.envelope; roots.push(root);
  } else {
    root = options.continueFrom.root; envelope = (await fixture()).envelope;
  }
  const contract = createContract(repo, ["true"], null);
  contract.verification.verifierType = "agent";
  contract.executionPolicy.maxAttempts = options.maxAttempts ?? 3;
  options.contract?.(contract);
  const tokenPolicy = options.tokenPolicy === null ? undefined : options.tokenPolicy ?? POLICY;
  Object.assign(envelope, { protocol: options.protocol ?? 4, ...(tokenPolicy === undefined ? {} : { tokenPolicy }), inputCheckpoint: options.continueFrom?.input ?? null });
  envelope.claim.runId = runId;
  envelope.work.contract = contract;
  envelope.work.sourceDir = root;
  const runDir = join(root, "run");
  registerAttemptRefNamespace(runDir, runId);
  let cumulative = 0, known = true, activeMs = 0;
  const ceiling: LiveCeiling = { protocol: 1, revision: 1, tokens: options.ceiling, cause: options.cause ?? "group" };
  const state = await runLoop(contract, runDir, adapter, {
    ...(tokenPolicy === undefined ? {} : { tokenPolicy, workGrant: { tokens: null, activeMs: 60_000, attempts: contract.executionPolicy.maxAttempts, sessions: 1 } }),
    liveCeiling: { current: () => ceiling, baseTokens: options.baseTokens ?? 0 },
    ...(options.continueFrom === undefined ? {} : { firstWorkspaceInput: options.continueFrom.input, allowanceContinuation: await readAllowanceContinuation(envelope) }),
    onPhaseSettled: async (o) => {
      if (o.tokenUsage === null) known = false; else cumulative += o.tokenUsage;
      activeMs += o.elapsedMs;
      await appendUsageObservation(root, { runId, generation: envelope.claim.generation, bucket: "work", observationId: `attempt-${o.attempt}-${o.phase}`,
        threadTotalTokens: known ? cumulative : null, elapsedMs: o.elapsedMs, attempts: o.attempt, sessions: 1, evidence: { phase: o.phase }, phase: o.phase });
    },
    ...options.hooks,
  } as RunControlHooks);
  const usageEvents = await readUsageEvents(root);
  const predicted = (usageEvents.at(-1)?.eventSeq ?? 0) + 1;
  const usage = await captureKnownWorkUsageLedger(root, { runId, generation: envelope.claim.generation, usageHighWater: predicted }).catch(() => undefined);
  const built = await buildHandoffPacket(envelope, null, state, predicted, "partial", usage);
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; detail: string });
  return { root, repo, runId, state, envelope, contract, packet: built.packet, handoff: built.handoff, missing: built.missing, events, tokens: cumulative, activeMs, tokenPolicy };
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const git = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, ...args]).toString().trim();

/**
 * The resume bundle Orca's archive gives the next run: the checkpoint names the stop's handoff and a snapshot v2 of the
 * attempt pinned at refs/orca/runs/<predecessor>. `tamper` edits the saved run state (packet and its state artifact alike).
 */
async function bundleFrom(stopped: Stopped, tamper?: (state: Record<string, any>) => void): Promise<{ input: InputCheckpointV1; root: string }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const files = new Map<string, Buffer>();
  const put = (bytes: Buffer): ArtifactRefV1 => { const hash = sha256(bytes); const ref = { artifactId: `sha256-${hash}`, hash }; files.set(ref.artifactId, bytes); return ref; };
  const packet = structuredClone(stopped.packet) as HandoffPacketV1 & { allowanceContinuation?: Record<string, ArtifactRefV1 | null | string> };
  for (const ref of packet.artifacts) files.set(ref.artifactId, await readEvidence(stopped.root, ref));
  if (tamper !== undefined && packet.allowanceContinuation !== undefined) {
    tamper(packet.runState as never);
    const state = put(Buffer.from(JSON.stringify(packet.runState)));
    packet.allowanceContinuation.state = state; packet.artifacts.push(state);
  }
  const handoff = tamper === undefined ? (files.set(stopped.handoff.artifactId, await readEvidence(stopped.root, stopped.handoff)), stopped.handoff) : put(Buffer.from(JSON.stringify(packet)));
  const attempt = git(stopped.repo, "rev-parse", `refs/ccloop/${stopped.runId}/attempts/${stopped.state.currentAttempt}`);
  const base = git(stopped.repo, "rev-parse", `${attempt}^`);
  const pin = `refs/orca/runs/${stopped.runId}`;
  git(stopped.repo, "update-ref", pin, attempt);
  const bundleFile = join(stopped.root, `${stopped.runId}.bundle`);
  git(stopped.repo, "bundle", "create", "-q", bundleFile, `${base}..${pin}`);
  const bundle = put(await readFile(bundleFile));
  const snapshot = put(Buffer.from(JSON.stringify({ version: 2, objectFormat: "sha1", base, attempt, tree: git(stopped.repo, "rev-parse", `${attempt}^{tree}`),
    head: base, ref: pin, source: "ccloop-live", bundle, missing: [] })));
  const checkpointBytes = Buffer.from(JSON.stringify({ checkpointId: "cp1", snapshot, handoff }));
  const checkpoint = { artifactId: `checkpoint-cp1-${sha256(checkpointBytes)}`, hash: sha256(checkpointBytes) };
  const next = (await fixture()).root; roots.push(next);
  const bundlePath = join(next, "input", "cp1");
  await mkdir(join(bundlePath, "artifacts"), { recursive: true, mode: 0o700 });
  await writeFile(join(bundlePath, "checkpoint.json"), checkpointBytes, { mode: 0o600 });
  const artifacts = [{ ref: checkpoint, file: "checkpoint.json" }];
  for (const [artifactId, bytes] of files) {
    const file = `artifacts/${artifactId}.bin`;
    await writeFile(join(bundlePath, file), bytes, { mode: 0o600 });
    artifacts.push({ ref: { artifactId, hash: sha256(bytes) }, file });
  }
  await writeFile(join(bundlePath, "resume-bundle.json"), JSON.stringify({ protocol: 1, predecessorRunId: stopped.runId, checkpointId: "cp1", checkpointHash: checkpoint.hash,
    checkpoint, snapshot, artifacts, unfinished: [], pendingDecisions: [], awaitingHuman: [] }), { mode: 0o600 });
  return { root: next, input: { predecessorRunId: stopped.runId, checkpointId: "cp1", checkpointHash: checkpoint.hash, bundlePath } };
}

/** The next run's token policy, as Orca must send it: tokens and time inherited whole; the resumed attempt counted once. */
function inheritedAfter(stopped: Stopped, resumesAttempt: boolean): TokenPolicy {
  const prior = stopped.tokenPolicy!.inheritedUsage;
  return { ...stopped.tokenPolicy!, inheritedUsage: { tokens: prior.tokens + stopped.tokens, activeMs: prior.activeMs + stopped.activeMs,
    attempts: prior.attempts + stopped.state.attemptsUsed - (resumesAttempt ? 1 : 0), sessions: prior.sessions + 1 } };
}

const interrupted = (s: Stopped) => s.events.filter((event) => event.type === "ceiling_interrupted").map((event) => event.detail);
const attemptMissing = (s: Stopped) => s.missing.filter((label) => label.startsWith("attempts/"));
type Carried = { nextPhase: string; plan: boolean; execution: boolean; verification: boolean };
const carried = (s: Stopped): Carried | undefined => {
  const c = s.packet.allowanceContinuation;
  return c === undefined ? undefined : { nextPhase: c.nextPhase, plan: c.plan !== null, execution: c.execution !== null, verification: c.verification !== null };
};
function expectResumable(s: Stopped, expected: Carried, event: string | null): void {
  expect(s.state.status).toBe("exhausted");
  expect(s.state.stopReason).toBe(STOP_REASON);
  expect(s.state.liveCeilingStop).toBeDefined();
  expect(carried(s)).toEqual(expected);
  expect(attemptMissing(s)).toEqual([]);
  expect(interrupted(s)).toEqual(event === null ? [] : [event]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Criterion 1: each site of the spec's §5.1 table.

describe("criterion 1: a resumable ceiling stop carries its continuation evidence", () => {
  it("before an attempt (boundary, after a rejection): plan of the next attempt with the rejection", async () => {
    // Attempt 1 spends 30 and is rejected; the ceiling (30) is reached before attempt 2 starts.
    const s = await stopRun({ plan: async () => PLAN, execute: async (c) => { await write(c); return EXECUTION; }, verify: async () => REJECTED }, { ceiling: 30 });
    expect(s.state.liveCeilingStop).toMatchObject({ phase: "plan", at: "boundary" });
    expect(s.state.attemptsUsed).toBe(1);
    expectResumable(s, { nextPhase: "plan", plan: false, execution: false, verification: true }, null);
  }, 30_000);

  it("plan mid-call on attempt 1: plan, nothing paid to carry", async () => {
    const s = await stopRun({ plan: async (c) => { await streamUntilStopped(c, 50); throw new Error("stopped"); }, execute: async () => EXECUTION, verify: async () => APPROVED }, { ceiling: 40 });
    expectResumable(s, { nextPhase: "plan", plan: false, execution: false, verification: false }, "plan in attempt 1");
  }, 30_000);

  it("plan mid-call on attempt 2: plan, with attempt 1's rejection", async () => {
    let plans = 0;
    const s = await stopRun({ plan: async (c) => { if (++plans === 2) { await streamUntilStopped(c, 50); throw new Error("stopped"); } return PLAN; },
      execute: async (c) => { await write(c); return EXECUTION; }, verify: async () => REJECTED }, { ceiling: 40 });
    expect(s.state.currentAttempt).toBe(2);
    expectResumable(s, { nextPhase: "plan", plan: false, execution: false, verification: true }, "plan in attempt 2");
  }, 30_000);

  it("before execute (boundary): execute with the plan", async () => {
    const s = await stopRun({ plan: async () => ({ ...PLAN, tokenUsage: 50 }), execute: async () => EXECUTION, verify: async () => APPROVED }, { ceiling: 40 });
    expect(s.state.liveCeilingStop).toMatchObject({ phase: "execute", at: "boundary" });
    expectResumable(s, { nextPhase: "execute", plan: true, execution: false, verification: false }, null);
  }, 30_000);

  it("execute mid-call with no result: execute with the plan", async () => {
    const s = await stopRun({ plan: async () => PLAN, execute: async (c) => { await write(c); await streamUntilStopped(c, 50); throw new Error("stopped"); }, verify: async () => APPROVED }, { ceiling: 40 });
    expectResumable(s, { nextPhase: "execute", plan: true, execution: false, verification: false }, "execute in attempt 1");
  }, 30_000);

  it("a runner-built partial execute result (it ended failed before): execute with the plan, and the run ends exhausted", async () => {
    const s = await stopRun({ plan: async () => PLAN, verify: async () => APPROVED,
      execute: async (c) => { await write(c); await streamUntilStopped(c, 50); return { ...EXECUTION, tokenUsage: 50, completionStatus: "partial", failureType: "error", failureMessage: "SIGTERM", partialOrigin: "runner" }; } }, { ceiling: 40 });
    expectResumable(s, { nextPhase: "execute", plan: true, execution: false, verification: false }, "execute in attempt 1");
  }, 30_000);

  it("an agent's own partial execute result sent toward verify: execute, never verify", async () => {
    const s = await stopRun({ plan: async () => PLAN, verify: async () => APPROVED,
      execute: async (c) => { await write(c); await streamUntilStopped(c, 50); return { ...EXECUTION, tokenUsage: 50, completionStatus: "partial", failureType: "error", failureMessage: "unfinished" }; } }, { ceiling: 40 });
    expectResumable(s, { nextPhase: "execute", plan: true, execution: false, verification: false }, "execute in attempt 1");
  }, 30_000);

  it("a complete execute result mid-call: verify with plan and execution", async () => {
    const s = await stopRun({ plan: async () => PLAN, verify: async () => APPROVED,
      execute: async (c) => { await write(c); await streamUntilStopped(c, 50); return { ...EXECUTION, tokenUsage: 50 }; } }, { ceiling: 40 });
    expect(s.state.liveCeilingStop).toMatchObject({ phase: "execute", at: "mid-call" });
    expectResumable(s, { nextPhase: "verify", plan: true, execution: true, verification: false }, null);
  }, 30_000);

  it("before verify (boundary): verify with plan and execution", async () => {
    const s = await stopRun({ plan: async () => PLAN, execute: async (c) => { await write(c); return { ...EXECUTION, tokenUsage: 50 }; }, verify: async () => APPROVED }, { ceiling: 40 });
    expect(s.state.liveCeilingStop).toMatchObject({ phase: "verify", at: "boundary" });
    expectResumable(s, { nextPhase: "verify", plan: true, execution: true, verification: false }, null);
  }, 30_000);

  it("verify mid-call: verify with plan and execution", async () => {
    const s = await stopRun({ plan: async () => PLAN, execute: async (c) => { await write(c); return EXECUTION; },
      verify: async (c) => { await streamUntilStopped(c, 50); throw new Error("stopped"); } }, { ceiling: 40 });
    expectResumable(s, { nextPhase: "verify", plan: true, execution: true, verification: false }, "verify in attempt 1");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Criterion 2: not resumable => the stop of before (no continuation, no event, no allowanceNextPhase; a partial still
// ends failed). Each case is the "execute mid-call" stop above with one condition broken.

describe("criterion 2: a stop that is not resumable is the stop of before", () => {
  const midExecute = (extra: (c: AttemptContext) => void = () => undefined): RuntimeAdapter => ({ plan: async () => PLAN, verify: async () => APPROVED,
    execute: async (c) => { await write(c); extra(c); await streamUntilStopped(c, 50); throw new Error("stopped"); } });
  function expectAsBefore(s: Stopped): void {
    expect(s.state.status).toBe("exhausted");
    expect(s.state.stopReason).toBe(STOP_REASON);
    expect(s.state.liveCeilingStop).toBeDefined();
    expect(s.state).not.toHaveProperty("allowanceNextPhase");
    expect(s.packet).not.toHaveProperty("allowanceContinuation");
    expect(interrupted(s)).toEqual([]);
    expect(s.missing).toContain("attempts/1/execution.json");
  }

  it("task-cap", async () => expectAsBefore(await stopRun(midExecute(), { ceiling: 40, cause: "task-cap" })), 30_000);
  it("no token policy", async () => expectAsBefore(await stopRun(midExecute(), { ceiling: 40, tokenPolicy: null })), 30_000);
  it("unknown observations", async () => expectAsBefore(await stopRun({ ...midExecute(), plan: async () => ({ summary: "edit", primaryTargetPaths: ["src/a.ts"] }) }, { ceiling: 40 })), 30_000);
  it("an open handoff request", async () => {
    const stopRequested = { requested: false };
    expectAsBefore(await stopRun(midExecute(() => { stopRequested.requested = true; }), { ceiling: 40, hooks: { stopRequested } }));
  }, 30_000);
  it("a multi-directory run", async () => {
    const extra = await realpath(await createRepo()); roots.push(extra);
    expectAsBefore(await stopRun(midExecute(), { ceiling: 40, contract: (contract) => {
      Object.assign(contract.context, { repoKey: "app", additionalRepos: [{ key: "lib", repoPath: extra, targetPaths: ["src"] }] });
    } }));
  }, 30_000);
  it("protocol 3 (the packet carries no continuation even for a resumable state)", async () => {
    const s = await stopRun(midExecute(), { ceiling: 40, protocol: 3 });
    expect(s.packet).not.toHaveProperty("allowanceContinuation");
    expect(s.missing).toContain("attempts/1/execution.json");
  }, 30_000);
  it("a stop before the first attempt", async () => {
    const s = await stopRun(midExecute(), { ceiling: 40, baseTokens: 40 });
    expect(s.state.attemptsUsed).toBe(0);
    expect(s.state).not.toHaveProperty("allowanceNextPhase");
    expect(s.packet).not.toHaveProperty("allowanceContinuation");
  }, 30_000);
  it("a task-cap partial execute result still ends failed", async () => {
    const s = await stopRun({ plan: async () => PLAN, verify: async () => APPROVED,
      execute: async (c) => { await write(c); await streamUntilStopped(c, 50); return { ...EXECUTION, tokenUsage: 50, completionStatus: "partial", failureType: "error", failureMessage: "SIGTERM", partialOrigin: "runner" }; } }, { ceiling: 40, cause: "task-cap" });
    expect(s.state.status).toBe("failed");
    expect(s.packet).not.toHaveProperty("allowanceContinuation");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Criteria 3-5: the continuation.

describe("criterion 3: the continuation resumes the interrupted phase, same attempt, with a note", () => {
  it("a 1-attempt task stopped mid-execute resumes execute, not plan, on the interrupted tree, and is not refused for attempts", async () => {
    const a = await stopRun({ plan: async () => PLAN, verify: async () => APPROVED,
      execute: async (c) => { await write(c, "export const a = 'interrupted';\n"); await streamUntilStopped(c, 50); throw new Error("stopped"); } }, { ceiling: 40, maxAttempts: 1 });
    expect(a.state.budgetSnapshot.attemptsRemaining).toBe(0);
    const next = await bundleFrom(a);
    const calls: string[] = [];
    let seenTree = "", seenNotes: unknown;
    const b = await stopRun({
      plan: async () => { calls.push("plan"); return PLAN; },
      execute: async (c) => { calls.push("execute"); seenTree = await readFile(join(c.worktreePath, "src", "a.ts"), "utf8"); seenNotes = c.liveNotes; await write(c, "export const a = 'done';\n"); return EXECUTION; },
      verify: async () => { calls.push("verify"); return APPROVED; },
    }, { repo: a.repo, runId: "run-b", ceiling: 10_000, maxAttempts: 1, tokenPolicy: inheritedAfter(a, true), continueFrom: next });
    expect(calls).toEqual(["execute", "verify"]);
    expect(seenTree).toBe("export const a = 'interrupted';\n");
    expect((seenNotes as Array<{ text: string }>).map((n) => n.text)).toEqual([CEILING_RESUME_NOTE]);
    expect(b.state.status).toBe("succeeded");
    expect(b.state.attemptsUsed + inheritedAfter(a, true).inheritedUsage.attempts).toBe(1);
  }, 60_000);

  it("a continuation from a boundary stop carries no note", async () => {
    const a = await stopRun({ plan: async () => ({ ...PLAN, tokenUsage: 50 }), execute: async () => EXECUTION, verify: async () => APPROVED }, { ceiling: 40, maxAttempts: 1 });
    const next = await bundleFrom(a);
    let seen: AttemptContext | undefined;
    const b = await stopRun({ plan: async () => { throw new Error("plan replayed"); }, execute: async (c) => { seen = c; await write(c); return EXECUTION; }, verify: async () => APPROVED },
      { repo: a.repo, runId: "run-b", ceiling: 10_000, maxAttempts: 1, tokenPolicy: inheritedAfter(a, true), continueFrom: next });
    expect(b.state.status).toBe("succeeded");
    expect(seen).not.toHaveProperty("liveNotes");
  }, 60_000);

  it("the lineage counts the resumed attempt once, never zero times", async () => {
    const a = await stopRun({ plan: async () => PLAN, verify: async () => APPROVED,
      execute: async (c) => { await write(c); await streamUntilStopped(c, 50); throw new Error("stopped"); } }, { ceiling: 40, maxAttempts: 1 });
    const next = await bundleFrom(a);
    const policy = inheritedAfter(a, true);
    const envelope = { ...a.envelope, claim: { ...a.envelope.claim, runId: "run-b" }, inputCheckpoint: next.input, tokenPolicy: { ...policy, inheritedUsage: { ...policy.inheritedUsage, attempts: policy.inheritedUsage.attempts - 1 } } };
    await expect(readAllowanceContinuation(envelope as never)).rejects.toThrow("control-allowance-lineage-invalid");
  }, 60_000);

  it("a boundary stop before a new attempt resumes a new attempt: its attempt is not refunded", async () => {
    const a = await stopRun({ plan: async () => PLAN, execute: async (c) => { await write(c); return EXECUTION; }, verify: async () => REJECTED }, { ceiling: 30 });
    const next = await bundleFrom(a);
    const envelope = { ...a.envelope, claim: { ...a.envelope.claim, runId: "run-b" }, inputCheckpoint: next.input, tokenPolicy: inheritedAfter(a, true) };
    await expect(readAllowanceContinuation(envelope as never)).rejects.toThrow("control-allowance-lineage-invalid");
    expect((await readAllowanceContinuation({ ...envelope, tokenPolicy: inheritedAfter(a, false) } as never))?.nextPhase).toBe("plan");
  }, 60_000);
});

describe("criterion 4: a second ceiling inside a continuation is resumable again", () => {
  it("stopped mid-execute, then mid-verify twice, then the verify finishes; no phase is paid twice", async () => {
    const execute = async (c: AttemptContext) => { await write(c); await streamUntilStopped(c, 50); throw new Error("stopped"); };
    let previous = await stopRun({ plan: async () => PLAN, execute, verify: async () => APPROVED }, { ceiling: 40, maxAttempts: 1 });
    const calls: string[] = [];
    const stopVerify = async (c: AttemptContext) => { calls.push("verify"); await streamUntilStopped(c, 50); throw new Error("stopped"); };
    for (const [runId, adapter] of [
      ["run-b", { plan: async () => { throw new Error("plan replayed"); }, execute: async (c: AttemptContext) => { calls.push("execute"); await write(c); return EXECUTION; }, verify: stopVerify }],
      ["run-c", { plan: async () => { throw new Error("plan replayed"); }, execute: async () => { throw new Error("execute replayed"); }, verify: stopVerify }],
    ] as const) {
      const next = await bundleFrom(previous);
      previous = await stopRun(adapter, { repo: previous.repo, runId, ceiling: 40, maxAttempts: 1, tokenPolicy: inheritedAfter(previous, true), continueFrom: next });
      expectResumable(previous, { nextPhase: "verify", plan: true, execution: true, verification: false }, "verify in attempt 1");
    }
    const next = await bundleFrom(previous);
    let notes: unknown;
    const last = await stopRun({ plan: async () => { throw new Error("plan replayed"); }, execute: async () => { throw new Error("execute replayed"); },
      verify: async (c) => { calls.push("verify"); notes = c.liveNotes; return APPROVED; } },
      { repo: previous.repo, runId: "run-d", ceiling: 10_000, maxAttempts: 1, tokenPolicy: inheritedAfter(previous, true), continueFrom: next });
    expect(last.state.status).toBe("succeeded");
    expect(calls).toEqual(["execute", "verify", "verify", "verify"]);
    expect((notes as Array<{ text: string }>).map((n) => n.text)).toEqual([CEILING_RESUME_NOTE]);
  }, 120_000);
});

describe("criterion 5: plan without the rejection is accepted only for a ceiling stop on attempt 1", () => {
  it("accepted for the attempt-1 plan stop; refused once the saved state says attempt 2 or is a plain allowance park", async () => {
    const a = await stopRun({ plan: async (c) => { await streamUntilStopped(c, 50); throw new Error("stopped"); }, execute: async () => EXECUTION, verify: async () => APPROVED }, { ceiling: 40 });
    const reader = async (next: { input: InputCheckpointV1 }, resumes = true) => readAllowanceContinuation({ ...a.envelope, claim: { ...a.envelope.claim, runId: "run-b" }, inputCheckpoint: next.input, tokenPolicy: inheritedAfter(a, resumes) } as never);
    expect(await reader(await bundleFrom(a))).toMatchObject({ nextPhase: "plan", plan: null, execution: null });
    // Each tamper is otherwise valid, so the refusal is the missing rejection itself (its null ref is unreachable).
    await expect(reader(await bundleFrom(a, (state) => { state.currentAttempt = 2; }))).rejects.toThrow("control-allowance-evidence-unreachable");
    await expect(reader(await bundleFrom(a, (state) => { delete state.liveCeilingStop; state.waitingCause = "token-allowance"; state.status = "blocked_waiting_human";
      state.budgetSnapshot = { ...state.budgetSnapshot, attemptsRemaining: 2, tokenBudgetRemaining: 0, tokenRemainingStatus: "known" }; }), false)).rejects.toThrow("control-allowance-evidence-unreachable");
    await expect(reader(await bundleFrom(a, (state) => { state.liveCeilingStop.cause = "task-cap"; }))).rejects.toThrow(/control-allowance-/);
  }, 60_000);
});

it("the stopped run's worktree file is in its attempt commit (the tree a continuation restores)", async () => {
  const a = await stopRun({ plan: async () => PLAN, verify: async () => APPROVED,
    execute: async (c) => { await write(c, "kept\n"); await streamUntilStopped(c, 50); throw new Error("stopped"); } }, { ceiling: 40 });
  expect(git(a.repo, "show", `refs/ccloop/${a.runId}/attempts/1:src/a.ts`)).toBe("kept");
  expect(existsSync(join(a.root, "run", "worktrees", "attempt-1"))).toBe(false);
}, 30_000);
