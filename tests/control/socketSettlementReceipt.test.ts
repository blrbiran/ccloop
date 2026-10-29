import {rm} from "node:fs/promises";
import {describe,expect,it} from "vitest";
import {readSavedResultEligibility} from "../../src/control/savedResultRecovery.js";
import {savedRecoveryFixture} from "./savedRecoveryFixture.js";

// Orca session b999cc81 (2026-10-29): Orca's `orca task settle-usage` settles unknown usage over the socket with a person
// token (Orca spec 2026-10-29-socket-usage-settlement-design.md). Its ledger row is `client: cli`, `principal: agent:cli`
// and records the token's account in `person_principal`; the receipt copies the row. A receipt from such a row must back
// the marker through `personPrincipal`, exactly as Orca's own reader does, or a socket-settled run can never be recovered.
const result=(f:Awaited<ReturnType<typeof savedRecoveryFixture>>)=>({kind:"usage-settled",taskId:f.source.claim.taskId,runId:f.source.claim.runId,generation:f.source.claim.generation,
 charged:JSON.parse(f.bytes.get(f.admission.accounting.settlement!.artifactId)!.toString()).charged,at:1,method:"remaining-grant"});
async function withReceipt(fields:Record<string,unknown>){
 const f=await savedRecoveryFixture();
 f.admission.accounting.receipt=await f.put({verb:"settle-unknown-usage",commandId:"settle-command",result:result(f),...fields});await f.seal();
 return f;
}

describe("a receipt from a socket settlement",()=>{
 it("backs the marker when its personPrincipal is the marker's principal",async()=>{
  const f=await withReceipt({principal:"agent:cli",client:"cli",personPrincipal:"user:fixture"});
  try{expect(await readSavedResultEligibility(f.input)).toMatchObject({status:"eligible"});}finally{await rm(f.root,{recursive:true,force:true});}
 },30000);
 it("is refused when its personPrincipal is another account",async()=>{
  const f=await withReceipt({principal:"agent:cli",client:"cli",personPrincipal:"user:someone-else"});
  try{expect(await readSavedResultEligibility(f.input)).toEqual({status:"unavailable",reason:"saved-result-settlement-invalid"});}finally{await rm(f.root,{recursive:true,force:true});}
 },30000);
 it("is refused without a personPrincipal: the agent principal alone never backs a person's settlement",async()=>{
  const f=await withReceipt({principal:"user:fixture",client:"cli"});
  try{expect(await readSavedResultEligibility(f.input)).toEqual({status:"unavailable",reason:"saved-result-settlement-invalid"});}finally{await rm(f.root,{recursive:true,force:true});}
 },30000);
});

describe("a receipt from a Web settlement (unchanged)",()=>{
 it("is refused when its principal is not the marker's, whatever personPrincipal says",async()=>{
  const f=await withReceipt({principal:"user:someone-else",client:"web",personPrincipal:"user:fixture"});
  try{expect(await readSavedResultEligibility(f.input)).toEqual({status:"unavailable",reason:"saved-result-settlement-invalid"});}finally{await rm(f.root,{recursive:true,force:true});}
 },30000);
});
