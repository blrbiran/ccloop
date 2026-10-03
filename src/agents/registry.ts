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
  /** Arguments `agents detect` writes after the binary in a draft's `command`; none when absent. */
  draftCommandArgs?: readonly string[];
  validateSelection(selection: AgentSelectionV1): void;
  capabilities(config: MaterializedAgentConfigV1): CapabilityViewV1;
  /**
   * Orca single-call estimate (2026-09-27), spec §4.4: "v1" when this kind can run one read-only structured call with
   * an output-token cap and every tool turned off; null when either cannot be done. A sibling of capabilities, not a
   * key of it: Orca does not intersect it with a profile or freeze it into a task.
   */
  singleCallExecution(config: MaterializedAgentConfigV1): "v1" | null;
  /** Orca syncskill integration (2026-10-03), spec §10.7: `skillPluginDir` is honoured by claude only (accept refuses it for any other agent). */
  createAdapter(config: MaterializedAgentConfigV1, options?: { skillPluginDir?: string }): RuntimeAdapter;
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
