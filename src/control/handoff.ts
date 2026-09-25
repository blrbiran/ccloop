import { constants } from "node:fs";
import { open, readdir, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { listDescriptors } from "../agents/registry.js";
import { isTerminalRunStatus } from "../state/stateMachine.js";
import type { RunState } from "../state/types.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory, readPrivateFile } from "./paths.js";
import {
  canonicalHash,
  canonicalJson,
  ControlProtocolError,
  handoffRequestSchema,
  type ArtifactRefV1,
  type HandoffRequestV1,
  type StartEnvelopeV2,
} from "./protocol.js";
import { testCrashPoint } from "./testCrashPoint.js";
import { writeEvidence } from "./evidence.js";
import { readAcceptedOptional } from "./store.js";

export type HandoffAckV1 =
  | { kind: "latched"; requestId: string }
  | { kind: "complete"; requestId: string; checkpointId: string };

export interface HandoffIdentityV1 {
  groupId: string;
  workItemId: string;
  taskId: string | null;
  runId: string;
  generation: number;
  graphVersion: number;
  targetVersion: number;
}

export interface HandoffPacketV1 {
  protocol: 1;
  identity: HandoffIdentityV1;
  request: HandoffRequestV1 | null;
  runState: RunState;
  completed: string[];
  unfinished: string[];
  pendingDecisions: string[];
  awaitingHuman: string[];
  validationCommands: string[];
  rawLogs: ArtifactRefV1[];
  usageHighWater: number;
  unresolvedRequestIds: string[];
  artifacts: ArtifactRefV1[];
}

export interface BuiltHandoffPacketV1 {
  packet: HandoffPacketV1;
  handoff: ArtifactRefV1;
  artifacts: ArtifactRefV1[];
  missing: string[];
}

export interface CandidateV1 extends HandoffIdentityV1 {
  checkpointId: string;
  usageHighWater: number;
  result: "complete" | "partial" | "failed";
  artifacts: ArtifactRefV1[];
  snapshot: ArtifactRefV1 | null;
  missing: string[];
  unresolvedRequestIds: string[];
  stopProof: null;
  terminalOutcome: string;
  handoff: ArtifactRefV1;
}

function controlDir(sourceDir: string): string {
  return join(sourceDir, "control");
}

function requestPath(sourceDir: string): string {
  return join(controlDir(sourceDir), "handoff-request.json");
}

function candidatePath(sourceDir: string): string {
  return join(controlDir(sourceDir), "candidate.json");
}

async function withHandoffLock<T>(sourceDir: string, action: () => Promise<T>): Promise<T> {
  const root = controlDir(sourceDir);
  await ensurePrivateDirectory(sourceDir, root);
  const path = join(root, "handoff.lock");
  let handle;
  const deadline = Date.now() + 2_000;
  while (handle === undefined) {
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new ControlProtocolError("control-handoff-busy");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(path);
  }
}

export async function readHandoffRequest(sourceDir: string): Promise<HandoffRequestV1> {
  try {
    const parsed = handoffRequestSchema.safeParse(
      JSON.parse((await readPrivateFile(sourceDir, requestPath(sourceDir))).toString("utf8")) as unknown,
    );
    if (!parsed.success) throw new ControlProtocolError("control-handoff-invalid");
    return parsed.data;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ControlProtocolError("control-handoff-invalid");
    throw error;
  }
}

export async function readHandoffRequestOptional(sourceDir: string): Promise<HandoffRequestV1 | null> {
  try {
    return await readHandoffRequest(sourceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readHandoffCandidate(sourceDir: string): Promise<CandidateV1 | null> {
  try {
    return JSON.parse((await readPrivateFile(sourceDir, candidatePath(sourceDir))).toString("utf8")) as CandidateV1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new ControlProtocolError("control-candidate-invalid");
    throw error;
  }
}

export async function requestHandoff(
  envelope: StartEnvelopeV2,
  request: HandoffRequestV1,
): Promise<HandoffAckV1> {
  if (request.runId !== envelope.claim.runId || request.generation !== envelope.claim.generation) {
    throw new ControlProtocolError("control-handoff-identity-mismatch");
  }
  const accepted = await readAcceptedOptional(envelope.work.sourceDir);
  if (accepted === null) throw new ControlProtocolError("control-handoff-not-accepted");
  if (accepted.envelopeHash !== canonicalHash(envelope)) {
    throw new ControlProtocolError("control-envelope-conflict");
  }
  const ack: HandoffAckV1 = await withHandoffLock(envelope.work.sourceDir, async () => {
    const existing = await readHandoffRequestOptional(envelope.work.sourceDir);
    if (existing !== null) {
      if (canonicalHash(existing) !== canonicalHash(request)) {
        throw new ControlProtocolError("control-handoff-conflict");
      }
      const candidate = await readHandoffCandidate(envelope.work.sourceDir);
      return candidate === null
        ? { kind: "latched", requestId: request.requestId }
        : { kind: "complete", requestId: request.requestId, checkpointId: candidate.checkpointId };
    }
    await atomicReplacePrivateFile(
      envelope.work.sourceDir,
      requestPath(envelope.work.sourceDir),
      Buffer.from(`${canonicalJson(request)}\n`),
    );
    return { kind: "latched", requestId: request.requestId };
  });
  await testCrashPoint("handoff-fsynced");
  return ack;
}

function identity(envelope: StartEnvelopeV2): HandoffIdentityV1 {
  const claim = envelope.claim;
  return {
    groupId: claim.groupId,
    workItemId: claim.workItemId,
    taskId: claim.taskId,
    runId: claim.runId,
    generation: claim.generation,
    graphVersion: claim.graphVersion,
    targetVersion: claim.targetVersion,
  };
}

async function retainFile(
  sourceDir: string,
  path: string,
  label: string,
  artifacts: ArtifactRefV1[],
  missing: string[],
): Promise<ArtifactRefV1 | null> {
  try {
    const ref = await writeEvidence(sourceDir, await readPrivateFile(sourceDir, path));
    artifacts.push(ref);
    return ref;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      missing.push(label);
      return null;
    }
    throw error;
  }
}

// Agent selection (2026-09-26), wave-1 review I-2: every adapter keeps its per-call evidence under run/<kind>/
// (codex: events.jsonl, final.json, ...; claude: stdout.json, ...), so the packet retains the union of both sets.
// request.json holds the prompt and is left out, as codex's evidence holds no prompt either.
const RAW_AGENT_FILES = new Set([
  "events.jsonl",
  "stderr.log",
  "outcome.json",
  "final.json",
  "process.json",
  "usage.json",
  "decode-error.txt",
  "stdout.json",
]);

async function retainAgentLogs(
  sourceDir: string,
  runDir: string,
  directory: string,
  artifacts: ArtifactRefV1[],
  rawLogs: ArtifactRefV1[],
  depth = 0,
): Promise<void> {
  if (depth > 8 || rawLogs.length >= 256) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (rawLogs.length >= 256) break;
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await retainAgentLogs(sourceDir, runDir, path, artifacts, rawLogs, depth + 1);
    } else if (entry.isFile() && RAW_AGENT_FILES.has(entry.name)) {
      const ref = await retainFile(sourceDir, path, relative(runDir, path), artifacts, []);
      if (ref !== null) rawLogs.push(ref);
    }
  }
}

const PHASE_FILE: Record<string, string> = { plan: "plan.json", execute: "execution.json", verify: "verify.json" };

/**
 * Orca handoff delivery spec §13.1 C-2 (human ruling 2026-09-25): a handoff candidate of a run that is
 * not terminal lists as missing only the phase files of the current attempt that the attempt entered.
 * Entered: plan once the attempt exists; execute on its `execute_started`; verify on its
 * `execution_finished` (runLoop.ts emits both with detail `attempt <n>`).
 *
 * Orca handoff delivery spec §13.4 D-C7' (α), human ruling 2026-09-25: the phase this attempt's
 * `handoff_interrupted` event names (detail `handoff deadline interrupted <phase> in attempt <n>`) is
 * removed here even though entered -- a handoff deadline stopped it by design, before it could ever
 * write a result file, and the worktree snapshot is the evidence for it. Excluding its file from
 * `entered` keeps it out of `missing` too, since the caller only checks files still in the set.
 */
async function enteredPhaseFiles(sourceDir: string, runDir: string, attempt: number): Promise<Set<string>> {
  const entered = new Set(["plan.json"]);
  let text = "";
  try {
    text = (await readPrivateFile(sourceDir, join(runDir, "events.jsonl"))).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event: { type?: unknown; detail?: unknown };
    try { event = JSON.parse(line) as { type?: unknown; detail?: unknown }; } catch { continue; }
    if (event.type === "handoff_interrupted") {
      for (const [phase, file] of Object.entries(PHASE_FILE)) {
        if (event.detail === `handoff deadline interrupted ${phase} in attempt ${attempt}`) entered.delete(file);
      }
    }
    if (event.detail !== `attempt ${attempt}`) continue;
    if (event.type === "execute_started") entered.add("execution.json");
    if (event.type === "execution_finished") entered.add("verify.json");
  }
  return entered;
}

export async function buildHandoffPacket(
  envelope: StartEnvelopeV2,
  request: HandoffRequestV1 | null,
  runState: RunState,
  usageHighWater: number,
  result: CandidateV1["result"] = request === null && runState.status === "succeeded" ? "complete" : "partial",
): Promise<BuiltHandoffPacketV1> {
  if (request === null && !isTerminalRunStatus(runState.status)) {
    throw new ControlProtocolError("control-handoff-request-required");
  }
  const runDir = join(envelope.work.sourceDir, "run");
  const artifacts: ArtifactRefV1[] = [];
  const missing: string[] = [];
  const eventRef = await retainFile(envelope.work.sourceDir, join(runDir, "events.jsonl"), "events.jsonl", artifacts, missing);
  const rawLogs = eventRef === null ? [] : [eventRef];
  for (const kind of listDescriptors().map((descriptor) => descriptor.kind).sort()) {
    await retainAgentLogs(envelope.work.sourceDir, runDir, join(runDir, kind), artifacts, rawLogs);
  }
  await retainFile(envelope.work.sourceDir, join(runDir, "loop-state.json"), "loop-state.json", artifacts, missing);
  await retainFile(envelope.work.sourceDir, join(runDir, "loop-contract.json"), "loop-contract.json", artifacts, missing);
  if (runState.currentAttempt > 0) {
    const entered = request !== null && !isTerminalRunStatus(runState.status)
      ? await enteredPhaseFiles(envelope.work.sourceDir, runDir, runState.currentAttempt)
      : null;
    for (const name of ["plan.json", "execution.json", "verify.json"]) {
      if (entered !== null && !entered.has(name)) continue;
      await retainFile(
        envelope.work.sourceDir,
        join(runDir, "attempts", String(runState.currentAttempt), name),
        `attempts/${runState.currentAttempt}/${name}`,
        artifacts,
        missing,
      );
    }
  }
  const pendingDecisions = [
    ...runState.recentFailures.map((failure) => failure.rejectCategory).filter(Boolean),
    ...(runState.waitingOnHuman && runState.stopReason !== null ? [runState.stopReason] : []),
  ];
  const packet: HandoffPacketV1 = {
    protocol: 1,
    identity: identity(envelope),
    request,
    runState,
    completed: runState.attemptsUsed > 0 ? [`${runState.attemptsUsed} attempt(s) entered`] : [],
    unfinished: runState.status === "succeeded" ? [] : [envelope.work.contract.objective.successCondition],
    pendingDecisions,
    awaitingHuman: runState.waitingOnHuman ? [runState.stopReason ?? "human input required"] : [],
    validationCommands: [...envelope.work.contract.verification.requiredChecks],
    rawLogs,
    usageHighWater,
    unresolvedRequestIds: [],
    artifacts: [...artifacts],
  };
  const handoff = await writeEvidence(envelope.work.sourceDir, Buffer.from(canonicalJson(packet)));
  return { packet, handoff, artifacts, missing };
}

export async function persistHandoffCandidate(
  envelope: StartEnvelopeV2,
  request: HandoffRequestV1 | null,
  runState: RunState,
  built: BuiltHandoffPacketV1,
  options: { result: CandidateV1["result"]; usageHighWater: number },
): Promise<CandidateV1> {
  const candidate: CandidateV1 = {
    ...identity(envelope),
    checkpointId: `checkpoint-${canonicalHash({ handoff: built.handoff, usageHighWater: options.usageHighWater }).slice(0, 48)}`,
    usageHighWater: options.usageHighWater,
    result: options.result,
    artifacts: [...built.artifacts, built.handoff],
    snapshot: null,
    missing: [...built.missing],
    unresolvedRequestIds: [],
    stopProof: null,
    terminalOutcome: runState.status,
    handoff: built.handoff,
  };
  await atomicReplacePrivateFile(
    envelope.work.sourceDir,
    candidatePath(envelope.work.sourceDir),
    Buffer.from(`${canonicalJson(candidate)}\n`),
  );
  await testCrashPoint("candidate-fsynced");
  return candidate;
}

export async function finalizeHandoffCandidate(
  envelope: StartEnvelopeV2,
  request: HandoffRequestV1 | null,
  runState: RunState,
  options: { result: CandidateV1["result"]; usageHighWater: number },
): Promise<CandidateV1> {
  const built = await buildHandoffPacket(envelope, request, runState, options.usageHighWater, options.result);
  return await persistHandoffCandidate(envelope, request, runState, built, options);
}
