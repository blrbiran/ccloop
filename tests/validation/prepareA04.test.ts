import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  A04_APPROVED_EXECUTION_POLICY,
  buildA04RunCommand,
  buildApprovalPackage,
  prepareA04,
} from "../../validation/v1/lib/a04.js";
import { renderScenario } from "../../validation/v1/lib/scenarios.js";

function buildOptions(
  overrides: Partial<typeof A04_APPROVED_EXECUTION_POLICY> = {},
  pathOverrides: Partial<{
    repoRoot: string;
    fixturePath: string;
    contractPath: string;
    runDir: string;
    evidenceDir: string;
    adapterConfigPath: string;
  }> = {},
) {
  return {
    repoRoot: "/repo",
    fixturePath: "/repo/.validation-runs/fixture-01",
    contractPath: "/repo/.validation-runs/contracts/A-04.json",
    runDir: "/repo/.validation-runs/runs/A-04",
    evidenceDir: "/repo/.validation-runs/evidence/A-04",
    adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
    ...pathOverrides,
    executionPolicyOverrides: {
      ...A04_APPROVED_EXECUTION_POLICY,
      ...overrides,
    },
  };
}

function buildContract(overrides: Partial<typeof A04_APPROVED_EXECUTION_POLICY> = {}) {
  return renderScenario("A", {
    repoPath: "/repo/.validation-runs/fixture-01",
    executionPolicyOverrides: {
      ...A04_APPROVED_EXECUTION_POLICY,
      ...overrides,
    },
  });
}

function buildDeps(input: {
  pathExists?: (path: string) => Promise<boolean>;
  assertCleanFixture?: (fixturePath: string) => Promise<{ head: string; status: string }>;
  readCurrentBranch?: (repoRoot: string) => Promise<string>;
  readRepoTrackedState?: (repoRoot: string) => Promise<{ head: string; status: string }>;
  runCommand?: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  writeContract?: (options: {
    fixturePath: string;
    contractPath: string;
    executionPolicyOverrides: typeof A04_APPROVED_EXECUTION_POLICY;
  }) => Promise<{ contract: ReturnType<typeof renderScenario>; sha256: string }>;
} = {}) {
  return {
    pathExists: input.pathExists ?? (async () => false),
    assertCleanFixture: input.assertCleanFixture ?? (async () => ({ head: "fixture-head", status: "" })),
    readCurrentBranch: input.readCurrentBranch ?? (async () => "main"),
    readRepoTrackedState: input.readRepoTrackedState ?? (async () => ({ head: "repo-head", status: "" })),
    runCommand: input.runCommand ?? (async () => ({ stdout: "", stderr: "" })),
    writeContract:
      input.writeContract ??
      (async ({ fixturePath, executionPolicyOverrides }) => ({
        contract: renderScenario("A", {
          repoPath: fixturePath,
          executionPolicyOverrides,
        }),
        sha256: "abc123",
      })),
  };
}

describe("A-04 approval package", () => {
  it("builds a frozen approval package with explicit scenario, path, and artifact expectations", () => {
    const pkg = buildApprovalPackage({
      repoRoot: "/repo",
      contract: buildContract(),
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
    expect(pkg.workingDirectory).toBe("/repo");
    expect(pkg.paths).toEqual({
      contractPath: "/repo/.validation-runs/contracts/A-04.json",
      fixturePath: "/repo/.validation-runs/fixture-01",
      runDir: "/repo/.validation-runs/runs/A-04",
      evidenceDir: "/repo/.validation-runs/evidence/A-04",
    });
    expect(pkg.scenario).toBe("A");
    expect(pkg.attempts).toBe(1);
    expect(pkg.automaticRetries).toBe("none");
    expect(pkg.claudePhases).toEqual(["plan", "execute", "verify"]);
    expect(pkg.expectedFileScope).toEqual(["src/counter.js", "test/counter.test.js"]);
    expect(pkg.expectedDiffScope).toEqual(["src/**", "test/**"]);
    expect(pkg.executionPolicy).toEqual({
      tokenBudget: 550000,
      perAttemptTimeoutMs: 600000,
      totalRuntimeBudgetMs: 1200000,
      partialOutcomeRecoveryWindowMs: 5000,
    });
    expect(pkg.expectedArtifacts).toEqual({
      runDir: [
        "loop-contract.json",
        "loop-state.json",
        "events.jsonl",
        "attempts/1/plan.json",
        "attempts/1/execution.json",
        "attempts/1/verify.json",
        "attempts/1/diff.patch",
        "attempts/1/stdout-stderr.log",
      ],
      evidenceDir: ["artifacts.json", "observations.json"],
    });
    expect(pkg.expectedReviewOutputs).toEqual({
      verifierType: "agent",
      requiredChecks: ["npm test"],
      expectedEvidenceArtifactStatuses: {
        plan: "PRESENT",
        execution: "PRESENT",
        verify: "PRESENT",
        diff: "PRESENT",
        log: "PRESENT",
        requiredChecks: "PRESENT",
      },
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

  it("rejects approval packages built from a non-A-04 execution policy", () => {
    expect(() =>
      buildApprovalPackage({
        repoRoot: "/repo",
        contract: buildContract({ tokenBudget: 1 }),
        contractPath: "/repo/.validation-runs/contracts/A-04.json",
        contractSha256: "abc123",
        fixturePath: "/repo/.validation-runs/fixture-01",
        runDir: "/repo/.validation-runs/runs/A-04",
        evidenceDir: "/repo/.validation-runs/evidence/A-04",
        adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
      }),
    ).toThrow(/A-04 requires fixed execution policy/);
  });

  it("rejects approval packages built from a drifted non-one-shot contract", () => {
    const contract = buildContract();

    expect(() =>
      buildApprovalPackage({
        repoRoot: "/repo",
        contract: {
          ...contract,
          executionPolicy: {
            ...contract.executionPolicy,
            maxAttempts: 2,
          },
        },
        contractPath: "/repo/.validation-runs/contracts/A-04.json",
        contractSha256: "abc123",
        fixturePath: "/repo/.validation-runs/fixture-01",
        runDir: "/repo/.validation-runs/runs/A-04",
        evidenceDir: "/repo/.validation-runs/evidence/A-04",
        adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
      }),
    ).toThrow(/A-04 requires fixed one-shot contract execution policy/);
  });

  it.each([
    ["contract path", "/repo/.validation-runs/contracts/A-04.json"],
    ["run directory", "/repo/.validation-runs/runs/A-04"],
    ["evidence directory", "/repo/.validation-runs/evidence/A-04"],
  ])("refuses to prepare when %s already exists", async (label, existingPath) => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          pathExists: async (path) => path === existingPath,
          runCommand,
        }),
      ),
    ).rejects.toThrow(`${label} already exists`);

    expect(runCommand.mock.calls).toEqual([
      ["npm", ["test"], "/repo"],
      ["npm", ["run", "typecheck"], "/repo"],
      ["npm", ["run", "build"], "/repo"],
    ]);
  });

  it.each([
    ["run directory", "/repo/.validation-runs/runs/A-04/pre-approval/contract.json"],
    ["evidence directory", "/repo/.validation-runs/evidence/A-04/pre-approval/contract.json"],
  ])("rejects contract paths inside the %s", async (label, contractPath) => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions({}, { contractPath }),
        buildDeps({ runCommand }),
      ),
    ).rejects.toThrow(`contract path must not be inside ${label}`);

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses to prepare A-04 outside branch main", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          readCurrentBranch: async () => "feature/a04",
          runCommand,
        }),
      ),
    ).rejects.toThrow(/A-04 preparation must run from branch main/);

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses execution policies that do not match the fixed A-04 envelope", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions({ tokenBudget: 1 }),
        buildDeps({ runCommand }),
      ),
    ).rejects.toThrow(/A-04 requires fixed execution policy/);

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses to start deterministic preflight when repo root already has changes", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          readRepoTrackedState: async () => ({ head: "repo-head", status: " M validation/v1/lib/a04.ts" }),
          runCommand,
        }),
      ),
    ).rejects.toThrow(/repo root must have no changes before deterministic A-04 preflight/);

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails when deterministic preflight leaves tracked changes in the main checkout", async () => {
    const writeContract = vi.fn(async () => ({ contract: buildContract(), sha256: "abc123" }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    let repoRootReads = 0;

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          readRepoTrackedState: async () => {
            repoRootReads += 1;
            if (repoRootReads === 1) {
              return { head: "repo-head", status: "" };
            }

            return { head: "repo-head", status: " M validation/v1/lib/a04.ts" };
          },
          runCommand,
          writeContract,
        }),
      ),
    ).rejects.toThrow(/deterministic A-04 preflight must leave the main checkout unchanged/);

    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("fails when deterministic preflight creates an untracked file in the main checkout", async () => {
    const writeContract = vi.fn(async () => ({ contract: buildContract(), sha256: "abc123" }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    let repoRootReads = 0;

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          readRepoTrackedState: async () => {
            repoRootReads += 1;
            if (repoRootReads === 1) {
              return { head: "repo-head", status: "" };
            }

            return { head: "repo-head", status: "?? scratch.txt" };
          },
          runCommand,
          writeContract,
        }),
      ),
    ).rejects.toThrow(/deterministic A-04 preflight must leave the main checkout unchanged/);

    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("fails when fixture becomes dirty during deterministic preflight", async () => {
    const writeContract = vi.fn(async () => ({ contract: buildContract(), sha256: "abc123" }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    let fixtureReads = 0;

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          assertCleanFixture: async () => {
            fixtureReads += 1;
            if (fixtureReads === 1) {
              return { head: "fixture-head", status: "" };
            }

            return { head: "fixture-head", status: " M src/counter.js" };
          },
          runCommand,
          writeContract,
        }),
      ),
    ).rejects.toThrow(/fixture must remain clean through final A-04 pre-approval/);

    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("runs deterministic preflight commands in the required order", async () => {
    const commands: string[] = [];

    await prepareA04(
      buildOptions(),
      buildDeps({
        runCommand: async (command, args) => {
          commands.push([command, ...args].join(" "));
          return { stdout: "", stderr: "" };
        },
      }),
    );

    expect(commands).toEqual([
      "npm test",
      "npm run typecheck",
      "npm run build",
      "npm test -- --run tests/validation/contracts.test.ts",
      "npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts tests/controller/runLoop.integration.test.ts tests/validation/evidence.test.ts",
    ]);
  });

  it("runs A-04 phases in spec order: main verification, freshness, contract render, focused regressions, final gate", async () => {
    const steps: string[] = [];

    await prepareA04(
      buildOptions(),
      buildDeps({
        assertCleanFixture: async () => {
          steps.push("fixture");
          return { head: "fixture-head", status: "" };
        },
        pathExists: async (path) => {
          steps.push(`exists:${path}`);
          return false;
        },
        runCommand: async (command, args) => {
          steps.push([command, ...args].join(" "));
          return { stdout: "", stderr: "" };
        },
        writeContract: async ({ fixturePath, executionPolicyOverrides }) => {
          steps.push("writeContract");
          return {
            contract: renderScenario("A", {
              repoPath: fixturePath,
              executionPolicyOverrides,
            }),
            sha256: "abc123",
          };
        },
      }),
    );

    expect(steps).toEqual([
      "npm test",
      "npm run typecheck",
      "npm run build",
      "fixture",
      "exists:/repo/.validation-runs/contracts/A-04.json",
      "exists:/repo/.validation-runs/runs/A-04",
      "exists:/repo/.validation-runs/evidence/A-04",
      "writeContract",
      "npm test -- --run tests/validation/contracts.test.ts",
      "npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts tests/controller/runLoop.integration.test.ts tests/validation/evidence.test.ts",
      "fixture",
      "exists:/repo/.validation-runs/runs/A-04",
      "exists:/repo/.validation-runs/evidence/A-04",
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
      workingDirectory: "/repo",
      paths: {
        contractPath: "/repo/.validation-runs/contracts/A-04.json",
        fixturePath: "/repo/.validation-runs/fixture-01",
        runDir: "/repo/.validation-runs/runs/A-04",
        evidenceDir: "/repo/.validation-runs/evidence/A-04",
      },
      scenario: "A",
      attempts: 1,
      automaticRetries: "none",
      claudePhases: ["plan", "execute", "verify"],
      executionPolicy: {
        tokenBudget: 550000,
        perAttemptTimeoutMs: 600000,
        totalRuntimeBudgetMs: 1200000,
        partialOutcomeRecoveryWindowMs: 5000,
      },
      expectedFileScope: ["src/counter.js", "test/counter.test.js"],
      expectedDiffScope: ["src/**", "test/**"],
      expectedArtifacts: {
        runDir: [
          "loop-contract.json",
          "loop-state.json",
          "events.jsonl",
          "attempts/1/plan.json",
          "attempts/1/execution.json",
          "attempts/1/verify.json",
          "attempts/1/diff.patch",
          "attempts/1/stdout-stderr.log",
        ],
        evidenceDir: ["artifacts.json", "observations.json"],
      },
      expectedReviewOutputs: {
        verifierType: "agent",
        requiredChecks: ["npm test"],
        expectedEvidenceArtifactStatuses: {
          plan: "PRESENT",
          execution: "PRESENT",
          verify: "PRESENT",
          diff: "PRESENT",
          log: "PRESENT",
          requiredChecks: "PRESENT",
        },
      },
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
    vi.doMock("../../validation/v1/lib/a04.js", async () => {
      const actual = await vi.importActual("../../validation/v1/lib/a04.js");
      return {
        ...actual,
        prepareA04: prepareA04Mock,
      };
    });

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

  it("prepare-a04 CLI rejects non-A-04 execution policy values before preparing", async () => {
    const prepareA04Mock = vi.fn(async () => ({
      approvalPackage: {},
      preflightCommands: [],
    }));

    vi.resetModules();
    vi.doMock("../../validation/v1/lib/a04.js", async () => {
      const actual = await vi.importActual("../../validation/v1/lib/a04.js");
      return {
        ...actual,
        prepareA04: prepareA04Mock,
      };
    });

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
        "1",
        "--per-attempt-timeout-ms",
        "600000",
        "--total-runtime-budget-ms",
        "1200000",
        "--partial-recovery-window-ms",
        "5000",
      ]);

      expect(code).toBe(1);
      expect(stdoutChunks).toEqual([]);
      expect(stderrChunks.join(""))
        .toContain("A-04 requires fixed execution policy: tokenBudget=550000, perAttemptTimeoutMs=600000, totalRuntimeBudgetMs=1200000, partialOutcomeRecoveryWindowMs=5000");
      expect(prepareA04Mock).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      vi.doUnmock("../../validation/v1/lib/a04.js");
      vi.resetModules();
    }
  });
});
