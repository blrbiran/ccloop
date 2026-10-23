// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.2, §11.3, §11.6, §11.7), fix M3 from the
// independent review of feat/multi-repo (Orca session ffec7b28, 2026-10-24).
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import { ExecutionFormatFailure } from "../../src/runtime/executionNormalizer.js";
import type { AttemptContext, RuntimeAdapter, VerificationResult } from "../../src/runtime/types.js";
import { savedResultIndexPath } from "../../src/control/savedResultEvidence.js";
import type { LoopStartEnvelope } from "../../src/control/protocol.js";
import { fixture } from "../control/optionalFixture.js";
import { git, multiRepoWorld } from "./multiRepoFixture.js";

const approve: VerificationResult = { approved: true, rejectCategory: "", primaryTargetPaths: [], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] };
const put = async (root: string, file: string) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), "x\n"); };
const lib = (context: AttemptContext) => context.extraWorktrees!.find((extra) => extra.key === "lib")!;
const events = async (runDir: string) => (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; detail: string });
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("extra worktrees observed again right before publish (review M3)", () => {
  const verifierWriting = (file: string): RuntimeAdapter => ({
    async plan() { return { summary: "s", primaryTargetPaths: [] }; },
    async execute() { return { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" }; },
    async verify(context) { await put(lib(context).worktreePath, file); return approve; },
  });

  it("a file the verify phase wrote inside the allowlist is in dirs.json", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib" }]);
    contract.verification.verifierType = "agent";
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    expect((await runLoop(contract, runDir, verifierWriting("lib/late.txt"))).status).toBe("succeeded");
    expect(JSON.parse(await readFile(join(runDir, "attempts", "1", "dirs.json"), "utf8"))).toEqual([{ key: "lib", changedPaths: ["lib/late.txt"] }]);
  }, 30_000);

  it("a file the verify phase wrote outside the allowlist is the same human gate", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib" }]);
    contract.verification.verifierType = "agent";
    const state = await runLoop(contract, await mkdtemp(join(tmpdir(), "ccloop-run-")), verifierWriting("other/late.txt"));
    expect({ status: state.status, stopReason: state.stopReason }).toEqual({ status: "blocked_waiting_human", stopReason: "allowlist miss: lib:other/late.txt" });
  }, 30_000);
});
