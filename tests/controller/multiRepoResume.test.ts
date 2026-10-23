// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.2, §16.1 C10; review 7): crash resume publishes and
// removes residual <runDir>/dirs/attempt-*/<key> worktrees through a new function beside the untouched
// cleanupResidualWorktrees, and the fresh-run guard refuses a non-empty dirs/ with its own `(dirs)` message.
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { resumeLoop } from "../../src/controller/resumeLoop.js";
import { ensureFreshRunDir } from "../../src/persistence/fileStore.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { createExtraWorktree } from "../../src/workspace/worktreeManager.js";
import { git, multiRepoWorld } from "./multiRepoFixture.js";

const exists = (path: string) => stat(path).then(() => true, () => false);

// The resumable run of tests/controller/resumeLoop.integration.test.ts (seedEligibleRun), with this contract.
async function seedEligibleRun(runDir: string, contract: LoopContract): Promise<void> {
  await mkdir(join(runDir, "attempts"), { recursive: true });
  await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
  await writeFile(join(runDir, "events.jsonl"), "");
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify({
    status: "executing", currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 2, timeRemainingMs: 5000, tokenBudgetRemaining: 1000 }, recentFailures: [] }));
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify({ runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:100", lastAffirmedAt: "2026-07-25T00:00:00.000Z", ownerStatus: "current", supersededByEpoch: null }));
  await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify({ priorOwnerEpoch: 1, newOwnerEpoch: 2, priorProcessInstanceId: "pid:100",
    newProcessInstanceId: "pid:100", transferredAt: "2026-07-25T00:00:00.000Z", reason: "owner lost", eligibleForContinuation: true }));
  await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify({ staleSuspicionBasis: [], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute", conflictingEvidence: [], takeoverPermission: { allowed: true, reason: "ok" }, priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true }));
}

const succeeding: RuntimeAdapter = {
  async plan() { return { summary: "s", primaryTargetPaths: [] }; },
  async execute() { return { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" }; },
  async verify() { throw new Error("command verifier"); },
};

describe("crash resume and the fresh-run guard with extra worktrees (C10)", () => {
  it("publishes and removes a residual extra worktree on resume, then leaves no dirs/ behind", async () => {
    const { repos, contract } = await multiRepoWorld([{ key: "lib" }]);
    contract.executionPolicy.tokenBudget = 1000;
    const runDir = join(await mkdtemp(join(tmpdir(), "ccloop-run-")), "run-resume");
    await mkdir(runDir);
    await seedEligibleRun(runDir, contract);
    const { worktreePath } = await createExtraWorktree(repos.lib!, runDir, 1, "lib");
    await writeFile(join(worktreePath, "lib", "interrupted.txt"), "left by the crashed attempt\n");

    const state = await resumeLoop(runDir, succeeding);
    expect(state.status).toBe("succeeded");
    expect(await exists(worktreePath)).toBe(false);
    expect(await exists(join(runDir, "dirs"))).toBe(false);
    const sha = await git(repos.lib!, "rev-parse", `refs/ccloop/${basename(runDir)}/attempts/1`);
    expect(await git(repos.lib!, "diff", "--name-only", `${sha}^`, sha)).toBe("lib/interrupted.txt");
    expect((await git(repos.lib!, "worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree ")).length).toBe(1);
  }, 30_000);

  it("ensureFreshRunDir refuses a non-empty dirs/ by its own message and accepts an empty one", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await mkdir(join(runDir, "dirs"));
    await expect(ensureFreshRunDir(runDir)).resolves.toBeUndefined();
    await mkdir(join(runDir, "dirs", "attempt-1"));
    await expect(ensureFreshRunDir(runDir)).rejects.toThrow("runDir already contains prior run data (dirs)");
  });
});
