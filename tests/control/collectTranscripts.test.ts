import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExecution } from "../../src/control/collect.js";
import { runControlCommand } from "../../src/control/command.js";
import { canonicalHash, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { createContract } from "../controller/optionalFixture.js";
import { FIXTURE_SELECTION } from "./agentsFixture.js";

// Live transcript (Orca spec 2026-10-23 §10.2.4, criterion L5). Orca finds a run's transcripts only through collect, never by
// walking ccloop's directories, and asks `features` whether this ccloop lists them at all. Call directories are mkdtemp
// names, so their order means nothing: a listing by name would replay a run's retries out of order. A call whose worker
// died never writes outcome.json, so `final` must also follow the run's end, or Orca would poll that call forever.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function world(status: "succeeded" | "executing") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-collect-transcripts-"))); roots.push(root);
  await mkdir(join(root, "input"));
  const contract = createContract(root, ["true"], 1);
  const amount = { tokens: 1, activeMs: 1, attempts: 1, sessions: 1 };
  const envelope = {
    protocol: 3, claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: "c".repeat(64), agent: FIXTURE_SELECTION, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: canonicalHash(contract), inputCheckpoint: null, work: { kind: "loop", contract, targetRepo: root, base: "main", sourceDir: root },
  } as LoopStartEnvelope;
  const run = join(root, "run");
  await mkdir(run, { recursive: true, mode: 0o700 });
  await writeFile(join(run, "loop-state.json"), JSON.stringify({ status, currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-10-24T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 0, timeRemainingMs: 1_000, tokenBudgetRemaining: 1 }, recentFailures: [] }));
  return { root, run, envelope };
}

/** One call directory: process.json's startedAt (ps lstart, UTC), and which of transcript.jsonl / outcome.json exist. */
async function call(run: string, kind: string, attempt: number, phase: string, name: string, options: { startedAt?: string; transcript?: string; outcome?: boolean }) {
  const dir = join(run, kind, String(attempt), phase, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (options.startedAt !== undefined) await writeFile(join(dir, "process.json"), JSON.stringify({ pid: 1, pgid: 1, startedAt: options.startedAt, phase }), { mode: 0o600 });
  if (options.transcript !== undefined) await writeFile(join(dir, "transcript.jsonl"), options.transcript, { mode: 0o600 });
  if (options.outcome === true) await writeFile(join(dir, "outcome.json"), "{}", { mode: 0o600 });
}

describe("collect lists the run's transcripts", () => {
  it("features answers transcripts: v1", async () => {
    const w = await world("succeeded");
    const answer = await runControlCommand(["features", "--agents", join(w.root, "absent-agents.json")], "{}");
    expect(answer.code, answer.stderr).toBe(0);
    expect(JSON.parse(answer.stdout)).toMatchObject({ transcripts: "v1" });
  });

  it("orders a phase's calls by startedAt, not by their names, and lists a pre-change call with path null", async () => {
    const w = await world("executing");
    const line = '{"type":"assistant"}\n';
    // Names sort the other way round from the start times, and the directories are created in name order, so neither the
    // name nor the birth-time tie-break can produce the start-time order by accident.
    await call(w.run, "codex", 1, "plan", "call-aaaaaa", { startedAt: "Fri Oct 24 02:00:00 2026", transcript: "" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await call(w.run, "codex", 1, "plan", "call-mmmmmm", { startedAt: "Fri Oct 24 01:00:05 2026", transcript: line + line, outcome: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await call(w.run, "codex", 1, "plan", "call-zzzzzz", { startedAt: "Fri Oct 24 01:00:00 2026", transcript: line, outcome: true });
    await call(w.run, "codex", 1, "execute", "call-bbbbbb", { startedAt: "Fri Oct 24 03:00:00 2026", outcome: true });
    const report = await collectExecution(w.envelope, 0);
    expect(report.transcripts).toEqual([
      { attempt: 1, phase: "execute", seq: 1, path: null, bytes: 0, final: true, truncatedAt: null },
      { attempt: 1, phase: "plan", seq: 1, path: "codex/1/plan/call-zzzzzz/transcript.jsonl", bytes: line.length, final: true, truncatedAt: null },
      { attempt: 1, phase: "plan", seq: 2, path: "codex/1/plan/call-mmmmmm/transcript.jsonl", bytes: 2 * line.length, final: true, truncatedAt: null },
      // Still running: no outcome.json, and the run is not terminal.
      { attempt: 1, phase: "plan", seq: 3, path: "codex/1/plan/call-aaaaaa/transcript.jsonl", bytes: 0, final: false, truncatedAt: null },
    ]);
  });

  it("marks a call without outcome.json final once the run is terminal, and reads where a transcript stopped", async () => {
    const w = await world("succeeded");
    const kept = '{"type":"assistant"}\n';
    const marker = `${JSON.stringify({ type: "ccloop.transcript-truncated", atBytes: kept.length })}\n`;
    await call(w.run, "omp", 2, "verify", "call-abcdef", { startedAt: "Fri Oct 24 01:00:00 2026", transcript: kept + marker });
    await call(w.run, "omp", 1, "single-call", "call-ghijkl", { transcript: kept, outcome: true });
    const report = await collectExecution(w.envelope, 0);
    expect(report.transcripts).toEqual([
      { attempt: 1, phase: "single-call", seq: 1, path: "omp/1/single-call/call-ghijkl/transcript.jsonl", bytes: kept.length, final: true, truncatedAt: null },
      { attempt: 2, phase: "verify", seq: 1, path: "omp/2/verify/call-abcdef/transcript.jsonl", bytes: kept.length + marker.length, final: true, truncatedAt: kept.length },
    ]);
  });

  it("is absent when the run has no agent call, and passes the command's strict collect schema when present", async () => {
    const w = await world("executing");
    expect(Object.hasOwn(await collectExecution(w.envelope, 0), "transcripts")).toBe(false);
    await call(w.run, "claude", 1, "plan", "call-qwerty", { startedAt: "Fri Oct 24 01:00:00 2026", transcript: "{}\n" });
    const answer = await runControlCommand(["collect", "--agents", join(w.root, "absent-agents.json")], JSON.stringify({ input: w.envelope, afterSeq: 0 }));
    expect(answer.code, answer.stderr).toBe(0);
    expect((JSON.parse(answer.stdout) as { transcripts?: unknown }).transcripts).toEqual([{ attempt: 1, phase: "plan", seq: 1, path: "claude/1/plan/call-qwerty/transcript.jsonl", bytes: 3, final: false, truncatedAt: null }]);
  });

  it("leaves out a directory it cannot read and lists the rest (review minor, Orca session ffec7b28)", async () => {
    const w = await world("executing");
    await call(w.run, "codex", 1, "plan", "call-aaaaaa", { startedAt: "Fri Oct 24 01:00:00 2026", transcript: "{}\n", outcome: true });
    await call(w.run, "codex", 2, "plan", "call-bbbbbb", { startedAt: "Fri Oct 24 02:00:00 2026", transcript: "{}\n", outcome: true });
    const { chmod } = await import("node:fs/promises");
    await chmod(join(w.run, "codex", "1"), 0o000);
    try {
      const report = await collectExecution(w.envelope, 0);
      expect(report.transcripts).toEqual([{ attempt: 2, phase: "plan", seq: 1, path: "codex/2/plan/call-bbbbbb/transcript.jsonl", bytes: 3, final: true, truncatedAt: null }]);
    } finally { await chmod(join(w.run, "codex", "1"), 0o700); }
  });
});
