// Memory in runs (Orca spec 2026-11-20-memory-in-runs-and-read-api-design.md §3): only plan and execute prompts receive the
// memory text, encoded as a JSON string exactly as the operator note is -- memory rows (tool_output, auto_inferred,
// external) are untrusted text, so raw insertion under a delimiter would let a row forge prompt structure. Verify never
// sees it; an attempt without memory yields today's bytes.
//
// Mutation named by the criterion: add `...memoryLines(context.memory)` to `buildVerifierPrompt` (or spread memory into
// the verify attempt context and render it there). The verify assertions here -- builder and every kind's real adapter --
// must go red.
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "../../src/runtime/claude/prompts.js";
import type { RunMemory } from "../../src/runtime/types.js";
import { realAdapter } from "./realAdapterFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const TEXT = '## ccmem context\n- (decision) use "median" helper, not a dependency\n- 中文\n';
const MEMORY: RunMemory = { format: "ccloop-memory-v1", sha256: createHash("sha256").update(TEXT).digest("hex"), tokens: 30, ids: [1042, 1057], text: TEXT };
const ENCODED = JSON.stringify(TEXT);

describe("memory lines in the prompt builders", () => {
  it("plan and execute carry the text JSON-encoded; verify adds no bytes", async () => {
    const { f } = await realAdapter("claude", roots);
    const plan = buildPlannerPrompt(f.context.contract, undefined, undefined, undefined, { ...f.context, memory: MEMORY });
    const execute = buildExecutorPrompt({ ...f.context, memory: MEMORY });
    for (const prompt of [plan, execute]) {
      expect(prompt).toContain(`\n${ENCODED}\n`);
      // JSON encoding, not the raw row text: a raw newline inside the memory never reaches the prompt.
      expect(prompt).not.toContain("- (decision) use \"median\" helper, not a dependency\n- 中文");
    }
    const execution = { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
    expect(buildVerifierPrompt({ ...f.context, execution, memory: MEMORY })).toBe(buildVerifierPrompt({ ...f.context, execution }));
    expect(buildVerifierPrompt({ ...f.context, execution, memory: MEMORY })).not.toContain(ENCODED);
  });

  it("without memory the plan and execute prompts are byte-identical to today's", async () => {
    const { f } = await realAdapter("claude", roots);
    expect(buildPlannerPrompt(f.context.contract, undefined, undefined, undefined, { ...f.context, memory: undefined }))
      .toBe(buildPlannerPrompt(f.context.contract, undefined, undefined, undefined, f.context));
    expect(buildExecutorPrompt({ ...f.context, memory: undefined })).toBe(buildExecutorPrompt(f.context));
  });
});

describe("each kind's real adapter sends memory in plan and execute, never in verify", () => {
  it.each(["claude", "codex", "omp"] as const)("%s plan", async kind => {
    const { f, adapter, prompt } = await realAdapter(kind, roots);
    await adapter.plan({ ...f.context, memory: MEMORY });
    const sent = await prompt();
    expect(sent).toContain(`\n${ENCODED}\n`);
  }, 30_000);

  it.each(["claude", "codex", "omp"] as const)("%s execute", async kind => {
    const { f, adapter, prompt } = await realAdapter(kind, roots);
    await adapter.execute({ ...f.context, plan: { summary: "s", primaryTargetPaths: ["answer.txt"] }, memory: MEMORY });
    const sent = await prompt();
    expect(sent).toContain(`\n${ENCODED}\n`);
  }, 30_000);

  it.each(["claude", "codex", "omp"] as const)("%s verify", async kind => {
    const { f, adapter, prompt } = await realAdapter(kind, roots);
    await adapter.verify({ ...f.context, execution: { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" }, memory: MEMORY });
    const sent = await prompt();
    expect(sent).not.toContain(ENCODED);
    expect(sent).not.toContain("ccmem context");
  }, 30_000);
});