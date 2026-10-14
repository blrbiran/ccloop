import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeDescriptor } from "../../src/agents/claude.js";
import { codexDescriptor } from "../../src/agents/codex.js";
import { resolveAgent } from "../../src/agents/materialize.js";
import type { CatalogRowV1, InstallationV1, MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { runControlCommand } from "../../src/control/command.js";
import { writeAgentsTable } from "../control/agentsFixture.js";

// OMP single call (Orca spec 2026-10-14-omp-single-call-design.md §3.2, criterion 1): the selected catalog row decides the
// resolution's context window, its single-call answer and the cap that call runs under -- Orca sizes the estimate by the
// cap, and refuses the call by the answer -- so a resolution that ignored the row would let omp run unbounded or never.
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const installation: InstallationV1 = {
  kind: "omp", command: ["/opt/omp"], version: "18.10.1", configDir: null, timeoutMs: 1_800_000, killGraceMs: 5_000, defaultModel: "gateway/model-a", profile: null,
};
const table = { schema: "ccloop-agents-table-v1" as const, installations: { work: installation } };
const rows: CatalogRowV1[] = [
  { selector: "gateway/model-a", provider: "gateway", contextWindow: 200_000, maxTokens: 8_192 },
  { selector: "gateway/no-cap", provider: "gateway", contextWindow: 128_000, maxTokens: null },
  { selector: "openrouter/vendor/m", provider: "openrouter", contextWindow: 64_000, maxTokens: 4_096 },
];
const deps = { probeVersion: async () => "18.10.1", probeCatalog: async () => rows };

describe("the omp resolution takes its numbers from the selected catalog row (criterion 1)", () => {
  it("C1: a row with a cap answers its window, v1 and its cap", async () => {
    const { resolution } = await resolveAgent(table, { agent: "work" }, deps);
    expect([resolution.capabilities.contextWindowTokens, resolution.singleCallExecution, resolution.singleCallOutputCap]).toEqual([200_000, "v1", 8_192]);
  });

  it("C1: a row without maxTokens answers null for both, keeping its window", async () => {
    const { resolution } = await resolveAgent(table, { agent: "work", model: "gateway/no-cap" }, deps);
    expect([resolution.capabilities.contextWindowTokens, resolution.singleCallExecution, resolution.singleCallOutputCap]).toEqual([128_000, null, null]);
  });

  it("C1: an openrouter row answers singleCallExecution null although it declares a cap", async () => {
    const { resolution } = await resolveAgent(table, { agent: "work", model: "openrouter/vendor/m" }, deps);
    expect([resolution.capabilities.contextWindowTokens, resolution.singleCallExecution, resolution.singleCallOutputCap]).toEqual([64_000, null, 4_096]);
  });

  it("still refuses a model the catalog does not list, by name", async () => {
    await expect(resolveAgent(table, { agent: "work", model: "gateway/absent" }, deps)).rejects.toMatchObject({ code: "agent-selection-invalid" });
  });

  it("leaves claude's and codex's cap null: their calls honour the request's maxOutputTokens", () => {
    const config = (kind: "claude" | "codex"): MaterializedAgentConfigV1 => ({
      schema: "ccloop-agent-config-v1", kind,
      installation: { kind, command: ["/bin/echo"], version: "1.2.3", configDir: null, timeoutMs: 1000, killGraceMs: 50, ...(kind === "codex" ? { sandbox: "workspace-write", budgetMode: "soft" } : {}) },
      selection: { agent: kind, model: kind === "claude" ? "claude-opus-5-5" : "gpt-6-sol", contextWindow: "agent-default" },
    });
    expect([claudeDescriptor.singleCallOutputCap(config("claude")), codexDescriptor.singleCallOutputCap(config("codex"))]).toEqual([null, null]);
  });

  it("C1 on the wire: control capabilities prints the row's values through ccloop's strict answer schema", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-resolution-wire-")));
    dirs.push(dir);
    const marker = join(dir, "omp-marker");
    await writeFile(`${marker}.catalog.json`, JSON.stringify([{ provider: "gateway", kind: "chat", id: "model-a", selector: "gateway/model-a", contextWindow: 200000, maxTokens: 8192 }]));
    const binary = join(dir, "omp");
    await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${marker}' "$@"\n`, { mode: 0o700 });
    const { path } = await writeAgentsTable({ omp: { ...installation, command: [binary], timeoutMs: 10_000, killGraceMs: 50 } }, dir);
    const result = await runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: { agent: "omp" } }));
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ protocol: 3, capabilities: { contextWindowTokens: 200_000 }, singleCallExecution: "v1", singleCallOutputCap: 8_192 });
  });
});
