// Memory in runs (Orca spec 2026-11-20-memory-in-runs-and-read-api-design.md §3): the accepted envelope's `work.memory`
// reaches plan and execute of every attempt -- it is the run's frozen bundle, not a per-attempt note -- and never verify.
// An envelope without it puts no key on the contexts, so the run behaves exactly as before.
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import type { AttemptContext, RuntimeAdapter, VerificationResult } from "../../src/runtime/types.js";
import { resultFixture } from "../control/taskResultFixture.js";

const approve: VerificationResult = { approved: true, rejectCategory: "", primaryTargetPaths: [], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] };
const TEXT = "## ccmem context\n- (decision) use the median helper\n";
const MEMORY = { format: "ccloop-memory-v1" as const, sha256: createHash("sha256").update(TEXT).digest("hex"), tokens: 12, ids: [1042, 1057], text: TEXT };

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function recording() {
  const seen: { phase: string; attempt: number; context: AttemptContext }[] = [];
  const adapter: RuntimeAdapter = {
    async plan(context) { seen.push({ phase: "plan", attempt: context.attempt, context }); return { summary: "s", primaryTargetPaths: ["answer.txt"] }; },
    async execute(context) { seen.push({ phase: "execute", attempt: context.attempt, context }); return { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" }; },
    async verify(context) { seen.push({ phase: "verify", attempt: context.attempt, context }); return approve; },
  };
  const at = (phase: string, attempt: number) => seen.find(s => s.phase === phase && s.attempt === attempt)!.context;
  return { seen, adapter, at };
}

describe("work.memory reaches plan and execute, never verify", () => {
  it("the envelope's memory is on both contexts and on no verify context", async () => {
    const f = await resultFixture(); roots.push(f.root);
    const input = { ...f.input, work: { ...f.input.work, memory: MEMORY } };
    const { seen, adapter, at } = recording();
    const state = await runLoop(f.contract, f.runDir, adapter, { taskResultInput: input });
    expect(state.status).toBe("succeeded");
    for (const phase of ["plan", "execute"]) expect(at(phase, 1).memory).toEqual(MEMORY);
    expect(seen.filter(s => s.phase === "verify")).toHaveLength(1);
    expect(at("verify", 1)).not.toHaveProperty("memory");
  }, 30_000);

  it("an envelope without memory gives contexts without the key", async () => {
    const f = await resultFixture(); roots.push(f.root);
    const { adapter, at } = recording();
    await runLoop(f.contract, f.runDir, adapter, { taskResultInput: f.input });
    expect(at("plan", 1)).not.toHaveProperty("memory");
    expect(at("execute", 1)).not.toHaveProperty("memory");
  }, 30_000);
});