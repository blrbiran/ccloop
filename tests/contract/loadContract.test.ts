import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadContract } from "../../src/contract/loadContract.js";

function createValidContract() {
  return {
    objective: {
      taskId: "task-1",
      goal: "Fix the failing test",
      successCondition: "All required checks pass",
      nonGoals: ["Do not refactor unrelated files"],
    },
    context: {
      repoPath: "/tmp/repo",
      targetPaths: ["src"],
      relevantDocs: ["docs/ref/LoopEngineering.md"],
      buildTestCommands: ["npm test"],
      constraints: ["smallest possible diff"],
    },
    executionPolicy: {
      autonomyLevel: "L2",
      maxAttempts: 3,
      perAttemptTimeoutMs: 300000,
      totalRuntimeBudgetMs: 900000,
      tokenBudget: 200000,
      worktreeRequired: true,
    },
    safetyPolicy: {
      allowlistPaths: ["src/**"],
      denylistPaths: [".env", "auth/**"],
      maxFilesTouched: 10,
      humanGateConditions: ["touches gated path"],
    },
    verification: {
      verifierType: "command",
      requiredChecks: ["npm test"],
      rejectOn: ["tests fail"],
      evidenceRequired: ["command output"],
    },
    escalationAndExit: {
      escalationTargets: ["human"],
      pauseOn: ["missing information"],
      stopOn: ["budget exhausted"],
      terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
    },
  };
}

describe("loadContract", () => {
  it("loads a valid L2 contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccloop-contract-"));
    const filePath = join(dir, "contract.json");

    await writeFile(filePath, JSON.stringify(createValidContract()));

    const contract = await loadContract(filePath);
    expect(contract.executionPolicy.autonomyLevel).toBe("L2");
    expect(contract.executionPolicy.worktreeRequired).toBe(true);
  });

  it("rejects a contract without a success condition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccloop-contract-"));
    const filePath = join(dir, "broken.json");
    await writeFile(filePath, JSON.stringify({ objective: { taskId: "task-1", goal: "x" } }));

    await expect(loadContract(filePath)).rejects.toThrow(/successCondition/i);
  });

  it("rejects a contract with unsupported top-level fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccloop-contract-"));
    const filePath = join(dir, "extra-top-level.json");
    await writeFile(filePath, JSON.stringify({ ...createValidContract(), unexpected: true }));

    await expect(loadContract(filePath)).rejects.toThrow(/unrecognized key/i);
  });

  it.each([
    {
      name: "an empty terminalStates list",
      terminalStates: [],
    },
    {
      name: "a partial terminalStates list",
      terminalStates: ["succeeded"],
    },
  ])("rejects a contract with $name", async ({ terminalStates }) => {
    const dir = await mkdtemp(join(tmpdir(), "ccloop-contract-"));
    const filePath = join(dir, "invalid-terminal-states.json");
    await writeFile(
      filePath,
      JSON.stringify({
        ...createValidContract(),
        escalationAndExit: {
          ...createValidContract().escalationAndExit,
          terminalStates,
        },
      }),
    );

    await expect(loadContract(filePath)).rejects.toThrow(/terminalStates/i);
  });

  it("rejects a contract with unsupported nested fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccloop-contract-"));
    const filePath = join(dir, "extra-nested.json");
    await writeFile(
      filePath,
      JSON.stringify({
        ...createValidContract(),
        objective: {
          ...createValidContract().objective,
          unexpected: true,
        },
      }),
    );

    await expect(loadContract(filePath)).rejects.toThrow(/unrecognized key/i);
  });
});
