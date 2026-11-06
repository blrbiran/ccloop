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

// Orca spec 2026-11-06 quota probe §4 step 2: a failed single call's record carries the cause the codex phase path
// computes for the same stream, so Orca can tell a quota failure from any other without reading model text. A complete
// call's record is byte-identical to before: no failureCause key.
describe("codex single-call records carry the classified cause (Orca quota probe)", { timeout: 30_000 }, () => {
  const QUOTA = "You've hit your usage limit. Upgrade to Pro or try again in 3 days.";
  it("a call codex refused for quota records failureCause quota with the provider's own text", async () => {
    const w = await world({ rows: [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, { type: "error", message: QUOTA }, { type: "turn.failed", error: { message: QUOTA } }], exitCode: 1 });
    expect(w.record).toMatchObject({ outcome: "failed", errorCode: "codex-exit-error", failureCause: { cause: "quota", detail: QUOTA } });
  });

  it("a call that failed on any other error records that cause, not quota", async () => {
    const w = await world({ rows: [{ type: "thread.started", thread_id: "t" }, { type: "error", message: "unexpected status 401 Unauthorized, last status: 401" }], exitCode: 1 });
    expect(w.record).toMatchObject({ outcome: "failed", failureCause: { cause: "auth" } });
  });

  it("a complete call's record has exactly the keys it had before", async () => {
    const w = await world();
    expect(Object.keys(w.record).sort()).toEqual(["errorCode", "outcome", "outputRef", "promptSha256", "responseSchemaSha256", "schema"]);
  });
});
