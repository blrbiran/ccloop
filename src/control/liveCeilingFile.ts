import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { liveCeilingSchema, type LiveCeiling } from "../budget/liveCeiling.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory, readPrivateFile } from "./paths.js";
import { canonicalHash, canonicalJson, ControlProtocolError, type StartEnvelopeV3 } from "./protocol.js";
import { readAcceptedOptional } from "./store.js";

// Live token ceiling (Orca tester follow-up G part 2): the run's current ceiling lives in its control directory, written
// only by ccloop -- seeded by the worker from the envelope, raised by Orca through the `live-ceiling` method -- and re-read
// by the worker while a phase streams.

export function liveCeilingPath(sourceDir: string): string {
  return join(sourceDir, "control", "live-ceiling.json");
}

export async function readLiveCeilingOptional(sourceDir: string): Promise<LiveCeiling | null> {
  let bytes: Buffer;
  try {
    bytes = await readPrivateFile(sourceDir, liveCeilingPath(sourceDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = liveCeilingSchema.safeParse(JSON.parse(bytes.toString("utf8")) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    // not JSON: the same named failure as a body that fails its schema
  }
  throw new ControlProtocolError("control-live-ceiling-invalid");
}

async function withLiveCeilingLock<T>(sourceDir: string, action: () => Promise<T>): Promise<T> {
  const root = join(sourceDir, "control");
  await ensurePrivateDirectory(sourceDir, root);
  const path = join(root, "live-ceiling.lock");
  let handle;
  const deadline = Date.now() + 2_000;
  while (handle === undefined) {
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new ControlProtocolError("control-live-ceiling-busy");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(path);
  }
}

/** Replaces the ceiling (0600, atomic); a revision that is not newer than the stored one is control-live-ceiling-stale. */
export async function writeLiveCeiling(sourceDir: string, ceiling: LiveCeiling): Promise<void> {
  const parsed = liveCeilingSchema.safeParse(ceiling);
  if (!parsed.success) throw new ControlProtocolError("control-live-ceiling-invalid");
  await withLiveCeilingLock(sourceDir, async () => {
    const stored = await readLiveCeilingOptional(sourceDir);
    if (stored !== null && parsed.data.revision <= stored.revision) throw new ControlProtocolError("control-live-ceiling-stale");
    await atomicReplacePrivateFile(sourceDir, liveCeilingPath(sourceDir), Buffer.from(`${canonicalJson(parsed.data)}\n`));
  });
}

/**
 * The `live-ceiling` control method: only for an accepted run whose envelope opted in (a protocol-4 loop envelope carrying
 * `liveCeiling`); answers the revision and tokens it stored.
 */
export async function updateLiveCeiling(envelope: StartEnvelopeV3, ceiling: LiveCeiling): Promise<{ revision: number; tokens: number }> {
  if (envelope.liveCeiling === undefined) throw new ControlProtocolError("control-live-ceiling-unsupported");
  const accepted = await readAcceptedOptional(envelope.work.sourceDir);
  if (accepted === null) throw new ControlProtocolError("control-live-ceiling-not-accepted");
  if (accepted.envelopeHash !== canonicalHash(envelope)) throw new ControlProtocolError("control-envelope-conflict");
  await writeLiveCeiling(envelope.work.sourceDir, ceiling);
  return { revision: ceiling.revision, tokens: ceiling.tokens };
}

/**
 * The worker's view of the ceiling while the run runs: the highest revision read so far, polled every 50 ms (the handoff
 * request watcher polls every 20 ms). A read that fails keeps the last good value; the first failure of each streak is
 * reported through `onReadFailed`, so a run never stops or speeds up on a file it could not read.
 */
export function createLiveCeilingWatch(
  sourceDir: string,
  initial: LiveCeiling,
  onReadFailed: (error: unknown) => Promise<void> = async () => undefined,
): { current(): LiveCeiling; stop(): Promise<void> } {
  let current = initial;
  let stopped = false;
  let failing = false;
  let wake: () => void = () => undefined;
  const loop = (async () => {
    while (!stopped) {
      try {
        const read = await readLiveCeilingOptional(sourceDir);
        if (read !== null && read.revision > current.revision) current = read;
        failing = false;
      } catch (error) {
        if (!failing) await onReadFailed(error).catch(() => undefined);
        failing = true;
      }
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 50); timer.unref(); wake = () => { clearTimeout(timer); resolve(); }; });
    }
  })();
  return {
    current: () => current,
    stop: async () => { stopped = true; wake(); await loop; },
  };
}
