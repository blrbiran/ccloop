import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupAttemptWorkspaceBestEffort, cleanupResidualExtraWorktrees } from "../controller/runLoop.js";
import { confirmOwnerDead } from "../controller/adoptCrashedRun.js";
import { classifyOwnerProcess, type OwnerLivenessDeps } from "../ownership/ownerLiveness.js";
import { reapRunProcesses } from "../ownership/reapRunProcesses.js";
import { appendEvent, readOwnerRecord, readRunState, releaseOwnerLease, writeRunState } from "../persistence/fileStore.js";
import { causeDetail } from "../runtime/failureCause.js";
import type { OwnerRecord } from "../runtime/types.js";
import { isTerminalRunStatus } from "../state/stateMachine.js";
import type { RunState } from "../state/types.js";
import { registerAttemptRefNamespace } from "../workspace/worktreeManager.js";
import { buildHandoffPacket, persistHandoffCandidate, readHandoffCandidate, type CandidateV1 } from "./handoff.js";
import { canonicalHash, ControlProtocolError, type LoopStartEnvelope } from "./protocol.js";
import { candidateOf, type CollectionV1 } from "./collect.js";
import { workerLiveness } from "./workerLiveness.js";
import { materializeExtraResultRepositories, materializeResultRepository } from "./resultRepository.js";
import { proveStopped } from "./stopProof.js";
import { testCrashPoint } from "./testCrashPoint.js";
import { readAccepted, writeAccepted, withAcceptedLock } from "./store.js";
import { appendUsageObservation } from "./usage.js";

const PHASE = { planning: "plan", executing: "execute", verifying: "verify" } as const;
/** The worker's own result mapping (worker.ts onRunSettledBeforeLeaseRelease) for a run that has no handoff request. */
const resultOf = (status: RunState["status"]): CandidateV1["result"] =>
  status === "succeeded" ? "complete" : status === "blocked_waiting_human" || status === "exhausted" || status === "cancelled" ? "partial" : "failed";

async function ownerOptional(runDir: string): Promise<OwnerRecord | null> {
  try { return await readOwnerRecord(runDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/**
 * §4.2 `settle-lost-worker`: an explicit controller request, never a launch. Refuses unless the worker is confirmed dead;
 * reaps the run's orphan process groups; moves an unfinished loop state to `failed` with the failure cause `worker-lost`
 * and books the killed call's usage as unknown; then does what the dead worker would have done at its end (result
 * repository, handoff candidate, lease release, seal) so the stop can be proved. Idempotent: a run that already has a
 * candidate answers it (sealing and releasing first when its worker died after writing it).
 */
export async function settleLostWorker(input: LoopStartEnvelope, deps: OwnerLivenessDeps = {}): Promise<{ candidate: NonNullable<CollectionV1["candidate"]> }> {
  const source = input.work.sourceDir, runDir = join(source, "run");
  return withAcceptedLock(source, async () => {
    const accepted = await readAccepted(source);
    if (accepted.envelopeHash !== canonicalHash(input) || accepted.generation !== input.claim.generation || accepted.configHash !== input.claim.configHash) {
      throw new ControlProtocolError("control-envelope-conflict");
    }
    let candidate = await readHandoffCandidate(source);
    // Orca tester follow-up I (review of #273, finding 2): a worker that sealed after writing its candidate and died before
    // releasing its lease leaves a `sealed` run whose stop cannot be proved. It is settled like a claimed one (its seal
    // rewritten unchanged). A sealed run whose stop is provable (the ordinary end) is answered as before, with no liveness check.
    if (accepted.launch === "sealed" && candidate !== null) {
      const proved = await proveStopped({ sourceDir: source, accepted });
      if (proved !== null) return { candidate: candidateOf(candidate, proved) };
    }
    if (accepted.launch === "claimed" || (accepted.launch === "sealed" && candidate !== null)) {
      const worker = await workerLiveness(accepted, deps);
      if (worker.state !== "lost") throw new ControlProtocolError("control-worker-not-lost");
      const owner = await ownerOptional(runDir);
      if (owner !== null && !(await confirmOwnerDead(owner, { classify: (record) => classifyOwnerProcess(record, deps) })).ok) throw new ControlProtocolError("control-worker-not-lost");
      const reaped = await reapRunProcesses(runDir);
      if (!reaped.ok) throw new Error(`control-worker-processes-not-reaped: ${reaped.reason}`);
      // A candidate the worker wrote is its own outcome (complete, partial or failed) and is kept as it is -- never
      // rewritten to worker-lost: only a run that has none is moved to the worker-lost failure.
      if (candidate === null) candidate = await settleState(input, runDir, worker.reason);
      if (owner !== null && owner.leaseAffirmedAt !== null) await releaseOwnerLease(runDir, owner);
      await writeAccepted(source, { ...accepted, launch: "sealed" });
    } else if (candidate === null) {
      throw new ControlProtocolError("control-worker-not-lost");
    }
    const proof = await proveStopped({ sourceDir: source, accepted: await readAccepted(source) });
    if (proof === null) throw new Error("control-worker-not-stopped");
    return { candidate: candidateOf(candidate, proof) };
  });
}

async function settleState(input: LoopStartEnvelope, runDir: string, reason: string): Promise<CandidateV1> {
  const source = input.work.sourceDir;
  let state: RunState;
  try { state = await readRunState(runDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ControlProtocolError("control-worker-lost-state-unavailable");
    throw error;
  }
  if (!isTerminalRunStatus(state.status)) {
    const phase = PHASE[state.status as keyof typeof PHASE] ?? null;
    const at = new Date().toISOString();
    state = { ...state, status: "failed", waitingOnHuman: false, stopReason: `worker-lost: ${reason}`, lastTransitionAt: at,
      failureCause: { cause: "worker-lost", phase, retries: 0, detail: causeDetail(reason) } };
    await writeRunState(runDir, state);
    await testCrashPoint("worker-lost-state-written");
    await appendEvent(runDir, { type: "worker_lost", at, detail: reason });
  }
  // §4.2 step 4: the killed call left no usage record, so the run's work usage becomes unknown (its observed floor stays).
  // Orca tester follow-up I: appended for a state this method moved to worker-lost, also when an earlier call of it stopped
  // after writing that state -- the observation is idempotent by id and its bytes come from the stored failure cause.
  if (state.failureCause?.cause === "worker-lost") {
    const phase = state.failureCause.phase;
    await appendUsageObservation(source, { runId: input.claim.runId, generation: input.claim.generation, bucket: "work", observationId: "worker-lost",
      threadTotalTokens: null, elapsedMs: 0, attempts: state.attemptsUsed, sessions: 1,
      evidence: { kind: "worker-lost-v1", runId: input.claim.runId, generation: input.claim.generation, attempt: state.currentAttempt, phase, tokenUsage: null, interrupted: true } });
  }
  // The dead worker's attempt worktrees: published under their refs, then removed (as a failed attempt's cleanup does).
  registerAttemptRefNamespace(runDir, input.claim.runId);
  let trees: string[] = [];
  try { trees = (await readdir(join(runDir, "worktrees"))).filter((name) => /^attempt-\d+$/.test(name)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const tree of trees) await cleanupAttemptWorkspaceBestEffort(input.work.contract.context.repoPath, join(runDir, "worktrees", tree), runDir, "cleanup after worker-lost settlement");
  if (input.work.contract.context.additionalRepos !== undefined) await cleanupResidualExtraWorktrees(input.work.contract, runDir);
  await materializeResultRepository(input, runDir, state.currentAttempt);
  await materializeExtraResultRepositories(input, runDir, state.currentAttempt);
  const result = resultOf(state.status);
  const usage = await appendUsageObservation(source, { runId: input.claim.runId, generation: input.claim.generation, bucket: "handoff", observationId: "worker-lost-settlement",
    threadTotalTokens: 0, elapsedMs: 0, attempts: 0, sessions: 0, evidence: { requestId: null, result, mechanical: true } });
  const built = await buildHandoffPacket(input, null, state, usage.eventSeq, result);
  return await persistHandoffCandidate(input, null, state, built, { result, usageHighWater: usage.eventSeq });
}
