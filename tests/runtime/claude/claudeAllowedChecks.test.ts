import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { ClaudeAgentAdapter, requiredCheckAllowRules } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import type { AttemptContext } from "../../../src/runtime/types.js";
import { codexFixture } from "../codex/fixture.js";

// Orca session 3d229487 (2026-10-20), measured with real claude: the installation runs `--permission-mode acceptEdits`,
// so in -p a Bash command outside claude's read-only set is denied ("This command requires approval"). A contract whose
// required check is `node check-median.js` could therefore never be approved: the verifier could not run the check and
// rejected with required_check_not_run. Execute and verify now name exactly the contract's required checks as
// `Bash(<command>)` allow rules -- never a broad Bash rule, never bypassPermissions.

const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function run(phase: "plan" | "execute" | "verify", requiredChecks: string[]) {
  const f = await codexFixture("unused");
  cleanup.push(async () => { await rm(f.dir, { recursive: true, force: true }); });
  const marker = join(f.dir, "claude-marker.json");
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, fakeCli, "ok", marker], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
  };
  const context: AttemptContext = { ...f.context, contract: { ...f.contract, verification: { ...f.contract.verification, requiredChecks } } };
  await new ClaudeAgentAdapter(config)[phase](context);
  const argv = JSON.parse((await readFile(`${marker}.argv`, "utf8")).trim().split("\n")[0]!) as string[];
  const [evidence] = await readdir(join(f.runDir, "claude", "1", phase));
  const outcome = JSON.parse(await readFile(join(f.runDir, "claude", "1", phase, evidence!, "outcome.json"), "utf8")) as Record<string, unknown>;
  return { argv, outcome };
}

describe("requiredCheckAllowRules (claude permission rule syntax, claude 2.1.304)", () => {
  it("names each expressible required check as one exact Bash rule, once", () => {
    expect(requiredCheckAllowRules(["node check-median.js", `test "$ANSWER" = 42`, "npm test, npm run lint", "node check-median.js"])).toEqual({
      rules: ["Bash(node check-median.js)", `Bash(test "$ANSWER" = 42)`, "Bash(npm test, npm run lint)"],
      notAllowed: [],
    });
  });

  it("never widens: a check the rule syntax cannot state exactly is left out and recorded", () => {
    // `*` is claude's wildcard with no escape; parentheses end or open the CLI splitter's parenthesis state and the rule's
    // content; a backslash is unescaped inside the content; "" or "*" as content is the whole Bash tool; control characters
    // (newline: a command separator) are refused too.
    const { rules, notAllowed } = requiredCheckAllowRules(["npm test *", "npm run x:*", "node -e f()", `test "$(cat answer.txt)" = 42`, "echo a\\b", "", "  ", "a\nb", " node x.js", "node ok.js"]);
    expect(rules).toEqual(["Bash(node ok.js)"]);
    expect(notAllowed.map((entry) => entry.command)).toEqual(["npm test *", "npm run x:*", "node -e f()", `test "$(cat answer.txt)" = 42`, "echo a\\b", "", "  ", "a\nb", " node x.js"]);
    for (const entry of notAllowed) expect(entry.reason).toMatch(/\S/);
  });
});

describe("ClaudeAgentAdapter allows exactly the contract's required checks (Orca session 3d229487)", () => {
  for (const phase of ["execute", "verify"] as const) {
    it(`${phase}: --allowedTools names each expressible required check before --model, and the prompt stays last`, async () => {
      const { argv, outcome } = await run(phase, ["node check-median.js", "npm test *"]);
      const at = argv.indexOf("--allowedTools");
      expect(at).toBeGreaterThan(-1);
      // the flag takes a list: the next argv element must be another option, or it would swallow the positional prompt
      expect(argv.slice(at, at + 3)).toEqual(["--allowedTools", "Bash(node check-median.js)", "--model"]);
      expect(argv.filter((arg) => arg.startsWith("Bash"))).toEqual(["Bash(node check-median.js)"]);
      expect(argv.at(-1)).toContain("task codex-test");
      expect(outcome.extraArgs).toEqual(["--allowedTools", "Bash(node check-median.js)", "--model", "claude-opus-5-5"]);
      expect(outcome.requiredChecksNotAllowed).toEqual([{ command: "npm test *", reason: expect.any(String) }]);
    });
  }

  it("execute: with no expressible check there is no --allowedTools flag at all", async () => {
    const { argv, outcome } = await run("execute", ["npm test *"]);
    expect(argv).not.toContain("--allowedTools");
    expect(outcome.extraArgs).toEqual(["--model", "claude-opus-5-5"]);
  });

  it("plan: read-only, so it is given no check to run", async () => {
    const { argv, outcome } = await run("plan", ["node check-median.js"]);
    expect(argv).not.toContain("--allowedTools");
    expect(outcome.extraArgs).toEqual(["--model", "claude-opus-5-5"]);
  });
});
