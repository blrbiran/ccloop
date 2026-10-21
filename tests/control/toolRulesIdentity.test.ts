// Per-contract tool rules are task identity (ccloop spec 2026-10-22 §2 "Why the contract", §6, §8 T7). An allowance
// continuation reuses already-paid phases of an earlier run only when ccloop's own content comparison (semanticContract)
// says the contract is the same task; a changed rule set is a different boundary, so the continuation must be refused
// even when Orca hands the same contractHash (ccloop never recomputes that hash, it only compares it). The rules are not
// agent identity: agentConfigHash must not move with them, or a frozen agent selection would strand on a template edit.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAllowanceContinuation } from "../../src/control/materialize.js";
import { appendUsageObservation } from "../../src/control/usage.js";
import { buildBundle } from "./optionalMaterializeFixture.js";
import { fixture } from "./optionalFixture.js";

const rules = { commands: [{ kind: "exact", value: "npm test" }], network: false, secretEnv: [] };

/** The saved verify-phase allowance continuation of allowanceEvidence.test.ts, with the sealed contract's toolRules chosen. */
async function saved(sealedToolRules: unknown) {
  const h = await buildBundle(); const { envelope } = await fixture();
  envelope.protocol = 4; envelope.tokenPolicy = { authoredTokenCeiling: null, bindingCauses: ["spend-cap"], inheritedUsage: { tokens: 20, activeMs: 100, attempts: 1, sessions: 1 } };
  envelope.inputCheckpoint = h.input; envelope.work.sourceDir = h.sourceDir; envelope.work.contract.context.repoPath = h.targetRepo;
  const put = async (value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)); const hash = createHash("sha256").update(bytes).digest("hex"); const ref = { artifactId: `sha256-${hash}`, hash }; const file = `artifacts/${ref.artifactId}.bin`; await writeFile(join(h.input.bundlePath, file), bytes, { mode: 0o600 }); h.manifest.artifacts.push({ ref, file }); return ref; };
  const plan = { summary: "saved plan", primaryTargetPaths: [], tokenUsage: 10 };
  const execution = { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "", tokenUsage: 10 };
  const sealedPolicy = { ...envelope.work.contract.executionPolicy, ...(sealedToolRules === undefined ? {} : { toolRules: sealedToolRules }) };
  const planRef = await put(plan), executionRef = await put(execution), acceptedContract = await put({ ...envelope.work.contract, executionPolicy: sealedPolicy, context: { ...envelope.work.contract.context, repoPath: h.sourceRepo } });
  const runState = { currentAttempt: 1, attemptsUsed: 1, budgetSnapshot: { attemptsRemaining: 2, timeRemainingMs: 100, tokenBudgetRemaining: 0, tokenRemainingStatus: "known" }, recentFailures: [], waitingCause: "token-allowance", allowanceNextPhase: "verify" };
  const state = await put(runState);
  const usageDir = join(h.root, "usage-source"); await mkdir(usageDir);
  await appendUsageObservation(usageDir, { runId: h.input.predecessorRunId, generation: envelope.claim.generation, bucket: "work", observationId: "settled", threadTotalTokens: 20, elapsedMs: 100, attempts: 1, sessions: 1, evidence: { phase: "execute" } });
  const usage = await put(JSON.parse(await readFile(join(usageDir, "control/usage.json"), "utf8")));
  const packet = { usageHighWater: 2, identity: { ...envelope.claim, runId: h.input.predecessorRunId }, tokenPolicy: { authoredTokenCeiling: null, bindingCauses: ["spend-cap"], inheritedUsage: { tokens: 0, activeMs: 0, attempts: 0, sessions: 0 } }, contractHash: envelope.contractHash, acceptedContract, runState,
    allowanceContinuation: { nextPhase: "verify", plan: planRef, execution: executionRef, verification: null, state, usage }, artifacts: [planRef, executionRef, acceptedContract, state, usage] };
  const handoff = await put(packet);
  const checkpoint = { checkpointId: h.input.checkpointId, snapshot: h.manifest.snapshot, handoff };
  const bytes = Buffer.from(JSON.stringify(checkpoint)); const hash = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(h.input.bundlePath, "checkpoint.json"), bytes, { mode: 0o600 });
  h.manifest.artifacts[0] = { ref: { artifactId: `checkpoint-cp1-${hash}`, hash }, file: "checkpoint.json" }; h.manifest.checkpoint = h.manifest.artifacts[0].ref; h.manifest.checkpointHash = hash; h.input.checkpointHash = hash;
  await writeFile(h.manifestPath, JSON.stringify(h.manifest), { mode: 0o600 });
  return { envelope };
}
const withRules = <T extends { work: { contract: { executionPolicy: object } } }>(envelope: T, toolRules: unknown): T => {
  envelope.work.contract.executionPolicy = { ...envelope.work.contract.executionPolicy, toolRules } as never;
  return envelope;
};

describe("toolRules and continuation identity (T7)", () => {
  it("the same rules on both sides: the continuation is accepted (the rules alone do not break it)", async () => {
    const { envelope } = await saved(rules);
    expect((await readAllowanceContinuation(withRules(envelope, rules)))?.nextPhase).toBe("verify");
  }, 30_000);

  it("rules added, removed or changed with the same contractHash handed in: control-allowance-authority-mismatch", async () => {
    await expect(saved(undefined).then(({ envelope }) => readAllowanceContinuation(withRules(envelope, rules)))).rejects.toThrow("control-allowance-authority-mismatch");
    await expect(saved(rules).then(({ envelope }) => readAllowanceContinuation(envelope))).rejects.toThrow("control-allowance-authority-mismatch");
    await expect(saved(rules).then(({ envelope }) => readAllowanceContinuation(withRules(envelope, { ...rules, network: true })))).rejects.toThrow("control-allowance-authority-mismatch");
  }, 30_000);
});

// toolRules are not agent identity (spec §6): this holds by construction -- agentConfigHash hashes only the materialized
// config, which resolveAgent builds from the agents table and the selection, never the contract (review round 1, M8:
// the former test here could not fail on its named mutation, so it was removed).
