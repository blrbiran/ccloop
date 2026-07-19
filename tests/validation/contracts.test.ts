import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { V1_TERMINAL_STATES, loopContractSchema } from "../../src/contract/schema.js";
import { SCENARIO_IDS, getScenario, renderScenario } from "../../validation/v1/lib/scenarios.js";

const execFileAsync = promisify(execFile);
const worktreeRoot = process.cwd();
const fixtureRepo = join(worktreeRoot, ".validation-runs", "fixture-smoke");
const renderScript = join(worktreeRoot, "validation", "v1", "scripts", "render-contract.ts");

async function createGitRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "ccloop-contract-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoPath });
  return repoPath;
}

type ScenarioOptions = {
  repoPath: string;
  timeoutMs?: number;
};

function optionsFor(id: (typeof SCENARIO_IDS)[number]): ScenarioOptions {
  if (id === "C" || id === "D") {
    return { repoPath: fixtureRepo, timeoutMs: 1234 };
  }

  return { repoPath: fixtureRepo };
}

describe("validation scenario rendering", () => {
  it("lists all strict scenario ids in order", () => {
    expect(SCENARIO_IDS).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("renders every scenario as a valid one-attempt contract", () => {
    for (const id of SCENARIO_IDS) {
      expect(() => loopContractSchema.parse(renderScenario(id, optionsFor(id)))).not.toThrow();
      expect(renderScenario(id, optionsFor(id)).executionPolicy.maxAttempts).toBe(1);
    }
  });

  it("renders scenario A with agent verification and src/test allowlists", () => {
    const contract = renderScenario("A", optionsFor("A"));

    expect(contract.verification.verifierType).toBe("agent");
    expect(contract.verification.requiredChecks).toEqual(["npm test"]);
    expect(contract.safetyPolicy.allowlistPaths).toEqual(["src/**", "test/**"]);
    expect(contract.safetyPolicy.denylistPaths).toEqual([]);
    expect(contract.verification.evidenceRequired).toEqual(["command output"]);
    expect(contract.escalationAndExit.terminalStates).toEqual([...V1_TERMINAL_STATES]);
    expect(contract.executionPolicy.tokenBudget).toBe(50000);
  });

  it("renders scenario A with explicit execution-policy overrides", () => {
    const contract = renderScenario("A", {
      repoPath: fixtureRepo,
      executionPolicyOverrides: {
        tokenBudget: 550000,
        perAttemptTimeoutMs: 600000,
        totalRuntimeBudgetMs: 1200000,
        partialOutcomeRecoveryWindowMs: 5000,
      },
    });

    expect(contract.executionPolicy).toMatchObject({
      maxAttempts: 1,
      tokenBudget: 550000,
      perAttemptTimeoutMs: 600000,
      totalRuntimeBudgetMs: 1200000,
      partialOutcomeRecoveryWindowMs: 5000,
    });
    expect(contract.objective.taskId).toBe("validation-v1-A");
    expect(contract.context.targetPaths).toEqual(["src/counter.js", "test/counter.test.js"]);
  });

  it("keeps non-overridden execution-policy fields unchanged", () => {
    const contract = renderScenario("A", {
      repoPath: fixtureRepo,
      executionPolicyOverrides: {
        tokenBudget: 550000,
      },
    });

    expect(contract.executionPolicy).toMatchObject({
      autonomyLevel: "L2",
      maxAttempts: 1,
      tokenBudget: 550000,
      perAttemptTimeoutMs: 300000,
      totalRuntimeBudgetMs: 600000,
      partialOutcomeRecoveryWindowMs: 3000,
      worktreeRequired: true,
    });
  });

  it("ignores unapproved runtime execution-policy overrides", () => {
    const contract = renderScenario("A", {
      repoPath: fixtureRepo,
      executionPolicyOverrides: {
        tokenBudget: 550000,
        maxAttempts: 99,
        autonomyLevel: "L4",
        worktreeRequired: false,
      } as any,
    });

    expect(contract.executionPolicy).toMatchObject({
      autonomyLevel: "L2",
      maxAttempts: 1,
      tokenBudget: 550000,
      worktreeRequired: true,
    });
  });

  it("rejects non-positive execution-policy overrides", () => {
    expect(() =>
      renderScenario("A", {
        repoPath: fixtureRepo,
        executionPolicyOverrides: { tokenBudget: 0 },
      }),
    ).toThrow();
  });

  it("renders scenario B with a denylisted restricted target and skipped verification artifacts", () => {
    const scenario = getScenario("B");
    const contract = renderScenario("B", optionsFor("B"));

    expect(contract.context.targetPaths).toEqual(["restricted.txt"]);
    expect(contract.safetyPolicy.denylistPaths).toEqual(["restricted.txt"]);
    expect(scenario.expectedArtifacts.verify).toBe("NOT_RUN");
    expect(scenario.expectedArtifacts.requiredChecks).toBe("NOT_RUN");
  });

  it("requires a positive timeout for scenarios C and D", () => {
    expect(() => renderScenario("C", { repoPath: fixtureRepo })).toThrow(/timeoutMs/);
    expect(() => renderScenario("C", { repoPath: fixtureRepo, timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => renderScenario("D", { repoPath: fixtureRepo })).toThrow(/timeoutMs/);
    expect(() => renderScenario("D", { repoPath: fixtureRepo, timeoutMs: -1 })).toThrow(/timeoutMs/);
  });

  it("renders scenarios C and D with the provided timeout and fixed shared total budget", () => {
    expect(renderScenario("C", optionsFor("C")).executionPolicy.perAttemptTimeoutMs).toBe(1234);
    expect(renderScenario("D", optionsFor("D")).executionPolicy.perAttemptTimeoutMs).toBe(1234);
    expect(renderScenario("C", optionsFor("C")).executionPolicy.totalRuntimeBudgetMs).toBe(600000);
    expect(renderScenario("D", optionsFor("D")).executionPolicy.totalRuntimeBudgetMs).toBe(600000);
    expect(renderScenario("C", optionsFor("C")).executionPolicy.partialOutcomeRecoveryWindowMs).toBe(3000);
    expect(renderScenario("D", optionsFor("D")).executionPolicy.partialOutcomeRecoveryWindowMs).toBe(3000);
  });
  it.each([
    ["B", { repoPath: fixtureRepo }],
    ["C", { repoPath: fixtureRepo, timeoutMs: 1234 }],
    ["D", { repoPath: fixtureRepo, timeoutMs: 1234 }],
    ["E", { repoPath: fixtureRepo }],
  ] as const)("rejects execution-policy overrides for non-A scenario %s", (id, options) => {
    expect(() =>
      renderScenario(id, {
        ...options,
        executionPolicyOverrides: {
          perAttemptTimeoutMs: 4321,
        },
      } as any),
    ).toThrow(/executionPolicyOverrides are only supported for scenario A/);
  });

  it("renders scenario E with src-only writes and required tests", () => {
    const contract = renderScenario("E", optionsFor("E"));

    expect(contract.safetyPolicy.allowlistPaths).toEqual(["src/**"]);
    expect(contract.safetyPolicy.denylistPaths).toEqual(["test/**"]);
    expect(contract.verification.requiredChecks).toEqual(["npm test"]);
    expect(contract.executionPolicy.maxAttempts).toBe(1);
    expect(contract.escalationAndExit.terminalStates).toEqual([...V1_TERMINAL_STATES]);
    expect(contract.executionPolicy.tokenBudget).toBe(50000);
  });
});

describe("render-contract CLI", () => {
  it("writes a validated scenario contract JSON file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-render-contract-"));
    const repoPath = await createGitRepo();
    const outputPath = join(tempRoot, "A.json");

    await execFileAsync(
      "npx",
      [
        "--no-install",
        "tsx",
        renderScript,
        "--scenario",
        "A",
        "--repo",
        repoPath,
        "--output",
        outputPath,
      ],
      { cwd: worktreeRoot },
    );

    const written = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    expect(loopContractSchema.parse(written).context.repoPath).toBe(await realpath(repoPath));
  });

  it("rejects scenario C without an explicit timeout", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-render-contract-"));
    const outputPath = join(tempRoot, "C.json");

    await expect(
      execFileAsync(
        "npx",
        [
          "--no-install",
          "tsx",
          renderScript,
          "--scenario",
          "C",
          "--repo",
          fixtureRepo,
          "--output",
          outputPath,
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/timeout-ms/) });
  });

  it("rejects a non-git repository path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-render-contract-"));
    const repoPath = join(tempRoot, "plain-dir");
    const outputPath = join(tempRoot, "A.json");
    await mkdir(repoPath, { recursive: true });

    await expect(
      execFileAsync(
        "npx",
        [
          "--no-install",
          "tsx",
          renderScript,
          "--scenario",
          "A",
          "--repo",
          repoPath,
          "--output",
          outputPath,
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/git repository/) });
  });

  it("refuses to overwrite an existing output file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-render-contract-"));
    const repoPath = await createGitRepo();
    const outputPath = join(tempRoot, "A.json");
    await writeFile(outputPath, `{}
`);

    await expect(
      execFileAsync(
        "npx",
        [
          "--no-install",
          "tsx",
          renderScript,
          "--scenario",
          "A",
          "--repo",
          repoPath,
          "--output",
          outputPath,
        ],
        { cwd: worktreeRoot },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/output file already exists/) });
  });
});
