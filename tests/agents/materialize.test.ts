import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentConfigHash, parseMaterializedAgentConfig, probeVersion, resolveAgent } from "../../src/agents/materialize.js";
import type { AgentsTableV1, PartialSelectionV1 } from "../../src/agents/types.js";
import { canonicalHash } from "../../src/control/protocol.js";

async function script(body: string): Promise<string[]> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-agents-version-")));
  const path = join(dir, "cli.mjs");
  await writeFile(path, body, { mode: 0o600 });
  return [process.execPath, path];
}

const table: AgentsTableV1 = {
  schema: "ccloop-agents-table-v1",
  installations: {
    claude: { kind: "claude", command: ["/opt/claude"], version: "2.1.282", configDir: null, timeoutMs: 1_800_000, killGraceMs: 5_000 },
    codex: { kind: "codex", command: ["/opt/codex"], version: "0.155.1", configDir: null, timeoutMs: 900_000, killGraceMs: 2_000, sandbox: "workspace-write", budgetMode: "soft" },
  },
};
const versions: Record<string, string> = { "/opt/claude": "2.1.282", "/opt/codex": "0.155.1" };
const probe = async (command: string[]) => versions[command[0]!] ?? null;

describe("probing an installed CLI's version", () => {
  it("answers the x.y.z the real CLIs print (claude 2.1.282, codex-cli 0.155.1 as measured on this machine)", async () => {
    expect(await probeVersion(await script('console.log("2.1.282 (Claude Code)")'))).toBe("2.1.282");
    expect(await probeVersion(await script('console.log("codex-cli 0.155.1")'))).toBe("0.155.1");
    expect(await probeVersion(await script('console.log("tool 1.0.0-beta.2 build")'))).toBe("1.0.0-beta.2");
  });

  it("passes the command's own arguments before --version", async () => {
    expect(await probeVersion([...(await script('console.log(process.argv.slice(2).join(" ") === "script m --version" ? "3.4.5" : "0.0.0")')), "script", "m"])).toBe("3.4.5");
  });

  it("answers null, not a guess, when the CLI fails, prints no version, is missing, or hangs", async () => {
    expect(await probeVersion(await script('console.log("2.1.282"); process.exitCode = 1'))).toBeNull();
    expect(await probeVersion(await script('console.log("no version here")'))).toBeNull();
    expect(await probeVersion(["/nonexistent/ccloop-agent-cli"])).toBeNull();
    expect(await probeVersion(await script("setInterval(() => {}, 1000)"), { timeoutMs: 200 })).toBeNull();
    expect(await probeVersion(await script('process.stdout.write("1.2.3 ".repeat(20000))'))).toBeNull();
  });
});

describe("resolving a selection against the table", () => {
  it("fills unset fields from the descriptor and echoes the fields the request gave verbatim", async () => {
    const { resolution, config } = await resolveAgent(table, { agent: "claude", model: "opus" }, { probeVersion: probe });
    expect(resolution.selection).toEqual({ agent: "claude", model: "opus", contextWindow: "agent-default" });
    expect(config).toEqual({ schema: "ccloop-agent-config-v1", kind: "claude", installation: table.installations.claude, selection: resolution.selection });
    expect(resolution.configHash).toBe(canonicalHash(config));
    expect((await resolveAgent(table, { agent: "codex" }, { probeVersion: probe })).resolution).toMatchObject({
      selection: { agent: "codex", model: "gpt-6-sol", contextWindow: "agent-default" },
      timeoutMs: 900_000,
      killGraceMs: 2_000,
      capabilities: { contextWindowTokens: null, budgetEnforcement: "soft" },
    });
  });

  it("reports the 1M window as a capability only when it was selected", async () => {
    const { resolution } = await resolveAgent(table, { agent: "claude", contextWindow: 1_000_000 }, { probeVersion: probe });
    expect(resolution.capabilities.contextWindowTokens).toBe(1_000_000);
  });

  it("names each refusal", async () => {
    await expect(resolveAgent(table, {}, { probeVersion: probe })).rejects.toMatchObject({ code: "agent-unselected" });
    await expect(resolveAgent(table, { agent: "gemini" }, { probeVersion: probe })).rejects.toMatchObject({ code: "agent-installation-missing" });
    // An inherited property is not an installation: the refusal names the requested id, not a missing kind.
    await expect(resolveAgent(table, { agent: "toString" }, { probeVersion: probe })).rejects.toMatchObject({ code: "agent-installation-missing", detail: "toString" });
    await expect(resolveAgent(table, { agent: "codex", contextWindow: 1_000_000 }, { probeVersion: probe })).rejects.toMatchObject({ code: "agent-context-unsupported" });
    await expect(resolveAgent(table, { agent: "claude", model: "-p" }, { probeVersion: probe })).rejects.toMatchObject({ code: "agent-selection-invalid" });
  });

  // Spec §12 C6: an in-place upgrade changes neither the table nor the hash; only the probe can see it.
  it("refuses an installation whose CLI no longer reports the table's version", async () => {
    await expect(resolveAgent(table, { agent: "claude" }, { probeVersion: async () => "2.1.283" })).rejects.toMatchObject({ code: "agent-version-drift" });
    await expect(resolveAgent(table, { agent: "claude" }, { probeVersion: async () => null })).rejects.toMatchObject({ code: "agent-version-drift" });
  });

  it("probes the real CLI when no probe is injected", async () => {
    const command = await script('console.log("7.8.9 (Fake)")');
    const real: AgentsTableV1 = { schema: "ccloop-agents-table-v1", installations: { claude: { ...table.installations.claude!, command: command as [string, ...string[]], version: "7.8.9" } } };
    expect((await resolveAgent(real, { agent: "claude" })).resolution.selection.agent).toBe("claude");
    const drifted: AgentsTableV1 = { schema: "ccloop-agents-table-v1", installations: { claude: { ...real.installations.claude!, version: "7.8.8" } } };
    await expect(resolveAgent(drifted, { agent: "claude" })).rejects.toMatchObject({ code: "agent-version-drift" });
  });
});

// Spec §9 criterion 2 (§12 I13): the hash covers exactly one installation record plus the selection.
describe("materialized config hash", () => {
  const hashOf = async (source: AgentsTableV1, partial: PartialSelectionV1 = { agent: "claude" }) =>
    (await resolveAgent(source, partial, { probeVersion: async (command) => (command[0] === "/opt/claude2" ? "2.1.282" : probe(command)) })).resolution.configHash;

  it("is stable for the same table and selection", async () => {
    expect(await hashOf(table)).toBe(await hashOf(structuredClone(table)));
  });

  it("changes with every field of the selected record and of the selection", async () => {
    const base = await hashOf(table);
    const claude = table.installations.claude!;
    for (const changed of [
      { ...claude, command: ["/opt/claude2"] as [string, ...string[]] },
      { ...claude, configDir: "/Users/me/.claude-work" },
      { ...claude, timeoutMs: 1_800_001 },
      { ...claude, killGraceMs: 5_001 },
    ]) {
      expect(await hashOf({ ...table, installations: { ...table.installations, claude: changed } })).not.toBe(base);
    }
    expect(await hashOf(table, { agent: "claude", model: "opus" })).not.toBe(base);
    expect(await hashOf(table, { agent: "claude", contextWindow: 1_000_000 })).not.toBe(base);
  });

  it("does not change when another installation record changes", async () => {
    const base = await hashOf(table);
    const codex = { ...table.installations.codex!, timeoutMs: 1 };
    expect(await hashOf({ ...table, installations: { ...table.installations, codex } })).toBe(base);
    const { claude } = table.installations;
    expect(await hashOf({ ...table, installations: { claude: claude! } })).toBe(base);
  });

  it("is the canonical hash of the materialized config", async () => {
    const { config, resolution } = await resolveAgent(table, { agent: "codex" }, { probeVersion: probe });
    expect(agentConfigHash(config)).toBe(resolution.configHash);
  });
});

describe("reading back a materialized config", () => {
  it("round-trips what resolution materialized", async () => {
    const { config } = await resolveAgent(table, { agent: "codex", model: "gpt-6-luna" }, { probeVersion: probe });
    expect(parseMaterializedAgentConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });

  it("refuses a kind that differs from the installation, a bad selection and extra keys", async () => {
    const { config } = await resolveAgent(table, { agent: "claude" }, { probeVersion: probe });
    expect(() => parseMaterializedAgentConfig({ ...config, kind: "codex" })).toThrow(expect.objectContaining({ code: "agent-config-invalid" }));
    expect(() => parseMaterializedAgentConfig({ ...config, selection: { ...config.selection, contextWindow: 5 } })).toThrow(expect.objectContaining({ code: "agent-context-unsupported" }));
    expect(() => parseMaterializedAgentConfig({ ...config, extra: 1 })).toThrow(expect.objectContaining({ code: "agent-config-invalid" }));
    expect(() => parseMaterializedAgentConfig({ ...config, installation: { ...config.installation, env: {} } })).toThrow(expect.objectContaining({ code: "agents-table-invalid" }));
  });
});
