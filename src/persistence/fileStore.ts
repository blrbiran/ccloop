import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoopContract } from "../contract/schema.js";
import type { RunState } from "../state/types.js";

export type RunEvent = {
  type: string;
  at: string;
  detail: string;
};

export type AttemptArtifacts = {
  plan: unknown;
  execution?: unknown;
  verify?: unknown;
  diffPatch?: string;
  stdoutStderrLog?: string;
};

export async function initializeRunFiles(runDir: string, contract: LoopContract, initialState: RunState): Promise<void> {
  await mkdir(join(runDir, "attempts"), { recursive: true });
  await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify(initialState, null, 2));
  await writeFile(join(runDir, "events.jsonl"), "");
}

export async function writeRunState(runDir: string, state: RunState): Promise<void> {
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify(state, null, 2));
}

export async function appendEvent(runDir: string, event: RunEvent): Promise<void> {
  await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

export async function writeAttemptArtifacts(runDir: string, attempt: number, artifacts: AttemptArtifacts): Promise<void> {
  const attemptDir = join(runDir, "attempts", String(attempt));
  await mkdir(attemptDir, { recursive: true });
  await writeFile(join(attemptDir, "plan.json"), JSON.stringify(artifacts.plan, null, 2));

  if (artifacts.execution !== undefined) {
    await writeFile(join(attemptDir, "execution.json"), JSON.stringify(artifacts.execution, null, 2));
  }

  if (artifacts.verify !== undefined) {
    await writeFile(join(attemptDir, "verify.json"), JSON.stringify(artifacts.verify, null, 2));
  }

  if (artifacts.diffPatch !== undefined) {
    await writeFile(join(attemptDir, "diff.patch"), artifacts.diffPatch);
  }

  if (artifacts.stdoutStderrLog !== undefined) {
    await writeFile(join(attemptDir, "stdout-stderr.log"), artifacts.stdoutStderrLog);
  }
}
