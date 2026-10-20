import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexDescriptor } from "../../../src/agents/codex.js";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { runCodexPhase } from "../../../src/runtime/codex/runCodexPhase.js";
import { codexFixture } from "./fixture.js";

// Records the CODEX_HOME the spawned CLI saw, then exits without answering (the phase itself is not under test).
async function envProbe(dir: string): Promise<{ command: [string, ...string[]]; seen: string }> {
  const script = join(dir, "env-probe.mjs");
  const seen = join(dir, "seen.json");
  await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env.CODEX_HOME ?? null));`, { mode: 0o600 });
  return { command: [process.execPath, script], seen };
}

// Spec §4.2 / §12 I14: a table record's configDir is part of the hashed config, so the CLI must actually run with it.
describe("codex config directory", () => {
  it("runs the CLI with extraEnv on top of the inherited environment", async () => {
    const f = await codexFixture("integration");
    const probe = await envProbe(f.dir);
    const config = parseCodexConfig({ ...f.config, command: probe.command });
    await runCodexPhase(config, { phase: "plan", prompt: "p", context: f.context }, { CODEX_HOME: "/tmp/codex-home-a" });
    expect(JSON.parse(await readFile(probe.seen, "utf8"))).toBe("/tmp/codex-home-a");
    await runCodexPhase(config, { phase: "plan", prompt: "p", context: f.context });
    expect(JSON.parse(await readFile(probe.seen, "utf8"))).toBe(process.env.CODEX_HOME ?? null);
  });

  // Rewritten 2026-10-20 (ccloop Rule 15; human authorized criterion rewrite, Orca session 3d229487): under codex phase
  // isolation (spec 2026-10-18 §3.3) a phase built by the descriptor runs with the installation's private CODEX_HOME, no
  // longer with configDir itself; configDir still reaches the CLI as the target of that CODEX_HOME's auth.json and
  // config.toml links, and the phase must actually run (the old probe never answered, so it only saw a catalog probe).
  it("sets CODEX_HOME from the installation's configDir through the descriptor's adapter", async () => {
    const f = await codexFixture("integration");
    const configDir = join(f.dir, "codex-home-b");
    await mkdir(configDir); await writeFile(join(configDir, "auth.json"), "{}"); await writeFile(join(configDir, "config.toml"), "");
    const materialized: MaterializedAgentConfigV1 = {
      schema: "ccloop-agent-config-v1",
      kind: "codex",
      installation: { kind: "codex", command: f.config.command as [string, ...string[]], version: "0.155.1", configDir, timeoutMs: 10_000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft" },
      selection: { agent: "codex", model: "gpt-6-sol", contextWindow: "agent-default" },
    };
    await codexDescriptor.createAdapter(materialized).plan(f.context);
    const seen = (JSON.parse(await readFile(`${f.marker}.phase-env.json`, "utf8")) as { CODEX_HOME: string }).CODEX_HOME;
    expect(seen).not.toBe(configDir);
    expect(await readlink(join(seen, "config.toml"))).toBe(join(configDir, "config.toml"));
    expect(await readlink(join(seen, "auth.json"))).toBe(join(configDir, "auth.json"));
  });
});
