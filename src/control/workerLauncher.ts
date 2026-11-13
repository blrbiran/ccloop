import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseLstartUtc } from "../ownership/ownerLiveness.js";
import { claimAcceptedWorker, markAcceptedUnknown, readAccepted, sealAcceptedWorker, type AcceptedRecordV1 } from "./store.js";

const execFileAsync = promisify(execFile);

export interface WorkerLaunchDeps {
  sourceDir: string;
  workerCommand: string[];
  workerEnv?: Record<string, string>;
  receiptTimeoutMs?: number;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLstartUtc(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    maxBuffer: 16 * 1024,
  });
  return stdout;
}

/**
 * The process's start instant as ISO-8601. Orca tester follow-up I (review of #273, finding 3): `ps lstart` is read under
 * TZ=UTC and parsed as UTC -- as the owner liveness check reads the same pid (ownerLiveness.ts) -- never as local time,
 * which is ambiguous in a DST fall-back hour and could record a live worker's start an hour early, so that it looked lost.
 */
export async function readProcessStartedAt(pid: number, readLstart: (pid: number) => Promise<string> = readLstartUtc): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const seconds = parseLstartUtc(await readLstart(pid));
    return seconds === null ? null : new Date(seconds * 1000).toISOString();
  } catch {
    return null;
  }
}

export async function workerIdentityMatches(worker: AcceptedRecordV1["worker"]): Promise<boolean> {
  if (worker === null) return false;
  return (await readProcessStartedAt(worker.pid)) === worker.startedAt;
}

export async function launchWorker(record: AcceptedRecordV1, deps: WorkerLaunchDeps): Promise<void> {
  const [executable, ...baseArgs] = deps.workerCommand;
  if (executable === undefined || !isAbsolute(executable) || !isAbsolute(deps.sourceDir)) {
    throw new Error("control-worker-command-invalid");
  }
  const nonce = randomUUID();
  const child = spawn(
    executable,
    [
      ...baseArgs,
      "--source-dir",
      deps.sourceDir,
      "--execution-id",
      record.executionId,
      "--nonce",
      nonce,
    ],
    {
      cwd: deps.sourceDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...deps.workerEnv },
    },
  );
  // Orca follow-up J (#308): a worker command that cannot be spawned (missing, not executable) is reported as an 'error'
  // event; unheard, it killed this process and left the launch `intended` -- ambiguous for ever. It is a launch no worker
  // claimed, recorded as such below.
  let spawnFailed = false;
  child.once("error", () => { spawnFailed = true; });
  child.unref();
  const deadline = Date.now() + (deps.receiptTimeoutMs ?? 2_000);
  while (Date.now() < deadline) {
    const current = await readAccepted(deps.sourceDir);
    if (
      current.executionId === record.executionId &&
      (current.launch === "claimed" || current.launch === "sealed") &&
      current.worker?.nonce === nonce
    ) {
      return;
    }
    if (child.exitCode !== null || spawnFailed) break;
    await wait(20);
  }
  await markAcceptedUnknown(deps.sourceDir, record.executionId);
}

async function workerReceiptMain(argv: string[]): Promise<void> {
  const read = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index < 0 ? undefined : argv[index + 1];
    if (value === undefined) throw new Error(`missing ${flag}`);
    return value;
  };
  const sourceDir = read("--source-dir");
  const executionId = read("--execution-id");
  const nonce = read("--nonce");
  const startedAt = new Date(performance.timeOrigin).toISOString();
  if (await claimAcceptedWorker(sourceDir, { executionId, nonce, pid: process.pid, startedAt })) {
    await sealAcceptedWorker(sourceDir, executionId, nonce);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void workerReceiptMain(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
