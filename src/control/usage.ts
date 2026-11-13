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

/**
 * Per-model token usage; `input` is non-cached input. Arrays are sorted by `model`, unique.
 * Orca raw usage detail (Orca spec 2026-11-13-raw-usage-detail-design.md §3, §8): the optional keys are raw sub-parts and
 * annotations a later price step reads, never a fifth addend -- the four parts alone add up to the tokens booked. Each is
 * present only when the provider reported it (absent is unknown, never 0): `reasoning` is of `output`; `cacheWrite5m` and
 * `cacheWrite1h` are of `cacheWrite`; `requests` counts model requests; `maxRequestInput` is the largest single request's
 * input + cacheRead + cacheWrite among the requests of the phase (or single call) that produced the event (§8.5).
 */
export interface ModelUsageV1 {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  requests?: number;
  maxRequestInput?: number;
}

/** Orca raw usage detail §8.1: the loop phase a work event settles; absent on every other event (single calls included). */
export type UsagePhaseV1 = "plan" | "execute" | "verify" | "setup";

export interface UsageEventV1 {
  runId: string;
  generation: number;
  eventSeq: number;
  bucket: "work" | "handoff";
  cumulative: AmountV1 | null;
  source: ArtifactRefV1;
  byModel?: ModelUsageV1[];
  phase?: UsagePhaseV1;
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
  byModel?: ModelUsageV1[];
  phase?: UsagePhaseV1;
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
export const modelUsageSchema = z
  .object({
    model: z.string().min(1).max(200), input: safe, output: safe, cacheRead: safe, cacheWrite: safe,
    reasoning: safe.optional(), cacheWrite5m: safe.optional(), cacheWrite1h: safe.optional(),
    requests: safe.optional(), maxRequestInput: safe.optional(),
  })
  .strict()
  // Orca raw usage detail §5: a sub-part is never larger than the part it is of; no producer emits one that is.
  .refine((entry) => entry.reasoning === undefined || entry.reasoning <= entry.output)
  .refine((entry) => (entry.cacheWrite5m ?? 0) + (entry.cacheWrite1h ?? 0) <= entry.cacheWrite)
  .refine((entry) => entry.maxRequestInput === undefined || entry.maxRequestInput <= entry.input + entry.cacheRead + entry.cacheWrite);
export const usagePhaseSchema = z.enum(["plan", "execute", "verify", "setup"]);
// Orca accounts plan B2 (2026-10-07), controller ruling: an empty breakdown is not a way to write "unknown"; absent is.
export const byModelSchema = z
  .array(modelUsageSchema)
  .min(1)
  .refine((entries) => entries.every((entry, index) => index === 0 || entries[index - 1]!.model < entry.model));
/**
 * Orca accounts plan B2 (2026-10-07): the breakdown, when it has entries and they add up to exactly `tokens`; otherwise
 * undefined. ccloop never puts on an event a breakdown it knows does not reconcile (Orca still checks).
 */
export function reconciledByModel(entries: ModelUsageV1[] | undefined, tokens: number | null): ModelUsageV1[] | undefined {
  if (entries === undefined || entries.length === 0 || tokens === null) return undefined;
  const sum = entries.reduce((total, entry) => total + entry.input + entry.output + entry.cacheRead + entry.cacheWrite, 0);
  return sum === tokens ? entries : undefined;
}

const eventSchema = z
  .object({
    runId: id,
    generation: positive,
    eventSeq: positive,
    bucket: z.enum(["work", "handoff"]),
    cumulative: amount.nullable(),
    source: artifact,
    byModel: byModelSchema.optional(),
    phase: usagePhaseSchema.optional(),
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
export const usageLedgerSchema = stateSchema;
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
    byModel: byModelSchema.optional(),
    phase: usagePhaseSchema.optional(),
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
      ...(input.byModel === undefined ? {} : { byModel: input.byModel }),
      ...(input.phase === undefined ? {} : { phase: input.phase }),
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


export interface AllowanceUsageIdentity {
  runId: string;
  generation: unknown;
  usageHighWater: unknown;
}

/** Exact parked-boundary ledger, before the mechanical handoff event is appended. */
export function parseKnownWorkUsageLedger(raw: unknown, expected: AllowanceUsageIdentity): AmountV1 {
  const parsed = stateSchema.safeParse(raw);
  const invalid = (): never => { throw new ControlProtocolError("control-allowance-usage-invalid"); };
  if (!parsed.success || !positive.safeParse(expected.generation).success || !positive.safeParse(expected.usageHighWater).success) return invalid();
  const state = parsed.data;
  if (state.nextSeq !== expected.usageHighWater || state.events.length !== state.nextSeq - 1
    || state.events.some((event, index) => event.eventSeq !== index + 1 || event.runId !== expected.runId
      || event.generation !== expected.generation || (event.bucket === "work" && event.cumulative === null))) return invalid();
  const settled = state.events.at(-1);
  if (!settled || settled.bucket !== "work" || settled.cumulative === null
    || canonicalHash(settled.cumulative) !== canonicalHash(state.totals.work)
    || settled.cumulative.attempts < 1 || settled.cumulative.sessions < 1) return invalid();
  return settled.cumulative;
}

export async function captureKnownWorkUsageLedger(sourceDir: string, expected: AllowanceUsageIdentity): Promise<ArtifactRefV1> {
  const bytes = await readPrivateFile(sourceDir, usagePath(sourceDir));
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new ControlProtocolError("control-allowance-usage-invalid"); }
  parseKnownWorkUsageLedger(raw, expected);
  return await writeEvidence(sourceDir, bytes);
}
