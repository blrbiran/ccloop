import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExecution } from "../../src/control/collect.js";
import { runControlCommand } from "../../src/control/command.js";
import { canonicalHash, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { createContract } from "../controller/optionalFixture.js";
import { FIXTURE_SELECTION } from "./agentsFixture.js";

// Orca #116: a loop call that ended without a usage report (an omp timeout, say) leaves usage-lower-bound.json. Collect is
// how Orca learns of it, so the person settling the run sees "at least N tokens" instead of a bare "unknown".

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function world() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-collect-floor-"))); roots.push(root);
  await mkdir(join(root, "input"));
  const contract = createContract(root, ["true"], 1);
  const amount = { tokens: 1, activeMs: 1, attempts: 1, sessions: 1 };
  const envelope = {
    protocol: 3, claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: "c".repeat(64), agent: FIXTURE_SELECTION, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: canonicalHash(contract), inputCheckpoint: null, work: { kind: "loop", contract, targetRepo: root, base: "main", sourceDir: root },
  } as LoopStartEnvelope;
  const run = join(root, "run");
  await mkdir(run, { recursive: true, mode: 0o700 });
  await writeFile(join(run, "loop-state.json"), JSON.stringify({ status: "executing", currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-10-24T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 0, timeRemainingMs: 1_000, tokenBudgetRemaining: 1 }, recentFailures: [] }));
  const floor = async (attempt: number, phase: string, name: string, body: string) => {
    const dir = join(run, "omp", String(attempt), phase, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "usage-lower-bound.json"), body, { mode: 0o600 });
  };
  return { root, envelope, floor };
}

describe("collect carries the run's observed usage floor", () => {
  it("is absent when no call left one", async () => {
    const w = await world();
    expect(Object.hasOwn(await collectExecution(w.envelope, 0), "usageLowerBound")).toBe(false);
  });

  it("sums every call's floor, across attempts and phases", async () => {
    const w = await world();
    await w.floor(1, "execute", "call-aaaaaa", JSON.stringify({ tokens: 533_486 }));
    await w.floor(2, "plan", "call-bbbbbb", JSON.stringify({ tokens: 14 }));
    expect((await collectExecution(w.envelope, 0)).usageLowerBound).toEqual({ tokens: 533_500 });
  });

  it("ignores a malformed floor rather than failing collect", async () => {
    const w = await world();
    await w.floor(1, "execute", "call-aaaaaa", "not json");
    await w.floor(1, "execute", "call-bbbbbb", JSON.stringify({ tokens: -5 }));
    await w.floor(1, "execute", "call-cccccc", JSON.stringify({ tokens: 7 }));
    expect((await collectExecution(w.envelope, 0)).usageLowerBound).toEqual({ tokens: 7 });
  });

  it("passes the command's strict collect schema", async () => {
    const w = await world();
    await w.floor(1, "execute", "call-aaaaaa", JSON.stringify({ tokens: 9 }));
    const answer = await runControlCommand(["collect", "--agents", join(w.root, "absent-agents.json")], JSON.stringify({ input: w.envelope, afterSeq: 0 }));
    expect(answer.code, answer.stderr).toBe(0);
    expect((JSON.parse(answer.stdout) as { usageLowerBound?: unknown }).usageLowerBound).toEqual({ tokens: 9 });
  });
});
