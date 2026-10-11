import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentError } from "./types.js";
import { testCrashPoint } from "../control/testCrashPoint.js";
import { readAgentsTableSnapshot } from "./table.js";

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const updatesRoot = (tablePath: string) => `${tablePath}.updates`;

function fail(detail: string): never { throw new AgentError("agent-installation-update-invalid", detail); }

async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}

export async function assertUpdatesRoot(tablePath: string, create: boolean): Promise<string> {
  const root = updatesRoot(tablePath);
  if (create) {
    try { await mkdir(root, { mode: 0o700 }); await syncDirectory(dirname(root)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.geteuid!() || (metadata.mode & 0o077) !== 0) fail("updates directory is not private");
  return root;
}

export async function readOwnedJson<T>(root: string, name: string): Promise<T | null> {
  let fd;
  try {
    fd = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await fd.stat();
    if (!info.isFile() || info.uid !== process.geteuid!() || (info.mode & 0o077) !== 0 || info.size > 4 * 1024 * 1024) fail(`invalid owned file ${name}`);
    const bytes = await fd.readFile();
    if (bytes.length > 4 * 1024 * 1024) fail(`oversized owned file ${name}`);
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally { await fd?.close(); }
}

export async function writeOwnedJson(root: string, name: string, value: unknown): Promise<void> {
  const fd = await open(join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(`${JSON.stringify(value)}\n`); await fd.sync(); }
  finally { await fd.close(); }
  await syncDirectory(root);
}

async function deadLock(root: string): Promise<boolean> {
  const lock = join(root, "lock");
  const owner = await readOwnedJson<{ pid: number }>(root, "lock");
  if (owner === null) return false;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail("invalid update lock owner");
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** The sole table-scoped writer lock, shared by every apply entry point and every process. */
export async function withTableUpdateLock<T>(tablePath: string, opId: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await assertUpdatesRoot(tablePath, true);
  const lock = join(root, "lock");
  const deadline = Date.now() + 20_000;
  const token = randomUUID();
  while (true) {
    const ticket = join(root, `claim-${opId}-${randomUUID()}.json`);
    await writeOwnedJson(root, ticket.split("/").at(-1)!, { pid: process.pid, token });
    try {
      // The claim is fully written before its hard link becomes the lock; readers never see an
      // ownerless lock and therefore cannot mistake a paused writer for a crashed one.
      await link(ticket, lock);
      await syncDirectory(root);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await deadLock(root)) {
        // One reclaimer at a time. Without this guard, two reclaimers could both observe the dead
        // owner and the slower one could rename a live lock freshly acquired by another process.
        const reclaim = join(root, "reclaim");
        try { await mkdir(reclaim, { mode: 0o700 }); }
        catch (race) { if ((race as NodeJS.ErrnoException).code !== "EEXIST") throw race; await new Promise((resolve) => setTimeout(resolve, 30)); continue; }
        try {
          if (await deadLock(root)) {
            const moved = join(root, `stale-${randomUUID()}`);
            await rename(lock, moved);
            await unlink(moved);
          }
        } finally { await rm(reclaim, { recursive: true, force: true }); }
        continue;
      }
      if (Date.now() >= deadline) fail("update lock timeout");
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      await unlink(ticket).catch(() => undefined);
    }
  }
  try { return await fn(root); }
  finally {
    const owner = await readOwnedJson<{ token: string }>(root, "lock");
    if (owner?.token !== token) fail("update lock ownership changed");
    await unlink(lock);
    await syncDirectory(root);
  }
}

function temporaryName(opId: string, digest: string): string { return `table-${opId}-${digest}.tmp`; }

export async function cleanupOperationTemporary(root: string, opId: string, digest: string): Promise<void> {
  const temporary = join(root, temporaryName(opId, digest));
  let info;
  try { info = await lstat(temporary); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid!()) fail("invalid operation temporary file");
  await unlink(temporary);
  await syncDirectory(root);
}

export async function replaceTableDurably(tablePath: string, root: string, bytes: Buffer, expectedBytes: Buffer, mode: number, opId: string, digest: string): Promise<void> {
  const parent = dirname(tablePath);
  const temporary = join(root, temporaryName(opId, digest));
  let fd;
  try {
    fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await fd.writeFile(bytes);
    await fd.chmod(mode);
    await fd.sync();
    await fd.close();
    fd = undefined;
    await syncDirectory(root);
    await testCrashPoint("agent-update-temp-fsynced");
    // This check follows all temporary-file I/O and immediately precedes the atomic replacement.
    if (!(await readAgentsTableSnapshot(tablePath)).bytes.equals(expectedBytes)) {
      throw new AgentError("agent-installation-update-stale");
    }
    await rename(temporary, tablePath);
    await syncDirectory(parent);
  } catch (error) {
    await fd?.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
