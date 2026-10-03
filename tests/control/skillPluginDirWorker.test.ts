import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture } from "../runtime/codex/fixture.js";
import { FAKE_CLAUDE_CLI, claudeInstallation, sealClaude } from "./agentsFixture.js";

// Orca syncskill integration (2026-10-03), spec 10.7: the worker hands the envelope's skillPluginDir to the adapter, so
// every claude call of a real control run (plan, execute, verify) loads the plugin and keeps slash commands enabled.
// Additive only (ccloop Rule 15).
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function runWorker(withPlugin: boolean): Promise<{ argvs: string[][]; skillPluginDir: string }> {
  const runtime = await codexFixture("script");
  dirs.push(runtime.dir);
  const scriptPath = join(runtime.dir, "script.json");
  await writeFile(scriptPath, JSON.stringify({ "codex-test": { files: { "answer.txt": "42\n" } } }));
  await mkdir(join(runtime.dir, "input"));
  // The worker re-parses its sealed envelope as an accept, so the directory has to exist (it does while a run is live).
  const skillPluginDir = join(runtime.dir, "skill-plugin");
  await mkdir(skillPluginDir);
  const installation = await claudeInstallation([process.execPath, FAKE_CLAUDE_CLI, "script", runtime.marker, scriptPath], { timeoutMs: 60_000, killGraceMs: 300 });
  const bare = await sealClaude(installation);
  // The `--version` probe answers only for the bare command, so the flag is appended to the config the worker reads
  // (the worker never re-probes); the claim's hash stays the bare config's.
  const sealed = { ...bare, config: { ...bare.config, installation: { ...bare.config.installation, command: [...installation.command, "--disable-slash-commands"] } } as typeof bare.config };
  const amount = { tokens: 100, activeMs: 60_000, attempts: 1, sessions: 1 };
  const envelope: LoopStartEnvelope = {
    protocol: 3,
    claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: "c".repeat(64),
    inputCheckpoint: null,
    work: { kind: "loop", contract: runtime.contract, targetRepo: runtime.repo, base: "main", sourceDir: runtime.dir, ...(withPlugin ? { skillPluginDir } : {}) },
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
  const argvs = (await readFile(`${runtime.marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  return { argvs, skillPluginDir };
}

describe("worker passes skillPluginDir to the claude adapter (Orca syncskill integration)", { timeout: 60_000 }, () => {
  it("loads the plugin and keeps slash commands enabled in plan, execute and verify", async () => {
    const { argvs, skillPluginDir } = await runWorker(true);
    expect(argvs).toHaveLength(3);
    for (const argv of argvs) {
      expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe(skillPluginDir);
      expect(argv).not.toContain("--disable-slash-commands");
    }
  });

  it("without the field the claude command is exactly the installation's (slash commands stay disabled, no plugin)", async () => {
    const { argvs } = await runWorker(false);
    expect(argvs).toHaveLength(3);
    for (const argv of argvs) {
      expect(argv).toContain("--disable-slash-commands");
      expect(argv).not.toContain("--plugin-dir");
    }
  });
});
