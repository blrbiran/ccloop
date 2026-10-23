// Operator note (Orca spec docs/superpowers/specs/2026-10-23-live-transcript-design.md §10.2.6, criterion L6). A person
// leaves a note for the next attempt of a running step. Without a note the start envelope must hash exactly as before (Orca
// and ccloop agree on the envelope by hash). The note must reach plan and execute even when the run already failed once --
// that is when a person writes one -- so it cannot share priorFailureLines, which drops its input then. Verify never sees
// it: the verifier judges the attempt against the contract, not against what the person asked the agent.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHash, parseControlRequest } from "../../src/control/protocol.js";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../../src/runtime/claude/prompts.js";
import { operatorNoteGate } from "../../src/runtime/operatorNote.js";
import type { AttemptContext, OperatorNote } from "../../src/runtime/types.js";
import { fixture } from "../control/optionalFixture.js";
import { codexFixture } from "./codex/fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const NOTE: OperatorNote = { text: "Use the existing median helper in src/stats.ts; do not add a dependency. 中文", scope: "next-attempt" };
const LAST = { rejectCategory: "required-check-failed", failingCommand: "node check-median.js", evidence: ["TypeError: median is not a function"] };
const PRIOR = [{ rejectCategory: "run-failed:stalled", failingCommand: null, evidence: null }];

async function context(): Promise<AttemptContext> {
  const f = await codexFixture("ok"); roots.push(f.dir);
  return { ...f.context, plan: { summary: "s", primaryTargetPaths: ["answer.txt"] }, execution: { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" } };
}

describe("work.operatorNote on the start envelope", () => {
  it("absent: parses without the key and hashes as the envelope itself; present: kept byte for byte, bounded", async () => {
    const { root, envelope } = await fixture(); roots.push(root);
    const parsed = parseControlRequest("accept", envelope) as { work: object };
    expect(Object.keys(parsed.work)).not.toContain("operatorNote");
    expect(canonicalHash(parsed)).toBe(canonicalHash(envelope));
    const withNote = { ...envelope, work: { ...envelope.work, operatorNote: NOTE } };
    expect(parseControlRequest("accept", withNote)).toEqual(withNote);
    const v4 = { ...withNote, protocol: 4 };
    expect(parseControlRequest("accept", v4)).toEqual(v4);
    const refused = (note: unknown) => expect(() => parseControlRequest("accept", { ...envelope, work: { ...envelope.work, operatorNote: note } })).toThrow("control-request-invalid");
    parseControlRequest("accept", { ...envelope, work: { ...envelope.work, operatorNote: { text: "é".repeat(2048), scope: "remaining-attempts" } } });
    refused({ text: `${"é".repeat(2048)}x`, scope: "next-attempt" });
    refused({ text: "", scope: "next-attempt" });
    refused({ text: "t", scope: "every-step" });
    refused({ text: "t", scope: "next-attempt", by: "someone" });
  });
});

describe("the note in the prompts", () => {
  it("is rendered in plan and execute even when the run has its own last failure, and never in verify", async () => {
    const ctx = await context();
    const encoded = JSON.stringify(NOTE.text);
    const plan = buildPlannerPrompt(ctx.contract, LAST, PRIOR, NOTE);
    const execute = buildExecutorPrompt({ ...ctx, lastFailure: LAST, priorFailures: PRIOR, operatorNote: NOTE });
    for (const prompt of [plan, execute]) {
      expect(prompt).toContain(`\n${encoded}\n`);
      expect(prompt.indexOf(encoded)).toBeLessThan(prompt.lastIndexOf("Your final message must be exactly one JSON object"));
    }
    expect(buildVerifierPrompt({ ...ctx, lastFailure: LAST, operatorNote: NOTE })).not.toContain("left a note");
    expect(buildVerifierPrompt({ ...ctx, lastFailure: LAST, operatorNote: NOTE })).not.toContain("median helper");
  });

  it("without a note, plan and execute prompts are byte-identical to before", async () => {
    const ctx = await context();
    expect(buildPlannerPrompt(ctx.contract, LAST, PRIOR, undefined)).toBe(buildPlannerPrompt(ctx.contract, LAST, PRIOR));
    expect(buildExecutorPrompt({ ...ctx, operatorNote: undefined })).toBe(buildExecutorPrompt(ctx));
  });
});

describe("which attempts get the note", () => {
  it("next-attempt: only the first attempt this run plans or executes, even when that is not the run's first attempt", () => {
    const gate = operatorNoteGate(NOTE);
    // A continuation that resumed attempt 2 at verify plans next at attempt 3.
    expect(gate(3)).toEqual({ operatorNote: NOTE });
    expect(gate(3)).toEqual({ operatorNote: NOTE });
    expect(gate(4)).toEqual({});
  });
  it("remaining-attempts: every attempt; no note: nothing", () => {
    const gate = operatorNoteGate({ ...NOTE, scope: "remaining-attempts" });
    expect([gate(1), gate(2), gate(5)].every((value) => value.operatorNote !== undefined)).toBe(true);
    expect(operatorNoteGate(undefined)(1)).toEqual({});
  });
});
