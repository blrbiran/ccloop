import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
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

type FrozenContract = {
  contract: LoopContract;
  sha256: string;
};

type IsolatedVerificationCheckout = {
  path: string;
  cleanup: () => Promise<void>;
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
  readCurrentBranch: (repoRoot: string) => Promise<string>;
  createMainVerificationCheckout: (repoRoot: string) => Promise<IsolatedVerificationCheckout>;
  runCommand: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  writeContract: (options: Pick<A04PrepareOptions, "fixturePath" | "contractPath" | "executionPolicyOverrides">) => Promise<FrozenContract>;
  readFrozenContract: (contractPath: string) => Promise<FrozenContract>;
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

async function defaultReadCurrentBranch(repoRoot: string): Promise<string> {
  return gitOutput(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

async function defaultCreateMainVerificationCheckout(repoRoot: string): Promise<IsolatedVerificationCheckout> {
  const worktreePath = await mkdtemp(join(tmpdir(), "ccloop-a04-main-"));
  await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "--detach", worktreePath, "HEAD"], {
    maxBuffer: 10 * 1024 * 1024,
  });

  const sourceNodeModulesPath = resolve(repoRoot, "node_modules");
  if (await pathExists(sourceNodeModulesPath)) {
    await symlink(sourceNodeModulesPath, resolve(worktreePath, "node_modules"));
  }

  return {
    path: worktreePath,
    cleanup: async () => {
      await execFileAsync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreePath], {
        maxBuffer: 10 * 1024 * 1024,
      });
    },
  };
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
  createMainVerificationCheckout: defaultCreateMainVerificationCheckout,
  runCommand: defaultRunCommand,
  writeContract: defaultWriteContract,
  readFrozenContract: defaultReadFrozenContract,
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

async function assertMainCheckout(deps: PrepareDeps, repoRoot: string): Promise<void> {
  const currentBranch = await deps.readCurrentBranch(repoRoot);

  if (currentBranch !== "main") {
    throw new Error(`A-04 preparation must run from branch main (current branch: ${currentBranch})`);
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
  options: Pick<A04PrepareOptions, "fixturePath" | "contractPath" | "runDir" | "evidenceDir">,
  beforePreflight: { fixture: RepoState },
  expectedSha256: string,
): Promise<FrozenContract> {
  await assertFixtureUnchangedBeforeApproval(deps, options.fixturePath, beforePreflight.fixture);
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
  await assertMainCheckout(deps, resolvedOptions.repoRoot);

  const verificationCheckout = await deps.createMainVerificationCheckout(resolvedOptions.repoRoot);

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
      { fixture: fixtureStateBeforeContractRender },
      sha256,
    );

    return {
      approvalPackage: buildApprovalPackage({
        repoRoot: resolvedOptions.repoRoot,
        contract: frozenContract.contract,
        contractPath: resolvedOptions.contractPath,
        contractSha256: frozenContract.sha256,
        fixturePath: resolvedOptions.fixturePath,
        runDir: resolvedOptions.runDir,
        evidenceDir: resolvedOptions.evidenceDir,
        adapterConfigPath: resolvedOptions.adapterConfigPath,
      }),
      preflightCommands,
    };
  } finally {
    await verificationCheckout.cleanup();
  }
}
