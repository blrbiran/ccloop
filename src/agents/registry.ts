import type { z } from "zod";
import type { RuntimeAdapter } from "../runtime/types.js";
import { claudeDescriptor } from "./claude.js";
import { codexDescriptor } from "./codex.js";
import {
  AgentError,
  type AgentSelectionV1,
  type CapabilityViewV1,
  type ContextWindow,
  type MaterializedAgentConfigV1,
} from "./types.js";

/**
 * One agent kind (spec 2026-09-26 §4.1). A new kind is one descriptor plus one adapter, registered below;
 * Orca never sees more than the kind string.
 */
export interface AgentDescriptor {
  kind: string;
  binary: string;
  searchDirs(input: { home: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform }): string[];
  configDirEnv: string;
  defaults: { model: string; contextWindow: ContextWindow };
  contextOptions: ContextWindow[];
  /** Kind-only installation fields, merged into the strict installation schema. */
  installationExtras: z.ZodRawShape;
  /** The values `agents detect` writes for installationExtras in a draft table. */
  draftInstallationExtras: Record<string, unknown>;
  validateSelection(selection: AgentSelectionV1): void;
  capabilities(config: MaterializedAgentConfigV1): CapabilityViewV1;
  createAdapter(config: MaterializedAgentConfigV1): RuntimeAdapter;
}

const DESCRIPTORS: readonly AgentDescriptor[] = [claudeDescriptor, codexDescriptor];

export function getDescriptor(kind: string): AgentDescriptor {
  const descriptor = DESCRIPTORS.find((candidate) => candidate.kind === kind);
  if (descriptor === undefined) throw new AgentError("agent-installation-missing", `unknown agent kind ${JSON.stringify(kind)}`);
  return descriptor;
}

export function listDescriptors(): AgentDescriptor[] {
  return [...DESCRIPTORS];
}
