// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.5; review M5): a whole claude run with an extra repository
// completes -- every phase passes the extra worktree as `--add-dir`, before --model -- against a fake claude that takes
// that option (tests/fixtures/fake-claude-cli-multi.mjs). The fake answers fixed plan/execute/verify objects.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../../src/controller/runLoop.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { multiRepoWorld } from "../../controller/multiRepoFixture.js";

const FAKE = fileURLToPath(new URL("../../fixtures/fake-claude-cli-multi.mjs", import.meta.url));

describe("a claude run with an extra repository (review M5)", () => {
  it("succeeds, and every phase's argv carries --add-dir <the extra worktree> before --model", async () => {
    const { contract } = await multiRepoWorld([{ key: "lib" }]);
    contract.context.targetPaths = ["answer.txt"];
    contract.safetyPolicy.allowlistPaths = ["answer.txt"];
    contract.verification.verifierType = "agent";
    const dir = await mkdtemp(join(tmpdir(), "claude-multi-")), marker = join(dir, "marker"), runDir = join(dir, "run");
    const adapter = new ClaudeAgentAdapter({ schema: "ccloop-agent-config-v1", kind: "claude",
      installation: { kind: "claude", command: [process.execPath, FAKE, "ok", marker, "--strict-mcp-config", "--disable-slash-commands"], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
      selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } } as never);
    const state = await runLoop(contract, runDir, adapter);
    expect({ status: state.status, stopReason: state.stopReason }).toEqual({ status: "succeeded", stopReason: "success condition satisfied" });
    const calls = (await readFile(`${marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(3);
    const extra = join(runDir, "dirs", "attempt-1", "lib");
    for (const argv of calls) {
      const at = argv.indexOf("--add-dir");
      expect(argv.slice(at, at + 2)).toEqual(["--add-dir", extra]);
      expect(at).toBeLessThan(argv.indexOf("--model"));
    }
  }, 60_000);
});
