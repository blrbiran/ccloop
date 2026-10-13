import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { runLoop } from "../../../src/controller/runLoop.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { codexFixture } from "./fixture.js";

// Codex rate-limit spec (2026-10-13) §4 criterion 8: the real controller with the real adapter. A plan phase rejected by
// 429 before any work on every call fails the run, names the reason, and books the phase's usage as 0, not unknown.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("a run whose phase is rejected by 429 before any work fails as codex-rate-limited with 0 tokens booked", async () => {
  const f = await codexFixture("rate-limit-all");
  dirs.push(f.dir);
  const adapter = new CodexAdapter(parseCodexConfig(f.config), undefined, undefined, { rateLimitDelaysMs: [10, 10, 10] });
  const phases: { phase: string; tokenUsage?: number | null }[] = [];
  const state = await runLoop(f.contract, f.runDir, adapter, { onPhaseSettled: async observation => { phases.push(observation as never); } });
  expect(state.status).toBe("failed");
  expect(state.stopReason).toMatch(/codex-rate-limited: /);
  expect(phases).toEqual([expect.objectContaining({ phase: "plan", tokenUsage: 0 })]);
}, 30_000);
