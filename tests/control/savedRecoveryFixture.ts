import { createHash } from "node:crypto";
import { readFile,writeFile,mkdir,chmod } from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {resultFixture} from "./taskResultFixture.js";
import {canonicalHash,canonicalJson,type ArtifactRefV1,type LoopStartEnvelope} from "../../src/control/protocol.js";
import {normalizeExecutionFinal} from "../../src/runtime/executionNormalizer.js";
import type {SavedResultAdmission,SavedResultPackage} from "../../src/control/savedResultRecovery.js";
export async function savedRecoveryFixture(variant:"default"|"hidden"|"partial"="default"){
 const fixtureRoot=fileURLToPath(new URL(`../fixtures/saved-result-legacy${variant==="default"?"":"-"+variant}/`,import.meta.url));
 const f=await resultFixture(),raw=JSON.parse(await readFile(join(fixtureRoot,"fixture.json"),"utf8"));
 const packagePath=join(f.sourceDir,"input/recovery");await mkdir(packagePath,{recursive:true,mode:0o700});
 const artifacts:Array<{ref:ArtifactRefV1;file:string}>=[];const bytes=new Map<string,Buffer>();
 for(const entry of raw.artifacts){const b=await readFile(join(fixtureRoot,entry.file));await writeFile(join(packagePath,entry.file),b,{mode:0o600});artifacts.push(entry);bytes.set(entry.ref.artifactId,b);}
 const put=async(value:unknown):Promise<ArtifactRefV1>=>{
  const b=Buffer.isBuffer(value)?value:Buffer.from(canonicalJson(value)),hash=createHash("sha256").update(b).digest("hex"),ref={artifactId:`recovery-${hash}`,hash},file=ref.artifactId+".bin";
  await writeFile(join(packagePath,file),b,{mode:0o600});if(!artifacts.some(e=>e.file===file))artifacts.push({ref,file});bytes.set(ref.artifactId,b);return ref;
 };
 const archive=JSON.parse(bytes.get(raw.archive.artifactId)!.toString());
 const log=(path:string)=>JSON.parse(bytes.get(archive.logs.find((x:any)=>x.path===path).ref.artifactId)!.toString());
 const source=raw.source as LoopStartEnvelope,accepted=log("control/accepted.json"),ledger=log("control/usage.json"),candidate=log("control/candidate.json");
 const finalPath=archive.logs.find((x:any)=>/\/execute\/call-[^/]+\/final.json$/.test(x.path));
 const normalized=normalizeExecutionFinal(bytes.get(finalPath.ref.artifactId)!.toString());if(normalized.status!=="available")throw Error("fixture raw output invalid");
 const recoveryOf={sourceRunId:source.claim.runId,sourceAttempt:1,capsuleHash:raw.archive.hash,snapshotHash:archive.snapshot.hash,normalizedExecutionHash:canonicalHash(normalized.execution)};
 const input:LoopStartEnvelope={...structuredClone(source),protocol:4,mode:"verify-saved-result",inputCheckpoint:null,
  claim:{...source.claim,runId:"recovery-1",generation:2,commandId:"recover-command",ownerToken:"recover-owner",grant:{work:{tokens:1000,activeMs:30000,attempts:2,sessions:1},handoff:source.claim.grant.handoff}},
  work:{...structuredClone(source.work),sourceDir:f.sourceDir,targetRepo:f.repo,contract:{...structuredClone(source.work.contract),context:{...source.work.contract.context,repoPath:f.repo}}},
  savedResultRecovery:{packagePath,packageHash:"0".repeat(64),admissionHash:"0".repeat(64),recoveryOf}};
 const stopProof=log(`control/evidence/${raw.stopProof.source.artifactId}.bin`),stopRef=await put(stopProof);
 const report=await put({candidate:{...candidate,stopProof:raw.stopProof},terminal:{outcome:"failed",sourceDir:source.work.sourceDir}});
 const lastKnown=ledger.events.filter((e:any)=>e.bucket==='work'&&e.cumulative!==null).at(-1).cumulative;
 const work={tokens:1000,activeMs:30000,attempts:2,sessions:1},handoff={tokens:0,activeMs:0,attempts:0,sessions:0};
 const charged={work:Object.fromEntries(Object.keys(work).map(d=>[d,(work as any)[d]-lastKnown[d]])),handoff:{tokens:1000,activeMs:30000,attempts:2,sessions:1}};
 // Typed controller boundary only. Task7 must create these via real owner settlement and DB receipt validation.
 const settlementValue={method:"remaining-grant",commandId:"settle-command",principal:"user:fixture",at:1,
  groupId:source.claim.groupId,taskId:source.claim.taskId,workItemId:source.claim.workItemId,runId:source.claim.runId,generation:source.claim.generation,highWater:3,
  charged,reservationDisposition:"committed",report,stopProof:raw.stopProof};
 const settlement=await put(settlementValue),receipt=await put({principal:"user:fixture",client:"web",verb:"settle-unknown-usage",commandId:"settle-command",result:{kind:"usage-settled",taskId:source.claim.taskId,runId:source.claim.runId,generation:source.claim.generation,charged,at:1,method:"remaining-grant"}});
 const policyAuthority={schema:"ccloop-recovery-policy-authority-v1",groupId:source.claim.groupId,workItemId:source.claim.workItemId,taskId:source.claim.taskId,sourceRunId:source.claim.runId,contractHash:source.contractHash,accountingMode:"finite-legacy",authoredWork:work};
 const funding={kind:"legacy-fresh-grant-v1",historicalPolicy:{accountingMode:"finite-legacy",authoredWork:work,contractHash:source.contractHash,authority:await put(policyAuthority)},
  inheritedUsage:work,freshGrant:input.claim.grant,fundedTotal:{tokens:2000,activeMs:60000,attempts:4,sessions:2},reservation:{runId:input.claim.runId,revision:7,workAllocationId:"allocation-work",handoffAllocationId:"allocation-handoff"}};
 const admission:SavedResultAdmission={funding:funding as any,schema:"ccloop-saved-result-admission-v1",revision:7,source:{groupId:source.claim.groupId,workItemId:source.claim.workItemId,taskId:source.claim.taskId!,runId:source.claim.runId,generation:source.claim.generation,graphVersion:source.claim.graphVersion,targetVersion:source.claim.targetVersion,executionId:accepted.executionId,envelopeHash:accepted.envelopeHash},recoveryOf,contractHash:source.contractHash,
  claim:{runId:input.claim.runId,generation:input.claim.generation,commandId:input.claim.commandId,ownerToken:input.claim.ownerToken,configHash:input.claim.configHash},currentRunId:source.claim.runId,predecessor:null,
  accounting:{work,handoff:{tokens:1000,activeMs:30000,attempts:2,sessions:1},highWater:3,report,stopProof:stopRef,settlement,receipt}};
 const manifest:SavedResultPackage={schema:"ccloop-saved-result-package-v1",authorityKind:"legacy-published-candidate-v1",source:raw.archive,admission:await put(admission),artifacts};
 const seal=async()=>{
  manifest.admission=await put(admission);const b=Buffer.from(canonicalJson(manifest));await writeFile(join(packagePath,"package.json"),b,{mode:0o600});
  input.savedResultRecovery!.packageHash=createHash("sha256").update(b).digest("hex");input.savedResultRecovery!.admissionHash=manifest.admission.hash;
  await mkdir(join(f.sourceDir,"control"),{recursive:true,mode:0o700});await writeFile(join(f.sourceDir,"control/recovery-fence.json"),canonicalJson({schema:"ccloop-saved-result-fence-v1",admissionHash:manifest.admission.hash,packageHash:input.savedResultRecovery!.packageHash,runId:input.claim.runId,generation:input.claim.generation,revision:admission.revision,currentRunId:admission.currentRunId,status:"admitted"}),{mode:0o600});
 };
 await seal();return {...f,input,source,manifest,admission,archive,bytes,put,seal,normalized:normalized.execution,log};
}
