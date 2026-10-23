import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { readEvidence } from "./evidence.js";
import { isTerminalRunStatus } from "../state/stateMachine.js";
import type { RunState, RunStatus } from "../state/types.js";
import { ControlProtocolError, type StartEnvelopeV3 } from "./protocol.js";
import { readPrivateFile } from "./paths.js";
import { readUsageEvents, type UsageEventV1 } from "./usage.js";
import { readHandoffCandidate, type CandidateV1 } from "./handoff.js";
import { proveStopped, type StopProofV1 } from "./stopProof.js";
import { inspectStart, type ExecutionStatusV1 } from "./accept.js";
import { readAcceptedOptional } from "./store.js";
import { readToolRulesReport } from "./toolRulesReport.js";
import { listTranscripts, type TranscriptEntryV1 } from "./transcripts.js";

/** Orca labels and progress spec §3.2 (2026-09-28): the loop's latest state, as Orca shows a task's step. */
export interface ProgressV1 {
  status: RunStatus;
  currentAttempt: number;
  attemptsUsed: number;
  attemptsRemaining: number;
  lastTransitionAt: string;
}

export interface CollectionV1 {
  events: UsageEventV1[];
  candidate: (Omit<CandidateV1, "stopProof"> & { stopProof: StopProofV1 | null }) | null;
  terminal: RunState | null;
  /** Running or terminal alike; null before the loop wrote any state. */
  progress: ProgressV1 | null;
  /**
   * Reported decisions and debug (spec 2026-10-20 §4.3): what the collected candidate's attempt reported, carried
   * opaquely for Orca. Absent (never null) when there is no candidate or its attempt reported none.
   */
  decisions?: unknown;
  debug?: unknown;
  /** Orca's flow-step report (spec 2026-10-22-flow-answer-key-design.md §4 item 7), read the same way as debug. */
  flow?: unknown;
  /**
   * Failure causes (ccloop spec 2026-10-21-failure-causes-and-transient-retries-design.md §5): why the run failed or was
   * exhausted, present iff `terminal` is non-null and the state has one. Top level, not inside `terminal`, so both strict
   * terminal schemas and the frozen protocol-3 projection stay as they are.
   */
  failureCause?: import("../runtime/failureCause.js").RunFailureCauseV1;
  /**
   * Per-contract tool rules (spec 2026-10-22 §5): the run's report, present iff the contract has toolRules and
   * run/tool-rules.json exists. Top level, like failureCause; absent otherwise, so no existing caller sees new bytes.
   */
  toolRules?: import("../runtime/toolRules.js").ToolRulesReportV1;
  /**
   * Live transcript (Orca spec 2026-10-23-live-transcript-design.md §10.2.4): one entry per agent call of the run, present iff
   * there is at least one; absent otherwise, like toolRules. Advertised by `features.transcripts: "v1"`.
   */
  transcripts?: TranscriptEntryV1[];
  /**
   * Multi-repo runs (spec 2026-10-24-multi-dir-projects §11.6): one entry per extra repository, contract order, present
   * iff the contract has additionalRepos. changedPaths is ccloop's own observation of the current attempt (§11.3), [] before
   * there is one. Top level, like toolRules, so the protocol-3 terminal projection is untouched.
   */
  dirs?: CollectedDirV1[];
}

export interface CollectedDirV1 {
  key: string;
  resultRepo: string;
  changedPaths: string[];
}

/** Spec §11.6: run/attempts/<currentAttempt>/dirs.json, written by the run loop after execute; absent ⇒ []. */
async function dirsOf(sourceDir: string, keys: string[], state: unknown): Promise<CollectedDirV1[]> {
  const attempt = state === null ? 0 : (state as { currentAttempt: number }).currentAttempt;
  let observed: unknown = [];
  if (attempt >= 1) {
    try {
      observed = JSON.parse((await readPrivateFile(sourceDir, join(sourceDir, "run", "attempts", String(attempt), "dirs.json"))).toString("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const byKey = new Map(Array.isArray(observed) ? observed.map((entry) => [(entry as { key?: unknown }).key, (entry as { changedPaths?: unknown }).changedPaths]) : []);
  return keys.map((key) => {
    const changed = byKey.get(key);
    return { key, resultRepo: `repos/${key}`, changedPaths: Array.isArray(changed) && changed.every((path) => typeof path === "string") ? changed as string[] : [] };
  });
}

const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// Orca labels and progress spec §8 R17: loop-state.json is checked for the fields progress takes, never cast.
const loopStateProgressSchema = z.object({
  status: z.enum(["queued", "planning", "executing", "verifying", "succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"]),
  currentAttempt: safe,
  attemptsUsed: safe,
  lastTransitionAt: z.string().min(1),
  budgetSnapshot: z.object({ attemptsRemaining: safe }).passthrough(),
}).passthrough();

/**
 * The one read of run/loop-state.json per collect, so `terminal` and `progress` describe the same moment of the run
 * (Task 6 fix round 1). No file (ENOENT) is null; bytes that are not JSON are control-terminal-invalid. The parsed value
 * is boxed so a file holding the JSON literal `null` stays distinct from no file at all.
 */
async function readLoopStateJson(sourceDir: string): Promise<{ state: unknown } | null> {
  const target = join(sourceDir, "run", "loop-state.json");
  try {
    return { state: JSON.parse((await readPrivateFile(sourceDir, target)).toString("utf8")) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new ControlProtocolError("control-terminal-invalid");
    throw error;
  }
}

/**
 * Orca labels and progress spec §3.2: the progress collect answers on every call, for a loop still running and for one
 * that ended alike. A loop state that lacks a field progress takes is control-terminal-invalid -- the code a loop state
 * that is not JSON already answers.
 */
function progressOf(state: unknown): ProgressV1 {
  const parsed = loopStateProgressSchema.safeParse(state);
  if (!parsed.success) throw new ControlProtocolError("control-terminal-invalid");
  const { status, currentAttempt, attemptsUsed, lastTransitionAt, budgetSnapshot } = parsed.data;
  return { status, currentAttempt, attemptsUsed, attemptsRemaining: budgetSnapshot.attemptsRemaining, lastTransitionAt };
}

function terminalOf(state: unknown, protocol: number): RunState | null {
  const run = state as RunState;
  if (!isTerminalRunStatus(run.status)) return null;
  if (protocol === 4) { const {savedResult:_private,failureCause:_topLevel,...core}=run;return core; }
  // Internal extensions must never change the frozen finite protocol-3 projection.
  return {
    status: run.status, currentAttempt: run.currentAttempt, attemptsUsed: run.attemptsUsed,
    lastTransitionAt: run.lastTransitionAt, waitingOnHuman: run.waitingOnHuman, stopReason: run.stopReason,
    budgetSnapshot: { attemptsRemaining: run.budgetSnapshot.attemptsRemaining,
      timeRemainingMs: run.budgetSnapshot.timeRemainingMs, tokenBudgetRemaining: run.budgetSnapshot.tokenBudgetRemaining },
    recentFailures: run.recentFailures,
  };
}

function candidateOf(candidate: CandidateV1, proof: StopProofV1 | null): NonNullable<CollectionV1["candidate"]> {
  const { groupId, workItemId, taskId, runId, generation, graphVersion, targetVersion,
    checkpointId, usageHighWater, result, artifacts, snapshot, missing, unresolvedRequestIds, terminalOutcome, handoff } = candidate;
  return { groupId, workItemId, taskId, runId, generation, graphVersion, targetVersion,
    checkpointId, usageHighWater, result, artifacts, snapshot, missing, unresolvedRequestIds, stopProof: proof, terminalOutcome, handoff };
}

/**
 * Reported decisions and debug (spec 2026-10-20 §4.3): read from the candidate's kept copy of its attempt's execution.json,
 * never from the live attempt directory. The candidate records no label for its artifacts, so the kept copy is found by
 * content: the live run/attempts/<currentAttempt>/execution.json is hashed and only an artifact of the candidate with that
 * hash is read. The attempt is the loop state's current one -- the one the candidate was built from (handoff.ts) -- and a
 * file that changed after the candidate kept it, or another attempt's file, matches no kept copy, so it is never reported.
 */
async function reportedOf(sourceDir: string, candidate: CandidateV1, state: unknown): Promise<Pick<CollectionV1, "decisions" | "debug" | "flow">> {
  const attempt = (state as { currentAttempt: number }).currentAttempt;
  if (attempt < 1) return {};
  let live: Buffer;
  try {
    live = await readPrivateFile(sourceDir, join(sourceDir, "run", "attempts", String(attempt), "execution.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const hash = createHash("sha256").update(live).digest("hex");
  const kept = candidate.artifacts.find((ref) => ref.hash === hash && ref.artifactId === `evidence-${hash}`);
  if (kept === undefined) return {};
  let execution: unknown;
  try { execution = JSON.parse((await readEvidence(sourceDir, kept)).toString("utf8")); } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  if (execution === null || typeof execution !== "object" || Array.isArray(execution)) return {};
  const fields = execution as Record<string, unknown>;
  return { ...(Object.hasOwn(fields, "decisions") ? { decisions: fields.decisions } : {}), ...(Object.hasOwn(fields, "debug") ? { debug: fields.debug } : {}),
    ...(Object.hasOwn(fields, "flow") ? { flow: fields.flow } : {}) };
}

export async function collectExecution(input: StartEnvelopeV3, afterSeq: number): Promise<CollectionV1> {
  if (!safe.safeParse(afterSeq).success) throw new ControlProtocolError("control-collect-invalid");
  const events = (await readUsageEvents(input.work.sourceDir)).filter((event) => event.eventSeq > afterSeq);
  const storedCandidate = await readHandoffCandidate(input.work.sourceDir);
  const accepted = storedCandidate === null ? null : await readAcceptedOptional(input.work.sourceDir);
  const proof = accepted === null
    ? null
    : await proveStopped({ sourceDir: input.work.sourceDir, accepted });
  const loopState = await readLoopStateJson(input.work.sourceDir);
  const terminal = storedCandidate === null || loopState === null ? null : terminalOf(loopState.state, input.protocol);
  const failureCause = terminal === null ? undefined : (loopState!.state as RunState).failureCause;
  const declared = (input.work as { contract?: { executionPolicy?: { toolRules?: unknown } } }).contract?.executionPolicy?.toolRules;
  const toolRules = declared === undefined ? undefined : await readToolRulesReport(input.work.sourceDir);
  // progressOf validates the loop state (an unknown status is control-terminal-invalid) before its status is read here.
  const progress = loopState === null ? null : progressOf(loopState.state);
  const runFinal = proof !== null || (progress !== null && isTerminalRunStatus(progress.status));
  const transcripts = await listTranscripts(input.work.sourceDir, runFinal);
  const extraKeys = input.work.kind === "loop" ? input.work.contract.context.additionalRepos?.map((repo) => repo.key) : undefined;
  // Evaluated after progressOf, which has checked the loop state's currentAttempt.
  const dirs = extraKeys === undefined ? undefined : await dirsOf(input.work.sourceDir, extraKeys, loopState === null ? null : loopState.state);
  return {
    events,
    candidate: storedCandidate === null ? null : candidateOf(storedCandidate, proof),
    terminal,
    progress,
    // Evaluated after progressOf, which has checked the loop state's currentAttempt.
    ...(storedCandidate === null || loopState === null ? {} : await reportedOf(input.work.sourceDir, storedCandidate, loopState.state)),
    ...(failureCause === undefined ? {} : { failureCause }),
    ...(toolRules === undefined ? {} : { toolRules }),
    ...(transcripts.length === 0 ? {} : { transcripts }),
    ...(dirs === undefined ? {} : { dirs }),
  };
}

export async function inspectExecution(input: StartEnvelopeV3): Promise<ExecutionStatusV1> {
  const status = await inspectStart(input);
  if (status.kind !== "accepted") return status;
  const accepted = await readAcceptedOptional(input.work.sourceDir);
  const candidate = await readHandoffCandidate(input.work.sourceDir);
  if (accepted === null || candidate === null) return status;
  const proof = await proveStopped({ sourceDir: input.work.sourceDir, accepted });
  return proof === null ? status : { kind: "stopped", proof };
}
