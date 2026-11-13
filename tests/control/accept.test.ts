import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { resolveAgent } from "../../src/agents/materialize.js";
import { acceptStart, inspectStart } from "../../src/control/accept.js";
import { runControlCommand } from "../../src/control/command.js";
import { canonicalHash, canonicalJson, ControlProtocolError, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { claimAcceptedWorker, readAccepted, withAcceptedLock, writeAccepted, type AcceptedRecordV1 } from "../../src/control/store.js";
import { readProcessStartedAt } from "../../src/control/workerLauncher.js";
import { codexInstallation, writeAgentsTable } from "./agentsFixture.js";

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

// Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): every criterion below
// accepts through an agents table (one codex installation for the same fake-codex command the v1 fixture named) and a
// protocol-2 envelope whose claim carries the resolved selection and the materialized config's canonical hash.
// ERRATUM (human ruling S6, 2026-09-27, session f341f05f): the envelope named above is now protocol 3, work tagged kind "loop".
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-accept-")));
  await mkdir(join(root, "input"));
  const installation = await codexInstallation({
    command: [process.execPath, resolve("tests/fixtures/fake-codex.mjs"), "success", join(root, "marker")],
    budgetMode: "soft",
    sandbox: "workspace-write",
    timeoutMs: 1_000,
    killGraceMs: 100,
  });
  const { path: tablePath, table } = await writeAgentsTable({ codex: installation }, root);
  const { config, resolution } = await resolveAgent(table, { agent: "codex", model: "fixture" });
  // Human ruling S6 (2026-09-27, session f341f05f): protocol 3 envelope
  const envelope: LoopStartEnvelope = {
    protocol: 3,
    claim: {
      groupId: "group-1",
      workItemId: "work-1",
      taskId: "task-1",
      runId: "run-1",
      generation: 1,
      graphVersion: 1,
      targetVersion: 1,
      commandId: "command-1",
      configHash: resolution.configHash,
      agent: resolution.selection,
      grant: { work: amount, handoff: amount },
      ownerToken: "owner-1",
    },
    contractHash: "b".repeat(64),
    inputCheckpoint: null,
    work: { kind: "loop", contract: contract(root), targetRepo: root, base: "main", sourceDir: root },
  };
  return { root, tablePath, config, envelope, launchFile: join(root, "agent-launches") };
}

function binding(tablePath: string, launchFile: string) {
  return {
    agentsTablePath: tablePath,
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
    const first = await acceptStart(f.envelope, binding(f.tablePath, f.launchFile));
    const second = await acceptStart(f.envelope, binding(f.tablePath, f.launchFile));
    expect(first.kind).toBe("accepted");
    expect(second).toEqual(first);
    await expect.poll(() => launchRows(f.launchFile)).toEqual(["launch"]);
    expect(["claimed", "sealed"]).toContain((await readAccepted(f.root)).launch);
  });

  it("serializes concurrent identical accepts into one durable launch", async () => {
    const f = await fixture();
    const [left, right] = await Promise.all([
      acceptStart(f.envelope, binding(f.tablePath, f.launchFile)),
      acceptStart(f.envelope, binding(f.tablePath, f.launchFile)),
    ]);
    expect([left.kind, right.kind]).toContain("accepted");
    expect([left.kind, right.kind].every((kind) => kind === "accepted" || kind === "unknown")).toBe(true);
    await expect.poll(() => launchRows(f.launchFile)).toEqual(["launch"]);
  });

  it("refuses the same identity with a different envelope", async () => {
    const f = await fixture();
    await acceptStart(f.envelope, binding(f.tablePath, f.launchFile));
    const changed = { ...f.envelope, contractHash: "c".repeat(64) };
    await expect(acceptStart(changed, binding(f.tablePath, f.launchFile))).rejects.toMatchObject({
      code: "control-envelope-conflict",
    });
  });

  it("recovers a dropped accept response through inspect without another worker", async () => {
    const f = await fixture();
    await acceptStart(f.envelope, binding(f.tablePath, f.launchFile));
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
    expect(await acceptStart(f.envelope, binding(f.tablePath, f.launchFile))).toEqual({ kind: "unknown" });
    await expect(readFile(f.launchFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): what accept seals is the
  // materialized agent config (installation plus filled selection), byte-for-byte its canonical JSON; rewriting the
  // table afterwards changes neither a replayed accept nor the sealed bytes (the replay never reads the table).
  it("seals the materialized agent config so later table drift has no effect", async () => {
    const f = await fixture();
    await acceptStart(f.envelope, binding(f.tablePath, f.launchFile));
    const sealed = await readFile(join(f.root, "control", "config.json"), "utf8");
    expect(sealed).toBe(`${canonicalJson(f.config)}\n`);
    await writeFile(f.tablePath, "{}\n");
    expect(await acceptStart(f.envelope, binding(f.tablePath, f.launchFile))).toMatchObject({ kind: "accepted" });
    expect(await readFile(join(f.root, "control", "config.json"), "utf8")).toBe(sealed);
  });

  it("rejects a claim config hash mismatch before creating a worker", async () => {
    const f = await fixture();
    const bad = { ...f.envelope, claim: { ...f.envelope.claim, configHash: "d".repeat(64) } };
    await expect(acceptStart(bad, binding(f.tablePath, f.launchFile))).rejects.toBeInstanceOf(
      ControlProtocolError,
    );
    await expect(readFile(f.launchFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// Orca follow-up J (#308, tester ledger issue-20261023 "Issue 308"; human, Orca session c8b75eac: 「本会话建议的顺序 => 同意」):
// a launch whose launcher gave up before any worker claimed it was recorded `launch: "unknown"`, `worker: null`, and was
// answered `unknown` for ever -- Orca blocked after ten inspections with nothing to recover. No worker can claim such an
// execution any more (a claim needs `intended` and the same execution id), so the launch provably never ran: inspect now
// says so (additive `launch: "never-claimed"`), and a re-issued accept launches it again under a fresh execution id.
describe("a launch no worker ever claimed (Orca follow-up J, #308)", () => {
  function neverClaimed(f: Awaited<ReturnType<typeof fixture>>): AcceptedRecordV1 {
    return {
      protocol: 1,
      envelopeHash: canonicalHash(f.envelope),
      executionId: "execution-1",
      configHash: f.envelope.claim.configHash,
      generation: 1,
      acceptedAt: new Date().toISOString(),
      launch: "unknown",
      worker: null,
    };
  }

  it("is reported never-claimed, and a re-issued accept launches it under a fresh execution id", async () => {
    const f = await fixture();
    await writeAccepted(f.root, neverClaimed(f));
    // mutation: status() without the never-claimed branch -> { kind: "unknown" }, red
    expect(await inspectStart(f.envelope)).toEqual({ kind: "unknown", launch: "never-claimed" });
    // mutation: acceptStart answers the existing record without relaunching -> never-claimed again, no launch, red
    const relaunched = await acceptStart(f.envelope, binding(f.tablePath, f.launchFile));
    expect(relaunched.kind).toBe("accepted");
    await expect.poll(() => launchRows(f.launchFile)).toEqual(["launch"]);
    // mutation: the relaunch keeps executionId "execution-1" -> a late worker of the first launch could claim it, red
    const record = await readAccepted(f.root);
    expect(record.executionId).not.toBe("execution-1");
    expect(relaunched).toEqual({ kind: "accepted", executionId: record.executionId, configHash: f.envelope.claim.configHash });
    const startedAt = await readProcessStartedAt(process.pid);
    expect(await claimAcceptedWorker(f.root, { executionId: "execution-1", nonce: "late", pid: process.pid, startedAt: startedAt! })).toBe(false);
    // An intended record (the launcher may still be running) is not never-claimed: the criterion above
    // "keeps an intended crash ambiguous and never launches a replacement" still holds unchanged.
  });

  it("relaunches only while the record is still never-claimed when the accept takes the lock", async () => {
    const f = await fixture();
    await writeAccepted(f.root, neverClaimed(f));
    const startedAt = await readProcessStartedAt(process.pid);
    const claimed: AcceptedRecordV1 = { ...neverClaimed(f), launch: "claimed", worker: { pid: process.pid, startedAt: startedAt!, nonce: "other" } };
    let accept: Promise<unknown> | undefined;
    await withAcceptedLock(f.root, async () => {
      // The accept reads the never-claimed record, then waits on this lock (its aside file shows it is waiting) ...
      accept = acceptStart(f.envelope, binding(f.tablePath, f.launchFile));
      await expect.poll(async () => (await readdir(join(f.root, "control"))).some((name) => /^accepted\.lock\.[0-9a-f-]{36}$/.test(name))).toBe(true);
      // ... while another launch claims the execution.
      await writeAccepted(f.root, claimed);
    });
    // mutation: drop the re-check under the lock -> the claimed record is overwritten and a second worker launched, red
    expect(await accept).toEqual({ kind: "accepted", executionId: "execution-1", configHash: f.envelope.claim.configHash });
    expect(await readAccepted(f.root)).toEqual(claimed);
    expect(await launchRows(f.launchFile)).toEqual([]);
  });

  it("prints never-claimed on the wire (`ccloop control inspect`)", async () => {
    const f = await fixture();
    await writeAccepted(f.root, neverClaimed(f));
    // mutation: the response schema without the optional `launch` key -> control-response-invalid, exit 1, red
    expect(await runControlCommand(["inspect", "--agents", f.tablePath], JSON.stringify(f.envelope))).toEqual({
      code: 0, stdout: `${JSON.stringify({ kind: "unknown", launch: "never-claimed" })}\n`, stderr: "",
    });
  });

  it("records a worker command that cannot be spawned as never-claimed, and recovers it", async () => {
    const f = await fixture();
    const missing = { ...binding(f.tablePath, f.launchFile), workerCommand: [join(f.root, "no-such-worker")] };
    // mutation: no 'error' listener on the spawned child -> the unheard spawn error is thrown out of the process, red
    expect(await acceptStart(f.envelope, missing)).toEqual({ kind: "unknown", launch: "never-claimed" });
    expect(await readAccepted(f.root)).toMatchObject({ launch: "unknown", worker: null });
    expect(await inspectStart(f.envelope)).toEqual({ kind: "unknown", launch: "never-claimed" });
    expect(await acceptStart(f.envelope, binding(f.tablePath, f.launchFile))).toMatchObject({ kind: "accepted" });
    await expect.poll(() => launchRows(f.launchFile)).toEqual(["launch"]);
  });
});
