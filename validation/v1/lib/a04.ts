import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { loopContractSchema, type LoopContract } from "../../../src/contract/schema.js";
import { renderScenario, type ExecutionPolicyOverrides } from "./scenarios.js";

const execFileAsync = promisify(execFile);

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
  executionPolicy: Required<ExecutionPolicyOverrides>;
  expectedFileScope: string[];
  expectedDiffScope: string[];
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
  runCommand: defaultRunCommand,
  writeContract: defaultWriteContract,
};

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
  contract: LoopContract;
  contractPath: string;
  contractSha256: string;
  fixturePath: string;
  runDir: string;
  evidenceDir: string;
  adapterConfigPath: string;
}): ApprovalPackage {
  return {
    contractIdentity: {
      path: input.contractPath,
      sha256: input.contractSha256,
      schemaValid: true,
    },
    executionPolicy: {
      tokenBudget: input.contract.executionPolicy.tokenBudget,
      perAttemptTimeoutMs: input.contract.executionPolicy.perAttemptTimeoutMs,
      totalRuntimeBudgetMs: input.contract.executionPolicy.totalRuntimeBudgetMs,
      partialOutcomeRecoveryWindowMs: input.contract.executionPolicy.partialOutcomeRecoveryWindowMs,
    },
    expectedFileScope: [...input.contract.context.targetPaths],
    expectedDiffScope: [...input.contract.safetyPolicy.allowlistPaths],
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

export async function prepareA04(
  options: A04PrepareOptions,
  deps: PrepareDeps = defaultDeps,
): Promise<{ approvalPackage: ApprovalPackage; preflightCommands: string[] }> {
  await deps.assertCleanFixture(options.fixturePath);
  const preflightCommands = await runDeterministicPreflight(deps, options.repoRoot);
  await assertFreshPath(deps, options.contractPath, "contract path");
  await assertFreshPath(deps, options.runDir, "run directory");
  await assertFreshPath(deps, options.evidenceDir, "evidence directory");

  const { contract, sha256 } = await deps.writeContract({
    fixturePath: options.fixturePath,
    contractPath: options.contractPath,
    executionPolicyOverrides: options.executionPolicyOverrides,
  });

  return {
    approvalPackage: buildApprovalPackage({
      contract,
      contractPath: options.contractPath,
      contractSha256: sha256,
      fixturePath: options.fixturePath,
      runDir: options.runDir,
      evidenceDir: options.evidenceDir,
      adapterConfigPath: options.adapterConfigPath,
    }),
    preflightCommands,
  };
}
