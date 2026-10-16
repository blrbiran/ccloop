import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { acceptStart } from "../../src/control/accept.js";
import { runControlCommand } from "../../src/control/command.js";
import { FAKE_CLAUDE_CLI, FAKE_CODEX, claudeInstallation, codexInstallation, singleCallEnvelope, writeAgentsTable } from "./agentsFixture.js";

// Orca single-call estimate (2026-09-27), spec §4.4, §5.1 and §8.2 "capabilities"/"accept": whether an agent can run
// one read-only structured call is a sibling of the seven-key capability view (like timeoutMs and killGraceMs, a fact
// Orca does not intersect with a profile), and accept refuses single-call work for an agent that answers null even
// when Orca's preflight let it through. Additive only (ccloop Rule 15): no existing criterion pins this answer.
const SEVEN = {
  usageObservation: "phase-end", budgetEnforcement: "soft", contextObservation: "unavailable", handoffControl: "durable",
  handoffExecution: "mechanical-in-run-v1", contextWindowTokens: null, requestBoundProof: null,
};

// Temp-dir cleanup (Orca session c85d2c4e, 2026-09-28, human-authorized in Orca ledger 2026-09-27-single-call-estimate
// §3.22): this file used to leak six dirs per full run. Cleanup only -- no assertion below changed. C4's worker may still
// be sealing when the test returns (measured under load: rm raced it and hit ENOTEMPTY), so wait for its pid to exit first.
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

async function twoAgentTable() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-single-call-table-")));
  dirs.push(dir);
  const script = join(dir, "script.json");
  await writeFile(script, "{}\n", { mode: 0o600 });
  return await writeAgentsTable({
    claude: await claudeInstallation([process.execPath, FAKE_CLAUDE_CLI, "script", join(dir, "claude-marker"), script]),
    codex: await codexInstallation({ command: [process.execPath, FAKE_CODEX, "integration", join(dir, "codex-marker")], sandbox: "workspace-write", budgetMode: "soft", timeoutMs: 1_000, killGraceMs: 100 }),
  }, dir);
}

describe("single-call capability and its accept gate (Orca single-call estimate)", { timeout: 30_000 }, () => {
  // Rewritten for the every-agent requirement chain (Orca spec 2026-10-15 §6.1, ruling R2; human named E2 on 2026-10-15):
  // codex now answers "v1-soft" beside the view. Ruling: human named E2 in Orca session a852f96a, 2026-10-15.
  it("C1: answers singleCallExecution beside the seven-key view: v1 for claude, v1-soft for codex", async () => {
    const { path, table } = await twoAgentTable();
    const claude = await runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: { agent: "claude" } }));
    expect(claude.code, claude.stderr).toBe(0);
    const claudeResolution = (await resolveAgent(table, { agent: "claude" })).resolution;
    // Rewritten for the every-agent requirement chain (Orca spec 2026-10-15 §2.3, §7, ruling R5; human named E1 on 2026-10-15):
    // claude's agent-default window is the 200000 lower bound. Ruling: human named E1 in Orca session a852f96a, 2026-10-15.
    expect(claudeResolution.capabilities).toEqual({ ...SEVEN, contextWindowTokens: 200000 });
    expect(JSON.parse(claude.stdout)).toEqual({ protocol: 3, ...claudeResolution, singleCallExecution: "v1" });

    const codex = await runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: { agent: "codex" } }));
    expect(codex.code, codex.stderr).toBe(0);
    const codexResolution = (await resolveAgent(table, { agent: "codex" })).resolution;
    // Rewritten for the every-agent requirement chain (Orca spec 2026-10-15 §6.1, ruling R2; human named E1 on 2026-10-15):
    // codex's window is its fake catalog row's context_window (gpt-6-sol: 272000); the claude half is Task 7.
    // Ruling: human named E1 in Orca session a852f96a, 2026-10-15.
    expect(codexResolution.capabilities).toEqual({ ...SEVEN, contextWindowTokens: 272000 });
    // Ruling: human named E2 in Orca session a852f96a, 2026-10-15.
    expect(JSON.parse(codex.stdout)).toEqual({ protocol: 3, ...codexResolution, singleCallExecution: "v1-soft" });
  });

  it("C2: leaves the table view without it", async () => {
    const { path } = await twoAgentTable();
    const view = await runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: null }));
    expect(view.code, view.stderr).toBe(0);
    expect(Object.keys(JSON.parse(view.stdout)).sort()).toEqual(["installations", "protocol"]);
  });

  // Rewritten for the every-agent requirement chain (Orca spec 2026-10-15 §6.1, ruling R2; human named E3 on 2026-10-15):
  // the refusal now holds for a codex model the catalog does not list ("fixture"), whose resolution answers null.
  // Ruling: human named E3 in Orca session a852f96a, 2026-10-15.
  it("C3: accept refuses single-call work for an agent that answers null (a codex model the catalog does not list), by name and before anything is persisted", async () => {
    const { path, table } = await twoAgentTable();
    const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-single-call-refused-")));
    dirs.push(sourceDir);
    const { resolution } = await resolveAgent(table, { agent: "codex", model: "fixture" });
    const envelope = singleCallEnvelope({ sourceDir, agent: resolution.selection, configHash: resolution.configHash });
    expect(await runControlCommand(["accept", "--agents", path], JSON.stringify(envelope))).toEqual({ code: 2, stdout: "", stderr: "single-call-unsupported\n" });
    expect(await readdir(sourceDir)).toEqual([]);
  });

  // Every-agent requirement chain (Orca spec 2026-10-15 §6.1, R2; only-add): a codex catalog model answers v1-soft, so
  // accept admits its single-call work exactly as C4 admits claude's.
  it("C3b: accept admits codex single-call work for a catalog model (v1-soft)", async () => {
    const { path, table } = await twoAgentTable();
    const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-single-call-admitted-")));
    dirs.push(sourceDir);
    const { resolution } = await resolveAgent(table, { agent: "codex" });
    expect(resolution.singleCallExecution).toBe("v1-soft");
    const envelope = singleCallEnvelope({ sourceDir, agent: resolution.selection, configHash: resolution.configHash });
    const status = await acceptStart(envelope, {
      agentsTablePath: path,
      workerCommand: [resolve("node_modules/.bin/tsx"), resolve("tests/fixtures/control-worker.mjs")],
      receiptTimeoutMs: 2_000,
    });
    expect(status.kind).toBe("accepted");
    expect(JSON.parse(await readFile(join(sourceDir, "control", "envelope.json"), "utf8"))).toEqual(envelope);
  });

  it("C4: accept admits single-call work for claude and seals its envelope", async () => {
    const { path, table } = await twoAgentTable();
    const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-single-call-admitted-")));
    dirs.push(sourceDir);
    const { resolution } = await resolveAgent(table, { agent: "claude" });
    const envelope = singleCallEnvelope({ sourceDir, agent: resolution.selection, configHash: resolution.configHash });
    const status = await acceptStart(envelope, {
      agentsTablePath: path,
      workerCommand: [resolve("node_modules/.bin/tsx"), resolve("tests/fixtures/control-worker.mjs")],
      receiptTimeoutMs: 2_000,
    });
    expect(status.kind).toBe("accepted");
    expect(JSON.parse(await readFile(join(sourceDir, "control", "envelope.json"), "utf8"))).toEqual(envelope);
  });
});
