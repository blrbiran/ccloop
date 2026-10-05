import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createStopRequestSignal, runLoop } from "../../../src/controller/runLoop.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { exec } from "./fixture.js";
import { skillsControllerFixture, waitForOwnFixture } from "./skillsControllerFixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

for (const phase of ["plan", "verify"] as const) {
  it(`controller ${phase} timeout waits for Codex close before deleting skills or the worktree`, { timeout: 15000 }, async () => {
    const f = await skillsControllerFixture(phase, false); dirs.push(f.dir);
    let closedAtSettle = false;
    const state = await runLoop(f.contract, f.runDir, new CodexAdapter(f.config, undefined, f.skills), {
      onRunSettledBeforeLeaseRelease: async () => { closedAtSettle = existsSync(f.marker + ".closed"); },
    });
    // Finish our own delayed fixture before teardown even when the old controller returned early.
    await waitForOwnFixture(f.marker + ".closed");
    const beforeExit = JSON.parse(await readFile(f.marker + ".closed", "utf8"));
    expect(closedAtSettle).toBe(true);
    expect(beforeExit.skillPresentBeforeExit).toBe(true);
    expect(state.status).toBe("exhausted");
    expect(existsSync(join(beforeExit.cwd, ".agents/skills/selected"))).toBe(false);
  });
}

for (const phase of ["plan", "execute", "verify"] as const) {
  for (const boundary of ["timeout", "handoff-request", "handoff-abort"] as const) {
    it(`controller preserves ${phase} skill cleanup failure across ${boundary}`, { timeout: 15000 }, async () => {
      const f = await skillsControllerFixture(phase, true); dirs.push(f.dir);
      const stopRequested = createStopRequestSignal(), phaseAbort = new AbortController();
      const work = runLoop(f.contract, f.runDir, new CodexAdapter(f.config, undefined, f.skills), { stopRequested, phaseSignal: phaseAbort.signal });
      await waitForOwnFixture(f.marker + ".started");
      if (boundary === "handoff-request") stopRequested.requested = true;
      if (boundary === "handoff-abort") { stopRequested.requested = true; phaseAbort.abort(); }
      const state = await work;
      await waitForOwnFixture(f.marker + ".closed");
      expect(state.stopReason).toContain("codex-skills-cleanup-failed:");
      expect(state.status).toBe("failed");
      const refs = await exec("git", ["for-each-ref", "--format=%(refname)", "refs/ccloop/"], { cwd: f.repo });
      expect(refs.stdout).toBe("");
    });
  }
}
