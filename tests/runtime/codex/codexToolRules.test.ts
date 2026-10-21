// Per-contract tool rules on codex (ccloop spec 2026-10-22 §3.2.2, §4 codex column, §8 T4; codex 0.163.0 measurements in
// /private/tmp/orca-b37f7ce9/measure-codex.md). codex exec has no per-command allowlist, so command rules are only
// recorded. network:true may switch the network on INSIDE workspace-write and never changes --sandbox; it is refused when
// the installation is read-only or the person's config.toml explicitly says false (overriding that is widening).
// network:false turns the sandbox network, web search and the apps connectors off with `-c` pairs, which only managed
// config layers sit above. codex silently ignores a misspelt -c key (measured), so the exact strings are asserted.
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../../src/contract/schema.js";
import { canonicalJson } from "../../../src/control/protocol.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { buildExecutorPrompt } from "../../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { OmpAdapter } from "../../../src/runtime/omp/ompAdapter.js";
import { codexToolRuleArgs, codexToolRuleRows, type ToolRulesV1 } from "../../../src/runtime/toolRules.js";
import { captureCodex, dispose, PHASES, RAW_CONTRACT, world, type CaptureModules, type CodexOptions, type Phase, type World } from "../../fixtures/toolRules/argvCapture.js";

const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await dispose(w); });
const withRules = (toolRules: ToolRulesV1) => ({ ...RAW_CONTRACT, executionPolicy: { ...RAW_CONTRACT.executionPolicy, toolRules } });
async function argsOf(phase: Phase, isolated: boolean, toolRules?: ToolRulesV1, options: CodexOptions = {}) {
  const w = await world(m, toolRules === undefined ? RAW_CONTRACT : withRules(toolRules)); worlds.push(w);
  return (await captureCodex(m, phase, w, isolated, options)).args;
}
const golden = async (phase: Phase) => JSON.parse(await readFile(new URL(`../../fixtures/toolRules/golden-2a2ae53/codex-${phase}.json`, import.meta.url), "utf8")) as { legacy: string[]; isolated: string[] };
/** The golden argv with `pairs` inserted right before the trailing `-` (the prompt on stdin). */
const plus = (args: string[], pairs: string[]) => [...args.slice(0, -1), ...pairs, "-"];
const NET_TRUE = ["-c", "sandbox_workspace_write.network_access=true"];
const NET_FALSE = ["-c", "sandbox_workspace_write.network_access=false"];
const SEARCH_APPS_OFF = ["-c", "web_search=\"disabled\"", "-c", "features.apps=false"];
const open: ToolRulesV1 = { commands: [{ kind: "exact", value: "npm test" }], network: true, secretEnv: [] };
const closed: ToolRulesV1 = { commands: [{ kind: "prefix", value: "npm run" }], network: false, secretEnv: [] };

describe("codex without toolRules (T1, codex part)", () => {
  for (const phase of PHASES) {
    for (const isolated of [false, true]) {
      it(`${phase} (${isolated ? "isolated" : "legacy"}): args equal the 2a2ae53 golden`, async () => {
        expect(await argsOf(phase, isolated)).toEqual((await golden(phase))[isolated ? "isolated" : "legacy"]);
      }, 30_000);
    }
  }
});

describe("codex argv with toolRules (T4)", () => {
  for (const isolated of [false, true]) {
    const path = isolated ? "isolated" : "legacy";
    it(`${path}: network:true on workspace-write ⇒ network_access=true on execute only; --sandbox unchanged`, async () => {
      expect(await argsOf("execute", isolated, open)).toEqual(plus((await golden("execute"))[path], NET_TRUE));
      expect(await argsOf("plan", isolated, open)).toEqual((await golden("plan"))[path]);
      expect(await argsOf("verify", isolated, open)).toEqual((await golden("verify"))[path]);
    }, 60_000);

    it(`${path}: network:false ⇒ network_access=false on execute, web search and apps off on every phase`, async () => {
      expect(await argsOf("execute", isolated, closed)).toEqual(plus((await golden("execute"))[path], [...NET_FALSE, ...SEARCH_APPS_OFF]));
      expect(await argsOf("plan", isolated, closed)).toEqual(plus((await golden("plan"))[path], SEARCH_APPS_OFF));
      expect(await argsOf("verify", isolated, closed)).toEqual(plus((await golden("verify"))[path], SEARCH_APPS_OFF));
    }, 60_000);
  }

  it("a read-only installation: network:true passes nothing and --sandbox stays read-only", async () => {
    const args = await argsOf("execute", true, open, { sandbox: "read-only" });
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args.some((arg) => arg.includes("network_access"))).toBe(false);
  }, 30_000);

  it("the person's config.toml says network_access = false: network:true passes nothing (never overrides the person)", async () => {
    const args = await argsOf("execute", true, open, { configToml: "[sandbox_workspace_write]\nnetwork_access = false\n" });
    expect(args).toEqual((await golden("execute")).isolated);
  }, 30_000);

  it("an unparseable config.toml: network:true passes nothing", async () => {
    const args = await argsOf("execute", true, open, { configToml: "[profiles.x.sandbox_workspace_write]\nnetwork_access = true\n" });
    expect(args).toEqual((await golden("execute")).isolated);
  }, 30_000);

  it("the person's config.toml says true, or nothing: network:true is passed", async () => {
    expect(await argsOf("execute", true, open, { configToml: "sandbox_workspace_write.network_access = true\n" })).toEqual(plus((await golden("execute")).isolated, NET_TRUE));
    expect(await argsOf("execute", true, open, { configToml: null })).toEqual(plus((await golden("execute")).isolated, NET_TRUE));
  }, 60_000);
});

describe("codexToolRuleArgs / codexToolRuleRows (T4 statuses)", () => {
  const absent = { kind: "absent" } as const;
  it("no toolRules: nothing", () => {
    for (const phase of PHASES) expect(codexToolRuleArgs(undefined, phase, "workspace-write", absent)).toEqual([]);
  });

  it("rows for network:true on workspace-write: enforced on execute; commands and commands-closed recorded-only; secrets recorded-only", () => {
    const { rows, baseline } = codexToolRuleRows({ commands: [{ kind: "exact", value: "npm test" }, { kind: "prefix", value: "npm run" }], network: true, secretEnv: ["TOKEN"] }, "workspace-write", absent);
    expect(rows.map((row) => [row.rule, row.status, row.phases])).toEqual([
      [{ kind: "commands-closed" }, "recorded-only", []],
      [{ kind: "exact", value: "npm test" }, "recorded-only", []],
      [{ kind: "prefix", value: "npm run" }, "recorded-only", []],
      [{ kind: "network", value: true }, "enforced", ["execute"]],
      [{ kind: "secretEnv", name: "TOKEN" }, "recorded-only", []],
    ]);
    expect(rows[3]!.reason).toBeNull();
    expect(rows.filter((row) => row.status !== "enforced").every((row) => typeof row.reason === "string" && row.reason.length > 0)).toBe(true);
    expect(baseline.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(baseline)).toBeLessThanOrEqual(1024);
  });

  it("network:true refused: read-only installation, the person's explicit false, an unparseable config", () => {
    const row = (sandbox: "read-only" | "workspace-write", setting: Parameters<typeof codexToolRuleRows>[2]) => codexToolRuleRows(open, sandbox, setting).rows.find((r) => r.rule.kind === "network")!;
    for (const got of [row("read-only", absent), row("workspace-write", { kind: "value", value: false }), row("workspace-write", { kind: "unparseable", reason: "x" })]) {
      expect(got.status).toBe("refused");
      expect(got.phases).toEqual([]);
      expect(got.reason!.length).toBeGreaterThan(0);
    }
  });

  it("network:false is enforced on every phase", () => {
    const network = codexToolRuleRows(closed, "workspace-write", absent).rows.find((r) => r.rule.kind === "network")!;
    expect(network).toEqual({ rule: { kind: "network", value: false }, status: "enforced", reason: null, phases: ["plan", "execute", "verify"] });
  });

  it("a command with a shell separator is refused, not recorded", () => {
    const { rows } = codexToolRuleRows({ commands: [{ kind: "exact", value: "npm test && rm -rf x" }, { kind: "prefix", value: "a | b" }], network: false, secretEnv: [] }, "workspace-write", absent);
    expect(rows.slice(1, 3).map((r) => r.status)).toEqual(["refused", "refused"]);
  });
});

// Review round 1 (Orca session b37f7ce9, M6): the executor prompt states the network as this kind's final status. With
// the person's `network_access = false` codex refuses network:true and passes no -c pair, so telling the agent "allowed"
// would be false.
describe("codex executor prompt states the codex rows (review round 1, M6)", () => {
  const promptOf = async (isolated: boolean, configToml: string) => {
    const w = await world(m, withRules(open)); worlds.push(w);
    await captureCodex(m, "execute", w, isolated, { configToml });
    return (JSON.parse(await readFile(w.marker, "utf8")) as { prompt: string }).prompt;
  };
  for (const isolated of [false, true]) {
    it(`${isolated ? "isolated" : "legacy"}: config.toml network_access = false ⇒ the prompt says the network is not granted`, async () => {
      const prompt = await promptOf(isolated, "[sandbox_workspace_write]\nnetwork_access = false\n");
      expect(prompt).toContain("Network access: not granted");
      expect(prompt).not.toContain("Network access: allowed.");
    }, 30_000);
  }
  it("positive control: no restriction in config.toml ⇒ the prompt says allowed", async () => {
    expect(await promptOf(true, "")).toContain("Network access: allowed.");
  }, 30_000);
});
