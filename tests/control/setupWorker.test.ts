import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture } from "../runtime/codex/fixture.js";
import { sealCodex } from "./agentsFixture.js";

// Task setup commands (spec 2026-11-04 §4.4): a setup-failed attempt made no provider call, so its usage is a measured 0,
// written as an explicit observation. Without it the run has no work observation at all, collect reports usage null, and
// Orca cannot settle a null-usage run.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("collect of a run whose setup fails has the setup-failed cause and a measured-zero usage observation", { timeout: 60_000 }, async () => {
  const runtime = await codexFixture("high-usage");
  dirs.push(runtime.dir);
  runtime.contract.context.setupCommands = ["exit 2"];
  const sealed = await sealCodex(runtime.config as Parameters<typeof sealCodex>[0]);
  const amount = { tokens: 100, activeMs: 60_000, attempts: 2, sessions: 1 };
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
  await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  expect(existsSync(`${runtime.marker}.calls`)).toBe(false);

  const { runControlCommand } = await import("../../src/control/command.js");
  const result = await runControlCommand(["collect", "--agents", join(runtime.dir, "absent-agents.json")], JSON.stringify({ input: envelope, afterSeq: 0 }));
  expect(result.code, result.stderr).toBe(0);
  const collected = JSON.parse(result.stdout);
  expect(collected.terminal.status).toBe("failed");
  expect(collected.failureCause).toEqual({ cause: "setup-failed", phase: "setup", retries: 0, detail: "exit 2 exit=2" });
  const work = collected.events.filter((event: { bucket: string }) => event.bucket === "work");
  expect(work).toHaveLength(1);
  expect(work[0].cumulative).toEqual({ tokens: 0, activeMs: 0, attempts: 1, sessions: 1 });
  const { readEvidence } = await import("../../src/control/evidence.js");
  expect(JSON.parse((await readEvidence(runtime.dir, work[0].source)).toString()))
    .toEqual({ kind: "setup-failed-attempt-v1", runId: "r", generation: 1, attempt: 1 });
});
