import {rm} from "node:fs/promises";
import {describe,expect,it} from "vitest";
import {canonicalHash} from "../../src/control/protocol.js";
import {readSavedResultEligibility} from "../../src/control/savedResultRecovery.js";
import {savedRecoveryFixture} from "./savedRecoveryFixture.js";

// Orca soft loop settlement (Orca spec docs/superpowers/specs/2026-11-06-soft-mode-loop-run-settlement-design.md, §3.2, §3.7
// C1-C6, and the human's answers in §6, session 86352010): when a loop run's usage is unknown in an unlimited group, Orca's
// own pass books the omp floor it observed, under principal `orca-auto` and its own panel-class row (verb
// `settle-approximate-usage`, Q3 = (d)). That is Orca's act, never a person's, so a person's row must not back it and its row
// must not back a person's marker. The floor and the known baseline count disjoint calls, so the floor itself is the work
// charge. Q6: it backs recovery only under a finite work ceiling; an unlimited grant stays refused, as it is for a person.
type Fixture=Awaited<ReturnType<typeof savedRecoveryFixture>>;
const dims=["tokens","activeMs","attempts","sessions"] as const;
const zero=()=>({tokens:0,activeMs:0,attempts:0,sessions:0});
function baseline(f:Fixture){
 const last={work:zero(),handoff:zero()} as Record<"work"|"handoff",ReturnType<typeof zero>>;
 for(const e of f.log("control/usage.json").events)if(e.cumulative!==null)last[e.bucket as "work"|"handoff"]=e.cumulative;
 return last;
}
const COMMAND="orca-auto-approximate-run-1";
interface Options{floorTokens?:number|null;chargedTokens?:number;workTokens?:number;marker?:Record<string,unknown>;receipt?:Record<string,unknown>|null;nullCeiling?:boolean}
async function approximate(o:Options={}){
 const f=await savedRecoveryFixture(),base=baseline(f),floorTokens=o.floorTokens===undefined?7:o.floorTokens;
 const charged={work:{...zero(),tokens:o.chargedTokens??floorTokens??0},handoff:zero()};
 const work={...base.work,tokens:o.workTokens??base.work.tokens+charged.work.tokens};
 const person=JSON.parse(f.bytes.get(f.admission.accounting.settlement!.artifactId)!.toString());
 f.admission.accounting.settlement=await f.put({...person,method:"approximate-floor",principal:"orca-auto",commandId:COMMAND,charged,floorTokens,reason:"omp floor",...o.marker});
 const result={kind:"usage-settled",taskId:f.source.claim.taskId,runId:f.source.claim.runId,generation:f.source.claim.generation,charged,at:1,method:"approximate-floor"};
 f.admission.accounting.receipt=o.receipt===null?null:await f.put(o.receipt??{principal:"orca-auto",client:"panel",verb:"settle-approximate-usage",commandId:COMMAND,result});
 f.admission.accounting.work=work;f.admission.accounting.handoff=base.handoff;
 const funding=f.admission.funding;funding.inheritedUsage=work;funding.fundedTotal=Object.fromEntries(dims.map(d=>[d,work[d]+funding.freshGrant.work[d]!])) as any;
 if(o.nullCeiling){
  // The original run's envelope is inside the archive: rewrite it with an unlimited work grant and re-bind its hash.
  // Only protocol 4 can carry a null ceiling (src/control/protocol.ts, v4StartEnvelopeSchema).
  const replace=async(path:string,value:unknown)=>{const entry=f.archive.logs.find((e:any)=>e.path===path);entry.ref=await f.put(value);};
  const source={...structuredClone(f.source),protocol:4} as typeof f.source;(source.claim.grant.work as any).tokens=null;await replace("control/envelope.json",source);
  const hash=canonicalHash(source);await replace("control/accepted.json",{...f.log("control/accepted.json"),envelopeHash:hash});f.admission.source.envelopeHash=hash;
  const ref=await f.put(f.archive);f.manifest.source=ref;f.admission.recoveryOf.capsuleHash=ref.hash;
 }
 await f.seal();return f;
}
async function eligibility(o:Options){const f=await approximate(o);try{return await readSavedResultEligibility(f.input);}finally{await rm(f.root,{recursive:true,force:true});}}
const invalid={status:"unavailable",reason:"saved-result-settlement-invalid"};

describe("an approximate-floor marker backed by an orca-auto receipt",()=>{
 it("C1: is eligible under a finite work ceiling",async()=>{
  expect(await eligibility({})).toMatchObject({status:"eligible"});
 },30000);
 it("C1: is refused under an unlimited work ceiling (Q6: recovery of unlimited grants is not a new capability)",async()=>{
  expect(await eligibility({nullCeiling:true})).toEqual(invalid);
 },30000);
 it("C2: is refused when the marker names a person: only Orca books an approximate floor",async()=>{
  expect(await eligibility({marker:{principal:"user:fixture"}})).toEqual({status:"unavailable",reason:"saved-result-evidence-invalid"});
 },30000);
});

describe("a person row and an orca-auto row never back each other's marker (C3)",()=>{
 const personResult=(f:Fixture,charged:unknown)=>({kind:"usage-settled",taskId:f.source.claim.taskId,runId:f.source.claim.runId,generation:f.source.claim.generation,charged,at:1,method:"remaining-grant"});
 it.each([["user:fixture"],["orca-auto"]])("approximate-floor with a person's settle-unknown-usage receipt (principal %s) is refused",async principal=>{
  const probe=await savedRecoveryFixture();const result=personResult(probe,{work:{...zero(),tokens:7},handoff:zero()});await rm(probe.root,{recursive:true,force:true});
  expect(await eligibility({receipt:{principal,client:"web",verb:"settle-unknown-usage",commandId:COMMAND,result}})).toEqual(invalid);
 },30000);
 it("remaining-grant with an orca-auto receipt is refused",async()=>{
  const f=await savedRecoveryFixture();
  try{
   const charged=JSON.parse(f.bytes.get(f.admission.accounting.settlement!.artifactId)!.toString()).charged;
   f.admission.accounting.receipt=await f.put({principal:"orca-auto",client:"panel",verb:"settle-approximate-usage",commandId:"settle-command",
    result:{kind:"usage-settled",taskId:f.source.claim.taskId,runId:f.source.claim.runId,generation:f.source.claim.generation,charged,at:1,method:"approximate-floor"}});
   await f.seal();expect(await readSavedResultEligibility(f.input)).toEqual(invalid);
  }finally{await rm(f.root,{recursive:true,force:true});}
 },30000);
});

describe("the floor is the work charge and nothing else is charged (C4)",()=>{
 it("is refused when the charged work tokens are not the floor",async()=>{
  expect(await eligibility({floorTokens:7,chargedTokens:8})).toEqual(invalid);
 },30000);
 it("is refused when the cumulative work tokens are not the baseline plus the charge",async()=>{
  const probe=await savedRecoveryFixture();const tokens=baseline(probe).work.tokens;await rm(probe.root,{recursive:true,force:true});
  expect(await eligibility({floorTokens:7,workTokens:tokens+8})).toEqual(invalid);
 },30000);
 it("books nothing for a run with no floor, and is eligible",async()=>{
  expect(await eligibility({floorTokens:null})).toMatchObject({status:"eligible"});
 },30000);
});

describe("the receipt stays required for the method (C5)",()=>{
 it("is refused as unsettled without a receipt",async()=>{
  expect(await eligibility({receipt:null})).toEqual({status:"unavailable",reason:"saved-result-usage-unsettled"});
 },30000);
});

describe("a released reservation needs its handoff resolution (C6)",()=>{
 const handoffResolution={requestId:"handoff-request",previousState:"settled-unrecoverable",previousFailureCode:"usage-unsettled",checkpointId:"checkpoint-1",checkpointHash:"a".repeat(64)};
 it("is eligible when released with a handoff resolution",async()=>{
  expect(await eligibility({marker:{reservationDisposition:"released",handoffResolution}})).toMatchObject({status:"eligible"});
 },30000);
 it("is refused when released without one",async()=>{
  expect(await eligibility({marker:{reservationDisposition:"released"}})).toEqual(invalid);
 },30000);
});
