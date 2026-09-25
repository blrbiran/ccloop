import { join } from "node:path";
import { z } from "zod";
import { idSchema } from "../control/protocol.js";

/** Agent selection (spec 2026-09-26 §3): a context window is "agent-default" or a positive safe integer, never null. */
export type ContextWindow = "agent-default" | number;
export interface AgentSelectionV1 { agent: string; model: string; contextWindow: ContextWindow }
export interface PartialSelectionV1 { agent?: string; model?: string; contextWindow?: ContextWindow }
export interface InstallationV1 {
  kind: string;
  command: [string, ...string[]];
  version: string;
  configDir: string | null;
  timeoutMs: number;
  killGraceMs: number;
  [extra: string]: unknown;
}
export interface AgentsTableV1 { schema: "ccloop-agents-table-v1"; installations: Record<string, InstallationV1> }
/** The eight capability fields of the control wire, without `protocol`. */
export interface CapabilityViewV1 {
  usageObservation: "realtime" | "phase-end" | "unavailable";
  budgetEnforcement: "bounded" | "soft" | "unavailable";
  contextObservation: "realtime" | "phase-end" | "unavailable";
  handoffControl: "durable" | "phase-end" | "unavailable";
  handoffExecution: "mechanical-in-run-v1" | "model-assisted-v1" | null;
  contextWindowTokens: number | null;
  requestBoundProof: {
    scheme: "adapter-request-bound-v1";
    version: string;
    workDimensions: string[];
    handoffDimensions: string[];
    evidenceKind: string;
  } | null;
}
export interface MaterializedAgentConfigV1 {
  schema: "ccloop-agent-config-v1";
  kind: string;
  installation: InstallationV1;
  selection: AgentSelectionV1;
}
export interface AgentResolutionV1 {
  selection: AgentSelectionV1;
  configHash: string;
  timeoutMs: number;
  killGraceMs: number;
  capabilities: CapabilityViewV1;
}

/** Every code an AgentError can carry (agent selection spec §7, plus the plan's additions). */
export const AGENT_ERROR_CODES = [
  "agents-table-invalid",
  "agent-installation-missing",
  "agent-context-unsupported",
  "agent-selection-invalid",
  "agent-version-drift",
  "agent-unselected",
  "agent-config-invalid",
  "agent-selection-file-invalid",
  "agents-command-invalid",
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/** A named agent failure. `message` starts with the code (`<code>` or `<code>: <detail>`), so a CLI prints it verbatim. */
export class AgentError extends Error {
  constructor(readonly code: AgentErrorCode, readonly detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "AgentError";
  }
}

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

const MODEL_MAX_LENGTH = 200;
/**
 * Spec §4.1 / §12 I14: a model is an opaque string to Orca, but it becomes a CLI argument here, so it may not
 * look like a flag, carry whitespace or control characters, or run past 200 characters.
 */
export function assertModel(model: string): void {
  if (model.length === 0 || model.length > MODEL_MAX_LENGTH || model.startsWith("-") || /[\s\p{Cc}]/u.test(model)) {
    throw new AgentError("agent-selection-invalid", `model ${JSON.stringify(model.slice(0, MODEL_MAX_LENGTH))}`);
  }
}

export function assertContextOption(options: ContextWindow[], selection: AgentSelectionV1): void {
  if (!options.includes(selection.contextWindow)) {
    throw new AgentError("agent-context-unsupported", `context window ${String(selection.contextWindow)}`);
  }
}

/** Candidate directories shared by every kind, in search order (after cc-switch's build_tool_search_paths). */
export function commonSearchDirs(input: { home: string; platform: NodeJS.Platform }): string[] {
  return [
    join(input.home, ".local", "bin"),
    join(input.home, ".npm-global", "bin"),
    join(input.home, "n", "bin"),
    join(input.home, ".volta", "bin"),
    join(input.home, ".bun", "bin"),
    join(input.home, ".local", "share", "mise", "shims"),
    ...(input.platform === "darwin" ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
  ];
}
