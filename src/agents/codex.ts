import { z } from "zod";
import { CodexAdapter } from "../runtime/codex/codexAdapter.js";
import { parseCodexConfig, type CodexConfig } from "../runtime/codex/protocol.js";
import type { AgentDescriptor } from "./registry.js";
import {
  assertContextOption,
  assertModel,
  commonSearchDirs,
  type ContextWindow,
  type MaterializedAgentConfigV1,
} from "./types.js";

const CONTEXT_OPTIONS: ContextWindow[] = ["agent-default"];

/** The codex runtime's own config, taken from a materialized agent config; parseCodexConfig keeps its constraints. */
export function toCodexConfig(config: MaterializedAgentConfigV1): CodexConfig {
  const { installation, selection } = config;
  return parseCodexConfig({
    command: installation.command,
    model: selection.model,
    budgetMode: installation.budgetMode,
    sandbox: installation.sandbox,
    timeoutMs: installation.timeoutMs,
    killGraceMs: installation.killGraceMs,
  });
}

export const codexDescriptor: AgentDescriptor = {
  kind: "codex",
  binary: "codex",
  searchDirs: ({ home, platform }) => commonSearchDirs({ home, platform }),
  configDirEnv: "CODEX_HOME",
  defaults: { model: "gpt-6-sol", contextWindow: "agent-default" },
  contextOptions: CONTEXT_OPTIONS,
  installationExtras: { sandbox: z.enum(["read-only", "workspace-write"]), budgetMode: z.literal("soft") },
  draftInstallationExtras: { sandbox: "workspace-write", budgetMode: "soft" },
  validateSelection(selection) {
    assertModel(selection.model);
    assertContextOption(CONTEXT_OPTIONS, selection);
  },
  capabilities() {
    return {
      usageObservation: "phase-end",
      budgetEnforcement: "soft",
      contextObservation: "unavailable",
      handoffControl: "durable",
      handoffExecution: "mechanical-in-run-v1",
      contextWindowTokens: null,
      requestBoundProof: null,
    };
  },
  createAdapter(config) {
    const { configDir } = config.installation;
    return new CodexAdapter(toCodexConfig(config), configDir === null ? undefined : { CODEX_HOME: configDir });
  },
};
