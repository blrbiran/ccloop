import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicReplacePrivateFile, ensurePrivateDirectory, readPrivateFile } from "./paths.js";

export interface AcceptedRecordV1 {
  protocol: 1;
  envelopeHash: string;
  executionId: string;
  configHash: string;
  generation: number;
  acceptedAt: string;
  launch: "intended" | "claimed" | "sealed" | "unknown";
  worker: { pid: number; startedAt: string; nonce: string } | null;
}

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const safePositive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const acceptedSchema = z
  .object({
    protocol: z.literal(1),
    envelopeHash: hash,
    executionId: id,
    configHash: hash,
    generation: safePositive,
    acceptedAt: z.string().datetime({ offset: true }),
    launch: z.enum(["intended", "claimed", "sealed", "unknown"]),
    worker: z
      .object({ pid: safePositive, startedAt: z.string().datetime({ offset: true }), nonce: id })
      .strict()
      .nullable(),
  })
  .strict();

function root(sourceDir: string): string {
  return join(sourceDir, "control");
}

function acceptedPath(sourceDir: string): string {
  return join(root(sourceDir), "accepted.json");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readAccepted(sourceDir: string): Promise<AcceptedRecordV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readPrivateFile(sourceDir, acceptedPath(sourceDir))).toString("utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    if (error instanceof SyntaxError) throw new Error("control-accepted-invalid");
    throw error;
  }
  const result = acceptedSchema.safeParse(parsed);
  if (!result.success) throw new Error("control-accepted-invalid");
  return result.data;
}

export async function readAcceptedOptional(sourceDir: string): Promise<AcceptedRecordV1 | null> {
  try {
    return await readAccepted(sourceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && error.message === "control-path-invalid") {
      try {
        await readPrivateFile(sourceDir, acceptedPath(sourceDir));
      } catch (nested) {
        if ((nested as NodeJS.ErrnoException).code === "ENOENT") return null;
      }
    }
    throw error;
  }
}

export async function writeAccepted(sourceDir: string, record: AcceptedRecordV1): Promise<void> {
  const parsed = acceptedSchema.parse(record);
  await ensurePrivateDirectory(sourceDir, root(sourceDir));
  await atomicReplacePrivateFile(sourceDir, acceptedPath(sourceDir), Buffer.from(`${JSON.stringify(parsed)}\n`));
}

export async function withAcceptedLock<T>(sourceDir: string, action: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(sourceDir, root(sourceDir));
  const path = join(root(sourceDir), "accepted.lock");
  let handle;
  const deadline = Date.now() + 2_000;
  while (handle === undefined) {
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("control-accepted-busy");
      await wait(10);
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(path);
    const directory = await open(root(sourceDir), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export async function claimAcceptedWorker(
  sourceDir: string,
  worker: { executionId: string; nonce: string; pid: number; startedAt: string },
): Promise<boolean> {
  return await withAcceptedLock(sourceDir, async () => {
    const record = await readAccepted(sourceDir);
    if (record.launch !== "intended") return false;
    if (record.executionId !== worker.executionId) return false;
    await writeAccepted(sourceDir, {
      ...record,
      launch: "claimed",
      worker: { pid: worker.pid, startedAt: worker.startedAt, nonce: worker.nonce },
    });
    return true;
  });
}

export async function sealAcceptedWorker(sourceDir: string, executionId: string, nonce: string): Promise<void> {
  await withAcceptedLock(sourceDir, async () => {
    const record = await readAccepted(sourceDir);
    if (
      record.launch !== "claimed" ||
      record.executionId !== executionId ||
      record.worker?.nonce !== nonce
    ) {
      throw new Error("control-worker-claim-lost");
    }
    await writeAccepted(sourceDir, { ...record, launch: "sealed" });
  });
}

export async function markAcceptedUnknown(sourceDir: string, executionId: string): Promise<void> {
  await withAcceptedLock(sourceDir, async () => {
    const record = await readAccepted(sourceDir);
    if (record.executionId !== executionId || record.launch !== "intended") return;
    await writeAccepted(sourceDir, { ...record, launch: "unknown" });
  });
}
