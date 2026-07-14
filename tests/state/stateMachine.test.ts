import { describe, expect, it } from "vitest";
import { transitionRunState } from "../../src/state/stateMachine.js";
import type { RunState } from "../../src/state/types.js";

const baseState: RunState = {
  status: "queued",
  currentAttempt: 0,
  attemptsUsed: 0,
  lastTransitionAt: "2026-07-14T00:00:00.000Z",
  waitingOnHuman: false,
  stopReason: null,
  budgetSnapshot: {
    attemptsRemaining: 3,
    timeRemainingMs: 900000,
    tokenBudgetRemaining: 200000,
  },
  recentFailures: [],
};

describe("transitionRunState", () => {
  it("allows queued -> planning", () => {
    expect(transitionRunState(baseState, "planning").status).toBe("planning");
  });

  it("rejects succeeded -> planning", () => {
    expect(() => transitionRunState({ ...baseState, status: "succeeded" }, "planning")).toThrow(/illegal/i);
  });
});
