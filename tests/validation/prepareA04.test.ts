import { mkdtemp, mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  A04_APPROVED_EXECUTION_POLICY,
  buildA04RunCommand,
  materializeVerifiedCheckoutDependencies,
  buildApprovalPackage,
  type ReadOnlyInspection,
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


function buildReadOnlyInspection(overrides: Partial<ReadOnlyInspection> = {}): ReadOnlyInspection {
  return {
    mainCheckout: {
      path: "/repo",
      head: "main-head",
      branch: "main",
    },
    evidenceFirstValidationWorktree: {
      path: "/repo/.worktrees/evidence-first-v1",
      head: "evidence-head",
      branch: "evidence-first-v1",
    },
    retainedBackupBranch: {
      name: "backup/evidence-first-v1-before-memory-history-cleanup",
      head: "backup-head",
    },
    retainedStashes: [
      "stash@{0}: On main: pre-local-merge-evidence-first-v1-2026-07-18",
      "stash@{1}: On main: pre-merge local changes 2026-07-16",
    ],
    preservedEvidenceTree: {
      path: "/repo/.worktrees/evidence-first-v1/.validation-runs",
      requiredPaths: [
        "/repo/.worktrees/evidence-first-v1/.validation-runs/fixture-01",
        "/repo/.worktrees/evidence-first-v1/.validation-runs/contracts/A-01.json",
        "/repo/.worktrees/evidence-first-v1/.validation-runs/contracts/A-02.json",
        "/repo/.worktrees/evidence-first-v1/.validation-runs/contracts/A-03.json",
        "/repo/.worktrees/evidence-first-v1/.validation-runs/evidence/A-01/review.json",
        "/repo/.worktrees/evidence-first-v1/.validation-runs/evidence/A-02/review.json",
        "/repo/.worktrees/evidence-first-v1/.validation-runs/evidence/A-03/review.json",
      ],
    },
    ...overrides,
  };
}

function buildDeps(input: {
  pathExists?: (path: string) => Promise<boolean>;
  assertCleanFixture?: (fixturePath: string) => Promise<{ head: string; status: string }>;
  readCurrentBranch?: (repoRoot: string) => Promise<string>;
  inspectReadOnlyInspection?: (repoRoot: string) => Promise<ReadOnlyInspection>;
  createMainVerificationCheckout?: (repoRoot: string) => Promise<{ path: string; head: string; cleanup: () => Promise<void> }>;
  runCommand?: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  writeContract?: (options: {
    fixturePath: string;
    contractPath: string;
    executionPolicyOverrides: typeof A04_APPROVED_EXECUTION_POLICY;
  }) => Promise<{ contract: ReturnType<typeof renderScenario>; sha256: string }>;
  readFrozenContract?: (contractPath: string) => Promise<{ contract: ReturnType<typeof renderScenario>; sha256: string }>;
} = {}) {
  return {
    pathExists: input.pathExists ?? (async () => false),
    assertCleanFixture: input.assertCleanFixture ?? (async () => ({ head: "fixture-head", status: "" })),
    readCurrentBranch: input.readCurrentBranch ?? (async () => "main"),
    inspectReadOnlyInspection: input.inspectReadOnlyInspection ?? (async () => buildReadOnlyInspection()),
    createMainVerificationCheckout:
      input.createMainVerificationCheckout ??
      (async () => ({
        path: "/tmp/a04-main-checkout",
        head: "verified-main-head",
        cleanup: async () => {},
      })),
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
    readFrozenContract:
      input.readFrozenContract ??
      (async () => ({
        contract: buildContract(),
        sha256: "abc123",
      })),
  };
}

describe("verified checkout dependency materialization", () => {
  it("copies node_modules into the verified checkout without leaving a symlink to the main checkout", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-a04-node-modules-"));
    const repoRoot = join(tempRoot, "repo");
    const worktreePath = join(tempRoot, "verified-checkout");
    const sourcePackageDir = join(repoRoot, "node_modules", "demo-package");
    const sourcePackageFile = join(sourcePackageDir, "index.js");
    const copiedPackageFile = join(worktreePath, "node_modules", "demo-package", "index.js");

    await mkdir(sourcePackageDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await writeFile(sourcePackageFile, 'module.exports = "source";\n');

    await materializeVerifiedCheckoutDependencies(repoRoot, worktreePath);

    const nodeModulesStats = await lstat(join(worktreePath, "node_modules"));
    expect(nodeModulesStats.isSymbolicLink()).toBe(false);
    expect(await readFile(copiedPackageFile, "utf8")).toBe('module.exports = "source";\n');

    await writeFile(sourcePackageFile, 'module.exports = "mutated";\n');
    expect(await readFile(copiedPackageFile, "utf8")).toBe('module.exports = "source";\n');
  });
});

describe("A-04 approval package", () => {
  it("builds a frozen approval package with explicit scenario, path, and artifact expectations", () => {
    const pkg = buildApprovalPackage({
      verifiedCheckoutPath: "/tmp/a04-main-checkout",
      verifiedCheckoutHead: "verified-main-head",
      readOnlyInspection: buildReadOnlyInspection(),
      contract: buildContract(),
      contractPath: "/repo/.validation-runs/contracts/A-04.json",
      contractSha256: "abc123",
      fixturePath: "/repo/.validation-runs/fixture-01",
      runDir: "/repo/.validation-runs/runs/A-04",
      evidenceDir: "/repo/.validation-runs/evidence/A-04",
      adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
    });

    expect(pkg.contractIdentity).toEqual({
      path: "/repo/.validation-runs/contracts/A-04.json",
      sha256: "abc123",
      schemaValid: true,
    });
    expect(pkg.verifiedCheckout).toEqual({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      runScenarioScriptPath: "/tmp/a04-main-checkout/validation/v1/scripts/run-scenario.ts",
      adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
    });
    expect(pkg.readOnlyInspection).toEqual(buildReadOnlyInspection());
    expect(pkg.workingDirectory).toBe("/tmp/a04-main-checkout");
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
      "/tmp/a04-main-checkout/validation/v1/scripts/run-scenario.ts",
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
      "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
    ]);
  });

  it("rejects approval packages built from a non-A-04 execution policy", () => {
    expect(() =>
      buildApprovalPackage({
        verifiedCheckoutPath: "/tmp/a04-main-checkout",
        verifiedCheckoutHead: "verified-main-head",
        readOnlyInspection: buildReadOnlyInspection(),
        contract: buildContract({ tokenBudget: 1 }),
        contractPath: "/repo/.validation-runs/contracts/A-04.json",
        contractSha256: "abc123",
        fixturePath: "/repo/.validation-runs/fixture-01",
        runDir: "/repo/.validation-runs/runs/A-04",
        evidenceDir: "/repo/.validation-runs/evidence/A-04",
        adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
      }),
    ).toThrow(/A-04 requires fixed execution policy/);
  });

  it("rejects approval packages built from a drifted non-one-shot contract", () => {
    const contract = buildContract();

    expect(() =>
      buildApprovalPackage({
        verifiedCheckoutPath: "/tmp/a04-main-checkout",
        verifiedCheckoutHead: "verified-main-head",
        readOnlyInspection: buildReadOnlyInspection(),
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
        adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
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
      ["npm", ["test"], "/tmp/a04-main-checkout"],
      ["npm", ["run", "typecheck"], "/tmp/a04-main-checkout"],
      ["npm", ["run", "build"], "/tmp/a04-main-checkout"],
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


  it("fails read-only inspection before creating the verification checkout", async () => {
    const createMainVerificationCheckout = vi.fn(async () => ({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      cleanup: async () => {},
    }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          inspectReadOnlyInspection: async () => {
            throw new Error("A-04 read-only inspection requires retained stash matching: On main: pre-local-merge-evidence-first-v1-2026-07-18");
          },
          createMainVerificationCheckout,
        }),
      ),
    ).rejects.toThrow(/A-04 read-only inspection requires retained stash matching/);

    expect(createMainVerificationCheckout).not.toHaveBeenCalled();
  });

  it("preserves the isolated verified checkout so approval stays bound to the verified runnable revision", async () => {
    const cleanup = vi.fn(async () => {});
    const createMainVerificationCheckout = vi.fn(async () => ({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      cleanup,
    }));
    const runCommand = vi.fn(async (..._args: [string, string[], string]) => ({ stdout: "", stderr: "" }));

    await prepareA04(
      buildOptions(),
      buildDeps({
        createMainVerificationCheckout,
        runCommand,
      }),
    );

    expect(createMainVerificationCheckout).toHaveBeenCalledWith("/repo");
    expect(runCommand.mock.calls.map((call) => call[2])).toEqual([
      "/tmp/a04-main-checkout",
      "/tmp/a04-main-checkout",
      "/tmp/a04-main-checkout",
      "/tmp/a04-main-checkout",
      "/tmp/a04-main-checkout",
    ]);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("cleans up the isolated verification checkout when preparation fails after checkout creation", async () => {
    const cleanup = vi.fn(async () => {});
    const createMainVerificationCheckout = vi.fn(async () => ({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      cleanup,
    }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          createMainVerificationCheckout,
          readFrozenContract: async () => ({
            contract: buildContract(),
            sha256: "drifted-sha256",
          }),
        }),
      ),
    ).rejects.toThrow(/contract file contents must remain frozen through final A-04 pre-approval/);

    expect(cleanup).toHaveBeenCalledTimes(1);
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

  it("fails when the frozen contract file is deleted after render", async () => {
    const writeContract = vi.fn(async () => ({ contract: buildContract(), sha256: "abc123" }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          runCommand,
          writeContract,
          readFrozenContract: async () => {
            const error = new Error("ENOENT") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          },
        }),
      ),
    ).rejects.toThrow(/contract file must still exist through final A-04 pre-approval/);

    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("fails when the frozen contract file contents drift after render", async () => {
    const writeContract = vi.fn(async () => ({ contract: buildContract(), sha256: "abc123" }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          runCommand,
          writeContract,
          readFrozenContract: async () => ({
            contract: buildContract(),
            sha256: "drifted-sha256",
          }),
        }),
      ),
    ).rejects.toThrow(/contract file contents must remain frozen through final A-04 pre-approval/);

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

  it("runs A-04 phases in spec order: read-only inspection, main verification, freshness, contract render, focused regressions, final gate", async () => {
    const steps: string[] = [];

    await prepareA04(
      buildOptions(),
      buildDeps({
        inspectReadOnlyInspection: async () => {
          steps.push("readOnlyInspection");
          return buildReadOnlyInspection();
        },
        createMainVerificationCheckout: async () => {
          steps.push("createCheckout");
          return {
            path: "/tmp/a04-main-checkout",
            head: "verified-main-head",
            cleanup: async () => {
              steps.push("cleanupCheckout");
            },
          };
        },
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
        readFrozenContract: async () => {
          steps.push("readContract");
          return {
            contract: buildContract(),
            sha256: "abc123",
          };
        },
      }),
    );

    expect(steps).toEqual([
      "readOnlyInspection",
      "createCheckout",
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
      "readContract",
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
      workingDirectory: "/tmp/a04-main-checkout",
      verifiedCheckout: {
        path: "/tmp/a04-main-checkout",
        head: "verified-main-head",
        runScenarioScriptPath: "/tmp/a04-main-checkout/validation/v1/scripts/run-scenario.ts",
        adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
      },
      readOnlyInspection: buildReadOnlyInspection(),
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
      exactCommand: ["npx", "--no-install", "tsx", "/tmp/a04-main-checkout/validation/v1/scripts/run-scenario.ts"],
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
