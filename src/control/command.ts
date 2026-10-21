import { FAILURE_CAUSES } from "../runtime/failureCause.js";
import { toolRulesReportSchema } from "./toolRulesReport.js";
import {settleSavedResult,readSavedResultSettlement,savedResultSettlementSchema} from "./settleSavedResult.js";
import {readSavedResultSourceEligibility,readSavedResultEligibility,savedResultEligibilitySchema,savedResultSourceEligibilitySchema} from "./savedResultRecovery.js";
import { collectSavedResultEvidence, readSavedResultEvidence, savedResultCollectionSchema } from "./savedResultEvidence.js";
import { z } from "zod";
import { applyAgentInstallations, observeAgentInstallations, previewAgentInstallations } from "../agents/updates.js";
import { resolveAgent } from "../agents/materialize.js";
import { listAgentModels } from "../agents/models.js";
import { descriptorDefaults, getDescriptor } from "../agents/registry.js";
import { assertAgentsTablePath, readAgentsTable } from "../agents/table.js";
import { AgentError, type CapabilityViewV1 } from "../agents/types.js";
import {
  agentSelectionSchema,
  artifactRefSchema,
  contextWindowSchema,
  attachControlMethod,
  ControlProtocolError,
  parseControlRequest,
  type ControlMethodV1,
  type ControlRequestV1,
} from "./protocol.js";
import { acceptStart } from "./accept.js";
import { collectExecution, inspectExecution } from "./collect.js";
import { MAX_CONTROL_BYTES, readEvidence } from "./evidence.js";
import { requestHandoff } from "./handoff.js";
import { collectTaskResults, readTaskResultEvidence, taskResultCollectionSchema } from "./taskResults.js";
import { byModelSchema } from "./usage.js";

export interface ControlCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ControlContextV1 {
  agentsTablePath: string;
}

export interface ControlCommandDeps {
  handle?: (request: ControlRequestV1, context: ControlContextV1) => Promise<unknown>;
}

// Orca backlog #11(c) (2026-09-29; ccloop handoff §2 "descriptor 维度偏松", Orca handoff §9.1): the shape Orca's
// capabilitiesSchema requires of a request-bound proof's dimensions (Orca src/control/webProtocol.ts,
// sortedDimensionsSchema): a strictly ascending -- so duplicate-free -- subset of the four budget dimensions. An answer
// that breaks it is refused here, as control-response-invalid, rather than printed for Orca to refuse whole.
const requestBoundDimensionsSchema = z
  .array(z.enum(["activeMs", "attempts", "sessions", "tokens"]))
  .refine((values) => values.every((value, index) => index === 0 || values[index - 1]! < value), "dimensions must be sorted and unique");

const capabilityViewSchema = z
  .object({
    usageObservation: z.enum(["realtime", "phase-end", "unavailable"]),
    budgetEnforcement: z.enum(["bounded", "soft", "unavailable"]),
    contextObservation: z.enum(["realtime", "phase-end", "unavailable"]),
    handoffControl: z.enum(["durable", "phase-end", "unavailable"]),
    handoffExecution: z.enum(["mechanical-in-run-v1", "model-assisted-v1"]).nullable(),
    contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    requestBoundProof: z
      .object({
        scheme: z.literal("adapter-request-bound-v1"),
        version: z.string().min(1),
        workDimensions: requestBoundDimensionsSchema,
        handoffDimensions: requestBoundDimensionsSchema,
        evidenceKind: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  // Wave-1 review M-6: the seven keys must stay the descriptors' CapabilityViewV1; this fails to compile if they drift.
  .strict() satisfies z.ZodType<CapabilityViewV1>;
// Agent selection (2026-09-26), spec §4.6: capabilities answers protocol 3, either the table view (request
// `{agent:null}`) or one resolution of a partial selection (the capability view carries no `protocol` of its own).
const capabilitiesSchema = z.union([
  z
    .object({
      protocol: z.literal(3),
      installations: z.array(
        z
          .object({
            id: z.string().min(1),
            kind: z.string().min(1),
            defaults: z.object({ model: z.string().min(1), contextWindow: contextWindowSchema }).strict(),
            contextOptions: z.array(contextWindowSchema).min(1),
            version: z.string().min(1),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      protocol: z.literal(3),
      selection: agentSelectionSchema,
      configHash: z.string().regex(/^[a-f0-9]{64}$/),
      timeoutMs: z.number().int().positive().max(2_147_483_647),
      killGraceMs: z.number().int().nonnegative().max(60_000),
      capabilities: capabilityViewSchema,
      singleCallExecution: z.enum(["v1", "v1-soft"]).nullable(),
      // OMP single call (Orca spec 2026-10-14 §3.2). Optional, so an answer without it (a handler stand-in) still parses.
      singleCallOutputCap: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
      // Declared context window (#70, ccloop spec 2026-10-21-declared-context-window-design.md §2.3): only when the window
      // is the installation's declared value. Orca's agentResolutionSchema must accept it in the same repin.
      contextWindowSource: z.literal("installation-declared").optional(),
    })
    .strict(),
]);
// Every-agent requirement chain (Orca spec 2026-10-15 §3): refused here rather than printed for Orca to refuse whole.
const modelsSchema = z.object({
  schema: z.literal("ccloop-models-v1"), installation: z.string().min(1), kind: z.string().min(1), source: z.enum(["cache", "probe", "none"]),
  observedAt: z.string().datetime().nullable(),
  models: z.array(z.object({ model: z.string().min(1).max(200), contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(), singleCallExecution: z.enum(["v1", "v1-soft"]).nullable() }).strict()),
}).strict();
const executionStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("accepted"), executionId: z.string().min(1), configHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
  z.object({
    kind: z.literal("stopped"),
    proof: z.object({
      executionId: z.string().min(1),
      generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      isolated: z.literal(true),
      source: artifactRefSchema,
    }).strict(),
  }).strict(),
]);
const handoffAckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("latched"), requestId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("complete"), requestId: z.string().min(1), checkpointId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("unknown"), requestId: z.string().min(1) }).strict(),
]);
const evidenceSchema = z
  .object({ artifactId: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/), base64: z.string() })
  .strict();
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const updateHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const observedInstallationSchema = z.object({
  id: z.string().min(1), kind: z.string().min(1), command: z.array(z.string()).min(1),
  recordedVersion: z.string().min(1), observedVersion: z.string().min(1).nullable(), realpath: z.string().nullable(),
  status: z.enum(["current", "changed", "unavailable"]),
}).strict();
const observationSchema = z.object({
  schema: z.literal("orca-agent-detection-observation-v1"), baseTableHash: updateHashSchema,
  observedAt: z.string().datetime(), installed: z.array(observedInstallationSchema),
}).strict();
const updateChangeSchema = z.object({
  changeId: z.string().min(1), kind: z.enum(["version", "path", "addition"]),
  installationId: z.string().min(1), command: z.array(z.string()).min(1),
  realpath: z.string().min(1), version: z.string().min(1), installation: z.record(z.unknown()).optional(),
  unavailableReason: z.literal("omp-frozen-model-unavailable").optional(),
}).strict();
const previewSchema = observationSchema.omit({ schema: true }).extend({
  schema: z.literal("orca-agent-detection-preview-v1"), previewId: z.string().min(1), changes: z.array(updateChangeSchema),
}).strict();
const tableResponseSchema = z.object({ schema: z.literal("ccloop-agents-table-v1"), installations: z.record(z.unknown()) }).strict();
const receiptSchema = z.object({
  schema: z.literal("orca-agent-detection-receipt-v1"), opId: z.string().min(1), requestDigest: updateHashSchema,
  previewId: z.string().min(1), acceptedChangeIds: z.array(z.string().min(1)).min(1),
  beforeHash: updateHashSchema, afterHash: updateHashSchema,
  before: tableResponseSchema, after: tableResponseSchema,
}).strict();
const amountSchema = z.object({ tokens: safeInteger, activeMs: safeInteger, attempts: safeInteger, sessions: safeInteger }).strict();
export const usageEventSchema = z.object({
  runId: z.string().min(1),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  eventSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  bucket: z.enum(["work", "handoff"]),
  cumulative: amountSchema.nullable(),
  source: artifactRefSchema,
  byModel: byModelSchema.optional(),
}).strict();
const terminalSchema = z.object({
  status: z.enum(["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"]),
  currentAttempt: safeInteger,
  attemptsUsed: safeInteger,
  lastTransitionAt: z.string(),
  waitingOnHuman: z.boolean(),
  stopReason: z.string().nullable(),
  budgetSnapshot: z.object({ attemptsRemaining: safeInteger, timeRemainingMs: safeInteger, tokenBudgetRemaining: safeInteger }).strict(),
  recentFailures: z.array(z.object({ rejectCategory: z.string(), primaryTargetPaths: z.array(z.string()), failingCommand: z.string().nullable() }).strict()),
}).strict();
const collectionSchema = z.object({
  events: z.array(usageEventSchema),
  candidate: z.object({
    groupId: z.string().min(1), workItemId: z.string().min(1), taskId: z.string().min(1).nullable(), runId: z.string().min(1),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), graphVersion: safeInteger, targetVersion: safeInteger,
    checkpointId: z.string().min(1), usageHighWater: safeInteger, result: z.enum(["complete", "partial", "failed"]),
    artifacts: z.array(artifactRefSchema), snapshot: artifactRefSchema.nullable(), missing: z.array(z.string()),
    unresolvedRequestIds: z.array(z.string()),
    stopProof: z.object({ executionId: z.string().min(1), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), isolated: z.literal(true), source: artifactRefSchema }).strict().nullable(),
    terminalOutcome: z.string().min(1), handoff: artifactRefSchema,
  }).strict().nullable(),
  terminal: terminalSchema.nullable(),
  // Orca labels and progress spec §3.2: ccloop answers progress on every collect (null before any loop state). Strict,
  // like the rest of this schema, so ccloop does not refuse its own answer.
  progress: z.object({
    status: z.enum(["queued", "planning", "executing", "verifying", "succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"]),
    currentAttempt: safeInteger,
    attemptsUsed: safeInteger,
    attemptsRemaining: safeInteger,
    lastTransitionAt: z.string().min(1),
  }).strict().nullable(),
  // Reported decisions and debug (spec 2026-10-20 §4.3): carried opaquely, absent when not reported; protocols 3 and 4.
  decisions: z.unknown().optional(),
  debug: z.unknown().optional(),
  // Failure causes (spec 2026-10-21 §5): top level, present iff terminal and the state has one. Orca's strict collect parse
  // must accept it in the same repin.
  failureCause: z.object({
    cause: z.enum(FAILURE_CAUSES), phase: z.enum(["plan", "execute", "verify"]).nullable(),
    retries: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), detail: z.string().nullable(),
  }).strict().optional(),
  // Per-contract tool rules (spec 2026-10-22 §5): top level, present iff the contract has rules and the report exists.
  toolRules: toolRulesReportSchema.optional(),
}).strict();

const METHODS = new Set<ControlMethodV1>([
  "features",
  "agent-installation-observe",
  "agent-installation-preview",
  "agent-installation-apply",
  "capabilities",
  "models",
  "accept",
  "inspect",
  "handoff",
  "collect",
  "read-evidence",
  "task-results",
  "read-task-result-evidence",
  "settle-saved-result",
  "read-saved-result-settlement",
  "saved-result-source-eligibility",
  "saved-result-eligibility",
  "saved-result-evidence",
  "read-saved-result-evidence",
]);

async function parseCommand(argv: string[]): Promise<{ method: ControlMethodV1; agentsTablePath: string }> {
  const method = argv[0] as ControlMethodV1 | undefined;
  if (method === undefined || !METHODS.has(method)) throw new Error("control-command-invalid");
  if (method === "features" && argv.length === 1) return { method, agentsTablePath: "" };
  // Agent selection (2026-09-26), spec §4.5: `--agents <table>` is the only form; `--adapter`/`--adapter-config`
  // are no longer accepted. Every method checks the path's shape; only capabilities and accept read the table
  // (spec §4.2, I4: a broken table must not block collecting a run already in flight).
  if (argv.length !== 3 || argv[1] !== "--agents") throw new Error("control-command-invalid");
  const agentsTablePath = argv[2]!;
  await assertAgentsTablePath(agentsTablePath);
  return { method, agentsTablePath };
}

async function tableView(agentsTablePath: string): Promise<unknown> {
  const table = await readAgentsTable(agentsTablePath);
  return {
    protocol: 3,
    installations: Object.keys(table.installations).sort().map((id) => {
      const installation = table.installations[id]!;
      const descriptor = getDescriptor(installation.kind);
      return {
        id,
        kind: installation.kind,
        defaults: descriptorDefaults(descriptor, installation),
        contextOptions: descriptor.contextOptions,
        version: installation.version,
      };
    }),
  };
}

async function defaultHandler(request: ControlRequestV1, context: ControlContextV1): Promise<unknown> {
  if (request.method === "features") return { protocol: 1, tokenPolicy: "optional-v1", savedResultRecovery: "v1", agentInstallationUpdate: "v1" };
  if (request.method === "agent-installation-observe") return observeAgentInstallations(context.agentsTablePath);
  if (request.method === "agent-installation-preview") return previewAgentInstallations(context.agentsTablePath);
  if (request.method === "agent-installation-apply") return applyAgentInstallations(context.agentsTablePath, request);
  if (request.method === "capabilities") {
    if (request.agent === null) return await tableView(context.agentsTablePath);
    const { resolution } = await resolveAgent(await readAgentsTable(context.agentsTablePath), request.agent);
    // Orca single-call estimate (2026-09-27), spec §4.4: a sibling of `capabilities`, like timeoutMs and killGraceMs,
    // so the seven-key view (frozen into Orca profiles and task records) stays exactly as it is.
    // OMP single call (Orca spec 2026-10-14 §3.2): singleCallExecution and singleCallOutputCap now come with the resolution.
    return { protocol: 3, ...resolution };
  }
  // Every-agent requirement chain (Orca spec 2026-10-15 §3): no `log` here -- the wire path prints nothing on stderr on
  // success, since Orca reads ccloop's code from the start of stderr.
  if (request.method === "models") return await listAgentModels(context.agentsTablePath, request.installation, { refresh: request.refresh });
  if (request.method === "accept") {
    return await acceptStart(request.input, { agentsTablePath: context.agentsTablePath });
  }
  if (request.method === "inspect") {
    return await inspectExecution(request.input);
  }
  if (request.method === "handoff") {
    return await requestHandoff(request.input, request.request);
  }
  if (request.method === "collect") {
    return await collectExecution(request.input, request.afterSeq);
  }
  if (request.method === "settle-saved-result")return settleSavedResult(request.input);
  if (request.method === "read-saved-result-settlement"){const bytes=await readSavedResultSettlement(request.input,request.settlementRef,request.ref);return {...request.ref,base64:bytes.toString("base64")};}
  if (request.method === "saved-result-source-eligibility") return await readSavedResultSourceEligibility(request.input);
  if (request.method === "saved-result-eligibility") return await readSavedResultEligibility(request.input);
  if (request.method === "saved-result-evidence") return await collectSavedResultEvidence(request.input);
  if (request.method === "read-saved-result-evidence") {
    const bytes=await readSavedResultEvidence(request.input,request.capsuleRef,request.ref);
    return {...request.ref,base64:bytes.toString("base64")};
  }
  if (request.method === "task-results") return await collectTaskResults(request.input, request.afterRevision);
  if (request.method === "read-task-result-evidence") {
    const bytes = await readTaskResultEvidence(request.input, request.manifestRef, request.ref);
    return { ...request.ref, base64: bytes.toString("base64") };
  }
  if (request.method === "read-evidence") {
    const bytes = await readEvidence(request.input.work.sourceDir, request.ref);
    return { ...request.ref, base64: bytes.toString("base64") };
  }
  throw new ControlProtocolError("control-method-unavailable");
}

function validateResponse(method: ControlMethodV1, value: unknown, protocol = 3): unknown {
  try {
    if (method === "features") return z.object({ protocol: z.literal(1), tokenPolicy: z.literal("optional-v1"), savedResultRecovery: z.literal("v1"), agentInstallationUpdate: z.literal("v1") }).strict().parse(value);
    if (method === "agent-installation-observe") return observationSchema.parse(value);
    if (method === "agent-installation-preview") return previewSchema.parse(value);
    if (method === "agent-installation-apply") return receiptSchema.parse(value);
    if (method === "capabilities") return capabilitiesSchema.parse(value);
    if (method === "models") return modelsSchema.parse(value);
    if (method === "accept" || method === "inspect") return executionStatusSchema.parse(value);
    if (method === "handoff") return handoffAckSchema.parse(value);
    if (method === "collect") return (protocol === 4 ? collectionSchema.extend({
      terminal: terminalSchema.extend({ waitingCause: z.literal("token-allowance").optional(), allowanceNextPhase: z.enum(["plan", "execute", "verify"]).optional(), budgetSnapshot: z.object({
        attemptsRemaining: safeInteger, timeRemainingMs: safeInteger, tokenBudgetRemaining: safeInteger.nullable(),
        tokenRemainingStatus: z.enum(["known", "unlimited", "unknown"]),
      }).strict() }).nullable(),
    }) : collectionSchema).parse(value);
    if (method === "settle-saved-result")return z.object({ref:artifactRefSchema,settlement:savedResultSettlementSchema}).strict().parse(value);
    if (method === "saved-result-source-eligibility") return savedResultSourceEligibilitySchema.parse(value);
    if (method === "saved-result-eligibility") return savedResultEligibilitySchema.parse(value);
    if (method === "saved-result-evidence") return savedResultCollectionSchema.parse(value);
    if (method === "task-results") return taskResultCollectionSchema.parse(value);
    if (method === "read-saved-result-settlement" || method === "read-evidence" || method === "read-task-result-evidence" || method === "read-saved-result-evidence") return evidenceSchema.parse(value);
    return value;
  } catch {
    throw new Error("control-response-invalid");
  }
}

export async function runControlCommand(
  argv: string[],
  stdin: string,
  deps: ControlCommandDeps = {},
): Promise<ControlCommandResult> {
  try {
    const command = await parseCommand(argv);
    let raw: unknown;
    try {
      raw = JSON.parse(stdin) as unknown;
    } catch {
      throw new Error("control-json-invalid");
    }
    const payload = parseControlRequest(command.method, raw);
    const request = attachControlMethod(command.method, payload);
    const value = await (deps.handle ?? defaultHandler)(request, { agentsTablePath: command.agentsTablePath });
    const validated = validateResponse(command.method, value, "input" in request && "protocol" in request.input ? request.input.protocol : 3);
    const stdout = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(stdout) > MAX_CONTROL_BYTES) {
      throw new ControlProtocolError("control-response-too-large");
    }
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      // Agent selection (2026-09-26), D-W3-2: an agent error is a named rejection like a protocol one (exit 2). Its
      // message starts with its code, so Orca reads the code back from `control-peer-exit` as `2:<code>[: <detail>]`.
      code: error instanceof ControlProtocolError || error instanceof AgentError ? 2 : 1,
      stdout: "",
      stderr: `${message}\n`,
    };
  }
}
