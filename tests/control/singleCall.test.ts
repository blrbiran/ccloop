import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExecution, inspectExecution } from "../../src/control/collect.js";
import { readEvidence } from "../../src/control/evidence.js";
import { requestHandoff } from "../../src/control/handoff.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type HandoffRequestV1 } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { FAKE_CLAUDE_CLI, claudeInstallation, sealClaude, singleCallEnvelope } from "./agentsFixture.js";

// Orca single-call estimate (2026-09-27), spec §5.2, §5.3 and §8.2 "worker 分支": single-call work runs in the control
// worker without git and is settled like any run -- read back through collect, as Orca reads it. The fake claude CLI
// and its marker live outside sourceDir, so sourceDir holds only what the worker wrote.
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

async function world(mode: "script" | "usage-then-hang" | "hang", script: unknown = {}) {
  const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-single-call-source-")));
  const aux = await realpath(await mkdtemp(join(tmpdir(), "ccloop-single-call-aux-")));
  dirs.push(sourceDir, aux);
  const marker = join(aux, "marker.json"), scriptPath = join(aux, "script.json");
  await writeFile(scriptPath, JSON.stringify(script));
  const command: [string, ...string[]] = mode === "script" ? [process.execPath, FAKE_CLAUDE_CLI, mode, marker, scriptPath] : [process.execPath, FAKE_CLAUDE_CLI, mode, marker];
  const sealed = await sealClaude(await claudeInstallation(command, { timeoutMs: 60_000, killGraceMs: 300 }));
  const envelope = singleCallEnvelope({ sourceDir, agent: sealed.selection, configHash: sealed.configHash });
  const controlDir = join(sourceDir, "control");
  await ensurePrivateDirectory(sourceDir, controlDir);
  await atomicReplacePrivateFile(sourceDir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(sourceDir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(sourceDir, {
    protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
  });
  const worker = runControlWorker(["--source-dir", sourceDir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  return { sourceDir, marker, envelope, worker };
}

/** Every file under root, relative; the random call directory and content-addressed evidence names normalized. */
async function tree(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path); else files.push(relative(root, path));
    }
  };
  await walk(root);
  return files.map((path) => path.replace(/\/call-[^/]+\//, "/call-*/").replace(/evidence-[a-f0-9]{64}\.bin$/, "evidence-*.bin")).sort();
}

const bookedTokens = (events: Array<{ bucket: string; cumulative: { tokens: number } | null }>) =>
  events.map((event) => [event.bucket, event.cumulative?.tokens ?? null]);
const request = (): HandoffRequestV1 => ({ protocol: 1, requestId: "request-1", runId: "run-estimate-1", generation: 1, reason: "human", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
async function waitForClosedObservation(sourceDir: string): Promise<void> {
  const root = join(sourceDir, "run", "claude", "1", "single-call");
  await expect.poll(async () => {
    try {
      const [call] = await readdir(root);
      return JSON.parse(await readFile(join(root, call!, "observed-usage.json"), "utf8")).openMessage === false;
    } catch { return false; }
  }, { timeout: 10_000 }).toBe(true);
}

describe("single-call work through the control worker (Orca single-call estimate)", { timeout: 30_000 }, () => {
  it("W1 + W5: books the call's output, call record, usage and stop proof, and writes nothing else", async () => {
    const w = await world("script", { "single-call": { output: { answer: "forty-two" } } });
    await w.worker;

    // W5, zero-write. Read before collect, whose stop proof writes evidence of its own. No repo/, no worktrees/, no
    // loop files: the call touched git nowhere, and its cwd is still empty.
    expect(await tree(w.sourceDir)).toEqual([
      "control/accepted.json",
      "control/candidate.json",
      "control/config.json",
      "control/envelope.json",
      "control/evidence/evidence-*.bin",
      "control/evidence/evidence-*.bin",
      "control/evidence/evidence-*.bin",
      "control/evidence/evidence-*.bin",
      "control/phases-completed.json",
      "control/processes.json",
      "control/usage.json",
      "run/claude/1/single-call/call-*/observed-usage.json",
      "run/claude/1/single-call/call-*/outcome.json",
      "run/claude/1/single-call/call-*/process.json",
      "run/claude/1/single-call/call-*/request.json",
      "run/claude/1/single-call/call-*/stderr.log",
      "run/claude/1/single-call/call-*/stdout.json",
      "run/claude/1/single-call/call-*/usage.json",
      "run/owner-record.json",
    ]);
    expect(await readdir(join(w.sourceDir, "run", "cwd"))).toEqual([]);
    expect((await stat(join(w.sourceDir, "run", "cwd"))).mode & 0o777).toBe(0o700);
    expect(await readFile(`${w.marker}.calls`, "utf8")).toBe("single-call\n");

    // W1, read back as Orca reads it.
    const collected = await collectExecution(w.envelope, 0);
    expect(collected.terminal).toBeNull();
    expect(bookedTokens(collected.events)).toEqual([["work", 15], ["handoff", 0]]);
    expect(collected.events[0]!.cumulative).toMatchObject({ tokens: 15, attempts: 1, sessions: 1 });
    const candidate = collected.candidate!;
    expect(candidate).toMatchObject({
      runId: "run-estimate-1", taskId: null, result: "complete", terminalOutcome: "single-call-complete",
      usageHighWater: collected.events[1]!.eventSeq, snapshot: null, missing: [], unresolvedRequestIds: [],
    });
    expect(candidate.stopProof).not.toBeNull();
    expect(candidate.artifacts).toHaveLength(1);
    expect(JSON.parse((await readEvidence(w.sourceDir, candidate.artifacts[0]!)).toString("utf8"))).toEqual({ answer: "forty-two" });
    // Controller ruling F10: the schema hash is of the exact string claude was handed after `--json-schema`, measured from
    // the fake's own argv record -- not recomputed from the in-memory envelope, whose key order accept's canonicalJson
    // rewrites before the worker ever reads it.
    const [argv] = (await readFile(`${w.marker}.argv`, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as string[]);
    const schemaArg = argv![argv!.indexOf("--json-schema") + 1]!;
    expect(JSON.parse(schemaArg)).toEqual(w.envelope.work.responseSchema);
    expect(JSON.parse((await readEvidence(w.sourceDir, candidate.handoff)).toString("utf8"))).toEqual({
      schema: "ccloop-single-call-record-v1",
      promptSha256: createHash("sha256").update(w.envelope.work.prompt, "utf8").digest("hex"),
      responseSchemaSha256: createHash("sha256").update(schemaArg, "utf8").digest("hex"),
      outcome: "complete",
      outputRef: candidate.artifacts[0],
      errorCode: null,
    });
    expect(await inspectExecution(w.envelope)).toMatchObject({ kind: "stopped" });
  });

  it("W2: an answer with no structured object fails the call, keeps its usage and leaves no output artifact", async () => {
    const w = await world("script", { "single-call": { output: null } });
    await w.worker;
    const collected = await collectExecution(w.envelope, 0);
    expect(bookedTokens(collected.events)).toEqual([["work", 15], ["handoff", 0]]);
    expect(collected.candidate).toMatchObject({ result: "failed", terminalOutcome: "single-call-failed", artifacts: [] });
    expect(collected.candidate!.stopProof).not.toBeNull();
    expect(JSON.parse((await readEvidence(w.sourceDir, collected.candidate!.handoff)).toString("utf8"))).toMatchObject({
      outcome: "failed", outputRef: null, errorCode: "single-call-output-invalid",
    });
  });

  it("W3: a handoff request stops the call at once and books what claude streamed before it as the cumulative", async () => {
    const w = await world("usage-then-hang");
    await waitForClosedObservation(w.sourceDir);
    const latched = request();
    const latchedAt = Date.now();
    expect(await requestHandoff(w.envelope, latched)).toEqual({ kind: "latched", requestId: "request-1" });
    await w.worker;
    // Not waited out: the request's deadline is a minute away (spec §5.3).
    expect(Date.now() - latchedAt).toBeLessThan(15_000);
    const collected = await collectExecution(w.envelope, 0);
    expect(bookedTokens(collected.events)).toEqual([["work", 1109], ["handoff", 0]]);
    const candidate = collected.candidate!;
    expect(candidate).toMatchObject({ result: "partial", terminalOutcome: "single-call-aborted", artifacts: [], unresolvedRequestIds: [] });
    expect(candidate.stopProof).not.toBeNull();
    expect(JSON.parse((await readEvidence(w.sourceDir, candidate.handoff)).toString("utf8"))).toMatchObject({ outcome: "aborted", outputRef: null, errorCode: null });
    expect(await requestHandoff(w.envelope, latched)).toEqual({ kind: "complete", requestId: "request-1", checkpointId: candidate.checkpointId });
  });

  it("W4: a call stopped before claude streamed anything books no work usage (null, never 0)", async () => {
    const w = await world("hang");
    await expect.poll(async () => {
      try { return (JSON.parse(await readFile(join(w.sourceDir, "control", "processes.json"), "utf8")) as unknown[]).length; } catch { return 0; }
    }, { timeout: 10_000 }).toBe(1);
    expect(await requestHandoff(w.envelope, request())).toEqual({ kind: "latched", requestId: "request-1" });
    await w.worker;
    const collected = await collectExecution(w.envelope, 0);
    expect(bookedTokens(collected.events)).toEqual([["work", null], ["handoff", 0]]);
    expect(collected.candidate).toMatchObject({ result: "partial", terminalOutcome: "single-call-aborted" });
    expect(collected.candidate!.stopProof).not.toBeNull();
  });
});
