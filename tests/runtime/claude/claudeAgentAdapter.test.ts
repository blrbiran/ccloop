import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, type MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { proveStopped, type StopProofRecord } from "../../../src/control/stopProof.js";
import { ClaudeAgentAdapter, ClaudePhaseAborted, claudeRunnerPath } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import type { AttemptContext } from "../../../src/runtime/types.js";
import { codexFixture } from "../codex/fixture.js";

// Orca agent selection (2026-09-26), spec §4.7 and §9 criteria 3, 4, 5: ClaudeAgentAdapter drives the
// claude CLI (here tests/fixtures/fake-claude-cli.mjs) through scripts/claude-phase-runner.mjs in a
// registered process group. These criteria exist because the older SubprocessClaudeAdapter never
// registered anything, which made the control stop proof hold vacuously (spec §1.2).
const exec = promisify(execFile);
const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const alive = async (pid: number) => exec("ps", ["-o", "stat=", "-p", String(pid)]).then((r) => r.stdout.trim().length > 0 && !r.stdout.trim().startsWith("Z"), () => false);
const pgidOf = async (pid: number) => Number((await exec("ps", ["-o", "pgid=", "-p", String(pid)])).stdout.trim());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function fixture(mode: "ok" | "hang" | "grandchild", selection: Partial<MaterializedAgentConfigV1["selection"]> = {}, installation: Partial<MaterializedAgentConfigV1["installation"]> = {}) {
  const f = await codexFixture("unused");
  const marker = join(f.dir, "claude-marker.json");
  cleanup.push(async () => {
    for (const path of [marker, `${marker}.grandchild`]) {
      try {
        const raw = await readFile(path, "utf8");
        const pid = path === marker ? JSON.parse(raw).pid as number : Number(raw);
        if (await alive(pid)) process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(f.dir, { recursive: true, force: true });
  });
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1",
    kind: "claude",
    installation: { kind: "claude", command: [process.execPath, fakeCli, mode, marker], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300, ...installation },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default", ...selection },
  };
  const context: AttemptContext = { ...f.context };
  return { ...f, marker, config, context };
}

const argvLines = async (marker: string): Promise<string[][]> =>
  (await readFile(`${marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);

describe("ClaudeAgentAdapter (Orca agent selection, spec §4.7)", () => {
  it("finds the phase runner script from the source tree", () => {
    expect(existsSync(claudeRunnerPath())).toBe(true);
  });

  it("passes the selected model to the claude CLI and returns the structured answer with its usage", async () => {
    const f = await fixture("ok");
    const plan = await new ClaudeAgentAdapter(f.config).plan(f.context);
    expect(plan).toMatchObject({ summary: "fixture", primaryTargetPaths: ["answer.txt"], tokenUsage: 15 });
    const [argv] = await argvLines(f.marker);
    expect(argv!.slice(0, 4)).toEqual(["-p", "--output-format", "json", "--json-schema"]);
    expect(argv!.slice(5, 7)).toEqual(["--model", "claude-opus-5-5"]);
    expect(argv).toHaveLength(8);
    expect(argv![7]).toContain("Plan one isolated L2 attempt for task codex-test.");
  });

  it("selects the 1M context window by the [1m] model suffix", async () => {
    const f = await fixture("ok", { contextWindow: 1_000_000 });
    await new ClaudeAgentAdapter(f.config).plan(f.context);
    const [argv] = await argvLines(f.marker);
    expect(argv!.slice(5, 7)).toEqual(["--model", "claude-opus-5-5[1m]"]);
  });

  it("refuses at construction a context window the claude CLI cannot express", async () => {
    const f = await fixture("ok", { contextWindow: 200_000 });
    let caught: unknown;
    try { new ClaudeAgentAdapter(f.config); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).code).toBe("agent-context-unsupported");
  });

  it("sets CLAUDE_CONFIG_DIR only when the installation names a configDir", async () => {
    const withDir = await fixture("ok", {}, { configDir: "/tmp/ccloop-claude-config-fixture" });
    await new ClaudeAgentAdapter(withDir.config).plan(withDir.context);
    expect(JSON.parse(await readFile(withDir.marker, "utf8")).claudeConfigDir).toBe("/tmp/ccloop-claude-config-fixture");
    const inherited = await fixture("ok");
    await new ClaudeAgentAdapter(inherited.config).plan(inherited.context);
    expect(JSON.parse(await readFile(inherited.marker, "utf8")).claudeConfigDir).toBe(process.env.CLAUDE_CONFIG_DIR ?? null);
  });

  it("keeps private per-call evidence and does not record the environment in request.json", async () => {
    const f = await fixture("ok");
    await new ClaudeAgentAdapter(f.config).plan(f.context);
    const root = join(f.context.runDir, "claude", "1", "plan");
    const [call] = await readdir(root);
    const dir = join(root, call!);
    expect((await readdir(dir)).sort()).toEqual(["outcome.json", "process.json", "request.json", "stderr.log", "stdout.json", "usage.json"]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(dir)) expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
    const request = await readFile(join(dir, "request.json"), "utf8");
    expect(JSON.parse(request)).toMatchObject({ phase: "plan", attempt: 1, worktreePath: f.context.worktreePath });
    expect(request).not.toContain("CCLOOP_CLAUDE");
    expect(JSON.parse(await readFile(join(dir, "outcome.json"), "utf8"))).toMatchObject({ reason: "completed", extraArgs: ["--model", "claude-opus-5-5"], claudeCommand: f.config.installation.command });
  });

  it("times out a hanging CLI by itself and leaves no process of the group behind", async () => {
    const f = await fixture("hang", {}, { timeoutMs: 500 });
    await expect(new ClaudeAgentAdapter(f.config).plan(f.context)).rejects.toThrow(/^claude-timeout: /);
    const { pid } = JSON.parse(await readFile(f.marker, "utf8"));
    await expect.poll(() => alive(pid), { timeout: 2000 }).toBe(false);
  }, 10_000);

  // §0.2 P23 m6: the timeout is min(installation.timeoutMs, remaining budget), not the installation value
  // alone. installation.timeoutMs is deliberately generous (20s) here; only the tiny remaining budget can
  // explain a timeout this fast. Mutation Mbudget: drop the Math.min down to installation.timeoutMs alone.
  it("caps the timeout by the remaining runtime budget, not just the installation's timeoutMs", async () => {
    const f = await fixture("hang", {}, { timeoutMs: 20_000 });
    const context: AttemptContext = {
      ...f.context,
      state: { ...f.context.state, budgetSnapshot: { ...f.context.state.budgetSnapshot, timeRemainingMs: 300 } },
    };
    const startedAt = Date.now();
    await expect(new ClaudeAgentAdapter(f.config).plan(context)).rejects.toThrow(/^claude-timeout: /);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  }, 10_000);

  // §9 criterion 3 — the vacuous-stop-proof regression. Mutation: delete the onProcessRegistered call.
  it("registers the runner's process group, so the stop proof refuses while that group is alive", async () => {
    const f = await fixture("hang");
    const sourceDir = join(f.dir, "source");
    await mkdir(join(sourceDir, "control"), { recursive: true });
    await mkdir(join(sourceDir, "run"));
    await writeFile(join(sourceDir, "run", "owner-record.json"), JSON.stringify({
      runId: "task-1", logicalSessionId: "session-1", currentOwnerEpoch: 1, currentProcessInstanceId: "process-1",
      lastAffirmedAt: new Date().toISOString(), ownerStatus: "current", supersededByEpoch: null, leaseAffirmedAt: null,
    }));
    const processesPath = join(sourceDir, "control", "processes.json");
    await writeFile(processesPath, "[]\n");
    const record: StopProofRecord = {
      sourceDir,
      accepted: {
        protocol: 1, envelopeHash: "a".repeat(64), executionId: "execution-1", configHash: "b".repeat(64), generation: 2,
        acceptedAt: new Date().toISOString(), launch: "sealed", worker: { pid: process.pid, startedAt: new Date().toISOString(), nonce: "nonce-1" },
      },
    };
    const abort = new AbortController();
    // The same file shape the control worker's registerProcess keeps (src/control/worker.ts).
    const context: AttemptContext = {
      ...f.context,
      abortSignal: abort.signal,
      onProcessRegistered: async (registration) => {
        const existing = JSON.parse(await readFile(processesPath, "utf8")) as unknown[];
        await writeFile(processesPath, JSON.stringify([...existing, { ...registration, registeredAt: new Date().toISOString() }]));
      },
    };
    const running = new ClaudeAgentAdapter(f.config).plan(context);
    await expect.poll(() => existsSync(`${f.marker}.argv`), { timeout: 5000 }).toBe(true);
    await expect.poll(() => readFile(f.marker, "utf8").then(() => true, () => false), { timeout: 2000 }).toBe(true);
    const registered = JSON.parse(await readFile(processesPath, "utf8")) as Array<{ pid: number; pgid: number; phase: string }>;
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ phase: "plan" });
    expect(registered[0]!.pgid).toBe(registered[0]!.pid);
    const cliPid = JSON.parse(await readFile(f.marker, "utf8")).pid as number;
    expect(await pgidOf(cliPid)).toBe(registered[0]!.pgid);
    expect(await proveStopped(record, { graceMs: 20 })).toBeNull();
    abort.abort();
    const error = await running.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudePhaseAborted);
    expect((error as ClaudePhaseAborted).observedTokens).toBeNull();
    // Control: once the registered group is gone the same record does prove the stop.
    await expect.poll(async () => (await proveStopped(record, { graceMs: 20 }))?.isolated ?? false, { timeout: 3000 }).toBe(true);
  }, 20_000);

  // §9 criterion 4 — the prompt is written only after registration returns. Held on a test-controlled
  // promise, not on kill timing. Mutation: move `await writeRequest()` above `await context.onProcessRegistered`.
  it("writes nothing to the runner until the registration callback has returned", async () => {
    const f = await fixture("ok");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let beforeRelease: { cliStarted: boolean; requestWritten: boolean } | undefined;
    const root = join(f.context.runDir, "claude", "1", "plan");
    const context: AttemptContext = {
      ...f.context,
      onProcessRegistered: async () => {
        // Give a runner that did receive its request ample time to start the CLI (it takes well under a second).
        let cliStarted = false;
        for (const deadline = Date.now() + 3000; Date.now() < deadline && !cliStarted; await sleep(50)) cliStarted = existsSync(`${f.marker}.argv`);
        const [call] = await readdir(root);
        beforeRelease = { cliStarted, requestWritten: existsSync(join(root, call!, "request.json")) };
        await gate;
      },
    };
    const running = new ClaudeAgentAdapter(f.config).plan(context);
    await expect.poll(() => beforeRelease, { timeout: 8000 }).toBeDefined();
    expect(beforeRelease).toEqual({ cliStarted: false, requestWritten: false });
    release();
    expect(await running).toMatchObject({ summary: "fixture" });
    expect(await argvLines(f.marker)).toHaveLength(1);
  }, 20_000);

  // §9 criterion 5 — stopping kills the whole group, including the CLI's own child (the runner's
  // grandchild, spec M9). Mutation: in `kill`, signal `child.pid` instead of `-child.pid`.
  it("kills the runner's grandchild within killGraceMs of an abort", async () => {
    const f = await fixture("grandchild");
    const abort = new AbortController();
    const running = new ClaudeAgentAdapter(f.config).execute({ ...f.context, abortSignal: abort.signal });
    await expect.poll(() => readFile(`${f.marker}.grandchild`, "utf8").then(Number, () => 0), { timeout: 5000 }).toBeGreaterThan(0);
    const grandchild = Number(await readFile(`${f.marker}.grandchild`, "utf8"));
    const registered = JSON.parse(await readFile(join((await readdir(join(f.context.runDir, "claude", "1", "execute"))).map((call) => join(f.context.runDir, "claude", "1", "execute", call))[0]!, "process.json"), "utf8")) as { pgid: number };
    expect(await pgidOf(grandchild)).toBe(registered.pgid);
    expect(await alive(grandchild)).toBe(true);
    abort.abort();
    expect(await running).toBeNull();
    await expect.poll(() => alive(grandchild), { timeout: f.config.installation.killGraceMs + 500 }).toBe(false);
  }, 20_000);
});
