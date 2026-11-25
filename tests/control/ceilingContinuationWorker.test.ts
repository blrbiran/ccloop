// Orca #478 (spec 2026-11-25-ceiling-stop-keeps-work-design.md §5.1 item 4) through the real control worker and collect: a
// resumable live-ceiling stop's candidate is what Orca reads, so the worker itself must capture the usage ledger for it and
// the candidate must list nothing missing -- otherwise Orca's checkpoint is not continuable and the next run re-pays the plan.
// The setup is liveCeilingCollect.test.ts's (codex high-usage: 40,000 tokens a phase, reported as each turn ends), with the
// token policy a protocol-4 Orca run carries.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runControlCommand } from "../../src/control/command.js";
import { readEvidence } from "../../src/control/evidence.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture } from "../runtime/codex/fixture.js";
import { sealCodex } from "./agentsFixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("a group ceiling stop before execute: the candidate misses nothing and carries the plan, the state and the usage ledger", { timeout: 60_000 }, async () => {
  const runtime = await codexFixture("high-usage");
  dirs.push(runtime.dir);
  runtime.contract.executionPolicy.tokenBudget = null;
  runtime.contract.executionPolicy.totalRuntimeBudgetMs = 60_000;
  const sealed = await sealCodex(runtime.config as Parameters<typeof sealCodex>[0]);
  const amount = { tokens: 100, activeMs: 60_000, attempts: 1, sessions: 1 };
  const envelope: LoopStartEnvelope = { protocol: 4, claim: { groupId: "g", workItemId: "w", taskId: "t", runId: "r", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "c",
    configHash: sealed.configHash, agent: sealed.selection, grant: { work: { ...amount, tokens: null }, handoff: amount }, ownerToken: "o" },
    tokenPolicy: { authoredTokenCeiling: null, bindingCauses: ["group"], inheritedUsage: { tokens: 0, activeMs: 0, attempts: 0, sessions: 0 } },
    contractHash: "c".repeat(64), inputCheckpoint: null, work: { kind: "loop", contract: runtime.contract, targetRepo: runtime.repo, base: "HEAD", sourceDir: runtime.dir },
    liveCeiling: { protocol: 1, revision: 1, tokens: 10_000, cause: "group" } };
  const controlDir = join(runtime.dir, "control");
  await ensurePrivateDirectory(runtime.dir, controlDir);
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(runtime.dir, { protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
  await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  expect((await readFile(`${runtime.marker}.calls`, "utf8")).trim().split("\n")).toEqual(["plan"]);

  const result = await runControlCommand(["collect", "--agents", join(runtime.dir, "absent-agents.json")], JSON.stringify({ input: envelope, afterSeq: 0 }));
  expect(result.code, result.stderr).toBe(0);
  const collected = JSON.parse(result.stdout);
  // What Orca's ceiling settle keys on stays as it was: exhausted, partial, the stop at top level.
  expect(collected.terminal).toMatchObject({ status: "exhausted", stopReason: "live token ceiling reached", allowanceNextPhase: "execute" });
  expect(collected.terminal).not.toHaveProperty("waitingCause");
  expect(collected.liveCeilingStop).toMatchObject({ cause: "group", phase: "execute", at: "boundary" });
  expect(collected.candidate.result).toBe("partial");
  expect(collected.candidate.missing).toEqual([]);
  const packet = JSON.parse((await readEvidence(runtime.dir, collected.candidate.handoff)).toString());
  expect(packet.allowanceContinuation).toMatchObject({ nextPhase: "execute", execution: null, verification: null });
  expect(packet.artifacts).toContainEqual(packet.allowanceContinuation.plan);
  expect(packet.tokenPolicy).toEqual(envelope.tokenPolicy);
  const ledger = JSON.parse((await readEvidence(runtime.dir, packet.allowanceContinuation.usage)).toString());
  expect(ledger.totals.work).toMatchObject({ tokens: 40_000, attempts: 1, sessions: 1 });
  expect(ledger.nextSeq).toBe(packet.usageHighWater);
});
