import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { collectEvidence } from "../lib/evidence.js";
import { SCENARIO_IDS, getScenario, type ScenarioId } from "../lib/scenarios.js";

const execFileAsync = promisify(execFile);
const BASE_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"] as const;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

type ParsedArgs = {
  scenario: ScenarioId;
  contractPath: string;
  fixturePath: string;
  runDir: string;
  evidenceDir: string;
  adapterConfigPath: string;
  passEnv: string[];
};

type ProcessEntry = {
  pid: number;
  ppid: number;
  command: string;
};

type FixtureSnapshot = {
  head: string;
  status: string;
};

type ContractMetadata = {
  repoPath: string;
  taskId: string;
};

function isScenarioId(value: string): value is ScenarioId {
  return (SCENARIO_IDS as readonly string[]).includes(value);
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

function parseArgs(argv: string[]): ParsedArgs {
  let scenario: ScenarioId | undefined;
  let contractPath: string | undefined;
  let fixturePath: string | undefined;
  let runDir: string | undefined;
  let evidenceDir: string | undefined;
  let adapterConfigPath: string | undefined;
  const passEnv: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    switch (flag) {
      case "--scenario":
        if (!value || !isScenarioId(value)) {
          throw new Error(`--scenario must be one of ${SCENARIO_IDS.join(", ")}`);
        }
        scenario = value;
        index += 1;
        break;
      case "--contract":
        if (!value) {
          throw new Error("expected --contract <path>");
        }
        contractPath = resolve(value);
        index += 1;
        break;
      case "--fixture":
        if (!value) {
          throw new Error("expected --fixture <path>");
        }
        fixturePath = resolve(value);
        index += 1;
        break;
      case "--run-dir":
        if (!value) {
          throw new Error("expected --run-dir <path>");
        }
        runDir = resolve(value);
        index += 1;
        break;
      case "--evidence-dir":
        if (!value) {
          throw new Error("expected --evidence-dir <path>");
        }
        evidenceDir = resolve(value);
        index += 1;
        break;
      case "--adapter-config":
        if (!value) {
          throw new Error("expected --adapter-config <path>");
        }
        adapterConfigPath = resolve(value);
        index += 1;
        break;
      case "--pass-env":
        if (!value) {
          throw new Error("expected --pass-env <NAME>");
        }
        passEnv.push(value);
        index += 1;
        break;
      default:
        throw new Error(`unexpected argument: ${flag}`);
    }
  }

  if (!scenario || !contractPath || !fixturePath || !runDir || !evidenceDir || !adapterConfigPath) {
    throw new Error("missing required flags");
  }

  return {
    scenario,
    contractPath,
    fixturePath,
    runDir,
    evidenceDir,
    adapterConfigPath,
    passEnv,
  };
}

async function gitOutput(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function assertFreshPath(path: string, label: string): Promise<void> {
  if (await pathExists(path)) {
    throw new Error(`${label} already exists`);
  }
}

async function readContractMetadata(contractPath: string): Promise<ContractMetadata> {
  const raw = JSON.parse(await readFile(contractPath, "utf8")) as {
    context?: { repoPath?: unknown };
    objective?: { taskId?: unknown };
  };
  const repoPath = raw.context?.repoPath;
  const taskId = raw.objective?.taskId;

  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("contract.context.repoPath must be a non-empty string");
  }

  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error("contract.objective.taskId must be a non-empty string");
  }

  return {
    repoPath: resolve(repoPath),
    taskId,
  };
}

function assertScenarioMatchesContract(scenario: ScenarioId, contract: ContractMetadata): void {
  const expectedTaskId = `validation-v1-${scenario}`;
  if (contract.taskId !== expectedTaskId) {
    throw new Error(`contract objective.taskId (${contract.taskId}) does not match --scenario ${scenario}`);
  }
}

async function assertCleanFixture(fixturePath: string, contract: ContractMetadata): Promise<FixtureSnapshot> {
  if (contract.repoPath !== fixturePath) {
    throw new Error(`contract.context.repoPath (${contract.repoPath}) must match --fixture (${fixturePath})`);
  }

  const head = await gitOutput(fixturePath, ["rev-parse", "HEAD"]);
  const status = await gitOutput(fixturePath, ["status", "--porcelain"]);
  if (status !== "") {
    throw new Error("fixture must be clean before running a scenario");
  }

  return { head, status };
}

function buildChildEnvironment(passEnv: string[]): { env: NodeJS.ProcessEnv; envNames: string[] } {
  const env: NodeJS.ProcessEnv = {};
  const envNames: string[] = [];

  for (const name of BASE_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
      envNames.push(name);
    }
  }

  for (const name of passEnv) {
    if (env[name] !== undefined) {
      continue;
    }

    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
      envNames.push(name);
    }
  }

  return { env, envNames };
}

async function readProcessTable(): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      command: match[3]!,
    }));
}

function collectDescendants(entries: ProcessEntry[], rootPid: number): ProcessEntry[] {
  const childrenByParent = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry);
    childrenByParent.set(entry.ppid, children);
  }

  const descendants: ProcessEntry[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    descendants.push(current);
    queue.push(...(childrenByParent.get(current.pid) ?? []));
  }

  return descendants;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function monitorDescendants(rootPid: number, observed: Map<number, ProcessEntry>, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    try {
      const entries = await readProcessTable();
      for (const descendant of collectDescendants(entries, rootPid)) {
        observed.set(descendant.pid, descendant);
      }
    } catch {
      // Best effort only.
    }

    if (shouldStop()) {
      break;
    }

    await delay(250);
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function finalizeStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    stream.end(() => resolve());
  });
}

function determineClaudeChildExited(): "YES" | "NO" | "NOT_OBSERVABLE" {
  return "NOT_OBSERVABLE";
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs | null = null;
  let baseline: FixtureSnapshot = { head: "", status: "" };
  let after: FixtureSnapshot = { head: "", status: "" };
  let worktreeList = "";
  let envNames: string[] = [];
  let command: string[] = [];
  let startedAt = new Date().toISOString();
  let endedAt = startedAt;
  let startedMs = Date.now();
  let exitCode = 1;
  let rootPid = -1;
  let observedDescendants: ProcessEntry[] = [];
  let survivorPids: number[] = [];
  let stdoutStream: ReturnType<typeof createWriteStream> | null = null;
  let stderrStream: ReturnType<typeof createWriteStream> | null = null;
  let evidenceDirReady = false;

  try {
    parsed = parseArgs(argv);
    command = [
      "node",
      "dist/cli.js",
      "run",
      "--contract",
      parsed.contractPath,
      "--run-dir",
      parsed.runDir,
      "--adapter",
      "claude",
      "--adapter-config",
      parsed.adapterConfigPath,
    ];

    await assertFreshPath(parsed.evidenceDir, "evidenceDir");
    await assertFreshPath(parsed.runDir, "runDir");

    await mkdir(dirname(parsed.evidenceDir), { recursive: true });
    await mkdir(parsed.evidenceDir, { recursive: false });
    evidenceDirReady = true;
    await Promise.all([
      writeFile(join(parsed.evidenceDir, "stdout.log"), ""),
      writeFile(join(parsed.evidenceDir, "stderr.log"), ""),
    ]);
    stdoutStream = createWriteStream(join(parsed.evidenceDir, "stdout.log"), { flags: "a" });
    stderrStream = createWriteStream(join(parsed.evidenceDir, "stderr.log"), { flags: "a" });

    const contract = await readContractMetadata(parsed.contractPath);
    assertScenarioMatchesContract(parsed.scenario, contract);
    baseline = await assertCleanFixture(parsed.fixturePath, contract);
    after = { ...baseline };

    const childEnv = buildChildEnvironment(parsed.passEnv);
    envNames = childEnv.envNames;
    startedAt = new Date().toISOString();
    startedMs = Date.now();

    const child = spawn(command[0]!, command.slice(1), {
      cwd: repoRoot,
      env: childEnv.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    rootPid = child.pid ?? -1;

    child.stdout.on("data", (chunk) => {
      stdoutStream?.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrStream?.write(chunk);
    });

    const observed = new Map<number, ProcessEntry>();
    let childClosed = false;
    const monitorPromise = monitorDescendants(rootPid, observed, () => childClosed);

    exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        childClosed = true;
        resolve(code ?? 1);
      });
    });

    await monitorPromise;
    await delay(250);
    observedDescendants = [...observed.values()];
    survivorPids = observedDescendants.filter((entry) => pidIsAlive(entry.pid)).map((entry) => entry.pid);
    endedAt = new Date().toISOString();
    after = {
      head: await gitOutput(parsed.fixturePath, ["rev-parse", "HEAD"]),
      status: await gitOutput(parsed.fixturePath, ["status", "--porcelain"]),
    };
    worktreeList = await gitOutput(parsed.fixturePath, ["worktree", "list"]);
  } catch (error) {
    if (stderrStream !== null) {
      stderrStream.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }

    endedAt = new Date().toISOString();
    exitCode = 1;

    if (parsed !== null && baseline.head !== "") {
      try {
        after = {
          head: await gitOutput(parsed.fixturePath, ["rev-parse", "HEAD"]),
          status: await gitOutput(parsed.fixturePath, ["status", "--porcelain"]),
        };
        worktreeList = await gitOutput(parsed.fixturePath, ["worktree", "list"]);
      } catch {
        after = { ...baseline };
        worktreeList = "";
      }
    }

    if (stdoutStream !== null) {
      await finalizeStream(stdoutStream);
    }
    if (stderrStream !== null) {
      await finalizeStream(stderrStream);
    }

    if (parsed !== null && evidenceDirReady) {
      await collectEvidence({
        scenario: getScenario(parsed.scenario),
        runDir: parsed.runDir,
        evidenceDir: parsed.evidenceDir,
        invocation: {
          startedAt,
          endedAt,
          durationMs: Math.max(Date.now() - startedMs, 0),
          command,
          exitCode,
          envNames,
        },
        git: {
          before: baseline,
          after,
          worktreeList,
        },
        processes: {
          rootPid,
          observedDescendants: observedDescendants.map((entry) => ({ pid: entry.pid, ppid: entry.ppid, command: entry.command })),
          survivorPids,
          claudeChildExited: determineClaudeChildExited(),
        },
      });
    }

    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (stdoutStream !== null) {
    await finalizeStream(stdoutStream);
  }
  if (stderrStream !== null) {
    await finalizeStream(stderrStream);
  }

  if (parsed !== null) {
    await collectEvidence({
      scenario: getScenario(parsed.scenario),
      runDir: parsed.runDir,
      evidenceDir: parsed.evidenceDir,
      invocation: {
        startedAt,
        endedAt,
        durationMs: Math.max(Date.now() - startedMs, 0),
        command,
        exitCode,
        envNames,
      },
      git: {
        before: baseline,
        after,
        worktreeList,
      },
      processes: {
        rootPid,
        observedDescendants: observedDescendants.map((entry) => ({ pid: entry.pid, ppid: entry.ppid, command: entry.command })),
        survivorPids,
        claudeChildExited: determineClaudeChildExited(),
      },
    });
  }

  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
