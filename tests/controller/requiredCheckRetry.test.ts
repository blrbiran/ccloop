// Spec 2026-10-20-verifier-sees-checks-and-last-failure-design.md §3 (ruling R, option (b)): a failed required check
// is retried once, only on the lineage's first attempt outside saved-result recovery; every other path keeps today's
// terminal state. One test per §3 row that changes or that (b) keeps.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import type { LoopContract } from "../../src/contract/schema.js";
import type { AttemptContext, RuntimeAdapter, VerificationResult } from "../../src/runtime/types.js";
import { createContract, createRepo } from "./optionalFixture.js";

const approve: VerificationResult = {
  approved: true, rejectCategory: "", primaryTargetPaths: [], failingCommand: null, safeToRetry: false,
  evidence: [], pauseSignals: [], stopSignals: [],
};

// Each attempt writes the files named for it (relative to the worktree) and reports exactly those as changed.
function adapterWriting(perAttempt: string[][], verify: (context: AttemptContext) => VerificationResult = () => approve): RuntimeAdapter & { attempts: number[] } {
  const attempts: number[] = [];
  return {
    attempts,
    async plan() { return { summary: "write files", primaryTargetPaths: ["src/plan.txt"] }; },
    async execute(context) {
      attempts.push(context.attempt);
      const files = perAttempt[context.attempt - 1] ?? [];
      for (const file of files) {
        await mkdir(dirname(join(context.worktreePath, file)), { recursive: true });
        await writeFile(join(context.worktreePath, file), "x\n");
      }
      return { changedFiles: files, diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
    },
    async verify(context) { return verify(context); },
  };
}

function agentContract(repo: string, checks: string[]): LoopContract {
  const contract = createContract(repo, checks);
  contract.verification.verifierType = "agent";
  return contract;
}

async function readVerify(runDir: string, attempt: number): Promise<VerificationResult> {
  return JSON.parse(await readFile(join(runDir, "attempts", String(attempt), "verify.json"), "utf8")) as VerificationResult;
}

describe("a failed required check is retried once on the lineage's first attempt (ruling R, option (b))", () => {
  it("row 1: the first attempt's check failure is retried, and the retry can succeed", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const adapter = adapterWriting([["src/other.txt"], ["src/ok.txt"]]);
    const state = await runLoop(agentContract(await createRepo(), ["test -f src/ok.txt"]), runDir, adapter);
    expect(state.status).toBe("succeeded");
    expect(state.attemptsUsed).toBe(2);
    expect(await readVerify(runDir, 1)).toMatchObject({ approved: false, rejectCategory: "required-check-failed", failingCommand: "test -f src/ok.txt", safeToRetry: true });
  }, 30_000);

  it("row 3: a different check failing on the second attempt ends failed, as today", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const adapter = adapterWriting([["src/x.txt"], ["src/a.txt"]]);
    const state = await runLoop(agentContract(await createRepo(), ["test -f src/a.txt", "test -f src/b.txt"]), runDir, adapter);
    expect(state.status).toBe("failed");
    expect(state.stopReason).toBe("verifier rejection with no safe retry path");
    expect(state.attemptsUsed).toBe(2);
    expect(await readVerify(runDir, 1)).toMatchObject({ failingCommand: "test -f src/a.txt", safeToRetry: true });
    expect(await readVerify(runDir, 2)).toMatchObject({ failingCommand: "test -f src/b.txt", primaryTargetPaths: ["src/a.txt"], safeToRetry: false });
  }, 30_000);

  it("row 5: a verifier rejection retried, then a check failure, ends failed, as today", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const adapter = adapterWriting([["src/x.txt"], ["src/bad.txt"]], () => ({
      ...approve, approved: false, rejectCategory: "fix", primaryTargetPaths: ["src/x.txt"], safeToRetry: true, evidence: ["not yet"],
    }));
    const state = await runLoop(agentContract(await createRepo(), ["test ! -f src/bad.txt"]), runDir, adapter);
    expect(state.status).toBe("failed");
    expect(state.stopReason).toBe("verifier rejection with no safe retry path");
    expect(adapter.attempts).toEqual([1, 2]);
    expect(await readVerify(runDir, 2)).toMatchObject({ rejectCategory: "required-check-failed", safeToRetry: false });
  }, 30_000);

  it("row 6: an inherited lineage's check failure is not retried", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const adapter = adapterWriting([["src/x.txt"], ["src/y.txt"]]);
    const state = await runLoop(agentContract(await createRepo(), ["false"]), runDir, adapter, {
      tokenPolicy: { authoredTokenCeiling: null, bindingCauses: ["spend-cap"], inheritedUsage: { tokens: 0, activeMs: 0, attempts: 1, sessions: 1 } },
    });
    expect(state.status).toBe("failed");
    expect(state.stopReason).toBe("verifier rejection with no safe retry path");
    expect(state.attemptsUsed).toBe(1);
    expect(await readVerify(runDir, 1)).toMatchObject({ rejectCategory: "required-check-failed", safeToRetry: false });
  }, 30_000);
});
