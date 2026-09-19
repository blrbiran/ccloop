import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  artifactRefSchema,
  attachControlMethod,
  ControlProtocolError,
  parseControlRequest,
  type ControlMethodV1,
  type ControlRequestV1,
} from "./protocol.js";

export interface ControlCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ControlCommandDeps {
  handle?: (request: ControlRequestV1, context: { adapter: "codex"; adapterConfigPath: string }) => Promise<unknown>;
}

const capabilitiesSchema = z
  .object({
    protocol: z.literal(1),
    durableAccept: z.boolean(),
    ownershipIsolation: z.boolean(),
    evidenceRetention: z.boolean(),
    usageObservation: z.enum(["realtime", "phase-end", "unavailable"]),
    budgetEnforcement: z.enum(["bounded", "soft", "unsupported"]),
    requestBoundEvidence: z.string().min(1).nullable(),
  })
  .strict();
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

const METHODS = new Set<ControlMethodV1>([
  "capabilities",
  "accept",
  "inspect",
  "handoff",
  "collect",
  "read-evidence",
]);

async function parseCommand(argv: string[]): Promise<{
  method: ControlMethodV1;
  adapter: "codex";
  adapterConfigPath: string;
}> {
  const method = argv[0] as ControlMethodV1 | undefined;
  if (method === undefined || !METHODS.has(method)) throw new Error("control-command-invalid");
  if (argv.length !== 5 || argv[1] !== "--adapter" || argv[3] !== "--adapter-config") {
    throw new Error("control-command-invalid");
  }
  if (argv[2] !== "codex") throw new Error("control-adapter-unsupported");
  const adapterConfigPath = argv[4]!;
  if (!isAbsolute(adapterConfigPath)) throw new Error("control-adapter-config-invalid");
  try {
    const canonical = await realpath(adapterConfigPath);
    const metadata = await lstat(adapterConfigPath);
    if (canonical !== adapterConfigPath || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("control-adapter-config-invalid");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "control-adapter-config-invalid") throw error;
    throw new Error("control-adapter-config-invalid");
  }
  return { method, adapter: "codex", adapterConfigPath };
}

async function defaultHandler(request: ControlRequestV1): Promise<unknown> {
  if (request.method === "capabilities") {
    return {
      protocol: 1,
      durableAccept: true,
      ownershipIsolation: true,
      evidenceRetention: true,
      usageObservation: "phase-end",
      budgetEnforcement: "soft",
      requestBoundEvidence: null,
    };
  }
  throw new ControlProtocolError("control-method-unavailable");
}

function validateResponse(method: ControlMethodV1, value: unknown): unknown {
  try {
    if (method === "capabilities") return capabilitiesSchema.parse(value);
    if (method === "accept" || method === "inspect") return executionStatusSchema.parse(value);
    if (method === "handoff") return handoffAckSchema.parse(value);
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
    const value = await (deps.handle ?? defaultHandler)(request, {
      adapter: command.adapter,
      adapterConfigPath: command.adapterConfigPath,
    });
    const validated = validateResponse(command.method, value);
    return { code: 0, stdout: `${JSON.stringify(validated)}\n`, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: error instanceof ControlProtocolError ? 2 : 1,
      stdout: "",
      stderr: `${message}\n`,
    };
  }
}
