import { budgetAmountSchema, tokenPolicySchema, type TokenPolicy, type BudgetAmount } from "../budget/tokenPolicy.js";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentSelectionV1, PartialSelectionV1 } from "../agents/types.js";
import { loopContractSchema, repoKeySchema, type LoopContract } from "../contract/schema.js";

export type ControlMethodV1 =
  | "features"
  | "agent-installation-observe"
  | "agent-installation-preview"
  | "agent-installation-apply"
  | "capabilities"
  | "models"
  | "accept"
  | "inspect"
  | "handoff"
  | "collect"
  | "read-evidence"
  | "task-results"
  | "read-task-result-evidence"
  | "settle-saved-result"
  | "read-saved-result-settlement"
  | "saved-result-source-eligibility"
  | "saved-result-eligibility"
  | "saved-result-evidence"
  | "read-saved-result-evidence";

export interface AmountV1 {
  tokens: number;
  activeMs: number;
  attempts: number;
  sessions: number;
}

export interface GrantV1 {
  work: BudgetAmount;
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
  /** Orca H6 Codex skills (2026-10-05): canonical absolute per-run snapshot `skills` directory, Codex-only. */
  codexSkillsDir?: string;
  /** OMP skill injection (2026-10-13): the same snapshot `skills` directory, OMP-only; listed in each phase's system prompt. */
  ompSkillsDir?: string;
  /** Prior-failures spec 2026-10-21 §2.1: earlier runs' failures, oldest first, for plan and execute of this run. */
  priorFailures?: PriorFailureV1[];
  /** Operator note (Orca spec 2026-10-23-live-transcript-design.md §10.2.6): the person's note for plan and execute. */
  operatorNote?: { text: string; scope: "next-attempt" | "remaining-attempts" };
  /** Multi-repo runs (spec 2026-10-24-multi-dir-projects §11.1): each extra repository's target and base, contract order. */
  additionalRepos?: AdditionalRepoWorkV1[];
}

export interface AdditionalRepoWorkV1 {
  key: string;
  targetRepo: string;
  base: string;
}

/** Prior-failures spec 2026-10-21 §2.1: one earlier run's failure; runId is for audit and never rendered. */
export interface PriorFailureV1 {
  runId: string;
  rejectCategory: string;
  failingCommand: string | null;
  evidence: string[] | null;
  failureCause?: string;
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
  protocol: 3 | 4;
  tokenPolicy?: TokenPolicy;
  mode?: "verify-saved-result";
  savedResultRecovery?: SavedResultRecoveryInput;
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

export interface SavedResultSourceInput { source: LoopStartEnvelope; sourceAttempt: number; packagePath: string; packageHash: string }

export type ControlRequestV1 =
  | { method: "features" }
  | { method: "agent-installation-observe" }
  | { method: "agent-installation-preview" }
  | { method: "agent-installation-apply"; opId: string; requestDigest: string; previewId: string; baseTableHash: string; acceptedChangeIds: string[] }
  | { method: "capabilities"; agent: PartialSelectionV1 | null }
  | { method: "models"; installation: string; refresh: boolean }
  | { method: "accept"; input: StartEnvelopeV3 }
  | { method: "inspect"; input: StartEnvelopeV3 }
  | { method: "handoff"; input: StartEnvelopeV3; request: HandoffRequestV1 }
  | { method: "collect"; input: StartEnvelopeV3; afterSeq: number }
  | { method: "read-evidence"; input: StartEnvelopeV3; ref: ArtifactRefV1 }
  | { method: "task-results"; input: StartEnvelopeV3; afterRevision: number }
  | { method: "read-task-result-evidence"; input: StartEnvelopeV3; manifestRef: ArtifactRefV1; ref: ArtifactRefV1 }
  | { method: "settle-saved-result"; input: LoopStartEnvelope }
  | { method: "read-saved-result-settlement"; input: LoopStartEnvelope; settlementRef: ArtifactRefV1; ref: ArtifactRefV1 }
  | { method: "saved-result-source-eligibility"; input: SavedResultSourceInput }
  | { method: "saved-result-eligibility"; input: LoopStartEnvelope }
  | { method: "saved-result-evidence"; input: StartEnvelopeV3 }
  | { method: "read-saved-result-evidence"; input: StartEnvelopeV3; capsuleRef: ArtifactRefV1; ref: ArtifactRefV1 };

export type ControlPayloadV1 =
  | { opId: string; requestDigest: string; previewId: string; baseTableHash: string; acceptedChangeIds: string[] }
  | { input: SavedResultSourceInput }
  | CapabilitiesRequestV3
  | { installation: string; refresh: boolean }
  | StartEnvelopeV3
  | { input: StartEnvelopeV3; request: HandoffRequestV1 }
  | { input: StartEnvelopeV3; afterSeq: number }
  | { input: StartEnvelopeV3; ref: ArtifactRefV1 }
  | { input: StartEnvelopeV3; afterRevision: number }
  | { input: StartEnvelopeV3; manifestRef: ArtifactRefV1; ref: ArtifactRefV1 }
  | { input: StartEnvelopeV3; capsuleRef: ArtifactRefV1; ref: ArtifactRefV1 };

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

export interface SavedResultRecoveryInput {
  packagePath: string; packageHash: string; admissionHash: string;
  recoveryOf: { sourceRunId: string; sourceAttempt: number; capsuleHash: string; snapshotHash: string; normalizedExecutionHash: string };
}
export const recoveryOfSchema = z.object({ sourceRunId: idSchema, sourceAttempt: positiveSafeInteger,
  capsuleHash: hashSchema, snapshotHash: hashSchema, normalizedExecutionHash: hashSchema }).strict();
export const savedResultRecoveryInputSchema = z.object({ packagePath: z.string().min(1), packageHash: hashSchema,
  admissionHash: hashSchema, recoveryOf: recoveryOfSchema }).strict();
export const artifactRefSchema = z.object({ artifactId: idSchema, hash: hashSchema }).strict();
const inputCheckpointSchema = z
  .object({
    predecessorRunId: idSchema,
    checkpointId: idSchema,
    checkpointHash: hashSchema,
    bundlePath: z.string().min(1),
  })
  .strict();
// Spec 2026-10-21-prior-failures-start-input-design.md §2.1: the failures of earlier runs of the same task, oldest first,
// for plan and execute of a fresh run. Bounds are UTF-8 bytes (zod's .max counts UTF-16 code units).
const utf8Bounded = (max: number) => z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= max);
const priorFailureSchema = z
  .object({
    runId: idSchema,
    rejectCategory: utf8Bounded(200),
    failingCommand: utf8Bounded(4096).nullable(),
    evidence: z.array(utf8Bounded(4096)).min(1).max(16).nullable(),
    failureCause: utf8Bounded(64).optional(),
  })
  .strict();
const priorFailuresSchema = z.array(priorFailureSchema).min(1).max(3).optional();
// Operator note (Orca spec 2026-10-23-live-transcript-design.md §10.2.6): optional, so an envelope without it parses and
// hashes exactly as before; text is 1-4096 UTF-8 bytes.
const operatorNoteSchema = z.object({ text: utf8Bounded(4096), scope: z.enum(["next-attempt", "remaining-attempts"]) }).strict().optional();
// Multi-repo runs (spec 2026-10-24-multi-dir-projects §11.1): optional, so a single-repo envelope parses and hashes exactly
// as before; when present its keys are the contract's additionalRepos keys, in the same order.
const additionalReposWorkSchema = z.array(z.object({ key: repoKeySchema, targetRepo: z.string().min(1), base: z.string().min(1) }).strict())
  .min(1).max(7).optional();
function workKeysMatchContract(work: { contract: LoopContract; additionalRepos?: { key: string }[] }): boolean {
  const contractKeys = work.contract.context.additionalRepos?.map((repo) => repo.key);
  const workKeys = work.additionalRepos?.map((repo) => repo.key);
  return JSON.stringify(contractKeys) === JSON.stringify(workKeys);
}
function atMostOneSkillDirectory(work: { skillPluginDir?: string; codexSkillsDir?: string; ompSkillsDir?: string }): boolean {
  return [work.skillPluginDir, work.codexSkillsDir, work.ompSkillsDir].filter((dir) => dir !== undefined).length <= 1;
}
const loopWorkSchema = z
  .object({
    kind: z.literal("loop"),
    contract: loopContractSchema.refine(contract => contract.executionPolicy.tokenBudget !== null && contract.executionPolicy.tokenBudget > 0),
    targetRepo: z.string().min(1),
    base: z.string().min(1),
    sourceDir: z.string().min(1),
    // Orca syncskill integration (2026-10-03), spec §10.7: where Orca's per-run skill snapshot lives (outside any git tree);
    // claude loads it with --plugin-dir. Optional so an envelope without it parses and hashes exactly as before.
    skillPluginDir: z.string().min(1).optional(),
    codexSkillsDir: z.string().min(1).optional(),
    ompSkillsDir: z.string().min(1).optional(),
    priorFailures: priorFailuresSchema,
    operatorNote: operatorNoteSchema,
    additionalRepos: additionalReposWorkSchema,
  })
  .strict()
  .refine((work) => atMostOneSkillDirectory(work), {
    path: ["codexSkillsDir"],
    message: "skill directory fields are mutually exclusive",
  })
  .refine((work) => workKeysMatchContract(work), { path: ["additionalRepos"], message: "additionalRepos keys must match the contract's" });
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
const legacyStartEnvelopeSchema = z.union([
  z.object({ ...envelopeBase, inputCheckpoint: inputCheckpointSchema.nullable(), work: loopWorkSchema }).strict(),
  z.object({ ...envelopeBase, inputCheckpoint: z.null(), work: singleCallWorkSchema }).strict(),
]);
const nullableLoopWorkSchema = z.object({
  kind: z.literal("loop"), contract: loopContractSchema,
  targetRepo: z.string().min(1), base: z.string().min(1), sourceDir: z.string().min(1),
  skillPluginDir: z.string().min(1).optional(), codexSkillsDir: z.string().min(1).optional(), ompSkillsDir: z.string().min(1).optional(),
  priorFailures: priorFailuresSchema,
  operatorNote: operatorNoteSchema,
  additionalRepos: additionalReposWorkSchema,
}).strict().refine(work => atMostOneSkillDirectory(work)).refine(work => workKeysMatchContract(work));
const v4StartEnvelopeSchema = z.object({
  protocol: z.literal(4), contractHash: hashSchema, tokenPolicy: tokenPolicySchema.optional(),
  mode: z.literal("verify-saved-result").optional(), savedResultRecovery: savedResultRecoveryInputSchema.optional(),
  claim: claimSchema.extend({ grant: z.object({ work: budgetAmountSchema.extend({ sessions: positiveSafeInteger }), handoff: amountSchema }).strict() }),
  inputCheckpoint: inputCheckpointSchema.nullable(), work: nullableLoopWorkSchema,
}).strict().refine(e => (e.mode === undefined) === (e.savedResultRecovery === undefined) && (e.mode === undefined || e.inputCheckpoint === null)
  // Prior-failures spec §2.1: a saved-result recovery builds no prompt, so it takes no prior failures -- nor an operator note
  // (live transcript spec §10.2.6; review minor, Orca session ffec7b28).
  && (e.mode === undefined || (e.work.priorFailures === undefined && e.work.operatorNote === undefined)));
export const startEnvelopeSchema = z.union([legacyStartEnvelopeSchema, v4StartEnvelopeSchema]);
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
  features: z.object({}).strict(),
  "agent-installation-observe": z.object({}).strict(),
  "agent-installation-preview": z.object({}).strict(),
  "agent-installation-apply": z.object({ opId: idSchema, requestDigest: hashSchema, previewId: idSchema, baseTableHash: hashSchema, acceptedChangeIds: z.array(idSchema).min(1) }).strict(),
  capabilities: z.object({ agent: partialSelectionSchema.nullable() }).strict(),
  // Every-agent requirement chain (Orca spec 2026-10-15 §3): one installation's models; refresh skips the cache.
  models: z.object({ installation: idSchema, refresh: z.boolean() }).strict(),
  accept: startEnvelopeSchema,
  inspect: startEnvelopeSchema,
  handoff: z.object({ input: startEnvelopeSchema, request: handoffRequestSchema }).strict(),
  collect: z.object({ input: startEnvelopeSchema, afterSeq: safeInteger }).strict(),
  "settle-saved-result": z.object({input:v4StartEnvelopeSchema.refine(e=>e.mode==="verify-saved-result")}).strict(),
  "read-saved-result-settlement": z.object({input:v4StartEnvelopeSchema.refine(e=>e.mode==="verify-saved-result"),settlementRef:artifactRefSchema,ref:artifactRefSchema}).strict(),
  "saved-result-source-eligibility": z.object({input:z.object({source:startEnvelopeSchema.refine(e=>e.work.kind==="loop"&&(!("mode" in e)||e.mode===undefined)),sourceAttempt:positiveSafeInteger,packagePath:z.string().min(1),packageHash:hashSchema}).strict()}).strict(),
  "saved-result-eligibility": z.object({input:v4StartEnvelopeSchema.refine(e=>e.mode==="verify-saved-result")}).strict(),
  "saved-result-evidence": z.object({ input: startEnvelopeSchema }).strict(),
  "read-saved-result-evidence": z.object({ input: startEnvelopeSchema, capsuleRef: artifactRefSchema, ref: artifactRefSchema }).strict(),
  "task-results": z.object({ input: startEnvelopeSchema, afterRevision: safeInteger }).strict(),
  "read-task-result-evidence": z.object({ input: startEnvelopeSchema, manifestRef: artifactRefSchema, ref: artifactRefSchema }).strict(),
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

// Multi-repo runs (spec 2026-10-24-multi-dir-projects §11.1): every extra targetRepo is absolute; at accept every extra
// contract repoPath is a canonical directory (like the skill directories, Orca may remove it before a later collect); the
// working repositories, and the targets, are pairwise distinct and none lies inside another.
function validateAdditionalRepos(work: LoopWork, method: ControlMethodV1): void {
  const extras = work.contract.context.additionalRepos ?? [];
  for (const repo of work.additionalRepos ?? []) if (!isAbsolute(repo.targetRepo)) throw new ControlProtocolError("control-request-invalid");
  for (const repo of extras) {
    if (!isAbsolute(repo.repoPath)) throw new ControlProtocolError("control-request-invalid");
    if (method === "accept") validateCanonicalDirectory(repo.repoPath);
  }
  const disjoint = (paths: string[]): void => {
    const resolved = paths.map((path) => resolve(path));
    for (const [index, left] of resolved.entries()) {
      for (const right of resolved.slice(index + 1)) {
        if (isWithin(left, right) || isWithin(right, left)) throw new ControlProtocolError("control-request-invalid");
      }
    }
  };
  disjoint([work.contract.context.repoPath, ...extras.map((repo) => repo.repoPath)]);
  disjoint([work.targetRepo, ...(work.additionalRepos ?? []).map((repo) => repo.targetRepo)]);
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
  for (const skillsDir of [envelope.work.codexSkillsDir, envelope.work.ompSkillsDir]) {
    if (skillsDir === undefined) continue;
    if (!isAbsolute(skillsDir)) throw new ControlProtocolError("control-request-invalid");
    if (method === "accept") validateCanonicalDirectory(skillsDir);
  }
  if (envelope.work.additionalRepos !== undefined) validateAdditionalRepos(envelope.work, method);
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
  // Task3 (2026-10-11): independent features negotiates protocol4; legacy protocol3 remains finite and exact.
  if (version !== undefined && version !== 3 && version !== 4) {
    throw new ControlProtocolError("control-protocol-unsupported");
  }
  try {
    const payload = payloadSchemas[method].parse(raw) as ControlPayloadV1;
    if (method === "accept" || method === "inspect") validateEnvelopePaths(payload as StartEnvelopeV3, method);
    if (method === "settle-saved-result" || method === "read-saved-result-settlement" || method === "saved-result-eligibility" || method === "handoff" || method === "collect" || method === "read-evidence" || method === "task-results" || method === "read-task-result-evidence" || method === "saved-result-evidence" || method === "read-saved-result-evidence") {
      validateEnvelopePaths((payload as { input: StartEnvelopeV3 }).input, method);
    }
    return payload;
  } catch (error) {
    if (error instanceof ControlProtocolError) throw error;
    throw new ControlProtocolError("control-request-invalid");
  }
}

export function attachControlMethod(method: ControlMethodV1, payload: ControlPayloadV1): ControlRequestV1 {
  if (method === "features") return { method };
  if (method === "agent-installation-observe" || method === "agent-installation-preview") return { method };
  if (method === "capabilities") return { method, agent: (payload as CapabilitiesRequestV3).agent };
  if (method === "accept" || method === "inspect") return { method, input: payload as StartEnvelopeV3 };
  return { method, ...(payload as Record<string, unknown>) } as ControlRequestV1;
}
