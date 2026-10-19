import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { runLoop } from "../../src/controller/runLoop.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { OmpAdapter } from "../../src/runtime/omp/ompAdapter.js";
import { codexFixture } from "./codex/fixture.js";

// Reported decisions and debug (ccloop spec 2026-10-20 §4.1, §4.3, §7 criteria 1-3). Orca's collect reads what the run
// persisted in attempts/N/execution.json, so each kind must land the agent's decisions and debug there unchanged in meaning,
// and a malformed report must never fail the run (C1: Orca refuses a bad entry into "needs confirmation", where the human
// sees it). The fake CLIs never validate an answer against the schema they were sent, so for claude the sent schema is
// asserted directly.
const fakeClaude = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));
const fakeOmp = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));
const major = { question: "Retry inside the client or the caller?", chose: "caller", alternatives: [{ option: "client", why_not: "hides failures" }], because: "the caller owns the budget", undo: { how: "restore the retry loop in src/client.ts", cost: "small", blast_radius: "src/client.ts" }, scope: "repo", kind: "interface", importance: "major" };
const minor = { question: "Name the helper?", chose: "retryOnce", alternatives: [{ option: "retry", why_not: "too generic" }], because: "says what it does", undo: { how: "rename retryOnce back in src/client.ts", cost: "trivial", blast_radius: "src/client.ts" }, scope: "file", kind: "implementation", importance: "minor" };
const debug = { choseInstead: "fix the parser", reproTests: ["tests/parser.test.ts"], reproCommand: "npx vitest run tests/parser.test.ts" };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(kind: "codex" | "claude" | "omp", reported?: unknown) {
  const f = await codexFixture("reported"); dirs.push(f.dir);
  if (reported !== undefined) await writeFile(`${f.marker}.reported.json`, JSON.stringify(reported));
  if (kind === "codex") return { ...f, adapter: new CodexAdapter(f.config) };
  if (kind === "claude") {
    const config: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: "claude",
      installation: { kind: "claude", command: [process.execPath, fakeClaude, "reported", f.marker], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
      selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } };
    return { ...f, adapter: new ClaudeAgentAdapter(config) };
  }
  const binary = join(f.dir, "omp");
  await writeFile(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeOmp)} ${JSON.stringify(f.marker)} "$@"\n`, { mode: 0o700 });
  const config: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: "omp",
    installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
    selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" } };
  return { ...f, adapter: new OmpAdapter(config) };
}

async function run(kind: "codex" | "claude" | "omp", reported?: unknown) {
  const f = await fixture(kind, reported);
  f.contract.executionPolicy.perAttemptTimeoutMs = 15_000;
  const state = await runLoop(f.contract, f.runDir, f.adapter);
  const execution = JSON.parse(await readFile(join(f.runDir, "attempts", "1", "execution.json"), "utf8")) as Record<string, unknown>;
  return { f, state, execution };
}

describe("criterion 1: every kind persists the reported decisions and debug in attempts/N/execution.json", { timeout: 60_000 }, () => {
  it("codex: the values, with the debug members its strict schema made null removed", async () => {
    const { state, execution } = await run("codex");
    expect(state.status).toBe("succeeded");
    expect(execution.decisions).toEqual([major, minor]);
    expect(execution.debug).toEqual(debug);
  });

  it.each(["claude", "omp"] as const)("%s: the values as given", async (kind) => {
    const { state, execution } = await run(kind, { decisions: [major, minor], debug });
    expect(state.status).toBe("succeeded");
    expect(execution.decisions).toEqual([major, minor]);
    expect(execution.debug).toEqual(debug);
  });

  it("claude: the --json-schema sent for execute carries both as optional properties that accept any JSON", async () => {
    const { f } = await run("claude");
    const argv = (await readFile(`${f.marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const schemas = argv.map((args) => JSON.parse(args[args.indexOf("--json-schema") + 1]!) as { properties: Record<string, unknown>; required: string[] });
    const execute = schemas.filter((schema) => schema.properties.changedFiles !== undefined);
    expect(execute).toHaveLength(1);
    expect(execute[0]!.properties.decisions).toEqual({});
    expect(execute[0]!.properties.debug).toEqual({});
    expect(execute[0]!.required).not.toContain("decisions");
    expect(execute[0]!.required).not.toContain("debug");
  });
});

describe("criteria 2 and 3 through a whole run", { timeout: 60_000 }, () => {
  it.each(["claude", "omp"] as const)("criterion 2 (C1): %s's malformed decisions do not fail the run and are persisted as given", async (kind) => {
    for (const decisions of ["x", [{ question: "only a question" }]]) {
      const { state, execution } = await run(kind, { decisions, debug: 5 });
      expect(state.status).toBe("succeeded");
      expect(execution.decisions).toEqual(decisions);
      expect(execution.debug).toBe(5);
    }
  });

  it("criterion 3: claude's decisions null persists no decisions key; [] is kept", async () => {
    const none = await run("claude", { decisions: null, debug: null });
    expect(none.state.status).toBe("succeeded");
    expect(Object.hasOwn(none.execution, "decisions")).toBe(false);
    expect(Object.hasOwn(none.execution, "debug")).toBe(false);
    expect((await run("claude", { decisions: [] })).execution.decisions).toEqual([]);
  });
});
