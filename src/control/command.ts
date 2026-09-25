import { z } from "zod";
import { resolveAgent } from "../agents/materialize.js";
import { getDescriptor } from "../agents/registry.js";
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
        workDimensions: z.array(z.string()),
        handoffDimensions: z.array(z.string()),
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
    })
    .strict(),
]);
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
const amountSchema = z.object({ tokens: safeInteger, activeMs: safeInteger, attempts: safeInteger, sessions: safeInteger }).strict();
const usageEventSchema = z.object({
  runId: z.string().min(1),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  eventSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  bucket: z.enum(["work", "handoff"]),
  cumulative: amountSchema.nullable(),
  source: artifactRefSchema,
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
}).strict();

const METHODS = new Set<ControlMethodV1>([
  "capabilities",
  "accept",
  "inspect",
  "handoff",
  "collect",
  "read-evidence",
]);

async function parseCommand(argv: string[]): Promise<{ method: ControlMethodV1; agentsTablePath: string }> {
  const method = argv[0] as ControlMethodV1 | undefined;
  if (method === undefined || !METHODS.has(method)) throw new Error("control-command-invalid");
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
        defaults: descriptor.defaults,
        contextOptions: descriptor.contextOptions,
        version: installation.version,
      };
    }),
  };
}

async function defaultHandler(request: ControlRequestV1, context: ControlContextV1): Promise<unknown> {
  if (request.method === "capabilities") {
    if (request.agent === null) return await tableView(context.agentsTablePath);
    const { resolution } = await resolveAgent(await readAgentsTable(context.agentsTablePath), request.agent);
    return { protocol: 3, ...resolution };
  }
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
  if (request.method === "read-evidence") {
    const bytes = await readEvidence(request.input.work.sourceDir, request.ref);
    return { ...request.ref, base64: bytes.toString("base64") };
  }
  throw new ControlProtocolError("control-method-unavailable");
}

function validateResponse(method: ControlMethodV1, value: unknown): unknown {
  try {
    if (method === "capabilities") return capabilitiesSchema.parse(value);
    if (method === "accept" || method === "inspect") return executionStatusSchema.parse(value);
    if (method === "handoff") return handoffAckSchema.parse(value);
    if (method === "collect") return collectionSchema.parse(value);
    if (method === "read-evidence") return evidenceSchema.parse(value);
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
    const validated = validateResponse(command.method, value);
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
