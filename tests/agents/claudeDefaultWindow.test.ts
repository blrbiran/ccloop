import { describe, expect, it } from "vitest";
import { claudeDescriptor } from "../../src/agents/claude.js";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";

// Every-agent requirement chain (Orca spec 2026-10-15 §2.3, §7, R5): every model in claude-code 2.1.300's built-in table
// has a window of at least 200000, so agent-default reports that lower bound; the verified 1M mapping is unchanged.
const config = (contextWindow: "agent-default" | 1_000_000): MaterializedAgentConfigV1 => ({ schema: "ccloop-agent-config-v1", kind: "claude",
  installation: { kind: "claude", command: ["/opt/claude"], version: "2.1.300", configDir: null, timeoutMs: 1, killGraceMs: 1 },
  selection: { agent: "claude", model: "claude-opus-5-5", contextWindow } });

describe("claude windows (spec §7)", () => {
  it("reports 200000 for agent-default and 1000000 for the 1M selection", () => {
    expect([claudeDescriptor.capabilities(config("agent-default")).contextWindowTokens, claudeDescriptor.capabilities(config(1_000_000)).contextWindowTokens]).toEqual([200000, 1000000]);
  });
});
