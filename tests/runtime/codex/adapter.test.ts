import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { codexFixture } from "./fixture.js";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(mode="ok"){const f=await codexFixture(mode);dirs.push(f.dir);return f;}
describe("Codex runtime adapter",()=>{
  it("returns null only for aborted execution and throws for aborted plan/verify",async()=>{
    const f=await fixture();const a=new AbortController();a.abort();const ctx={...f.context,abortSignal:a.signal};const adapter=new CodexAdapter(f.config);
    expect(await adapter.execute(ctx)).toBeNull();await expect(adapter.plan(ctx)).rejects.toThrow("codex-aborted");await expect(adapter.verify(ctx)).rejects.toThrow("codex-aborted");
  });
  it("retains usage evidence from every phase",async()=>{
    const f=await fixture();const a=new CodexAdapter(f.config);
    for(const phase of ["plan","execute","verify"] as const)expect(await a[phase](f.context)).toMatchObject({tokenUsage:15,usageEvidence:{usageStatus:"present",normalizedTotal:15}});
  });
  it("rejects nonzero exit despite a complete final message",async()=>{
    const f=await fixture("nonzero");await expect(new CodexAdapter(f.config).execute(f.context)).rejects.toThrow("codex-exit-error");
  });
  it("preserves partial execution without synthesizing completion",async()=>{
    const f=await fixture("partial");expect(await new CodexAdapter(f.config).execute(f.context)).toMatchObject({completionStatus:"partial",failureType:"error",failureMessage:"fixture partial",tokenUsage:15});
  });
});
