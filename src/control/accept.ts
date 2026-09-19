import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseCodexConfig } from "../runtime/codex/protocol.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "./paths.js";
import {
  canonicalHash,
  canonicalJson,
  ControlProtocolError,
  type StartEnvelopeV1,
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

export type ExecutionStatusV1 =
  | { kind: "absent" }
  | { kind: "accepted"; executionId: string; configHash: string }
  | { kind: "unknown" };

export interface AdapterBindingV1 {
  adapter: "codex";
  adapterConfigPath: string;
  workerCommand?: string[];
  workerEnv?: Record<string, string>;
  receiptTimeoutMs?: number;
}

async function readConfig(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("control-adapter-config-invalid");
    return JSON.parse((await handle.readFile()).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("control-adapter-config-invalid");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function status(record: AcceptedRecordV1): Promise<ExecutionStatusV1> {
  if (record.launch === "intended" || record.launch === "unknown") return { kind: "unknown" };
  if (record.launch === "claimed" && !(await workerIdentityMatches(record.worker))) return { kind: "unknown" };
  return { kind: "accepted", executionId: record.executionId, configHash: record.configHash };
}

function assertEnvelope(record: AcceptedRecordV1, input: StartEnvelopeV1): void {
  if (record.envelopeHash !== canonicalHash(input)) {
    throw new ControlProtocolError("control-envelope-conflict");
  }
}

export async function inspectStart(input: StartEnvelopeV1): Promise<ExecutionStatusV1> {
  const record = await readAcceptedOptional(input.work.sourceDir);
  if (record === null) return { kind: "absent" };
  assertEnvelope(record, input);
  return await status(record);
}

export async function acceptStart(
  input: StartEnvelopeV1,
  adapterBinding: AdapterBindingV1,
): Promise<ExecutionStatusV1> {
  const existing = await readAcceptedOptional(input.work.sourceDir);
  if (existing !== null) {
    assertEnvelope(existing, input);
    return await status(existing);
  }

  const config = parseCodexConfig(await readConfig(adapterBinding.adapterConfigPath));
  const configHash = canonicalHash(config);
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
    await writeAccepted(input.work.sourceDir, proposed);
    return { created: true as const, record: proposed };
  });
  if (!prepared.created) {
    assertEnvelope(prepared.record, input);
    return await status(prepared.record);
  }
  const record = prepared.record;

  const defaultWorker = [process.execPath, fileURLToPath(new URL("./workerLauncher.js", import.meta.url))];
  const launchDeps: WorkerLaunchDeps = {
    sourceDir: input.work.sourceDir,
    workerCommand: adapterBinding.workerCommand ?? defaultWorker,
    workerEnv: adapterBinding.workerEnv,
    receiptTimeoutMs: adapterBinding.receiptTimeoutMs,
  };
  try {
    await launchWorker(record, launchDeps);
  } catch {
    await markAcceptedUnknown(input.work.sourceDir, record.executionId).catch(() => undefined);
    return { kind: "unknown" };
  }
  return await inspectStart(input);
}
