import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loopContractSchema, type LoopContract } from "../../../src/contract/schema.js";
import { getScenario, renderScenario, type ExecutionPolicyOverrides, type ScenarioDefinition } from "./scenarios.js";

const execFileAsync = promisify(execFile);
const EXECUTION_POLICY_FIELDS = [
  "tokenBudget",
  "perAttemptTimeoutMs",
  "totalRuntimeBudgetMs",
  "partialOutcomeRecoveryWindowMs",
] as const;
const A04_EXECUTION_POLICY_DESCRIPTION =
  "tokenBudget=550000, perAttemptTimeoutMs=600000, totalRuntimeBudgetMs=1200000, partialOutcomeRecoveryWindowMs=5000";
const A04_ONE_SHOT_CONTRACT_DESCRIPTION =
  "autonomyLevel=L2, maxAttempts=1, worktreeRequired=true, tokenBudget=550000, perAttemptTimeoutMs=600000, totalRuntimeBudgetMs=1200000, partialOutcomeRecoveryWindowMs=5000";
const A04_CLAUDE_PHASES = ["plan", "execute", "verify"] as const;
const A04_RUN_ARTIFACTS = [
  "loop-contract.json",
  "loop-state.json",
  "events.jsonl",
  "attempts/1/plan.json",
  "attempts/1/execution.json",
  "attempts/1/verify.json",
  "attempts/1/diff.patch",
  "attempts/1/stdout-stderr.log",
] as const;
const A04_EVIDENCE_ARTIFACTS = ["artifacts.json", "observations.json"] as const;
const A04_RETAINED_BACKUP_BRANCH = "backup/evidence-first-v1-before-memory-history-cleanup";
const A04_REQUIRED_RETAINED_STASH_LINES = [
  "On main: pre-local-merge-evidence-first-v1-2026-07-18",
  "On main: pre-merge local changes 2026-07-16",
] as const;
const A04_REQUIRED_PRESERVED_EVIDENCE_PATHS = [
  "fixture-01",
  "contracts/A-01.json",
  "contracts/A-02.json",
  "contracts/A-03.json",
  "evidence/A-01/review.json",
  "evidence/A-02/review.json",
  "evidence/A-03/review.json",
] as const;
const A04_RUN_SCENARIO_SCRIPT = "validation/v1/scripts/run-scenario.ts";

export const A04_APPROVED_EXECUTION_POLICY: Readonly<Required<ExecutionPolicyOverrides>> = Object.freeze({
  tokenBudget: 550000,
  perAttemptTimeoutMs: 600000,
  totalRuntimeBudgetMs: 1200000,
  partialOutcomeRecoveryWindowMs: 5000,
});

type RepoState = {
  head: string;
  status: string;
};

type MainCheckoutState = RepoState & {
  fingerprint: string;
};

type FrozenContract = {
  contract: LoopContract;
  sha256: string;
};

type IsolatedVerificationCheckout = {
  path: string;
  head: string;
  cleanup: () => Promise<void>;
};

export type RequiredSourceStatus = "PRESENT" | "MISSING" | "UNREADABLE";
export type SoftSignalStatus = "PRESENT" | "MISSING" | "UNREADABLE";
export type ContradictionStatus = "CONFIRMED" | "CONTRADICTORY" | "INSUFFICIENT";

export type MetadataInspectionSummary = {
  mainCheckout: {
    status: "PRESENT";
    path: string;
    head: string;
    branch: "main";
  };
  requiredSources: {
    handoverDoc: { status: RequiredSourceStatus; path: string };
    a04BoundarySpec: { status: RequiredSourceStatus; path: string };
    a04BoundaryPlan: { status: RequiredSourceStatus; path: string };
    usageEvidenceSpec: { status: RequiredSourceStatus; path: string };
    backupBranch: {
      status: RequiredSourceStatus;
      name: typeof A04_RETAINED_BACKUP_BRANCH;
      head?: string;
      mergeBaseWithMain?: string;
      distinctFromMain?: boolean;
    };
  };
  softSignals: {
    retainedStashes: { status: SoftSignalStatus; matches: string[] };
    legacyEvidenceWorktree: { status: SoftSignalStatus; path: string };
    legacyPreservedEvidenceTree: { status: SoftSignalStatus; path: string };
  };
  contradictionChecks: {
    firstRealPaidScenarioA: { status: ContradictionStatus; sources: string[] };
    historicalA01ToA03Diagnoses: { status: ContradictionStatus; sources: string[] };
    localDryRunArtifactsNotHistoricalEvidence: { status: ContradictionStatus; sources: string[] };
    paidCallStillRequiresExplicitApproval: { status: ContradictionStatus; sources: string[] };
  };
};

export type ReadOnlyInspection = MetadataInspectionSummary;

export type A04PrepareOptions = {
  repoRoot: string;
  fixturePath: string;
  contractPath: string;
  runDir: string;
  evidenceDir: string;
  adapterConfigPath: string;
  executionPolicyOverrides: Required<ExecutionPolicyOverrides>;
};

export type ApprovalPackage = {
  contractIdentity: { path: string; sha256: string; schemaValid: true };
  verifiedCheckout: {
    path: string;
    head: string;
    runScenarioScriptPath: string;
    adapterConfigPath: string;
    contractPath: string;
  };
  readOnlyInspection: ReadOnlyInspection;
  workingDirectory: string;
  paths: {
    contractPath: string;
    fixturePath: string;
    runDir: string;
    evidenceDir: string;
  };
  scenario: "A";
  attempts: 1;
  automaticRetries: "none";
  claudePhases: typeof A04_CLAUDE_PHASES;
  executionPolicy: Required<ExecutionPolicyOverrides>;
  expectedFileScope: string[];
  expectedDiffScope: string[];
  expectedArtifacts: {
    runDir: string[];
    evidenceDir: string[];
  };
  expectedReviewOutputs: {
    verifierType: LoopContract["verification"]["verifierType"];
    requiredChecks: string[];
    expectedEvidenceArtifactStatuses: ScenarioDefinition["expectedArtifacts"];
  };
  exactCommand: string[];
  usageEvidenceExpectations: string[];
  invariants: {
    fixtureClean: true;
    mainCheckoutMustRemainUnchanged: true;
    maxClaudePhases: 3;
  };
};

export type PrepareDeps = {
  pathExists: (path: string) => Promise<boolean>;
  assertCleanFixture: (fixturePath: string) => Promise<{ head: string; status: string }>;
  readCurrentBranch: (repoRoot: string) => Promise<string>;
  readMainCheckoutState: (repoRoot: string) => Promise<RepoState>;
  readMainCheckoutFingerprint: (repoRoot: string, allowedMutablePaths: string[]) => Promise<string>;
  resolveRealPath: (path: string) => Promise<string>;
  inspectReadOnlyInspection: (repoRoot: string) => Promise<ReadOnlyInspection>;
  createMainVerificationCheckout: (repoRoot: string) => Promise<IsolatedVerificationCheckout>;
  runCommand: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  writeContract: (options: Pick<A04PrepareOptions, "fixturePath" | "contractPath" | "executionPolicyOverrides">) => Promise<FrozenContract>;
  readFrozenContract: (contractPath: string) => Promise<FrozenContract>;
  writeVerifiedContract: (sourceContractPath: string, verifiedContractPath: string) => Promise<void>;
};

const MAIN_DETERMINISTIC_VERIFICATION_COMMANDS: ReadonlyArray<readonly [string, string[]]> = [
  ["npm", ["test"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "build"]],
] as const;

const FOCUSED_EVIDENCE_CHAIN_REGRESSION_COMMANDS: ReadonlyArray<readonly [string, string[]]> = [
  ["npm", ["test", "--", "--run", "tests/validation/contracts.test.ts"]],
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
  ],
] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function gitOutput(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function defaultAssertCleanFixture(fixturePath: string): Promise<{ head: string; status: string }> {
  const head = await gitOutput(fixturePath, ["rev-parse", "HEAD"]);
  const status = await gitOutput(fixturePath, ["status", "--porcelain"]);

  if (status !== "") {
    throw new Error("fixture must be clean before preparing A-04");
  }

  return { head, status };
}

async function defaultReadCurrentBranch(repoRoot: string): Promise<string> {
  return gitOutput(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

async function defaultReadMainCheckoutState(repoRoot: string): Promise<RepoState> {
  const [head, status] = await Promise.all([
    gitOutput(repoRoot, ["rev-parse", "HEAD"]),
    gitOutput(repoRoot, ["status", "--porcelain"]),
  ]);

  return { head, status };
}

async function defaultResolveRealPath(path: string): Promise<string> {
  return realpath(path);
}

function shouldExcludeMainCheckoutPath(candidatePath: string, excludedPaths: readonly string[]): boolean {
  return excludedPaths.some((excludedPath) => isSameOrDescendantPath(candidatePath, excludedPath));
}

async function expandAllowedMutableMainCheckoutPaths(
  repoRoot: string,
  allowedMutablePaths: readonly string[],
): Promise<string[]> {
  const expandedPaths = new Set<string>();

  for (const allowedMutablePath of allowedMutablePaths) {
    let currentPath = resolve(allowedMutablePath);
    if (!isSameOrDescendantPath(currentPath, repoRoot)) {
      continue;
    }

    expandedPaths.add(currentPath);

    while (currentPath !== repoRoot) {
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath || !isSameOrDescendantPath(parentPath, repoRoot)) {
        break;
      }
      if (await pathExists(parentPath)) {
        break;
      }

      expandedPaths.add(parentPath);
      currentPath = parentPath;
    }
  }

  return [...expandedPaths].sort();
}

async function appendMainCheckoutSnapshotEntries(
  snapshotEntries: string[],
  repoRoot: string,
  currentPath: string,
  excludedPaths: readonly string[],
): Promise<void> {
  const relativePath = currentPath === repoRoot ? "." : relative(repoRoot, currentPath);
  const stats = await lstat(currentPath);

  if (stats.isSymbolicLink()) {
    snapshotEntries.push(`symlink	${relativePath}	${stats.mode.toString(8)}	${await readlink(currentPath)}`);
    return;
  }

  if (stats.isDirectory()) {
    snapshotEntries.push(`dir	${relativePath}`);

    for (const entry of (await readdir(currentPath)).sort()) {
      if (relativePath === "." && entry === ".git") {
        continue;
      }

      const childPath = resolve(currentPath, entry);
      if (shouldExcludeMainCheckoutPath(childPath, excludedPaths)) {
        continue;
      }

      await appendMainCheckoutSnapshotEntries(snapshotEntries, repoRoot, childPath, excludedPaths);
    }

    return;
  }

  if (stats.isFile()) {
    const body = await readFile(currentPath);
    snapshotEntries.push(
      `file\t${relativePath}\t${stats.mode.toString(8)}\t${body.byteLength}\t${createHash("sha256").update(body).digest("hex")}`,
    );
    return;
  }

  snapshotEntries.push(`other\t${relativePath}\t${stats.mode.toString(8)}\t${stats.size}`);
}

async function defaultReadMainCheckoutFingerprint(
  repoRoot: string,
  allowedMutablePaths: string[],
): Promise<string> {
  const resolvedRepoRoot = resolve(repoRoot);
  const excludedPaths = await expandAllowedMutableMainCheckoutPaths(resolvedRepoRoot, allowedMutablePaths);
  const snapshotEntries: string[] = [];
  await appendMainCheckoutSnapshotEntries(snapshotEntries, resolvedRepoRoot, resolvedRepoRoot, excludedPaths);
  return createHash("sha256").update(snapshotEntries.join("\n")).digest("hex");
}

type GitWorktreeEntry = {
  path: string;
  head: string;
  branch?: string;
};

function parseGitWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: Partial<GitWorktreeEntry> = {};

  const flush = () => {
    if (current.path && current.head) {
      entries.push({
        path: current.path,
        head: current.head,
        branch: current.branch,
      });
    }

    current = {};
  };

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();

    if (line === "") {
      flush();
      continue;
    }

    const separatorIndex = line.indexOf(" ");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);

    if (key === "worktree") {
      current.path = value;
    } else if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branch = value;
    }
  }

  flush();
  return entries;
}

async function assertReadablePath(path: string, label: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} is missing for A-04 read-only inspection`);
    }

    throw new Error(`${label} must remain readable for A-04 read-only inspection`);
  }
}

async function defaultInspectReadOnlyInspection(repoRoot: string): Promise<ReadOnlyInspection> {
  const worktrees = parseGitWorktreeList(await gitOutput(repoRoot, ["worktree", "list", "--porcelain"]));
  const mainCheckout = worktrees.find((entry) => entry.branch === "refs/heads/main");
  if (!mainCheckout) {
    throw new Error("A-04 read-only inspection requires the main checkout worktree");
  }

  const evidenceFirstValidationWorktree = worktrees.find((entry) => entry.branch === "refs/heads/evidence-first-v1");
  if (!evidenceFirstValidationWorktree) {
    throw new Error("A-04 read-only inspection requires the retained evidence-first-v1 worktree");
  }

  await assertReadablePath(mainCheckout.path, "main checkout");
  await assertReadablePath(evidenceFirstValidationWorktree.path, "evidence-first-v1 worktree");

  let backupBranchHead: string;
  try {
    backupBranchHead = await gitOutput(repoRoot, ["rev-parse", "--verify", `refs/heads/${A04_RETAINED_BACKUP_BRANCH}`]);
  } catch {
    throw new Error(`A-04 read-only inspection requires retained backup branch ${A04_RETAINED_BACKUP_BRANCH}`);
  }

  const stashLinesOutput = await gitOutput(repoRoot, ["stash", "list"]);
  const stashLines = stashLinesOutput === "" ? [] : stashLinesOutput.split("\n").map((line) => line.trim()).filter(Boolean);
  const retainedStashes = A04_REQUIRED_RETAINED_STASH_LINES.map((requiredLine) => {
    const match = stashLines.find((line) => line.includes(requiredLine));
    if (!match) {
      throw new Error(`A-04 read-only inspection requires retained stash matching: ${requiredLine}`);
    }

    return match;
  });

  const preservedEvidenceTreePath = resolve(evidenceFirstValidationWorktree.path, ".validation-runs");
  await assertReadablePath(preservedEvidenceTreePath, "preserved .validation-runs evidence tree");
  const requiredPaths = [];

  for (const relativePath of A04_REQUIRED_PRESERVED_EVIDENCE_PATHS) {
    const absolutePath = resolve(preservedEvidenceTreePath, relativePath);
    await assertReadablePath(absolutePath, `preserved evidence path ${relativePath}`);
    requiredPaths.push(absolutePath);
  }

  const legacyInspection = {
    mainCheckout: {
      path: mainCheckout.path,
      head: mainCheckout.head,
      branch: "main",
    },
    evidenceFirstValidationWorktree: {
      path: evidenceFirstValidationWorktree.path,
      head: evidenceFirstValidationWorktree.head,
      branch: "evidence-first-v1",
    },
    retainedBackupBranch: {
      name: A04_RETAINED_BACKUP_BRANCH,
      head: backupBranchHead,
    },
    retainedStashes,
    preservedEvidenceTree: {
      path: preservedEvidenceTreePath,
      requiredPaths,
    },
  };

  return legacyInspection as unknown as ReadOnlyInspection;
}

export async function materializeVerifiedCheckoutDependencies(repoRoot: string, worktreePath: string): Promise<void> {
  const sourceNodeModulesPath = resolve(repoRoot, "node_modules");
  if (!(await pathExists(sourceNodeModulesPath))) {
    return;
  }

  await cp(sourceNodeModulesPath, resolve(worktreePath, "node_modules"), {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true,
  });
}

async function defaultCreateMainVerificationCheckout(repoRoot: string): Promise<IsolatedVerificationCheckout> {
  const worktreePath = await mkdtemp(join(tmpdir(), "ccloop-a04-main-"));
  await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "--detach", worktreePath, "HEAD"], {
    maxBuffer: 10 * 1024 * 1024,
  });

  const cleanup = async () => {
    await execFileAsync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreePath], {
      maxBuffer: 10 * 1024 * 1024,
    });
  };

  try {
    await materializeVerifiedCheckoutDependencies(repoRoot, worktreePath);

    const head = await gitOutput(worktreePath, ["rev-parse", "HEAD"]);

    return {
      path: worktreePath,
      head,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function defaultRunCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function defaultWriteContract(options: Pick<A04PrepareOptions, "fixturePath" | "contractPath" | "executionPolicyOverrides">): Promise<FrozenContract> {
  const contract = loopContractSchema.parse(
    renderScenario("A", {
      repoPath: options.fixturePath,
      executionPolicyOverrides: options.executionPolicyOverrides,
    }),
  );
  contractExecutionPolicyToA04Overrides(contract);
  const contractPath = resolve(options.contractPath);
  await mkdir(dirname(contractPath), { recursive: true });
  const body = `${JSON.stringify(contract, null, 2)}
`;
  await writeFile(contractPath, body, { flag: "wx" });
  return {
    contract,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function defaultReadFrozenContract(contractPath: string): Promise<FrozenContract> {
  let body: Buffer;

  try {
    body = await readFile(resolve(contractPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw error;
    }

    throw new Error("contract file must remain readable through final A-04 pre-approval");
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error("contract file must remain schema-valid through final A-04 pre-approval");
  }

  return {
    contract: loopContractSchema.parse(rawJson),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

const defaultDeps: PrepareDeps = {
  pathExists,
  assertCleanFixture: defaultAssertCleanFixture,
  readCurrentBranch: defaultReadCurrentBranch,
  readMainCheckoutState: defaultReadMainCheckoutState,
  readMainCheckoutFingerprint: defaultReadMainCheckoutFingerprint,
  resolveRealPath: defaultResolveRealPath,
  inspectReadOnlyInspection: defaultInspectReadOnlyInspection,
  createMainVerificationCheckout: defaultCreateMainVerificationCheckout,
  runCommand: defaultRunCommand,
  writeContract: defaultWriteContract,
  readFrozenContract: defaultReadFrozenContract,
  writeVerifiedContract: async (sourceContractPath: string, verifiedContractPath: string) => {
    await mkdir(dirname(resolve(verifiedContractPath)), { recursive: true });
    await cp(resolve(sourceContractPath), resolve(verifiedContractPath), {
      force: false,
      errorOnExist: true,
    });
  },
};

export function validateA04ExecutionPolicy(
  executionPolicyOverrides: Required<ExecutionPolicyOverrides>,
): Required<ExecutionPolicyOverrides> {
  for (const field of EXECUTION_POLICY_FIELDS) {
    if (executionPolicyOverrides[field] !== A04_APPROVED_EXECUTION_POLICY[field]) {
      throw new Error(`A-04 requires fixed execution policy: ${A04_EXECUTION_POLICY_DESCRIPTION}`);
    }
  }

  return { ...A04_APPROVED_EXECUTION_POLICY };
}

function contractExecutionPolicyToA04Overrides(contract: LoopContract): Required<ExecutionPolicyOverrides> {
  if (
    contract.executionPolicy.autonomyLevel !== "L2" ||
    contract.executionPolicy.maxAttempts !== 1 ||
    contract.executionPolicy.worktreeRequired !== true
  ) {
    throw new Error(`A-04 requires fixed one-shot contract execution policy: ${A04_ONE_SHOT_CONTRACT_DESCRIPTION}`);
  }

  return validateA04ExecutionPolicy({
    tokenBudget: contract.executionPolicy.tokenBudget,
    perAttemptTimeoutMs: contract.executionPolicy.perAttemptTimeoutMs,
    totalRuntimeBudgetMs: contract.executionPolicy.totalRuntimeBudgetMs,
    partialOutcomeRecoveryWindowMs: contract.executionPolicy.partialOutcomeRecoveryWindowMs,
  });
}

function isSameOrDescendantPath(candidatePath: string, parentPath: string): boolean {
  const relation = relative(parentPath, candidatePath);
  return relation === "" || !relation.startsWith("..");
}

function resolvePrepareOptions(options: A04PrepareOptions): A04PrepareOptions {
  return {
    ...options,
    repoRoot: resolve(options.repoRoot),
    fixturePath: resolve(options.fixturePath),
    contractPath: resolve(options.contractPath),
    runDir: resolve(options.runDir),
    evidenceDir: resolve(options.evidenceDir),
    adapterConfigPath: resolve(options.adapterConfigPath),
  };
}

function assertPathUnderRepoRoot(repoRoot: string, path: string, label: string): void {
  if (!isSameOrDescendantPath(path, repoRoot)) {
    throw new Error(`${label} must live under repo root for A-04 approval`);
  }
}

function assertAdapterConfigUnderRepoRoot(repoRoot: string, adapterConfigPath: string): void {
  assertPathUnderRepoRoot(repoRoot, adapterConfigPath, "adapter config");
}

function assertContractPathUnderRepoRoot(repoRoot: string, contractPath: string): void {
  assertPathUnderRepoRoot(repoRoot, contractPath, "contract path");
}

function resolvePathForVerifiedCheckout(verifiedCheckoutPath: string, repoRoot: string, originalPath: string): string {
  assertPathUnderRepoRoot(repoRoot, originalPath, "path");
  return resolve(verifiedCheckoutPath, relative(repoRoot, originalPath));
}

async function assertAdapterConfigResolvesWithinRoot(
  deps: PrepareDeps,
  rootPath: string,
  adapterConfigPath: string,
  label: string,
  rootLabel: string,
): Promise<void> {
  if (!(await deps.pathExists(adapterConfigPath))) {
    throw new Error(`${label} must exist for A-04 approval`);
  }

  let realRootPath: string;
  let realAdapterConfigPath: string;
  try {
    [realRootPath, realAdapterConfigPath] = await Promise.all([
      deps.resolveRealPath(rootPath),
      deps.resolveRealPath(adapterConfigPath),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} must exist for A-04 approval`);
    }

    throw error;
  }

  if (!isSameOrDescendantPath(realAdapterConfigPath, realRootPath)) {
    throw new Error(`${label} must resolve inside ${rootLabel} for A-04 approval`);
  }
}

function assertNoContractMaterializationOverlap(
  options: Pick<A04PrepareOptions, "contractPath" | "runDir" | "evidenceDir">,
): void {
  for (const [path, label] of [
    [options.runDir, "run directory"],
    [options.evidenceDir, "evidence directory"],
  ] as const) {
    if (isSameOrDescendantPath(options.contractPath, path)) {
      throw new Error(`contract path must not be inside ${label}`);
    }
  }
}

export function buildA04RunCommand(input: {
  contractPath: string;
  fixturePath: string;
  runDir: string;
  evidenceDir: string;
  adapterConfigPath: string;
  runScenarioScriptPath?: string;
}): string[] {
  return [
    "npx",
    "--no-install",
    "tsx",
    input.runScenarioScriptPath ?? A04_RUN_SCENARIO_SCRIPT,
    "--scenario",
    "A",
    "--contract",
    input.contractPath,
    "--fixture",
    input.fixturePath,
    "--run-dir",
    input.runDir,
    "--evidence-dir",
    input.evidenceDir,
    "--adapter-config",
    input.adapterConfigPath,
  ];
}

export function buildApprovalPackage(input: {
  verifiedCheckoutPath: string;
  verifiedCheckoutHead: string;
  readOnlyInspection: ReadOnlyInspection;
  contract: LoopContract;
  contractPath: string;
  contractSha256: string;
  fixturePath: string;
  runDir: string;
  evidenceDir: string;
  adapterConfigPath: string;
}): ApprovalPackage {
  const scenario = getScenario("A");

  return {
    contractIdentity: {
      path: input.contractPath,
      sha256: input.contractSha256,
      schemaValid: true,
    },
    verifiedCheckout: {
      path: input.verifiedCheckoutPath,
      head: input.verifiedCheckoutHead,
      runScenarioScriptPath: resolve(input.verifiedCheckoutPath, A04_RUN_SCENARIO_SCRIPT),
      adapterConfigPath: input.adapterConfigPath,
      contractPath: input.contractPath,
    },
    readOnlyInspection: input.readOnlyInspection,
    workingDirectory: input.verifiedCheckoutPath,
    paths: {
      contractPath: input.contractPath,
      fixturePath: input.fixturePath,
      runDir: input.runDir,
      evidenceDir: input.evidenceDir,
    },
    scenario: "A",
    attempts: 1,
    automaticRetries: "none",
    claudePhases: A04_CLAUDE_PHASES,
    executionPolicy: contractExecutionPolicyToA04Overrides(input.contract),
    expectedFileScope: [...input.contract.context.targetPaths],
    expectedDiffScope: [...input.contract.safetyPolicy.allowlistPaths],
    expectedArtifacts: {
      runDir: [...A04_RUN_ARTIFACTS],
      evidenceDir: [...A04_EVIDENCE_ARTIFACTS],
    },
    expectedReviewOutputs: {
      verifierType: input.contract.verification.verifierType,
      requiredChecks: [...input.contract.verification.requiredChecks],
      expectedEvidenceArtifactStatuses: { ...scenario.expectedArtifacts },
    },
    exactCommand: buildA04RunCommand({
      contractPath: input.contractPath,
      fixturePath: input.fixturePath,
      runDir: input.runDir,
      evidenceDir: input.evidenceDir,
      adapterConfigPath: input.adapterConfigPath,
      runScenarioScriptPath: resolve(input.verifiedCheckoutPath, A04_RUN_SCENARIO_SCRIPT),
    }),
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
}

async function assertFreshPath(deps: PrepareDeps, path: string, label: string): Promise<void> {
  if (await deps.pathExists(path)) {
    throw new Error(`${label} already exists`);
  }
}

async function assertMainCheckout(deps: PrepareDeps, repoRoot: string): Promise<void> {
  const currentBranch = await deps.readCurrentBranch(repoRoot);

  if (currentBranch !== "main") {
    throw new Error(`A-04 preparation must run from branch main (current branch: ${currentBranch})`);
  }
}

async function assertCleanMainCheckoutBeforePrepare(
  deps: PrepareDeps,
  repoRoot: string,
  allowedMutablePaths: string[],
): Promise<MainCheckoutState> {
  const [mainCheckoutState, fingerprint] = await Promise.all([
    deps.readMainCheckoutState(repoRoot),
    deps.readMainCheckoutFingerprint(repoRoot, allowedMutablePaths),
  ]);

  if (mainCheckoutState.status !== "") {
    throw new Error("main checkout must be clean before preparing A-04");
  }

  return {
    ...mainCheckoutState,
    fingerprint,
  };
}

async function assertMainCheckoutUnchangedBeforeApproval(
  deps: PrepareDeps,
  repoRoot: string,
  beforePrepare: MainCheckoutState,
  allowedMutablePaths: string[],
): Promise<void> {
  const [mainCheckoutState, fingerprint] = await Promise.all([
    deps.readMainCheckoutState(repoRoot),
    deps.readMainCheckoutFingerprint(repoRoot, allowedMutablePaths),
  ]);

  if (
    mainCheckoutState.head !== beforePrepare.head ||
    mainCheckoutState.status !== beforePrepare.status ||
    fingerprint !== beforePrepare.fingerprint
  ) {
    throw new Error("main checkout must remain unchanged through final A-04 pre-approval");
  }
}

async function runCommandSet(
  deps: PrepareDeps,
  repoRoot: string,
  commandsToRun: ReadonlyArray<readonly [string, string[]]>,
): Promise<string[]> {
  const commands: string[] = [];

  for (const [command, args] of commandsToRun) {
    commands.push([command, ...args].join(" "));
    await deps.runCommand(command, [...args], repoRoot);
  }

  return commands;
}

async function runMainDeterministicVerification(deps: PrepareDeps, repoRoot: string): Promise<string[]> {
  return runCommandSet(deps, repoRoot, MAIN_DETERMINISTIC_VERIFICATION_COMMANDS);
}

async function runFocusedEvidenceChainRegressionSet(deps: PrepareDeps, repoRoot: string): Promise<string[]> {
  return runCommandSet(deps, repoRoot, FOCUSED_EVIDENCE_CHAIN_REGRESSION_COMMANDS);
}

async function assertA04FreshnessCheck(
  deps: PrepareDeps,
  options: Pick<A04PrepareOptions, "fixturePath" | "contractPath" | "runDir" | "evidenceDir">,
): Promise<RepoState> {
  const fixtureState = await deps.assertCleanFixture(options.fixturePath);
  await assertFreshPath(deps, options.contractPath, "contract path");
  await assertFreshPath(deps, options.runDir, "run directory");
  await assertFreshPath(deps, options.evidenceDir, "evidence directory");
  return fixtureState;
}

async function assertFixtureUnchangedBeforeApproval(
  deps: PrepareDeps,
  fixturePath: string,
  beforePreflight: RepoState,
): Promise<void> {
  let afterPreflight: RepoState;

  try {
    afterPreflight = await deps.assertCleanFixture(fixturePath);
  } catch {
    throw new Error("fixture must remain clean through final A-04 pre-approval");
  }

  if (afterPreflight.head !== beforePreflight.head || afterPreflight.status !== beforePreflight.status) {
    throw new Error("fixture must remain clean through final A-04 pre-approval");
  }
}

async function assertFrozenContractOnDiskAtFinalGate(
  deps: PrepareDeps,
  contractPath: string,
  expectedSha256: string,
): Promise<FrozenContract> {
  let frozenContract: FrozenContract;

  try {
    frozenContract = await deps.readFrozenContract(contractPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("contract file must still exist through final A-04 pre-approval");
    }

    throw error instanceof Error && error.message === "contract file must remain readable through final A-04 pre-approval"
      ? error
      : new Error("contract file must remain schema-valid through final A-04 pre-approval");
  }

  if (frozenContract.sha256 !== expectedSha256) {
    throw new Error("contract file contents must remain frozen through final A-04 pre-approval");
  }

  return frozenContract;
}

async function assertFinalPreApprovalGate(
  deps: PrepareDeps,
  options: Pick<A04PrepareOptions, "repoRoot" | "fixturePath" | "contractPath" | "runDir" | "evidenceDir">,
  beforePreflight: { fixture: RepoState; mainCheckout: MainCheckoutState },
  expectedSha256: string,
): Promise<FrozenContract> {
  await assertFixtureUnchangedBeforeApproval(deps, options.fixturePath, beforePreflight.fixture);
  await assertMainCheckoutUnchangedBeforeApproval(deps, options.repoRoot, beforePreflight.mainCheckout, [options.contractPath]);
  await assertFreshPath(deps, options.runDir, "run directory");
  await assertFreshPath(deps, options.evidenceDir, "evidence directory");
  return assertFrozenContractOnDiskAtFinalGate(deps, options.contractPath, expectedSha256);
}

export async function prepareA04(
  options: A04PrepareOptions,
  deps: PrepareDeps = defaultDeps,
): Promise<{ approvalPackage: ApprovalPackage; preflightCommands: string[] }> {
  const resolvedOptions = resolvePrepareOptions(options);
  const executionPolicyOverrides = validateA04ExecutionPolicy(resolvedOptions.executionPolicyOverrides);
  assertNoContractMaterializationOverlap(resolvedOptions);
  assertContractPathUnderRepoRoot(resolvedOptions.repoRoot, resolvedOptions.contractPath);
  await assertMainCheckout(deps, resolvedOptions.repoRoot);
  const mainCheckoutStateBeforePrepare = await assertCleanMainCheckoutBeforePrepare(
    deps,
    resolvedOptions.repoRoot,
    [resolvedOptions.contractPath],
  );
  const readOnlyInspection = await deps.inspectReadOnlyInspection(resolvedOptions.repoRoot);
  assertAdapterConfigUnderRepoRoot(resolvedOptions.repoRoot, resolvedOptions.adapterConfigPath);
  await assertAdapterConfigResolvesWithinRoot(
    deps,
    resolvedOptions.repoRoot,
    resolvedOptions.adapterConfigPath,
    "adapter config",
    "repo root",
  );

  const verificationCheckout = await deps.createMainVerificationCheckout(resolvedOptions.repoRoot);
  const verifiedAdapterConfigPath = resolvePathForVerifiedCheckout(
    verificationCheckout.path,
    resolvedOptions.repoRoot,
    resolvedOptions.adapterConfigPath,
  );
  const verifiedContractPath = resolvePathForVerifiedCheckout(
    verificationCheckout.path,
    resolvedOptions.repoRoot,
    resolvedOptions.contractPath,
  );
  await assertAdapterConfigResolvesWithinRoot(
    deps,
    verificationCheckout.path,
    verifiedAdapterConfigPath,
    "adapter config inside the preserved verified checkout",
    "the preserved verified checkout",
  );
  let preserveVerificationCheckout = false;

  try {
    const preflightCommands = await runMainDeterministicVerification(deps, verificationCheckout.path);
    const fixtureStateBeforeContractRender = await assertA04FreshnessCheck(deps, resolvedOptions);

    const { sha256 } = await deps.writeContract({
      fixturePath: resolvedOptions.fixturePath,
      contractPath: resolvedOptions.contractPath,
      executionPolicyOverrides,
    });

    preflightCommands.push(...(await runFocusedEvidenceChainRegressionSet(deps, verificationCheckout.path)));
    const frozenContract = await assertFinalPreApprovalGate(
      deps,
      resolvedOptions,
      { fixture: fixtureStateBeforeContractRender, mainCheckout: mainCheckoutStateBeforePrepare },
      sha256,
    );
    await deps.writeVerifiedContract(resolvedOptions.contractPath, verifiedContractPath);
    const frozenVerifiedContract = await assertFrozenContractOnDiskAtFinalGate(
      deps,
      verifiedContractPath,
      frozenContract.sha256,
    );

    preserveVerificationCheckout = true;

    return {
      approvalPackage: buildApprovalPackage({
        verifiedCheckoutPath: verificationCheckout.path,
        verifiedCheckoutHead: verificationCheckout.head,
        readOnlyInspection,
        contract: frozenVerifiedContract.contract,
        contractPath: verifiedContractPath,
        contractSha256: frozenVerifiedContract.sha256,
        fixturePath: resolvedOptions.fixturePath,
        runDir: resolvedOptions.runDir,
        evidenceDir: resolvedOptions.evidenceDir,
        adapterConfigPath: verifiedAdapterConfigPath,
      }),
      preflightCommands,
    };
  } finally {
    if (!preserveVerificationCheckout) {
      await verificationCheckout.cleanup();
    }
  }
}
