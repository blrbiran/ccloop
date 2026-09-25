import { describe, expect, it } from "vitest";
import { claudeDescriptor, claudeModelArgument } from "../../src/agents/claude.js";
import { codexDescriptor, toCodexConfig } from "../../src/agents/codex.js";
import { getDescriptor, listDescriptors } from "../../src/agents/registry.js";
import { AGENT_ERROR_CODES, AgentError, type AgentSelectionV1, type MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";

function config(kind: "claude" | "codex", selection: Partial<AgentSelectionV1> = {}): MaterializedAgentConfigV1 {
  const extras = kind === "codex" ? { sandbox: "workspace-write", budgetMode: "soft" } : {};
  return {
    schema: "ccloop-agent-config-v1",
    kind,
    installation: { kind, command: ["/bin/echo"], version: "1.2.3", configDir: null, timeoutMs: 1000, killGraceMs: 50, ...extras },
    selection: { agent: kind, model: kind === "claude" ? "claude-opus-5-5" : "gpt-6-sol", contextWindow: "agent-default", ...selection },
  };
}

describe("agent descriptors", () => {
  it("registers exactly claude and codex, and names an unknown kind as a missing installation", () => {
    expect(listDescriptors().map((descriptor) => descriptor.kind)).toEqual(["claude", "codex"]);
    expect(getDescriptor("codex")).toBe(codexDescriptor);
    expect(() => getDescriptor("opencode")).toThrow(expect.objectContaining({ code: "agent-installation-missing" }));
  });

  // Controller ruling (2026-09-26): a CLI prints an AgentError's message verbatim, so it must start with the code.
  it("puts the code first in an AgentError's message, with the detail after it", () => {
    expect(new AgentError("agent-version-drift", "claude: table 2.1.282, observed 2.1.283").message).toBe("agent-version-drift: claude: table 2.1.282, observed 2.1.283");
    expect(new AgentError("agent-unselected").message).toBe("agent-unselected");
    expect(AGENT_ERROR_CODES).toContain("agent-selection-file-invalid");
  });

  it("carries the defaults Task 0 measured (progress §1): claude-opus-5-5 with 1M expressible, gpt-6-sol default-only", () => {
    expect(claudeDescriptor.defaults).toEqual({ model: "claude-opus-5-5", contextWindow: "agent-default" });
    expect(claudeDescriptor.contextOptions).toEqual(["agent-default", 1_000_000]);
    expect(claudeDescriptor.configDirEnv).toBe("CLAUDE_CONFIG_DIR");
    expect(codexDescriptor.defaults).toEqual({ model: "gpt-6-sol", contextWindow: "agent-default" });
    expect(codexDescriptor.contextOptions).toEqual(["agent-default"]);
    expect(codexDescriptor.configDirEnv).toBe("CODEX_HOME");
  });

  // A model becomes a CLI argument (spec §12 I14): it must never be readable as a flag or split into two arguments.
  it.each([
    ["", "empty"],
    ["-p", "flag-like"],
    ["--dangerously-skip-permissions", "flag-like"],
    ["claude opus", "space"],
    ["claude\topus", "tab"],
    ["claude\nopus", "newline"],
    ["claude\u0000opus", "control character"],
    ["x".repeat(201), "longer than 200"],
  ])("rejects the model %j (%s) for both kinds as agent-selection-invalid", (model) => {
    for (const descriptor of [claudeDescriptor, codexDescriptor]) {
      expect(() => descriptor.validateSelection({ agent: descriptor.kind, model, contextWindow: "agent-default" }))
        .toThrow(expect.objectContaining({ code: "agent-selection-invalid" }));
    }
  });

  it("accepts opaque models it cannot interpret, including aliases with a [1m] suffix and 200 characters", () => {
    for (const model of ["opus", "sonnet[1m]", "litellm/anthropic/claude-x", "x".repeat(200)]) {
      expect(() => claudeDescriptor.validateSelection({ agent: "claude", model, contextWindow: "agent-default" })).not.toThrow();
    }
  });

  it("accepts a context window only when the kind can express it", () => {
    expect(() => claudeDescriptor.validateSelection({ agent: "claude", model: "opus", contextWindow: 1_000_000 })).not.toThrow();
    expect(() => claudeDescriptor.validateSelection({ agent: "claude", model: "opus", contextWindow: 200_000 }))
      .toThrow(expect.objectContaining({ code: "agent-context-unsupported" }));
    expect(() => codexDescriptor.validateSelection({ agent: "codex", model: "gpt-6-sol", contextWindow: 1_000_000 }))
      .toThrow(expect.objectContaining({ code: "agent-context-unsupported" }));
  });

  // Spec §12 I6: a requested window is not an observation; only claude's verified 1M mapping is reported.
  it("reports contextWindowTokens only for claude's verified 1M mapping and null otherwise", () => {
    expect(claudeDescriptor.capabilities(config("claude", { contextWindow: 1_000_000 })).contextWindowTokens).toBe(1_000_000);
    expect(claudeDescriptor.capabilities(config("claude")).contextWindowTokens).toBeNull();
    expect(codexDescriptor.capabilities(config("codex"))).toEqual({
      usageObservation: "phase-end",
      budgetEnforcement: "soft",
      contextObservation: "unavailable",
      handoffControl: "durable",
      handoffExecution: "mechanical-in-run-v1",
      contextWindowTokens: null,
      requestBoundProof: null,
    });
  });

  it("spells 1M for the claude CLI as the [1m] model suffix and nothing else", () => {
    expect(claudeModelArgument({ agent: "claude", model: "claude-opus-5-5", contextWindow: 1_000_000 })).toBe("claude-opus-5-5[1m]");
    expect(claudeModelArgument({ agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" })).toBe("claude-opus-5-5");
  });

  it("builds the codex runtime config from the installation and the selected model", () => {
    const materialized = config("codex", { model: "gpt-6-luna" });
    expect(toCodexConfig(materialized)).toEqual({
      command: ["/bin/echo"], model: "gpt-6-luna", budgetMode: "soft", sandbox: "workspace-write", timeoutMs: 1000, killGraceMs: 50,
    });
    expect(codexDescriptor.createAdapter(materialized)).toBeInstanceOf(CodexAdapter);
  });

  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): T1 left claude's
  // createAdapter throwing a T3-placeholder error code (now removed from AGENT_ERROR_CODES); T3 lands
  // ClaudeAgentAdapter, so this now encodes that claude's descriptor builds a real adapter instance.
  it("builds a ClaudeAgentAdapter from the claude descriptor", () => {
    expect(claudeDescriptor.createAdapter(config("claude"))).toBeInstanceOf(ClaudeAgentAdapter);
  });
});
