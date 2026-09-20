import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli.js";
import { codexFixture, exec } from "../runtime/codex/fixture.js";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
describe("Codex CLI",()=>{
  it("parses run",()=>expect(parseArgs(["run","--contract","c","--run-dir","r","--adapter","codex","--adapter-config","a"])).toEqual({command:"run",contractPath:"c",runDir:"r",adapter:"codex",adapterConfigPath:"a"}));
  it("parses resume",()=>expect(parseArgs(["resume","--run-dir","r","--adapter","codex","--adapter-config","a"])).toEqual({command:"resume",runDir:"r",adapter:"codex",adapterConfigPath:"a"}));
  it("parses sweep",()=>expect(parseArgs(["sweep","--root","r","--max-runs","2","--adapter","codex","--adapter-config","a"])).toEqual({command:"sweep",root:"r",maxRuns:2,adapter:"codex",adapterConfigPath:"a"}));
  it.each(["run","resume","sweep"])("rejects unknown adapter for %s",command=>expect(()=>parseArgs([command,"--root","r","--max-runs","2","--contract","c","--run-dir","r","--adapter","unknown","--adapter-config","a"])).toThrow("invalid adapter"));
  it.each(["soft","strict"])("executes the real CLI with %s config",async budgetMode=>{
    const f=await codexFixture();dirs.push(f.dir);const config=join(f.dir,"adapter.json"),contract=join(f.dir,"contract.json");
    await writeFile(config,JSON.stringify({...f.config,budgetMode}));await writeFile(contract,JSON.stringify(f.contract));
    const cli=fileURLToPath(new URL("../../src/cli.ts",import.meta.url));
    const loader=fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs",import.meta.url));
    const result=await exec(process.execPath,["--import",loader,cli,"run","--contract",contract,"--run-dir",f.runDir,"--adapter","codex","--adapter-config",config],{cwd:f.dir,timeout:15000}).then(r=>({...r,code:0}),e=>({stdout:e.stdout,stderr:e.stderr,code:e.code}));
    if(budgetMode==="strict") {expect(result.code).toBe(1);await expect(readFile(f.marker)).rejects.toThrow();}
    else {expect(result.code).toBe(0);expect(result.stderr).toContain("soft");expect(JSON.parse(await readFile(join(f.runDir,"loop-state.json"),"utf8")).status).toBe("succeeded");expect((await readFile(f.marker+".calls","utf8")).trim().split("\n")).toEqual(["plan","execute","verify"]);}
  },30000);
});
