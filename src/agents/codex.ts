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
  capabilities(_config, row) {
    return {
      usageObservation: "phase-end",
      budgetEnforcement: "soft",
      contextObservation: "unavailable",
      handoffControl: "durable",
      handoffExecution: "mechanical-in-run-v1",
      // Every-agent requirement chain (Orca spec 2026-10-15 §6.1): the catalog row's context_window (config.toml's
      // model_context_window wins), not scaled by effective_context_window_percent; no row => unknown.
      contextWindowTokens: row?.contextWindow ?? null,
      requestBoundProof: null,
    };
  },
  // Orca single-call estimate (2026-09-27), Task 0 item 1 (codex-cli 0.155.1): no config caps the model's output, so a
  // single call cannot be bounded the way spec §4.4 asks.
  // *** ERRATUM (Orca spec 2026-10-15 §6.1, ruling R2) -- the bound is now checked after the fact: codex answers "v1-soft"
  // (one structured call, tools off, output bound not enforced by the CLI) when its catalog row is found. ***
  singleCallExecution(_config, row) {
    return row !== undefined ? "v1-soft" : null;
  },
  // OMP single call (Orca spec 2026-10-14 §3.2): codex runs no single call; nothing to bound.
  // *** ERRATUM (Orca spec 2026-10-15 §6.1) -- codex runs a soft single call; it still has no cap, so this stays null. ***
  singleCallOutputCap() {
    return null;
  },
  createAdapter(config, options) {
    const { configDir } = config.installation;
    return new CodexAdapter(toCodexConfig(config), configDir === null ? undefined : { CODEX_HOME: configDir }, options?.codexSkillsDir, { installation: config.installation });
  },
};
