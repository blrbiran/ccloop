import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexAdapter } from "../runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../runtime/codex/protocol.js";
import { runLoop } from "../controller/runLoop.js";
import { atomicReplacePrivateFile, readPrivateFile } from "./paths.js";
import { appendUsageObservation } from "./usage.js";
import { canonicalJson, parseControlRequest, type StartEnvelopeV1 } from "./protocol.js";
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

  try {
    const envelope = parseControlRequest("accept", await readJson(sourceDir, "envelope.json")) as StartEnvelopeV1;
    const config = parseCodexConfig(await readJson(sourceDir, "config.json"));
    const adapter = new CodexAdapter(config);
    let cumulativeTokens = 0;
    await runLoop(envelope.work.contract, join(sourceDir, "run"), adapter, {
      onProcessRegistered: async (registration) => {
        await registerProcess(sourceDir, registration);
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
      },
    });
  } catch (error) {
    await recordWorkerError(sourceDir, error).catch(() => undefined);
    throw error;
  } finally {
    await sealAcceptedWorker(sourceDir, executionId, nonce);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runControlWorker(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
