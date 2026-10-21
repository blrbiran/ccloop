// Spec 2026-10-21-prior-failures-start-input-design.md §2.2 (and review round 1): a run whose accepted envelope carries
// `work.priorFailures` hands them to plan and execute while the run has no failure of its own — also as a successor with
// an input checkpoint — never to verify, never with runId; from the run's first fingerprint on, only ruling B's last
// failure is carried.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import type { LoopStartEnvelope, PriorFailureV1 } from "../../src/control/protocol.js";
import type { AttemptContext, RuntimeAdapter, VerificationResult } from "../../src/runtime/types.js";
import { resultFixture } from "../control/taskResultFixture.js";

const approve: VerificationResult = { approved: true, rejectCategory: "", primaryTargetPaths: [], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] };
const prior: PriorFailureV1[] = [
  { runId: "run-old-1", rejectCategory: "run-failed:stalled", failingCommand: null, evidence: null, failureCause: "stalled" },
  { runId: "run-old-2", rejectCategory: "required-check-failed", failingCommand: "npm test", evidence: ["TypeError: boom"] },
];
const rendered = prior.map(({ runId: _runId, ...failure }) => failure);

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function recording(writeOn: number[]) {
  const seen: { phase: string; attempt: number; context: AttemptContext }[] = [];
  const adapter: RuntimeAdapter = {
    async plan(context) { seen.push({ phase: "plan", attempt: context.attempt, context }); return { summary: "s", primaryTargetPaths: ["answer.txt"] }; },
    async execute(context) {
      seen.push({ phase: "execute", attempt: context.attempt, context });
      if (!writeOn.includes(context.attempt)) return { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
      await writeFile(join(context.worktreePath, "answer.txt"), "ok\n");
      return { changedFiles: ["answer.txt"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
    },
    async verify(context) { seen.push({ phase: "verify", attempt: context.attempt, context }); return approve; },
  };
  const at = (phase: string, attempt: number) => seen.find(s => s.phase === phase && s.attempt === attempt)!.context;
  return { seen, adapter, at };
}

async function setup(check: string, inputCheckpoint: LoopStartEnvelope["inputCheckpoint"] = null) {
  const f = await resultFixture(); roots.push(f.root);
  const contract = { ...f.contract, verification: { ...f.contract.verification, requiredChecks: [check] } };
  const input: LoopStartEnvelope = { ...f.input, inputCheckpoint, work: { ...f.input.work as LoopStartEnvelope["work"], contract, priorFailures: prior } };
  return { f, contract, input };
}

describe("earlier runs' failures reach a fresh run's plan and execute", () => {
  it("attempt 1's plan and execute carry them newest-last as on the wire, without runId; verify never does", async () => {
    const { f, contract, input } = await setup("true");
    const { seen, adapter, at } = recording([1]);
    const state = await runLoop(contract, f.runDir, adapter, { taskResultInput: input });
    expect(state.status).toBe("succeeded");
    for (const phase of ["plan", "execute"]) {
      expect(at(phase, 1).priorFailures).toEqual(rendered);
      expect(at(phase, 1)).not.toHaveProperty("lastFailure");
      expect(JSON.stringify(at(phase, 1).priorFailures)).not.toContain("run-old");
    }
    expect(seen.filter(s => s.phase === "verify")).toHaveLength(1);
    expect(at("verify", 1)).not.toHaveProperty("priorFailures");
  }, 30_000);

  it("after the run's own first failure, attempt 2 carries only B's last failure", async () => {
    const check = "grep -q ok answer.txt || { echo 'TypeError: median is not a function' >&2; exit 1; }";
    const { f, contract, input } = await setup(check);
    const { adapter, at } = recording([2]);
    const state = await runLoop(contract, f.runDir, adapter, { taskResultInput: input });
    expect(state.status).toBe("succeeded");
    expect(at("plan", 1).priorFailures).toEqual(rendered);
    for (const phase of ["plan", "execute"]) {
      expect(at(phase, 2)).not.toHaveProperty("priorFailures");
      expect(at(phase, 2).lastFailure).toMatchObject({ rejectCategory: "required-check-failed", failingCommand: check });
    }
  }, 30_000);

  it("a continuation that inherits a fingerprint carries B's failure on its attempt 1, not these", async () => {
    const { f, contract, input } = await setup("true");
    const { adapter, at } = recording([1]);
    const recentFailures = [{ rejectCategory: "fix", primaryTargetPaths: ["answer.txt"], failingCommand: null }];
    await runLoop(contract, f.runDir, adapter, { taskResultInput: input, allowanceContinuation: { nextPhase: "plan", plan: null, execution: null, recentFailures } });
    expect(at("plan", 1)).not.toHaveProperty("priorFailures");
    expect(at("plan", 1).lastFailure).toEqual({ rejectCategory: "fix", failingCommand: null, evidence: null });
  }, 30_000);

  it("a successor (input checkpoint set) of a run with no rejection still carries them", async () => {
    const f0 = await resultFixture(); roots.push(f0.root);
    const bundle = join(f0.root, "checkpoint-bundle"); await mkdir(bundle);
    const { f, contract, input } = await setup("true", { predecessorRunId: "run-0", checkpointId: "cp-1", checkpointHash: "c".repeat(64), bundlePath: bundle });
    const { adapter, at } = recording([1]);
    await runLoop(contract, f.runDir, adapter, { taskResultInput: input });
    expect(at("plan", 1).priorFailures).toEqual(rendered);
    expect(at("execute", 1).priorFailures).toEqual(rendered);
  }, 30_000);

  it("an envelope without them gives contexts without the key", async () => {
    const f = await resultFixture(); roots.push(f.root);
    const { adapter, at } = recording([1]);
    await runLoop(f.contract, f.runDir, adapter, { taskResultInput: f.input });
    expect(at("plan", 1)).not.toHaveProperty("priorFailures");
    expect(at("execute", 1)).not.toHaveProperty("priorFailures");
  }, 30_000);
});
