import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveAgent } from "../agents/materialize.js";
import { readAgentsTable } from "../agents/table.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "./paths.js";
import {
  canonicalHash,
  canonicalJson,
  ControlProtocolError,
  type StartEnvelopeV2,
} from "./protocol.js";
import { launchWorker, workerIdentityMatches, type WorkerLaunchDeps } from "./workerLauncher.js";
import {
  markAcceptedUnknown,
  readAccepted,
  readAcceptedOptional,
  withAcceptedLock,
  writeAccepted,
  type AcceptedRecordV1,
} from "./store.js";
import { testCrashPoint } from "./testCrashPoint.js";

export type ExecutionStatusV1 =
  | { kind: "absent" }
  | { kind: "accepted"; executionId: string; configHash: string }
  | { kind: "unknown" }
  | {
      kind: "stopped";
      proof: {
        executionId: string;
        generation: number;
        isolated: true;
        source: { artifactId: string; hash: string };
      };
    };

export interface AgentBindingV1 {
  agentsTablePath: string;
  workerCommand?: string[];
  workerEnv?: Record<string, string>;
  receiptTimeoutMs?: number;
}

async function status(record: AcceptedRecordV1): Promise<ExecutionStatusV1> {
  if (record.launch === "intended" || record.launch === "unknown") return { kind: "unknown" };
  if (record.launch === "claimed" && !(await workerIdentityMatches(record.worker))) return { kind: "unknown" };
  return { kind: "accepted", executionId: record.executionId, configHash: record.configHash };
}

function assertEnvelope(record: AcceptedRecordV1, input: StartEnvelopeV2): void {
  if (record.envelopeHash !== canonicalHash(input)) {
    throw new ControlProtocolError("control-envelope-conflict");
  }
}

export async function inspectStart(input: StartEnvelopeV2): Promise<ExecutionStatusV1> {
  const record = await readAcceptedOptional(input.work.sourceDir);
  if (record === null) return { kind: "absent" };
  assertEnvelope(record, input);
  return await status(record);
}

export async function acceptStart(
  input: StartEnvelopeV2,
  binding: AgentBindingV1,
): Promise<ExecutionStatusV1> {
  const existing = await readAcceptedOptional(input.work.sourceDir);
  if (existing !== null) {
    assertEnvelope(existing, input);
    return await status(existing);
  }

  // Agent selection (2026-09-26), spec §4.6: materialize the claimed selection against the table (which also runs
  // `<command> --version` against the recorded version: agent-version-drift); the claim's configHash must be the
  // materialized config's canonical hash. A replayed accept above never reads the table (spec §4.2, I4).
  const table = await readAgentsTable(binding.agentsTablePath);
  const { config, resolution } = await resolveAgent(table, input.claim.agent);
  const configHash = resolution.configHash;
  if (configHash !== input.claim.configHash) {
    throw new ControlProtocolError("control-config-hash-mismatch");
  }

  const proposed: AcceptedRecordV1 = {
    protocol: 1,
    envelopeHash: canonicalHash(input),
    executionId: `execution-${randomUUID()}`,
    configHash,
    generation: input.claim.generation,
    acceptedAt: new Date().toISOString(),
    launch: "intended",
    worker: null,
  };
  const prepared = await withAcceptedLock(input.work.sourceDir, async () => {
    const raced = await readAcceptedOptional(input.work.sourceDir);
    if (raced !== null) return { created: false as const, record: raced };
    const controlDir = join(input.work.sourceDir, "control");
    await ensurePrivateDirectory(input.work.sourceDir, controlDir);
    await atomicReplacePrivateFile(
      input.work.sourceDir,
      join(controlDir, "config.json"),
      Buffer.from(`${canonicalJson(config)}\n`),
    );
    await atomicReplacePrivateFile(
      input.work.sourceDir,
      join(controlDir, "envelope.json"),
      Buffer.from(`${canonicalJson(input)}\n`),
    );
    await writeAccepted(input.work.sourceDir, proposed);
    return { created: true as const, record: proposed };
  });
  if (!prepared.created) {
    assertEnvelope(prepared.record, input);
    return await status(prepared.record);
  }
  const record = prepared.record;
  await testCrashPoint("accepted-fsynced");

  const defaultWorker = [process.execPath, fileURLToPath(new URL("./worker.js", import.meta.url))];
  const launchDeps: WorkerLaunchDeps = {
    sourceDir: input.work.sourceDir,
    workerCommand: binding.workerCommand ?? defaultWorker,
    workerEnv: binding.workerEnv,
    receiptTimeoutMs: binding.receiptTimeoutMs,
  };
  try {
    await launchWorker(record, launchDeps);
  } catch {
    await markAcceptedUnknown(input.work.sourceDir, record.executionId).catch(() => undefined);
    return { kind: "unknown" };
  }
  return await inspectStart(input);
}
