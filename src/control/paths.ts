import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { StartEnvelopeV1 } from "./protocol.js";

function invalid(): Error {
  return new Error("control-path-invalid");
}

function within(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

async function canonicalRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw invalid();
  try {
    const canonical = await realpath(root);
    const metadata = await lstat(root);
    if (canonical !== root || !metadata.isDirectory() || metadata.isSymbolicLink()) throw invalid();
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message === "control-path-invalid") throw error;
    throw invalid();
  }
}

async function assertExistingAncestors(root: string, target: string, includeLeaf: boolean): Promise<void> {
  const canonical = await canonicalRoot(root);
  const absolute = resolve(target);
  if (!within(canonical, absolute)) throw invalid();
  const suffix = relative(canonical, absolute).split(sep).filter(Boolean);
  const count = includeLeaf ? suffix.length : Math.max(0, suffix.length - 1);
  let current = canonical;
  for (let index = 0; index < count; index += 1) {
    current = join(current, suffix[index]!);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw invalid();
      if (index < count - 1 && !metadata.isDirectory()) throw invalid();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (error instanceof Error && error.message === "control-path-invalid") throw error;
      throw invalid();
    }
  }
}

export function controlRoot(envelope: StartEnvelopeV1): string {
  return join(envelope.work.sourceDir, "control");
}

export async function ensurePrivateDirectory(root: string, target: string): Promise<void> {
  const canonical = await canonicalRoot(root);
  const absolute = resolve(target);
  if (!within(canonical, absolute) || absolute === canonical) throw invalid();
  const suffix = relative(canonical, absolute).split(sep).filter(Boolean);
  let current = canonical;
  for (const part of suffix) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalid();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof Error && error.message === "control-path-invalid") throw error;
        throw invalid();
      }
      await mkdir(current, { mode: 0o700 });
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalid();
    }
  }
}

export async function readPrivateFile(root: string, target: string): Promise<Buffer> {
  await assertExistingAncestors(root, target, false);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw invalid();
    return await handle.readFile();
  } catch (error) {
    if (error instanceof Error && error.message === "control-path-invalid") throw error;
    throw invalid();
  } finally {
    await handle?.close();
  }
}

export async function atomicReplacePrivateFile(root: string, target: string, bytes: Buffer): Promise<void> {
  const parent = resolve(target, "..");
  await ensurePrivateDirectory(root, parent);
  await assertExistingAncestors(root, target, false);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw invalid();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof Error && error.message === "control-path-invalid") throw error;
      throw invalid();
    }
  }

  const temporary = join(parent, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
