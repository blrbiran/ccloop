import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { requestHandoff } from "../../src/control/handoff.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture } from "../runtime/codex/fixture.js";
import { sealCodex } from "./agentsFixture.js";

// Task setup commands (spec 2026-11-04 §4.4): a setup-failed attempt made no provider call, so its usage is a measured 0,
// written as an explicit observation. Without it the run has no work observation at all, collect reports usage null, and
// Orca cannot settle a null-usage run.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

type Runtime = Awaited<ReturnType<typeof codexFixture>>;

async function workAndCollect(runtime: Runtime, config: Runtime["config"], whileRunning?: (envelope: LoopStartEnvelope) => Promise<void>) {
  const sealed = await sealCodex(config as Parameters<typeof sealCodex>[0]);
  const amount = { tokens: 100_000, activeMs: 60_000, attempts: 2, sessions: 1 };
  const envelope: LoopStartEnvelope = {
    protocol: 4,
    claim: { groupId: "g", workItemId: "w", taskId: "t", runId: "r", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "c", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "o" },
    tokenPolicy: { authoredTokenCeiling: null, bindingCauses: [], inheritedUsage: { tokens: 0, activeMs: 0, attempts: 0, sessions: 0 } },
    contractHash: "c".repeat(64), inputCheckpoint: null,
    work: { kind: "loop", contract: runtime.contract, targetRepo: runtime.repo, base: "HEAD", sourceDir: runtime.dir },
  };
  const controlDir = join(runtime.dir, "control");
  await ensurePrivateDirectory(runtime.dir, controlDir);
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(runtime.dir, {
    protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
  });
  const worker = runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  await whileRunning?.(envelope);
  await worker;
  const { runControlCommand } = await import("../../src/control/command.js");
  const result = await runControlCommand(["collect", "--agents", join(runtime.dir, "absent-agents.json")], JSON.stringify({ input: envelope, afterSeq: 0 }));
  expect(result.code, result.stderr).toBe(0);
  const collected = JSON.parse(result.stdout);
  const work = collected.events.filter((event: { bucket: string }) => event.bucket === "work");
  const { readEvidence } = await import("../../src/control/evidence.js");
  const evidence = async (event: { source: unknown }) => JSON.parse((await readEvidence(runtime.dir, event.source as never)).toString());
  return { collected, work, evidence };
}

it("collect of a run whose setup fails has the setup-failed cause and a measured-zero usage observation", { timeout: 60_000 }, async () => {
  const runtime = await codexFixture("high-usage");
  dirs.push(runtime.dir);
  runtime.contract.context.setupCommands = ["sleep 0.3; exit 2"];
  const { collected, work, evidence } = await workAndCollect(runtime, runtime.config);
  expect(existsSync(`${runtime.marker}.calls`)).toBe(false);
  expect(collected.terminal.status).toBe("failed");
  expect(collected.failureCause).toEqual({ cause: "setup-failed", phase: "setup", retries: 0, detail: "sleep 0.3; exit 2 exit=2" });
  expect(work).toHaveLength(1);
  // Fix round 1 ruling: zero tokens, but the setup's measured time.
  expect(work[0].cumulative).toMatchObject({ tokens: 0, attempts: 1, sessions: 1 });
  expect(work[0].cumulative.activeMs).toBeGreaterThanOrEqual(300);
  expect(await evidence(work[0])).toEqual({ kind: "setup-ended-attempt-v1", runId: "r", generation: 1, attempt: 1, outcome: "failed" });
});

// Fix round 1: a setup failure after an attempt that spent tokens keeps the running total -- a literal 0 would reset the
// ledger's cumulative tokens and under-report what the run spent.
it("a setup failure in attempt 2 keeps attempt 1's tokens in the thread total", { timeout: 60_000 }, async () => {
  const runtime = await codexFixture("frames");
  dirs.push(runtime.dir);
  const frames = join(runtime.dir, "frames.json");
  await writeFile(frames, JSON.stringify({ "*": [{ changedFiles: [], approved: false, safeToRetry: true }, { approved: true }] }));
  const config = { ...runtime.config, command: [process.execPath, fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)), "frames", runtime.marker, frames] };
  runtime.contract.executionPolicy.maxAttempts = 2;
  runtime.contract.executionPolicy.totalRuntimeBudgetMs = 60_000;
  runtime.contract.executionPolicy.tokenBudget = null;
  runtime.contract.verification.requiredChecks = ["true"];
  // Passes the first time, fails the second: the count lives outside the worktree.
  const count = join(runtime.dir, "setup-count");
  runtime.contract.context.setupCommands = [`if [ -f '${count}' ]; then exit 4; fi; touch '${count}'`];
  const { collected, work, evidence } = await workAndCollect(runtime, config);
  expect((await readFile(`${runtime.marker}.calls`, "utf8")).trim().split("\n")).toEqual(["plan", "execute", "verify"]);
  expect(collected.failureCause).toMatchObject({ cause: "setup-failed", phase: "setup", detail: expect.stringMatching(/ exit=4$/) });
  const setup = work.at(-1);
  expect(await evidence(setup)).toEqual({ kind: "setup-ended-attempt-v1", runId: "r", generation: 1, attempt: 2, outcome: "failed" });
  const before = work.at(-2).cumulative.tokens;
  expect(before).toBeGreaterThan(0);
  expect(setup.cumulative).toMatchObject({ tokens: before, attempts: 2, sessions: 1 });
});

// Fix round 2 ruling: every setup that ran is observed. A handoff during attempt 1's setup would otherwise leave the run
// with no work observation, and Orca's work usage unknown for good (a continuation is then refused).
it("a handoff during setup still leaves a known zero work observation for the attempt", { timeout: 60_000 }, async () => {
  const runtime = await codexFixture("high-usage");
  dirs.push(runtime.dir);
  runtime.contract.context.setupCommands = ["sleep 5"];
  const { collected, work, evidence } = await workAndCollect(runtime, runtime.config, async (envelope) => {
    const log = join(runtime.dir, "run", "attempts", "1", "setup-1.log");
    for (let i = 0; i < 500 && !existsSync(log); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(log)).toBe(true);
    await requestHandoff(envelope, { protocol: 1, requestId: "stop-1", runId: "r", generation: 1, reason: "human", deadlineAt: new Date().toISOString() });
  });
  expect(existsSync(`${runtime.marker}.calls`)).toBe(false);
  expect(collected.failureCause).toBeUndefined();
  expect(work).toHaveLength(1);
  expect(work[0].cumulative).toMatchObject({ tokens: 0, attempts: 1, sessions: 1 });
  expect(await evidence(work[0])).toEqual({ kind: "setup-ended-attempt-v1", runId: "r", generation: 1, attempt: 1, outcome: "handoff" });
});

it("a setup that passes is observed with its time before the plan phase's observation", { timeout: 60_000 }, async () => {
  const runtime = await codexFixture("high-usage");
  dirs.push(runtime.dir);
  runtime.contract.context.setupCommands = ["sleep 0.2"];
  runtime.contract.executionPolicy.tokenBudget = null;
  const { collected, work, evidence } = await workAndCollect(runtime, runtime.config);
  expect(collected.terminal.status).toBe("succeeded");
  expect(await evidence(work[0])).toEqual({ kind: "setup-ended-attempt-v1", runId: "r", generation: 1, attempt: 1, outcome: "ok" });
  expect(work[0].cumulative).toMatchObject({ tokens: 0, attempts: 1, sessions: 1 });
  expect(work[0].cumulative.activeMs).toBeGreaterThanOrEqual(200);
  expect(await evidence(work[1])).toMatchObject({ phase: "plan", attempt: 1 });
});
