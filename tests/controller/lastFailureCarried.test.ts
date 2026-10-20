// Spec 2026-10-20-verifier-sees-checks-and-last-failure-design.md §5 (ruling B): a retried attempt's plan and execute
// contexts carry the last rejection — category and command from the recorded fingerprint, evidence from the rejected
// verification — and the verify context never does.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import type { AttemptContext, RuntimeAdapter, VerificationResult } from "../../src/runtime/types.js";
import { createContract, createRepo } from "./optionalFixture.js";

const CHECK = "test -f src/ok.txt || { echo 'TypeError: median is not a function' >&2; exit 1; }";
const approve: VerificationResult = { approved: true, rejectCategory: "", primaryTargetPaths: [], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] };

function recording(writeOn: number[]) {
  const seen: { phase: string; attempt: number; context: AttemptContext }[] = [];
  const adapter: RuntimeAdapter = {
    async plan(context) { seen.push({ phase: "plan", attempt: context.attempt, context }); return { summary: "s", primaryTargetPaths: ["src/plan.txt"] }; },
    async execute(context) {
      seen.push({ phase: "execute", attempt: context.attempt, context });
      if (!writeOn.includes(context.attempt)) return { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
      const file = join(context.worktreePath, "src/ok.txt");
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, "ok\n");
      return { changedFiles: ["src/ok.txt"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
    },
    async verify(context) { seen.push({ phase: "verify", attempt: context.attempt, context }); return approve; },
  };
  return { seen, adapter };
}

describe("the last rejection reaches the retried attempt's plan and execute (ruling B)", () => {
  it("attempt 2 carries attempt 1's required-check failure; attempt 1 and every verify carry none", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(await createRepo(), [CHECK]);
    contract.verification.verifierType = "agent";
    const { seen, adapter } = recording([2]);
    const state = await runLoop(contract, runDir, adapter);
    expect(state.status).toBe("succeeded");
    const rejected = JSON.parse(await readFile(join(runDir, "attempts", "1", "verify.json"), "utf8")) as VerificationResult;
    expect(rejected.evidence.join("\n")).toContain("TypeError: median is not a function");
    const at = (phase: string, attempt: number) => seen.find(s => s.phase === phase && s.attempt === attempt)!.context;
    for (const phase of ["plan", "execute"]) {
      expect(at(phase, 1)).not.toHaveProperty("lastFailure");
      expect(at(phase, 2).lastFailure).toEqual({ rejectCategory: "required-check-failed", failingCommand: CHECK, evidence: rejected.evidence });
    }
    expect(seen.filter(s => s.phase === "verify").map(s => s.attempt)).toEqual([2]);
    expect(at("verify", 2)).not.toHaveProperty("lastFailure");
  }, 30_000);

  it("a verifier's own rejection is carried the same way", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const contract = createContract(await createRepo(), ["true"]);
    contract.verification.verifierType = "agent";
    const { seen, adapter } = recording([]);
    let verifies = 0;
    adapter.verify = async () => (++verifies === 1
      ? { ...approve, approved: false, rejectCategory: "fix", primaryTargetPaths: ["src/a.ts"], failingCommand: null, safeToRetry: true, evidence: ["the edge case is unhandled"] }
      : approve);
    expect((await runLoop(contract, runDir, adapter)).status).toBe("succeeded");
    const plan2 = seen.find(s => s.phase === "plan" && s.attempt === 2)!.context;
    expect(plan2.lastFailure).toEqual({ rejectCategory: "fix", failingCommand: null, evidence: ["command output | required check passed: true", "the edge case is unhandled"] });
  }, 30_000);

  it("an allowance continuation's first attempt carries the evidence the worker decoded, or null without it", async () => {
    const recentFailures = [{ rejectCategory: "required-check-failed", primaryTargetPaths: ["src/plan.txt"], failingCommand: "npm test" }];
    for (const lastRejectionEvidence of [["boom"], undefined]) {
      const contract = createContract(await createRepo(), ["true"]);
      const { seen, adapter } = recording([]);
      await runLoop(contract, await mkdtemp(join(tmpdir(), "ccloop-run-")), adapter, {
        allowanceContinuation: { nextPhase: "plan", plan: null, execution: null, recentFailures, ...(lastRejectionEvidence ? { lastRejectionEvidence } : {}) },
      });
      const plan1 = seen.find(s => s.phase === "plan" && s.attempt === 1)!.context;
      expect(plan1.lastFailure).toEqual({ rejectCategory: "required-check-failed", failingCommand: "npm test", evidence: lastRejectionEvidence ?? null });
    }
  }, 30_000);
});
