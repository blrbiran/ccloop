import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
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
  readRepoTrackedState: (repoRoot: string) => Promise<RepoState>;
  runCommand: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  writeContract: (options: Pick<A04PrepareOptions, "fixturePath" | "contractPath" | "executionPolicyOverrides">) => Promise<{
    contract: LoopContract;
    sha256: string;
  }>;
};

const DETERMINISTIC_PREFLIGHT_COMMANDS: ReadonlyArray<readonly [string, string[]]> = [
  ["npm", ["test"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "build"]],
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
    await stat(path);
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

async function defaultReadRepoTrackedState(repoRoot: string): Promise<RepoState> {
  const head = await gitOutput(repoRoot, ["rev-parse", "HEAD"]);
  const status = await gitOutput(repoRoot, ["status", "--porcelain"]);
  return { head, status };
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

async function defaultWriteContract(options: Pick<A04PrepareOptions, "fixturePath" | "contractPath" | "executionPolicyOverrides">) {
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

const defaultDeps: PrepareDeps = {
  pathExists,
  assertCleanFixture: defaultAssertCleanFixture,
  readRepoTrackedState: defaultReadRepoTrackedState,
  runCommand: defaultRunCommand,
  writeContract: defaultWriteContract,
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
}): string[] {
  return [
    "npx",
    "--no-install",
    "tsx",
    "validation/v1/scripts/run-scenario.ts",
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
  repoRoot: string;
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
    workingDirectory: input.repoRoot,
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
    exactCommand: buildA04RunCommand(input),
    usageEvidenceExpectations: [
      "plan/execute/verify artifacts may include usageEvidence fields and tokenUsage when normalizedTotal is finite and positive",
      "tokenBudget is a controller stopping threshold, not an API cost cap",
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

async function runDeterministicPreflight(deps: PrepareDeps, repoRoot: string): Promise<string[]> {
  const commands: string[] = [];

  for (const [command, args] of DETERMINISTIC_PREFLIGHT_COMMANDS) {
    commands.push([command, ...args].join(" "));
    await deps.runCommand(command, [...args], repoRoot);
  }

  return commands;
}

async function assertCleanRepoRootBeforePreflight(deps: PrepareDeps, repoRoot: string): Promise<RepoState> {
  const beforePreflight = await deps.readRepoTrackedState(repoRoot);

  if (beforePreflight.status !== "") {
    throw new Error("repo root must have no changes before deterministic A-04 preflight");
  }

  return beforePreflight;
}

async function assertRepoRootUnchangedAfterPreflight(
  deps: PrepareDeps,
  repoRoot: string,
  beforePreflight: RepoState,
): Promise<void> {
  const afterPreflight = await deps.readRepoTrackedState(repoRoot);

  if (afterPreflight.head !== beforePreflight.head || afterPreflight.status !== beforePreflight.status) {
    throw new Error("deterministic A-04 preflight must leave the main checkout unchanged");
  }
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

export async function prepareA04(
  options: A04PrepareOptions,
  deps: PrepareDeps = defaultDeps,
): Promise<{ approvalPackage: ApprovalPackage; preflightCommands: string[] }> {
  const resolvedOptions = resolvePrepareOptions(options);
  const executionPolicyOverrides = validateA04ExecutionPolicy(resolvedOptions.executionPolicyOverrides);
  assertNoContractMaterializationOverlap(resolvedOptions);
  const fixtureStateBeforePreflight = await deps.assertCleanFixture(resolvedOptions.fixturePath);
  const repoRootStateBeforePreflight = await assertCleanRepoRootBeforePreflight(deps, resolvedOptions.repoRoot);
  const preflightCommands = await runDeterministicPreflight(deps, resolvedOptions.repoRoot);
  await assertRepoRootUnchangedAfterPreflight(deps, resolvedOptions.repoRoot, repoRootStateBeforePreflight);
  await assertFixtureUnchangedBeforeApproval(deps, resolvedOptions.fixturePath, fixtureStateBeforePreflight);
  await assertFreshPath(deps, resolvedOptions.contractPath, "contract path");
  await assertFreshPath(deps, resolvedOptions.runDir, "run directory");
  await assertFreshPath(deps, resolvedOptions.evidenceDir, "evidence directory");

  const { contract, sha256 } = await deps.writeContract({
    fixturePath: resolvedOptions.fixturePath,
    contractPath: resolvedOptions.contractPath,
    executionPolicyOverrides,
  });

  return {
    approvalPackage: buildApprovalPackage({
      repoRoot: resolvedOptions.repoRoot,
      contract,
      contractPath: resolvedOptions.contractPath,
      contractSha256: sha256,
      fixturePath: resolvedOptions.fixturePath,
      runDir: resolvedOptions.runDir,
      evidenceDir: resolvedOptions.evidenceDir,
      adapterConfigPath: resolvedOptions.adapterConfigPath,
    }),
    preflightCommands,
  };
}
