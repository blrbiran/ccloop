import { execFile } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loopContractSchema } from "../../../src/contract/schema.js";
import { SCENARIO_IDS, renderScenario, type ScenarioId } from "../lib/scenarios.js";

const execFileAsync = promisify(execFile);

type ParsedArgs = {
  scenario: ScenarioId;
  repoPath: string;
  outputPath: string;
  timeoutMs?: number;
};

function isScenarioId(value: string): value is ScenarioId {
  return (SCENARIO_IDS as readonly string[]).includes(value);
}

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

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index] ?? "", argv[index + 1] ?? "");
  }

  const scenarioValue = values.get("--scenario");
  if (!scenarioValue || !isScenarioId(scenarioValue)) {
    throw new Error(`--scenario must be one of ${SCENARIO_IDS.join(", ")}`);
  }

  const repoPath = values.get("--repo");
  if (!repoPath) {
    throw new Error("expected --repo <path>");
  }

  const outputPath = values.get("--output");
  if (!outputPath) {
    throw new Error("expected --output <path>");
  }

  const timeoutValue = values.get("--timeout-ms");
  if ((scenarioValue === "C" || scenarioValue === "D") && timeoutValue === undefined) {
    throw new Error(`--timeout-ms <positive integer> is required for scenario ${scenarioValue}`);
  }

  return {
    scenario: scenarioValue,
    repoPath,
    outputPath,
    timeoutMs: timeoutValue === undefined ? undefined : parsePositiveInteger("--timeout-ms", timeoutValue),
  };
}

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

async function assertGitRepository(repoPath: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"]);
  if (stdout.trim() !== "true") {
    throw new Error("repo path must be a git repository");
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const repoPath = await realpath(parsed.repoPath);
    await assertGitRepository(repoPath);

    const outputPath = resolve(parsed.outputPath);
    if (await pathExists(outputPath)) {
      throw new Error("output file already exists");
    }

    const contract = loopContractSchema.parse(
      renderScenario(parsed.scenario, {
        repoPath,
        timeoutMs: parsed.timeoutMs,
      }),
    );

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(contract, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
