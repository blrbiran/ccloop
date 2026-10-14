import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { parseAgentsTable } from "../../src/agents/table.js";
import { collectExecution } from "../../src/control/collect.js";
import { readEvidence } from "../../src/control/evidence.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { singleCallEnvelope } from "./agentsFixture.js";

// OMP single call (Orca spec 2026-10-14 §3.3.1, §3.3.7) through the control worker, read back as Orca reads it: a complete
// call books its observed usage and answer; a call refused at spawn because the catalog cap rose above the envelope's
// maxOutputTokens (4096 here) books 0 and names the cap -- nothing was sent, so nothing may be charged.
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs");
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    try {
      for (const registered of JSON.parse(await readFile(join(dir, "control", "processes.json"), "utf8")) as Array<{ pgid: number }>) {
        try { process.kill(-registered.pgid, "SIGKILL"); } catch {}
      }
    } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

async function world(maxTokens: number) {
  const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-single-source-")));
  const aux = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-single-aux-")));
  dirs.push(sourceDir, aux);
  const marker = join(aux, "omp-marker");
  await writeFile(`${marker}.catalog.json`, JSON.stringify([{ provider: "gateway", kind: "chat", id: "model-a", selector: "gateway/model-a", contextWindow: 200000, maxTokens }]));
  const binary = join(aux, "omp");
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${marker}' "$@"\n`, { mode: 0o700 });
  const table = parseAgentsTable({ schema: "ccloop-agents-table-v1", installations: {
    omp: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 60_000, killGraceMs: 300, defaultModel: "gateway/model-a", profile: null },
  } });
  const { config, resolution } = await resolveAgent(table, { agent: "omp" });
  const envelope = singleCallEnvelope({ sourceDir, agent: resolution.selection, configHash: resolution.configHash });
  const controlDir = join(sourceDir, "control");
  await ensurePrivateDirectory(sourceDir, controlDir);
  await atomicReplacePrivateFile(sourceDir, join(controlDir, "config.json"), Buffer.from(canonicalJson(config)));
  await atomicReplacePrivateFile(sourceDir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(sourceDir, {
    protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
  });
  await runControlWorker(["--source-dir", sourceDir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  const collected = await collectExecution(envelope, 0);
  const record = JSON.parse((await readEvidence(sourceDir, collected.candidate!.handoff)).toString("utf8")) as { outcome: string; errorCode: string | null };
  return { sourceDir, marker, collected, record };
}
const booked = (events: Array<{ bucket: string; cumulative: { tokens: number } | null }>) => events.map((event) => [event.bucket, event.cumulative?.tokens ?? null]);

describe("omp single calls through the control worker", { timeout: 30_000 }, () => {
  it("books a complete call's observed usage and its answer", async () => {
    const w = await world(4096);
    expect(booked(w.collected.events)).toEqual([["work", 14], ["handoff", 0]]);
    expect(w.record).toMatchObject({ outcome: "complete", errorCode: null });
    expect(JSON.parse((await readEvidence(w.sourceDir, w.collected.candidate!.artifacts[0]!)).toString("utf8"))).toEqual({ answer: "42" });
  });

  it("C3: books 0 and names the cap when the catalog cap exceeds the envelope's maxOutputTokens", async () => {
    const w = await world(8192);
    expect(booked(w.collected.events)).toEqual([["work", 0], ["handoff", 0]]);
    expect(w.record).toMatchObject({ outcome: "failed", errorCode: "omp-single-call-cap-exceeded" });
    expect(existsSync(`${w.marker}.calls`)).toBe(false);
  });
});
