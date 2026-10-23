import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture } from "../runtime/codex/fixture.js";
import { sealCodex } from "./agentsFixture.js";

// Live transcript (Orca spec 2026-10-23 §10.2.1, criterion L1). The handoff packet is built at the end of every run and
// retains each listed raw agent file whole through writeEvidence, which refuses anything over 16 MiB -- and that refusal
// is not caught, so the run would end without a candidate and Orca could not collect it. A long agent turn must therefore
// leave nothing over 16 MiB among the retained files: transcript.jsonl is never retained, events.jsonl stays capped.
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("a long agent turn and the handoff packet", () => {
  it("a fake codex printing 40 MiB per phase completes its run and collect returns a candidate", async () => {
    vi.stubEnv("FAKE_CODEX_STREAM_MIB", "40");
    const runtime = await codexFixture("large-stream");
    dirs.push(runtime.dir);
    runtime.contract.executionPolicy.totalRuntimeBudgetMs = 120_000;
    runtime.contract.executionPolicy.perAttemptTimeoutMs = 60_000;
    const sealed = await sealCodex({ ...runtime.config, timeoutMs: 60_000 } as Parameters<typeof sealCodex>[0]);
    const amount = { tokens: 100, activeMs: 120_000, attempts: 1, sessions: 1 };
    const envelope: LoopStartEnvelope = { protocol: 3, claim: { groupId: "g", workItemId: "w", taskId: "t", runId: "r", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "c", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "o" },
      contractHash: "c".repeat(64), inputCheckpoint: null, work: { kind: "loop", contract: runtime.contract, targetRepo: runtime.repo, base: "HEAD", sourceDir: runtime.dir } };
    const controlDir = join(runtime.dir, "control");
    await ensurePrivateDirectory(runtime.dir, controlDir);
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
    await writeAccepted(runtime.dir, { protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
      generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
    await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
    // Positive observation first: every phase really printed past 40 MiB, and the transcript kept all of it.
    for (const phase of ["plan", "execute", "verify"]) {
      const root = join(runtime.runDir, "codex", "1", phase);
      const [call] = await readdir(root);
      expect((await stat(join(root, call!, "transcript.jsonl"))).size, phase).toBeGreaterThan(40 * 1024 * 1024);
      expect((await stat(join(root, call!, "events.jsonl"))).size, phase).toBeLessThanOrEqual(16 * 1024 * 1024);
    }
    const { runControlCommand } = await import("../../src/control/command.js");
    const result = await runControlCommand(["collect", "--agents", join(runtime.dir, "absent-agents.json")], JSON.stringify({ input: envelope, afterSeq: 0 }));
    expect(result.code, result.stderr).toBe(0);
    const collected = JSON.parse(result.stdout) as { candidate: unknown; terminal: { status: string } | null };
    expect(collected.terminal?.status).toBe("succeeded");
    expect(collected.candidate).not.toBeNull();
  }, 150_000);
});
