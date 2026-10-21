// Per-contract tool rules on claude (ccloop spec 2026-10-22 §3.2, §3.4, §4, §8 T3; plan Task 2 with the claude 2.1.306
// measurements in /private/tmp/orca-b37f7ce9/measure-claude.md). A rule is a grant only where claude can state it exactly
// (an exact `Bash(<cmd>)` or the prefix form `Bash(<cmd> *)`), on execute only; network:false denies WebFetch/WebSearch on
// every phase. Anything claude cannot state exactly is refused and nothing is passed for it: a wider rule in its place
// would let the agent run what the person did not declare. The installation's own permission mode decides whether the
// set is closed (`commands-closed`), and ccloop never touches that mode.
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../../src/contract/schema.js";
import { canonicalJson } from "../../../src/control/protocol.js";
import { ClaudeAgentAdapter, requiredCheckAllowRules } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { buildExecutorPrompt } from "../../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { OmpAdapter } from "../../../src/runtime/omp/ompAdapter.js";
import { claudeToolRuleArgs, claudeToolRuleRows, type ToolRulesV1 } from "../../../src/runtime/toolRules.js";
import { captureClaude, dispose, PHASES, RAW_CONTRACT, world, type CaptureModules, type World } from "../../fixtures/toolRules/argvCapture.js";

const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await dispose(w); });
const withRules = (toolRules: ToolRulesV1) => ({ ...RAW_CONTRACT, executionPolicy: { ...RAW_CONTRACT.executionPolicy, toolRules } });
async function argvOf(phase: "plan" | "execute" | "verify", toolRules?: ToolRulesV1) {
  const w = await world(m, toolRules === undefined ? RAW_CONTRACT : withRules(toolRules)); worlds.push(w);
  return captureClaude(m, phase, w);
}
const listAfter = (argv: string[], option: string): string[] => {
  const at = argv.indexOf(option);
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 1; i < argv.length && !argv[i]!.startsWith("-"); i += 1) out.push(argv[i]!);
  return out;
};
const REQUIRED = ["Bash(npm test)", "Bash(npm run lint)"];
const golden = async (phase: string) => JSON.parse(await readFile(new URL(`../../fixtures/toolRules/golden-2a2ae53/claude-${phase}.json`, import.meta.url), "utf8")) as { argv: string[]; extraArgs: string[] };

describe("claude without toolRules (T1, claude part)", () => {
  for (const phase of PHASES) {
    it(`${phase}: argv and extraArgs equal the 2a2ae53 golden`, async () => {
      const got = await argvOf(phase);
      const want = await golden(phase);
      expect(got.argv).toEqual(want.argv);
      expect(got.extraArgs).toEqual(want.extraArgs);
    }, 30_000);
  }
});

describe("claude argv with toolRules (T3)", () => {
  const rules: ToolRulesV1 = { commands: [{ kind: "exact", value: "npm test" }, { kind: "exact", value: "git status" }, { kind: "prefix", value: "npm run build" }], network: false, secretEnv: [] };

  it("execute: the required checks, then the exact and prefix grants (a grant equal to a required check once), WebFetch/WebSearch denied, all before --model", async () => {
    const { argv, extraArgs } = await argvOf("execute", rules);
    expect(listAfter(argv, "--allowedTools")).toEqual([...REQUIRED, "Bash(git status)", "Bash(npm run build *)"]);
    expect(listAfter(argv, "--disallowedTools")).toEqual(["WebFetch", "WebSearch"]);
    expect(argv.indexOf("--allowedTools")).toBeLessThan(argv.indexOf("--disallowedTools"));
    expect(argv.indexOf("--disallowedTools")).toBeLessThan(argv.indexOf("--model"));
    expect(extraArgs).toEqual(["--allowedTools", ...REQUIRED, "Bash(git status)", "Bash(npm run build *)", "--disallowedTools", "WebFetch", "WebSearch", "--model", "claude-opus-5-5"]);
  }, 30_000);

  it("plan: no grant at all, only the network denial", async () => {
    const { extraArgs } = await argvOf("plan", rules);
    expect(extraArgs).toEqual(["--disallowedTools", "WebFetch", "WebSearch", "--model", "claude-opus-5-5"]);
  }, 30_000);

  it("verify: exactly the required checks plus the network denial -- the execute grants are not given to the verifier", async () => {
    const { extraArgs } = await argvOf("verify", rules);
    expect(extraArgs).toEqual(["--allowedTools", ...REQUIRED, "--disallowedTools", "WebFetch", "WebSearch", "--model", "claude-opus-5-5"]);
  }, 30_000);

  it("network:true: WebFetch and WebSearch are granted on execute only, nothing is denied", async () => {
    const open: ToolRulesV1 = { commands: [], network: true, secretEnv: [] };
    expect((await argvOf("execute", open)).extraArgs).toEqual(["--allowedTools", ...REQUIRED, "WebFetch", "WebSearch", "--model", "claude-opus-5-5"]);
    expect((await argvOf("plan", open)).extraArgs).toEqual(["--model", "claude-opus-5-5"]);
    expect((await argvOf("verify", open)).extraArgs).toEqual(["--allowedTools", ...REQUIRED, "--model", "claude-opus-5-5"]);
  }, 60_000);
});

describe("claudeToolRuleArgs refusals (spec §3.1, §4 claude rows)", () => {
  const refusedValues = ["a && b", "a; b", "a | b", "a & b", "npm test *", "npm run x:*", "node -e f()", "echo a\\b", " npm test", "npm test ", "a\nb", "a\tb"];
  for (const value of refusedValues) {
    for (const kind of ["exact", "prefix"] as const) {
      it(`${kind} ${JSON.stringify(value)}: nothing passed, refused with a reason`, () => {
        const rules: ToolRulesV1 = { commands: [{ kind, value }], network: true, secretEnv: [] };
        const { allow } = claudeToolRuleArgs(rules, "execute", [], requiredCheckAllowRules);
        expect(allow).toEqual(["WebFetch", "WebSearch"]);
        const row = claudeToolRuleRows(rules, ["--permission-mode", "acceptEdits"], requiredCheckAllowRules).rows[1]!;
        expect(row).toEqual({ rule: { kind, value }, status: "refused", reason: expect.any(String), phases: [] });
        expect(row.reason!.length).toBeGreaterThan(0);
      });
    }
  }

  it("a required check is never dropped because a tool rule is present", () => {
    const { allow } = claudeToolRuleArgs({ commands: [{ kind: "exact", value: "npm test" }], network: false, secretEnv: [] }, "execute", REQUIRED, requiredCheckAllowRules);
    expect(allow).toEqual(REQUIRED);
  });

  it("prefix value: the grant is exactly Bash(<value> *), never the legacy :* or a bare wildcard", () => {
    const { allow } = claudeToolRuleArgs({ commands: [{ kind: "prefix", value: "npm test" }], network: true, secretEnv: [] }, "execute", [], requiredCheckAllowRules);
    expect(allow).toEqual(["Bash(npm test *)", "WebFetch", "WebSearch"]);
  });

  it("no toolRules: exactly the required check rules, nothing denied", () => {
    expect(claudeToolRuleArgs(undefined, "execute", REQUIRED, requiredCheckAllowRules)).toEqual({ allow: REQUIRED, disallow: [] });
    expect(claudeToolRuleArgs(undefined, "plan", [], requiredCheckAllowRules)).toEqual({ allow: [], disallow: [] });
  });
});

describe("claudeToolRuleRows: commands-closed from the installation command (spec §3.4)", () => {
  const rules: ToolRulesV1 = { commands: [{ kind: "exact", value: "npm test" }, { kind: "prefix", value: "npm run" }], network: false, secretEnv: ["NPM_TOKEN"] };
  const closed = (command: string[]) => claudeToolRuleRows(rules, command, requiredCheckAllowRules).rows[0]!;

  for (const mode of ["acceptEdits", "default", "manual"]) {
    it(`--permission-mode ${mode} ⇒ enforced on every phase`, () => {
      expect(closed(["--permission-mode", mode])).toEqual({ rule: { kind: "commands-closed" }, status: "enforced", reason: null, phases: ["plan", "execute", "verify"] });
      expect(closed([`--permission-mode=${mode}`]).status).toBe("enforced");
    });
  }

  it("the draft installation command (acceptEdits, inline settings without a mode or sandbox) ⇒ enforced", () => {
    expect(closed(["--permission-mode", "acceptEdits", "--no-session-persistence", "--setting-sources", "project,local", "--strict-mcp-config",
      "--disable-slash-commands", "--settings", '{"autoMemoryEnabled":false}', "--max-budget-usd", "100"]).status).toBe("enforced");
  });

  it("inline --settings permissions.defaultMode is read when the flag is absent", () => {
    expect(closed(["--settings", '{"permissions":{"defaultMode":"acceptEdits"}}']).status).toBe("enforced");
    expect(closed(["--settings", '{"permissions":{"defaultMode":"bypassPermissions"}}']).status).toBe("recorded-only");
  });

  const open: Array<[string, string[]]> = [
    ["absent mode", ["--strict-mcp-config"]],
    ["bypassPermissions", ["--permission-mode", "bypassPermissions"]],
    ["dontAsk", ["--permission-mode", "dontAsk"]],
    ["auto", ["--permission-mode", "auto"]],
    ["--dangerously-skip-permissions", ["--permission-mode", "acceptEdits", "--dangerously-skip-permissions"]],
    ["--allow-dangerously-skip-permissions", ["--permission-mode", "acceptEdits", "--allow-dangerously-skip-permissions"]],
    ["--permission-prompt-tool", ["--permission-mode", "acceptEdits", "--permission-prompt-tool", "mcp__x__ask"]],
    ["--sdk-url", ["--permission-mode", "acceptEdits", "--sdk-url", "ws://localhost:1"]],
    ["inline settings with sandbox", ["--permission-mode", "acceptEdits", "--settings", '{"sandbox":{"enabled":true}}']],
    ["settings file path (not read)", ["--permission-mode", "acceptEdits", "--settings", "/etc/claude.json"]],
    ["installation --allowedTools Bash", ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"]],
    ["installation --allowed-tools Bash(npm:*)", ["--permission-mode", "acceptEdits", "--allowed-tools", "Bash(npm:*)"]],
    ["installation --allowedTools 'Edit,Bash(git *)'", ["--permission-mode", "acceptEdits", "--allowedTools", "Edit,Bash(git *)"]],
    ["inline settings permissions.allow Bash(*)", ["--permission-mode", "acceptEdits", "--settings", '{"permissions":{"allow":["Bash(*)"]}}']],
    ["inline settings defaultMode bypassPermissions with flag absent", ["--settings", '{"permissions":{"defaultMode":"bypassPermissions"}}']],
  ];
  for (const [name, command] of open) {
    it(`${name} ⇒ recorded-only, no phases`, () => {
      const row = closed(command);
      expect(row.status).toBe("recorded-only");
      expect(row.phases).toEqual([]);
      expect(typeof row.reason).toBe("string");
    });
  }

  it("an exact installation Bash allow keeps the set closed and is named in the baseline", () => {
    const { rows, baseline } = claudeToolRuleRows(rules, ["--permission-mode", "acceptEdits", "--allowedTools", "Bash(git log)", "Edit"], requiredCheckAllowRules);
    expect(rows[0]!.status).toBe("enforced");
    expect(baseline).toContain("Bash(git log)");
    expect(Buffer.byteLength(baseline)).toBeLessThanOrEqual(1024);
  });

  it("rows: commands as given, network false recorded-only (Bash still reaches the network), secretEnv recorded-only", () => {
    const { rows } = claudeToolRuleRows(rules, ["--permission-mode", "acceptEdits"], requiredCheckAllowRules);
    expect(rows.map((row) => [row.rule, row.status, row.phases])).toEqual([
      [{ kind: "commands-closed" }, "enforced", ["plan", "execute", "verify"]],
      [{ kind: "exact", value: "npm test" }, "enforced", ["execute"]],
      [{ kind: "prefix", value: "npm run" }, "enforced", ["execute"]],
      [{ kind: "network", value: false }, "recorded-only", ["plan", "execute", "verify"]],
      [{ kind: "secretEnv", name: "NPM_TOKEN" }, "recorded-only", []],
    ]);
    expect(rows.slice(1, 3).every((row) => row.reason === null)).toBe(true);
    expect(rows[3]!.reason).toContain("Bash");
  });

  it("network:true is enforced on execute", () => {
    const { rows } = claudeToolRuleRows({ commands: [], network: true, secretEnv: [] }, ["--permission-mode", "acceptEdits"], requiredCheckAllowRules);
    expect(rows).toEqual([
      { rule: { kind: "commands-closed" }, status: "enforced", reason: null, phases: ["plan", "execute", "verify"] },
      { rule: { kind: "network", value: true }, status: "enforced", reason: null, phases: ["execute"] },
    ]);
  });
});
