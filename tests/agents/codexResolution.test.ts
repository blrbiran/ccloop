import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { runControlCommand } from "../../src/control/command.js";
import { codexInstallation, writeAgentsTable } from "../control/agentsFixture.js";

// Every-agent requirement chain (Orca spec 2026-10-15 §6.1, R2; criterion 3): codex answers the soft single call and its
// catalog row's window; a model the catalog does not have, or a catalog that cannot be read, answers neither (issue 5).
const FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
async function table(configDir: string | null = null) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-codex-resolution-")));
  const marker = join(dir, "codex-marker");
  const codex = await codexInstallation({ command: [process.execPath, FAKE_CODEX, "integration", marker], sandbox: "read-only", budgetMode: "soft", timeoutMs: 60_000, killGraceMs: 100 });
  return { dir, marker, ...(await writeAgentsTable({ codex: { ...codex, configDir } }, dir)) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("codex resolution (spec §6.1)", { timeout: 30_000 }, () => {
  it("answers v1-soft, no output cap, and the catalog window for a listed model", async () => {
    const t = await table();
    const { resolution } = await resolveAgent(t.table, { agent: "codex" });
    expect([resolution.selection.model, resolution.capabilities.contextWindowTokens, resolution.singleCallExecution, resolution.singleCallOutputCap]).toEqual(["gpt-6-sol", 272000, "v1-soft", null]);
  });
  it("answers the same for a hidden row", async () => {
    const t = await table();
    expect((await resolveAgent(t.table, { agent: "codex", model: "gpt-reserve" })).resolution.singleCallExecution).toBe("v1-soft");
  });
  it("answers null and null for a model with no row", async () => {
    const t = await table();
    const absent = (await resolveAgent(t.table, { agent: "codex", model: "not-in-catalog" })).resolution;
    expect([absent.capabilities.contextWindowTokens, absent.singleCallExecution]).toEqual([null, null]);
  });
  // Pre-flight ruling P11: its own table and its own cache dir -- the cache key cannot see `<marker>.catalog.json`, so a
  // warm entry from another case would answer the catalog this case breaks.
  it("answers null and null for a catalog that cannot be read", async () => {
    vi.stubEnv("CCLOOP_CACHE_DIR", await realpath(await mkdtemp(join(tmpdir(), "ccloop-codex-resolution-cache-"))));
    const t = await table();
    await writeFile(`${t.marker}.catalog.json`, JSON.stringify({ exitCode: 3 }));
    const broken = (await resolveAgent(t.table, { agent: "codex", model: "gpt-6-luna" })).resolution;
    expect([broken.capabilities.contextWindowTokens, broken.singleCallExecution]).toEqual([null, null]);
  });
  // Spec §6.1 "Window": the installation's config.toml model_context_window wins over the catalog's context_window.
  it("answers the installation's config.toml model_context_window over the catalog's", async () => {
    const configDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-codex-resolution-home-")));
    await writeFile(join(configDir, "config.toml"), "model_context_window = 400000\n\n[features]\nplugins = true\n", { mode: 0o600 });
    const t = await table(configDir);
    const { resolution } = await resolveAgent(t.table, { agent: "codex" });
    expect([resolution.capabilities.contextWindowTokens, resolution.singleCallExecution]).toEqual([400000, "v1-soft"]);
  });
  it("prints v1-soft through control capabilities (the wire enum accepts it)", async () => {
    const t = await table();
    const answer = await runControlCommand(["capabilities", "--agents", t.path], JSON.stringify({ agent: { agent: "codex" } }));
    expect(answer.code, answer.stderr).toBe(0);
    expect(JSON.parse(answer.stdout)).toMatchObject({ singleCallExecution: "v1-soft", singleCallOutputCap: null, capabilities: { contextWindowTokens: 272000 } });
  });
});
