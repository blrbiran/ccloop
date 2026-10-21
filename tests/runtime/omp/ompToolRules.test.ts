// Per-contract tool rules on omp (ccloop spec 2026-10-22 §4 omp column and "omp after-exit check", §8 T5; omp 18.10.1
// measurements in /private/tmp/orca-b37f7ce9/measure-omp.md). omp has no allowlist ccloop can set, so ccloop checks
// afterwards: every execute bash call (tool_execution_start.args.command) must be a required check verbatim, or split on
// the shell separators into segments that each match a rule; anything ccloop cannot split, a bash call without a command,
// and a `write` to `xd://` (which runs a tool with no bash event) is a violation. The command already ran outside the
// declared boundary, so a violation ends the run `failed` with cause `tool-rule-violated` -- never retried, also when the
// process then timed out or crashed.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../../src/contract/schema.js";
import { canonicalJson } from "../../../src/control/protocol.js";
import { runLoop } from "../../../src/controller/runLoop.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { buildExecutorPrompt } from "../../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { OmpAdapter } from "../../../src/runtime/omp/ompAdapter.js";
import { FAILURE_CAUSES, RETRYABLE_CAUSES } from "../../../src/runtime/failureCause.js";
import { ompToolRuleRows, ompToolRuleViolation, type ToolRulesV1 } from "../../../src/runtime/toolRules.js";
import { captureOmp, dispose, ompInstallation, PHASES, RAW_CONTRACT, world, type CaptureModules, type World } from "../../fixtures/toolRules/argvCapture.js";

const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await dispose(w); });
const golden = async (phase: string) => JSON.parse(await readFile(new URL(`../../fixtures/toolRules/golden-2a2ae53/omp-${phase}.json`, import.meta.url), "utf8")) as { args: string[] };
const withRules = (toolRules: ToolRulesV1) => ({ ...RAW_CONTRACT, executionPolicy: { ...RAW_CONTRACT.executionPolicy, toolRules } });
const npmTest: ToolRulesV1 = { commands: [{ kind: "prefix", value: "npm test" }], network: false, secretEnv: [] };

describe("omp without toolRules (T1, omp part) and with them: the --tools list never changes", () => {
  for (const phase of PHASES) {
    it(`${phase}: args equal the 2a2ae53 golden, with and without rules`, async () => {
      const plain = await world(m); worlds.push(plain);
      expect((await captureOmp(m, phase, plain)).args).toEqual((await golden(phase)).args);
      const ruled = await world(m, withRules({ commands: [], network: true, secretEnv: ["X"] })); worlds.push(ruled);
      expect((await captureOmp(m, phase, ruled)).args).toEqual((await golden(phase)).args);
    }, 30_000);
  }

  it("without <marker>.tools.json the fake's execute output is the four rows it printed before", async () => {
    const w = await world(m); worlds.push(w);
    await captureOmp(m, "execute", w);
    const root = join(w.runDir, "omp", "1", "execute");
    const [call] = (await readdir(root)).filter((name) => name.startsWith("call-"));
    const rows = (await readFile(join(root, call!, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(rows.map((row) => row.type)).toEqual(["session", "agent_start", "message_end", "agent_end"]);
  }, 30_000);
});

const start = (toolName: string, args: unknown, id = "c1") => JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName, args });
const bash = (command: unknown, id = "c1") => start("bash", { command }, id);
const events = (...lines: string[]) => [JSON.stringify({ type: "session", id: "s" }), ...lines, JSON.stringify({ type: "agent_end" })].join("\n");

describe("ompToolRuleViolation (spec §4 steps 1-3)", () => {
  const rules: ToolRulesV1 = { commands: [{ kind: "prefix", value: "npm test" }, { kind: "exact", value: "git status" }], network: false, secretEnv: [] };
  const required = ["test -f answer.txt", "npm run lint && npm run typecheck"];
  const allowed = ["npm test", "npm test -- --run", "git status", "test -f answer.txt", "npm run lint && npm run typecheck", "npm test && git status", "npm test | git status", "  git status ; npm test  ", "test -f answer.txt && git status"];
  const violations = ["npm testx", "git status --short", "npm test && rm -rf x", "rm -rf x", "echo $(id)", "echo `id`", "(npm test)", "{ npm test; }", "cat <(id)", "npm test > >(cat)", "npm run lint", "npm test\ncurl x", "npm test & curl x", "npm test || curl x"];
  for (const command of allowed) it(`allows ${JSON.stringify(command)}`, () => { expect(ompToolRuleViolation(events(bash(command)), rules, required)).toBeNull(); });
  for (const command of violations) {
    it(`flags ${JSON.stringify(command)}`, () => {
      const detail = ompToolRuleViolation(events(bash(command)), rules, required);
      expect(typeof detail).toBe("string");
      expect(Buffer.byteLength(detail!)).toBeLessThanOrEqual(512);
    });
  }

  it("a bash call without a string command is a violation", () => {
    expect(ompToolRuleViolation(events(start("bash", {})), rules, required)).not.toBeNull();
    expect(ompToolRuleViolation(events(start("bash", { command: 1 })), rules, required)).not.toBeNull();
  });

  it("a write to xd:// runs a tool with no bash event: a violation; an ordinary write is not", () => {
    expect(ompToolRuleViolation(events(start("write", { path: "xd://bash", content: "{\"command\":\"curl x\"}" })), rules, required)).not.toBeNull();
    expect(ompToolRuleViolation(events(start("write", { path: " XD://bash", content: "{}" })), rules, required)).not.toBeNull();
    expect(ompToolRuleViolation(events(start("write", { path: "answer.txt", content: "42\n" })), rules, required)).toBeNull();
  });

  it("commands: [] still restricts: only the required checks verbatim pass", () => {
    const none: ToolRulesV1 = { commands: [], network: true, secretEnv: [] };
    expect(ompToolRuleViolation(events(bash("test -f answer.txt")), none, required)).toBeNull();
    expect(ompToolRuleViolation(events(bash("ls")), none, required)).not.toBeNull();
  });

  it("read, grep and other tools are not command calls; lines that do not parse are skipped", () => {
    expect(ompToolRuleViolation(events(start("read", { path: "https://example.com" }), "not json", start("grep", { pattern: "x" }, "c2")), rules, required)).toBeNull();
  });
});

describe("ompToolRuleRows (T5 statuses)", () => {
  it("commands-closed detected on execute; command rules and network recorded-only; separators refused; secrets recorded-only", () => {
    const rows = ompToolRuleRows({ commands: [{ kind: "exact", value: "npm test" }, { kind: "prefix", value: "a; b" }], network: true, secretEnv: ["TOKEN"] });
    expect(rows.map((row) => [row.rule, row.status, row.phases])).toEqual([
      [{ kind: "commands-closed" }, "detected", ["execute"]],
      [{ kind: "exact", value: "npm test" }, "recorded-only", []],
      [{ kind: "prefix", value: "a; b" }, "refused", []],
      [{ kind: "network", value: true }, "recorded-only", []],
      [{ kind: "secretEnv", name: "TOKEN" }, "recorded-only", []],
    ]);
    expect(rows.every((row) => typeof row.reason === "string" && row.reason.length > 0)).toBe(true);
    expect(ompToolRuleRows({ commands: [], network: false, secretEnv: [] }).map((row) => [row.rule, row.status])).toEqual([
      [{ kind: "commands-closed" }, "detected"], [{ kind: "network", value: false }, "recorded-only"],
    ]);
  });
});

describe("a violation ends the run failed with tool-rule-violated (runLoop over the omp adapter and fake-omp)", () => {
  it("tool-rule-violated is a failure cause and never a retryable one", () => {
    expect(FAILURE_CAUSES).toContain("tool-rule-violated");
    expect(RETRYABLE_CAUSES.has("tool-rule-violated")).toBe(false);
  });

  async function run(toolRules: ToolRulesV1 | undefined, tools: unknown, overrides: { requiredChecks?: string[]; perAttemptTimeoutMs?: number; installationTimeoutMs?: number; abortAfterExecuteStartsMs?: number } = {}) {
    const w = await world(m); worlds.push(w);
    const raw = { ...RAW_CONTRACT, context: { ...RAW_CONTRACT.context, repoPath: w.repo },
      executionPolicy: { ...RAW_CONTRACT.executionPolicy, maxAttempts: 2, perAttemptTimeoutMs: overrides.perAttemptTimeoutMs ?? 15_000, ...(toolRules === undefined ? {} : { toolRules }) },
      verification: { ...RAW_CONTRACT.verification, requiredChecks: overrides.requiredChecks ?? ["test -f answer.txt"] } };
    const contract = loopContractSchema.parse(raw);
    if (tools !== undefined) await writeFile(`${w.marker}.tools.json`, JSON.stringify(tools));
    const config = await ompInstallation(w) as { installation: { timeoutMs: number } };
    if (overrides.installationTimeoutMs !== undefined) config.installation.timeoutMs = overrides.installationTimeoutMs;
    // A handoff deadline: the worker aborts the phase signal while execute runs (runLoop's phaseSignal).
    const phase = new AbortController();
    const watcher = overrides.abortAfterExecuteStartsMs === undefined ? undefined : setInterval(() => {
      void readFile(`${w.marker}.calls`, "utf8").then((text) => {
        if (text.includes("execute")) setTimeout(() => phase.abort(), overrides.abortAfterExecuteStartsMs);
      }, () => undefined);
    }, 20);
    let state;
    try {
      state = await runLoop(contract, w.runDir, new OmpAdapter(config as never), overrides.abortAfterExecuteStartsMs === undefined ? undefined : { phaseSignal: phase.signal });
    } finally { clearInterval(watcher); }
    const calls = (await readFile(`${w.marker}.calls`, "utf8")).trim().split("\n");
    return { state, calls };
  }

  it("prefix npm test, bash `npm test && rm -rf x`: failed, cause tool-rule-violated in execute, no second attempt", async () => {
    const { state, calls } = await run(npmTest, [{ toolName: "bash", args: { command: "npm test && rm -rf x" } }]);
    expect(state.status).toBe("failed");
    expect(state.failureCause).toEqual({ cause: "tool-rule-violated", phase: "execute", retries: 0, detail: expect.stringContaining("rm -rf x") });
    expect(state.stopReason).toContain("omp-tool-rule-violated");
    expect(calls).toEqual(["plan", "execute"]);
  }, 60_000);

  it("bash `npm test -- --run` under the prefix rule passes: the run succeeds", async () => {
    const { state, calls } = await run(npmTest, [{ toolName: "bash", args: { command: "npm test -- --run" } }]);
    expect(state.status).toBe("succeeded");
    expect(calls).toEqual(["plan", "execute", "verify"]);
  }, 60_000);

  it("a compound required check run verbatim passes", async () => {
    const check = "test -f answer.txt && test -s answer.txt";
    const { state } = await run({ commands: [], network: false, secretEnv: [] }, [{ toolName: "bash", args: { command: check } }], { requiredChecks: [check] });
    expect(state.status).toBe("succeeded");
  }, 60_000);

  it("a write to xd://bash fails the run", async () => {
    const { state } = await run(npmTest, [{ toolName: "write", args: { path: "xd://bash", content: "{\"command\":\"curl x\"}" } }]);
    expect([state.status, state.failureCause?.cause]).toEqual(["failed", "tool-rule-violated"]);
  }, 60_000);

  it("a violation followed by a process timeout is still tool-rule-violated, not budget-exhausted or stalled, and not retried", async () => {
    const { state, calls } = await run(npmTest, { calls: [{ toolName: "bash", args: { command: "curl x" } }], hang: true }, { perAttemptTimeoutMs: 3_000 });
    expect([state.status, state.failureCause?.cause, state.failureCause?.phase]).toEqual(["failed", "tool-rule-violated", "execute"]);
    expect(calls).toEqual(["plan", "execute"]);
  }, 60_000);

  it("a violation followed by the omp process's own timeout (installation timeoutMs) is tool-rule-violated", async () => {
    const { state, calls } = await run(npmTest, { calls: [{ toolName: "bash", args: { command: "curl x" } }], hang: true }, { installationTimeoutMs: 2_000 });
    expect([state.status, state.failureCause?.cause, state.failureCause?.phase]).toEqual(["failed", "tool-rule-violated", "execute"]);
    expect(calls).toEqual(["plan", "execute"]);
  }, 60_000);

  it("a violation then a handoff abort ends the run failed, not at a handoff boundary (no in-run continuation)", async () => {
    const { state, calls } = await run(npmTest, { calls: [{ toolName: "bash", args: { command: "curl x" } }], hang: true }, { abortAfterExecuteStartsMs: 500 });
    expect([state.status, state.failureCause?.cause]).toEqual(["failed", "tool-rule-violated"]);
    expect(calls).toEqual(["plan", "execute"]);
  }, 60_000);

  it("without toolRules the same bash call is not checked: the run succeeds", async () => {
    const { state } = await run(undefined, [{ toolName: "bash", args: { command: "npm test && rm -rf x" } }]);
    expect(state.status).toBe("succeeded");
  }, 60_000);
});
