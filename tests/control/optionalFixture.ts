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
export async function fixture(): Promise<{ root: string; envelope: LoopStartEnvelope }> {
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

