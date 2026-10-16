import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

// Every-agent requirement chain (Orca spec 2026-10-15 §6.1, R2) through the control worker, read back as Orca reads it: a
// complete codex single call books its observed usage and answer; a call that ran a tool is refused by name and still
// books the usage it was observed spending -- never 0 for a call that reached the model.
const FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
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

async function world(single?: unknown) {
  const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-codex-single-source-")));
  const aux = await realpath(await mkdtemp(join(tmpdir(), "ccloop-codex-single-aux-")));
  dirs.push(sourceDir, aux);
  const marker = join(aux, "codex-marker"), codexHome = join(aux, "codex-home");
  await mkdir(codexHome); await writeFile(join(codexHome, "auth.json"), "{}"); await writeFile(join(codexHome, "config.toml"), "");
  if (single !== undefined) await writeFile(`${marker}.single.json`, JSON.stringify(single));
  const table = parseAgentsTable({ schema: "ccloop-agents-table-v1", installations: {
    codex: { kind: "codex", command: [process.execPath, FAKE_CODEX, "integration", marker], version: "9.9.9-fake", configDir: codexHome, timeoutMs: 60_000, killGraceMs: 300, sandbox: "read-only", budgetMode: "soft" },
  } });
  const { config, resolution } = await resolveAgent(table, { agent: "codex" });
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

describe("codex single calls through the control worker", { timeout: 30_000 }, () => {
  it("books a complete call's observed usage and its answer", async () => {
    const w = await world();
    expect(booked(w.collected.events)).toEqual([["work", 24], ["handoff", 0]]);
    expect(w.record).toMatchObject({ outcome: "complete", errorCode: null });
    expect(JSON.parse((await readEvidence(w.sourceDir, w.collected.candidate!.artifacts[0]!)).toString("utf8"))).toEqual({ answer: "42" });
  });

  it("names a call that ran a tool and books the usage it saw", async () => {
    const w = await world({ rows: [{ type: "item.started", item: { id: "i", type: "command_execution", command: "ls" } }, { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 6 } }] });
    expect(booked(w.collected.events)).toEqual([["work", 36], ["handoff", 0]]);
    expect(w.record).toMatchObject({ outcome: "failed", errorCode: "codex-single-call-not-single:tool" });
  });
});
