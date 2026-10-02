// Crash resume (2026-10-02), spec §3.1: a process that runs one ClaudeAgentAdapter phase (fake claude in mode "hang")
// and can be SIGKILLed by a criterion, so the adapter's own spawn -- fd 3 and CCLOOP_PARENT_WATCH_FD -- is what the
// runner watches. Run with `node --import <tsx loader>`. Prints one JSON line {dir, marker, runDir}, then waits on the
// phase until it is killed. CCLOOP_PARENT_GONE_GRACE_MS, if set in this process's environment, reaches the runner
// through the adapter's copy of process.env.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { codexFixture } from "../runtime/codex/fixture.js";

const fakeCli = fileURLToPath(new URL("./fake-claude-cli.mjs", import.meta.url));
const f = await codexFixture("unused");
const marker = join(f.dir, "claude-marker.json");
process.stdout.write(`${JSON.stringify({ dir: f.dir, marker, runDir: f.runDir })}\n`);
await new ClaudeAgentAdapter({
  schema: "ccloop-agent-config-v1",
  kind: "claude",
  installation: { kind: "claude", command: [process.execPath, fakeCli, "hang", marker], version: "9.9.9-fake", configDir: null, timeoutMs: 60_000, killGraceMs: 300 },
  selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
}).plan(f.context).catch(() => {});
