import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import type { AgentSelectionV1, AgentsTableV1 } from "../../src/agents/types.js";
import type { LoopContract } from "../../src/contract/schema.js";
import { codexFixture, exec } from "../runtime/codex/fixture.js";

// Consolidation step 2 (spec 2026-10-01-agents-resume-sweep-design.md §3.2, criteria 2 and 3): `resume --run-dir <dir>
// --agents <table>` continues a run started by `run --agents`, with an adapter rebuilt from the selection that run froze
// into `<dir>/agent-selection.json`. Every refusal (missing, invalid, hash mismatch) happens before resumeLoop writes
// anything, so the run directory is left byte-for-byte as it was.
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

// The interrupted run: the crafted shape of tests/controller/resumeLoop.integration.test.ts's seedEligibleRun (status
// `executing` after attempt 1, owner lost, transfer and reconciliation eligible for continuation), copied rather than
// imported. maxAttempts is raised to 2 so the resumed attempt 2 is within budget.
// `seed` lays those files over whatever the run directory already holds (see the first criterion below).
async function interruptedRun() {
  const f = await codexFixture("integration");
  dirs.push(f.dir);
  const contract: LoopContract = { ...f.contract, executionPolicy: { ...f.contract.executionPolicy, maxAttempts: 2 } };
  const runDir = f.runDir;
  const seed = async () => {
    await mkdir(join(runDir, "attempts"), { recursive: true });
    await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
    await writeFile(join(runDir, "events.jsonl"), "");
    await writeFile(join(runDir, "loop-state.json"), JSON.stringify({
      status: "executing", currentAttempt: 1, attemptsUsed: 1,
      lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
      budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 20000, tokenBudgetRemaining: 1000 },
      recentFailures: [],
    }));
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
      runId: "codex-test", logicalSessionId: "codex-test:t0", currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:100", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current", supersededByEpoch: null,
    }));
    await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify({
      priorOwnerEpoch: 1, newOwnerEpoch: 2, priorProcessInstanceId: "pid:100",
      newProcessInstanceId: "pid:100", transferredAt: "2026-07-25T00:00:00.000Z",
      reason: "owner lost", eligibleForContinuation: true,
    }));
    await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify({
      staleSuspicionBasis: [], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute", conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "ok" },
      priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true,
    }));
  };
  const table: AgentsTableV1 = {
    schema: "ccloop-agents-table-v1",
    installations: {
      "codex-fake": { kind: "codex", command: [...f.config.command] as [string, ...string[]], version: "9.9.9-fake", configDir: null, timeoutMs: 10_000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft" },
    },
  };
  const tablePath = join(f.dir, "agents.json");
  await writeFile(tablePath, JSON.stringify(table), { mode: 0o600 });
  // A model no default would produce, so the argv the fake codex records proves the frozen selection was used.
  const selection: AgentSelectionV1 = { agent: "codex-fake", model: "gpt-6-frozen", contextWindow: "agent-default" };
  const { resolution } = await resolveAgent(table, selection);
  const contractPath = join(f.dir, "contract.json");
  await writeFile(contractPath, JSON.stringify(contract));
  return { ...f, runDir, tablePath, contractPath, selection, configHash: resolution.configHash, seed };
}

// The file exactly as `run --agents` writes it (src/cli.ts, runWithAgents): JSON + newline, owner-only.
async function freeze(runDir: string, content: string): Promise<void> {
  await writeFile(join(runDir, "agent-selection.json"), content, { mode: 0o600 });
}

async function ccloop(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return exec(process.execPath, ["--import", loader, cli, ...args], { cwd, timeout: 20_000 })
    .then((r) => ({ ...r, code: 0 }), (e: { stdout: string; stderr: string; code: number }) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
}

async function resumeCli(w: Awaited<ReturnType<typeof interruptedRun>>): Promise<{ code: number; stdout: string; stderr: string }> {
  return ccloop(["resume", "--run-dir", w.runDir, "--agents", w.tablePath], w.dir);
}

// Recursive byte snapshot: every path under the run directory (directories included) mapped to the sha256 of its
// content, the way tests/registry/zeroWrite.test.ts compares a tree. A refusal that wrote, renamed or removed
// anything changes this map.
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), key = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) { out[key] = "directory"; await walk(path, key); }
      else out[key] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  await walk(root, "");
  return out;
}

describe("ccloop resume --agents (consolidation step 2, spec §3.2)", () => {
  // The frozen file here is the one `run --agents` itself wrote: the run is started for real through the CLI, then its
  // state files are overwritten with the interrupted shape (a crash mid-attempt cannot be produced deterministically
  // from outside the process), and `resume --agents` finds only what `run --agents` left behind.
  it("resumes a run started by run --agents with the frozen selection", async () => {
    const w = await interruptedRun();
    const selectionPath = join(w.dir, "selection.json");
    await writeFile(selectionPath, JSON.stringify({ selection: w.selection, configHash: w.configHash }), { mode: 0o600 });
    const started = await ccloop(["run", "--contract", w.contractPath, "--run-dir", w.runDir, "--agents", w.tablePath, "--agent-selection", selectionPath], w.dir);
    expect(started.code, started.stderr).toBe(0);
    await w.seed();
    await writeFile(`${w.config.command[3]}.argv`, "");
    await exec("git", ["checkout", "--", "answer.txt"], { cwd: w.repo });
    const result = await resumeCli(w);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("Codex budgetMode=soft");
    const state = JSON.parse(await readFile(join(w.runDir, "loop-state.json"), "utf8"));
    expect(state.status).toBe("succeeded");
    expect(state.attemptsUsed).toBe(2);
    const argv = (await readFile(`${w.config.command[3]}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(argv.map((args) => args[args.indexOf("--model") + 1])).toEqual(["gpt-6-frozen", "gpt-6-frozen", "gpt-6-frozen"]);
  }, 30_000);

  // A run started before this step, or with --adapter, has no frozen file and is resumable only the way it always was.
  it("refuses a run with no frozen selection, leaving it unchanged", async () => {
    const w = await interruptedRun();
    await w.seed();
    const before = await snapshot(w.runDir);
    const result = await resumeCli(w);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("agent-selection-missing");
    expect(await snapshot(w.runDir)).toEqual(before);
  }, 30_000);

  // The table's hashed fields changed since the run froze its selection: the rebuilt agent would not be the one the
  // run started with.
  it("refuses a frozen selection whose configHash no longer matches", async () => {
    const w = await interruptedRun();
    await w.seed();
    const other = w.configHash.startsWith("0") ? "1".repeat(64) : "0".repeat(64);
    await freeze(w.runDir, `${JSON.stringify({ selection: w.selection, configHash: other })}\n`);
    const before = await snapshot(w.runDir);
    const result = await resumeCli(w);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("control-config-hash-mismatch");
    expect(await snapshot(w.runDir)).toEqual(before);
  }, 30_000);

  it("refuses an invalid frozen selection file", async () => {
    const w = await interruptedRun();
    await w.seed();
    await freeze(w.runDir, "not json");
    const before = await snapshot(w.runDir);
    const result = await resumeCli(w);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("agent-selection-file-invalid");
    expect(await snapshot(w.runDir)).toEqual(before);
  }, 30_000);
});
