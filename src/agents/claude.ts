import { join } from "node:path";
import { ClaudeAgentAdapter } from "../runtime/claude/claudeAgentAdapter.js";
import type { AgentDescriptor } from "./registry.js";
import {
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
  // Orca paid claude round (2026-09-27, human ruling on its findings): a bare `claude -p` loads the person's user
  // settings, hooks, plugins and MCP servers, and may not edit files. The draft isolates the call the way the paid round
  // did; the table is the person's to change, and `command` is outside configHash, so changing it strands no group.
  draftCommandArgs: [
    "--permission-mode", "acceptEdits",
    "--no-session-persistence",
    "--setting-sources", "project,local",
    "--strict-mcp-config",
    "--disable-slash-commands",
    // Human ruling 2026-09-27 ("B4 … 根治"): even with --no-session-persistence, claude made an empty
    // ~/.claude/projects/<cwd>/memory/ at start-up for every target repository; turning auto memory off stops it
    // (measured with the API unreachable: the directory appears without this setting and not with it).
    "--settings", '{"autoMemoryEnabled":false}',
    // Human ruling 2026-09-27 ("放，默认填100USD"): claude's own spending cap for each call.
    "--max-budget-usd", "100",
  ],
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
  // Orca single-call estimate (2026-09-27), Task 0 item 1 (claude 2.1.283, static only): `--tools ""` turns every tool
  // off (claude --help: 'Use "" to disable all tools') and CLAUDE_CODE_MAX_OUTPUT_TOKENS sets max_tokens.
  singleCallExecution() {
    return "v1";
  },
  createAdapter(config) {
    return new ClaudeAgentAdapter(config);
  },
};
