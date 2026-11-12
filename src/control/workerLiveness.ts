import { classifyOwnerProcess, type OwnerLivenessDeps } from "../ownership/ownerLiveness.js";
import type { StartEnvelopeV3 } from "./protocol.js";
import type { AcceptedRecordV1 } from "./store.js";

/**
 * Orca #273 (spec Orca docs/superpowers/specs/2026-11-12-worker-lost-recovery-design.md §4.1): whether the run's worker
 * process still exists, from its recorded identity (pid + process start time; a reused pid is `lost`). Lease age is not
 * a death criterion. Answered by the owner liveness classification crash-resume uses.
 */
export type WorkerLivenessV1 = { state: "alive" | "lost" | "undetermined"; reason: string };
export async function workerLiveness(accepted: AcceptedRecordV1, deps: OwnerLivenessDeps = {}): Promise<WorkerLivenessV1> {
  if (accepted.worker === null) return { state: "undetermined", reason: "no worker identity is recorded" };
  const verdict = await classifyOwnerProcess({ currentProcessInstanceId: `pid:${accepted.worker.pid}:${Date.parse(accepted.worker.startedAt)}`, lastAffirmedAt: accepted.worker.startedAt }, deps);
  return { state: verdict.verdict === "dead" ? "lost" : verdict.verdict, reason: verdict.reason };
}

/** §4.1 trigger: a loop run (not a saved-result recovery) whose worker was claimed and has neither a candidate nor a terminal. */
export function workerReportApplies(input: StartEnvelopeV3, accepted: AcceptedRecordV1 | null, hasCandidate: boolean, terminal: boolean): accepted is AcceptedRecordV1 {
  return input.work.kind === "loop" && !("mode" in input && input.mode !== undefined) && accepted !== null && accepted.launch === "claimed" && !hasCandidate && !terminal;
}
