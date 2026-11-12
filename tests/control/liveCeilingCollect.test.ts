// Live token ceiling (Orca tester follow-up G part 2) through the control worker and collect. Orca reads why a run stopped
// from collect: a run ended at its ceiling answers a top-level `liveCeilingStop` (with the cause Orca wrote), while the
// protocol-4 `terminal` keeps its strict shape -- Orca's pinned collect schema would refuse an unknown key there. A run
// started without a ceiling must behave and write exactly as before (no ceiling file). The worker's watch is what lets
// Orca's raises reach a running phase.
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveCeiling } from "../../src/budget/liveCeiling.js";
import { runControlCommand } from "../../src/control/command.js";
import { createLiveCeilingWatch, liveCeilingPath, writeLiveCeiling } from "../../src/control/liveCeilingFile.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture } from "../runtime/codex/fixture.js";
import { sealCodex } from "./agentsFixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const CEILING: LiveCeiling = { protocol: 1, revision: 1, tokens: 10_000, cause: "group" };

/** A protocol-4 codex run (high-usage: 40,000 tokens a phase) with a null work token grant, run by the real worker. */
async function runWorker(liveCeiling?: LiveCeiling, before: (dir: string) => Promise<void> = async () => undefined): Promise<{ dir: string; envelope: LoopStartEnvelope; calls: string[] }> {
  const runtime = await codexFixture("high-usage");
  dirs.push(runtime.dir);
  runtime.contract.executionPolicy.tokenBudget = null;
  runtime.contract.executionPolicy.totalRuntimeBudgetMs = 60_000;
  const sealed = await sealCodex(runtime.config as Parameters<typeof sealCodex>[0]);
  const amount = { tokens: 100, activeMs: 60_000, attempts: 1, sessions: 1 };
  const envelope: LoopStartEnvelope = { protocol: 4, claim: { groupId: "g", workItemId: "w", taskId: "t", runId: "r", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "c",
    configHash: sealed.configHash, agent: sealed.selection, grant: { work: { ...amount, tokens: null }, handoff: amount }, ownerToken: "o" },
    contractHash: "c".repeat(64), inputCheckpoint: null, work: { kind: "loop", contract: runtime.contract, targetRepo: runtime.repo, base: "HEAD", sourceDir: runtime.dir },
    ...(liveCeiling === undefined ? {} : { liveCeiling }) };
  const controlDir = join(runtime.dir, "control");
  await ensurePrivateDirectory(runtime.dir, controlDir);
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(runtime.dir, { protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
  await before(runtime.dir);
  await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  return { dir: runtime.dir, envelope, calls: (await readFile(`${runtime.marker}.calls`, "utf8")).trim().split("\n") };
}

async function collect(dir: string, envelope: LoopStartEnvelope): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const result = await runControlCommand(["collect", "--agents", join(dir, "absent-agents.json")], JSON.stringify({ input: envelope, afterSeq: 0 }));
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("a run with a live ceiling through the worker and collect", () => {
  it("the v4 terminal stays strict and liveCeilingStop is top level", { timeout: 60_000 }, async () => {
    const { dir, envelope, calls } = await runWorker(CEILING);
    expect(calls).toEqual(["plan"]);
    expect(JSON.parse(await readFile(liveCeilingPath(dir), "utf8"))).toEqual(CEILING);
    const collected = await collect(dir, envelope);
    expect(collected.terminal).toMatchObject({ status: "exhausted", stopReason: "live token ceiling reached" });
    expect(Object.keys(collected.terminal)).not.toContain("liveCeilingStop");
    expect(collected.liveCeilingStop).toEqual({ revision: 1, tokens: 10_000, cause: "group", observedTokens: 40_000, phase: "execute", at: "boundary" });
    expect(collected.candidate.result).toBe("partial");
  });

  it("a newer ceiling Orca wrote before the worker started is kept, not overwritten by the envelope's", { timeout: 60_000 }, async () => {
    // Orca's raise to 50,000 (revision 3) landed before the worker seeded revision 1 (10,000): plan (40,000) and execute run,
    // and the run stops before verify at the raised ceiling.
    const raised = { ...CEILING, revision: 3, tokens: 50_000 };
    const { dir, envelope, calls } = await runWorker(CEILING, (sourceDir) => writeLiveCeiling(sourceDir, raised));
    expect(calls).toEqual(["plan", "execute"]);
    expect(JSON.parse(await readFile(liveCeilingPath(dir), "utf8"))).toEqual(raised);
    expect((await collect(dir, envelope)).liveCeilingStop).toEqual({ revision: 3, tokens: 50_000, cause: "group", observedTokens: 80_000, phase: "verify", at: "boundary" });
  });
});

describe("a run without a live ceiling", () => {
  it("no liveCeiling: nothing is written and nothing changes", { timeout: 60_000 }, async () => {
    const { dir, envelope, calls } = await runWorker();
    expect(calls).toEqual(["plan", "execute", "verify"]);
    expect(existsSync(liveCeilingPath(dir))).toBe(false);
    const collected = await collect(dir, envelope);
    expect(collected.terminal.status).toBe("succeeded");
    expect(Object.keys(collected)).not.toContain("liveCeilingStop");
  });
});

describe("the worker's watch of the ceiling file", () => {
  it("takes a newer revision, ignores an older one, and keeps the last good value over a bad read, reported once", async () => {
    const runtime = await codexFixture();
    dirs.push(runtime.dir);
    await writeLiveCeiling(runtime.dir, CEILING);
    const failures: unknown[] = [];
    const watch = createLiveCeilingWatch(runtime.dir, CEILING, async (error) => { failures.push(error); });
    const until = async (check: () => boolean): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!check()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); }
    };
    try {
      await writeLiveCeiling(runtime.dir, { ...CEILING, revision: 2, tokens: 20_000 });
      await until(() => watch.current().revision === 2);
      expect(watch.current().tokens).toBe(20_000);
      await writeFile(liveCeilingPath(runtime.dir), "not json", { mode: 0o600 });
      await until(() => failures.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(failures).toHaveLength(1);
      expect(watch.current()).toEqual({ ...CEILING, revision: 2, tokens: 20_000 });
      await writeFile(liveCeilingPath(runtime.dir), canonicalJson({ ...CEILING, revision: 1, tokens: 1 }), { mode: 0o600 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(watch.current().revision).toBe(2);
    } finally {
      await watch.stop();
    }
  });
});
