import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentConfigHash, resolveAgent } from "../../src/agents/materialize.js";
import { parseAgentsTable } from "../../src/agents/table.js";
import type { CatalogRowV1, InstallationV1, MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { runControlCommand } from "../../src/control/command.js";
import { writeAgentsTable } from "../control/agentsFixture.js";

// Declared context window (#70, ccloop spec 2026-10-21-declared-context-window-design.md): a codex/omp installation may
// declare the window of a model its catalog does not report. Orca's estimator refuses a selection whose window is null
// (issue 70), so the declared value is what lets such a model be estimated -- but it must never override a window the
// catalog did report, must not apply when the catalog could not be read (absence is then unproven), and must be marked
// so the person can tell a declared number from an observed one.
const codex: InstallationV1 = {
  kind: "codex", command: ["/opt/codex"], version: "0.163.0", configDir: null, timeoutMs: 1_800_000, killGraceMs: 5_000, sandbox: "workspace-write", budgetMode: "soft",
};
const omp: InstallationV1 = {
  kind: "omp", command: ["/opt/omp"], version: "18.10.1", configDir: null, timeoutMs: 1_800_000, killGraceMs: 5_000, defaultModel: "gateway/model-a", profile: null,
};
const claude = { kind: "claude", command: ["/opt/claude"], version: "2.1.304", configDir: null, timeoutMs: 1_800_000, killGraceMs: 5_000 };
const tableOf = (installations: Record<string, unknown>) => ({ schema: "ccloop-agents-table-v1" as const, installations });
const codexRows: CatalogRowV1[] = [{ selector: "gpt-6-sol", provider: "openai", contextWindow: 272_000, maxTokens: null }];
const ompRows: CatalogRowV1[] = [
  { selector: "gateway/model-a", provider: "gateway", contextWindow: 200_000, maxTokens: 8_192 },
  { selector: "gateway/no-window", provider: "gateway", contextWindow: null, maxTokens: 8_192 },
];
const codexDeps = (rows: CatalogRowV1[] | null) => ({ probeVersion: async () => "0.163.0", codexCatalog: async () => rows });
const ompDeps = { probeVersion: async () => "18.10.1", probeCatalog: async () => ompRows };

describe("the table accepts declaredContextWindow on codex and omp only (test 1)", () => {
  it.each([["codex", codex], ["omp", omp]])("accepts a positive integer on %s", (_kind, installation) => {
    const parsed = parseAgentsTable(tableOf({ a: { ...installation, declaredContextWindow: 400_000 } }));
    expect(parsed.installations.a!.declaredContextWindow).toBe(400_000);
  });
  it.each([0, -1, 1.5, "400000"])("refuses %s", (value) => {
    expect(() => parseAgentsTable(tableOf({ a: { ...codex, declaredContextWindow: value } }))).toThrow(expect.objectContaining({ code: "agents-table-invalid" }));
  });
  it("refuses the key on claude, whose window the selection fixes", () => {
    expect(() => parseAgentsTable(tableOf({ a: { ...claude, declaredContextWindow: 400_000 } }))).toThrow(expect.objectContaining({ code: "agents-table-invalid" }));
  });
});

describe("the declared window fills only a window the catalog proved absent (test 2)", () => {
  const declared = (installation: InstallationV1) => tableOf({ a: { ...installation, declaredContextWindow: 400_000 } }) as never;
  it("codex listed row: the row's window, no source", async () => {
    const { resolution } = await resolveAgent(declared(codex), { agent: "a" }, codexDeps(codexRows));
    expect([resolution.capabilities.contextWindowTokens, resolution.contextWindowSource]).toEqual([272_000, undefined]);
  });
  it("codex unlisted model + declared: the declared value, marked installation-declared", async () => {
    const { resolution } = await resolveAgent(declared(codex), { agent: "a", model: "gpt-unlisted" }, codexDeps(codexRows));
    expect([resolution.capabilities.contextWindowTokens, resolution.contextWindowSource]).toEqual([400_000, "installation-declared"]);
  });
  it("codex unlisted model, nothing declared: null, no source", async () => {
    const { resolution } = await resolveAgent(tableOf({ a: codex }) as never, { agent: "a", model: "gpt-unlisted" }, codexDeps(codexRows));
    expect([resolution.capabilities.contextWindowTokens, resolution.contextWindowSource]).toEqual([null, undefined]);
  });
  it("codex catalog unreadable + declared: null, no source (absence unproven)", async () => {
    const { resolution } = await resolveAgent(declared(codex), { agent: "a", model: "gpt-unlisted" }, codexDeps(null));
    expect([resolution.capabilities.contextWindowTokens, resolution.contextWindowSource]).toEqual([null, undefined]);
  });
  it("omp row with a null window + declared: the declared value, marked", async () => {
    const { resolution } = await resolveAgent(declared(omp), { agent: "a", model: "gateway/no-window" }, ompDeps);
    expect([resolution.capabilities.contextWindowTokens, resolution.contextWindowSource]).toEqual([400_000, "installation-declared"]);
  });
  it("omp row with a window + declared: the row's window wins, no source", async () => {
    const { resolution } = await resolveAgent(declared(omp), { agent: "a" }, ompDeps);
    expect([resolution.capabilities.contextWindowTokens, resolution.contextWindowSource]).toEqual([200_000, undefined]);
  });
});

describe("declaredContextWindow is not part of configHash (test 3)", () => {
  it("hashes an installation with and without it the same", () => {
    const config = (installation: InstallationV1): MaterializedAgentConfigV1 => ({
      schema: "ccloop-agent-config-v1", kind: "codex", installation, selection: { agent: "a", model: "gpt-6-sol", contextWindow: "agent-default" },
    });
    expect(agentConfigHash(config({ ...codex, declaredContextWindow: 400_000 }))).toBe(agentConfigHash(config(codex)));
  });
});

describe("control capabilities prints the marker through its own strict schema (test 4)", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  it("answers the omp declared window with contextWindowSource", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-declared-window-")));
    dirs.push(dir);
    const { path } = await writeAgentsTable({ a: { ...omp, declaredContextWindow: 400_000 } }, dir);
    const answer = await runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: { agent: "a", model: "gateway/no-window" } }), {
      handle: async (request, context) => {
        const { readAgentsTable } = await import("../../src/agents/table.js");
        const { resolution } = await resolveAgent(await readAgentsTable(context.agentsTablePath), (request as unknown as { agent: never }).agent, ompDeps);
        return { protocol: 3, ...resolution };
      },
    });
    expect(answer.code, answer.stderr).toBe(0);
    expect(JSON.parse(answer.stdout)).toMatchObject({ capabilities: { contextWindowTokens: 400_000 }, contextWindowSource: "installation-declared" });
  });
});
