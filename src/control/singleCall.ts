import { createHash } from "node:crypto";
import { join } from "node:path";
import { getDescriptor } from "../agents/registry.js";
import type { MaterializedAgentConfigV1 } from "../agents/types.js";
import { observedTokensOf, SingleCallOutputInvalid, type AttemptContext, type OwnerRecord } from "../runtime/types.js";
import { writeEvidence } from "./evidence.js";
import { candidatePath, identity, type CandidateV1 } from "./handoff.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "./paths.js";
import { canonicalHash, canonicalJson, type ArtifactRefV1, type HandoffRequestV1, type SingleCallStartEnvelope } from "./protocol.js";
import { recordCompletedPhase } from "./stopProof.js";
import { testCrashPoint } from "./testCrashPoint.js";
import { appendUsageObservation } from "./usage.js";

// Orca single-call estimate (2026-09-27), spec docs/superpowers/specs/2026-09-27-single-call-estimate-design.md §5.2 in
// the Orca repository: single-call work is one read-only structured call. It never touches git (no attempt ref, no
// worktree, no result repository); it leaves exactly the files the control lifecycle reads -- processes, the completed
// count, usage, evidence, a released owner record and a candidate -- so accept, inspect, collect, handoff and the stop
// proof treat it like any run.

export const SINGLE_CALL_RECORD_SCHEMA = "ccloop-single-call-record-v1";

export interface SingleCallRecordV1 {
  schema: typeof SINGLE_CALL_RECORD_SCHEMA;
  /** sha256 of the prompt's UTF-8 bytes, so the caller can prove the call ran on the bytes it sent (spec §6.3). */
  promptSha256: string;
  /** sha256 of JSON.stringify(responseSchema) -- the exact string the runner passes to `--json-schema` (controller ruling F10). */
  responseSchemaSha256: string;
  outcome: "complete" | "aborted" | "failed";
  outputRef: ArtifactRefV1 | null;
  errorCode: string | null;
}

export interface SingleCallHooks {
  executionId: string;
  /** Aborted by a handoff request (spec §5.3) or a watcher failure. */
  signal: AbortSignal;
  onProcessRegistered: NonNullable<AttemptContext["onProcessRegistered"]>;
  /** Stops the worker's handoff watcher and answers the request it saw, or one on disk, or null. */
  settleRequest(): Promise<HandoffRequestV1 | null>;
  seal(): Promise<void>;
}

/**
 * Final review (2026-09-28): the call's time limit sits this far under the grant's activeMs, so the elapsed time the
 * worker reports -- the call plus its kill grace, evidence and settle -- never exceeds what the grant allowed.
 */
export const SINGLE_CALL_ACTIVE_MARGIN_MS = 10_000;

const RESULT = { complete: "complete", aborted: "partial", failed: "failed" } as const;

/** A failure's own code when it has one, else the name its message starts with (claude-timeout, claude-exit-error, ...). */
function errorCodeOf(error: unknown): string {
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string") return code;
  return (error instanceof Error ? error.message : String(error)).split(":")[0]!;
}

export async function runSingleCall(
  envelope: SingleCallStartEnvelope,
  sourceDir: string,
  config: MaterializedAgentConfigV1,
  hooks: SingleCallHooks,
): Promise<void> {
  const adapter = getDescriptor(config.kind).createAdapter(config);
  if (adapter.singleCall === undefined) throw new Error("single-call-unsupported");
  const { claim, work } = envelope;
  const runDir = join(sourceDir, "run");
  // Spec §5.2 item 1: an empty private directory is all the agent is given to stand in.
  const cwd = join(runDir, "cwd");
  await ensurePrivateDirectory(sourceDir, cwd);

  const startedAt = Date.now();
  let outcome: SingleCallRecordV1["outcome"];
  let output: unknown = null;
  let tokens: number | null = null;
  let usageEvidence: unknown = null;
  let errorCode: string | null = null;
  let completedWithResult = false;
  try {
    const result = await adapter.singleCall({
      prompt: work.prompt,
      responseSchema: work.responseSchema,
      maxOutputTokens: work.maxOutputTokens,
      cwd,
      runDir,
      timeoutMs: Math.max(1, claim.grant.work.activeMs - SINGLE_CALL_ACTIVE_MARGIN_MS),
      signal: hooks.signal,
      onProcessRegistered: hooks.onProcessRegistered,
    });
    outcome = "complete";
    output = result.output;
    tokens = result.tokenUsage;
    usageEvidence = result.usageEvidence;
    completedWithResult = true;
  } catch (error) {
    // Checked before the signal (final review, 2026-09-28): a call that ran to its end and raced a handoff request keeps
    // its measured usage and its code rather than being read as stopped.
    if (error instanceof SingleCallOutputInvalid) {
      // Spec §5.2 item 8: the call ran to its end; its usage is booked, its answer is not an output.
      outcome = "failed";
      tokens = error.tokenUsage;
      usageEvidence = error.usageEvidence;
      errorCode = error.code;
      completedWithResult = true;
    } else if (hooks.signal.aborted) {
      // Spec §5.2 item 4: what the agent was observed spending before the stop, or null -- never 0.
      outcome = "aborted";
      tokens = observedTokensOf(error);
    } else {
      // A timeout or a failed call still books what the agent was observed spending before it ended, or null.
      outcome = "failed";
      tokens = observedTokensOf(error);
      errorCode = errorCodeOf(error);
    }
  }
  const elapsedMs = Date.now() - startedAt;

  if (completedWithResult) await recordCompletedPhase(sourceDir);
  const outputRef = outcome === "complete" ? await writeEvidence(sourceDir, Buffer.from(canonicalJson(output))) : null;
  await appendUsageObservation(sourceDir, {
    runId: claim.runId,
    generation: claim.generation,
    bucket: "work",
    observationId: "single-call",
    threadTotalTokens: tokens,
    elapsedMs,
    attempts: 1,
    sessions: 1,
    evidence: { phase: "single-call", outcome, errorCode, elapsedMs, tokenUsage: tokens, usageEvidence },
  });

  const request = await hooks.settleRequest();
  const result = RESULT[outcome];
  // As the loop worker does: a mechanical handoff costs nothing, and Orca settles a run only once both buckets are
  // observed (Orca budget.ts hasObservedUsage).
  const handoffUsage = await appendUsageObservation(sourceDir, {
    runId: claim.runId,
    generation: claim.generation,
    bucket: "handoff",
    observationId: request === null ? `natural-${hooks.executionId}` : `handoff-${request.requestId}`,
    threadTotalTokens: 0,
    elapsedMs: 0,
    attempts: 0,
    sessions: 0,
    evidence: { requestId: request?.requestId ?? null, result, mechanical: true },
  });

  const record: SingleCallRecordV1 = {
    schema: SINGLE_CALL_RECORD_SCHEMA,
    promptSha256: createHash("sha256").update(work.prompt, "utf8").digest("hex"),
    // Controller ruling F10 (2026-09-28): the hash of the exact string handed to `--json-schema` (the runner stringifies
    // the schema as parsed from envelope.json, which accept wrote through canonicalJson), not of the caller's bytes --
    // ccloop and Orca sort keys differently, so this is evidence only; Orca compares promptSha256.
    responseSchemaSha256: createHash("sha256").update(JSON.stringify(work.responseSchema), "utf8").digest("hex"),
    outcome,
    outputRef,
    errorCode,
  };
  const handoff = await writeEvidence(sourceDir, Buffer.from(canonicalJson(record)));

  // Spec §5.2 item 7: no lease was ever held, so the owner record is written released; with the sealed worker and the
  // quiet registered group, proveStopped's conditions all hold.
  const now = new Date().toISOString();
  const owner: OwnerRecord = {
    runId: claim.runId,
    logicalSessionId: `${claim.runId}:single-call`,
    currentOwnerEpoch: 1,
    currentProcessInstanceId: hooks.executionId,
    lastAffirmedAt: now,
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
  };
  await atomicReplacePrivateFile(sourceDir, join(runDir, "owner-record.json"), Buffer.from(`${JSON.stringify(owner, null, 2)}\n`));

  const candidate: CandidateV1 = {
    ...identity(envelope),
    checkpointId: `checkpoint-${canonicalHash({ handoff, usageHighWater: handoffUsage.eventSeq }).slice(0, 48)}`,
    usageHighWater: handoffUsage.eventSeq,
    result,
    artifacts: outputRef === null ? [] : [outputRef],
    snapshot: null,
    missing: [],
    unresolvedRequestIds: [],
    stopProof: null,
    terminalOutcome: `single-call-${outcome}`,
    handoff,
  };
  await atomicReplacePrivateFile(sourceDir, candidatePath(sourceDir), Buffer.from(`${canonicalJson(candidate)}\n`));
  await testCrashPoint("candidate-fsynced");
  await hooks.seal();
}
