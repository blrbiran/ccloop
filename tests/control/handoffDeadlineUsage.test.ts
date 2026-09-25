import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestHandoff } from "../../src/control/handoff.js";
import { collectExecution } from "../../src/control/collect.js";
import { readEvidence } from "../../src/control/evidence.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type HandoffRequestV1, type StartEnvelopeV1 } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture } from "../runtime/codex/fixture.js";

// Orca handoff delivery (2026-09-25), spec §13.1 C-3 option (i), controller ruling on plan row D-C3: a control
// run whose execute phase a handoff deadline aborts after codex reported usage books that usage as a known
// cumulative (not null), so Orca does not have to treat the run's usage as unknown. Additive only (ccloop
// Rule 15): the existing "watches a latched deadline …" criterion (hang mode, nothing reported) keeps
// expecting a null work event.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("deadline-aborted execute with observed usage (Orca handoff delivery C-3)", () => {
  it("books the observed tokens as a known cumulative and still hands off a partial candidate that answers its request", async () => {
    const runtime = await codexFixture("script");
    dirs.push(runtime.dir);
    const scriptPath = join(runtime.dir, "script.json");
    await writeFile(scriptPath, JSON.stringify({ "codex-test": { files: { "answer.txt": "42\n" }, delayMs: { execute: 30_000 }, usageBeforeDelay: true } }));
    runtime.config.command.push(scriptPath);
    await mkdir(join(runtime.dir, "input"));
    const amount = { tokens: 100, activeMs: 60_000, attempts: 1, sessions: 1 };
    const envelope: StartEnvelopeV1 = {
      protocol: 1,
      claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: canonicalHash(runtime.config), grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
      contractHash: "c".repeat(64),
      inputCheckpoint: null,
      work: { contract: runtime.contract, targetRepo: runtime.repo, base: "main", sourceDir: runtime.dir },
    };
    const controlDir = join(runtime.dir, "control");
    await ensurePrivateDirectory(runtime.dir, controlDir);
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(runtime.config)));
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
    await writeAccepted(runtime.dir, {
      protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
      generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
    });

    const worker = runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
    // Wait until execute is running and its stdout already shows usage, then latch a request whose deadline
    // falls inside the 30 s delay.
    const executeRoot = join(runtime.runDir, "codex", "1", "execute");
    await expect.poll(async () => {
      try {
        const [call] = await readdir(executeRoot);
        return call === undefined ? "" : await readFile(join(executeRoot, call, "events.jsonl"), "utf8");
      } catch { return ""; }
    }, { timeout: 10_000 }).toContain('"turn.completed"');
    const request: HandoffRequestV1 = { protocol: 1, requestId: "request-1", runId: "run-1", generation: 1, reason: "human", deadlineAt: new Date(Date.now() + 150).toISOString() };
    expect(await requestHandoff(envelope, request)).toEqual({ kind: "latched", requestId: "request-1" });
    await worker;

    expect(await readFile(`${runtime.marker}.calls`, "utf8")).toBe("plan\nexecute\n");
    // Killed during the delay: the script's file was never written into the attempt worktree's repository.
    expect(await readFile(join(runtime.repo, "answer.txt"), "utf8")).toBe("0\n");
    const collected = await collectExecution(envelope, 0);
    expect(collected.candidate).toMatchObject({ result: "partial", unresolvedRequestIds: [] });
    // Plan completed with 15; execute was aborted after reporting 15 more.
    expect(collected.events.map((event) => [event.bucket, event.cumulative?.tokens ?? null])).toEqual([
      ["work", 15],
      ["work", 30],
      ["handoff", 0],
    ]);
    const packet = JSON.parse((await readEvidence(runtime.dir, collected.candidate!.handoff)).toString("utf8"));
    expect(packet.request).toEqual(request);
    expect(await readFile(join(runtime.runDir, "events.jsonl"), "utf8")).toContain("handoff deadline interrupted execute in attempt 1");
  }, 30_000);
});
