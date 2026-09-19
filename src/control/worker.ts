import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexAdapter } from "../runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../runtime/codex/protocol.js";
import { createStopRequestSignal, runLoop } from "../controller/runLoop.js";
import { isTerminalRunStatus } from "../state/stateMachine.js";
import { atomicReplacePrivateFile, readPrivateFile } from "./paths.js";
import { appendUsageObservation, readUsageEvents } from "./usage.js";
import { canonicalJson, parseControlRequest, type StartEnvelopeV1 } from "./protocol.js";
import {
  buildHandoffPacket,
  persistHandoffCandidate,
  readHandoffRequestOptional,
} from "./handoff.js";
import {
  claimAcceptedWorker,
  sealAcceptedWorker,
} from "./store.js";
import { readProcessStartedAt } from "./workerLauncher.js";

interface ManagedProcessV1 {
  pid: number;
  pgid: number;
  startedAt: string;
  phase: string;
  registeredAt: string;
}

function flag(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

async function readJson(sourceDir: string, name: string): Promise<unknown> {
  try {
    return JSON.parse((await readPrivateFile(sourceDir, join(sourceDir, "control", name))).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`control-${name.replace(/\.json$/, "")}-invalid`);
    throw error;
  }
}

async function registerProcess(
  sourceDir: string,
  process: Omit<ManagedProcessV1, "registeredAt">,
): Promise<void> {
  const target = join(sourceDir, "control", "processes.json");
  let existing: ManagedProcessV1[] = [];
  try {
    const raw = await readJson(sourceDir, "processes.json");
    if (!Array.isArray(raw)) throw new Error("control-processes-invalid");
    existing = raw as ManagedProcessV1[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = [...existing, { ...process, registeredAt: new Date().toISOString() }];
  await atomicReplacePrivateFile(sourceDir, target, Buffer.from(`${canonicalJson(next)}\n`));
}

async function initializeProcessRegistry(sourceDir: string): Promise<void> {
  try {
    const raw = await readJson(sourceDir, "processes.json");
    if (!Array.isArray(raw)) throw new Error("control-processes-invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicReplacePrivateFile(
      sourceDir,
      join(sourceDir, "control", "processes.json"),
      Buffer.from("[]\n"),
    );
  }
}

async function recordWorkerError(sourceDir: string, error: unknown): Promise<void> {
  const target = join(sourceDir, "control", "worker-error.json");
  await atomicReplacePrivateFile(
    sourceDir,
    target,
    Buffer.from(`${canonicalJson({ failedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) })}\n`),
  );
}

export async function runControlWorker(argv: string[]): Promise<void> {
  const sourceDir = flag(argv, "--source-dir");
  const executionId = flag(argv, "--execution-id");
  const nonce = flag(argv, "--nonce");
  const startedAt = await readProcessStartedAt(process.pid);
  if (startedAt === null) throw new Error("control-worker-identity-unavailable");
  const claimed = await claimAcceptedWorker(sourceDir, {
    executionId,
    nonce,
    pid: process.pid,
    startedAt,
  });
  if (!claimed) throw new Error("control-worker-claim-lost");

  let sealed = false;
  try {
    const envelope = parseControlRequest("accept", await readJson(sourceDir, "envelope.json")) as StartEnvelopeV1;
    const config = parseCodexConfig(await readJson(sourceDir, "config.json"));
    const adapter = new CodexAdapter(config);
    await initializeProcessRegistry(sourceDir);
    let cumulativeTokens = 0;
    const stopRequested = createStopRequestSignal();
    const phaseAbort = new AbortController();
    let watcherStopped = false;
    let observedRequest = await readHandoffRequestOptional(sourceDir);
    let deadlineInterrupted = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const armRequest = (request: NonNullable<typeof observedRequest>): void => {
      observedRequest = request;
      stopRequested.requested = true;
      if (deadlineTimer !== undefined || phaseAbort.signal.aborted) return;
      const delay = new Date(request.deadlineAt).getTime() - Date.now();
      if (delay <= 0) {
        deadlineInterrupted = true;
        phaseAbort.abort();
        return;
      }
      deadlineTimer = setTimeout(() => {
        deadlineInterrupted = true;
        phaseAbort.abort();
      }, delay);
      deadlineTimer.unref();
    };
    if (observedRequest !== null) armRequest(observedRequest);
    let watcherError: unknown = null;
    const watcher = (async () => {
      while (!watcherStopped && observedRequest === null) {
        const next = await readHandoffRequestOptional(sourceDir);
        if (next !== null) {
          armRequest(next);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })().catch((error: unknown) => {
      watcherError = error;
      stopRequested.requested = true;
      phaseAbort.abort();
    });
    await runLoop(envelope.work.contract, join(sourceDir, "run"), adapter, {
      stopRequested,
      phaseSignal: phaseAbort.signal,
      onProcessRegistered: async (registration) => {
        await registerProcess(sourceDir, registration);
        const request = await readHandoffRequestOptional(sourceDir);
        if (request !== null) {
          armRequest(request);
          throw new Error("control-handoff-latched-before-prompt");
        }
      },
      onPhaseSettled: async (observation) => {
        if (observation.tokenUsage !== null) {
          const next = cumulativeTokens + observation.tokenUsage;
          if (!Number.isSafeInteger(next)) throw new Error("control-usage-overflow");
          cumulativeTokens = next;
        }
        await appendUsageObservation(sourceDir, {
          runId: envelope.claim.runId,
          generation: envelope.claim.generation,
          bucket: "work",
          observationId: `attempt-${observation.attempt}-${observation.phase}`,
          threadTotalTokens: observation.tokenUsage === null ? null : cumulativeTokens,
          elapsedMs: observation.elapsedMs,
          attempts: observation.attempt,
          sessions: 1,
          evidence: observation,
        });
        const request = await readHandoffRequestOptional(sourceDir);
        if (request !== null) armRequest(request);
      },
      onRunSettledBeforeLeaseRelease: async (runState) => {
        watcherStopped = true;
        clearTimeout(deadlineTimer);
        await watcher;
        if (watcherError !== null) throw watcherError;
        const request = observedRequest ?? await readHandoffRequestOptional(sourceDir);
        if (request === null && !isTerminalRunStatus(runState.status)) {
          throw new Error("control-handoff-request-required");
        }
        const existingEvents = await readUsageEvents(sourceDir);
        const predictedHighWater = (existingEvents.at(-1)?.eventSeq ?? 0) + 1;
        const result = deadlineInterrupted
          ? "partial" as const
          : request !== null && !isTerminalRunStatus(runState.status)
            ? "complete" as const
            : runState.status === "succeeded"
              ? "complete" as const
              : runState.status === "blocked_waiting_human" || runState.status === "exhausted" || runState.status === "cancelled"
                ? "partial" as const
                : "failed" as const;
        const built = await buildHandoffPacket(envelope, request, runState, predictedHighWater, result);
        const handoffUsage = await appendUsageObservation(sourceDir, {
          runId: envelope.claim.runId,
          generation: envelope.claim.generation,
          bucket: "handoff",
          observationId: request === null ? `natural-${executionId}` : `handoff-${request.requestId}`,
          threadTotalTokens: 0,
          elapsedMs: 0,
          attempts: 0,
          sessions: 0,
          evidence: { requestId: request?.requestId ?? null, result, mechanical: true },
        });
        await persistHandoffCandidate(envelope, request, runState, built, {
          result,
          usageHighWater: handoffUsage.eventSeq,
        });
        await sealAcceptedWorker(sourceDir, executionId, nonce);
        sealed = true;
      },
    });
  } catch (error) {
    await recordWorkerError(sourceDir, error).catch(() => undefined);
    throw error;
  } finally {
    if (!sealed) await sealAcceptedWorker(sourceDir, executionId, nonce);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runControlWorker(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
