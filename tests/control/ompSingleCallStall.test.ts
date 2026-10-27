import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { parseAgentsTable } from "../../src/agents/table.js";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { collectExecution } from "../../src/control/collect.js";
import { readEvidence } from "../../src/control/evidence.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { OmpAdapter } from "../../src/runtime/omp/ompAdapter.js";
import { singleCallEnvelope } from "./agentsFixture.js";

// Tester #62 (Orca spec 2026-10-27-single-call-unknown-usage-settlement §3.1, §9 R5). When omp's own provider stream
// watchdog fires, omp exits 1 after an assistant message with stopReason "error". Orca reads only the record's errorCode:
// unless ccloop names that exit `omp-stalled` (the code its own idle watchdog already gives a stalled single call), Orca
// can only say "omp-exit-error" and the person cannot tell a network stall from a broken agent (C1). The usage of such a
// call stays unknown (booked null), so the person settles it by hand; the tokens the stream did show travel in the record
// as `usageLowerBound` so the settlement can show them -- never as usage, and never as 0 when omp's all-zero usage means
// "the provider sent no usage" (C2). The transcripts are omp 18.10.1's own (tests/fixtures/omp-m0/README.md).
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs");
const M0 = resolve("tests/fixtures/omp-m0");
const SELECTOR = "fake/fake-model";
const ROW = { provider: "fake", kind: "chat", id: "fake-model", selector: SELECTOR, contextWindow: 200000, maxTokens: 4096 };
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

async function transcript(name: "A" | "A_usage" | "B" | "C"): Promise<unknown[]> {
  return (await readFile(join(M0, `${name}.jsonl`), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
}
/** The same rows with every assistant message's field replaced (message_end, turn_end and agent_end all repeat it). */
function withAssistant(rows: unknown[], patch: Record<string, unknown>): unknown[] {
  const fix = (message: unknown) => (message as { role?: unknown }).role === "assistant" ? { ...(message as object), ...patch } : message;
  return rows.map((row) => {
    const r = row as { message?: unknown; messages?: unknown[] };
    return { ...r, ...(r.message === undefined ? {} : { message: fix(r.message) }), ...(r.messages === undefined ? {} : { messages: r.messages.map(fix) }) };
  });
}

async function fakeOmp(single: unknown) {
  const aux = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-stall-aux-")));
  dirs.push(aux);
  const marker = join(aux, "omp-marker");
  await writeFile(`${marker}.catalog.json`, JSON.stringify([ROW]));
  await writeFile(`${marker}.single.json`, JSON.stringify(single));
  const binary = join(aux, "omp");
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${marker}' "$@"\n`, { mode: 0o700 });
  return { aux, marker, binary };
}

/** One single call through the control worker, read back as Orca reads it: the booked usage and the handoff record. */
async function worker(single: { rows: unknown[]; exitCode: number }) {
  const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-stall-source-")));
  dirs.push(sourceDir);
  const { binary } = await fakeOmp(single);
  const table = parseAgentsTable({ schema: "ccloop-agents-table-v1", installations: {
    omp: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 60_000, killGraceMs: 300, defaultModel: SELECTOR, profile: null },
  } });
  const { config, resolution } = await resolveAgent(table, { agent: "omp", model: SELECTOR });
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
  const record = JSON.parse((await readEvidence(sourceDir, collected.candidate!.handoff)).toString("utf8")) as Record<string, unknown>;
  const booked = collected.events.map((event: { bucket: string; cumulative: { tokens: number } | null }) => [event.bucket, event.cumulative?.tokens ?? null]);
  return { record, booked };
}

describe("C1: omp's stream watchdog names the single call's errorCode omp-stalled", { timeout: 30_000 }, () => {
  it("A (stalled while waiting for the next event) is omp-stalled; its usage stays unknown", async () => {
    const w = await worker({ rows: await transcript("A"), exitCode: 1 });
    expect(w.record).toMatchObject({ outcome: "failed", errorCode: "omp-stalled", outputRef: null });
    expect(w.booked).toEqual([["work", null], ["handoff", 0]]);
  });

  it("B (timed out while waiting for the first event) is omp-stalled; its usage stays unknown", async () => {
    const w = await worker({ rows: await transcript("B"), exitCode: 1 });
    expect(w.record).toMatchObject({ outcome: "failed", errorCode: "omp-stalled", outputRef: null });
    expect(w.booked).toEqual([["work", null], ["handoff", 0]]);
  });

  it("an exit after an errored message with other error text keeps omp-exit-error", async () => {
    const rows = withAssistant(await transcript("A"), { errorMessage: "OpenAI completions request failed: 500 Internal Server Error" });
    const w = await worker({ rows, exitCode: 1 });
    expect(w.record).toMatchObject({ outcome: "failed", errorCode: "omp-exit-error" });
  });

  it("an exit after a message that did not stop on error keeps omp-exit-error, even when its text has the watchdog's words", async () => {
    const rows = withAssistant(await transcript("A"), { stopReason: "stop" });
    const w = await worker({ rows, exitCode: 1 });
    expect(w.record).toMatchObject({ outcome: "failed", errorCode: "omp-exit-error" });
  });

  it("the clean control C completes with its answer and booked usage", async () => {
    const w = await worker({ rows: await transcript("C"), exitCode: 0 });
    expect(w.record).toMatchObject({ outcome: "complete", errorCode: null });
    expect(w.booked).toEqual([["work", 133], ["handoff", 0]]);
  });
});

describe("C2: the record carries the observed lower bound only when it is positive", { timeout: 30_000 }, () => {
  it("A_usage: the provider's 133 tokens before the stall are the record's lower bound, not its usage", async () => {
    const w = await worker({ rows: await transcript("A_usage"), exitCode: 1 });
    expect(w.record).toMatchObject({ outcome: "failed", errorCode: "omp-stalled", usageLowerBound: { tokens: 133 } });
    expect(w.booked).toEqual([["work", null], ["handoff", 0]]);
  });

  it("A: an all-zero usage is nothing observed, so the record has no lower bound (never 0)", async () => {
    const w = await worker({ rows: await transcript("A"), exitCode: 1 });
    expect(Object.keys(w.record).sort()).toEqual(["errorCode", "outcome", "outputRef", "promptSha256", "responseSchemaSha256", "schema"]);
  });

  it("C: a complete call's record has no lower bound (its usage is booked)", async () => {
    const w = await worker({ rows: await transcript("C"), exitCode: 0 });
    expect(Object.keys(w.record).sort()).toEqual(["errorCode", "outcome", "outputRef", "promptSha256", "responseSchemaSha256", "schema"]);
  });
});

// The adapter alone: only omp's own non-zero exit is the watchdog; ccloop's time limit firing after omp printed the
// watchdog's message stays a timeout (its own code), so the stall name never hides why ccloop stopped the call.
describe("C1 boundary: only an exit-error is read as omp's watchdog", () => {
  let restore: () => void = () => {};
  beforeEach(() => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    restore = () => spy.mockRestore();
  });
  afterEach(() => restore());

  it("a timeout after the stalled message keeps omp-timeout", async () => {
    const { aux, binary } = await fakeOmp({ rows: await transcript("A"), holdOpen: true });
    const runDir = join(aux, "run");
    const cwd = join(runDir, "cwd");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const config: MaterializedAgentConfigV1 = {
      schema: "ccloop-agent-config-v1", kind: "omp",
      installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: SELECTOR, profile: null },
      selection: { agent: "omp", model: SELECTOR, contextWindow: "agent-default" },
    };
    const failure = await new OmpAdapter(config).singleCall({
      prompt: "p", responseSchema: { type: "object" }, maxOutputTokens: 4096, cwd, runDir, timeoutMs: 2_000,
    }).then(() => null, (error: unknown) => error);
    expect((failure as Error).message).toMatch(/^omp-timeout: /);
    expect((failure as { code?: unknown }).code).toBeUndefined();
  }, 20_000);
});
