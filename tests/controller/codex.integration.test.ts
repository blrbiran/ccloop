import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { codexFixture, exec } from "../runtime/codex/fixture.js";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(mode="integration"){const f=await codexFixture(mode);dirs.push(f.dir);return f;}
const json=async(p:string)=>JSON.parse(await readFile(p,"utf8"));
describe("Codex through the real controller",()=>{
  it("runs all three phases, charges actual usage and publishes the changed answer",async()=>{
    const f=await fixture();const state=await runLoop(f.contract,f.runDir,new CodexAdapter(f.config));
    expect(state.status).toBe("succeeded");expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(955);
    expect(await json(join(f.runDir,"loop-state.json"))).toEqual(state);
    for(const phase of ["plan","execution","verify"])expect(await json(join(f.runDir,"attempts","1",phase+".json"))).toMatchObject({tokenUsage:15,usageEvidence:{normalizedTotal:15}});
    expect((await exec("git",["show",`refs/ccloop/${basename(f.runDir)}/attempts/1:answer.txt`],{cwd:f.repo})).stdout).toBe("42\n");
    expect((await readFile(f.marker+".calls","utf8")).trim().split("\n")).toEqual(["plan","execute","verify"]);
  },30000);
  it("retains written artifacts when execute reaches the controller deadline",async()=>{
    const f=await fixture("write-hang");f.contract.executionPolicy.perAttemptTimeoutMs=700;
    const state=await runLoop(f.contract,f.runDir,new CodexAdapter(f.config));expect(state.status).not.toBe("succeeded");
    expect((await exec("git",["show",`refs/ccloop/${basename(f.runDir)}/attempts/1:answer.txt`],{cwd:f.repo})).stdout).toBe("42\n");
    const recovery=await json(join(f.runDir,"attempts","1","execution-recovery.json"));expect(recovery).toMatchObject({executeEntered:true,captureStatus:"partial",worktreeDiffObserved:true,changedPathsObserved:["answer.txt"]});
    expect((await readFile(f.marker+".calls","utf8")).trim().split("\n")).toEqual(["plan","execute"]);
  },30000);
  it("does not reach verify after execute usage is missing",async()=>{
    const f=await fixture("no-usage");const state=await runLoop(f.contract,f.runDir,new CodexAdapter(f.config));
    expect(state.status).toBe("failed");expect(state.stopReason).toContain("codex-no-completion");
    expect((await readFile(f.marker+".calls","utf8")).trim().split("\n")).toEqual(["plan","execute"]);
  },30000);
});
