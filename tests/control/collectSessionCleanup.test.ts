import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExecution } from "../../src/control/collect.js";
import { runControlCommand } from "../../src/control/command.js";
import { canonicalHash, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { createContract } from "../controller/optionalFixture.js";
import { FIXTURE_SELECTION } from "./agentsFixture.js";

// Orca tester #349 (human's ruling, session 4389b15f, 2026-11-18): a Codex session ccloop could not delete leaves the
// call's prompt in a private rollout. Collect is how Orca learns of it, so the person sees a standing notice with the
// command to delete it -- until the session is gone. Nothing failed => the key is absent and collect's bytes are unchanged.

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ID = "01a13431-3db4-73a1-afd1-154f0477282d";

async function world() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-collect-cleanup-"))); roots.push(root);
  await mkdir(join(root, "input"));
  const contract = createContract(root, ["true"], 1);
  const amount = { tokens: 1, activeMs: 1, attempts: 1, sessions: 1 };
  const envelope = {
    protocol: 3, claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: "c".repeat(64), agent: FIXTURE_SELECTION, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: canonicalHash(contract), inputCheckpoint: null, work: { kind: "loop", contract, targetRepo: root, base: "main", sourceDir: root },
  } as LoopStartEnvelope;
  const run = join(root, "run");
  await mkdir(run, { recursive: true, mode: 0o700 });
  await writeFile(join(run, "loop-state.json"), JSON.stringify({ status: "succeeded", currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-11-18T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 0, timeRemainingMs: 1_000, tokenBudgetRemaining: 1 }, recentFailures: [] }));
  const codexHome = join(root, "cache", "codex-home", "abc", "codex-home");
  const sessions = join(codexHome, "sessions", "2026", "11", "18");
  await mkdir(sessions, { recursive: true });
  const rolloutPath = join(sessions, `rollout-2026-11-18T00-00-00-${ID}.jsonl`);
  await writeFile(rolloutPath, "private prompt");
  const failed = async (call: string, state: string, body?: string) => {
    const dir = join(run, "codex", "1", "plan", call);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "session-cleanup-failed.json"), body ?? JSON.stringify({ schema: "ccloop-session-cleanup-failed-v1", threadId: ID, home: codexHome,
      command: ["/bin/codex", "delete", "--force", ID], exitCode: 1, signal: null, stderr: "Error: failed to delete session\n",
      detail: "exit 1: Error: failed to delete session", state, at: "2026-11-18T00:00:00.000Z" }), { mode: 0o600 });
    return dir;
  };
  const collect = async () => {
    const answer = await runControlCommand(["collect", "--agents", join(root, "absent-agents.json")], JSON.stringify({ input: envelope, afterSeq: 0 }));
    expect(answer.code, answer.stderr).toBe(0);
    return JSON.parse(answer.stdout) as Record<string, unknown>;
  };
  return { root, envelope, codexHome, rolloutPath, failed, collect };
}

describe("collect lists the run's Codex sessions that could not be deleted (Orca #349)", () => {
  it("is absent when no deletion failed", async () => {
    const w = await world();
    expect(Object.hasOwn(await collectExecution(w.envelope, 0), "sessionCleanup")).toBe(false);
    expect(Object.hasOwn(await w.collect(), "sessionCleanup")).toBe(false);
  });

  it("lists a failed and a retry-failed deletion through the strict collect schema", async () => {
    const w = await world();
    await w.failed("call-aaaaaa", "failed");
    await w.failed("call-bbbbbb", "retry-failed");
    const entry = (state: string) => ({ threadId: ID, home: w.codexHome, state, detail: "exit 1: Error: failed to delete session" });
    expect((await w.collect()).sessionCleanup).toEqual([entry("failed"), entry("retry-failed")]);
  });

  it("drops a call the sweep cleaned since", async () => {
    const w = await world();
    const dir = await w.failed("call-aaaaaa", "failed");
    await writeFile(join(dir, "session-cleaned.json"), JSON.stringify({ threadId: ID }));
    expect(Object.hasOwn(await collectExecution(w.envelope, 0), "sessionCleanup")).toBe(false);
  });

  it("drops a session a person deleted by hand (its rollout is gone)", async () => {
    const w = await world();
    await w.failed("call-bbbbbb", "retry-failed");
    await unlink(w.rolloutPath);
    expect(Object.hasOwn(await collectExecution(w.envelope, 0), "sessionCleanup")).toBe(false);
  });

  it("ignores a malformed record rather than failing collect", async () => {
    const w = await world();
    await w.failed("call-aaaaaa", "failed", "not json");
    await w.failed("call-bbbbbb", "failed", JSON.stringify({ threadId: ID, home: "relative", state: "failed", detail: "x" }));
    await w.failed("call-cccccc", "failed");
    expect((await collectExecution(w.envelope, 0)).sessionCleanup).toEqual([{ threadId: ID, home: w.codexHome, state: "failed", detail: "exit 1: Error: failed to delete session" }]);
  });
});
