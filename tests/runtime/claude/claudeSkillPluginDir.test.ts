import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { codexFixture } from "../codex/fixture.js";

const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function setup() {
  const f = await codexFixture("unused");
  cleanup.push(async () => { await rm(f.dir, { recursive: true, force: true }); });
  const marker = join(f.dir, "claude-marker.json");
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, fakeCli, "ok", marker, "--strict-mcp-config", "--disable-slash-commands"], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
  };
  return { ...f, marker, config };
}
const phases = ["plan", "execute", "verify"] as const;
type Phase = (typeof phases)[number];
// GOLDEN: captured by running the fake-claude path at ccloop 85a9564, before skillPluginDir existed, with this file's
// installation command (--strict-mcp-config --disable-slash-commands). Only the --json-schema value differs by phase.
const SCHEMAS: Record<Phase, string> = {
  "plan": "{\"type\":\"object\",\"properties\":{\"summary\":{\"type\":\"string\"},\"primaryTargetPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"summary\",\"primaryTargetPaths\"],\"additionalProperties\":false}",
  // Task results (2026-10-10), controller ruling under the human session authorization: execute golden adds only optional taskResult; required core and all argv assertions stay exact.
  "execute": "{\"type\":\"object\",\"properties\":{\"changedFiles\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"diffPatch\":{\"type\":\"string\"},\"commandOutputs\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"stdoutStderrLog\":{\"type\":\"string\"},\"taskResult\":{},\"completionStatus\":{\"type\":\"string\",\"enum\":[\"partial\"]},\"failureType\":{\"type\":\"string\",\"enum\":[\"timeout\",\"error\"]},\"failureMessage\":{\"type\":\"string\"}},\"required\":[\"changedFiles\",\"diffPatch\",\"commandOutputs\",\"stdoutStderrLog\"],\"additionalProperties\":false}",
  "verify": "{\"type\":\"object\",\"properties\":{\"approved\":{\"type\":\"boolean\"},\"rejectCategory\":{\"type\":\"string\"},\"primaryTargetPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"failingCommand\":{\"anyOf\":[{\"type\":\"string\"},{\"type\":\"null\"}]},\"safeToRetry\":{\"type\":\"boolean\"},\"evidence\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"pauseSignals\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"stopSignals\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"approved\",\"rejectCategory\",\"primaryTargetPaths\",\"failingCommand\",\"safeToRetry\",\"evidence\",\"pauseSignals\",\"stopSignals\"],\"additionalProperties\":false}"
};
const goldenArgv = (phase: Phase): string[] => [
  "--strict-mcp-config", "--disable-slash-commands", "-p", "--output-format", "stream-json", "--verbose",
  "--include-partial-messages", "--json-schema", SCHEMAS[phase], "--model", "claude-opus-5-5", "<prompt>",
];

async function run(options: { skillPluginDir?: string } | undefined, phase: Phase) {
  const f = await setup();
  await new ClaudeAgentAdapter(f.config, options)[phase](f.context);
  const argv = (JSON.parse((await readFile(`${f.marker}.argv`, "utf8")).trim().split("\n")[0]!) as string[])
    .map((arg) => (arg.includes("codex-test") ? "<prompt>" : arg));
  const [evidence] = await readdir(join(f.runDir, "claude", "1", phase));
  const outcome = JSON.parse(await readFile(join(f.runDir, "claude", "1", phase, evidence!, "outcome.json"), "utf8")) as { claudeCommand: string[]; extraArgs: string[] };
  return { argv, outcome };
}

describe("ClaudeAgentAdapter skillPluginDir (Orca syncskill integration, spec 10.7 and 4.4)", () => {
  for (const phase of phases) {
    it(`${phase}: without skillPluginDir the argv is byte-identical to the pre-change golden`, async () => {
      const { argv, outcome } = await run(undefined, phase);
      expect(argv).toEqual(goldenArgv(phase));
      expect(outcome.extraArgs).toEqual(["--model", "claude-opus-5-5"]);
      expect(outcome.claudeCommand).toContain("--disable-slash-commands");
    });

    it(`${phase}: with skillPluginDir the claude gets --plugin-dir <dir> and no --disable-slash-commands, other flags kept`, async () => {
      const dir = "/some/abs/skill-plugin";
      const { argv, outcome } = await run({ skillPluginDir: dir }, phase);
      expect(argv).toContain("--plugin-dir");
      expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe(dir);
      expect(argv).not.toContain("--disable-slash-commands");
      expect(argv).toContain("--strict-mcp-config");
      // everything else is the golden, in order
      expect(argv.filter((arg, i) => arg !== "--plugin-dir" && argv[i - 1] !== "--plugin-dir")).toEqual(
        goldenArgv(phase).filter((arg) => arg !== "--disable-slash-commands"),
      );
      expect(outcome.claudeCommand).not.toContain("--disable-slash-commands");
      expect(outcome.claudeCommand).toContain("--strict-mcp-config");
      expect(outcome.extraArgs).toEqual(["--model", "claude-opus-5-5", "--plugin-dir", dir]);
    });
  }
});
