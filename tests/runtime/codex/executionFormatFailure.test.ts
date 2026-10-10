import { afterEach, expect, it } from "vitest";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexFixture } from "./fixture.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { ExecutionFormatFailure } from "../../../src/controller/executionFormatFailure.js";
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
it("keeps failed execution usage and original bytes independently of missing core fields",async()=>{
  const f=await codexFixture("final-text");dirs.push(f.dir);
  const finals=join(f.dir,"finals.json"),final='Done: {"result":{"changedFiles":["answer.txt"]}}';
  await writeFile(finals,JSON.stringify({execute:final}));
  const error=await new CodexAdapter({...f.config,command:[...f.config.command,finals]}).execute(f.context).catch(e=>e);
  expect(error).toBeInstanceOf(ExecutionFormatFailure);
  expect(error).toMatchObject({observedTokens:15,usageEvidence:{normalizedTotal:15},modelUsage:[{model:"fixture",input:12,output:3,cacheRead:0,cacheWrite:0}],normalization:{status:"unavailable"}});
  expect(await readFile(join(error.evidenceDir,"final.json"),"utf8")).toBe(final);
  expect(JSON.parse(await readFile(join(error.evidenceDir,"usage.json"),"utf8"))).toMatchObject({normalizedTotal:15});
});
it("accepts direct execution through the real adapter",async()=>{
  const f=await codexFixture("final-text");dirs.push(f.dir);const finals=join(f.dir,"finals.json");
  const execution={changedFiles:[],diffPatch:"",commandOutputs:[],stdoutStderrLog:"ok"};
  await writeFile(finals,JSON.stringify({execute:JSON.stringify(execution)}));
  expect(await new CodexAdapter({...f.config,command:[...f.config.command,finals]}).execute(f.context)).toMatchObject({...execution,tokenUsage:15});
});
it("never labels a failed process as eligible format failure",async()=>{
  const f=await codexFixture("nonzero");dirs.push(f.dir);
  const error=await new CodexAdapter(f.config).execute(f.context).catch(e=>e);
  expect(error).not.toBeInstanceOf(ExecutionFormatFailure);expect(error.message).toContain("codex-exit-error");
});

it("requires intact stream, unique completion and finite actual usage independently of final schema",async()=>{
  const {decodeCodexUsage}=await import("../../../src/runtime/codex/protocol.js");
  const event=JSON.stringify({type:"turn.completed",usage:{input_tokens:12,output_tokens:3}});
  expect(decodeCodexUsage(event,true)).toMatchObject({tokenUsage:15});
  for(const text of [event+"\n"+event,event+"\n{broken",event+'\n{"type":"error"}',JSON.stringify({type:"turn.completed",usage:{input_tokens:null,output_tokens:3}})])expect(()=>decodeCodexUsage(text,true)).toThrow();
});
