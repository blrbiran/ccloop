// Crash resume (2026-10-02), spec §3.1 and §7.2, criterion T3: the adapter now hands every runner a fourth pipe (fd 3,
// the parent watch). One long-lived process -- an Orca worker running many phases -- must not keep a descriptor per
// phase. Phases ending each way the adapter can end in-process run here, and this process's /dev/fd count must not grow.
// Endings covered: completed, timeout, aborted, spawn-error (the runner's cwd does not exist), io-error (the registration
// callback throws). Not covered: exit-error and output-limit (no fake-claude mode produces them without a runner change);
// they share finish() with the five above.
import { readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import type { AttemptContext } from "../../../src/runtime/types.js";
import { codexFixture } from "../codex/fixture.js";

const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dirs: string[] = [];
const markers: string[] = [];
afterEach(async () => {
  for (const marker of markers.splice(0)) {
    try { process.kill((JSON.parse(await readFile(marker, "utf8")) as { pid: number }).pid, "SIGKILL"); } catch { /* gone or never started */ }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function adapterFor(mode: "ok" | "hang") {
  const f = await codexFixture("unused");
  dirs.push(f.dir);
  const marker = join(f.dir, "claude-marker.json");
  markers.push(marker);
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1",
    kind: "claude",
    installation: { kind: "claude", command: [process.execPath, fakeCli, mode, marker], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
  };
  return { adapter: new ClaudeAgentAdapter(config), context: f.context, marker };
}

const fdCount = () => readdirSync("/dev/fd").length;

async function onePhaseOfEachEnding(): Promise<string[]> {
  const endings: string[] = [];
  const settle = async (running: Promise<unknown>) => endings.push(await running.then(
    () => "completed",
    (e: unknown) => (e instanceof Error && e.name !== "Error" ? e.name : String((e as Error).message).split(":")[0]!),
  ));

  const ok = await adapterFor("ok");
  await settle(ok.adapter.plan(ok.context));

  const timeout = await adapterFor("hang");
  await settle(timeout.adapter.plan({ ...timeout.context, state: { ...timeout.context.state, budgetSnapshot: { ...timeout.context.state.budgetSnapshot, timeRemainingMs: 800 } } }));

  const aborted = await adapterFor("hang");
  const abort = new AbortController();
  const abortRun = aborted.adapter.plan({ ...aborted.context, abortSignal: abort.signal });
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(50)) {
    if (await readFile(aborted.marker, "utf8").then(() => true, () => false)) break;
  }
  abort.abort();
  await settle(abortRun);

  const spawnError = await adapterFor("ok");
  await settle(spawnError.adapter.plan({ ...spawnError.context, worktreePath: join(spawnError.context.worktreePath, "does-not-exist") }));

  const ioError = await adapterFor("hang");
  await settle(ioError.adapter.plan({ ...ioError.context, onProcessRegistered: async () => { throw new Error("registration refused"); } }));
  return endings;
}

describe("ClaudeAgentAdapter does not leak descriptors across phases (spec 2026-10-02 §7.2, T3)", () => {
  it("keeps this process's /dev/fd count unchanged over phases ending each way", async () => {
    // Warm-up round: the first phase loads modules and opens whatever Node keeps open for good (not a per-phase cost).
    await onePhaseOfEachEnding();
    await sleep(200);
    const before = fdCount();
    const endings = [...await onePhaseOfEachEnding(), ...await onePhaseOfEachEnding()];
    await sleep(200);
    // One comparison, so a wrong ending cannot hide the descriptor count (or the other way round).
    expect({ endings, fdGrowth: fdCount() - before }).toEqual({
      endings: [
        "completed", "claude-timeout", "ClaudePhaseAborted", "claude-spawn-error", "claude-io-error",
        "completed", "claude-timeout", "ClaudePhaseAborted", "claude-spawn-error", "claude-io-error",
      ],
      fdGrowth: 0,
    });
  }, 60_000);
});
