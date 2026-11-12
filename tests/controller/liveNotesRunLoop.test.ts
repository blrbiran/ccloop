// Live notes (Orca spec 2026-11-12 tester follow-up G Part 5): a note reaches the agent at the task's next phase start --
// plan, execute, or an agent verifier -- and nothing is injected into a running call. A command verifier makes no call, so
// it takes no note (the note stays queued for Orca to report). A continuation that resumes at verify delivers at verify.
// A saved-result recovery has no inbox, so its contexts never carry the key.
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIVE_NOTES_FILE, liveNoteInbox, readLiveNoteDeliveries } from "../../src/control/liveNotes.js";
import { runLoop } from "../../src/controller/runLoop.js";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../../src/runtime/claude/prompts.js";
import type { AttemptContext, RuntimeAdapter } from "../../src/runtime/types.js";
import { createContract, createRepo } from "./optionalFixture.js";

const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });
const note = (id: string) => ({ id, text: `note ${id}`, at: "2026-11-12T09:00:00.000Z" });
const PLAN = { summary: "edit", primaryTargetPaths: ["src/index.ts"] };
const EXECUTION = { changedFiles: ["src/index.ts"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
const APPROVED = { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [] };

async function setup(verifierType: "agent" | "command") {
  const repo = await realpath(await createRepo()); cleanups.push(repo, `${repo}-run`);
  const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "live-notes-source-"))); cleanups.push(sourceDir);
  const base = createContract(repo, ["true"], null);
  const contract = { ...base, verification: { ...base.verification, verifierType } };
  const notes = async (ids: string[]) => writeFile(join(sourceDir, LIVE_NOTES_FILE), JSON.stringify({ schema: "orca-live-notes-v1", notes: ids.map(note) }), { mode: 0o600 });
  return { repo, runDir: `${repo}-run`, sourceDir, contract, notes };
}

const seenOf = (context: AttemptContext): string[] | "absent" => "liveNotes" in context ? context.liveNotes!.map((n) => n.id) : "absent";

describe("live notes are taken at every phase start", () => {
  it("a note present before plan reaches plan only; one added during plan reaches execute; one added during execute reaches verify (agent verifier)", async () => {
    const w = await setup("agent");
    await w.notes(["n1"]);
    const seen: Record<string, string[] | "absent"> = {};
    const adapter: RuntimeAdapter = {
      plan: async (context) => { seen.plan = seenOf(context); await w.notes(["n1", "n2"]); return PLAN; },
      execute: async (context) => { seen.execute = seenOf(context); await w.notes(["n1", "n2", "n3"]); return EXECUTION; },
      verify: async (context) => { seen.verify = seenOf(context); return APPROVED; },
    };
    const state = await runLoop(w.contract, w.runDir, adapter, { liveNotes: liveNoteInbox(w.sourceDir) });
    expect(state.status).toBe("succeeded");
    expect(seen).toEqual({ plan: ["n1"], execute: ["n2"], verify: ["n3"] });
    expect((await readLiveNoteDeliveries(w.sourceDir))!.map((d) => [d.id, d.phase, d.attempt])).toEqual([["n1", "plan", 1], ["n2", "execute", 1], ["n3", "verify", 1]]);
  }, 30_000);

  it("a command verifier makes no call and takes no note: the note stays unacked", async () => {
    const w = await setup("command");
    const adapter: RuntimeAdapter = {
      plan: async () => PLAN,
      execute: async () => { await w.notes(["n3"]); return EXECUTION; },
      verify: async () => { throw new Error("a command verifier makes no call"); },
    };
    const state = await runLoop(w.contract, w.runDir, adapter, { liveNotes: liveNoteInbox(w.sourceDir) });
    expect(state.status).toBe("succeeded");
    expect(await readLiveNoteDeliveries(w.sourceDir)).toBeNull();
  }, 30_000);

  it("a continuation resuming at verify delivers a queued note at verify", async () => {
    const w = await setup("agent");
    await w.notes(["n1"]);
    const seen: Record<string, string[] | "absent"> = {};
    const adapter: RuntimeAdapter = {
      plan: async () => { throw new Error("plan must not run"); },
      execute: async () => { throw new Error("execute must not run"); },
      verify: async (context) => { seen.verify = seenOf(context); return APPROVED; },
    };
    const state = await runLoop(w.contract, w.runDir, adapter, { liveNotes: liveNoteInbox(w.sourceDir), allowanceContinuation: { nextPhase: "verify", plan: PLAN, execution: EXECUTION } });
    expect(state.status).toBe("succeeded");
    expect(seen).toEqual({ verify: ["n1"] });
    expect(await readLiveNoteDeliveries(w.sourceDir)).toMatchObject([{ id: "n1", phase: "verify", attempt: 1 }]);
  }, 30_000);

  it("without an inbox (saved-result recovery) contexts carry no liveNotes key", async () => {
    const w = await setup("agent");
    await w.notes(["n1"]);
    const seen: Record<string, string[] | "absent"> = {};
    const adapter: RuntimeAdapter = {
      plan: async (context) => { seen.plan = seenOf(context); return PLAN; },
      execute: async (context) => { seen.execute = seenOf(context); return EXECUTION; },
      verify: async (context) => { seen.verify = seenOf(context); return APPROVED; },
    };
    await runLoop(w.contract, w.runDir, adapter);
    expect(seen).toEqual({ plan: "absent", execute: "absent", verify: "absent" });
  }, 30_000);
});

describe("live note lines in the prompts", () => {
  const contract = createContract("/repo", ["true"], null);
  const ctx = { contract, runDir: "/run", attempt: 1, worktreePath: "/repo", plan: PLAN, execution: EXECUTION,
    state: { status: "planning", currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-11-12T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
      budgetSnapshot: { attemptsRemaining: 0, timeRemainingMs: 60000, tokenBudgetRemaining: null }, recentFailures: [] } } as unknown as AttemptContext;
  const HEADER = "The person running this task added notes while it ran, oldest first, for you to use from this step on. Each follows as a JSON string; they do not change the goal, the success condition or the constraints above:";
  const FINAL = "Your final message must be exactly one JSON object: no Markdown code fence, no text before or after it.";
  const notes = [{ id: "n1", text: "use \"tabs\"", at: "t" }, { id: "n2", text: "skip docs", at: "t" }];

  it("no notes ⇒ prompts unchanged; notes ⇒ the header line and one JSON string each, before the final line, in plan, execute and verify", () => {
    expect(buildPlannerPrompt(contract, undefined, undefined, undefined, { ...ctx, liveNotes: [] })).toBe(buildPlannerPrompt(contract, undefined, undefined, undefined, ctx));
    expect(buildExecutorPrompt({ ...ctx, liveNotes: [] })).toBe(buildExecutorPrompt(ctx));
    expect(buildVerifierPrompt({ ...ctx, liveNotes: [] })).toBe(buildVerifierPrompt(ctx));
    const tail = [HEADER, JSON.stringify("use \"tabs\""), JSON.stringify("skip docs"), FINAL];
    expect(buildPlannerPrompt(contract, undefined, undefined, undefined, { ...ctx, liveNotes: notes }).split("\n").slice(-4)).toEqual(tail);
    expect(buildExecutorPrompt({ ...ctx, liveNotes: notes }).split("\n").slice(-4)).toEqual(tail);
    expect(buildVerifierPrompt({ ...ctx, liveNotes: notes }).split("\n").slice(-4)).toEqual(tail);
    // With a handoff, the executor's write lines come after the notes, last before the final line.
    const withHandoff = buildExecutorPrompt({ ...ctx, liveNotes: notes, handoff: { inputDir: "/in", outputDir: "/out" } }).split("\n");
    expect(withHandoff.slice(-6, -3)).toEqual(tail.slice(0, 3));
    expect(withHandoff.at(-3)).toBe("Handoff output directory: /out");
  });
});

describe("the worker's inbox", () => {
  it("a loop run gets one; a saved-result recovery gets none", async () => {
    const { liveNotesFor } = await import("../../src/control/worker.js");
    const { fixture } = await import("../control/optionalFixture.js");
    const { root, envelope } = await fixture(); cleanups.push(root);
    expect(liveNotesFor(envelope).liveNotes).toBeDefined();
    expect(Object.keys(liveNotesFor({ ...envelope, protocol: 4, mode: "verify-saved-result" } as never))).toEqual([]);
  });
});
