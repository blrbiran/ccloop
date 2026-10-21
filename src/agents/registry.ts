import type { z } from "zod";
import type { RuntimeAdapter } from "../runtime/types.js";
import { claudeDescriptor } from "./claude.js";
import { codexDescriptor } from "./codex.js";
import { ompDescriptor } from "./omp.js";
import {
  AgentError,
  type AgentSelectionV1,
  type CapabilityViewV1,
  type CatalogRowV1,
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
  defaults?: { model: string; contextWindow: ContextWindow };
  defaultsForInstallation?: (installation: MaterializedAgentConfigV1["installation"]) => { model: string; contextWindow: ContextWindow };
  contextOptions: ContextWindow[];
  /** Kind-only installation fields, merged into the strict installation schema. */
  installationExtras: z.ZodRawShape;
  /** The values `agents detect` writes for installationExtras in a draft table. */
  draftInstallationExtras: Record<string, unknown>;
  /** Arguments `agents detect` writes after the binary in a draft's `command`; none when absent. */
  draftCommandArgs?: readonly string[];
  validateInstallation?: (installation: MaterializedAgentConfigV1["installation"]) => void;
  validateSelection(selection: AgentSelectionV1): void;
  /** `row` is the selected catalog row for a kind that has a catalog (omp, OMP single call 2026-10-14 §3.2), else undefined. */
  /**
   * `declaredWindow` (#70, ccloop spec 2026-10-21-declared-context-window-design.md §2.2): the installation's
   * declaredContextWindow when materialize established that the catalog was read and gives no window; else null/absent.
   */
  capabilities(config: MaterializedAgentConfigV1, row?: CatalogRowV1, declaredWindow?: number | null): CapabilityViewV1;
  /**
   * Orca single-call estimate (2026-09-27), spec §4.4: "v1" when this kind can run one read-only structured call with
   * an output-token cap and every tool turned off; null when either cannot be done. A sibling of capabilities, not a
   * key of it: Orca does not intersect it with a profile or freeze it into a task.
   *
   * *** ERRATUM (OMP single call, Orca spec 2026-10-14 §3.2, Orca session 02f047f6, 2026-10-14) *** "when this kind can run" no longer holds for omp: its
   * answer is decided per selected catalog row (`row`, at resolution), not per kind -- "v1" only when that row declares
   * a maxTokens and its provider is not openrouter. Claude and codex still answer per kind.
   *
   * *** ERRATUM (Orca spec 2026-10-15 §6.1, R2) -- a third answer, "v1-soft": one structured call with tools off whose output bound the CLI cannot enforce (codex); Orca accepts it only in soft estimate mode. Codex now also answers per selected catalog row: "v1-soft" when the row is found, null otherwise. ***
   */
  singleCallExecution(config: MaterializedAgentConfigV1, row?: CatalogRowV1): "v1" | "v1-soft" | null;
  /**
   * OMP single call (Orca spec 2026-10-14 §3.2): the output cap the kind's single call actually runs under, from its catalog
   * row; null means the call honours the request's maxOutputTokens. A sibling of singleCallExecution: never in the
   * seven-key view, never frozen.
   */
  singleCallOutputCap(config: MaterializedAgentConfigV1, row?: CatalogRowV1): number | null;
  /**
   * Orca syncskill integration (2026-10-03), spec §10.7: each skill directory field is honoured by one kind only --
   * `skillPluginDir` by claude, `codexSkillsDir` by codex (H6), `ompSkillsDir` by omp (2026-10-13); accept refuses the rest.
   */
  createAdapter(config: MaterializedAgentConfigV1, options?: { skillPluginDir?: string; codexSkillsDir?: string; ompSkillsDir?: string }): RuntimeAdapter;
}

const DESCRIPTORS: readonly AgentDescriptor[] = [claudeDescriptor, codexDescriptor, ompDescriptor];

export function descriptorDefaults(descriptor: AgentDescriptor, installation: MaterializedAgentConfigV1["installation"]): { model: string; contextWindow: ContextWindow } {
  if (descriptor.defaultsForInstallation !== undefined) return descriptor.defaultsForInstallation(installation);
  if (descriptor.defaults !== undefined) return descriptor.defaults;
  throw new AgentError("agent-config-invalid", `missing defaults for ${descriptor.kind}`);
}

export function getDescriptor(kind: string): AgentDescriptor {
  const descriptor = DESCRIPTORS.find((candidate) => candidate.kind === kind);
  if (descriptor === undefined) throw new AgentError("agent-installation-missing", `unknown agent kind ${JSON.stringify(kind)}`);
  return descriptor;
}

export function listDescriptors(): AgentDescriptor[] {
  return [...DESCRIPTORS];
}
