import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendUsageObservation } from "../../src/control/usage.js";

async function root(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-usage-")));
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

describe("ordered usage observations", () => {
  it("keeps Codex thread totals cumulative instead of summing them as deltas", async () => {
    const sourceDir = await root();
    const events = [];
    for (const [index, total] of [15, 35, 60].entries()) {
      events.push(await appendUsageObservation(sourceDir, observation(`phase-${index + 1}`, total)));
    }
    expect(events.map((event) => event.eventSeq)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.cumulative?.tokens)).toEqual([15, 35, 60]);
    expect(events.map((event) => event.cumulative?.activeMs)).toEqual([10, 20, 30]);
  });

  it("returns the same event for duplicate evidence and refuses conflicting replay", async () => {
    const sourceDir = await root();
    const first = await appendUsageObservation(sourceDir, observation("phase-1", 15));
    expect(await appendUsageObservation(sourceDir, observation("phase-1", 15))).toEqual(first);
    await expect(appendUsageObservation(sourceDir, observation("phase-1", 16))).rejects.toThrow(
      "control-usage-conflict",
    );
  });

  it("distinguishes unavailable usage from an explicit final zero", async () => {
    const missingRoot = await root();
    const missing = await appendUsageObservation(missingRoot, observation("missing", null));
    expect(missing.cumulative).toBeNull();

    const zeroRoot = await root();
    const zero = await appendUsageObservation(zeroRoot, observation("zero", 0, 0));
    expect(zero.cumulative).toEqual({ tokens: 0, activeMs: 0, attempts: 1, sessions: 1 });
  });

  it("refuses safe-integer overflow rather than saturating", async () => {
    const sourceDir = await root();
    await appendUsageObservation(sourceDir, observation("large", 1, Number.MAX_SAFE_INTEGER));
    await expect(appendUsageObservation(sourceDir, observation("overflow", 1, 1))).rejects.toThrow(
      "control-usage-overflow",
    );
  });
});
