import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
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

export async function readProcessStartedAt(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
    });
    const parsed = new Date(stdout.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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
    if (child.exitCode !== null) break;
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
