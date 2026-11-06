// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.3, §16.1 C4; reviews 1 and 6): the primary is judged as
// today from the executor's changedFiles; an extra repository only from ccloop's own observation (HEAD against the start
// sha, then the diff from the start sha plus untracked paths) against its own lists; maxFilesTouched counts every
// repository. An agent that commits in an extra worktree is a human gate, and its committed change is still observed.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import { collectExecution } from "../../src/control/collect.js";
import { finalizeHandoffCandidate } from "../../src/control/handoff.js";
import { canonicalHash, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { FIXTURE_SELECTION } from "../control/agentsFixture.js";
import type { AttemptContext, RuntimeAdapter } from "../../src/runtime/types.js";
import { createContract, createRepo } from "./optionalFixture.js";
import { git, multiRepoWorld } from "./multiRepoFixture.js";

type Writes = { primary?: string[]; reported?: string[]; lib?: string[]; libCommit?: boolean; libStage?: boolean };
function adapterWriting(writes: Writes): RuntimeAdapter {
  const put = async (root: string, file: string) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), "x\n"); };
  return {
    async plan() { return { summary: "s", primaryTargetPaths: [] }; },
    async execute(context: AttemptContext) {
      for (const file of writes.primary ?? []) await put(context.worktreePath, file);
      const lib = context.extraWorktrees?.find((extra) => extra.key === "lib");
      for (const file of writes.lib ?? []) await put(lib!.worktreePath, file);
      if (writes.libStage === true) await git(lib!.worktreePath, "add", "-A");
      if (writes.libCommit === true) {
        await git(lib!.worktreePath, "add", "-A");
        await git(lib!.worktreePath, "-c", "user.name=agent", "-c", "user.email=agent@invalid", "commit", "-m", "agent commit");
      }
      return { changedFiles: writes.reported ?? writes.primary ?? [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
    },
    async verify() { throw new Error("command verifier"); },
  };
}
const runDirOf = async () => mkdtemp(join(tmpdir(), "ccloop-run-"));
const observed = async (runDir: string) => JSON.parse(await readFile(join(runDir, "attempts", "1", "dirs.json"), "utf8")) as unknown;

describe("per-repository path policy (C4)", () => {
  it("reports every exact allowlist miss across the primary and additional repository in one blocked attempt", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib" }]);
    const state = await runLoop(contract, await runDirOf(), adapterWriting({
      primary: ["src/a.txt", "docs/one.txt", "docs/two.txt"], lib: ["other/one.txt", "other/two.txt"],
    }));
    expect(state.status).toBe("blocked_waiting_human");
    expect(state.stopReason).toBe("allowlist miss: docs/one.txt");
    expect(state.pathPolicyMisses).toEqual([
      { repoKey: null, path: "docs/one.txt" }, { repoKey: null, path: "docs/two.txt" },
      { repoKey: "lib", path: "other/one.txt" }, { repoKey: "lib", path: "other/two.txt" },
    ]);
  }, 30_000);

  it("reports an extra-repository-only miss after a blocked run is persisted and collected again", async () => {
    const { primary, contract } = await multiRepoWorld([{ key: "lib" }]);
    const sourceDir = await runDirOf();
    try {
      const runDir = join(sourceDir, "run");
      await mkdir(runDir);
      const state = await runLoop(contract, runDir, adapterWriting({ primary: ["src/a.txt"], lib: ["other/one.txt", "other/two.txt"] }));
      expect(state.pathPolicyMisses).toEqual([
        { repoKey: "lib", path: "other/one.txt" }, { repoKey: "lib", path: "other/two.txt" },
      ]);
      const amount = { tokens: 1_000, activeMs: 1_000, attempts: 1, sessions: 1 };
      const envelope = { protocol: 3, claim: { groupId: "g", workItemId: "a", taskId: "a", runId: "run-a", generation: 1,
        graphVersion: 1, targetVersion: 1, commandId: "c", configHash: "a".repeat(64), agent: FIXTURE_SELECTION,
        grant: { work: amount, handoff: amount }, ownerToken: "owner" }, contractHash: canonicalHash(contract), inputCheckpoint: null,
        work: { kind: "loop", contract, targetRepo: primary, base: await git(primary, "rev-parse", "HEAD"), sourceDir } } as LoopStartEnvelope;
      await finalizeHandoffCandidate(envelope, null, state, { result: "partial", usageHighWater: 0 });
      const first = await collectExecution(envelope, 0);
      const afterRestart = await collectExecution(envelope, 0);
      expect([first.pathPolicyMisses, afterRestart.pathPolicyMisses]).toEqual([state.pathPolicyMisses, state.pathPolicyMisses]);
      expect(Object.hasOwn(afterRestart.terminal!, "pathPolicyMisses")).toBe(false);
    } finally { await rm(sourceDir, { recursive: true, force: true }); }
  }, 30_000);

  it("does not offer allowlist authorization when another repository has a denylist match", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib", denylistPaths: ["lib/secret.txt"] }]);
    const state = await runLoop(contract, await runDirOf(), adapterWriting({ primary: ["docs/missing.txt"], lib: ["lib/secret.txt"] }));
    expect(state.status).toBe("blocked_waiting_human");
    expect(state.pathPolicyMisses).toBeUndefined();
  }, 30_000);

  it("does not offer allowlist authorization when the global file limit wins", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib" }]);
    contract.safetyPolicy.maxFilesTouched = 1;
    const state = await runLoop(contract, await runDirOf(), adapterWriting({ primary: ["docs/missing.txt"], lib: ["other/missing.txt"] }));
    expect(state.stopReason).toBe("max files exceeded: 2");
    expect(state.pathPolicyMisses).toBeUndefined();
  }, 30_000);

  it("omits oversized authorization evidence instead of truncating the missing path list", async () => {
    const contract = createContract(await createRepo(), ["true"]);
    contract.safetyPolicy.maxFilesTouched = 200;
    const reported = Array.from({ length: 129 }, (_, index) => `docs/missing-${index}.txt`);
    const state = await runLoop(contract, await runDirOf(), adapterWriting({ primary: reported }));
    expect(state.status).toBe("blocked_waiting_human");
    expect(state.pathPolicyMisses).toBeUndefined();
  }, 30_000);

  it("does not authorize a path that only the executor reported and Git did not observe", async () => {
    const contract = createContract(await createRepo(), ["true"]);
    const state = await runLoop(contract, await runDirOf(), adapterWriting({ reported: ["docs/fabricated.txt"] }));
    expect(state.stopReason).toBe("allowlist miss: docs/fabricated.txt");
    expect(state.pathPolicyMisses).toBeUndefined();
  }, 30_000);

  it("an extra-repo write inside that repo's own allowlist passes and is observed", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib" }]);
    const runDir = await runDirOf();
    const state = await runLoop(contract, runDir, adapterWriting({ primary: ["src/a.txt"], lib: ["lib/ok.txt"] }));
    expect(state.status).toBe("succeeded");
    expect(await observed(runDir)).toEqual([{ key: "lib", changedPaths: ["lib/ok.txt"] }]);
  }, 30_000);

  it("a write outside an extra repo's allowlist is a human gate, though the executor's changedFiles omits it", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib" }]);
    const state = await runLoop(contract, await runDirOf(), adapterWriting({ primary: ["src/a.txt"], lib: ["other/x.txt"] }));
    expect(state.status).toBe("blocked_waiting_human");
    expect(state.stopReason).toBe("allowlist miss: lib:other/x.txt");
  }, 30_000);

  it("an extra repo's own denylist is applied with the key", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib", denylistPaths: ["lib/secret.txt"] }]);
    const state = await runLoop(contract, await runDirOf(), adapterWriting({ lib: ["lib/secret.txt"] }));
    expect(state.stopReason).toBe("denylist match: lib:lib/secret.txt");
  }, 30_000);

  it("maxFilesTouched counts the primary and every extra repo together", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib" }]);
    contract.safetyPolicy.maxFilesTouched = 2;
    const state = await runLoop(contract, await runDirOf(), adapterWriting({ primary: ["src/a.txt"], lib: ["lib/a.txt", "lib/b.txt"] }));
    expect(state.status).toBe("blocked_waiting_human");
    expect(state.stopReason).toBe("max files exceeded: 3");
  }, 30_000);

  it("a single-repo contract still judges the executor's changedFiles", async () => {
    const contract = createContract(await createRepo(), ["true"]);
    const state = await runLoop(contract, await runDirOf(), adapterWriting({ reported: ["docs/not-written.txt"] }));
    expect(state.status).toBe("blocked_waiting_human");
    expect(state.stopReason).toBe("allowlist miss: docs/not-written.txt");
  }, 30_000);

  it("an agent that commits its extra-repo change (clean status, moved HEAD) ends extra-repo-head-moved, and the change is observed", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib" }]);
    const runDir = await runDirOf();
    const state = await runLoop(contract, runDir, adapterWriting({ lib: ["lib/committed.txt"], libCommit: true }));
    expect(state.status).toBe("blocked_waiting_human");
    expect(state.stopReason).toBe("extra-repo-head-moved: lib");
    expect(await observed(runDir)).toEqual([{ key: "lib", changedPaths: ["lib/committed.txt"] }]);
  }, 30_000);

  it("a staged, uncommitted change is still judged", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib" }]);
    const state = await runLoop(contract, await runDirOf(), adapterWriting({ lib: ["other/staged.txt"], libStage: true }));
    expect(state.stopReason).toBe("allowlist miss: lib:other/staged.txt");
  }, 30_000);
});
