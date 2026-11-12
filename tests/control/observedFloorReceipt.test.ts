import {rm} from "node:fs/promises";
import {describe,expect,it} from "vitest";
import {canonicalHash} from "../../src/control/protocol.js";
import {readSavedResultEligibility} from "../../src/control/savedResultRecovery.js";
import {savedRecoveryFixture} from "./savedRecoveryFixture.js";

// Orca #116 (tester follow-up F §2, Orca commit "feat(control): settle a finite run's unknown usage at ccloop's observed floor,
// explicitly (#116)"): a person or a socket agent may settle a finite run's unknown usage by charging the floor ccloop observed
// (`acknowledge: charge-observed-floor`). Orca writes marker `method: "observed-floor"` -- the approximate-floor shape (floorTokens,
// reason, charged = the floor as work tokens and nothing else) under the settler's principal, backed by the settler's own
// `settle-unknown-usage` row whose result carries `method: "observed-floor"`. Saved-result recovery must accept that marker with the
// approximate-floor semantics, or a run Orca settled this way can never be verified from its saved result. Each refusal below is
// the same check approximate-floor has; the settler binding is the one Orca's settlingPrincipalFor applies.
type Fixture=Awaited<ReturnType<typeof savedRecoveryFixture>>;
const dims=["tokens","activeMs","attempts","sessions"] as const;
const zero=()=>({tokens:0,activeMs:0,attempts:0,sessions:0});
function baseline(f:Fixture){
 const last={work:zero(),handoff:zero()} as Record<"work"|"handoff",ReturnType<typeof zero>>;
 for(const e of f.log("control/usage.json").events)if(e.cumulative!==null)last[e.bucket as "work"|"handoff"]=e.cumulative;
 return last;
}
const COMMAND="observed-floor-command";
interface Options{floorTokens?:number;chargedTokens?:number;principal?:string;receipt?:Record<string,unknown>;receiptMethod?:string;nullCeiling?:boolean;rawUsageMissing?:boolean}
async function observed(o:Options={}){
 const f=await savedRecoveryFixture(),base=baseline(f),floorTokens=o.floorTokens??7;
 const charged={work:{...zero(),tokens:o.chargedTokens??floorTokens},handoff:zero()};
 const work={...base.work,tokens:base.work.tokens+charged.work.tokens};
 const person=JSON.parse(f.bytes.get(f.admission.accounting.settlement!.artifactId)!.toString());
 f.admission.accounting.settlement=await f.put({...person,method:"observed-floor",principal:o.principal??"user:fixture",commandId:COMMAND,charged,floorTokens,reason:"usage-unknown"});
 const result={kind:"usage-settled",taskId:f.source.claim.taskId,runId:f.source.claim.runId,generation:f.source.claim.generation,charged,at:1,method:o.receiptMethod??"observed-floor"};
 f.admission.accounting.receipt=await f.put({principal:"user:fixture",client:"web",verb:"settle-unknown-usage",commandId:COMMAND,...o.receipt,result});
 f.admission.accounting.work=work;f.admission.accounting.handoff=base.handoff;
 const funding=f.admission.funding;funding.inheritedUsage=work;funding.fundedTotal=Object.fromEntries(dims.map(d=>[d,work[d]+funding.freshGrant.work[d]!])) as any;
 const replace=async(path:string,value:unknown)=>{const entry=f.archive.logs.find((e:any)=>e.path===path);entry.ref=await f.put(value);};
 if(o.nullCeiling){
  // Only protocol 4 can carry a null ceiling (src/control/protocol.ts, v4StartEnvelopeSchema).
  const source={...structuredClone(f.source),protocol:4} as typeof f.source;(source.claim.grant.work as any).tokens=null;await replace("control/envelope.json",source);
  const hash=canonicalHash(source);await replace("control/accepted.json",{...f.log("control/accepted.json"),envelopeHash:hash});f.admission.source.envelopeHash=hash;
 }
 if(o.rawUsageMissing){
  const entry=f.archive.logs.find((row:any)=>/^run\/codex\/1\/execute\/call-[^/]+\/events\.jsonl$/.test(row.path))!;
  entry.ref=await f.put(Buffer.from('{"type":"turn.completed"}\n'));
 }
 if(o.nullCeiling||o.rawUsageMissing){
  const ref=await f.put(f.archive);f.manifest.source=ref;f.admission.recoveryOf.capsuleHash=ref.hash;f.input.savedResultRecovery!.recoveryOf.capsuleHash=ref.hash;
 }
 await f.seal();return f;
}
async function eligibility(o:Options){const f=await observed(o);try{return await readSavedResultEligibility(f.input);}finally{await rm(f.root,{recursive:true,force:true});}}
const invalid={status:"unavailable",reason:"saved-result-settlement-invalid"};

describe("an observed-floor marker backed by its settler's settle-unknown-usage row (Orca #116)",()=>{
 it("is eligible when a person settled it from the Web",async()=>{
  expect(await eligibility({})).toMatchObject({status:"eligible"});
 },30000);
 it("is eligible when a socket agent with a person token settled it for that person",async()=>{
  expect(await eligibility({receipt:{principal:"agent:cli",client:"cli",personPrincipal:"user:fixture"}})).toMatchObject({status:"eligible"});
 },30000);
 it("is eligible when a socket agent without a person token settled it as itself",async()=>{
  expect(await eligibility({principal:"agent:cli",receipt:{principal:"agent:cli",client:"cli"}})).toMatchObject({status:"eligible"});
 },30000);
 it("accepts a completed Codex call with unavailable raw usage, as an approximate floor does",async()=>{
  expect(await eligibility({rawUsageMissing:true})).toMatchObject({status:"eligible"});
 },30000);
});

describe("the observed floor keeps the approximate-floor refusals",()=>{
 it("is refused under an unlimited work ceiling (Orca admits it only for a finite remainder)",async()=>{
  expect(await eligibility({nullCeiling:true})).toEqual(invalid);
 },30000);
 it("is refused when the charged work tokens are not the floor",async()=>{
  expect(await eligibility({floorTokens:7,chargedTokens:8})).toEqual(invalid);
 },30000);
 it("is refused when the row's result names another method",async()=>{
  expect(await eligibility({receiptMethod:"remaining-grant"})).toEqual(invalid);
 },30000);
 it("is refused when Orca's own settle-approximate-usage row is offered to back it",async()=>{
  expect(await eligibility({principal:"user:fixture",receipt:{principal:"orca-auto",client:"panel",verb:"settle-approximate-usage"}})).toEqual({status:"unavailable",reason:"saved-result-evidence-invalid"});
 },30000);
 it("is refused when the marker names someone other than the row's settler",async()=>{
  expect(await eligibility({principal:"user:someone-else"})).toEqual(invalid);
 },30000);
 it("is refused when a socket row without a person token is not an agent's",async()=>{
  expect(await eligibility({principal:"user:fixture",receipt:{principal:"user:fixture",client:"cli"}})).toEqual(invalid);
 },30000);
 it("is refused when the marker is booked to orca-auto: that is the approximate-floor form, never this one",async()=>{
  expect(await eligibility({principal:"orca-auto"})).toEqual({status:"unavailable",reason:"saved-result-evidence-invalid"});
 },30000);
});
