import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { parseAgentsTable } from "../../src/agents/table.js";
import type { InstallationV1 } from "../../src/agents/types.js";
import { acceptStart } from "../../src/control/accept.js";
import { runControlCommand } from "../../src/control/command.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, parseControlRequest, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture, exec } from "../runtime/codex/fixture.js";
import { FAKE_CLAUDE_CLI, claudeInstallation, controlContract, startEnvelope, writeAgentsTable } from "./agentsFixture.js";

// OMP skill injection (spec 2026-10-13-omp-skill-injection-design.md §2, session 808feb6a): a third skill directory
// field, `ompSkillsDir`, honoured by omp only and mutually exclusive with the claude and codex fields. Additive only
// (ccloop Rule 15): the claude/codex criteria in skillPluginDirAccept.test.ts are untouched.
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs");
const dirs: string[] = [];
// The in-process worker records this test process as its worker pid, so its directory is removed without waiting on it.
const inProcessDirs: string[] = [];
afterEach(async () => {
  for (const dir of inProcessDirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  for (const dir of dirs.splice(0)) {
    let pid: number | undefined;
    try {
      pid = (JSON.parse(await readFile(join(dir, "control", "accepted.json"), "utf8")) as { worker?: { pid?: number } }).worker?.pid;
    } catch {}
    for (const deadline = Date.now() + 10_000; pid !== undefined && Date.now() < deadline; await new Promise((r) => setTimeout(r, 20))) {
      try { process.kill(pid, 0); } catch { break; }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/** An omp installation whose single-element command is a wrapper around tests/fixtures/fake-omp.mjs. */
async function ompInstallation(dir: string, marker: string): Promise<InstallationV1> {
  const binary = join(dir, "omp");
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${marker}' "$@"\n`);
  await chmod(binary, 0o700);
  return { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null };
}

async function setup(agent: "claude" | "omp") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-skills-dir-")));
  dirs.push(dir);
  const script = join(dir, "script.json");
  await writeFile(script, "{}\n", { mode: 0o600 });
  const { path, table } = await writeAgentsTable({
    claude: await claudeInstallation([process.execPath, FAKE_CLAUDE_CLI, "script", join(dir, "claude-marker"), script]),
    omp: await ompInstallation(dir, join(dir, "omp-marker")),
  }, dir);
  const sourceDir = join(dir, "source");
  await mkdir(sourceDir);
  const skillsDir = join(dir, "frozen-skills", "skills");
  await mkdir(skillsDir, { recursive: true });
  const { resolution } = await resolveAgent(table, { agent });
  const envelope = startEnvelope({ sourceDir, targetRepo: dir, contract: controlContract(dir), agent: resolution.selection, configHash: resolution.configHash });
  return { dir, path, sourceDir, envelope, skillsDir };
}

const worker = () => ({
  workerCommand: [resolve("node_modules/.bin/tsx"), resolve("tests/fixtures/control-worker.mjs")],
  receiptTimeoutMs: 2_000,
});

describe("ompSkillsDir on the wire", () => {
  it("parses beside nothing, and refuses it beside either other skill directory field", async () => {
    const f = await setup("omp");
    const withOmp = { ...f.envelope, work: { ...f.envelope.work, ompSkillsDir: f.skillsDir } };
    expect(parseControlRequest("accept", withOmp)).toEqual(withOmp);
    for (const other of [{ codexSkillsDir: f.skillsDir }, { skillPluginDir: f.dir }]) {
      expect(() => parseControlRequest("accept", { ...withOmp, work: { ...withOmp.work, ...other } })).toThrow();
    }
  });

  it("keeps the envelope hash of a run that names no skill directory", async () => {
    const f = await setup("omp");
    expect(canonicalHash(parseControlRequest("accept", f.envelope))).toBe(canonicalHash(f.envelope));
  });
});

describe("ompSkillsDir at accept", { timeout: 30_000 }, () => {
  it("admits an omp run that names it and seals the envelope with the field", async () => {
    const f = await setup("omp");
    const envelope = { ...f.envelope, work: { ...f.envelope.work, ompSkillsDir: f.skillsDir } };
    const status = await acceptStart(envelope, { agentsTablePath: f.path, ...worker() });
    expect(status.kind).toBe("accepted");
    expect(JSON.parse(await readFile(join(f.sourceDir, "control", "envelope.json"), "utf8"))).toEqual(envelope);
  });

  it("refuses it for a claude installation by name, before anything is persisted", async () => {
    const f = await setup("claude");
    const envelope = { ...f.envelope, work: { ...f.envelope.work, ompSkillsDir: f.skillsDir } };
    expect(await runControlCommand(["accept", "--agents", f.path], JSON.stringify(envelope))).toEqual({ code: 2, stdout: "", stderr: "skills-unsupported-agent\n" });
    expect(await readdir(f.sourceDir)).toEqual([]);
  });

  it("refuses a directory that does not exist at accept as an invalid request, before anything is persisted", async () => {
    const f = await setup("omp");
    const envelope = { ...f.envelope, work: { ...f.envelope.work, ompSkillsDir: join(f.dir, "missing", "skills") } };
    expect(await runControlCommand(["accept", "--agents", f.path], JSON.stringify(envelope))).toEqual({ code: 2, stdout: "", stderr: "control-request-invalid\n" });
    expect(await readdir(f.sourceDir)).toEqual([]);
  });

  it.each([["codexSkillsDir"], ["skillPluginDir"]])("refuses %s for an omp installation, before anything is persisted", async (field) => {
    const f = await setup("omp");
    const envelope = { ...f.envelope, work: { ...f.envelope.work, [field]: field === "skillPluginDir" ? join(f.dir, "frozen-skills") : f.skillsDir } };
    expect(await runControlCommand(["accept", "--agents", f.path], JSON.stringify(envelope))).toEqual({ code: 2, stdout: "", stderr: "skills-unsupported-agent\n" });
    expect(await readdir(f.sourceDir)).toEqual([]);
  });
});

describe("ompSkillsDir in the worker", () => {
  it("lists the frozen skills to every OMP phase and publishes only the attempt's answer", { timeout: 60_000 }, async () => {
    const runtime = await codexFixture();
    inProcessDirs.push(runtime.dir);
    const marker = join(runtime.dir, "omp-marker");
    const table = parseAgentsTable({ schema: "ccloop-agents-table-v1", installations: { omp: await ompInstallation(runtime.dir, marker) } });
    const { config, resolution } = await resolveAgent(table, { agent: "omp" });
    await mkdir(join(runtime.dir, "input"));
    const skillsDir = join(runtime.dir, "frozen", "skills");
    await mkdir(join(skillsDir, "selected"), { recursive: true });
    await writeFile(join(skillsDir, "selected", "SKILL.md"), "---\ndescription: unique marker skill\n---\nunique marker\n");
    await writeFile(join(skillsDir, "syncskill-lock.json"), "{}\n");
    const amount = { tokens: 100, activeMs: 60_000, attempts: 1, sessions: 1 };
    const envelope: LoopStartEnvelope = {
      protocol: 3,
      claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1, commandId: "command-1", configHash: resolution.configHash, agent: resolution.selection, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
      contractHash: "c".repeat(64),
      inputCheckpoint: null,
      work: { kind: "loop", contract: runtime.contract, targetRepo: runtime.repo, base: "main", sourceDir: runtime.dir, ompSkillsDir: skillsDir },
    };
    const controlDir = join(runtime.dir, "control");
    await ensurePrivateDirectory(runtime.dir, controlDir);
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(config)));
    await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
    await writeAccepted(runtime.dir, {
      protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
      generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
    });
    await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
    expect((await readFile(`${marker}.calls`, "utf8")).trim().split("\n")).toEqual(["plan", "execute", "verify"]);
    const skill = "---\ndescription: unique marker skill\n---\nunique marker\n";
    expect(await readFile(`${marker}.skills`, "utf8")).toBe(skill.repeat(3));
    const { stdout: tree } = await exec("git", ["ls-tree", "-r", "--name-only", "refs/ccloop/run-1/attempts/1"], { cwd: runtime.repo });
    expect(tree.trim().split("\n")).toEqual(["answer.txt"]);
  });
});
