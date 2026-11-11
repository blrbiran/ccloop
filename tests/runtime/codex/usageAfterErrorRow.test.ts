import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runLoop } from "../../../src/controller/runLoop.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { observedTokensOf } from "../../../src/runtime/types.js";
import { codexFixture } from "./fixture.js";

// Tester follow-up E §1 (Orca issue #249): a mid-stream `error` row still fails the phase (codex-event-error, cause unchanged),
// but the usage the stream's turn.completed reported is spent money. It must ride on the error as observed tokens, so the
// run books it and failure-cause.json says usage was observed; without it Orca booked the call as unknown (the tester lost
// 2.58M and 4.50M tokens). A stream with no turn.completed has nothing to book and stays unobserved (null, never a guess).
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function failedCall(mode: string, phase: "plan" | "execute") {
  const f = await codexFixture(mode);
  dirs.push(f.dir);
  const adapter = new CodexAdapter(parseCodexConfig(f.config));
  const error = await (phase === "plan" ? adapter.plan(f.context) : adapter.execute(f.context)).then(() => null, (e: unknown) => e as Error);
  const root = join(f.runDir, "codex", "1", phase);
  const calls = await readdir(root);
  expect(calls).toHaveLength(1);
  const call = join(root, calls[0]!);
  return {
    error: error!,
    failureCause: JSON.parse(await readFile(join(call, "failure-cause.json"), "utf8")) as Record<string, unknown>,
    decodeError: await readFile(join(call, "decode-error.txt"), "utf8"),
  };
}

for (const phase of ["plan", "execute"] as const) {
  it(`${phase}: an error row before a completed turn fails the phase but carries the turn's usage (12 + 3)`, async () => {
    const out = await failedCall("error-then-usage", phase);
    expect(out.error).toBeInstanceOf(Error);
    expect(out.error.message).toMatch(/^Error: codex-event-error: /);
    expect(out.decodeError).toBe("Error: codex-event-error");
    // Soft: the error's tokens and the call's failure-cause.json are each measured, not hidden behind the other.
    expect.soft(observedTokensOf(out.error)).toBe(15);
    expect.soft(out.failureCause).toEqual({ cause: "unknown", workObserved: true, call: 1, nextDelayMs: null, detail: null, usageObserved: true });
  }, 30_000);

  it(`${phase}: an error row with no completed turn still has no observed usage`, async () => {
    const out = await failedCall("error-no-usage", phase);
    expect(out.error.message).toMatch(/^Error: codex-event-error: /);
    expect(observedTokensOf(out.error)).toBeNull();
    expect(out.failureCause).toMatchObject({ cause: "unknown", usageObserved: false });
  }, 30_000);
}

it("the run books the failed plan's turn usage instead of leaving it unknown", async () => {
  const f = await codexFixture("error-then-usage");
  dirs.push(f.dir);
  const settled: { phase: string; tokenUsage: number | null }[] = [];
  const state = await runLoop(f.contract, f.runDir, new CodexAdapter(parseCodexConfig(f.config)), {
    onPhaseSettled: async ({ phase, tokenUsage }) => { settled.push({ phase, tokenUsage }); },
  });
  expect(state.status).toBe("failed");
  expect(state.failureCause).toMatchObject({ cause: "unknown", phase: "plan" });
  expect(settled).toEqual([{ phase: "plan", tokenUsage: 15 }]);
  expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(1000 - 15);
}, 30_000);
