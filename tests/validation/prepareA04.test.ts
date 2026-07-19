import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  A04_APPROVED_EXECUTION_POLICY,
  buildA04RunCommand,
  materializeVerifiedCheckoutDependencies,
  buildApprovalPackage,
  inspectMetadataBackedA04History,
  type ReadOnlyInspection,
  prepareA04,
} from "../../validation/v1/lib/a04.js";
import { renderScenario } from "../../validation/v1/lib/scenarios.js";

const execFileAsync = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Claude",
  GIT_AUTHOR_EMAIL: "claude@example.com",
  GIT_COMMITTER_NAME: "Claude",
  GIT_COMMITTER_EMAIL: "claude@example.com",
};

type MetadataInspectionRepoDocs = {
  handoverDoc: string;
  a04BoundarySpec: string;
  a04BoundaryPlan: string;
  usageEvidenceSpec: string;
};

const BASE_METADATA_INSPECTION_REPO_DOCS: MetadataInspectionRepoDocs = {
  handoverDoc: [
    "No successful real-Claude Scenario A exists yet.",
    "Task 5 A-01: INCONCLUSIVE — harness failed before controller launch",
    "Task 5 A-02: INCONCLUSIVE — planning exhausted the 50k token budget",
    "Task 5 A-03: INCONCLUSIVE — execution completed but 100k exhausted before verify",
    "Historical verdict: `INCONCLUSIVE / RUNTIME_VARIANCE`",
    "These are **not** preserved real-run evidence.",
    "Every real call requires separate approval.",
  ].join("\n"),
  a04BoundarySpec: [
    "Prepare one fresh A-04 Scenario A invocation",
    "This design governs branch assessment and branch-local tightening only. It does not authorize a paid Scenario A invocation.",
  ].join("\n"),
  a04BoundaryPlan: "This branch assessment remains non-paid and non-destructive.\n",
  usageEvidenceSpec: [
    "Historical A-01 through A-03 artifacts remain immutable",
    "The invocation remains unapproved and unrun until separately presented to the user.",
  ].join("\n"),
};

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: TEST_GIT_ENV,
  });
  return stdout.trim();
}

async function writeTextFile(filePath: string, body: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
}

async function createMetadataInspectionRepo(
  overrides: Partial<MetadataInspectionRepoDocs> = {},
): Promise<{ tempRoot: string; repoRoot: string; trackedFilePath: string }> {
  const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-a04-metadata-inspection-"));
  const repoRoot = join(tempRoot, "repo");
  const docs = { ...BASE_METADATA_INSPECTION_REPO_DOCS, ...overrides };

  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch=main", repoRoot], { env: TEST_GIT_ENV });

  await writeTextFile(join(repoRoot, "docs", "handover", "ccloop-handover.md"), docs.handoverDoc);
  await writeTextFile(
    join(repoRoot, "docs", "superpowers", "specs", "2026-07-18-a04-preflight-and-stop-boundaries-design.md"),
    docs.a04BoundarySpec,
  );
  await writeTextFile(
    join(repoRoot, "docs", "superpowers", "plans", "2026-07-18-a04-preflight-and-approval.md"),
    docs.a04BoundaryPlan,
  );
  await writeTextFile(
    join(repoRoot, "docs", "superpowers", "specs", "2026-07-18-claude-usage-evidence-design.md"),
    docs.usageEvidenceSpec,
  );

  const trackedFilePath = join(repoRoot, "tracked.txt");
  await writeFile(trackedFilePath, "seed\n");
  await runGit(repoRoot, ["add", "tracked.txt", "docs"]);
  await runGit(repoRoot, ["commit", "-m", "seed metadata"]);
  await runGit(repoRoot, ["branch", "backup/evidence-first-v1-before-memory-history-cleanup"]);

  await writeFile(trackedFilePath, "main advanced\n");
  await runGit(repoRoot, ["add", "tracked.txt"]);
  await runGit(repoRoot, ["commit", "-m", "advance main"]);

  return { tempRoot, repoRoot, trackedFilePath };
}

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


function buildReadOnlyInspection(): ReadOnlyInspection {
  return {
    mainCheckout: {
      status: "PRESENT",
      path: "/repo",
      head: "main-head",
      branch: "main",
    },
    requiredSources: {
      handoverDoc: {
        status: "PRESENT",
        path: "/repo/docs/handover/ccloop-handover.md",
      },
      a04BoundarySpec: {
        status: "PRESENT",
        path: "/repo/docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md",
      },
      a04BoundaryPlan: {
        status: "PRESENT",
        path: "/repo/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md",
      },
      usageEvidenceSpec: {
        status: "PRESENT",
        path: "/repo/docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md",
      },
      backupBranch: {
        status: "PRESENT",
        name: "backup/evidence-first-v1-before-memory-history-cleanup",
        head: "backup-head",
        mergeBaseWithMain: "merge-base",
        distinctFromMain: true,
      },
    },
    softSignals: {
      retainedStashes: {
        status: "MISSING",
        matches: [],
      },
      legacyEvidenceWorktree: {
        status: "MISSING",
        path: "/repo/.worktrees/evidence-first-v1",
      },
      legacyPreservedEvidenceTree: {
        status: "MISSING",
        path: "/repo/.worktrees/evidence-first-v1/.validation-runs",
      },
    },
    contradictionChecks: {
      firstRealPaidScenarioA: {
        status: "CONFIRMED",
        sources: ["handoverDoc", "a04BoundarySpec"],
      },
      historicalA01ToA03Diagnoses: {
        status: "CONFIRMED",
        sources: ["handoverDoc", "usageEvidenceSpec"],
      },
      localDryRunArtifactsNotHistoricalEvidence: {
        status: "CONFIRMED",
        sources: ["handoverDoc", "a04BoundaryPlan"],
      },
      paidCallStillRequiresExplicitApproval: {
        status: "CONFIRMED",
        sources: ["handoverDoc", "a04BoundarySpec", "usageEvidenceSpec"],
      },
    },
  };
}

function buildDeps(input: {
  pathExists?: (path: string) => Promise<boolean>;
  assertCleanFixture?: (fixturePath: string) => Promise<{ head: string; status: string }>;
  readCurrentBranch?: (repoRoot: string) => Promise<string>;
  readMainCheckoutState?: (repoRoot: string) => Promise<{ head: string; status: string }>;
  readMainCheckoutFingerprint?: (repoRoot: string, allowedMutablePaths: string[]) => Promise<string>;
  resolveRealPath?: (path: string) => Promise<string>;
  inspectReadOnlyInspection?: (repoRoot: string) => Promise<ReadOnlyInspection>;
  createMainVerificationCheckout?: (repoRoot: string) => Promise<{ path: string; head: string; cleanup: () => Promise<void> }>;
  runCommand?: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  writeContract?: (options: {
    fixturePath: string;
    contractPath: string;
    executionPolicyOverrides: typeof A04_APPROVED_EXECUTION_POLICY;
  }) => Promise<{ contract: ReturnType<typeof renderScenario>; sha256: string }>;
  readFrozenContract?: (contractPath: string) => Promise<{ contract: ReturnType<typeof renderScenario>; sha256: string }>;
  writeVerifiedContract?: (sourceContractPath: string, verifiedContractPath: string) => Promise<void>;
} = {}) {
  return {
    pathExists:
      input.pathExists ??
      (async (path) =>
        path === "/repo/examples/v1/claude-adapter-config.json" ||
        path === "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json"),
    assertCleanFixture: input.assertCleanFixture ?? (async () => ({ head: "fixture-head", status: "" })),
    readCurrentBranch: input.readCurrentBranch ?? (async () => "main"),
    readMainCheckoutState: input.readMainCheckoutState ?? (async () => ({ head: "main-head", status: "" })),
    readMainCheckoutFingerprint: input.readMainCheckoutFingerprint ?? (async () => "main-fingerprint"),
    resolveRealPath: input.resolveRealPath ?? (async (path) => path),
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
    writeVerifiedContract: input.writeVerifiedContract ?? (async () => {}),
  };
}

describe("inspectMetadataBackedA04History", () => {
  it("uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval", async () => {
    const { repoRoot } = await createMetadataInspectionRepo();

    const result = await inspectMetadataBackedA04History(repoRoot);

    expect(result.contradictionChecks.historicalA01ToA03Diagnoses).toEqual({
      status: "CONFIRMED",
      sources: ["handoverDoc", "usageEvidenceSpec"],
    });
    expect(result.contradictionChecks.paidCallStillRequiresExplicitApproval).toEqual({
      status: "CONFIRMED",
      sources: ["handoverDoc", "a04BoundarySpec", "usageEvidenceSpec"],
    });
  });

  it("marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts", async () => {
    const { repoRoot } = await createMetadataInspectionRepo({
      handoverDoc: BASE_METADATA_INSPECTION_REPO_DOCS.handoverDoc.replace(
        "Task 5 A-02: INCONCLUSIVE — planning exhausted the 50k token budget",
        "Task 5 A-02: PASS — planning exhausted the 50k token budget",
      ),
    });

    const result = await inspectMetadataBackedA04History(repoRoot);

    expect(result.contradictionChecks.historicalA01ToA03Diagnoses).toEqual({
      status: "CONTRADICTORY",
      sources: ["handoverDoc", "usageEvidenceSpec"],
    });
  });

  it("treats retained stashes as present only when a required retained stash matches", async () => {
    const { repoRoot, trackedFilePath } = await createMetadataInspectionRepo();

    await writeFile(trackedFilePath, "stashed change\n");
    await runGit(repoRoot, ["stash", "push", "-m", "unrelated stash"]);

    const result = await inspectMetadataBackedA04History(repoRoot);

    expect(result.softSignals.retainedStashes).toEqual({
      status: "MISSING",
      matches: [],
    });
  });

  it("reports the discovered legacy evidence worktree paths", async () => {
    const { repoRoot, tempRoot } = await createMetadataInspectionRepo();
    const legacyWorktreePath = join(tempRoot, "actual-evidence-first-v1");

    await runGit(repoRoot, ["branch", "evidence-first-v1"]);
    await runGit(repoRoot, ["worktree", "add", legacyWorktreePath, "evidence-first-v1"]);

    const canonicalLegacyWorktreePath = await realpath(legacyWorktreePath);
    await mkdir(join(canonicalLegacyWorktreePath, ".validation-runs"), { recursive: true });

    const result = await inspectMetadataBackedA04History(repoRoot);

    expect(result.softSignals.legacyEvidenceWorktree).toEqual({
      status: "PRESENT",
      path: canonicalLegacyWorktreePath,
    });
    expect(result.softSignals.legacyPreservedEvidenceTree).toEqual({
      status: "PRESENT",
      path: join(canonicalLegacyWorktreePath, ".validation-runs"),
    });
  });

  it("reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection", async () => {
    const { repoRoot, tempRoot } = await createMetadataInspectionRepo();
    const legacyWorktreePath = join(tempRoot, "actual-evidence-first-v1");

    await runGit(repoRoot, ["branch", "evidence-first-v1"]);
    await runGit(repoRoot, ["worktree", "add", legacyWorktreePath, "evidence-first-v1"]);

    const canonicalLegacyWorktreePath = await realpath(legacyWorktreePath);
    const legacyPreservedEvidenceTreePath = join(canonicalLegacyWorktreePath, ".validation-runs");
    await mkdir(legacyPreservedEvidenceTreePath, { recursive: true });

    const originalMode = (await lstat(canonicalLegacyWorktreePath)).mode & 0o777;
    await chmod(canonicalLegacyWorktreePath, 0o000);

    try {
      const result = await inspectMetadataBackedA04History(repoRoot);

      expect(result.softSignals.legacyPreservedEvidenceTree).toEqual({
        status: "UNREADABLE",
        path: legacyPreservedEvidenceTreePath,
      });
    } finally {
      await chmod(canonicalLegacyWorktreePath, originalMode);
    }
  });

  it("reports unreadable required metadata docs through the summary contract", async () => {
    const { repoRoot } = await createMetadataInspectionRepo();
    const unreadableUsageEvidenceSpecPath = join(
      repoRoot,
      "docs",
      "superpowers",
      "specs",
      "2026-07-18-claude-usage-evidence-design.md",
    );

    await rm(unreadableUsageEvidenceSpecPath, { recursive: true, force: true });
    await mkdir(unreadableUsageEvidenceSpecPath, { recursive: true });

    const result = await inspectMetadataBackedA04History(repoRoot);

    expect(result.requiredSources.usageEvidenceSpec).toEqual({
      status: "UNREADABLE",
      path: unreadableUsageEvidenceSpecPath,
    });
    expect(result.contradictionChecks.paidCallStillRequiresExplicitApproval.status).toBe("INSUFFICIENT");
  });

  it("keeps the backup branch present when merge-base reachability is unavailable", async () => {
    const { repoRoot } = await createMetadataInspectionRepo();

    await runGit(repoRoot, ["branch", "-D", "backup/evidence-first-v1-before-memory-history-cleanup"]);
    await runGit(repoRoot, ["checkout", "--orphan", "backup/evidence-first-v1-before-memory-history-cleanup"]);
    await runGit(repoRoot, ["commit", "--allow-empty", "-m", "orphan backup anchor"]);
    const orphanBackupHead = await runGit(repoRoot, ["rev-parse", "HEAD"]);
    await runGit(repoRoot, ["checkout", "main"]);

    const result = await inspectMetadataBackedA04History(repoRoot);

    expect(result.requiredSources.backupBranch).toEqual({
      status: "PRESENT",
      name: "backup/evidence-first-v1-before-memory-history-cleanup",
      head: orphanBackupHead,
      mergeBaseWithMain: undefined,
      distinctFromMain: true,
    });
  });
});

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
  it("builds an approval package with the metadata-backed inspection summary", () => {
    const pkg = buildApprovalPackage({
      verifiedCheckoutPath: "/tmp/a04-main-checkout",
      verifiedCheckoutHead: "verified-main-head",
      readOnlyInspection: buildReadOnlyInspection(),
      contract: buildContract(),
      contractPath: "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
      contractSha256: "abc123",
      fixturePath: "/repo/.validation-runs/fixture-01",
      runDir: "/repo/.validation-runs/runs/A-04",
      evidenceDir: "/repo/.validation-runs/evidence/A-04",
      adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
    });

    expect(pkg.readOnlyInspection.softSignals.legacyEvidenceWorktree.status).toBe("MISSING");
    expect(pkg.readOnlyInspection.requiredSources.usageEvidenceSpec.status).toBe("PRESENT");
    expect(pkg.readOnlyInspection.contradictionChecks.paidCallStillRequiresExplicitApproval.status).toBe("CONFIRMED");
  });

  it("builds a frozen approval package with explicit scenario, path, and artifact expectations", () => {
    const pkg = buildApprovalPackage({
      verifiedCheckoutPath: "/tmp/a04-main-checkout",
      verifiedCheckoutHead: "verified-main-head",
      readOnlyInspection: buildReadOnlyInspection(),
      contract: buildContract(),
      contractPath: "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
      contractSha256: "abc123",
      fixturePath: "/repo/.validation-runs/fixture-01",
      runDir: "/repo/.validation-runs/runs/A-04",
      evidenceDir: "/repo/.validation-runs/evidence/A-04",
      adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
    });

    expect(pkg.contractIdentity).toEqual({
      path: "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
      sha256: "abc123",
      schemaValid: true,
    });
    expect(pkg.verifiedCheckout).toEqual({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      runScenarioScriptPath: "/tmp/a04-main-checkout/validation/v1/scripts/run-scenario.ts",
      adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
      contractPath: "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
    });
    expect(pkg.readOnlyInspection).toEqual(buildReadOnlyInspection());
    expect(pkg.workingDirectory).toBe("/tmp/a04-main-checkout");
    expect(pkg.paths).toEqual({
      contractPath: "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
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
      "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
      "--fixture",
      "/repo/.validation-runs/fixture-01",
      "--run-dir",
      "/repo/.validation-runs/runs/A-04",
      "--evidence-dir",
      "/repo/.validation-runs/evidence/A-04",
      "--adapter-config",
      "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
    ]);
    expect(pkg.usageEvidenceExpectations).toEqual([
      "this approved invocation may consume budget across up to three Claude-backed phases: plan, execute, and verify",
      "each produced phase artifact is expected to carry standard usageEvidence fields, explicit alias selection, and normalizedTotal",
      "tokenUsage is expected exactly when usageEvidence.normalizedTotal is finite and positive, and then must equal normalizedTotal",
      "usage evidence improves auditability, but does not define success by itself",
      "tokenBudget is a controller stopping threshold derived from adapter-reported usage, not a guaranteed API-cost cap",
    ]);
    expect(pkg.invariants).toEqual({
      fixtureClean: true,
      mainCheckoutMustRemainUnchanged: true,
      maxClaudePhases: 3,
    });
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
        contractPath: "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
        contractSha256: "abc123",
        fixturePath: "/repo/.validation-runs/fixture-01",
        runDir: "/repo/.validation-runs/runs/A-04",
        evidenceDir: "/repo/.validation-runs/evidence/A-04",
        adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
      }),
    ).toThrow(/A-04 requires fixed one-shot contract execution policy/);
  });

  it.each([
    [
      "contract path",
      { contractPath: "/repo/.validation-runs/contracts/A-04.json" },
      "/repo/.validation-runs/contracts/A-04.json",
    ],
    [
      "contract path",
      { contractPath: "/repo/.validation-runs/contracts/A-04.dangling-link" },
      "/repo/.validation-runs/contracts/A-04.dangling-link",
    ],
    [
      "run directory",
      { runDir: "/repo/.validation-runs/runs/A-04" },
      "/repo/.validation-runs/runs/A-04",
    ],
    [
      "run directory",
      { runDir: "/repo/.validation-runs/runs/A-04.dangling-link" },
      "/repo/.validation-runs/runs/A-04.dangling-link",
    ],
    [
      "evidence directory",
      { evidenceDir: "/repo/.validation-runs/evidence/A-04" },
      "/repo/.validation-runs/evidence/A-04",
    ],
    [
      "evidence directory",
      { evidenceDir: "/repo/.validation-runs/evidence/A-04.dangling-link" },
      "/repo/.validation-runs/evidence/A-04.dangling-link",
    ],
  ])("refuses to prepare when %s already exists", async (label, pathOverrides, occupiedPath) => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const options = buildOptions({}, pathOverrides);

    await expect(
      prepareA04(
        options,
        buildDeps({
          pathExists: async (path) =>
            path === occupiedPath ||
            path === "/repo/examples/v1/claude-adapter-config.json" ||
            path === "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
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

  it("rejects a dangling symlink at contractPath as non-fresh", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions({}, { contractPath: "/repo/.validation-runs/contracts/A-04.dangling-link" }),
        buildDeps({
          pathExists: async (path) =>
            path === "/repo/.validation-runs/contracts/A-04.dangling-link" ||
            path === "/repo/examples/v1/claude-adapter-config.json" ||
            path === "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
          runCommand,
        }),
      ),
    ).rejects.toThrow("contract path already exists");

    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it("rejects a dangling symlink at runDir as non-fresh", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions({}, { runDir: "/repo/.validation-runs/runs/A-04.dangling-link" }),
        buildDeps({
          pathExists: async (path) =>
            path === "/repo/.validation-runs/runs/A-04.dangling-link" ||
            path === "/repo/examples/v1/claude-adapter-config.json" ||
            path === "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
          runCommand,
        }),
      ),
    ).rejects.toThrow("run directory already exists");

    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it("rejects a dangling symlink at evidenceDir as non-fresh", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions({}, { evidenceDir: "/repo/.validation-runs/evidence/A-04.dangling-link" }),
        buildDeps({
          pathExists: async (path) =>
            path === "/repo/.validation-runs/evidence/A-04.dangling-link" ||
            path === "/repo/examples/v1/claude-adapter-config.json" ||
            path === "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
          runCommand,
        }),
      ),
    ).rejects.toThrow("evidence directory already exists");

    expect(runCommand).toHaveBeenCalledTimes(3);
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

  it("rejects when the main checkout is already dirty before prepare starts", async () => {
    const createMainVerificationCheckout = vi.fn(async () => ({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      cleanup: async () => {},
    }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          readMainCheckoutState: async () => ({ head: "main-head", status: " M validation/v1/lib/a04.ts" }),
          createMainVerificationCheckout,
          runCommand,
        }),
      ),
    ).rejects.toThrow(/main checkout must be clean before preparing A-04/);

    expect(createMainVerificationCheckout).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects when the main checkout drifts during prepare", async () => {
    const writeContract = vi.fn(async () => ({ contract: buildContract(), sha256: "abc123" }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    let mainCheckoutReads = 0;

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          readMainCheckoutState: async () => {
            mainCheckoutReads += 1;
            if (mainCheckoutReads === 1) {
              return { head: "main-head", status: "" };
            }

            return { head: "main-head", status: "?? drifted-untracked.txt" };
          },
          readMainCheckoutFingerprint: async () => "main-fingerprint",
          runCommand,
          writeContract,
        }),
      ),
    ).rejects.toThrow(/main checkout must remain unchanged through final A-04 pre-approval/);

    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("rejects ignored-file drift in the main checkout even when git porcelain stays clean", async () => {
    const writeContract = vi.fn(async () => ({ contract: buildContract(), sha256: "abc123" }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const readMainCheckoutFingerprint = vi
      .fn<(_repoRoot: string, _allowedMutablePaths: string[]) => Promise<string>>()
      .mockResolvedValueOnce("baseline-fingerprint")
      .mockResolvedValueOnce("drifted-fingerprint");

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          readMainCheckoutState: async () => ({ head: "main-head", status: "" }),
          readMainCheckoutFingerprint,
          runCommand,
          writeContract,
        }),
      ),
    ).rejects.toThrow(/main checkout must remain unchanged through final A-04 pre-approval/);

    expect(readMainCheckoutFingerprint.mock.calls).toEqual([
      ["/repo", ["/repo/.validation-runs/contracts/A-04.json"]],
      ["/repo", ["/repo/.validation-runs/contracts/A-04.json"]],
    ]);
    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("rejects adapter configs outside repo root", async () => {
    const createMainVerificationCheckout = vi.fn(async () => ({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      cleanup: async () => {},
    }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions({}, { adapterConfigPath: "/tmp/adapter-config.json" }),
        buildDeps({
          createMainVerificationCheckout,
          runCommand,
        }),
      ),
    ).rejects.toThrow(/adapter config must live under repo root for A-04 approval/);

    expect(createMainVerificationCheckout).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects adapter configs that are symlinks escaping repo root", async () => {
    const createMainVerificationCheckout = vi.fn(async () => ({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      cleanup: async () => {},
    }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          createMainVerificationCheckout,
          runCommand,
          resolveRealPath: async (path) => {
            if (path === "/repo") {
              return "/repo";
            }
            if (path === "/repo/examples/v1/claude-adapter-config.json") {
              return "/outside/live-adapter-config.json";
            }
            return path;
          },
        }),
      ),
    ).rejects.toThrow(/adapter config must resolve inside repo root for A-04 approval/);

    expect(createMainVerificationCheckout).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects missing adapter configs before creating the verification checkout", async () => {
    const createMainVerificationCheckout = vi.fn(async () => ({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      cleanup: async () => {},
    }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          pathExists: async () => false,
          createMainVerificationCheckout,
          runCommand,
        }),
      ),
    ).rejects.toThrow(/adapter config must exist for A-04 approval/);

    expect(createMainVerificationCheckout).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects adapter configs that do not exist in the preserved verified checkout", async () => {
    const createMainVerificationCheckout = vi.fn(async () => ({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      cleanup: async () => {},
    }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          pathExists: async (path) => path === "/repo/examples/v1/claude-adapter-config.json",
          createMainVerificationCheckout,
          runCommand,
        }),
      ),
    ).rejects.toThrow(/adapter config inside the preserved verified checkout must exist for A-04 approval/);

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects verified-checkout adapter configs that are symlinks escaping the preserved checkout", async () => {
    const createMainVerificationCheckout = vi.fn(async () => ({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      cleanup: async () => {},
    }));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          createMainVerificationCheckout,
          runCommand,
          resolveRealPath: async (path) => {
            if (path === "/repo") {
              return "/repo";
            }
            if (path === "/repo/examples/v1/claude-adapter-config.json") {
              return "/repo/examples/v1/claude-adapter-config.json";
            }
            if (path === "/tmp/a04-main-checkout") {
              return "/tmp/a04-main-checkout";
            }
            if (path === "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json") {
              return "/outside/live-adapter-config.json";
            }
            return path;
          },
        }),
      ),
    ).rejects.toThrow(/adapter config inside the preserved verified checkout must resolve inside the preserved verified checkout for A-04 approval/);

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


  it("propagates inspection failure before creating the verification checkout", async () => {
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
            throw new Error("inspection exploded before checkout");
          },
          createMainVerificationCheckout,
        }),
      ),
    ).rejects.toThrow(/inspection exploded before checkout/);

    expect(createMainVerificationCheckout).not.toHaveBeenCalled();
  });

  it("does not fail when retained stashes are missing because they are a soft signal", async () => {
    const result = await prepareA04(
      buildOptions(),
      buildDeps({
        inspectReadOnlyInspection: async () => ({
          ...buildReadOnlyInspection(),
          softSignals: {
            retainedStashes: {
              status: "MISSING",
              matches: [],
            },
            legacyEvidenceWorktree: {
              status: "PRESENT",
              path: "/repo/.worktrees/evidence-first-v1",
            },
            legacyPreservedEvidenceTree: {
              status: "PRESENT",
              path: "/repo/.worktrees/evidence-first-v1/.validation-runs",
            },
          },
        }),
      }),
    );

    expect(result.approvalPackage.readOnlyInspection.softSignals.retainedStashes.status).toBe("MISSING");
  });

  it("does not fail when the legacy preserved evidence tree is unreadable because it is a soft signal", async () => {
    const result = await prepareA04(
      buildOptions(),
      buildDeps({
        inspectReadOnlyInspection: async () => ({
          ...buildReadOnlyInspection(),
          softSignals: {
            retainedStashes: {
              status: "PRESENT",
              matches: ["On main: pre-local-merge-evidence-first-v1-2026-07-18"],
            },
            legacyEvidenceWorktree: {
              status: "PRESENT",
              path: "/repo/.worktrees/evidence-first-v1",
            },
            legacyPreservedEvidenceTree: {
              status: "UNREADABLE",
              path: "/repo/.worktrees/evidence-first-v1/.validation-runs",
            },
          },
        }),
      }),
    );

    expect(result.approvalPackage.readOnlyInspection.softSignals.legacyPreservedEvidenceTree.status).toBe("UNREADABLE");
  });

  it("fails when the usage-evidence spec is missing", async () => {
    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          inspectReadOnlyInspection: async () => ({
            ...buildReadOnlyInspection(),
            requiredSources: {
              ...buildReadOnlyInspection().requiredSources,
              usageEvidenceSpec: {
                status: "MISSING",
                path: "/repo/docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md",
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow(/usage-evidence spec/i);
  });

  it("fails when contradiction checks are insufficient", async () => {
    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          inspectReadOnlyInspection: async () => ({
            ...buildReadOnlyInspection(),
            contradictionChecks: {
              ...buildReadOnlyInspection().contradictionChecks,
              firstRealPaidScenarioA: {
                status: "INSUFFICIENT",
                sources: ["handoverDoc"],
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow(/first real paid scenario a/i);
  });

  it("fails when the backup branch is not a distinct history anchor", async () => {
    await expect(
      prepareA04(
        buildOptions(),
        buildDeps({
          inspectReadOnlyInspection: async () => ({
            ...buildReadOnlyInspection(),
            requiredSources: {
              ...buildReadOnlyInspection().requiredSources,
              backupBranch: {
                status: "PRESENT",
                name: "backup/evidence-first-v1-before-memory-history-cleanup",
                head: "main-head",
                mergeBaseWithMain: "main-head",
                distinctFromMain: false,
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow(/backup branch/i);
  });

  it("preserves the isolated verified checkout so approval stays bound to the verified runnable revision", async () => {
    const cleanup = vi.fn(async () => {});
    const createMainVerificationCheckout = vi.fn(async () => ({
      path: "/tmp/a04-main-checkout",
      head: "verified-main-head",
      cleanup,
    }));
    const runCommand = vi.fn(async (..._args: [string, string[], string]) => ({ stdout: "", stderr: "" }));
    const writeVerifiedContract = vi.fn(async () => {});

    const result = await prepareA04(
      buildOptions(),
      buildDeps({
        createMainVerificationCheckout,
        runCommand,
        writeVerifiedContract,
      }),
    );

    expect(createMainVerificationCheckout).toHaveBeenCalledWith("/repo");
    expect(result.approvalPackage.verifiedCheckout.adapterConfigPath).toBe(
      "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
    );
    expect(result.approvalPackage.verifiedCheckout.contractPath).toBe(
      "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
    );
    expect(writeVerifiedContract).toHaveBeenCalledWith(
      "/repo/.validation-runs/contracts/A-04.json",
      "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
    );
    expect(result.approvalPackage.exactCommand).toEqual([
      "npx",
      "--no-install",
      "tsx",
      "/tmp/a04-main-checkout/validation/v1/scripts/run-scenario.ts",
      "--scenario",
      "A",
      "--contract",
      "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
      "--fixture",
      "/repo/.validation-runs/fixture-01",
      "--run-dir",
      "/repo/.validation-runs/runs/A-04",
      "--evidence-dir",
      "/repo/.validation-runs/evidence/A-04",
      "--adapter-config",
      "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
    ]);
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
          return (
            path === "/repo/examples/v1/claude-adapter-config.json" ||
            path === "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json"
          );
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
        readFrozenContract: async (contractPath) => {
          steps.push(`readContract:${contractPath}`);
          return {
            contract: buildContract(),
            sha256: "abc123",
          };
        },
        writeVerifiedContract: async (sourceContractPath, verifiedContractPath) => {
          steps.push(`writeVerifiedContract:${sourceContractPath}->${verifiedContractPath}`);
        },
      }),
    );

    expect(steps).toEqual([
      "readOnlyInspection",
      "exists:/repo/examples/v1/claude-adapter-config.json",
      "createCheckout",
      "exists:/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
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
      "readContract:/repo/.validation-runs/contracts/A-04.json",
      "writeVerifiedContract:/repo/.validation-runs/contracts/A-04.json->/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
      "readContract:/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
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
        path: "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
        sha256: "abc123",
        schemaValid: true,
      },
      workingDirectory: "/tmp/a04-main-checkout",
      verifiedCheckout: {
        path: "/tmp/a04-main-checkout",
        head: "verified-main-head",
        runScenarioScriptPath: "/tmp/a04-main-checkout/validation/v1/scripts/run-scenario.ts",
        adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
        contractPath: "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
      },
      readOnlyInspection: buildReadOnlyInspection(),
      paths: {
        contractPath: "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
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
      exactCommand: [
        "npx",
        "--no-install",
        "tsx",
        "/tmp/a04-main-checkout/validation/v1/scripts/run-scenario.ts",
        "--scenario",
        "A",
        "--contract",
        "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
        "--fixture",
        "/repo/.validation-runs/fixture-01",
        "--run-dir",
        "/repo/.validation-runs/runs/A-04",
        "--evidence-dir",
        "/repo/.validation-runs/evidence/A-04",
        "--adapter-config",
        "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
      ],
      usageEvidenceExpectations: [
        "this approved invocation may consume budget across up to three Claude-backed phases: plan, execute, and verify",
        "each produced phase artifact is expected to carry standard usageEvidence fields, explicit alias selection, and normalizedTotal",
        "tokenUsage is expected exactly when usageEvidence.normalizedTotal is finite and positive, and then must equal normalizedTotal",
        "usage evidence improves auditability, but does not define success by itself",
        "tokenBudget is a controller stopping threshold derived from adapter-reported usage, not a guaranteed API-cost cap",
      ],
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
