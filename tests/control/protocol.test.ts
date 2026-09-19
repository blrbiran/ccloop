import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  parseControlRequest,
  type StartEnvelopeV1,
} from "../../src/control/protocol.js";
import { controlRoot } from "../../src/control/paths.js";

const amount = { tokens: 10, activeMs: 20, attempts: 1, sessions: 1 };

async function fixture(): Promise<{ root: string; envelope: StartEnvelopeV1 }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-protocol-")));
  await mkdir(join(root, "input", "checkpoint-1"), { recursive: true });
  return {
    root,
    envelope: {
      protocol: 1,
      claim: {
        groupId: "group-1",
        workItemId: "work-1",
        taskId: "task-1",
        runId: "run-1",
        generation: 1,
        graphVersion: 2,
        targetVersion: 3,
        commandId: "command-1",
        configHash: "a".repeat(64),
        grant: { work: amount, handoff: amount },
        ownerToken: "owner-1",
      },
      contractHash: "b".repeat(64),
      inputCheckpoint: null,
      work: {
        contract: {
          objective: {
            taskId: "task-1",
            goal: "implement the task",
            successCondition: "the task passes",
            nonGoals: [],
          },
          context: {
            repoPath: root,
            targetPaths: ["src"],
            relevantDocs: [],
            buildTestCommands: ["npm test"],
            constraints: [],
          },
          executionPolicy: {
            autonomyLevel: "L2",
            maxAttempts: 2,
            perAttemptTimeoutMs: 1_000,
            totalRuntimeBudgetMs: 2_000,
            tokenBudget: 1_000,
            worktreeRequired: true,
            partialOutcomeRecoveryWindowMs: 100,
          },
          safetyPolicy: {
            allowlistPaths: ["src"],
            denylistPaths: [],
            maxFilesTouched: 10,
            humanGateConditions: [],
          },
          verification: {
            verifierType: "command",
            requiredChecks: ["npm test"],
            rejectOn: ["failure"],
            evidenceRequired: [],
          },
          escalationAndExit: {
            escalationTargets: [],
            pauseOn: [],
            stopOn: [],
            terminalStates: [
              "succeeded",
              "blocked_waiting_human",
              "exhausted",
              "cancelled",
              "failed",
            ],
          },
        },
        targetRepo: root,
        base: "main",
        sourceDir: root,
      },
    },
  };
}

describe("control protocol v1", () => {
  it("round-trips the strict payload for every method", async () => {
    const { envelope } = await fixture();
    const request = {
      protocol: 1 as const,
      requestId: "request-1",
      runId: envelope.claim.runId,
      generation: envelope.claim.generation,
      reason: "budget" as const,
      deadlineAt: "2026-09-19T10:00:00+08:00",
    };
    const ref = { artifactId: "artifact-1", hash: "c".repeat(64) };

    expect(parseControlRequest("capabilities", {})).toEqual({});
    expect(parseControlRequest("accept", envelope)).toEqual(envelope);
    expect(parseControlRequest("inspect", envelope)).toEqual(envelope);
    expect(parseControlRequest("handoff", { input: envelope, request })).toEqual({ input: envelope, request });
    expect(parseControlRequest("collect", { input: envelope, afterSeq: 0 })).toEqual({ input: envelope, afterSeq: 0 });
    expect(parseControlRequest("read-evidence", { input: envelope, ref })).toEqual({ input: envelope, ref });
  });

  it("names unsupported protocol versions separately from invalid requests", async () => {
    const { envelope } = await fixture();
    expect(() => parseControlRequest("accept", { ...envelope, protocol: 2 })).toThrow(
      "control-protocol-unsupported",
    );
    expect(() => parseControlRequest("accept", { ...envelope, extra: true })).toThrow(
      "control-request-invalid",
    );
    expect(() => parseControlRequest("capabilities", { extra: true })).toThrow("control-request-invalid");
  });

  it("rejects unsafe integers, malformed identities, and malformed hashes", async () => {
    const { envelope } = await fixture();
    expect(() =>
      parseControlRequest("accept", {
        ...envelope,
        claim: { ...envelope.claim, generation: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow("control-request-invalid");
    expect(() =>
      parseControlRequest("accept", {
        ...envelope,
        claim: { ...envelope.claim, runId: "../run" },
      }),
    ).toThrow("control-request-invalid");
    expect(() => parseControlRequest("accept", { ...envelope, contractHash: "nope" })).toThrow(
      "control-request-invalid",
    );
    expect(() =>
      parseControlRequest("collect", { input: envelope, afterSeq: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow("control-request-invalid");
    expect(() =>
      parseControlRequest("read-evidence", {
        input: envelope,
        ref: { artifactId: "artifact-1", hash: "F".repeat(64) },
      }),
    ).toThrow("control-request-invalid");
  });

  it("requires a canonical absolute sourceDir with no symlink ancestor", async () => {
    const { root, envelope } = await fixture();
    expect(() =>
      parseControlRequest("accept", { ...envelope, work: { ...envelope.work, sourceDir: "relative" } }),
    ).toThrow("control-request-invalid");

    const alias = `${root}-alias`;
    await symlink(root, alias);
    expect(() =>
      parseControlRequest("accept", { ...envelope, work: { ...envelope.work, sourceDir: alias } }),
    ).toThrow("control-request-invalid");
  });

  it("keeps an input bundle inside the canonical source input directory", async () => {
    const { root, envelope } = await fixture();
    const outside = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-outside-")));
    const checkpoint = {
      predecessorRunId: "run-0",
      checkpointId: "checkpoint-1",
      checkpointHash: "d".repeat(64),
      bundlePath: outside,
    };
    expect(() => parseControlRequest("accept", { ...envelope, inputCheckpoint: checkpoint })).toThrow(
      "control-request-invalid",
    );

    const inside = { ...checkpoint, bundlePath: join(root, "input", "checkpoint-1") };
    expect(parseControlRequest("accept", { ...envelope, inputCheckpoint: inside })).toEqual({
      ...envelope,
      inputCheckpoint: inside,
    });
  });

  it("canonicalizes object keys recursively while preserving array order", () => {
    const left = { z: [{ b: 2, a: 1 }, 3], a: { y: true, x: null } };
    const right = { a: { x: null, y: true }, z: [{ a: 1, b: 2 }, 3] };
    const reorderedArray = { ...right, z: [3, { a: 1, b: 2 }] };
    const expected = createHash("sha256")
      .update('{"a":{"x":null,"y":true},"z":[{"a":1,"b":2},3]}')
      .digest("hex");
    expect(canonicalHash(left)).toBe(expected);
    expect(canonicalHash(right)).toBe(expected);
    expect(canonicalHash(reorderedArray)).not.toBe(expected);
  });

  it("derives the control root from the accepted source directory", async () => {
    const { root, envelope } = await fixture();
    expect(controlRoot(envelope)).toBe(join(root, "control"));
  });
});
