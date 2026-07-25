import { describe, expect, it } from "vitest";
import { evaluateResumeEligibility, ResumeNotEligibleError, type ResumeGateInput } from "../../src/controller/resumeLoop.js";

function baseInput(): ResumeGateInput {
  return {
    ownerRecord: {
      runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:111", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current", supersededByEpoch: null,
    },
    ownerTransfer: {
      priorOwnerEpoch: 1, newOwnerEpoch: 2, priorProcessInstanceId: "pid:100",
      newProcessInstanceId: "pid:111", transferredAt: "2026-07-25T00:00:00.000Z",
      reason: "owner lost", eligibleForContinuation: true,
    },
    reconciliation: {
      staleSuspicionBasis: [], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute", conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "ok" },
      priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true,
    },
    runState: {
      status: "executing", currentAttempt: 2, attemptsUsed: 2,
      lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
      budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 1000, tokenBudgetRemaining: 500 },
      recentFailures: [],
    },
  };
}

describe("evaluateResumeEligibility", () => {
  it("passes for a coherent, current, non-superseded, resumable input", () => {
    expect(evaluateResumeEligibility(baseInput())).toEqual({ ok: true });
  });

  // The whitelist is the whole contract: an interrupted run is resumable only while it was
  // mid-loop. Asserting each accepted status separately keeps a silent narrowing of the
  // whitelist (e.g. dropping "verifying") from passing as "still green".
  it.each(["planning", "executing", "verifying"] as const)("accepts resumable status %s", (status) => {
    const input = baseInput();
    input.runState.status = status;
    expect(evaluateResumeEligibility(input)).toEqual({ ok: true });
  });

  it("refuses when owner-transfer is not eligible", () => {
    const input = baseInput();
    (input.ownerTransfer as { eligibleForContinuation: boolean }).eligibleForContinuation = false;
    const result = evaluateResumeEligibility(input);
    expect(result.ok).toBe(false);
  });

  it("refuses when reconciliation verdict is not OWNER_LOST", () => {
    const input = baseInput();
    input.reconciliation.ownershipVerdict = "OWNER_VALID";
    expect(evaluateResumeEligibility(input).ok).toBe(false);
  });

  it("refuses when reconciliation newOwnerEpoch does not match the transfer", () => {
    const input = baseInput();
    input.reconciliation.newOwnerEpoch = 3;
    expect(evaluateResumeEligibility(input).ok).toBe(false);
  });

  it("refuses a superseded eligibility (owner epoch newer than the transfer) — takeover authority belongs to reconciliation, not resume", () => {
    const input = baseInput();
    input.ownerRecord.currentOwnerEpoch = 3; // a newer transfer already rotated the epoch
    expect(evaluateResumeEligibility(input).ok).toBe(false);
  });

  it("refuses when supersededByEpoch is set", () => {
    const input = baseInput();
    input.ownerRecord.supersededByEpoch = 3;
    expect(evaluateResumeEligibility(input).ok).toBe(false);
  });

  it("refuses when owner status is not current", () => {
    const input = baseInput();
    input.ownerRecord.ownerStatus = "lost";
    expect(evaluateResumeEligibility(input).ok).toBe(false);
  });

  it.each(["succeeded", "failed", "cancelled", "exhausted", "blocked_waiting_human", "queued"] as const)(
    "refuses non-resumable status %s",
    (status) => {
      const input = baseInput();
      input.runState.status = status;
      expect(evaluateResumeEligibility(input).ok).toBe(false);
    },
  );
});

describe("ResumeNotEligibleError", () => {
  // A refusal is a policy outcome, not a crash. The CLI prints `error.message` only for
  // `instanceof Error` (src/cli.ts), so losing the Error subclassing or the verbatim reason
  // would leave an operator with no way to see WHY resume was denied.
  it("is an Error carrying the refusal reason verbatim under a distinguishable name", () => {
    const error = new ResumeNotEligibleError("run status succeeded is not resumable");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ResumeNotEligibleError");
    expect(error.message).toBe("run status succeeded is not resumable");
  });
});
