// Change-sized runs P1 (Orca spec 2026-11-19-change-sized-runs-design.md §6.1, criteria P1-2 and P1-3; Orca #363 #366):
// the optional envelope key `work.attemptDelivery: "ref-v1"` is protocol 4 only and never beside `mode`. Without it an
// envelope parses and hashes exactly as before the key existed -- an in-flight envelope is frozen byte for byte, and Orca
// re-sends a stored one unchanged (spec §5.8), so a hash that moved would make every such run's accept a conflict.
import { describe, expect, it } from "vitest";
import { canonicalHash, ControlProtocolError, parseControlRequest, startEnvelopeSchema } from "../../src/control/protocol.js";
import { fixture } from "./optionalFixture.js";

const amount = { tokens: 10, activeMs: 20, attempts: 1, sessions: 1 };
/** A fixed protocol-4 loop envelope (no paths that vary per run), so its canonical hash can be pinned as a literal. */
function fixedV4(): Record<string, any> {
  return {
    protocol: 4,
    claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 2, targetVersion: 3,
      commandId: "command-1", configHash: "a".repeat(64), agent: { agent: "codex", model: "fixture", contextWindow: "agent-default" },
      grant: { work: { ...amount, sessions: 1 }, handoff: amount }, ownerToken: "owner-1" },
    contractHash: "b".repeat(64), inputCheckpoint: null,
    work: { kind: "loop", targetRepo: "/nonexistent/target", base: "main", sourceDir: "/nonexistent/source",
      contract: {
        objective: { taskId: "task-1", goal: "implement the task", successCondition: "the task passes", nonGoals: [] },
        context: { repoPath: "/nonexistent/repo", targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
        executionPolicy: { autonomyLevel: "L2", maxAttempts: 2, perAttemptTimeoutMs: 1_000, totalRuntimeBudgetMs: 2_000, tokenBudget: 1_000,
          worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
        safetyPolicy: { allowlistPaths: ["src"], denylistPaths: [], maxFilesTouched: 10, humanGateConditions: [] },
        verification: { verifierType: "command", requiredChecks: ["npm test"], rejectOn: ["failure"], evidenceRequired: [] },
        escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
      } },
  };
}

describe("work.attemptDelivery (change-sized runs P1, §6.1)", () => {
  it("P1-2: without the key a protocol-4 envelope parses to itself and hashes to the value it had before the key existed", () => {
    const envelope = fixedV4();
    const parsed = startEnvelopeSchema.parse(envelope);
    expect(parsed).toEqual(envelope);
    expect(Object.hasOwn(parsed.work, "attemptDelivery")).toBe(false);
    // Measured on ccloop 214125f (the commit before the key), with this same literal: the frozen bytes of an in-flight envelope.
    expect(canonicalHash(parsed)).toBe("8342cce27623ca836cf13378b2adc7407ccd453519c5c280534da66796c5596f");
  });

  it("P1-3: the key is accepted on a protocol-4 loop envelope and kept as sent", async () => {
    const { envelope } = await fixture();
    const v4 = { ...envelope, protocol: 4, work: { ...envelope.work, attemptDelivery: "ref-v1" } };
    const parsed = parseControlRequest("accept", v4);
    expect(parsed).toEqual(v4);
    expect(canonicalHash(parsed)).not.toBe(canonicalHash({ ...envelope, protocol: 4 }));
  });

  it("P1-3: the key on a protocol-3 envelope, or with any other value, is refused", async () => {
    const { envelope } = await fixture();
    expect(() => parseControlRequest("accept", { ...envelope, work: { ...envelope.work, attemptDelivery: "ref-v1" } })).toThrow("control-request-invalid");
    expect(() => parseControlRequest("accept", { ...envelope, protocol: 4, work: { ...envelope.work, attemptDelivery: "ref-v2" } })).toThrow("control-request-invalid");
  });

  it("P1-3: the key beside mode verify-saved-result is refused by name, for every method that reads an envelope", async () => {
    const { envelope } = await fixture();
    const recovery = { ...envelope, protocol: 4, mode: "verify-saved-result",
      savedResultRecovery: { packagePath: "/nonexistent/input/p", packageHash: "c".repeat(64), admissionHash: "d".repeat(64),
        recoveryOf: { sourceRunId: "run-0", sourceAttempt: 1, capsuleHash: "e".repeat(64), snapshotHash: "e".repeat(64), normalizedExecutionHash: "f".repeat(64) } },
      work: { ...envelope.work, attemptDelivery: "ref-v1" } };
    // Without the key the same recovery envelope gets past the schema (its paths are what fail next), so the refusal is the key's.
    const { attemptDelivery: _key, ...plainWork } = recovery.work;
    const schemaOnly = startEnvelopeSchema.safeParse({ ...recovery, work: plainWork });
    expect(schemaOnly.success, JSON.stringify(schemaOnly.error?.issues)).toBe(true);
    for (const call of [() => parseControlRequest("accept", recovery), () => parseControlRequest("collect", { input: recovery, afterSeq: 0 })]) {
      let error: unknown;
      try { call(); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ControlProtocolError);
      expect((error as ControlProtocolError).code).toBe("attempt-delivery-with-saved-result");
    }
  });
});
