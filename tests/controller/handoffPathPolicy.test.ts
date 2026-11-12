// Task handoffs (Orca spec 2026-11-12 tester follow-up G §10.2): the agent writes handoff.md and summary.md into Orca's
// output directory, outside the worktree, and may well list them in changedFiles. ccloop does not count them as changed
// paths: an allowlist that names only the task's files must not block the run for them, and every other entry is judged
// exactly as before.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import { dropHandoffOutput } from "../../src/policy/handoffOutput.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { fixture } from "../control/optionalFixture.js";
import { createContract, createRepo } from "./optionalFixture.js";

const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("dropHandoffOutput", () => {
  it("drops absolute and worktree-relative entries that resolve inside outputDir, keeps every other entry and its order", () => {
    const wt = "/work/tree", out = "/work/x/out";
    expect(dropHandoffOutput(["a.txt", `${out}/handoff.md`, "../x/out/summary.md", "b/c.ts", out, "/work/x/outside.md"], wt, out))
      .toEqual(["a.txt", "b/c.ts", "/work/x/outside.md"]);
    expect(dropHandoffOutput(["a.txt"], wt, undefined)).toEqual(["a.txt"]);
    expect(dropHandoffOutput(["../x/out/summary.md"], null, out)).toEqual(["../x/out/summary.md"]);
  });
});

describe("a run whose executor lists the handoff files in changedFiles", () => {
  for (const withHandoff of [true, false]) {
    it(withHandoff ? "is not blocked as an allowlist miss" : "without work.handoff the same report is blocked as before", async () => {
      const repo = await realpath(await createRepo()); cleanups.push(repo);
      const outputDir = await realpath(await mkdtemp(join(tmpdir(), "handoff-out-"))); cleanups.push(outputDir);
      const runDir = `${repo}-run`; cleanups.push(runDir);
      const { root, envelope } = await fixture(); cleanups.push(root);
      const base = createContract(repo, ["true"], null);
      const contract = { ...base, verification: { ...base.verification, verifierType: "agent" as const } };
      const seen: Record<string, unknown> = {};
      const input = { ...envelope, work: { ...envelope.work, contract, targetRepo: repo, ...(withHandoff ? { handoff: { inputDir: root, outputDir } } : {}) } };
      const adapter: RuntimeAdapter = {
        plan: async (context) => { seen.plan = context.handoff; return { summary: "edit", primaryTargetPaths: ["src/index.ts"] }; },
        execute: async (context) => {
          seen.execute = context.handoff;
          await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
          await mkdir(outputDir, { recursive: true });
          await writeFile(join(outputDir, "handoff.md"), "H");
          return { changedFiles: ["src/index.ts", join(outputDir, "handoff.md"), relative(context.worktreePath, join(outputDir, "summary.md"))], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
        },
        verify: async (context) => {
          seen.verify = context.handoff;
          return { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [] };
        },
      };
      const state = await runLoop(contract, runDir, adapter, { taskResultInput: input as never });
      // The directories reach plan and execute (each a separate call that shares no context), never verify.
      expect(seen).toEqual(withHandoff ? { plan: { inputDir: root, outputDir }, execute: { inputDir: root, outputDir }, verify: undefined } : { plan: undefined, execute: undefined });
      if (withHandoff) expect(state.status).toBe("succeeded");
      else expect(state).toMatchObject({ status: "blocked_waiting_human", stopReason: expect.stringMatching(/^allowlist miss: /) });
    }, 30_000);
  }
});
