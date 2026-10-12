import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectAgents } from "../../src/agents/detect.js";

async function fakeOmp(configuredDefault: string | null): Promise<{ dir: string; binary: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ccloop-omp-detect-"));
  const binary = join(dir, "omp");
  await writeFile(binary, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args.includes("--version")){console.log("omp/18.10.1");process.exit(0)}
if(args.includes("config")){if(args.indexOf("--no-extensions")>args.indexOf("config"))process.exit(2);console.log(JSON.stringify({key:"modelRoles",value:${JSON.stringify(configuredDefault === null ? {} : { default: configuredDefault })},type:"record",description:""}));process.exit(0)}
if(args.includes("models")){console.log(JSON.stringify({models:[{provider:"gateway",id:"model-a",selector:"gateway/model-a",kind:"chat",name:"A",contextWindow:128000,maxTokens:16384,reasoning:false,thinking:null,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},pricingStatus:"unknown"}]}));process.exit(0)}
process.exit(2);
`, { mode: 0o700 });
  return { dir, binary };
}

describe("OMP discovery", () => {
  it("drafts the model configured on this candidate without a repository-wide model name", async () => {
    const fixture = await fakeOmp("gateway/model-a");
    try {
      const result = await detectAgents({ home: fixture.dir, path: fixture.dir, platform: "linux" });
      expect(result.table.installations.omp).toMatchObject({
        kind: "omp", command: [fixture.binary], version: "18.10.1",
        defaultModel: "gateway/model-a", profile: null,
      });
      expect(result.candidates.omp).toContainEqual(expect.objectContaining({ path: fixture.binary, runnable: true }));
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("keeps an installed OMP candidate visible but cannot draft without a resolvable default", async () => {
    const fixture = await fakeOmp(null);
    try {
      const result = await detectAgents({ home: fixture.dir, path: fixture.dir, platform: "linux" });
      expect(result.table.installations.omp).toBeUndefined();
      expect(result.candidates.omp).toContainEqual(expect.objectContaining({
        path: fixture.binary, version: "18.10.1", error: "omp-default-model-unresolved",
      }));
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("canonicalizes a unique bare default using this installation's catalog", async () => {
    const fixture = await fakeOmp("model-a");
    try {
      const result = await detectAgents({ home: fixture.dir, path: fixture.dir, platform: "linux" });
      expect(result.table.installations.omp?.defaultModel).toBe("gateway/model-a");
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
});
