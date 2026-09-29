import { describe, expect, it } from "vitest";
import { claudeDescriptor } from "../../src/agents/claude.js";
import { AgentError } from "../../src/agents/types.js";

// Orca backlog #13(a) (2026-09-29; Orca agent selection spec §12 m-5, Orca handoff §9.0c): the claude CLI reads a
// `[1m]` model suffix as the 1M window, which is how claudeModelArgument spells contextWindow 1_000_000. A model that
// carries the suffix itself would get the 1M window under "agent-default" -- while capabilities answer
// contextWindowTokens null, so Orca's context tier never sees it -- or be sent as `[1m][1m]`. Refused, whatever
// contextWindow says.
const refusal = (model: string, contextWindow: "agent-default" | 1_000_000): string | null => {
  try {
    claudeDescriptor.validateSelection({ agent: "claude", model, contextWindow });
    return null;
  } catch (error) {
    return error instanceof AgentError ? error.code : `not an AgentError: ${String(error)}`;
  }
};

describe("claude model suffix (Orca backlog #13(a))", () => {
  it("accepts a plain model under either window and refuses one that carries the [1m] suffix itself", () => {
    expect(refusal("claude-opus-5-5", "agent-default")).toBeNull();
    expect(refusal("claude-opus-5-5", 1_000_000)).toBeNull();
    for (const model of ["claude-opus-5-5[1m]", "opus[1m]", "claude-opus-5-5[1M]"]) {
      for (const contextWindow of ["agent-default", 1_000_000] as const) {
        expect([model, contextWindow, refusal(model, contextWindow)]).toEqual([model, contextWindow, "agent-context-unsupported"]);
      }
    }
  });
});
