import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { acceptStart, inspectStart } from "../../src/control/accept.js";
import { canonicalHash, ControlProtocolError, type StartEnvelopeV1 } from "../../src/control/protocol.js";
import { readAccepted, writeAccepted } from "../../src/control/store.js";

const amount = { tokens: 10, activeMs: 20, attempts: 1, sessions: 1 };
const worker = resolve("node_modules/.bin/tsx");
const workerFixture = resolve("tests/fixtures/control-worker.mjs");

function contract(root: string): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "work", successCondition: "done", nonGoals: [] },
    context: {
      repoPath: root,
      targetPaths: ["src"],
      relevantDocs: [],
      buildTestCommands: ["npm test"],
      constraints: [],
    },
    executionPolicy: {
      autonomyLevel: "L2" as const,
      maxAttempts: 2,
      perAttemptTimeoutMs: 1_000,
      totalRuntimeBudgetMs: 2_000,
      tokenBudget: 1_000,
      worktreeRequired: true as const,
      partialOutcomeRecoveryWindowMs: 100,
    },
    safetyPolicy: {
      allowlistPaths: ["src"],
      denylistPaths: [],
      maxFilesTouched: 10,
      humanGateConditions: [],
    },
    verification: {
      verifierType: "command" as const,
      requiredChecks: ["npm test"],
      rejectOn: ["failure"],
      evidenceRequired: [],
    },
    escalationAndExit: {
      escalationTargets: [],
      pauseOn: [],
      stopOn: [],
      terminalStates: [
        "succeeded",
        "blocked_waiting_human",
        "exhausted",
        "cancelled",
        "failed",
      ],
    },
  };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-accept-")));
  await mkdir(join(root, "input"));
  const configPath = join(root, "adapter.json");
  const config = {
    command: [process.execPath, resolve("tests/fixtures/fake-codex.mjs"), "success", join(root, "marker")],
    model: "fixture",
    budgetMode: "soft" as const,
    sandbox: "workspace-write" as const,
    timeoutMs: 1_000,
    killGraceMs: 100,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const envelope: StartEnvelopeV1 = {
    protocol: 1,
    claim: {
      groupId: "group-1",
      workItemId: "work-1",
      taskId: "task-1",
      runId: "run-1",
      generation: 1,
      graphVersion: 1,
      targetVersion: 1,
      commandId: "command-1",
      configHash: canonicalHash(config),
      grant: { work: amount, handoff: amount },
      ownerToken: "owner-1",
    },
    contractHash: "b".repeat(64),
    inputCheckpoint: null,
    work: { contract: contract(root), targetRepo: root, base: "main", sourceDir: root },
  };
  return { root, configPath, config, envelope, launchFile: join(root, "agent-launches") };
}

function binding(configPath: string, launchFile: string) {
  return {
    adapter: "codex" as const,
    adapterConfigPath: configPath,
    workerCommand: [worker, workerFixture],
    workerEnv: { CCLOOP_CONTROL_LAUNCH_FILE: launchFile },
    receiptTimeoutMs: 2_000,
  };
}

async function launchRows(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("durable control acceptance", () => {
  it("persists accepted before one exclusive worker claim and replays idempotently", async () => {
    const f = await fixture();
    const first = await acceptStart(f.envelope, binding(f.configPath, f.launchFile));
    const second = await acceptStart(f.envelope, binding(f.configPath, f.launchFile));
    expect(first.kind).toBe("accepted");
    expect(second).toEqual(first);
    await expect.poll(() => launchRows(f.launchFile)).toEqual(["launch"]);
    expect(["claimed", "sealed"]).toContain((await readAccepted(f.root)).launch);
  });

  it("serializes concurrent identical accepts into one durable launch", async () => {
    const f = await fixture();
    const [left, right] = await Promise.all([
      acceptStart(f.envelope, binding(f.configPath, f.launchFile)),
      acceptStart(f.envelope, binding(f.configPath, f.launchFile)),
    ]);
    expect([left.kind, right.kind]).toContain("accepted");
    expect([left.kind, right.kind].every((kind) => kind === "accepted" || kind === "unknown")).toBe(true);
    await expect.poll(() => launchRows(f.launchFile)).toEqual(["launch"]);
  });

  it("refuses the same identity with a different envelope", async () => {
    const f = await fixture();
    await acceptStart(f.envelope, binding(f.configPath, f.launchFile));
    const changed = { ...f.envelope, contractHash: "c".repeat(64) };
    await expect(acceptStart(changed, binding(f.configPath, f.launchFile))).rejects.toMatchObject({
      code: "control-envelope-conflict",
    });
  });

  it("recovers a dropped accept response through inspect without another worker", async () => {
    const f = await fixture();
    await acceptStart(f.envelope, binding(f.configPath, f.launchFile));
    const recovered = await inspectStart(f.envelope);
    expect(recovered.kind).toBe("accepted");
    await expect.poll(() => launchRows(f.launchFile)).toHaveLength(1);
  });

  it("keeps an intended crash ambiguous and never launches a replacement", async () => {
    const f = await fixture();
    await writeAccepted(f.root, {
      protocol: 1,
      envelopeHash: canonicalHash(f.envelope),
      executionId: "execution-1",
      configHash: f.envelope.claim.configHash,
      generation: 1,
      acceptedAt: new Date().toISOString(),
      launch: "intended",
      worker: null,
    });
    expect(await inspectStart(f.envelope)).toEqual({ kind: "unknown" });
    expect(await acceptStart(f.envelope, binding(f.configPath, f.launchFile))).toEqual({ kind: "unknown" });
    await expect(readFile(f.launchFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("seals the canonical config so later external drift has no effect", async () => {
    const f = await fixture();
    await acceptStart(f.envelope, binding(f.configPath, f.launchFile));
    const sealed = await readFile(join(f.root, "control", "config.json"), "utf8");
    await writeFile(f.configPath, "{}\n");
    expect(await acceptStart(f.envelope, binding(f.configPath, f.launchFile))).toMatchObject({ kind: "accepted" });
    expect(await readFile(join(f.root, "control", "config.json"), "utf8")).toBe(sealed);
  });

  it("rejects a claim config hash mismatch before creating a worker", async () => {
    const f = await fixture();
    const bad = { ...f.envelope, claim: { ...f.envelope.claim, configHash: "d".repeat(64) } };
    await expect(acceptStart(bad, binding(f.configPath, f.launchFile))).rejects.toBeInstanceOf(
      ControlProtocolError,
    );
    await expect(readFile(f.launchFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
