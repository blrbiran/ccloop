import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { acceptStart } from "../../src/control/accept.js";
import { runControlCommand } from "../../src/control/command.js";
import { singleCallEnvelope, writeAgentsTable } from "./agentsFixture.js";

// OMP single call (Orca spec 2026-10-14 §3.2, criterion 2): accept refuses single-call work by the resolution's answer --
// for omp, the selected catalog row's -- not by the installation's config alone, which cannot tell a row with a cap from
// one without. Both directions are pinned: a config-only answer would refuse the admitted call too.
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs");
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
    await rm(dir, { recursive: true, force: true });
  }
});

async function ompTable() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-accept-")));
  dirs.push(dir);
  const marker = join(dir, "omp-marker");
  await writeFile(`${marker}.catalog.json`, JSON.stringify([
    { provider: "gateway", kind: "chat", id: "model-a", selector: "gateway/model-a", contextWindow: 200000, maxTokens: 8192 },
    { provider: "gateway", kind: "chat", id: "no-cap", selector: "gateway/no-cap", contextWindow: 128000 },
  ]));
  const binary = join(dir, "omp");
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${marker}' "$@"\n`, { mode: 0o700 });
  return await writeAgentsTable({
    omp: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
  }, dir);
}
async function sourceDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-accept-source-")));
  dirs.push(dir);
  return dir;
}

describe("accept uses the resolution for omp single calls (criterion 2)", { timeout: 30_000 }, () => {
  it("C2: refuses an omp single call whose resolution answers null, by name and before anything is persisted", async () => {
    const { path, table } = await ompTable();
    const source = await sourceDir();
    const { resolution } = await resolveAgent(table, { agent: "omp", model: "gateway/no-cap" });
    expect(resolution.singleCallExecution).toBeNull();
    const envelope = singleCallEnvelope({ sourceDir: source, agent: resolution.selection, configHash: resolution.configHash });
    expect(await runControlCommand(["accept", "--agents", path], JSON.stringify(envelope))).toEqual({ code: 2, stdout: "", stderr: "single-call-unsupported\n" });
    expect(await readdir(source)).toEqual([]);
  });

  it("C2: admits an omp single call whose resolution answers v1 and seals its envelope", async () => {
    const { path, table } = await ompTable();
    const source = await sourceDir();
    const { resolution } = await resolveAgent(table, { agent: "omp" });
    expect(resolution.singleCallExecution).toBe("v1");
    const envelope = singleCallEnvelope({ sourceDir: source, agent: resolution.selection, configHash: resolution.configHash });
    const status = await acceptStart(envelope, {
      agentsTablePath: path,
      workerCommand: [resolve("node_modules/.bin/tsx"), resolve("tests/fixtures/control-worker.mjs")],
      receiptTimeoutMs: 2_000,
    });
    expect(status.kind).toBe("accepted");
    expect(JSON.parse(await readFile(join(source, "control", "envelope.json"), "utf8"))).toEqual(envelope);
  });
});
