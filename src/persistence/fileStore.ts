import { access, appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoopContract } from "../contract/schema.js";
import type { ExecutionRecovery, ReconciliationRecord } from "../runtime/types.js";
import type { RunBoundaryAnalysis, RunState } from "../state/types.js";

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
  executionRecovery?: ExecutionRecovery;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function ensureFreshRunDir(runDir: string): Promise<void> {
  await mkdir(runDir, { recursive: true });

  const blockingPaths = [
    [join(runDir, "loop-contract.json"), "loop-contract.json"],
    [join(runDir, "loop-state.json"), "loop-state.json"],
    [join(runDir, "events.jsonl"), "events.jsonl"],
  ] as const;

  for (const [path, label] of blockingPaths) {
    if (await pathExists(path)) {
      throw new Error(`runDir already contains prior run data (${label}); V1 does not support reinitializing an existing automated run`);
    }
  }

  if (await directoryHasEntries(join(runDir, "attempts"))) {
    throw new Error("runDir already contains prior run data (attempts); V1 does not support reinitializing an existing automated run");
  }

  if (await directoryHasEntries(join(runDir, "worktrees"))) {
    throw new Error("runDir already contains prior run data (worktrees); V1 does not support reinitializing an existing automated run");
  }
}

export async function initializeRunFiles(runDir: string, contract: LoopContract, initialState: RunState): Promise<void> {
  await ensureFreshRunDir(runDir);
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

export async function writeBoundaryArtifacts(
  runDir: string,
  artifacts: {
    boundaryAnalysis: RunBoundaryAnalysis;
    reconciliationRecord?: ReconciliationRecord;
  },
): Promise<void> {
  await writeFile(join(runDir, "boundary-analysis.json"), JSON.stringify(artifacts.boundaryAnalysis, null, 2));

  if (artifacts.reconciliationRecord !== undefined) {
    await writeFile(
      join(runDir, "reconciliation-record.json"),
      JSON.stringify(artifacts.reconciliationRecord, null, 2),
    );
  }
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

  if (artifacts.executionRecovery !== undefined) {
    await writeFile(
      join(attemptDir, "execution-recovery.json"),
      JSON.stringify(artifacts.executionRecovery, null, 2),
    );
  }
}
