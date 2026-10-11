import {cleanupAttemptWorkspaceBestEffort} from "../controller/runLoop.js";
import {registerAttemptRefNamespace} from "../workspace/worktreeManager.js";
import {join} from "node:path";
import {z} from "zod";
import {readdir,lstat} from "node:fs/promises";
import {canonicalHash,canonicalJson,artifactRefSchema,type ArtifactRefV1,type LoopStartEnvelope,recoveryOfSchema} from "./protocol.js";
import {withAcceptedLock,readAccepted,writeAccepted} from "./store.js";
import {readPrivateFile,atomicReplacePrivateFile} from "./paths.js";
import {loadSavedResultRecovery,assertSavedResultFence} from "./savedResultRecovery.js";
import {hasSavedResultEntry,recoverSavedResultEntry,readSavedResultMode,hasPreparedSavedResultProof,readSavedResultBudget,assertSavedResultCompletionCandidate,assertSavedResultDelivery} from "../controller/verifySavedResult.js";
import {classifyOwnerProcess} from "../ownership/ownerLiveness.js";
import {confirmOwnerDead} from "../controller/adoptCrashedRun.js";
import {reapRunProcesses} from "../ownership/reapRunProcesses.js";
import {readOwnerRecord,readRunState,releaseOwnerLease,writeRunState} from "../persistence/fileStore.js";
import {isTerminalRunStatus} from "../state/stateMachine.js";
import {appendUsageObservation,readUsageEvents} from "./usage.js";
import {materializeResultRepository} from "./resultRepository.js";
import {buildHandoffPacket,persistHandoffCandidate,readHandoffCandidate} from "./handoff.js";
import {proveStopped} from "./stopProof.js";
import {readEvidence} from "./evidence.js";
import {readSavedBytes,writeSavedBytes,savedResultIdentity} from "./savedResultEvidence.js";
import {taskResultIdentitySchema} from "./taskResults.js";

export const savedResultSettlementSchema=z.object({schema:z.literal("ccloop-saved-result-settlement-v1"),identity:taskResultIdentitySchema,recoveryOf:recoveryOfSchema,
 disposition:z.enum(["complete","interrupted","terminal"]),usageStatus:z.enum(["known","unknown"]),
 state:artifactRefSchema,lifecycle:artifactRefSchema.nullable(),accepted:artifactRefSchema,envelope:artifactRefSchema,usage:artifactRefSchema,stopProof:artifactRefSchema,
 usageObservations:z.array(z.object({source:artifactRefSchema,copy:artifactRefSchema}).strict())}).strict();
export type SavedResultSettlement=z.infer<typeof savedResultSettlementSchema>;
const indexPath=(input:LoopStartEnvelope)=>join(input.work.sourceDir,"run","saved-result-settlement.json");
async function existingSettlement(input:LoopStartEnvelope):Promise<ArtifactRefV1|null>{
 try{const index=JSON.parse((await readPrivateFile(input.work.sourceDir,indexPath(input))).toString());if(index.envelopeHash!==canonicalHash(input))throw Error("saved-result-settlement-authority-invalid");return artifactRefSchema.parse(index.ref);}
 catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
}
async function validateOwnedProcesses(source:string,runDir:string):Promise<void>{
 const registered=JSON.parse((await readPrivateFile(source,join(source,"control/processes.json"))).toString());
 if(!Array.isArray(registered)||registered.some(p=>!["verify","verify-check"].includes(p.phase)||!Number.isSafeInteger(p.pid)||p.pid<=0||p.pgid!==p.pid||typeof p.startedAt!=="string"))throw Error("saved-result-process-authority-invalid");
 async function walk(dir:string):Promise<void>{
  const entries=await readdir(dir,{withFileTypes:true});
  if(entries.some(e=>e.name==="process.json")){
   const p=JSON.parse((await readPrivateFile(source,join(dir,"process.json"))).toString());
   if(!registered.some((q:{pid:number;pgid:number;startedAt:string;phase:string})=>q.pid===p.pid&&q.pgid===p.pgid&&q.startedAt===p.startedAt&&q.phase===p.phase))throw Error("saved-result-process-authority-invalid");
  }
  for(const e of entries)if(e.isDirectory()&&e.name!=="worktrees")await walk(join(dir,e.name));
 }
 await walk(runDir);
}
/** Explicit controller reconciliation only: never launches a check, Agent or replacement worker. */
export async function settleSavedResult(input:LoopStartEnvelope):Promise<{ref:ArtifactRefV1;settlement:SavedResultSettlement}>{
 const source=input.work.sourceDir,runDir=join(source,"run");
 return withAcceptedLock(source,async()=>{
  const accepted=await readAccepted(source);
  if(accepted.envelopeHash!==canonicalHash(input)||accepted.generation!==input.claim.generation||accepted.configHash!==input.claim.configHash||input.mode!=="verify-saved-result")throw Error("saved-result-settlement-authority-invalid");
  const previous=await existingSettlement(input);if(previous)return {ref:previous,settlement:await readSettlement(input,previous)};
  const mode=await readSavedResultMode(runDir);if(canonicalHash(mode)!==canonicalHash(input))throw Error("saved-result-mode-conflict");
  const loaded=await loadSavedResultRecovery(input,false),owner=await readOwnerRecord(runDir);
  const dead=await confirmOwnerDead(owner);if(!dead.ok)throw Error("saved-result-owner-not-dead");
  if(!accepted.worker)throw Error("saved-result-process-authority-invalid");
  const worker=await classifyOwnerProcess({currentProcessInstanceId:`pid:${accepted.worker.pid}:${Date.parse(accepted.worker.startedAt)}`,lastAffirmedAt:accepted.worker.startedAt});
  if(worker.verdict!=="dead")throw Error("saved-result-owner-not-dead");
  if(!accepted.worker||!owner.currentProcessInstanceId.startsWith(`pid:${accepted.worker.pid}:`))throw Error("saved-result-process-authority-invalid");
  await validateOwnedProcesses(source,runDir);
  const reaped=await reapRunProcesses(runDir);if(!reaped.ok)throw Error(`saved-result-process-not-reaped:${reaped.reason}`);
  let authorized=true;try{await assertSavedResultFence(input,loaded.admission);}catch{authorized=false;}
  let state=await readRunState(runDir);
  if(await hasSavedResultEntry(runDir))state=await recoverSavedResultEntry(runDir,state,loaded,authorized);
  else if(!isTerminalRunStatus(state.status)){
   const prepared=await hasPreparedSavedResultProof(runDir,state);
   const budgetSnapshot=await readSavedResultBudget(runDir,loaded,state);
   state={...state,status:"blocked_waiting_human",waitingOnHuman:true,stopReason:prepared?"saved-result-before-entry-interrupted":"saved-result-lifecycle-unavailable",lastTransitionAt:new Date().toISOString(),budgetSnapshot};
  }
  if(!isTerminalRunStatus(state.status))throw Error("saved-result-settlement-state-invalid");
  await releaseOwnerLease(runDir,owner);
  await writeRunState(runDir,state);
  const events=await readUsageEvents(source);
  if(!events.some(e=>e.bucket==="work")||state.budgetSnapshot.tokenRemainingStatus==="unknown"){
   await appendUsageObservation(source,{runId:input.claim.runId,generation:input.claim.generation,bucket:"work",observationId:"saved-result-interrupted",threadTotalTokens:null,elapsedMs:0,attempts:state.attemptsUsed,sessions:1,evidence:{phase:"verify",attempt:state.currentAttempt,tokenUsage:null,completedWithResult:false,interrupted:true}});
  }
  if(state.status==="succeeded"){
   try{
    await assertSavedResultFence(input,loaded.admission);
    await assertSavedResultCompletionCandidate(runDir,loaded,state);
    const tree=join(runDir,"worktrees/attempt-1");
    try{await lstat(tree);registerAttemptRefNamespace(runDir,input.claim.runId);await cleanupAttemptWorkspaceBestEffort(input.work.contract.context.repoPath,tree,runDir,"cleanup after saved-result settlement");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const repository=await materializeResultRepository(input,runDir,state.currentAttempt);
    await assertSavedResultDelivery(runDir,loaded,state,repository);
   }catch(error){
    state={...state,status:"failed",waitingOnHuman:false,stopReason:error instanceof Error&&["saved-result-publication-unavailable","saved-result-source-stale"].includes(error.message)?error.message:"saved-result-modified-during-verification",lastTransitionAt:new Date().toISOString()};
    await writeRunState(runDir,state);
   }
  }
  const priorCandidate=await readHandoffCandidate(source);
  if(priorCandidate===null||priorCandidate.terminalOutcome!==state.status||priorCandidate.usageHighWater!==(await readUsageEvents(source)).at(-1)?.eventSeq){
   // Existing harvest/publication helpers consume a genuinely approved result only after the fresh fence check.
   if(state.status==="succeeded"){if(!authorized)throw Error("saved-result-source-stale");await assertSavedResultFence(input,loaded.admission);}
   await materializeResultRepository(input,runDir,state.currentAttempt);
   const result=state.status==="succeeded"?"complete":"partial";
   const usage=await appendUsageObservation(source,{runId:input.claim.runId,generation:input.claim.generation,bucket:"handoff",observationId:"saved-result-settlement",threadTotalTokens:0,elapsedMs:0,attempts:0,sessions:0,evidence:{requestId:null,result,mechanical:true}});
   const built=await buildHandoffPacket(input,null,state,usage.eventSeq,result);
   if(state.status==="succeeded"){await assertSavedResultFence(input,loaded.admission);await assertSavedResultDelivery(runDir,loaded,state,join(source,"repo"));}
   await persistHandoffCandidate(input,null,state,built,{result,usageHighWater:usage.eventSeq});
  }
  const sealed={...accepted,launch:"sealed" as const};await writeAccepted(source,sealed);
  const proof=await proveStopped({sourceDir:source,accepted:sealed});if(!proof)throw Error("saved-result-process-not-stopped");
  const identity=await savedResultIdentity(input),assertHeld=async()=>{const now=await readAccepted(source);if(now.envelopeHash!==accepted.envelopeHash||now.executionId!==accepted.executionId||now.generation!==accepted.generation)throw Error("saved-result-settlement-authority-invalid");};
  const retain=async(path:string)=>writeSavedBytes(source,await readPrivateFile(source,path),assertHeld);
  const usage=await retain(join(source,"control/usage.json")),usageEvents=await readUsageEvents(source),usageObservations=[];
  for(const event of usageEvents)usageObservations.push({source:event.source,copy:await writeSavedBytes(source,await readEvidence(source,event.source),assertHeld)});
  const settlement=savedResultSettlementSchema.parse({schema:"ccloop-saved-result-settlement-v1",identity,recoveryOf:input.savedResultRecovery!.recoveryOf,
   disposition:state.status==="succeeded"?"complete":["saved-result-verification-interrupted","saved-result-before-entry-interrupted"].includes(state.stopReason??"")?"interrupted":"terminal",
   usageStatus:usageEvents.some(e=>e.cumulative===null)?"unknown":"known",
   state:await retain(join(runDir,"loop-state.json")),lifecycle:await retain(join(runDir,"saved-result-lifecycle.json")).catch(()=>null),accepted:await retain(join(source,"control/accepted.json")),envelope:await retain(join(source,"control/envelope.json")),usage,
   stopProof:await writeSavedBytes(source,await readEvidence(source,proof.source),assertHeld),usageObservations});
  const ref=await writeSavedBytes(source,Buffer.from(canonicalJson(settlement)),assertHeld);
  await atomicReplacePrivateFile(source,indexPath(input),Buffer.from(canonicalJson({envelopeHash:accepted.envelopeHash,ref})));
  return {ref,settlement};
 });
}
async function readSettlement(input:LoopStartEnvelope,ref:ArtifactRefV1):Promise<SavedResultSettlement>{
 const identity=await savedResultIdentity(input),receipt=savedResultSettlementSchema.parse(JSON.parse((await readSavedBytes(input.work.sourceDir,ref)).toString()));
 if(canonicalHash(identity)!==canonicalHash(receipt.identity)||canonicalHash(receipt.recoveryOf)!==canonicalHash(input.savedResultRecovery?.recoveryOf))throw Error("saved-result-settlement-authority-invalid");
 const {usageObservations,...all}=receipt;
 for(const r of [receipt.state,...(receipt.lifecycle?[receipt.lifecycle]:[]),receipt.accepted,receipt.envelope,receipt.usage,receipt.stopProof,...usageObservations.map(a=>a.copy)])await readSavedBytes(input.work.sourceDir,r);
 const ledger=JSON.parse((await readSavedBytes(input.work.sourceDir,receipt.usage)).toString());
 if(ledger.events.length!==usageObservations.length||usageObservations.some((a,i)=>canonicalHash(a.source)!==canonicalHash(ledger.events[i].source)||a.source.hash!==a.copy.hash))throw Error("saved-result-settlement-authority-invalid");
 return receipt;
}
export async function readSavedResultSettlement(input:LoopStartEnvelope,settlementRef:ArtifactRefV1,ref:ArtifactRefV1):Promise<Buffer>{
 const saved=await existingSettlement(input);if(!saved||canonicalHash(saved)!==canonicalHash(settlementRef))throw Error("saved-result-settlement-authority-invalid");
 const r=await readSettlement(input,settlementRef),refs=[settlementRef,r.state,...(r.lifecycle?[r.lifecycle]:[]),r.accepted,r.envelope,r.usage,r.stopProof,...r.usageObservations.map(a=>a.copy)];
 const alias=r.usageObservations.find(a=>canonicalHash(a.source)===canonicalHash(ref));
 if(alias){if(alias.source.artifactId!==`evidence-${alias.source.hash}`||alias.copy.hash!==alias.source.hash)throw Error("saved-result-settlement-authority-invalid");return readSavedBytes(input.work.sourceDir,alias.copy);}
 if(!refs.some(r=>canonicalHash(r)===canonicalHash(ref)))throw Error("saved-result-settlement-authority-invalid");
 return readSavedBytes(input.work.sourceDir,ref);
}
