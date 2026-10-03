import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentSelectionV1, PartialSelectionV1 } from "../agents/types.js";
import { loopContractSchema, type LoopContract } from "../contract/schema.js";

export type ControlMethodV1 =
  | "capabilities"
  | "accept"
  | "inspect"
  | "handoff"
  | "collect"
  | "read-evidence";

export interface AmountV1 {
  tokens: number;
  activeMs: number;
  attempts: number;
  sessions: number;
}

export interface GrantV1 {
  work: AmountV1;
  handoff: AmountV1;
}

export interface ClaimV2 {
  groupId: string;
  workItemId: string;
  taskId: string | null;
  runId: string;
  generation: number;
  graphVersion: number;
  targetVersion: number;
  commandId: string;
  /** Agent selection (2026-09-26), spec §4.6: the canonical hash of the config `agent` materializes to. */
  configHash: string;
  /** The full selection, descriptor defaults already filled; accept re-materializes it and checks configHash. */
  agent: AgentSelectionV1;
  grant: GrantV1;
  ownerToken: string;
}

export interface ArtifactRefV1 {
  artifactId: string;
  hash: string;
}

export interface InputCheckpointV1 {
  predecessorRunId: string;
  checkpointId: string;
  checkpointHash: string;
  bundlePath: string;
}

/** Orca single-call estimate (2026-09-27), spec §4.1: the work a loop run does -- protocol 2's four fields, now tagged. */
export interface LoopWork {
  kind: "loop";
  contract: LoopContract;
  targetRepo: string;
  base: string;
  sourceDir: string;
  /** Orca syncskill integration (2026-10-03), spec §10.7: absolute; claude loads it with --plugin-dir. */
  skillPluginDir?: string;
}

/**
 * Spec §4.1 and §4.2: one read-only structured call. The prompt and the schema are the caller's bytes, handed to the
 * agent as they are and never rebuilt here; ccloop knows nothing of what the call is for.
 */
export interface SingleCallWork {
  kind: "single-call";
  prompt: string;
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
  sourceDir: string;
}

interface StartEnvelopeBaseV3 {
  protocol: 3;
  claim: ClaimV2;
  contractHash: string;
}

export type LoopStartEnvelope = StartEnvelopeBaseV3 & { inputCheckpoint: InputCheckpointV1 | null; work: LoopWork };
/** Spec §6.5: a single call is never continued, so it takes no input checkpoint. */
export type SingleCallStartEnvelope = StartEnvelopeBaseV3 & { inputCheckpoint: null; work: SingleCallWork };
/** Human ruling S7 (2026-09-27, "ccloop 现在没有发布，暂时不用考虑兼容性"): protocol 3 is the only start envelope. */
export type StartEnvelopeV3 = LoopStartEnvelope | SingleCallStartEnvelope;

export function isLoopEnvelope(envelope: StartEnvelopeV3): envelope is LoopStartEnvelope {
  return envelope.work.kind === "loop";
}

export interface HandoffRequestV1 {
  protocol: 1;
  requestId: string;
  runId: string;
  generation: number;
  reason: "budget" | "context" | "human" | "graph-change" | "shutdown";
  deadlineAt: string;
}

/** Agent selection (2026-09-26), spec §4.6: null asks for the table view, a partial selection for one resolution. */
export interface CapabilitiesRequestV3 {
  agent: PartialSelectionV1 | null;
}

export type ControlRequestV1 =
  | { method: "capabilities"; agent: PartialSelectionV1 | null }
  | { method: "accept"; input: StartEnvelopeV3 }
  | { method: "inspect"; input: StartEnvelopeV3 }
  | { method: "handoff"; input: StartEnvelopeV3; request: HandoffRequestV1 }
  | { method: "collect"; input: StartEnvelopeV3; afterSeq: number }
  | { method: "read-evidence"; input: StartEnvelopeV3; ref: ArtifactRefV1 };

export type ControlPayloadV1 =
  | CapabilitiesRequestV3
  | StartEnvelopeV3
  | { input: StartEnvelopeV3; request: HandoffRequestV1 }
  | { input: StartEnvelopeV3; afterSeq: number }
  | { input: StartEnvelopeV3; ref: ArtifactRefV1 };

export class ControlProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ControlProtocolError";
  }
}

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = safeInteger.refine((value) => value > 0);
export const idSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const amountSchema = z
  .object({
    tokens: safeInteger,
    activeMs: safeInteger,
    attempts: safeInteger,
    sessions: safeInteger,
  })
  .strict();
const grantSchema = z.object({ work: amountSchema, handoff: amountSchema }).strict();
// Agent selection (2026-09-26): wire shapes only. What a model string may be is the kind's validateSelection's
// call (agent-selection-invalid, spec §7), so `model` is any string here. Defined here, not in src/agents/types.ts
// (which re-exports them): types.ts imports idSchema from this module, so importing these back would be a cycle.
export const contextWindowSchema = z.union([
  z.literal("agent-default"),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
]);
export const agentSelectionSchema = z
  .object({ agent: idSchema, model: z.string(), contextWindow: contextWindowSchema })
  .strict();
export const partialSelectionSchema = z
  .object({ agent: idSchema.optional(), model: z.string().optional(), contextWindow: contextWindowSchema.optional() })
  .strict();
const claimSchema = z
  .object({
    groupId: idSchema,
    workItemId: idSchema,
    taskId: idSchema.nullable(),
    runId: idSchema,
    generation: positiveSafeInteger,
    graphVersion: safeInteger,
    targetVersion: safeInteger,
    commandId: idSchema,
    configHash: hashSchema,
    agent: agentSelectionSchema,
    grant: grantSchema,
    ownerToken: idSchema,
  })
  .strict();

export const artifactRefSchema = z.object({ artifactId: idSchema, hash: hashSchema }).strict();
const inputCheckpointSchema = z
  .object({
    predecessorRunId: idSchema,
    checkpointId: idSchema,
    checkpointHash: hashSchema,
    bundlePath: z.string().min(1),
  })
  .strict();
const loopWorkSchema = z
  .object({
    kind: z.literal("loop"),
    contract: loopContractSchema,
    targetRepo: z.string().min(1),
    base: z.string().min(1),
    sourceDir: z.string().min(1),
    // Orca syncskill integration (2026-10-03), spec §10.7: where Orca's per-run skill snapshot lives (outside any git tree);
    // claude loads it with --plugin-dir. Optional so an envelope without it parses and hashes exactly as before.
    skillPluginDir: z.string().min(1).optional(),
  })
  .strict();
// Orca single-call estimate (2026-09-27), spec §4.1: the claude API takes the schema as a tool's input_schema, whose top
// level must be `type: "object"` (scripts/claude-phase-runner.mjs records the 400 it answers otherwise).
const singleCallWorkSchema = z
  .object({
    kind: z.literal("single-call"),
    prompt: z.string().min(1),
    responseSchema: z.record(z.unknown()).refine((schema) => schema.type === "object"),
    maxOutputTokens: positiveSafeInteger,
    sourceDir: z.string().min(1),
  })
  .strict();
const envelopeBase = { protocol: z.literal(3), claim: claimSchema, contractHash: hashSchema };
const startEnvelopeSchema = z.union([
  z.object({ ...envelopeBase, inputCheckpoint: inputCheckpointSchema.nullable(), work: loopWorkSchema }).strict(),
  z.object({ ...envelopeBase, inputCheckpoint: z.null(), work: singleCallWorkSchema }).strict(),
]);
export const handoffRequestSchema = z
  .object({
    protocol: z.literal(1),
    requestId: idSchema,
    runId: idSchema,
    generation: positiveSafeInteger,
    reason: z.enum(["budget", "context", "human", "graph-change", "shutdown"]),
    deadlineAt: z.string().datetime({ offset: true }),
  })
  .strict();

const payloadSchemas = {
  capabilities: z.object({ agent: partialSelectionSchema.nullable() }).strict(),
  accept: startEnvelopeSchema,
  inspect: startEnvelopeSchema,
  handoff: z.object({ input: startEnvelopeSchema, request: handoffRequestSchema }).strict(),
  collect: z.object({ input: startEnvelopeSchema, afterSeq: safeInteger }).strict(),
  "read-evidence": z.object({ input: startEnvelopeSchema, ref: artifactRefSchema }).strict(),
} satisfies Record<ControlMethodV1, z.ZodTypeAny>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) throw new ControlProtocolError("control-request-invalid");
  return encoded;
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

function validateCanonicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new ControlProtocolError("control-request-invalid");
  try {
    const canonical = realpathSync(path);
    if (canonical !== path || !lstatSync(path).isDirectory()) {
      throw new ControlProtocolError("control-request-invalid");
    }
    return canonical;
  } catch (error) {
    if (error instanceof ControlProtocolError) throw error;
    throw new ControlProtocolError("control-request-invalid");
  }
}

function validateEnvelopePaths(envelope: StartEnvelopeV3, method: ControlMethodV1): void {
  const sourceDir = validateCanonicalDirectory(envelope.work.sourceDir);
  // Orca single-call estimate (2026-09-27), spec §5.1: a single call names no repository and takes no input
  // checkpoint (its schema holds that to null), so its sourceDir is all there is to check.
  if (!isLoopEnvelope(envelope)) return;
  if (!isAbsolute(envelope.work.targetRepo)) throw new ControlProtocolError("control-request-invalid");
  // Orca syncskill integration (2026-10-03), spec §10.7: the snapshot directory is removed with the workspace after
  // landing and inspect/handoff/collect/read-evidence may come later, so only accept demands that it exists.
  if (envelope.work.skillPluginDir !== undefined) {
    if (!isAbsolute(envelope.work.skillPluginDir)) throw new ControlProtocolError("control-request-invalid");
    if (method === "accept") validateCanonicalDirectory(envelope.work.skillPluginDir);
  }
  if (envelope.inputCheckpoint === null) return;
  const bundle = validateCanonicalDirectory(envelope.inputCheckpoint.bundlePath);
  const inputRoot = resolve(sourceDir, "input");
  if (!isWithin(inputRoot, bundle) || bundle === inputRoot) {
    throw new ControlProtocolError("control-request-invalid");
  }
}

function protocolVersion(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if ("protocol" in record) return record.protocol;
  const input = record.input;
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>).protocol : undefined;
}

export function parseControlRequest(method: "capabilities", raw: unknown): CapabilitiesRequestV3;
export function parseControlRequest(method: "accept" | "inspect", raw: unknown): StartEnvelopeV3;
export function parseControlRequest(
  method: "handoff",
  raw: unknown,
): { input: StartEnvelopeV3; request: HandoffRequestV1 };
export function parseControlRequest(method: "collect", raw: unknown): { input: StartEnvelopeV3; afterSeq: number };
export function parseControlRequest(
  method: "read-evidence",
  raw: unknown,
): { input: StartEnvelopeV3; ref: ArtifactRefV1 };
export function parseControlRequest(method: ControlMethodV1, raw: unknown): ControlPayloadV1;
export function parseControlRequest(method: ControlMethodV1, raw: unknown): ControlPayloadV1 {
  const version = protocolVersion(raw);
  // Agent selection (2026-09-26), spec §5: the start envelope is protocol 2; a v1 envelope is refused by name.
  // Handoff requests stay protocol 1 and are nested, so this reads the envelope's number (spec §5 M4).
  // ERRATUM (Orca single-call estimate, 2026-09-27, human ruling S7): the start envelope is now protocol 3 only; 1 and 2 are refused by name.
  if (version !== undefined && version !== 3) {
    throw new ControlProtocolError("control-protocol-unsupported");
  }
  try {
    const payload = payloadSchemas[method].parse(raw) as ControlPayloadV1;
    if (method === "accept" || method === "inspect") validateEnvelopePaths(payload as StartEnvelopeV3, method);
    if (method === "handoff" || method === "collect" || method === "read-evidence") {
      validateEnvelopePaths((payload as { input: StartEnvelopeV3 }).input, method);
    }
    return payload;
  } catch (error) {
    if (error instanceof ControlProtocolError) throw error;
    throw new ControlProtocolError("control-request-invalid");
  }
}

export function attachControlMethod(method: ControlMethodV1, payload: ControlPayloadV1): ControlRequestV1 {
  if (method === "capabilities") return { method, agent: (payload as CapabilitiesRequestV3).agent };
  if (method === "accept" || method === "inspect") return { method, input: payload as StartEnvelopeV3 };
  return { method, ...(payload as Record<string, unknown>) } as ControlRequestV1;
}
