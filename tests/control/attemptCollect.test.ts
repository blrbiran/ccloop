// Change-sized runs P1 review I2 (Orca spec 2026-11-19-change-sized-runs-design.md §6.1; Orca #363 #366): collect's `attempt`
// is present iff the envelope carries work.attemptDelivery AND there is a candidate. Why it matters: before the worker has
// settled there is no record yet, and an in-flight collect that said `record-failed` (attempt-record-missing) would tell Orca
// the run's result is lost while the run is still working.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectExecution } from "../../src/control/collect.js";
import type { LoopStartEnvelope } from "../../src/control/protocol.js";
import { fixture } from "./optionalFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("a key run collected before any candidate has no attempt", async () => {
  const { root, envelope } = await fixture(); roots.push(root);
  const keyed = { ...envelope, protocol: 4, work: { ...envelope.work, attemptDelivery: "ref-v1" } } as LoopStartEnvelope;
  await mkdir(join(root, "run"));
  await writeFile(join(root, "run", "loop-state.json"), JSON.stringify({ status: "executing", currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-11-19T00:00:00Z",
    waitingOnHuman: false, stopReason: null, budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 10, tokenBudgetRemaining: 10 }, recentFailures: [] }), { mode: 0o600 });
  const collected = await collectExecution(keyed, 0);
  expect(collected.candidate).toBeNull();
  expect(collected.progress).toMatchObject({ currentAttempt: 1 });
  expect(Object.hasOwn(collected, "attempt")).toBe(false);
});
