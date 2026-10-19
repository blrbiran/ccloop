import { describe, expect, it } from "vitest";
import { normalizeExecutionFinal } from "../../src/runtime/executionNormalizer.js";
import { dropUnreported } from "../../src/runtime/reportedDecisions.js";

// Reported decisions and debug (ccloop spec 2026-10-20-reported-decisions-and-debug-design.md §4.1, §7 criteria 2-4, 6).
// Orca writes a run's ledger from the decisions its agent reported and a debug run's closing from its debug report; ccloop
// only carries them. Why each case matters: a run must never fail because of what is inside them (C1), and an answer that
// reports nothing must keep today's bytes, because saved-result recovery pins the hash of the normalized execution.
const complete = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: ["ran"], stdoutStderrLog: "ok" };
const partial = { ...complete, completionStatus: "partial", failureType: "error", failureMessage: "stopped" };
const major = { question: "Retry inside the client or the caller?", chose: "caller", alternatives: [{ option: "client", why_not: "hides failures" }],
  because: "the caller owns the budget", undo: { how: "restore the retry loop in src/client.ts", cost: "small", blast_radius: "src/client.ts" },
  scope: "repo", kind: "interface", importance: "major" };
const minor = { ...major, question: "Name the helper?", chose: "retryOnce", kind: "implementation", scope: "file", importance: "minor" };
const debug = { choseInstead: "fix the parser", reproTests: ["tests/parser.test.ts"], reproCommand: "npx vitest run tests/parser.test.ts" };
const codexNothing = { decisions: null, debug: { choseInstead: null, reproTests: null, reproCommand: null, reproduction: null, reproductionReason: null } };

const normalized = (body: unknown) => {
  const result = normalizeExecutionFinal(JSON.stringify(body));
  if (result.status !== "available") throw new Error(`unavailable: ${result.reason}`);
  return result.execution;
};

describe("reported decisions and debug in the codex/omp execute normalization", () => {
  for (const body of [complete, partial]) for (const wrapped of [false, true]) {
    it(`criterion 1: carries decisions (major and minor) and debug of a ${body === partial ? "partial" : "complete"} ${wrapped ? "envelope" : "direct"} answer unchanged`, () => {
      const answer = { ...body, decisions: [major, minor], debug };
      const execution = normalized(wrapped ? { result: answer } : answer) as Record<string, unknown>;
      expect(execution.decisions).toEqual([major, minor]);
      expect(execution.debug).toEqual(debug);
      expect(execution).toMatchObject(body);
    });
  }

  it.each([
    ["a string", "x"],
    ["an item missing members", [{ question: "only a question" }]],
    ["a number item", [7]],
  ])("criterion 2 (C1): %s as decisions does not make the answer unavailable and is kept as given", (_name, decisions) => {
    const execution = normalized({ ...complete, decisions, debug: "not an object" }) as Record<string, unknown>;
    expect(execution.decisions).toEqual(decisions);
    expect(execution.debug).toBe("not an object");
  });

  it("criterion 3: codex's 'reported nothing' (null decisions, all-null debug) normalizes to the bytes of the same answer without the keys", () => {
    for (const body of [complete, partial]) for (const wrapped of [false, true]) {
      const plain = JSON.stringify(normalized(wrapped ? { result: body } : body));
      const answer = { ...body, ...codexNothing };
      expect(JSON.stringify(normalized(wrapped ? { result: answer } : answer))).toBe(plain);
    }
  });

  it("criterion 3: decisions [] is kept; a debug with some null members keeps only the others", () => {
    const execution = normalized({ ...complete, decisions: [], debug: { ...codexNothing.debug, reproduction: "not-expressible", reproductionReason: "timing" } }) as Record<string, unknown>;
    expect(execution.decisions).toEqual([]);
    expect(execution.debug).toEqual({ reproduction: "not-expressible", reproductionReason: "timing" });
  });

  it("criterion 4: a decisions value over 65536 bytes is removed and the answer is still available; one at the limit is kept", () => {
    // `["` + text + `"]` is the value's UTF-8 JSON: 4 bytes of punctuation.
    const atLimit = ["x".repeat(65536 - 4)], overLimit = ["x".repeat(65536 - 3)];
    expect((normalized({ ...complete, decisions: atLimit }) as Record<string, unknown>).decisions).toEqual(atLimit);
    const over = normalized({ ...complete, decisions: overLimit, debug }) as Record<string, unknown>;
    expect(Object.hasOwn(over, "decisions")).toBe(false);
    expect(over.debug).toEqual(debug);
    expect(over).toMatchObject(complete);
    const overDebug = normalized({ ...complete, debug: { choseInstead: "y".repeat(70000) } }) as Record<string, unknown>;
    expect(Object.hasOwn(overDebug, "debug")).toBe(false);
  });

  it("criterion 6: an unknown top-level key is still refused, with or without reported decisions", () => {
    expect(normalizeExecutionFinal(JSON.stringify({ ...complete, decisions: [major], extra: 1 })).status).toBe("unavailable");
    expect(normalizeExecutionFinal(JSON.stringify({ result: { ...complete, debug, extra: 1 } })).status).toBe("unavailable");
  });
});

describe("the shared unreported step (claude's parsed answer)", () => {
  it("criterion 3: claude's decisions null normalizes to the bytes of the answer without it", () => {
    expect(JSON.stringify(dropUnreported({ ...complete, decisions: null }))).toBe(JSON.stringify(complete));
    expect(JSON.stringify(dropUnreported({ ...complete, decisions: null, debug: null }))).toBe(JSON.stringify(complete));
    expect(dropUnreported({ ...complete, decisions: [] })).toEqual({ ...complete, decisions: [] });
  });
});
