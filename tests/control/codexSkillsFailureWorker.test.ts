import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectExecution } from "../../src/control/collect.js";
import { requestHandoff } from "../../src/control/handoff.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { exec } from "../runtime/codex/fixture.js";
import { skillsControllerFixture, waitForOwnFixture } from "../runtime/codex/skillsControllerFixture.js";
import { sealCodex } from "./agentsFixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

for (const boundary of ["execute-timeout", "plan-handoff"] as const) {
  it(`worker collects the stable cleanup failure after ${boundary}, without a complete candidate or attempt ref`, { timeout: 20000 }, async () => {
    const f = await skillsControllerFixture(boundary === "execute-timeout" ? "execute" : "plan", true); dirs.push(f.dir);
    const sourceDir = join(f.dir, "source");
    await ensurePrivateDirectory(f.dir, sourceDir);
    const sealed = await sealCodex(f.config as Parameters<typeof sealCodex>[0]);
    const amount = { tokens: 100, activeMs: 60000, attempts: 1, sessions: 1 };
    const envelope: LoopStartEnvelope = {
      protocol: 3,
      claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
      contractHash: "c".repeat(64), inputCheckpoint: null,
      work: { kind: "loop", contract: f.contract, targetRepo: f.repo, base: "HEAD", sourceDir, codexSkillsDir: f.skills },
    };
    await ensurePrivateDirectory(sourceDir, join(sourceDir, "control"));
    await atomicReplacePrivateFile(sourceDir, join(sourceDir, "control/config.json"), Buffer.from(canonicalJson(sealed.config)));
    await atomicReplacePrivateFile(sourceDir, join(sourceDir, "control/envelope.json"), Buffer.from(canonicalJson(envelope)));
    await writeAccepted(sourceDir, { protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: sealed.configHash, generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
    const worker = runControlWorker(["--source-dir", sourceDir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
    await waitForOwnFixture(f.marker + ".started");
    if (boundary === "plan-handoff") await requestHandoff(envelope, { protocol: 1, requestId: "stop-1", runId: "run-1", generation: 1, reason: "human", deadlineAt: new Date().toISOString() });
    await worker;
    await waitForOwnFixture(f.marker + ".closed");
    const report = await collectExecution(envelope, 0);
    expect(report.terminal?.stopReason).toContain("codex-skills-cleanup-failed:");
    expect(report.terminal?.status).toBe("failed");
    expect(report.candidate).not.toBeNull();
    expect(report.candidate?.result).not.toBe("complete");
    const tree = await exec("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: join(sourceDir, "repo") });
    expect(tree.stdout).not.toContain(".agents/skills/selected");
    const refs = await exec("git", ["for-each-ref", "--format=%(refname)", "refs/ccloop/"], { cwd: f.repo });
    expect(refs.stdout).toBe("");
    expect((await readFile(join(sourceDir, "run/loop-state.json"), "utf8"))).toContain("codex-skills-cleanup-failed:");
  });
}
