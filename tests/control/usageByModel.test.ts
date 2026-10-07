import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { usageEventSchema } from "../../src/control/command.js";
import { appendUsageObservation, readUsageEvents } from "../../src/control/usage.js";

async function root(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-usage-by-model-")));
}

function observation(observationId: string, threadTotalTokens: number | null, elapsedMs = 10) {
  return {
    runId: "run-1",
    generation: 1,
    bucket: "work" as const,
    observationId,
    threadTotalTokens,
    elapsedMs,
    attempts: 1,
    sessions: 1,
    evidence: { observationId, threadTotalTokens },
  };
}

const haiku = { model: "haiku", input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const opus = { model: "opus", input: 30, output: 10, cacheRead: 8, cacheWrite: 2 };

describe("per-model usage on events (Orca accounts spec §4.1)", () => {
  it("keeps a sorted breakdown on the event, absent when none was given, and refuses an unsorted one", async () => {
    const sourceDir = await root();
    const withBreakdown = await appendUsageObservation(sourceDir, { ...observation("p1", 65), byModel: [haiku, opus] });
    expect(withBreakdown.byModel?.map((e) => e.model)).toEqual(["haiku", "opus"]);
    const without = await appendUsageObservation(sourceDir, observation("p2", 70));
    expect(Object.hasOwn(without, "byModel")).toBe(false);
    await expect(
      appendUsageObservation(sourceDir, {
        ...observation("p3", 80),
        byModel: [
          { model: "z", input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
          { model: "a", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ],
      }),
    ).rejects.toThrow("control-usage-invalid");
    expect((await readUsageEvents(sourceDir)).map((e) => e.eventSeq)).toEqual([1, 2]);
  });

  it("survives a read back from disk and makes a replay with a different breakdown a conflict", async () => {
    const sourceDir = await root();
    await appendUsageObservation(sourceDir, { ...observation("p1", 65), byModel: [haiku, opus] });
    const [stored] = await readUsageEvents(sourceDir);
    expect(stored?.byModel).toEqual([haiku, opus]);
    await expect(
      appendUsageObservation(sourceDir, { ...observation("p1", 65), byModel: [haiku] }),
    ).rejects.toThrow("control-usage-conflict");
  });

  it("collect's event schema passes a breakdown through and refuses an unsorted or duplicated one", () => {
    const base = {
      runId: "run-1",
      generation: 1,
      eventSeq: 1,
      bucket: "work" as const,
      cumulative: null,
      source: { artifactId: "a1", hash: "a".repeat(64) },
    };
    expect(usageEventSchema.parse({ ...base, byModel: [haiku, opus] }).byModel).toEqual([haiku, opus]);
    expect(Object.hasOwn(usageEventSchema.parse(base), "byModel")).toBe(false);
    expect(usageEventSchema.safeParse({ ...base, byModel: [opus, haiku] }).success).toBe(false);
    expect(usageEventSchema.safeParse({ ...base, byModel: [haiku, haiku] }).success).toBe(false);
  });
});
