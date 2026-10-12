import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyAgentInstallations, previewAgentInstallations } from "../../src/agents/updates.js";
import { runControlCommand } from "../../src/control/command.js";

const model = "gateway/model-a";

async function fixture(installed: boolean, catalog: string[] = [model]) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-update-")));
  const binary = join(dir, "omp");
  const statePath = join(dir, "state.json");
  const tablePath = join(dir, "agents.json");
  const state = { version: "18.10.1", defaultModel: model, catalog };
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  await writeFile(binary, `#!/usr/bin/env node
import {readFileSync} from "node:fs";
const state=JSON.parse(readFileSync(${JSON.stringify(statePath)},"utf8"));
const args=process.argv.slice(2);
if(args.includes("--version")){console.log("omp/"+state.version);process.exit(0)}
if(args.includes("config")){console.log(JSON.stringify({key:"modelRoles",value:{default:state.defaultModel},type:"record",description:""}));process.exit(0)}
if(args.includes("models")){console.log(JSON.stringify({models:state.catalog.map(selector=>{const slash=selector.indexOf("/");return {provider:selector.slice(0,slash),id:selector.slice(slash+1),selector}})}));process.exit(0)}
process.exit(2);
`, { mode: 0o700 });
  const installation = { kind: "omp", command: [binary], version: "18.10.0", configDir: null, timeoutMs: 1_800_000, killGraceMs: 5_000, defaultModel: model, profile: null };
  await writeFile(tablePath, JSON.stringify({ schema: "ccloop-agents-table-v1", installations: installed ? { work: installation } : {} }), { mode: 0o600 });
  return { dir, binary, statePath, tablePath, state };
}

function request(preview: Awaited<ReturnType<typeof previewAgentInstallations>>, changeId: string, opId: string) {
  return { opId, requestDigest: "a".repeat(64), previewId: preview.previewId, baseTableHash: preview.baseTableHash, acceptedChangeIds: [changeId] };
}

describe("OMP installation updates", () => {
  it("offers a new OMP candidate with its own resolvable model default", async () => {
    const f = await fixture(false);
    try {
      const preview = await previewAgentInstallations(f.tablePath, { home: f.dir, path: f.dir });
      expect(preview.changes).toContainEqual(expect.objectContaining({
        kind: "addition", installationId: "omp", installation: expect.objectContaining({ defaultModel: model, profile: null }),
      }));
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it("keeps an addition visible but inapplicable when its default model is absent", async () => {
    const f = await fixture(false, []);
    try {
      const preview = await previewAgentInstallations(f.tablePath, { home: f.dir, path: f.dir });
      const change = preview.changes.find((row) => row.kind === "addition" && row.installationId === "omp");
      expect(change).toBeDefined();
      expect(change?.installation).toBeUndefined();
      const before = await readFile(f.tablePath);
      await expect(applyAgentInstallations(f.tablePath, request(preview, change!.changeId, "unavailable-addition"))).rejects.toMatchObject({ code: "agent-installation-update-conflict" });
      expect(await readFile(f.tablePath)).toEqual(before);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it("marks a version update unavailable when the new CLI lacks the frozen model", async () => {
    const f = await fixture(true, []);
    try {
      const preview = await previewAgentInstallations(f.tablePath, { home: f.dir, path: f.dir });
      expect(preview.changes).toContainEqual(expect.objectContaining({
        kind: "version", installationId: "work", unavailableReason: "omp-frozen-model-unavailable",
      }));
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it("preserves the unavailable reason through the strict control preview response", async () => {
    const f = await fixture(true, []);
    try {
      const result = await runControlCommand(["agent-installation-preview", "--agents", f.tablePath], "{}");
      expect(result.code).toBe(0);
      const preview = JSON.parse(result.stdout) as { changes: Array<{ kind: string; unavailableReason?: string }> };
      expect(preview.changes).toContainEqual(expect.objectContaining({ kind: "version", unavailableReason: "omp-frozen-model-unavailable" }));
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it("refuses Apply if the model vanishes after preview and preserves the table bytes", async () => {
    const f = await fixture(true);
    try {
      const preview = await previewAgentInstallations(f.tablePath, { home: f.dir, path: f.dir });
      const change = preview.changes.find((row) => row.kind === "version" && row.installationId === "work");
      expect(change?.unavailableReason).toBeUndefined();
      const before = await readFile(f.tablePath);
      await writeFile(f.statePath, JSON.stringify({ ...f.state, catalog: [] }), { mode: 0o600 });
      await expect(applyAgentInstallations(f.tablePath, request(preview, change!.changeId, "model-vanished"))).rejects.toMatchObject({
        code: "agent-installation-update-invalid", detail: "omp-frozen-model-unavailable",
      });
      expect(await readFile(f.tablePath)).toEqual(before);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
});
