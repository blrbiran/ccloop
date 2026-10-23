// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.2, §11.3, §11.6, §11.7), fix M8 from the
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

describe("an extra worktree not at the envelope's base (review M8)", () => {
  const quiet: RuntimeAdapter = {
    async plan() { return { summary: "s", primaryTargetPaths: [] }; },
    async execute() { return { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" }; },
    async verify() { return approve; },
  };
  it("records extra_repo_base_mismatch when the base is another commit, and nothing when it is HEAD", async () => {
    const { repos, contract } = await multiRepoWorld([{ key: "lib" }]);
    const first = await git(repos.lib!, "rev-parse", "HEAD");
    await git(repos.lib!, "-c", "user.name=t", "-c", "user.email=t@invalid", "commit", "-q", "--allow-empty", "-m", "moved on");
    const head = await git(repos.lib!, "rev-parse", "HEAD");
    const moved = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    expect((await runLoop(contract, moved, quiet, { extraRepoBases: { lib: first } })).status).toBe("succeeded");
    expect((await events(moved)).filter((event) => event.type === "extra_repo_base_mismatch").map((event) => event.detail)).toEqual([`lib: base ${first} is ${first}, worktree HEAD ${head}`]);
    const same = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    expect((await runLoop(contract, same, quiet, { extraRepoBases: { lib: head } })).status).toBe("succeeded");
    expect((await events(same)).some((event) => event.type === "extra_repo_base_mismatch")).toBe(false);
  }, 30_000);
});
