import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { classifyOwnerProcess, parseLstartUtc, readProcessStart } from "../ownership/ownerLiveness.js";
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

type LockHolder = { pid: number; startedAt: string | null; nonce: string };
let ownStart: Promise<string | null> | undefined;
/** This process's start instant (ISO-8601, from `ps lstart` read as UTC), read once. */
function ownStartedAt(): Promise<string | null> {
  ownStart ??= readProcessStart(process.pid).then((lstart) => {
    const seconds = lstart === null ? null : parseLstartUtc(lstart);
    return seconds === null ? null : new Date(seconds * 1000).toISOString();
  });
  return ownStart;
}

async function readLockHolder(path: string): Promise<LockHolder | null> {
  let text: string;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(text) as Partial<LockHolder>;
    if (Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.nonce === "string" && value.nonce !== "" &&
      (value.startedAt === null || (typeof value.startedAt === "string" && !Number.isNaN(Date.parse(value.startedAt))))) {
      return { pid: value.pid as number, startedAt: value.startedAt as string | null, nonce: value.nonce };
    }
  } catch { /* not a holder identity */ }
  return { pid: 0, startedAt: null, nonce: "" };
}

/** Only a holder whose recorded identity proves it dead (pid gone, or held by a later-started process) is stale. */
async function holderDead(holder: LockHolder): Promise<boolean> {
  if (holder.nonce === "" || holder.startedAt === null) return false;
  const verdict = await classifyOwnerProcess({ currentProcessInstanceId: `pid:${holder.pid}:${Date.parse(holder.startedAt)}`, lastAffirmedAt: holder.startedAt });
  return verdict.verdict === "dead";
}

/** Whether this contender removed the stale holder's lock (false: another recoverer has it, or the lock changed). */
async function removeStaleLock(path: string, stale: LockHolder): Promise<boolean> {
  const claim = `${path}.stale-${stale.nonce}`;
  try {
    await link(path, claim);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw error;
  }
  const claimed = await readLockHolder(claim);
  if (claimed?.nonce === stale.nonce) {
    await unlink(path);
    process.stderr.write(`ccloop-control: removed ${path} held by dead pid ${stale.pid} (started ${stale.startedAt})\n`);
  }
  await unlink(claim);
  return claimed?.nonce === stale.nonce;
}

/**
 * Orca follow-up J: a holder killed inside the lock (a settle-lost-worker, a worker) left accepted.lock behind, and every later
 * claim / seal / settle answered control-accepted-busy forever. The lock now names its holder (pid + process start, the
 * worker-liveness identity), and is made visible only with that content (written aside, then hard-linked into place). A
 * contender that finds a provably dead holder removes the lock and tries again; one that is alive, or undeterminable (a
 * lock without a readable identity, as older ccloop wrote), keeps it -- still control-accepted-busy, removed by hand.
 * Removal is exclusive per stale holder: the recoverer first hard-links the lock to `accepted.lock.stale-<nonce>`, which only
 * one can create, and unlinks the lock only when that link carries the stale nonce -- so a lock another contender has made
 * since is never removed. (A recoverer killed between that link and the unlink leaves the lock: undeterminable again.)
 */
export async function withAcceptedLock<T>(sourceDir: string, action: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(sourceDir, root(sourceDir));
  const path = join(root(sourceDir), "accepted.lock");
  const nonce = randomUUID();
  const content = `${JSON.stringify({ pid: process.pid, startedAt: await ownStartedAt(), nonce })}\n`;
  const aside = `${path}.${nonce}`;
  const handle = await open(aside, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  const judged = new Map<string, boolean>();
  const deadline = Date.now() + 2_000;
  try {
    for (;;) {
      try {
        await link(aside, path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = await readLockHolder(path);
      if (holder === null) continue;
      if (!judged.has(holder.nonce)) judged.set(holder.nonce, await holderDead(holder));
      if (judged.get(holder.nonce) === true && (await removeStaleLock(path, holder))) continue;
      if (Date.now() >= deadline) throw new Error("control-accepted-busy");
      await wait(10);
    }
  } finally {
    await unlink(aside);
  }
  try {
    return await action();
  } finally {
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
