import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactRefSchema, ControlProtocolError, type ArtifactRefV1 } from "./protocol.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "./paths.js";

export const MAX_TASK_RESULT_FILES = 64;
export const MAX_TASK_RESULT_FILE_BYTES = 1048576;
export const MAX_TASK_RESULT_PREVIEW_BYTES = 131072;
export const MAX_TASK_RESULT_EVIDENCE_BYTES = 16 * 1024 * 1024;
export const taskResultDigest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function safeTaskResultPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !/[\\\0:]/.test(path) && !isAbsolute(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
export class TaskResultFileError extends Error {
  constructor(readonly status: "symlink" | "unsafe" | "unavailable" | "too-large" | "changed" | "missing") { super(status); }
}
// Darwin sys/fcntl.h: O_NOFOLLOW_ANY=0x20000000 rejects symlinks anywhere in a path.
// It is mutually exclusive with O_NOFOLLOW. Unsupported native flags fail closed; there is no path-only fallback.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
function noFollowFlag(): number {
  if (process.platform === "darwin") return DARWIN_O_NOFOLLOW_ANY;
  if (process.platform === "linux") return constants.O_NOFOLLOW;
  throw new TaskResultFileError("unavailable");
}

type DirectoryPin = {
  path: string;
  handle: FileHandle;
  metadata: BigIntStats;
};
function sameEntry(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs;
}
function childPath(parent: DirectoryPin, name: string): string {
  return process.platform === "linux" ? `/proc/self/fd/${parent.handle.fd}/${name}` : join(parent.path, name);
}

/** Pin validated directories, reject namespace changes, and bound reads even if the leaf grows. */
export async function readTaskResultFile(root: string, target: string, limit: number): Promise<Buffer> {
  const suffix = relative(root, resolve(target));
  if (!isAbsolute(root) || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new TaskResultFileError("unsafe");
  }
  const pins: DirectoryPin[] = [];
  let handle: FileHandle | undefined;
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag();
  const pinDirectory = async (path: string, anchoredPath: string): Promise<DirectoryPin> => {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink()) throw new TaskResultFileError("symlink");
    if (!metadata.isDirectory()) throw new TaskResultFileError("unavailable");
    let directory;
    try {
      directory = await open(anchoredPath, flags | constants.O_DIRECTORY);
    } catch (error) {
      if (["ELOOP", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new TaskResultFileError("changed");
      }
      throw error;
    }
    const pin = { path, handle: directory, metadata };
    pins.push(pin);
    const opened = await directory.stat({ bigint: true });
    if (!opened.isDirectory() || !sameEntry(metadata, opened)) throw new TaskResultFileError("changed");
    return pin;
  };
  try {
    if (await realpath(root) !== root) throw new TaskResultFileError("symlink");
    let parent = await pinDirectory(root, root);
    if (process.platform === "linux") {
      // Verify the kernel descriptor namespace exists. Never fall back to pathname traversal.
      try {
        const descriptor = await stat(`/proc/self/fd/${parent.handle.fd}`, { bigint: true });
        if (!sameEntry(parent.metadata, descriptor)) throw new TaskResultFileError("changed");
      } catch (error) {
        if (error instanceof TaskResultFileError) throw error;
        throw new TaskResultFileError("unavailable");
      }
    }
    const components = suffix.split(sep).filter(Boolean);
    for (const name of components.slice(0, -1)) {
      parent = await pinDirectory(join(parent.path, name), childPath(parent, name));
    }
    const leaf = await lstat(target, { bigint: true });
    if (leaf.isSymbolicLink()) throw new TaskResultFileError("symlink");
    if (!leaf.isFile()) throw new TaskResultFileError("unavailable");
    if (leaf.size > BigInt(limit)) throw new TaskResultFileError("too-large");
    try {
      handle = await open(childPath(parent, components.at(-1) ?? ""), flags);
    } catch (error) {
      if (["ELOOP", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new TaskResultFileError("changed");
      }
      throw error;
    }
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameEntry(leaf, before)) throw new TaskResultFileError("changed");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(target, { bigint: true });
    if (BigInt(size) !== before.size || !sameEntry(before, after) || !sameEntry(before, current)) {
      throw new TaskResultFileError("changed");
    }
    for (const pin of pins) {
      const held = await pin.handle.stat({ bigint: true });
      const named = await lstat(pin.path, { bigint: true });
      if (!held.isDirectory() || !named.isDirectory()
        || !sameEntry(pin.metadata, held) || !sameEntry(pin.metadata, named)) {
        throw new TaskResultFileError("changed");
      }
    }
    return buffer.subarray(0, size);
  } catch (error) {
    if (error instanceof TaskResultFileError) throw error;
    throw new TaskResultFileError((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable");
  } finally {
    await handle?.close();
    for (const pin of pins.reverse()) await pin.handle.close();
  }
}

/** Result-index-only publication: the ownership check is immediately after staging/sync and before rename. */
export async function publishTaskResultIndex(
  sourceDir: string,
  target: string,
  bytes: Buffer,
  assertHeld: () => Promise<void>,
): Promise<void> {
  const parent = dirname(target);
  await assertHeld();
  await ensurePrivateDirectory(sourceDir, parent);
  const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlag());
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  let staging: FileHandle | undefined;
  try {
    try {
      const previous = await lstat(target);
      if (previous.isSymbolicLink() || !previous.isFile()) throw new TaskResultFileError("unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    staging = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
    await staging.writeFile(bytes);
    await staging.sync();
    await staging.close();
    staging = undefined;
    await assertHeld();
    await rename(temporary, target);
    await directory.sync();
  } catch (error) {
    await staging?.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await directory.close();
  }
}

export function taskResultEvidencePath(sourceDir:string,ref:ArtifactRefV1):string {
  const parsed=artifactRefSchema.safeParse(ref);
  if(!parsed.success || ref.artifactId!==`task-result-${ref.hash}`)throw new ControlProtocolError("control-task-result-ref-invalid");
  return join(sourceDir,"control","task-result-evidence",`${ref.artifactId}.bin`);
}
export async function writeTaskResultEvidence(sourceDir:string,bytes:Buffer,assertHeld:()=>Promise<void>):Promise<ArtifactRefV1> {
  if(bytes.length>MAX_TASK_RESULT_EVIDENCE_BYTES)throw new Error("task-result-evidence-too-large");
  const hash=taskResultDigest(bytes),ref={artifactId:`task-result-${hash}`,hash};
  try {
    await readCapturedTaskResultEvidence(sourceDir,ref);
    return ref;
  } catch (error) {
    if (!(error instanceof TaskResultFileError && error.status === "missing")) throw error;
  }
  await assertHeld();await ensurePrivateDirectory(sourceDir,join(sourceDir,"control","task-result-evidence"));
  await assertHeld();await atomicReplacePrivateFile(sourceDir,taskResultEvidencePath(sourceDir,ref),bytes);
  return ref;
}
export async function readCapturedTaskResultEvidence(sourceDir:string,ref:ArtifactRefV1):Promise<Buffer> {
  const bytes=await readTaskResultFile(sourceDir,taskResultEvidencePath(sourceDir,ref),MAX_TASK_RESULT_EVIDENCE_BYTES);
  if(taskResultDigest(bytes)!==ref.hash)throw new ControlProtocolError("control-task-result-hash-mismatch");
  return bytes;
}
