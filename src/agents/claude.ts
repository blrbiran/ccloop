import { join } from "node:path";
import type { AgentDescriptor } from "./registry.js";
import {
  AgentError,
  assertContextOption,
  assertModel,
  commonSearchDirs,
  type AgentSelectionV1,
  type ContextWindow,
} from "./types.js";

const ONE_MILLION = 1_000_000;
const CONTEXT_OPTIONS: ContextWindow[] = ["agent-default", ONE_MILLION];

/**
 * The one place the 1M window is spelled for the claude CLI: `--model <model>[1m]` (Task 0, progress §1:
 * the claude 2.1.282 binary carries "append [1m] to the model name for 1M").
 */
export function claudeModelArgument(selection: AgentSelectionV1): string {
  return selection.contextWindow === ONE_MILLION ? `${selection.model}[1m]` : selection.model;
}

export const claudeDescriptor: AgentDescriptor = {
  kind: "claude",
  binary: "claude",
  searchDirs: ({ home, platform }) => [join(home, ".claude", "local"), ...commonSearchDirs({ home, platform })],
  configDirEnv: "CLAUDE_CONFIG_DIR",
  defaults: { model: "claude-opus-5-5", contextWindow: "agent-default" },
  contextOptions: CONTEXT_OPTIONS,
  installationExtras: {},
  draftInstallationExtras: {},
  validateSelection(selection) {
    assertModel(selection.model);
    assertContextOption(CONTEXT_OPTIONS, selection);
  },
  capabilities(config) {
    return {
      usageObservation: "phase-end",
      budgetEnforcement: "soft",
      contextObservation: "unavailable",
      handoffControl: "durable",
      handoffExecution: "mechanical-in-run-v1",
      // Spec §12 I6: only a mapping Task 0 verified is reported; "agent-default" stays unknown (null).
      contextWindowTokens: config.selection.contextWindow === ONE_MILLION ? ONE_MILLION : null,
      requestBoundProof: null,
    };
  },
  createAdapter() {
    // Agent selection plan T1: ClaudeAgentAdapter lands in T3, which replaces this line.
    throw new AgentError("agent-adapter-unavailable", "claude");
  },
};
