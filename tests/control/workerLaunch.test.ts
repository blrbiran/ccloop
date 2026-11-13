import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { inspectStart } from "../../src/control/accept.js";
import { canonicalHash, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { FIXTURE_SELECTION } from "./agentsFixture.js";
import { readProcessStartedAt } from "../../src/control/workerLauncher.js";
import { parseLstartUtc, readProcessStart } from "../../src/ownership/ownerLiveness.js";
import { writeAccepted } from "../../src/control/store.js";

async function fixture(): Promise<{ root: string; envelope: LoopStartEnvelope }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-worker-")));
  await mkdir(join(root, "input"));
  const amount = { tokens: 0, activeMs: 0, attempts: 0, sessions: 0 };
  const loop: LoopContract = {
    objective: { taskId: "task-1", goal: "work", successCondition: "done", nonGoals: [] },
    context: { repoPath: root, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2" as const, maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalRuntimeBudgetMs: 1_000, tokenBudget: 1, worktreeRequired: true as const, partialOutcomeRecoveryWindowMs: 0 },
    safetyPolicy: { allowlistPaths: [], denylistPaths: [], maxFilesTouched: 1, humanGateConditions: [] },
    verification: { verifierType: "command" as const, requiredChecks: ["npm test"], rejectOn: ["failure"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): the fixture is a
  // protocol-2 envelope whose claim carries a selection; the identity assertion is unchanged.
  // ERRATUM (human ruling S6, 2026-09-27, session f341f05f): the envelope named above is now protocol 3, work tagged kind "loop".
  // Human ruling S6 (2026-09-27, session f341f05f): protocol 3 envelope
  const envelope: LoopStartEnvelope = {
    protocol: 3,
    claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: "a".repeat(64), agent: FIXTURE_SELECTION, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: "b".repeat(64),
    inputCheckpoint: null,
    work: { kind: "loop", contract: loop, targetRepo: root, base: "main", sourceDir: root },
  };
  return { root, envelope };
}

describe("worker process identity", () => {
  it("does not accept a recycled live PID with a mismatched UTC start identity", async () => {
    const f = await fixture();
    const actual = await readProcessStartedAt(process.pid);
    expect(actual).not.toBeNull();
    await writeAccepted(f.root, {
      protocol: 1,
      envelopeHash: canonicalHash(f.envelope),
      executionId: "execution-1",
      configHash: f.envelope.claim.configHash,
      generation: 1,
      acceptedAt: new Date().toISOString(),
      launch: "claimed",
      worker: { pid: process.pid, startedAt: "1970-01-01T00:00:00.000Z", nonce: "nonce-1" },
    });
    expect(await inspectStart(f.envelope)).toEqual({ kind: "unknown" });
  });
});

// Orca tester follow-up I (Orca session d467cbd2, 2026-11-13; review of #273, finding 3): the worker's recorded start is
// compared with the start the owner liveness check reads (`ps lstart` under TZ=UTC, parsed as UTC). Recorded from a local
// reading, it was ambiguous in a DST fall-back hour -- 01:30 happens twice -- and a live worker could be recorded an hour
// early and so look lost (its pid "started after the owner was last known alive"). The start is now read as UTC whatever
// the process's own zone.
describe("worker start identity is read as UTC (Orca tester follow-up I)", () => {
  it("reads ps lstart as UTC, never in the local zone, and agrees with the liveness check's reading", async () => {
    const saved = process.env.TZ;
    process.env.TZ = "America/New_York"; // 2026-11-01 01:00-02:00 local happens twice here
    try {
      // 06:30 UTC is the second 01:30 in New York; a local reading of the same text would be 11:30 UTC.
      // mutation: parse the lstart text as local time (new Date(text)) -> 2026-11-01T11:30:00.000Z, red
      expect(await readProcessStartedAt(4242, async () => "Sun Nov  1 06:30:00 2026\n")).toBe("2026-11-01T06:30:00.000Z");
      // The real reading of this process equals the liveness check's own (readProcessStart under TZ=UTC + parseLstartUtc).
      // mutation: ps run without TZ=UTC (so it prints New York time) -> five hours apart, red
      const lstart = await readProcessStart(process.pid);
      expect(lstart).not.toBeNull();
      expect(await readProcessStartedAt(process.pid)).toBe(new Date(parseLstartUtc(lstart!)! * 1000).toISOString());
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });
});
