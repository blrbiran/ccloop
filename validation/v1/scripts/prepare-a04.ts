import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareA04 } from "../lib/a04.js";

type ParsedArgs = {
  fixturePath: string;
  contractPath: string;
  runDir: string;
  evidenceDir: string;
  adapterConfigPath: string;
  tokenBudget: number;
  perAttemptTimeoutMs: number;
  totalRuntimeBudgetMs: number;
  partialRecoveryWindowMs: number;
};

function parsePositiveInteger(flag: string, value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }

  return parsed;
}

function parseNonNegativeInteger(flag: string, value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }

  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index] ?? "", argv[index + 1] ?? "");
  }

  const fixturePath = values.get("--fixture");
  if (!fixturePath) {
    throw new Error("expected --fixture <path>");
  }

  const contractPath = values.get("--contract");
  if (!contractPath) {
    throw new Error("expected --contract <path>");
  }

  const runDir = values.get("--run-dir");
  if (!runDir) {
    throw new Error("expected --run-dir <path>");
  }

  const evidenceDir = values.get("--evidence-dir");
  if (!evidenceDir) {
    throw new Error("expected --evidence-dir <path>");
  }

  const adapterConfigPath = values.get("--adapter-config");
  if (!adapterConfigPath) {
    throw new Error("expected --adapter-config <path>");
  }

  return {
    fixturePath,
    contractPath,
    runDir,
    evidenceDir,
    adapterConfigPath,
    tokenBudget: parsePositiveInteger("--token-budget", values.get("--token-budget")),
    perAttemptTimeoutMs: parsePositiveInteger("--per-attempt-timeout-ms", values.get("--per-attempt-timeout-ms")),
    totalRuntimeBudgetMs: parsePositiveInteger("--total-runtime-budget-ms", values.get("--total-runtime-budget-ms")),
    partialRecoveryWindowMs: parseNonNegativeInteger(
      "--partial-recovery-window-ms",
      values.get("--partial-recovery-window-ms"),
    ),
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const result = await prepareA04({
      repoRoot: resolve("."),
      fixturePath: resolve(parsed.fixturePath),
      contractPath: resolve(parsed.contractPath),
      runDir: resolve(parsed.runDir),
      evidenceDir: resolve(parsed.evidenceDir),
      adapterConfigPath: resolve(parsed.adapterConfigPath),
      executionPolicyOverrides: {
        tokenBudget: parsed.tokenBudget,
        perAttemptTimeoutMs: parsed.perAttemptTimeoutMs,
        totalRuntimeBudgetMs: parsed.totalRuntimeBudgetMs,
        partialOutcomeRecoveryWindowMs: parsed.partialRecoveryWindowMs,
      },
    });

    process.stdout.write(`${JSON.stringify(result.approvalPackage, null, 2)}
`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
