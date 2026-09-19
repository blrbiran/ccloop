import { appendFile } from "node:fs/promises";
import { claimAcceptedWorker, sealAcceptedWorker } from "../../src/control/store.ts";
import { readProcessStartedAt } from "../../src/control/workerLauncher.ts";

function value(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

const sourceDir = value("--source-dir");
const executionId = value("--execution-id");
const nonce = value("--nonce");
const startedAt = await readProcessStartedAt(process.pid);
if (startedAt === null) throw new Error("worker-start-identity-unavailable");
const claimed = await claimAcceptedWorker(sourceDir, { executionId, nonce, pid: process.pid, startedAt });
if (claimed) {
  const launchFile = process.env.CCLOOP_CONTROL_LAUNCH_FILE;
  if (launchFile) await appendFile(launchFile, "launch\n", { mode: 0o600 });
  await sealAcceptedWorker(sourceDir, executionId, nonce);
}
