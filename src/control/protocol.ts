import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
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

export interface ClaimV1 {
  groupId: string;
  workItemId: string;
  taskId: string | null;
  runId: string;
  generation: number;
  graphVersion: number;
  targetVersion: number;
  commandId: string;
  configHash: string;
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

export interface StartEnvelopeV1 {
  protocol: 1;
  claim: ClaimV1;
  contractHash: string;
  inputCheckpoint: InputCheckpointV1 | null;
  work: {
    contract: LoopContract;
    targetRepo: string;
    base: string;
    sourceDir: string;
  };
}

export interface HandoffRequestV1 {
  protocol: 1;
  requestId: string;
  runId: string;
  generation: number;
  reason: "budget" | "context" | "human" | "graph-change" | "shutdown";
  deadlineAt: string;
}

export type ControlRequestV1 =
  | { method: "capabilities" }
  | { method: "accept"; input: StartEnvelopeV1 }
  | { method: "inspect"; input: StartEnvelopeV1 }
  | { method: "handoff"; input: StartEnvelopeV1; request: HandoffRequestV1 }
  | { method: "collect"; input: StartEnvelopeV1; afterSeq: number }
  | { method: "read-evidence"; input: StartEnvelopeV1; ref: ArtifactRefV1 };

export type ControlPayloadV1 =
  | Record<string, never>
  | StartEnvelopeV1
  | { input: StartEnvelopeV1; request: HandoffRequestV1 }
  | { input: StartEnvelopeV1; afterSeq: number }
  | { input: StartEnvelopeV1; ref: ArtifactRefV1 };

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
const workSchema = z
  .object({
    contract: loopContractSchema,
    targetRepo: z.string().min(1),
    base: z.string().min(1),
    sourceDir: z.string().min(1),
  })
  .strict();
const startEnvelopeSchema = z
  .object({
    protocol: z.literal(1),
    claim: claimSchema,
    contractHash: hashSchema,
    inputCheckpoint: inputCheckpointSchema.nullable(),
    work: workSchema,
  })
  .strict();
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
  capabilities: z.object({}).strict(),
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

function validateEnvelopePaths(envelope: StartEnvelopeV1): void {
  const sourceDir = validateCanonicalDirectory(envelope.work.sourceDir);
  if (!isAbsolute(envelope.work.targetRepo)) throw new ControlProtocolError("control-request-invalid");
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

export function parseControlRequest(method: "capabilities", raw: unknown): Record<string, never>;
export function parseControlRequest(method: "accept" | "inspect", raw: unknown): StartEnvelopeV1;
export function parseControlRequest(
  method: "handoff",
  raw: unknown,
): { input: StartEnvelopeV1; request: HandoffRequestV1 };
export function parseControlRequest(method: "collect", raw: unknown): { input: StartEnvelopeV1; afterSeq: number };
export function parseControlRequest(
  method: "read-evidence",
  raw: unknown,
): { input: StartEnvelopeV1; ref: ArtifactRefV1 };
export function parseControlRequest(method: ControlMethodV1, raw: unknown): ControlPayloadV1;
export function parseControlRequest(method: ControlMethodV1, raw: unknown): ControlPayloadV1 {
  const version = protocolVersion(raw);
  if (version !== undefined && version !== 1) {
    throw new ControlProtocolError("control-protocol-unsupported");
  }
  try {
    const payload = payloadSchemas[method].parse(raw) as ControlPayloadV1;
    if (method === "accept" || method === "inspect") validateEnvelopePaths(payload as StartEnvelopeV1);
    if (method === "handoff" || method === "collect" || method === "read-evidence") {
      validateEnvelopePaths((payload as { input: StartEnvelopeV1 }).input);
    }
    return payload;
  } catch (error) {
    if (error instanceof ControlProtocolError) throw error;
    throw new ControlProtocolError("control-request-invalid");
  }
}

export function attachControlMethod(method: ControlMethodV1, payload: ControlPayloadV1): ControlRequestV1 {
  if (method === "capabilities") return { method };
  if (method === "accept" || method === "inspect") return { method, input: payload as StartEnvelopeV1 };
  return { method, ...(payload as Record<string, unknown>) } as ControlRequestV1;
}
