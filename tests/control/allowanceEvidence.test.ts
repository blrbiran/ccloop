import { appendUsageObservation } from "../../src/control/usage.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBundle } from "./optionalMaterializeFixture.js";
import { readAllowanceContinuation } from "../../src/control/materialize.js";
import { fixture } from "./optionalFixture.js";
import { canonicalHash } from "../../src/control/protocol.js";

async function saved(nextPhase:"plan"|"execute"|"verify"="verify") {
 const h=await buildBundle();const {envelope}=await fixture();
 envelope.protocol=4;envelope.tokenPolicy={authoredTokenCeiling:null,bindingCauses:["spend-cap"],inheritedUsage:{tokens:20,activeMs:100,attempts:1,sessions:1}};envelope.inputCheckpoint=h.input;envelope.work.sourceDir=h.sourceDir;
 envelope.work.contract.context.repoPath=h.targetRepo;
 const put=async(value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value));const hash=createHash("sha256").update(bytes).digest("hex");const ref={artifactId:`sha256-${hash}`,hash};const file=`artifacts/${ref.artifactId}.bin`;await writeFile(join(h.input.bundlePath,file),bytes,{mode:0o600});h.manifest.artifacts.push({ref,file});return ref;};
 const plan={summary:"saved plan",primaryTargetPaths:[],tokenUsage:10};
 const execution={changedFiles:[],diffPatch:"",commandOutputs:[],stdoutStderrLog:"",tokenUsage:10};
 const planRef=await put(plan),executionRef=await put(execution),acceptedContract=await put({...envelope.work.contract,context:{...envelope.work.contract.context,repoPath:h.sourceRepo}});
 const recentFailures=nextPhase==="plan"?[{rejectCategory:"fix",primaryTargetPaths:[],failingCommand:null}]:[];
 const runState={currentAttempt:1,attemptsUsed:1,budgetSnapshot:{attemptsRemaining:2,timeRemainingMs:100,tokenBudgetRemaining:0,tokenRemainingStatus:"known"},recentFailures,waitingCause:"token-allowance",allowanceNextPhase:nextPhase};
 const state=await put(runState),verification=nextPhase==="plan"?await put({approved:false,rejectCategory:"fix",primaryTargetPaths:[],failingCommand:null,safeToRetry:true,pauseSignals:[],stopSignals:[]}):null;
 const usageDir=join(h.root,"usage-source");await mkdir(usageDir);
 await appendUsageObservation(usageDir,{runId:h.input.predecessorRunId,generation:envelope.claim.generation,bucket:"work",observationId:"settled",threadTotalTokens:20,elapsedMs:100,attempts:1,sessions:1,evidence:{phase:"execute"}});
 const ledger=JSON.parse(await readFile(join(usageDir,"control/usage.json"),"utf8"));
 const usage=await put(ledger);
 const packet={usageHighWater:2,identity:{...envelope.claim,runId:h.input.predecessorRunId},tokenPolicy:{authoredTokenCeiling:null,bindingCauses:["spend-cap"],inheritedUsage:{tokens:0,activeMs:0,attempts:0,sessions:0}},contractHash:envelope.contractHash,acceptedContract,runState,allowanceContinuation:{nextPhase,plan:nextPhase==="plan"?null:planRef,execution:nextPhase==="verify"?executionRef:null,verification,state,usage},artifacts:[planRef,executionRef,acceptedContract,state,usage,...(verification?[verification]:[])]};
 const update=async()=>{const handoff=await put(packet);const checkpoint={checkpointId:h.input.checkpointId,snapshot:h.manifest.snapshot,handoff};const bytes=Buffer.from(JSON.stringify(checkpoint));const hash=createHash("sha256").update(bytes).digest("hex");await writeFile(join(h.input.bundlePath,"checkpoint.json"),bytes,{mode:0o600});const ref={artifactId:`checkpoint-cp1-${hash}`,hash};h.manifest.artifacts[0]={ref,file:"checkpoint.json"};h.manifest.checkpoint=ref;h.manifest.checkpointHash=hash;h.input.checkpointHash=hash;await writeFile(h.manifestPath,JSON.stringify(h.manifest),{mode:0o600});};
 await update();return{h,envelope,packet,plan,execution,ledger,put,update};
}
describe("saved allowance phase evidence",()=>{
 it.each(["plan","execute","verify"] as const)("loads only reachable hash-verified completed phases for %s",async phase=>{
  const f=await saved(phase);expect(await readAllowanceContinuation(f.envelope)).toEqual({nextPhase:phase,plan:phase==="plan"?null:f.plan,execution:phase==="verify"?f.execution:null,recentFailures:f.packet.runState.recentFailures});
  f.envelope.work.contract.executionPolicy.tokenBudget=null;
  f.envelope.work.contract.executionPolicy.maxAttempts=1;
  expect((await readAllowanceContinuation(f.envelope))?.nextPhase).toBe(phase);
 });
 it("refuses changed task authority even if the caller repeats the frozen hash",async()=>{
  const f=await saved();f.envelope.work.contract.objective.goal="different";
  await expect(readAllowanceContinuation(f.envelope)).rejects.toThrow("control-allowance-authority-mismatch");
 });
 it.each(["identity","hash","unreachable","partial"] as const)("refuses %s evidence",async kind=>{
  const f=await saved();
  if(kind==="identity")f.packet.identity.runId="foreign";
  if(kind==="hash")f.packet.contractHash="f".repeat(64);
  if(kind==="unreachable")f.packet.artifacts=[];
  if(kind==="partial"){const ref=await f.put({...f.execution,completionStatus:"partial",failureType:"error",failureMessage:"unfinished"});f.packet.allowanceContinuation.execution=ref;f.packet.artifacts.push(ref);}
  await f.update();await expect(readAllowanceContinuation(f.envelope)).rejects.toThrow(/control-allowance-/);
 });
 it("refuses a renewal that resets inherited attempt or session counts",async()=>{
  const f=await saved();f.envelope.tokenPolicy!.inheritedUsage.attempts=0;
  await expect(readAllowanceContinuation(f.envelope)).rejects.toThrow("control-allowance-lineage-invalid");
  f.envelope.tokenPolicy!.inheritedUsage.attempts=1;f.envelope.tokenPolicy!.inheritedUsage.sessions=0;
  await expect(readAllowanceContinuation(f.envelope)).rejects.toThrow("control-allowance-lineage-invalid");
 });

 it("review I1: refuses another work item sharing every other frozen authority",async()=>{
  const f=await saved();f.envelope.claim.workItemId="foreign-work";
  await expect(readAllowanceContinuation(f.envelope)).rejects.toThrow("control-allowance-authority-mismatch");
 });
 it.each(["tokens","activeMs"] as const)("review I2: refuses rollback below previously inherited %s",async dimension=>{
  const f=await saved();f.packet.tokenPolicy.inheritedUsage[dimension]=1000;await f.update();f.envelope.tokenPolicy!.inheritedUsage[dimension]=0;
  await expect(readAllowanceContinuation(f.envelope)).rejects.toThrow("control-allowance-lineage-invalid");
 });
 it.each(["tokens","activeMs"] as const)("review I2: refuses omitted local %s and preserves source overshoot",async dimension=>{
  const f=await saved();f.packet.tokenPolicy.inheritedUsage[dimension]=1000;f.ledger.totals.work[dimension]=2500;f.ledger.events[0].cumulative[dimension]=2500;
  const usage=await f.put(f.ledger);f.packet.allowanceContinuation.usage=usage;f.packet.artifacts.push(usage);await f.update();
  for(const inherited of [1000,3499]){f.envelope.tokenPolicy!.inheritedUsage[dimension]=inherited;await expect(readAllowanceContinuation(f.envelope)).rejects.toThrow("control-allowance-lineage-invalid");}
  f.envelope.tokenPolicy!.inheritedUsage[dimension]=3500;expect((await readAllowanceContinuation(f.envelope))?.nextPhase).toBe("verify");
 });
 it.each(["unknown","foreign-generation","foreign-run","unsafe-sum","unreachable"] as const)("review I2: refuses %s work usage evidence",async kind=>{
  const f=await saved();
  if(kind==="unknown")f.ledger.events[0].cumulative=null;
  if(kind==="foreign-generation")f.ledger.events[0].generation++;
  if(kind==="foreign-run")f.ledger.events[0].runId="other-run";
  if(kind==="unsafe-sum")f.packet.tokenPolicy.inheritedUsage.tokens=Number.MAX_SAFE_INTEGER;
  if(kind!=="unsafe-sum"&&kind!=="unreachable"){const usage=await f.put(f.ledger);f.packet.allowanceContinuation.usage=usage;f.packet.artifacts.push(usage);}
  if(kind==="unreachable")f.packet.artifacts=f.packet.artifacts.filter(ref=>ref.artifactId!==f.packet.allowanceContinuation.usage.artifactId);
  await f.update();await expect(readAllowanceContinuation(f.envelope)).rejects.toThrow(/control-allowance-/);
 });
 it("review I2: carries source ledger usage without recharging already paid phase artifacts",async()=>{
  const f=await saved();f.ledger.totals.work.tokens=0;f.ledger.events[0].cumulative.tokens=0;f.envelope.tokenPolicy!.inheritedUsage.tokens=0;
  const usage=await f.put(f.ledger);f.packet.allowanceContinuation.usage=usage;f.packet.artifacts.push(usage);await f.update();
  expect((await readAllowanceContinuation(f.envelope))?.execution?.tokenUsage).toBe(10);
 });

});
