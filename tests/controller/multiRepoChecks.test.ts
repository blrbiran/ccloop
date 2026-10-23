// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.4, §16.1 C5, §19.2 P4): the primary's required checks run
// first in the primary worktree, unchanged; then each extra repository's checks in that repository's worktree, labelled
// `[<key>] <command>` in the evidence and as the failing command.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import type { AttemptContext, RuntimeAdapter, VerificationResult } from "../../src/runtime/types.js";
import { multiRepoWorld } from "./multiRepoFixture.js";

function adapter(writeMarker: boolean, seen: AttemptContext[] = []): RuntimeAdapter {
  return {
    async plan() { return { summary: "s", primaryTargetPaths: [] }; },
    async execute(context) {
      const lib = context.extraWorktrees!.find((extra) => extra.key === "lib")!;
      if (writeMarker) { await mkdir(join(lib.worktreePath, "lib"), { recursive: true }); await writeFile(join(lib.worktreePath, "lib", "marker"), "m\n"); }
      return { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
    },
    async verify(context) {
      seen.push(context);
      return { approved: true, rejectCategory: "", primaryTargetPaths: [], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] };
    },
  };
}
const readVerify = async (runDir: string, attempt: number) => JSON.parse(await readFile(join(runDir, "attempts", String(attempt), "verify.json"), "utf8")) as VerificationResult;

describe("required checks per repository (C5)", () => {
  it("an extra repo's check runs in that repo's worktree, after the primary's, labelled; the primary's evidence is unchanged", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib", requiredChecks: ["test -f lib/marker"] }], ["test ! -f lib/marker"]);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const state = await runLoop(contract, runDir, adapter(true));
    expect(state.status).toBe("succeeded");
    expect((await readVerify(runDir, 1)).evidence).toEqual([
      "command output | required check passed: test ! -f lib/marker",
      "command output | required check passed: [lib] test -f lib/marker",
    ]);
  }, 30_000);

  it("a failing extra check is reported as [<key>] <command>, after the primary's passed evidence", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib", requiredChecks: ["test -f lib/marker"] }], ["true"]);
    contract.executionPolicy.maxAttempts = 1;
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const state = await runLoop(contract, runDir, adapter(false));
    expect(state.status).not.toBe("succeeded");
    const verify = await readVerify(runDir, 1);
    expect(verify).toMatchObject({ approved: false, rejectCategory: "required-check-failed", failingCommand: "[lib] test -f lib/marker" });
    expect(verify.evidence[0]).toBe("command output | required check passed: true");
    expect(verify.evidence[1]).toMatch(/^command output \| required check failed: \[lib\] test -f lib\/marker \| exit=1$/);
  }, 30_000);

  it("the agent verifier receives every result in order, labelled", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib", requiredChecks: ["test -f lib/marker"] }], ["true"]);
    contract.verification.verifierType = "agent";
    const seen: AttemptContext[] = [];
    const state = await runLoop(contract, await mkdtemp(join(tmpdir(), "ccloop-run-")), adapter(true, seen));
    expect(state.status).toBe("succeeded");
    expect(seen[0]!.requiredCheckResults!.map((result) => result.command)).toEqual(["true", "[lib] test -f lib/marker"]);
  }, 30_000);
});
