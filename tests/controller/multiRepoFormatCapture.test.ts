// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.2, §11.3, §11.6, §11.7), fix M4 from the
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

describe("execution-format capture with extra repositories (review M4, spec §11.7)", () => {
  async function formatFailureRun(multi: boolean) {
    const { contract } = await multiRepoWorld(multi ? [{ key: "lib" }] : []);
    if (!multi) { delete contract.context.repoKey; delete contract.context.additionalRepos; }
    const { root, envelope } = await fixture();
    const input = { ...envelope, work: { ...envelope.work, contract, ...(multi ? { additionalRepos: [{ key: "lib", targetRepo: contract.context.additionalRepos![0]!.repoPath, base: "HEAD" }] } : {}) } } as LoopStartEnvelope;
    const runDir = join(root, "run");
    const adapter: RuntimeAdapter = {
      async plan() { return { summary: "s", primaryTargetPaths: [] }; },
      async execute() { throw new ExecutionFormatFailure("codex-result-invalid", join(root, "evidence"), 1, { usageStatus: "absent" } as never, undefined, { status: "unavailable" } as never); },
      async verify() { return approve; },
    };
    const config = { schema: "ccloop-agent-config-v1", kind: "codex" } as never;
    // This fixture has no accepted record, so a capture that is entered ends the run with that read's ENOENT.
    const outcome = await runLoop(contract, runDir, adapter, { taskResultInput: input, executionFormatCapture: { config } })
      .then((state) => ({ status: state.status, error: null }), (error: unknown) => ({ status: null, error: String(error) }));
    const capture = outcome.error?.includes("accepted.json") === true || await exists(savedResultIndexPath(root))
      || (await events(runDir)).some((event) => event.type === "execution_format_capture_failed");
    return { outcome, capture };
  }
  it("a single-repo run enters the capture (positive control); a multi-repo run does not", async () => {
    const single = await formatFailureRun(false);
    expect(single.capture).toBe(true);
    const multi = await formatFailureRun(true);
    expect(multi.outcome).toEqual({ status: "failed", error: null });
    expect(multi.capture).toBe(false);
  }, 30_000);
});
