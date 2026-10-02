import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { loopContractSchema } from "../../src/contract/schema.js";
import { LEASE_TTL_MS } from "../../src/ownership/lease.js";
import { claudeInstallation, writeAgentsTable } from "../control/agentsFixture.js";
import { codexFixture, exec } from "../runtime/codex/fixture.js";

// Crash-resume spec 2026-10-02 §4.3, criterion T6, from the outside: a real `ccloop run --agents` with a fake claude is
// SIGKILLed mid-execute, its claude runner dies by its own parent watch, and `ccloop resume` carries the run to
// `succeeded`. The kill is real; only the lease ageing is simulated (waiting LEASE_TTL_MS for real would take 90 s).
const fakeCli = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
const dirs: string[] = [];
const children: ChildProcess[] = [];
const pids = new Set<number>();
afterEach(async () => {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  pids.clear();
  for (const c of children.splice(0)) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("ccloop run --agents SIGKILLed mid-execute, then resume", () => {
  it("the runner dies with its parent and resume adopts the run to succeeded", async () => {
    const f = await codexFixture("integration");
    dirs.push(f.dir);
    const marker = join(f.dir, "claude-marker.json"), scriptPath = join(f.dir, "script.json");
    const script = (delay: boolean) => writeFile(scriptPath, JSON.stringify({ "codex-test": { files: { "answer.txt": "42\n" }, ...(delay ? { delayMs: { execute: 60_000 } } : {}) } }));
    await script(true);
    const installation = await claudeInstallation([process.execPath, fakeCli, "script", marker, scriptPath], { timeoutMs: 120_000, killGraceMs: 50 });
    const { path: tablePath, table } = await writeAgentsTable({ "claude-fake": installation }, f.dir);
    const { resolution } = await resolveAgent(table, { agent: "claude-fake", model: "claude-opus-5-5", contextWindow: 1_000_000 });
    const selectionPath = join(f.dir, "selection.json"), contractPath = join(f.dir, "contract.json");
    await writeFile(selectionPath, JSON.stringify({ selection: resolution.selection, configHash: resolution.configHash }), { mode: 0o600 });
    // Room for the resumed second attempt, and a per-attempt timeout longer than the kill sequence.
    const contract = loopContractSchema.parse({ ...f.contract, executionPolicy: { ...f.contract.executionPolicy, maxAttempts: 2, perAttemptTimeoutMs: 120_000, totalRuntimeBudgetMs: 600_000 } });
    await writeFile(contractPath, JSON.stringify(contract));

    // Not killed as a group: the runner is its own group, so only its parent watch can stop it.
    const ccloop = spawn(process.execPath, ["--import", loader, cli, "run", "--contract", contractPath, "--run-dir", f.runDir, "--agents", tablePath, "--agent-selection", selectionPath], { cwd: f.dir, detached: true, stdio: "ignore" });
    children.push(ccloop);
    pids.add(ccloop.pid!);

    await until("execute_started", 20_000, async () => (await readFile(join(f.runDir, "events.jsonl"), "utf8")).includes('"execute_started"') ? true : undefined);
    const runnerPid = await until("the execute runner's process.json", 20_000, async () => {
      const dir = join(f.runDir, "claude", "1", "execute");
      for (const call of await readdir(dir)) {
        const reg = await readFile(join(dir, call, "process.json"), "utf8").then((t) => JSON.parse(t) as { pid?: number }, () => undefined);
        if (reg !== undefined && Number.isSafeInteger(reg.pid)) return reg.pid;
      }
      return undefined;
    });
    pids.add(runnerPid);
    // The fake overwrites <marker> on every call, so the plan call's (already dead) pid may still be there: take the pid
    // only once the marker holds the execute prompt, so the death check below cannot pass vacuously.
    const fakePid = await until("the execute-phase fake claude", 20_000, async () => {
      const m = JSON.parse(await readFile(marker, "utf8")) as { pid?: number; prompt?: string };
      return m.prompt?.includes("Execute one isolated attempt") ? m.pid : undefined;
    });
    pids.add(fakePid);
    expect(alive(fakePid)).toBe(true);
    expect(alive(runnerPid)).toBe(true);

    ccloop.kill("SIGKILL");
    await until("ccloop to exit", 5_000, async () => (ccloop.exitCode !== null || ccloop.signalCode !== null ? true : undefined));
    // PARENT_GONE_GRACE_MS (5 s) plus margin.
    await until("the runner to die with its parent", 12_000, async () => (alive(runnerPid) ? undefined : true));
    await until("fake claude to die", 3_000, async () => (alive(fakePid) ? undefined : true));

    // The kill above is real. Only the lease ageing is simulated: the owner record's lease is moved past its TTL.
    const ownerPath = join(f.runDir, "owner-record.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    await writeFile(ownerPath, JSON.stringify({ ...owner, leaseAffirmedAt: new Date(Date.now() - LEASE_TTL_MS - 1000).toISOString() }, null, 2));
    await script(false);

    const resumed = await exec(process.execPath, ["--import", loader, cli, "resume", "--run-dir", f.runDir, "--agents", tablePath], { cwd: f.dir, timeout: 30_000 })
      .then((r) => ({ ...r, code: 0 }), (e: { stdout: string; stderr: string; code: number }) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
    expect(resumed.code, resumed.stderr).toBe(0);
    const state = JSON.parse(await readFile(join(f.runDir, "loop-state.json"), "utf8")) as { status: string };
    expect(state.status).toBe("succeeded");
    const events = await readFile(join(f.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"owner_crash_adopted"');
    expect(events.indexOf('"owner_crash_adopted"')).toBeLessThan(events.indexOf('"resume_adopted"'));
  }, 90_000);
});
