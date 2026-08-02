import { describe, expect, it } from "vitest";
import { evaluateResumeEligibility, ResumeNotEligibleError, type ResumeGateInput } from "../../src/controller/resumeLoop.js";

function baseInput(): ResumeGateInput {
  return {
    ownerRecord: {
      runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:111", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: null,
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

// A5's double-transfer shape, rebuilt here in minimal INPUT form (no disk, no imported
// helper): the first transfer 1→2 published cleanly, then a second transfer 2→3 crashed
// mid-flight after `owner-transfer.json` and the owner record had rotated to 3 but before
// `reconciliation-record.json` was rewritten — so the reconciliation still describes 1→2.
// This is the only shape in which the reconciliation epoch LAGS the transfer epoch, which
// is what makes criterion 4 an equality check rather than a "not newer" check.
function doubleTransferInput(): ResumeGateInput {
  const input = baseInput();
  input.ownerTransfer.priorOwnerEpoch = 2;
  input.ownerTransfer.newOwnerEpoch = 3;
  input.ownerRecord.currentOwnerEpoch = 3;
  input.reconciliation.priorOwnerEpoch = 1;
  input.reconciliation.newOwnerEpoch = 2; // stale: left behind by the FIRST transfer
  return input;
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

  // ---------------------------------------------------------------------------------
  // §15 acceptance 5 / test 15: one test per criterion, each of which a single-criterion
  // mutation of `evaluateResumeEligibility` makes go red ON ITS OWN.
  //
  // Every one of these asserts the VERBATIM refusal reason, not just `.ok === false`.
  // With eight criteria refusing the same input shape, `.ok === false` cannot tell which
  // criterion decided, so a mutation of criterion X could be "killed" by a test that is
  // really pinned by criterion Y. The reason string is the only observable that names the
  // deciding criterion, so it is what makes each kill attributable.
  //
  // Each fixture below satisfies the other seven criteria, so the mutated criterion is the
  // ONLY one that can refuse: under its mutation the input must fall all the way through
  // to `{ ok: true }`.
  // ---------------------------------------------------------------------------------

  // Criterion 1 defends the `as boolean` cast: `OwnerTransferRecord.eligibleForContinuation`
  // is statically the literal `true`, so the cast exists purely because the value is parsed
  // off disk and can be anything. A truthy non-boolean must still be refused.
  it("refuses when owner-transfer eligibleForContinuation is not literally true", () => {
    const input = baseInput();
    (input.ownerTransfer as unknown as { eligibleForContinuation: unknown }).eligibleForContinuation = "true";
    expect(evaluateResumeEligibility(input)).toEqual({
      ok: false,
      reason: "owner-transfer is not eligible for continuation",
    });
  });

  it("refuses when the reconciliation record is not eligible", () => {
    const input = baseInput();
    input.reconciliation.eligibleForContinuation = false;
    expect(evaluateResumeEligibility(input)).toEqual({
      ok: false,
      reason: "reconciliation-record is not eligible for continuation",
    });
  });

  it("refuses when the reconciliation verdict is not OWNER_LOST", () => {
    const input = baseInput();
    input.reconciliation.ownershipVerdict = "OWNER_VALID";
    expect(evaluateResumeEligibility(input)).toEqual({
      ok: false,
      reason: "reconciliation verdict is OWNER_VALID, expected OWNER_LOST",
    });
  });

  // Uses the double-transfer fixture on purpose: with the reconciliation epoch BEHIND the
  // transfer epoch, weakening criterion 4 from `!==` to `>` lets the input through. A
  // fixture with the reconciliation epoch ahead (the shape the older test above uses)
  // cannot tell `!==` from `>` apart at all.
  it("refuses when the reconciliation epoch does not equal the transfer epoch", () => {
    const input = doubleTransferInput();
    expect(evaluateResumeEligibility(input)).toEqual({
      ok: false,
      reason: "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch",
    });
  });

  // `ownerStatus` stays "current" here even though a superseded epoch would normally carry
  // a different status: criterion 7 sits AFTER criterion 5, so leaving the status alone is
  // what keeps criterion 5 the only criterion that can refuse this input.
  it("refuses when the owner record has been superseded", () => {
    const input = baseInput();
    input.ownerRecord.supersededByEpoch = 3;
    expect(evaluateResumeEligibility(input)).toEqual({
      ok: false,
      reason: "owner epoch is superseded by 3",
    });
  });

  // The owner record LAGS the transfer (1 < 2) — the transfer was published but the owner
  // record was never rotated. Only deleting criterion 6 lets this through; the `<`
  // direction still refuses it, which is exactly why the third fixture below exists.
  it("refuses when the owner epoch does not equal the transfer epoch", () => {
    const input = baseInput();
    input.ownerRecord.currentOwnerEpoch = 1;
    expect(evaluateResumeEligibility(input)).toEqual({
      ok: false,
      reason: "published eligibility has been superseded by a newer owner epoch",
    });
  });

  it("refuses when the owner status is not current", () => {
    const input = baseInput();
    input.ownerRecord.ownerStatus = "lost";
    expect(evaluateResumeEligibility(input)).toEqual({
      ok: false,
      reason: "owner status is lost, expected current",
    });
  });

  it("refuses when the run status is not resumable", () => {
    const input = baseInput();
    input.runState.status = "succeeded";
    expect(evaluateResumeEligibility(input)).toEqual({
      ok: false,
      reason: "run status succeeded is not resumable",
    });
  });

  // The field ABSENT (not `false`): a truncated or older `owner-transfer.json` parses to
  // `undefined` here. `!== true` refuses it; `=== false` would wave it through. This is the
  // case the `as boolean` cast was written for, moved out of a comment and into a test.
  it("refuses when owner-transfer eligibleForContinuation is missing entirely", () => {
    const input = baseInput();
    delete (input.ownerTransfer as unknown as { eligibleForContinuation?: unknown }).eligibleForContinuation;
    expect(evaluateResumeEligibility(input)).toEqual({
      ok: false,
      reason: "owner-transfer is not eligible for continuation",
    });
  });

  // Third fixture for criterion 6: the owner epoch has run AHEAD of the transfer
  // (currentOwnerEpoch 3 > newOwnerEpoch 2). Hand-built and NOT reachable in production —
  // it corresponds to "a later transfer already completed but `owner-transfer.json` is
  // still the old one". That is fine: this test pins the SEMANTICS of criterion 6, not its
  // reachability. Baseline `3 !== 2` refuses; the mutant `3 < 2` is false and lets it pass.
  //
  // Every other criterion must PASS on this fixture, or the mutant survives:
  //   1 ownerTransfer.eligibleForContinuation === true  (before 6: else criterion 1 refuses both sides)
  //   2 reconciliation.eligibleForContinuation === true (before 6: same — and it has no intuitive
  //     link to "the owner epoch ran ahead", so it is the easiest one to forget)
  //   3 reconciliation.ownershipVerdict === "OWNER_LOST"      (before 6)
  //   4 reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch, i.e. both 2 (before 6)
  //   5 ownerRecord.supersededByEpoch === null                (before 6)
  //   7 ownerRecord.ownerStatus === "current"  (AFTER 6: otherwise the mutant is caught by 7
  //     and both sides refuse alike)
  //   8 runState.status ∈ RESUMABLE_STATUSES   (AFTER 6: same trap as 7)
  it("refuses when the owner epoch has run ahead of the transfer epoch", () => {
    const input = baseInput();
    input.ownerTransfer.eligibleForContinuation = true; // 1
    input.reconciliation.eligibleForContinuation = true; // 2
    input.reconciliation.ownershipVerdict = "OWNER_LOST"; // 3
    input.ownerTransfer.newOwnerEpoch = 2; // 4 (with the line below)
    input.reconciliation.newOwnerEpoch = 2; // 4
    input.ownerRecord.supersededByEpoch = null; // 5
    input.ownerRecord.currentOwnerEpoch = 3; // 6 — the criterion under test
    input.ownerRecord.ownerStatus = "current"; // 7
    input.runState.status = "executing"; // 8

    expect(evaluateResumeEligibility(input)).toEqual({
      ok: false,
      reason: "published eligibility has been superseded by a newer owner epoch",
    });
  });
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
