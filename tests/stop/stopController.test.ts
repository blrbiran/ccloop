import { describe, expect, it } from "vitest";
import { evaluateStopDecision } from "../../src/stop/stopController.js";

describe("evaluateStopDecision", () => {
  it("returns retryable after the first failed attempt", () => {
    expect(
      evaluateStopDecision({
        humanCancelled: false,
        successSatisfied: false,
        humanGateHit: false,
        attemptNumber: 1,
        maxAttempts: 3,
        budgetExceeded: false,
        recentFailures: [],
        verifier: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/core.ts"],
          failingCommand: "npm test",
          safeToRetry: true,
        },
      }).kind,
    ).toBe("retryable");
  });

  it("blocks retries after the first failed attempt", () => {
    expect(
      evaluateStopDecision({
        humanCancelled: false,
        successSatisfied: false,
        humanGateHit: false,
        attemptNumber: 2,
        maxAttempts: 3,
        budgetExceeded: false,
        recentFailures: [],
        verifier: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/core.ts"],
          failingCommand: "npm test",
          safeToRetry: true,
        },
      }).kind,
    ).toBe("blocked_waiting_human");
  });

  it("exhausts when the reject category matches and the target paths repeat", () => {
    expect(
      evaluateStopDecision({
        humanCancelled: false,
        successSatisfied: false,
        humanGateHit: false,
        attemptNumber: 2,
        maxAttempts: 3,
        budgetExceeded: false,
        recentFailures: [
          {
            rejectCategory: "tests-failed",
            primaryTargetPaths: ["src/core.ts"],
            failingCommand: "npm test",
          },
        ],
        verifier: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/core.ts"],
          failingCommand: "pnpm test",
          safeToRetry: true,
        },
      }).kind,
    ).toBe("exhausted");
  });

  it("exhausts when the reject category matches and the failing command repeats", () => {
    expect(
      evaluateStopDecision({
        humanCancelled: false,
        successSatisfied: false,
        humanGateHit: false,
        attemptNumber: 2,
        maxAttempts: 3,
        budgetExceeded: false,
        recentFailures: [
          {
            rejectCategory: "tests-failed",
            primaryTargetPaths: ["src/core.ts"],
            failingCommand: "npm test",
          },
        ],
        verifier: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/other.ts"],
          failingCommand: "npm test",
          safeToRetry: true,
        },
      }).kind,
    ).toBe("exhausted");
  });
});
