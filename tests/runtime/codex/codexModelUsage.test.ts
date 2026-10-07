import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { codexModelUsage, decodeCodexResult } from "../../../src/runtime/codex/protocol.js";
import { codexFixture } from "./fixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const completed = (usage: Record<string, number>) => JSON.stringify({ type: "turn.completed", usage }) + "\n";
const plan = JSON.stringify({ summary: "s", primaryTargetPaths: [] });

describe("codexModelUsage", () => {
  // Why: the breakdown is only usable by the worker when it adds up to the total the phase already reported.
  it("splits cached input out and reconciles with decodeCodexResult's tokenUsage", () => {
    const events = completed({ input_tokens: 15, output_tokens: 3, cached_input_tokens: 5 });
    const usage = codexModelUsage(events, "gpt-x");
    expect(usage).toEqual([{ model: "gpt-x", input: 10, output: 3, cacheRead: 5, cacheWrite: 0 }]);
    const entryTotal = usage!.reduce((n, e) => n + e.input + e.output + e.cacheRead + e.cacheWrite, 0);
    expect(entryTotal).toBe(18);
    expect(decodeCodexResult("plan", events, plan).tokenUsage).toBe(18);
  });
  it("without cached_input_tokens all input is non-cached", () => {
    expect(codexModelUsage(completed({ input_tokens: 15, output_tokens: 3 }), "gpt-x")).toEqual([{ model: "gpt-x", input: 15, output: 3, cacheRead: 0, cacheWrite: 0 }]);
  });
  it("is null without a completion, and for a model name the schema would refuse", () => {
    expect(codexModelUsage(JSON.stringify({ type: "item.completed" }) + "\n", "gpt-x")).toBeNull();
    expect(codexModelUsage(completed({ input_tokens: 1, output_tokens: 1 }), "")).toBeNull();
    expect(codexModelUsage(completed({ input_tokens: 1, output_tokens: 1 }), "m".repeat(201))).toBeNull();
  });
});

describe("Codex adapter model usage", () => {
  it("attaches the configured model's usage to every phase result", async () => {
    const f = await codexFixture(); dirs.push(f.dir);
    const adapter = new CodexAdapter(f.config);
    for (const phase of ["plan", "execute", "verify"] as const) {
      expect(await adapter[phase](f.context)).toMatchObject({ tokenUsage: 15, modelUsage: [{ model: "fixture", input: 12, output: 3, cacheRead: 0, cacheWrite: 0 }] });
    }
  });
});
