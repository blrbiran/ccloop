// Change-sized runs P1 through the real control worker (Orca spec 2026-11-19-change-sized-runs-design.md §5.2, §6.1, criteria
// P1-1 and P1-2; Orca #363 #366). A handoff during setup leaves the attempt's worktree kept at the boundary, with what setup
// wrote in it. With work.attemptDelivery the worker records that worktree as a commit, removes it, makes no result repository
// (the repository-sized copy this design exists to remove), and collect reports `attempt`. Without the key the same run still
// makes <sourceDir>/repo and collect has no `attempt` -- the legacy path Orca relies on for in-flight envelopes.
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { requestHandoff } from "../../src/control/handoff.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture, exec } from "../runtime/codex/fixture.js";
import { sealCodex } from "./agentsFixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function handoffDuringSetup(attemptDelivery: boolean) {
  const runtime = await codexFixture("high-usage");
  dirs.push(runtime.dir);
  // Setup stands in for the agent's edits: a tracked change, an untracked file, and an ignored file.
  runtime.contract.context.setupCommands = ["printf '42\\n' > answer.txt; printf 'u\\n' > untracked.txt; printf 'x.log\\n' > .gitignore; printf 'i\\n' > x.log; touch setup-wrote; sleep 5"];
  const sealed = await sealCodex(runtime.config as Parameters<typeof sealCodex>[0]);
  const amount = { tokens: 100_000, activeMs: 60_000, attempts: 1, sessions: 1 };
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: runtime.repo })).stdout.trim();
  // The fixture's target repository is <dir>/repo, so the run's source directory is a sibling: <sourceDir>/repo must be the
  // result repository's path alone.
  const sourceDir = join(runtime.dir, "source");
  await mkdir(sourceDir, { mode: 0o700 });
  const envelope: LoopStartEnvelope = {
    protocol: 4,
    claim: { groupId: "g", workItemId: "w", taskId: "t", runId: "run-p1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "c", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "o" },
    tokenPolicy: { authoredTokenCeiling: null, bindingCauses: [], inheritedUsage: { tokens: 0, activeMs: 0, attempts: 0, sessions: 0 } },
    contractHash: "c".repeat(64), inputCheckpoint: null,
    work: { kind: "loop", contract: runtime.contract, targetRepo: runtime.repo, base, sourceDir, ...(attemptDelivery ? { attemptDelivery: "ref-v1" as const } : {}) },
  };
  const controlDir = join(sourceDir, "control");
  await ensurePrivateDirectory(sourceDir, controlDir);
  await atomicReplacePrivateFile(sourceDir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(sourceDir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(sourceDir, { protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
  const worker = runControlWorker(["--source-dir", sourceDir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  const wrote = join(sourceDir, "run", "worktrees", "attempt-1", "setup-wrote");
  for (let i = 0; i < 1000 && !existsSync(wrote); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(existsSync(wrote)).toBe(true);
  await requestHandoff(envelope, { protocol: 1, requestId: "stop-1", runId: "run-p1", generation: 1, reason: "human", deadlineAt: new Date().toISOString() });
  await worker;
  const { runControlCommand } = await import("../../src/control/command.js");
  const result = await runControlCommand(["collect", "--agents", join(runtime.dir, "absent-agents.json")], JSON.stringify({ input: envelope, afterSeq: 0 }));
  expect(result.code, result.stderr).toBe(0);
  return { runtime, sourceDir, base, collected: JSON.parse(result.stdout) };
}

it("P1-1/P1-2: with the key a kept worktree is recorded live, removed, both refs set, and no result repository exists", { timeout: 90_000 }, async () => {
  const { runtime, sourceDir, base, collected } = await handoffDuringSetup(true);
  expect(collected.candidate).not.toBeNull();
  expect(collected.attempt).toMatchObject({ attempt: 1, base, head: base, capture: "live", worktree: "removed", ref: "refs/ccloop/run-p1/attempts/1" });
  const sha = collected.attempt.sha as string;
  expect(existsSync(join(sourceDir, "repo"))).toBe(false);
  expect(existsSync(join(sourceDir, "repos"))).toBe(false);
  expect(existsSync(join(sourceDir, "run", "worktrees", "attempt-1"))).toBe(false);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: runtime.repo })).stdout.trim();
  expect(await git("rev-parse", "refs/ccloop/run-p1/attempts/1")).toBe(sha);
  expect(await git("rev-parse", "refs/ccloop/run/attempts/1")).toBe(sha);
  expect(await git("rev-parse", `${sha}^`)).toBe(base);
  expect(await git("rev-parse", `${sha}^{tree}`)).toBe(collected.attempt.tree);
  const paths = (await git("ls-tree", "-r", "--name-only", sha)).split("\n");
  expect(paths).toEqual(expect.arrayContaining([".gitignore", "answer.txt", "untracked.txt", "setup-wrote"]));
  expect(paths).not.toContain("x.log");
  expect(await git("show", `${sha}:answer.txt`)).toBe("42");
});

it("P1-2: without the key the same run makes <sourceDir>/repo and collect has no attempt", { timeout: 90_000 }, async () => {
  const { sourceDir, collected } = await handoffDuringSetup(false);
  expect(collected.candidate).not.toBeNull();
  expect(Object.hasOwn(collected, "attempt")).toBe(false);
  expect(existsSync(join(sourceDir, "repo", ".git"))).toBe(true);
  expect(existsSync(join(sourceDir, "run", "attempt-record.json"))).toBe(false);
});
