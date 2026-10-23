// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.2, §11.3, §11.6, §11.7), fix I2 from the
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

describe("a rejection whose extra-worktree removal fails (review I2)", () => {
  it("keeps the primary's and the extra's commit, and publishes the extra once across both cleanup passes", async () => {
    const { repos, contract } = await multiRepoWorld([{ key: "lib" }]);
    contract.verification.verifierType = "agent";
    const runDir = join(await mkdtemp(join(tmpdir(), "ccloop-run-")), "run-i2");
    const adapter: RuntimeAdapter = {
      async plan() { return { summary: "s", primaryTargetPaths: [] }; },
      async execute(context) {
        await put(lib(context).worktreePath, "lib/x.txt");
        // A locked worktree is refused by `git worktree remove --force` (it takes --force twice).
        await git(repos.lib!, "worktree", "lock", lib(context).worktreePath);
        return { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
      },
      async verify() { return { ...approve, approved: false, rejectCategory: "fix", safeToRetry: true, evidence: ["again"] }; },
    };
    const state = await runLoop(contract, runDir, adapter);
    expect(state.status).toBe("failed");
    const commits = JSON.parse(await readFile(join(runDir, "attempts", "1", "commits.json"), "utf8")) as Record<string, { sha: string; base: string }>;
    expect(Object.keys(commits)).toEqual(["app", "lib"]);
    const ref = `refs/ccloop/${basename(runDir)}/attempts/1`;
    expect(await git(repos.lib!, "rev-parse", ref)).toBe(commits.lib!.sha);
    // Counted from the repository's own HEAD (the worktree's start), not from commits.json's base, which a second publish
    // would move along with it.
    expect(await git(repos.lib!, "rev-list", "--count", `${await git(repos.lib!, "rev-parse", "HEAD")}..${ref}`)).toBe("1");
    expect(commits.lib!.base).toBe(await git(repos.lib!, "rev-parse", "HEAD"));
  }, 30_000);
});
