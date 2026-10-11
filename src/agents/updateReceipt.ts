import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
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
  const temporary = join(root, `${name}.tmp`);
  const target = join(root, name);
  // A previous crash may have left this operation's unpublished temporary. No final artifact
  // is read or replaced here, and only this exact private owned temporary can be removed.
  let old;
  try { old = await lstat(temporary); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (old !== undefined) {
    if (!old.isFile() || old.isSymbolicLink() || old.uid !== process.geteuid!() || (old.mode & 0o077) !== 0) fail("invalid owned JSON temporary file");
    await unlink(temporary);
    await syncDirectory(root);
  }
  const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (name.startsWith("intent-")) await testCrashPoint("agent-update-intent-open");
    if (name.startsWith("receipt-")) await testCrashPoint("agent-update-receipt-open");
    await fd.writeFile(`${JSON.stringify(value)}\n`);
    await fd.sync();
  } catch (error) {
    await fd.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await fd.close();
  try {
    await syncDirectory(root);
    // link is atomic and refuses an existing immutable preview, intent or receipt. Readers
    // cannot observe a partial final JSON file, even if the process dies during writing.
    await link(temporary, target);
    await syncDirectory(root);
  } finally {
    await unlink(temporary).catch(() => undefined);
    await syncDirectory(root);
  }
}

async function ensureKernelLockFile(root: string): Promise<string> {
  const lock = join(root, "lock");
  try {
    const fd = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.sync(); } finally { await fd.close(); }
    await syncDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(lock);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid!() || (info.mode & 0o077) !== 0) fail("invalid update lock file");
  return lock;
}

/** One fixed kernel lock per table. A killed parent closes the helper's stdin, releasing the lock. */
export async function withTableUpdateLock<T>(tablePath: string, _opId: string, fn: (root: string, assertHeld: () => void) => Promise<T>): Promise<T> {
  const root = await assertUpdatesRoot(tablePath, true);
  const lock = await ensureKernelLockFile(root);
  if (process.platform !== "darwin" && process.platform !== "linux") fail("unsupported update lock platform");
  const script = 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));process.stdout.write("LOCKED\\n");';
  const command = process.platform === "darwin" ? "/usr/bin/lockf" : "/usr/bin/flock";
  const args = process.platform === "darwin"
    ? ["-k", "-t", "20", lock, process.execPath, "-e", script]
    : ["-x", "-w", "20", lock, process.execPath, "-e", script];
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  child.stdin.on("error", () => undefined);
  let ready = false;
  let lost = false;
  let output = "";
  let errorOutput = "";
  const closed = new Promise<void>((resolve) => child.once("close", () => { lost = true; resolve(); }));
  const acquired = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new AgentError("agent-installation-update-invalid", "table lock timeout")); }, 25_000);
    const settle = (error?: Error): void => {
      if (ready) return;
      ready = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("LOCKED\n")) settle();
      if (output.length > 1024) settle(new AgentError("agent-installation-update-invalid", "table lock helper output overflow"));
    });
    child.stderr.on("data", (chunk: Buffer) => { errorOutput = `${errorOutput}${chunk.toString("utf8")}`.slice(0, 1024); });
    child.once("error", (error) => settle(new AgentError("agent-installation-update-invalid", `table lock helper unavailable: ${error.message}`)));
    child.once("close", () => settle(new AgentError("agent-installation-update-invalid", `table lock helper exited: ${errorOutput || "no details"}`)));
  });
  try {
    await acquired;
    const assertHeld = (): void => { if (lost || child.exitCode !== null || child.signalCode !== null) fail("table lock helper lost"); };
    assertHeld();
    await testCrashPoint("agent-update-lock-recovery-acquired");
    return await fn(root, assertHeld);
  } finally {
    child.stdin.end();
    const releaseDeadline = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try { await closed; } finally { clearTimeout(releaseDeadline); }
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

export async function replaceTableDurably(tablePath: string, root: string, bytes: Buffer, expectedBytes: Buffer, mode: number, opId: string, digest: string, assertHeld: () => void = () => undefined): Promise<void> {
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
    assertHeld();
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
