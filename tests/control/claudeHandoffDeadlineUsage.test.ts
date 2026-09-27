import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestHandoff } from "../../src/control/handoff.js";
import { collectExecution } from "../../src/control/collect.js";
import { readEvidence } from "../../src/control/evidence.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type HandoffRequestV1, type StartEnvelopeV2 } from "../../src/control/protocol.js";
import { FAKE_CLAUDE_CLI, claudeInstallation, sealClaude } from "./agentsFixture.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture } from "../runtime/codex/fixture.js";

// Orca claude stream usage (2026-09-27), spec §5.2 N8, the claude twin of Orca handoff delivery's C-3 (option
// (i)): a control run whose execute phase a handoff deadline aborts after claude streamed usage (but before its
// closing result envelope) books the usage it streamed as a known cumulative (not null), so Orca does not have
// to treat the run's usage as unknown. Additive only (ccloop Rule 15): the codex criterion this is copied from
// stays as it is.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("deadline-aborted claude execute with observed usage (Orca claude stream usage C-3)", () => {
  it("books the observed tokens as a known cumulative and still hands off a partial candidate that answers its request", async () => {
    const runtime = await codexFixture("script");
    dirs.push(runtime.dir);
    const scriptPath = join(runtime.dir, "script.json");
    await writeFile(scriptPath, JSON.stringify({ "codex-test": { files: { "answer.txt": "42\n" }, delayMs: { execute: 30_000 }, usageBeforeDelay: true } }));
    await mkdir(join(runtime.dir, "input"));
    // Orca claude stream usage (2026-09-27), spec §5.2 N8: the worker reads the sealed materialized claude
    // config for the fake claude CLI's script mode and a protocol-2 envelope carrying its hash and selection;
    // the booked-usage, partial-candidate and packet assertions mirror the codex criterion this is copied from.
    const installation = await claudeInstallation([process.execPath, FAKE_CLAUDE_CLI, "script", runtime.marker, scriptPath], { timeoutMs: 60_000, killGraceMs: 300 });
    const sealed = await sealClaude(installation);
    const amount = { tokens: 100, activeMs: 60_000, attempts: 1, sessions: 1 };
    const envelope: StartEnvelopeV2 = {
      protocol: 2,
      claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
      contractHash: "c".repeat(64),
      inputCheckpoint: null,
      work: { contract: runtime.contract, targetRepo: runtime.repo, base: "main", sourceDir: runtime.dir },
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
    // Wait until execute is running and has already streamed a closed message's usage to its evidence
    // directory, then latch a request whose deadline falls inside the 30 s delay.
    const executeRoot = join(runtime.runDir, "claude", "1", "execute");
    // Orca claude stream usage (2026-09-27), final-review ruling in the round's ledger: wait until the fake's message is closed (openMessage false), not merely until the file exists -- message_start and the tail are separate writes, so an existence wait can abort at the 1103 snapshot.
    await expect.poll(async () => {
      try {
        const [call] = await readdir(executeRoot);
        if (call === undefined) return false;
        const contents = await readFile(join(executeRoot, call, "observed-usage.json"), "utf8");
        return JSON.parse(contents).openMessage === false;
      } catch { return false; }
    }, { timeout: 10_000 }).toBe(true);
    const request: HandoffRequestV1 = { protocol: 1, requestId: "request-1", runId: "run-1", generation: 1, reason: "human", deadlineAt: new Date(Date.now() + 150).toISOString() };
    expect(await requestHandoff(envelope, request)).toEqual({ kind: "latched", requestId: "request-1" });
    await worker;

    expect(await readFile(`${runtime.marker}.calls`, "utf8")).toBe("plan\nexecute\n");
    // Killed during the delay: the script's file was never written into the attempt worktree's repository.
    expect(await readFile(join(runtime.repo, "answer.txt"), "utf8")).toBe("0\n");
    const collected = await collectExecution(envelope, 0);
    expect(collected.candidate).toMatchObject({ result: "partial", unresolvedRequestIds: [] });
    // Plan completed and booked its result envelope's own usage (15); execute was aborted after streaming one
    // closed message's usage (1109) that the runner observed before the delay.
    expect(collected.events.map((event) => [event.bucket, event.cumulative?.tokens ?? null])).toEqual([
      ["work", 15],
      ["work", 1124],
      ["handoff", 0],
    ]);
    const packet = JSON.parse((await readEvidence(runtime.dir, collected.candidate!.handoff)).toString("utf8"));
    expect(packet.request).toEqual(request);
    expect(await readFile(join(runtime.runDir, "events.jsonl"), "utf8")).toContain("handoff deadline interrupted execute in attempt 1");
  }, 30_000);
});
