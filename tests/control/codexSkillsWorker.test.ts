import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture } from "../runtime/codex/fixture.js";
import { sealCodex } from "./agentsFixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function runWorker(): Promise<void> {
  const runtime = await codexFixture("skill-integration");
  dirs.push(runtime.dir);
  const scriptPath = join(runtime.dir, "script.json");
  await writeFile(scriptPath, JSON.stringify({ "codex-test": { files: { "answer.txt": "42\n" } } }));
  await mkdir(join(runtime.dir, "input"));
  // The worker re-parses its sealed envelope as an accept, so the directory has to exist (it does while a run is live).
  const skillPluginDir = join(runtime.dir, "skill-plugin");
  await mkdir(skillPluginDir);
  const sealed = await sealCodex(runtime.config as Parameters<typeof sealCodex>[0]);
  const codexSkillsDir = join(skillPluginDir,"skills");
  await mkdir(join(codexSkillsDir,"selected"),{recursive:true});
  await writeFile(join(codexSkillsDir,"selected","SKILL.md"),"unique marker");
  await mkdir(join(runtime.repo,".agents/skills/legacy"),{recursive:true});
  await writeFile(join(runtime.repo,".agents/skills/legacy/SKILL.md"),"legacy bytes");
  const {exec} = await import("../runtime/codex/fixture.js");
  await exec("git",["add",".agents"],{cwd:runtime.repo});await exec("git",["commit","-m","legacy skill"],{cwd:runtime.repo});
  const amount = { tokens: 100, activeMs: 60_000, attempts: 1, sessions: 1 };
  const envelope: LoopStartEnvelope = {
    protocol: 3,
    claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: "c".repeat(64),
    inputCheckpoint: null,
    work: { kind: "loop", contract: runtime.contract, targetRepo: runtime.repo, base: "main", sourceDir: runtime.dir, codexSkillsDir },
  };
  const controlDir = join(runtime.dir, "control");
  await ensurePrivateDirectory(runtime.dir, controlDir);
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(runtime.dir, {
    protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
  });
  await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  expect((await readFile(`${runtime.marker}.calls`, "utf8")).trim().split("\n")).toEqual(["plan", "execute", "verify"]);
  expect(await readFile(runtime.marker+".skills","utf8")).toBe("unique marker\nunique marker\nunique marker\n");
  const {stdout:tree}=await exec("git",["ls-tree","-r","--name-only","refs/ccloop/run-1/attempts/1"],{cwd:runtime.repo});
  expect(tree).not.toContain(".agents/skills/selected");expect(tree).toContain(".agents/skills/legacy/SKILL.md");
  const {stdout:legacy}=await exec("git",["show","refs/ccloop/run-1/attempts/1:.agents/skills/legacy/SKILL.md"],{cwd:runtime.repo});expect(legacy).toBe("legacy bytes");
}
it("worker loads frozen Codex skills in all phases and publishes only original skills",{timeout:60000},runWorker);
