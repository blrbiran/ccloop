import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { readOmpModels } from "../../src/agents/ompModels.js";
import { parseAgentsTable } from "../../src/agents/table.js";
import type { InstallationV1 } from "../../src/agents/types.js";
import { runControlCommand } from "../../src/control/command.js";

const installation: InstallationV1 = {
  kind: "omp",
  command: ["/opt/omp"],
  version: "18.10.1",
  configDir: null,
  timeoutMs: 1_800_000,
  killGraceMs: 5_000,
  defaultModel: "gateway/model-a",
  profile: null,
};

describe("OMP installation selection", () => {
  it("admits a private-table OMP installation with its own model default", () => {
    const table = { schema: "ccloop-agents-table-v1", installations: { work: installation } };
    expect(parseAgentsTable(table)).toEqual(table);
  });

  it("refuses prearguments that could re-enable extension tools", () => {
    const table = { schema: "ccloop-agents-table-v1", installations: { work: { ...installation, command: ["/opt/omp", "--extension", "/tmp/tool.js"] } } };
    expect(() => parseAgentsTable(table)).toThrow(expect.objectContaining({ code: "agents-table-invalid" }));
  });

  it("refuses a named profile combined with default-profile configDir", () => {
    const table = { schema: "ccloop-agents-table-v1", installations: { work: { ...installation, profile: "team", configDir: "/tmp/omp-agent" } } };
    expect(() => parseAgentsTable(table)).toThrow(expect.objectContaining({ code: "agents-table-invalid" }));
  });

  it("refuses a bare defaultModel in the durable agents table", () => {
    const table = { schema: "ccloop-agents-table-v1", installations: { work: { ...installation, defaultModel: "model-a" } } };
    expect(() => parseAgentsTable(table)).toThrow(expect.objectContaining({ code: "agents-table-invalid" }));
  });

  it("freezes each installation's model and profile instead of a repo-wide OMP default", async () => {
    const table = {
      schema: "ccloop-agents-table-v1" as const,
      installations: {
        first: { ...installation, defaultModel: "gateway/model-a", profile: null },
        second: { ...installation, defaultModel: "gateway/model-b", profile: "team" },
      },
    };
    const deps = { probeVersion: async () => "18.10.1", probeModels: async () => ["gateway/model-a", "gateway/model-b"] };
    const first = await resolveAgent(table, { agent: "first" }, deps);
    const second = await resolveAgent(table, { agent: "second" }, deps);
    expect(first.resolution.selection.model).toBe("gateway/model-a");
    expect(second.resolution.selection.model).toBe("gateway/model-b");
    expect(first.config.installation.profile).toBeNull();
    expect(second.config.installation.profile).toBe("team");
    expect(first.resolution.configHash).not.toBe(second.resolution.configHash);
  });

  it("shows a different OMP default for each installed agent in the control table view", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-view-")));
    const path = join(dir, "agents.json");
    const table = { schema: "ccloop-agents-table-v1", installations: {
      first: { ...installation, defaultModel: "gateway/model-a" },
      second: { ...installation, defaultModel: "other/model-b" },
    } };
    await writeFile(path, JSON.stringify(table), { mode: 0o600 });
    try {
      const result = await runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: null }));
      expect(result.code).toBe(0);
      const view = JSON.parse(result.stdout) as { installations: Array<{ id: string; defaults: { model: string } }> };
      expect(view.installations.map(({ id, defaults }) => [id, defaults.model])).toEqual([
        ["first", "gateway/model-a"], ["second", "other/model-b"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects fuzzy and thinking-suffixed overrides while admitting exact IDs with colons", async () => {
    const table = { schema: "ccloop-agents-table-v1" as const, installations: { work: installation } };
    const deps = { probeVersion: async () => "18.10.1", probeModels: async () => ["gateway/model-a", "gateway/model:0"] };
    await expect(resolveAgent(table, { agent: "work", model: "gateway/model" }, deps)).rejects.toMatchObject({ code: "agent-selection-invalid" });
    await expect(resolveAgent(table, { agent: "work", model: "gateway/model-a:high" }, deps)).rejects.toMatchObject({ code: "agent-selection-invalid" });
    expect((await resolveAgent(table, { agent: "work", model: "gateway/model:0" }, deps)).resolution.selection.model).toBe("gateway/model:0");
  });

  it("reads the selected profile's real CLI model catalog before freezing a default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccloop-omp-catalog-"));
    const binary = join(dir, "omp");
    const argvFile = join(dir, "argv.json");
    await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("omp/18.10.1"); process.exit(0); }
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
console.log(JSON.stringify({models:[{provider:"gateway",id:"model-a",selector:"gateway/model-a",kind:"chat",name:"A",contextWindow:128000,maxTokens:16384,reasoning:false,thinking:null,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},pricingStatus:"unknown"}]}));
`, { mode: 0o700 });
    try {
      const table = { schema: "ccloop-agents-table-v1" as const, installations: { work: { ...installation, command: [binary] as [string], profile: "team" } } };
      const { resolution } = await resolveAgent(table, { agent: "work" });
      expect(resolution.selection.model).toBe("gateway/model-a");
      const argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
      expect(argv).toContain("--profile");
      expect(argv).toContain("team");
      expect(argv).toContain("--no-extensions");
      expect(argv).toContain("models");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a multibyte model ID intact when CLI stdout splits its UTF-8 bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccloop-omp-utf8-"));
    const binary = join(dir, "omp");
    await writeFile(binary, `#!/usr/bin/env node
const id = "模型-😀";
const data = Buffer.from(JSON.stringify({models:[{provider:"gateway",id,selector:"gateway/"+id}]}));
const cut = data.indexOf(Buffer.from("😀")) + 2;
process.stdout.write(data.subarray(0, cut), () => setTimeout(() => process.stdout.end(data.subarray(cut)), 10));
`, { mode: 0o700 });
    try {
      await expect(readOmpModels({ ...installation, command: [binary] })).resolves.toEqual(["gateway/模型-😀"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
