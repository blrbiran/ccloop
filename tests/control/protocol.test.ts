import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  parseControlRequest,
  type LoopStartEnvelope,
} from "../../src/control/protocol.js";
import { controlRoot } from "../../src/control/paths.js";
import { FIXTURE_SELECTION } from "./agentsFixture.js";

const amount = { tokens: 10, activeMs: 20, attempts: 1, sessions: 1 };

// Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): every criterion in this
// file reads a protocol-2 start envelope whose claim carries a full agent selection (spec §4.6); the envelope is
// otherwise the one the v1 criteria read.
// Human ruling S6 (2026-09-27, session f341f05f): protocol 3 envelope
// ERRATUM (same ruling): where the comment above says protocol-2, the fixture is now a protocol-3 envelope whose work
// is tagged `kind: "loop"` (Orca spec 2026-09-27-single-call-estimate-design.md §4.1); nothing else in it changed.
async function fixture(): Promise<{ root: string; envelope: LoopStartEnvelope }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-protocol-")));
  await mkdir(join(root, "input", "checkpoint-1"), { recursive: true });
  return {
    root,
    envelope: {
      protocol: 3,
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
        agent: FIXTURE_SELECTION,
        grant: { work: amount, handoff: amount },
        ownerToken: "owner-1",
      },
      contractHash: "b".repeat(64),
      inputCheckpoint: null,
      work: {
        kind: "loop",
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

// Orca single-call estimate (2026-09-27), spec §4.1 and §8.2 "协议": the single-call twin of the loop fixture.
function singleCallOf(root: string, loop: LoopStartEnvelope) {
  return {
    ...loop,
    inputCheckpoint: null,
    work: {
      kind: "single-call" as const,
      prompt: "Estimate the plan below.\n\n{\"planHash\":\"p\"}",
      responseSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      maxOutputTokens: 4096,
      sourceDir: root,
    },
  };
}

describe("control protocol v1", () => {
  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): the strict payload of every
  // method round-trips with a protocol-2 envelope, and capabilities carries a partial selection or null (spec §4.6)
  // where it used to carry an empty object.
  // Human ruling S6 (2026-09-27, session f341f05f): protocol 3 envelope
  // ERRATUM (same ruling): where the comment above says protocol-2, the fixture is now a protocol-3 envelope whose work
  // is tagged `kind: "loop"` (Orca spec 2026-09-27-single-call-estimate-design.md §4.1); nothing else in it changed.
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

    expect(parseControlRequest("capabilities", { agent: null })).toEqual({ agent: null });
    expect(parseControlRequest("capabilities", { agent: { agent: "claude", model: "opus" } })).toEqual({
      agent: { agent: "claude", model: "opus" },
    });
    expect(parseControlRequest("accept", envelope)).toEqual(envelope);
    expect(parseControlRequest("inspect", envelope)).toEqual(envelope);
    expect(parseControlRequest("handoff", { input: envelope, request })).toEqual({ input: envelope, request });
    expect(parseControlRequest("collect", { input: envelope, afterSeq: 0 })).toEqual({ input: envelope, afterSeq: 0 });
    expect(parseControlRequest("read-evidence", { input: envelope, ref })).toEqual({ input: envelope, ref });
  });

  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): the retired envelope
  // (protocol 1) and an unknown one (3) are both refused by name, apart from invalid requests; a capabilities request
  // must name its agent field (null for the table view), so `{}` is invalid like any extra key.
  // Human ruling S6 (2026-09-27, session f341f05f): protocol 3 envelope
  // Rewritten under S6 (Orca spec 2026-09-27-single-call-estimate-design.md §4.1, human ruling S7 "ccloop 现在没有发布，
  // 暂时不用考虑兼容性"): 3 is now the only start envelope; the retired 1 and 2 and an unknown 4 are each refused by name,
  // apart from invalid requests. The capabilities assertions are unchanged.
  it("names unsupported protocol versions separately from invalid requests", async () => {
    const { envelope } = await fixture();
    for (const protocol of [1, 2, 4]) {
      expect(() => parseControlRequest("accept", { ...envelope, protocol })).toThrow("control-protocol-unsupported");
    }
    expect(() => parseControlRequest("accept", { ...envelope, extra: true })).toThrow(
      "control-request-invalid",
    );
    expect(() => parseControlRequest("capabilities", { extra: true })).toThrow("control-request-invalid");
    expect(() => parseControlRequest("capabilities", { agent: null, extra: true })).toThrow("control-request-invalid");
    expect(() => parseControlRequest("capabilities", {})).toThrow("control-request-invalid");
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

  // Agent selection (2026-09-26), spec §4.6: the claim carries the FULL selection (every field, no extra key, a
  // positive safe integer or "agent-default" window, an id-shaped installation); capabilities carries at most a
  // partial one. Model strings are not judged here: the kind's validateSelection names them (spec §7).
  it("requires a full agent selection on the claim and at most a partial one on capabilities", async () => {
    const { envelope } = await fixture();
    const { agent: _agent, ...claimWithoutAgent } = envelope.claim;
    expect(() => parseControlRequest("accept", { ...envelope, claim: claimWithoutAgent })).toThrow(
      "control-request-invalid",
    );
    for (const agent of [
      { agent: "codex", model: "fixture" },
      { ...FIXTURE_SELECTION, extra: true },
      { ...FIXTURE_SELECTION, contextWindow: 0 },
      { ...FIXTURE_SELECTION, contextWindow: "1m" },
      { ...FIXTURE_SELECTION, agent: "../codex" },
    ]) {
      expect(() => parseControlRequest("accept", { ...envelope, claim: { ...envelope.claim, agent } })).toThrow(
        "control-request-invalid",
      );
    }
    expect(parseControlRequest("capabilities", { agent: { contextWindow: 1_000_000 } })).toEqual({
      agent: { contextWindow: 1_000_000 },
    });
    expect(() => parseControlRequest("capabilities", { agent: { agent: "claude", extra: true } })).toThrow(
      "control-request-invalid",
    );
  });

  // Orca single-call estimate (2026-09-27), spec §4.1: protocol 3 carries one read-only structured call as a second
  // kind of work, through every method that carries a start envelope.
  it("round-trips a single-call envelope for every method that carries one", async () => {
    const { root, envelope: loop } = await fixture();
    const envelope = singleCallOf(root, loop);
    const request = { protocol: 1 as const, requestId: "request-1", runId: envelope.claim.runId, generation: envelope.claim.generation, reason: "human" as const, deadlineAt: "2026-09-27T10:00:00+08:00" };
    const ref = { artifactId: "artifact-1", hash: "c".repeat(64) };
    expect(parseControlRequest("accept", envelope)).toEqual(envelope);
    expect(parseControlRequest("inspect", envelope)).toEqual(envelope);
    expect(parseControlRequest("handoff", { input: envelope, request })).toEqual({ input: envelope, request });
    expect(parseControlRequest("collect", { input: envelope, afterSeq: 0 })).toEqual({ input: envelope, afterSeq: 0 });
    expect(parseControlRequest("read-evidence", { input: envelope, ref })).toEqual({ input: envelope, ref });
  });

  // Spec §4.1: both kinds are strict, and a single call names no repository and no contract.
  it("refuses a work without its kind, an unknown kind, and a single call carrying loop fields or extra keys", async () => {
    const { root, envelope: loop } = await fixture();
    const { kind: _kind, ...untagged } = loop.work;
    expect(() => parseControlRequest("accept", { ...loop, work: untagged })).toThrow("control-request-invalid");
    expect(() => parseControlRequest("accept", { ...loop, work: { ...loop.work, kind: "estimate" } })).toThrow("control-request-invalid");
    const single = singleCallOf(root, loop);
    expect(() => parseControlRequest("accept", { ...single, work: { ...single.work, targetRepo: root } })).toThrow("control-request-invalid");
    expect(() => parseControlRequest("accept", { ...single, work: { ...single.work, contract: loop.work.contract } })).toThrow("control-request-invalid");
    expect(() => parseControlRequest("accept", { ...single, extra: true })).toThrow("control-request-invalid");
    expect(() => parseControlRequest("accept", { ...single, protocol: 2 })).toThrow("control-protocol-unsupported");
  });

  // Spec §4.1: the claude API takes the schema as a tool's input_schema, whose top level must be `type: "object"`.
  it("requires a response schema whose top level is an object schema", async () => {
    const { root, envelope: loop } = await fixture();
    const single = singleCallOf(root, loop);
    for (const responseSchema of [{ type: "array", items: {} }, { properties: {} }, { oneOf: [{ type: "object" }] }, [], "object", null]) {
      expect(() => parseControlRequest("accept", { ...single, work: { ...single.work, responseSchema } })).toThrow("control-request-invalid");
    }
  });

  it("requires a positive safe integer output cap", async () => {
    const { root, envelope: loop } = await fixture();
    const single = singleCallOf(root, loop);
    for (const maxOutputTokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4096"]) {
      expect(() => parseControlRequest("accept", { ...single, work: { ...single.work, maxOutputTokens } })).toThrow("control-request-invalid");
    }
    expect(parseControlRequest("accept", { ...single, work: { ...single.work, maxOutputTokens: 1 } })).toMatchObject({ work: { maxOutputTokens: 1 } });
  });

  // Spec §4.1 and §6.5: a single call is never continued, so it takes no input checkpoint -- not even one a loop
  // envelope with the same sourceDir would accept.
  it("refuses an input checkpoint on a single call that a loop envelope accepts", async () => {
    const { root, envelope: loop } = await fixture();
    const inside = { predecessorRunId: "run-0", checkpointId: "checkpoint-1", checkpointHash: "d".repeat(64), bundlePath: join(root, "input", "checkpoint-1") };
    expect(parseControlRequest("accept", { ...loop, inputCheckpoint: inside })).toEqual({ ...loop, inputCheckpoint: inside });
    expect(() => parseControlRequest("accept", { ...singleCallOf(root, loop), inputCheckpoint: inside })).toThrow("control-request-invalid");
  });

  it("requires a canonical absolute sourceDir on a single call too", async () => {
    const { root, envelope: loop } = await fixture();
    const single = singleCallOf(root, loop);
    expect(() => parseControlRequest("accept", { ...single, work: { ...single.work, sourceDir: "relative" } })).toThrow("control-request-invalid");
  });
});

// Orca syncskill integration (2026-10-03), spec 10.7 and 4.4: `work.skillPluginDir` on the loop work. Additive only.
describe("loop work skillPluginDir (Orca syncskill integration)", () => {
  // The envelope's identity is its canonical hash; an envelope that does not carry the field must hash as it did before
  // the field existed. GOLDEN: computed at ccloop 85a9564 (before the schema change) from this fixed envelope.
  it("leaves the canonical hash of an envelope without the field unchanged", async () => {
    const { envelope } = await fixture();
    const fixed = { ...envelope, work: { ...envelope.work, targetRepo: "/fixed/repo", sourceDir: "/fixed/source", contract: { ...(envelope.work as { contract: object }).contract, context: { ...(envelope.work as { contract: { context: object } }).contract.context, repoPath: "/fixed/repo" } } } };
    expect(canonicalHash(fixed)).toBe("032325fb451b1403ba45b211630306a2c8c961e707d872f48989c9893b71bf80");
  });

  it("parses an existing canonical directory and keeps the field", async () => {
    const { root, envelope } = await fixture();
    const dir = join(root, "skill-plugin");
    await mkdir(dir);
    const withDir = { ...envelope, work: { ...envelope.work, skillPluginDir: dir } };
    expect(parseControlRequest("accept", withDir)).toEqual(withDir);
  });

  it("refuses a relative path for every method that carries the envelope", async () => {
    const { envelope } = await fixture();
    const bad = { ...envelope, work: { ...envelope.work, skillPluginDir: "relative/dir" } };
    const request = { protocol: 1 as const, requestId: "r", runId: "run-1", generation: 1, reason: "budget" as const, deadlineAt: "2026-09-19T10:00:00+08:00" };
    expect(() => parseControlRequest("accept", bad)).toThrow("control-request-invalid");
    expect(() => parseControlRequest("inspect", bad)).toThrow("control-request-invalid");
    expect(() => parseControlRequest("handoff", { input: bad, request })).toThrow("control-request-invalid");
    expect(() => parseControlRequest("collect", { input: bad, afterSeq: 0 })).toThrow("control-request-invalid");
    expect(() => parseControlRequest("read-evidence", { input: bad, ref: { artifactId: "a", hash: "c".repeat(64) } })).toThrow("control-request-invalid");
  });

  it("requires an existing canonical directory for accept only", async () => {
    const { root, envelope } = await fixture();
    const real = join(root, "real-plugin");
    await mkdir(real);
    const link = join(root, "link-plugin");
    await symlink(real, link);
    const gone = join(root, "removed-plugin");
    const at = (skillPluginDir: string) => ({ ...envelope, work: { ...envelope.work, skillPluginDir } });
    expect(() => parseControlRequest("accept", at(gone))).toThrow("control-request-invalid");
    expect(() => parseControlRequest("accept", at(link))).toThrow("control-request-invalid");
    // The directory goes away with the workspace after landing; later calls must still parse the same envelope.
    expect(parseControlRequest("inspect", at(gone))).toEqual(at(gone));
    expect(parseControlRequest("handoff", { input: at(gone), request: { protocol: 1, requestId: "r", runId: "run-1", generation: 1, reason: "budget", deadlineAt: "2026-09-19T10:00:00+08:00" } }).input).toEqual(at(gone));
    expect(parseControlRequest("collect", { input: at(gone), afterSeq: 0 }).input).toEqual(at(gone));
    expect(parseControlRequest("read-evidence", { input: at(gone), ref: { artifactId: "a", hash: "c".repeat(64) } }).input).toEqual(at(gone));
  });

  it("does not take the field on a single-call work", async () => {
    const { root, envelope } = await fixture();
    const call = singleCallOf(root, envelope);
    expect(() => parseControlRequest("accept", { ...call, work: { ...call.work, skillPluginDir: root } })).toThrow("control-request-invalid");
  });
});
