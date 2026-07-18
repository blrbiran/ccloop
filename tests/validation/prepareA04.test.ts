import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildA04RunCommand, buildApprovalPackage, prepareA04 } from "../../validation/v1/lib/a04.js";
import { renderScenario } from "../../validation/v1/lib/scenarios.js";

describe("A-04 approval package", () => {
  it("builds a frozen approval package with contract identity and expected scope", () => {
    const contract = renderScenario("A", {
      repoPath: "/repo/.validation-runs/fixture-01",
      executionPolicyOverrides: {
        tokenBudget: 550000,
        perAttemptTimeoutMs: 600000,
        totalRuntimeBudgetMs: 1200000,
        partialOutcomeRecoveryWindowMs: 5000,
      },
    });

    const pkg = buildApprovalPackage({
      contract,
      contractPath: "/repo/.validation-runs/contracts/A-04.json",
      contractSha256: "abc123",
      fixturePath: "/repo/.validation-runs/fixture-01",
      runDir: "/repo/.validation-runs/runs/A-04",
      evidenceDir: "/repo/.validation-runs/evidence/A-04",
      adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
    });

    expect(pkg.contractIdentity).toEqual({
      path: "/repo/.validation-runs/contracts/A-04.json",
      sha256: "abc123",
      schemaValid: true,
    });
    expect(pkg.expectedFileScope).toEqual(["src/counter.js", "test/counter.test.js"]);
    expect(pkg.expectedDiffScope).toEqual(["src/**", "test/**"]);
    expect(pkg.executionPolicy).toEqual({
      tokenBudget: 550000,
      perAttemptTimeoutMs: 600000,
      totalRuntimeBudgetMs: 1200000,
      partialOutcomeRecoveryWindowMs: 5000,
    });
    expect(pkg.exactCommand).toEqual([
      "npx",
      "--no-install",
      "tsx",
      "validation/v1/scripts/run-scenario.ts",
      "--scenario",
      "A",
      "--contract",
      "/repo/.validation-runs/contracts/A-04.json",
      "--fixture",
      "/repo/.validation-runs/fixture-01",
      "--run-dir",
      "/repo/.validation-runs/runs/A-04",
      "--evidence-dir",
      "/repo/.validation-runs/evidence/A-04",
      "--adapter-config",
      "/repo/examples/v1/claude-adapter-config.json",
    ]);
  });

  it("refuses to prepare when run or evidence paths already exist", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        {
          repoRoot: "/repo",
          fixturePath: "/repo/.validation-runs/fixture-01",
          contractPath: "/repo/.validation-runs/contracts/A-04.json",
          runDir: "/repo/.validation-runs/runs/A-04",
          evidenceDir: "/repo/.validation-runs/evidence/A-04",
          adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
          executionPolicyOverrides: {
            tokenBudget: 550000,
            perAttemptTimeoutMs: 600000,
            totalRuntimeBudgetMs: 1200000,
            partialOutcomeRecoveryWindowMs: 5000,
          },
        },
        {
          pathExists: async (path) => path.endsWith("runs/A-04"),
          assertCleanFixture: async () => ({ head: "abc", status: "" }),
          runCommand,
          writeContract: async () => ({
            contract: renderScenario("A", { repoPath: "/repo/.validation-runs/fixture-01" }),
            sha256: "abc123",
          }),
        },
      ),
    ).rejects.toThrow(/already exists/);

    expect(runCommand.mock.calls).toEqual([
      ["npm", ["test"], "/repo"],
      ["npm", ["run", "typecheck"], "/repo"],
      ["npm", ["run", "build"], "/repo"],
      ["npm", ["test", "--", "--run", "tests/validation/contracts.test.ts"], "/repo"],
      [
        "npm",
        [
          "test",
          "--",
          "--run",
          "tests/runtime/claude/subprocessClaudeAdapter.test.ts",
          "tests/controller/runLoop.integration.test.ts",
          "tests/validation/evidence.test.ts",
        ],
        "/repo",
      ],
    ]);
  });

  it("runs deterministic preflight commands in the required order", async () => {
    const commands: string[] = [];

    await prepareA04(
      {
        repoRoot: "/repo",
        fixturePath: "/repo/.validation-runs/fixture-01",
        contractPath: "/repo/.validation-runs/contracts/A-04.json",
        runDir: "/repo/.validation-runs/runs/A-04",
        evidenceDir: "/repo/.validation-runs/evidence/A-04",
        adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
        executionPolicyOverrides: {
          tokenBudget: 550000,
          perAttemptTimeoutMs: 600000,
          totalRuntimeBudgetMs: 1200000,
          partialOutcomeRecoveryWindowMs: 5000,
        },
      },
      {
        pathExists: async () => false,
        assertCleanFixture: async () => ({ head: "abc", status: "" }),
        runCommand: async (command, args) => {
          commands.push([command, ...args].join(" "));
          return { stdout: "", stderr: "" };
        },
        writeContract: async () => ({
          contract: renderScenario("A", { repoPath: "/repo/.validation-runs/fixture-01" }),
          sha256: "abc123",
        }),
      },
    );

    expect(commands).toEqual([
      "npm test",
      "npm run typecheck",
      "npm run build",
      "npm test -- --run tests/validation/contracts.test.ts",
      "npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts tests/controller/runLoop.integration.test.ts tests/validation/evidence.test.ts",
    ]);
  });

  it("buildA04RunCommand matches the current run-scenario CLI shape", () => {
    expect(
      buildA04RunCommand({
        contractPath: "/repo/.validation-runs/contracts/A-04.json",
        fixturePath: "/repo/.validation-runs/fixture-01",
        runDir: "/repo/.validation-runs/runs/A-04",
        evidenceDir: "/repo/.validation-runs/evidence/A-04",
        adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
      }),
    ).toEqual([
      "npx",
      "--no-install",
      "tsx",
      "validation/v1/scripts/run-scenario.ts",
      "--scenario",
      "A",
      "--contract",
      "/repo/.validation-runs/contracts/A-04.json",
      "--fixture",
      "/repo/.validation-runs/fixture-01",
      "--run-dir",
      "/repo/.validation-runs/runs/A-04",
      "--evidence-dir",
      "/repo/.validation-runs/evidence/A-04",
      "--adapter-config",
      "/repo/examples/v1/claude-adapter-config.json",
    ]);
  });

  it("prepare-a04 CLI prints approval package JSON only", async () => {
    const approvalPackage = {
      contractIdentity: {
        path: "/repo/.validation-runs/contracts/A-04.json",
        sha256: "abc123",
        schemaValid: true,
      },
      executionPolicy: {
        tokenBudget: 550000,
        perAttemptTimeoutMs: 600000,
        totalRuntimeBudgetMs: 1200000,
        partialOutcomeRecoveryWindowMs: 5000,
      },
      expectedFileScope: ["src/counter.js", "test/counter.test.js"],
      expectedDiffScope: ["src/**", "test/**"],
      exactCommand: ["npx", "--no-install", "tsx", "validation/v1/scripts/run-scenario.ts"],
      usageEvidenceExpectations: ["usage evidence is normalized in artifacts"],
      invariants: {
        fixtureClean: true,
        mainCheckoutMustRemainUnchanged: true,
        maxClaudePhases: 3,
      },
    };
    const prepareA04Mock = vi.fn(async () => ({
      approvalPackage,
      preflightCommands: ["npm test"],
    }));

    vi.resetModules();
    vi.doMock("../../validation/v1/lib/a04.js", () => ({
      prepareA04: prepareA04Mock,
    }));

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    try {
      const { main } = await import("../../validation/v1/scripts/prepare-a04.js");
      const code = await main([
        "--fixture",
        "/repo/.validation-runs/fixture-01",
        "--contract",
        "/repo/.validation-runs/contracts/A-04.json",
        "--run-dir",
        "/repo/.validation-runs/runs/A-04",
        "--evidence-dir",
        "/repo/.validation-runs/evidence/A-04",
        "--adapter-config",
        "/repo/examples/v1/claude-adapter-config.json",
        "--token-budget",
        "550000",
        "--per-attempt-timeout-ms",
        "600000",
        "--total-runtime-budget-ms",
        "1200000",
        "--partial-recovery-window-ms",
        "5000",
      ]);

      expect(code).toBe(0);
      expect(JSON.parse(stdoutChunks.join(""))).toEqual(approvalPackage);
      expect(stderrChunks).toEqual([]);
      expect(prepareA04Mock).toHaveBeenCalledWith({
        repoRoot: resolve("."),
        fixturePath: resolve("/repo/.validation-runs/fixture-01"),
        contractPath: resolve("/repo/.validation-runs/contracts/A-04.json"),
        runDir: resolve("/repo/.validation-runs/runs/A-04"),
        evidenceDir: resolve("/repo/.validation-runs/evidence/A-04"),
        adapterConfigPath: resolve("/repo/examples/v1/claude-adapter-config.json"),
        executionPolicyOverrides: {
          tokenBudget: 550000,
          perAttemptTimeoutMs: 600000,
          totalRuntimeBudgetMs: 1200000,
          partialOutcomeRecoveryWindowMs: 5000,
        },
      });
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      vi.doUnmock("../../validation/v1/lib/a04.js");
      vi.resetModules();
    }
  });
});
