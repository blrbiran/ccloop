import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { runLoop } from "../../../src/controller/runLoop.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { codexFixture } from "./fixture.js";

// Issue #215: only a failure the runner can prove spent nothing carries usageKnownZero. A 429 before any work qualifies;
// a 429 after an item does not, and neither does any other failure that observed usage.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("a 429 before any work marks the failed terminal's usage as known zero", async () => {
  const f = await codexFixture("rate-limit-all");
  dirs.push(f.dir);
  const adapter = new CodexAdapter(parseCodexConfig(f.config), undefined, undefined, { rateLimitDelaysMs: [10, 10, 10] });
  const state = await runLoop(f.contract, f.runDir, adapter, {});
  expect(state.status).toBe("failed");
  expect(state.failureCause).toMatchObject({ cause: "rate-limited", phase: "plan", usageKnownZero: true });
}, 30_000);

it("a 429 after work carries no zero proof", async () => {
  const f = await codexFixture("rate-limit-after-item");
  dirs.push(f.dir);
  const adapter = new CodexAdapter(parseCodexConfig(f.config), undefined, undefined, { rateLimitDelaysMs: [10, 10, 10] });
  const state = await runLoop(f.contract, f.runDir, adapter, {});
  expect(state.status).toBe("failed");
  expect(state.failureCause).toMatchObject({ cause: "rate-limited" });
  expect((state.failureCause as { usageKnownZero?: true }).usageKnownZero).toBeUndefined();
}, 30_000);
