import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { acceptStart } from "../../src/control/accept.js";
import { runControlCommand } from "../../src/control/command.js";
import { FAKE_CLAUDE_CLI, FAKE_CODEX, claudeInstallation, codexInstallation, controlContract, startEnvelope, writeAgentsTable } from "./agentsFixture.js";

// Orca syncskill integration (2026-10-03), spec 10.7 and 4.4: a loop run that names a skill plugin directory can only
// run under claude (the only agent with a verified way to load it); accept refuses any other agent by name, before
// anything is persisted. Additive only (ccloop Rule 15).
const dirs: string[] = [];
afterEach(async () => {
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

async function setup(agent: "claude" | "codex") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-skill-plugin-")));
  dirs.push(dir);
  const script = join(dir, "script.json");
  await writeFile(script, "{}\n", { mode: 0o600 });
  const { path, table } = await writeAgentsTable({
    claude: await claudeInstallation([process.execPath, FAKE_CLAUDE_CLI, "script", join(dir, "claude-marker"), script]),
    codex: await codexInstallation({ command: [process.execPath, FAKE_CODEX, "integration", join(dir, "codex-marker")], sandbox: "workspace-write", budgetMode: "soft", timeoutMs: 1_000, killGraceMs: 100 }),
  }, dir);
  const sourceDir = join(dir, "source");
  await mkdir(sourceDir);
  const skillPluginDir = join(dir, "skill-plugin");
  await mkdir(skillPluginDir);
  const codexSkillsDir = join(dir, "frozen-skills", "skills");
  await mkdir(codexSkillsDir, { recursive: true });
  const { resolution } = await resolveAgent(table, { agent });
  const base = startEnvelope({ sourceDir, targetRepo: dir, contract: controlContract(dir), agent: resolution.selection, configHash: resolution.configHash });
  const envelope = { ...base, work: { ...base.work, skillPluginDir } };
  return { path, sourceDir, envelope, codexSkillsDir };
}

describe("skillPluginDir at accept (Orca syncskill integration)", { timeout: 30_000 }, () => {
  it("refuses a codex run that names a skill plugin dir, by name and before anything is persisted", async () => {
    const f = await setup("codex");
    expect(await runControlCommand(["accept", "--agents", f.path], JSON.stringify(f.envelope))).toEqual({ code: 2, stdout: "", stderr: "skills-unsupported-agent\n" });
    expect(await readdir(f.sourceDir)).toEqual([]);
    await expect(readFile(join(f.sourceDir, "control", "accepted.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits a claude run that names a skill plugin dir and seals the envelope with the field", async () => {
    const f = await setup("claude");
    const status = await acceptStart(f.envelope, {
      agentsTablePath: f.path,
      workerCommand: [resolve("node_modules/.bin/tsx"), resolve("tests/fixtures/control-worker.mjs")],
      receiptTimeoutMs: 2_000,
    });
    expect(status.kind).toBe("accepted");
    expect(JSON.parse(await readFile(join(f.sourceDir, "control", "envelope.json"), "utf8"))).toEqual(f.envelope);
  });

  it("still admits a codex run that names none (the refusal is for the field, not the agent)", async () => {
    const f = await setup("codex");
    const { skillPluginDir: _dropped, ...work } = f.envelope.work;
    const status = await acceptStart({ ...f.envelope, work }, {
      agentsTablePath: f.path,
      workerCommand: [resolve("node_modules/.bin/tsx"), resolve("tests/fixtures/control-worker.mjs")],
      receiptTimeoutMs: 2_000,
    });
    expect(status.kind).toBe("accepted");
  });

  it("admits a codex run with codexSkillsDir and seals that field", async () => {
    const f = await setup("codex");
    const { skillPluginDir: _dropped, ...work } = f.envelope.work;
    const envelope = { ...f.envelope, work: { ...work, codexSkillsDir: f.codexSkillsDir } };
    const status = await acceptStart(envelope, {
      agentsTablePath: f.path,
      workerCommand: [resolve("node_modules/.bin/tsx"), resolve("tests/fixtures/control-worker.mjs")],
      receiptTimeoutMs: 2_000,
    });
    expect(status.kind).toBe("accepted");
    expect(JSON.parse(await readFile(join(f.sourceDir, "control", "envelope.json"), "utf8"))).toEqual(envelope);
  });

  it("refuses codexSkillsDir for a claude installation before anything is persisted", async () => {
    const f = await setup("claude");
    const { skillPluginDir: _dropped, ...work } = f.envelope.work;
    const envelope = { ...f.envelope, work: { ...work, codexSkillsDir: f.codexSkillsDir } };
    expect(await runControlCommand(["accept", "--agents", f.path], JSON.stringify(envelope))).toEqual({
      code: 2,
      stdout: "",
      stderr: "skills-unsupported-agent\n",
    });
    expect(await readdir(f.sourceDir)).toEqual([]);
  });
});
