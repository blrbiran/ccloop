import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  canonicalHash,
  canonicalJson,
  ControlProtocolError,
  type AmountV1,
  type ArtifactRefV1,
} from "./protocol.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory, readPrivateFile } from "./paths.js";
import { writeEvidence } from "./evidence.js";

export interface UsageEventV1 {
  runId: string;
  generation: number;
  eventSeq: number;
  bucket: "work" | "handoff";
  cumulative: AmountV1 | null;
  source: ArtifactRefV1;
}

export interface UsageObservationInput {
  runId: string;
  generation: number;
  bucket: "work" | "handoff";
  observationId: string;
  threadTotalTokens: number | null;
  elapsedMs: number;
  attempts: number;
  sessions: number;
  evidence: unknown;
}

interface UsageStateV1 {
  protocol: 1;
  nextSeq: number;
  totals: Record<"work" | "handoff", AmountV1>;
  events: UsageEventV1[];
  observations: Record<string, { hash: string; eventSeq: number }>;
}

const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const amount = z.object({ tokens: safe, activeMs: safe, attempts: safe, sessions: safe }).strict();
const artifact = z.object({ artifactId: id, hash }).strict();
const eventSchema = z
  .object({
    runId: id,
    generation: positive,
    eventSeq: positive,
    bucket: z.enum(["work", "handoff"]),
    cumulative: amount.nullable(),
    source: artifact,
  })
  .strict();
const stateSchema = z
  .object({
    protocol: z.literal(1),
    nextSeq: positive,
    totals: z.object({ work: amount, handoff: amount }).strict(),
    events: z.array(eventSchema),
    observations: z.record(z.object({ hash, eventSeq: positive }).strict()),
  })
  .strict();
const inputSchema = z
  .object({
    runId: id,
    generation: positive,
    bucket: z.enum(["work", "handoff"]),
    observationId: id,
    threadTotalTokens: safe.nullable(),
    elapsedMs: safe,
    attempts: safe,
    sessions: safe,
    evidence: z.unknown(),
  })
  .strict();

function emptyAmount(): AmountV1 {
  return { tokens: 0, activeMs: 0, attempts: 0, sessions: 0 };
}

function emptyState(): UsageStateV1 {
  return {
    protocol: 1,
    nextSeq: 1,
    totals: { work: emptyAmount(), handoff: emptyAmount() },
    events: [],
    observations: {},
  };
}

function controlDir(sourceDir: string): string {
  return join(sourceDir, "control");
}

function usagePath(sourceDir: string): string {
  return join(controlDir(sourceDir), "usage.json");
}

function add(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new ControlProtocolError("control-usage-overflow");
  return value;
}

async function readState(sourceDir: string): Promise<UsageStateV1> {
  try {
    const parsed = JSON.parse((await readPrivateFile(sourceDir, usagePath(sourceDir))).toString("utf8")) as unknown;
    const result = stateSchema.safeParse(parsed);
    if (!result.success) throw new ControlProtocolError("control-usage-invalid");
    return result.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    if (error instanceof SyntaxError) throw new ControlProtocolError("control-usage-invalid");
    throw error;
  }
}

async function withUsageLock<T>(sourceDir: string, action: () => Promise<T>): Promise<T> {
  const directory = controlDir(sourceDir);
  await ensurePrivateDirectory(sourceDir, directory);
  const path = join(directory, "usage.lock");
  let handle;
  const deadline = Date.now() + 2_000;
  while (handle === undefined) {
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new ControlProtocolError("control-usage-busy");
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

export async function appendUsageObservation(
  sourceDir: string,
  rawInput: UsageObservationInput,
): Promise<UsageEventV1> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ControlProtocolError("control-usage-invalid");
  const input = parsed.data;
  const observationHash = canonicalHash(input);
  return await withUsageLock(sourceDir, async () => {
    const state = await readState(sourceDir);
    const prior = state.observations[input.observationId];
    if (prior !== undefined) {
      if (prior.hash !== observationHash) throw new ControlProtocolError("control-usage-conflict");
      const event = state.events.find((candidate) => candidate.eventSeq === prior.eventSeq);
      if (event === undefined) throw new ControlProtocolError("control-usage-invalid");
      return event;
    }

    const previous = state.totals[input.bucket];
    const totals: AmountV1 = {
      tokens: input.threadTotalTokens ?? previous.tokens,
      activeMs: add(previous.activeMs, input.elapsedMs),
      attempts: input.attempts,
      sessions: input.sessions,
    };
    const source = await writeEvidence(sourceDir, Buffer.from(canonicalJson(input.evidence)));
    const event: UsageEventV1 = {
      runId: input.runId,
      generation: input.generation,
      eventSeq: state.nextSeq,
      bucket: input.bucket,
      cumulative: input.threadTotalTokens === null ? null : totals,
      source,
    };
    const next: UsageStateV1 = {
      ...state,
      nextSeq: add(state.nextSeq, 1),
      totals: { ...state.totals, [input.bucket]: totals },
      events: [...state.events, event],
      observations: {
        ...state.observations,
        [input.observationId]: { hash: observationHash, eventSeq: event.eventSeq },
      },
    };
    await atomicReplacePrivateFile(sourceDir, usagePath(sourceDir), Buffer.from(`${canonicalJson(next)}\n`));
    return event;
  });
}

export async function readUsageEvents(sourceDir: string): Promise<UsageEventV1[]> {
  return [...(await readState(sourceDir)).events];
}
