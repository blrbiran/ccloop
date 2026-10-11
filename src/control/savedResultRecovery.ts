import {budgetAmountSchema,type BudgetAmount} from "../budget/tokenPolicy.js";
import {usageLedgerSchema} from "./usage.js";
import { z } from "zod";
import { artifactRefSchema, recoveryOfSchema, idSchema, type LoopStartEnvelope } from "./protocol.js";
const safe=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), positive=safe.refine(n=>n>0), hash=z.string().regex(/^[a-f0-9]{64}$/);
const amount=z.object({tokens:safe,activeMs:safe,attempts:safe,sessions:safe}).strict();
const policyBase={contractHash:hash,authority:artifactRefSchema};
const reservationSchema=z.object({runId:idSchema,revision:safe,workAllocationId:idSchema,handoffAllocationId:idSchema}).strict();
const fundingBase={inheritedUsage:amount,reservation:reservationSchema};
export const recoveryFundingSchema=z.discriminatedUnion("kind",[
 z.object({...fundingBase,kind:z.literal("legacy-fresh-grant-v1"),historicalPolicy:z.object({...policyBase,accountingMode:z.literal("finite-legacy"),authoredWork:amount}).strict(),freshGrant:z.object({work:amount,handoff:amount}).strict(),fundedTotal:amount}).strict(),
 z.object({...fundingBase,kind:z.literal("optional-cumulative-v1"),historicalPolicy:z.object({...policyBase,accountingMode:z.literal("optional-v1"),authoredWork:budgetAmountSchema}).strict(),freshGrant:z.object({work:budgetAmountSchema,handoff:amount}).strict(),fundedTotal:budgetAmountSchema}).strict(),
]);
export type RecoveryFunding=z.infer<typeof recoveryFundingSchema>;
export const recoveryPolicyAuthoritySchema=z.object({schema:z.literal("ccloop-recovery-policy-authority-v1"),groupId:idSchema,workItemId:idSchema,taskId:idSchema,sourceRunId:idSchema,
 contractHash:hash,accountingMode:z.enum(["finite-legacy","optional-v1"]),authoredWork:budgetAmountSchema}).strict();
export const savedResultAdmissionSchema=z.object({
 schema:z.literal("ccloop-saved-result-admission-v1"),revision:safe,funding:recoveryFundingSchema,
 source:z.object({groupId:idSchema,workItemId:idSchema,taskId:idSchema,runId:idSchema,generation:positive,graphVersion:safe,targetVersion:safe,executionId:idSchema,envelopeHash:hash}).strict(),
 recoveryOf:recoveryOfSchema,contractHash:hash,
 claim:z.object({runId:idSchema,generation:positive,commandId:idSchema,ownerToken:idSchema,configHash:hash}).strict(),
 currentRunId:idSchema,
 predecessor:z.object({runId:idSchema,recoveryOf:recoveryOfSchema,outcome:z.literal("interrupted"),record:artifactRefSchema}).strict().nullable(),
 accounting:z.object({work:amount,handoff:amount,highWater:safe,report:artifactRefSchema,stopProof:artifactRefSchema,
  settlement:artifactRefSchema.nullable(),receipt:artifactRefSchema.nullable()}).strict(),
}).strict();
export type SavedResultAdmission=z.infer<typeof savedResultAdmissionSchema>;
export const savedResultPackageSchema=z.object({schema:z.literal("ccloop-saved-result-package-v1"),
 authorityKind:z.enum(["execution-format-failure-v1","legacy-published-candidate-v1"]),source:artifactRefSchema,admission:artifactRefSchema,
 artifacts:z.array(z.object({ref:artifactRefSchema,file:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)}).strict()).max(20000),
}).strict();
export type SavedResultPackage=z.infer<typeof savedResultPackageSchema>;
export const savedResultFenceSchema=z.object({schema:z.literal("ccloop-saved-result-fence-v1"),
 admissionHash:hash,packageHash:hash,runId:idSchema,generation:positive,revision:safe,currentRunId:idSchema,status:z.literal("admitted")}).strict();
export type SavedResultFence=z.infer<typeof savedResultFenceSchema>;
export type SavedResultEligibility={status:"unavailable";reason:string}|{status:"eligible";authorityKind:SavedResultPackage["authorityKind"];normalizedExecutionHash:string};


import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open,readdir,realpath,mkdtemp,writeFile,rm,mkdir,chmod} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {canonicalHash,canonicalJson,startEnvelopeSchema,type ArtifactRefV1} from "./protocol.js";
import {loopContractSchema,type LoopContract} from "../contract/schema.js";
import {parseMaterializedAgentConfig,agentConfigHash} from "../agents/materialize.js";
import {normalizeExecutionFinal} from "../runtime/executionNormalizer.js";
import {decodeCodexResult,decodeCodexUsage,phaseJsonSchema} from "../runtime/codex/protocol.js";
import {executionFormatFailureSchema,executionSnapshotSchema} from "./savedResultEvidence.js";
import {safeTaskResultPath} from "./taskResultEvidence.js";
import {createAttemptWorkspace} from "../workspace/worktreeManager.js";
import type {AttemptPlan,ExecutionResult} from "../runtime/types.js";
const exec=promisify(execFile),digest=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
function fail(reason:string):never{throw new Error(reason);}
const same=(a:unknown,b:unknown)=>canonicalHash(a)===canonicalHash(b);
const oid=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const path=z.string().refine(safeTaskResultPath);
const treeEntry=z.union([
 z.object({path,kind:z.literal("file"),mode:safe.max(0o777),ref:artifactRefSchema}).strict(),
 z.object({path,kind:z.literal("directory"),mode:safe.max(0o777)}).strict(),
]);
const legacySnapshotSchema=z.object({version:z.literal(1),head:oid,bundle:artifactRefSchema,
 index:z.array(z.object({path,mode:z.enum(["100644","100755"]),oid,stage:z.literal(0),ref:artifactRefSchema}).strict()).max(10000),
 tree:z.array(treeEntry).max(10000),deleted:z.array(path).length(0),missing:z.array(z.string()).length(0)}).strict();
const archiveSchema=z.object({version:z.literal(1),runId:idSchema,sourceIdentity:z.object({dev:z.string(),ino:z.string(),birthtimeNs:z.string()}).strict(),
 logs:z.array(treeEntry).max(20000),snapshot:artifactRefSchema,missing:z.array(z.string()).length(0)}).strict();
type LegacySnapshot=z.infer<typeof legacySnapshotSchema>;
export interface LoadedSavedResult {
 input:LoopStartEnvelope; admission:SavedResultAdmission; manifest:SavedResultPackage; source:LoopStartEnvelope;
 plan:AttemptPlan; execution:ExecutionResult; snapshot:LegacySnapshot; bytes:Map<string,Buffer>; originalBase:string; actualChangedPaths:string[];
}
export async function savedGit(cwd:string,...args:string[]):Promise<Buffer>{
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith("GIT_"))delete env[key];
 return (await exec("/usr/bin/git",["--no-replace-objects","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false",...args],{cwd,env,encoding:"buffer",maxBuffer:16*1024*1024,timeout:30000})).stdout;
}
async function privateBytes(root:string,file:string):Promise<Buffer>{
 if(await realpath(root)!==root||(await lstat(root)).isSymbolicLink())fail("saved-result-package-path-invalid");
 const target=join(root,file);if(await realpath(target)!==target)fail("saved-result-package-path-invalid");
 const before=await lstat(target,{bigint:true});
 if(!before.isFile()||before.nlink!==1n||(before.mode&0o7777n)!==0o600n||before.size>BigInt(12*1024*1024-1024))fail("saved-result-package-file-invalid");
 const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes:Buffer;
 try{bytes=await handle.readFile();}finally{await handle.close();}
 const after=await lstat(target,{bigint:true});
 if(before.ino!==after.ino||before.dev!==after.dev||before.ctimeNs!==after.ctimeNs||before.size!==after.size)fail("saved-result-package-changed");
 return bytes;
}
function semantic(contract:LoopContract):unknown{
 const {repoPath:_repo,...context}=contract.context;
 const {tokenBudget:_tokens,maxAttempts:_attempts,totalRuntimeBudgetMs:_time,...executionPolicy}=contract.executionPolicy;
 return {...contract,context,executionPolicy};
}
export function boundSavedResultRuntime(source:LoopContract,actual:LoopContract):void{
 if(!same(semantic(source),semantic(actual))||actual.executionPolicy.maxAttempts>source.executionPolicy.maxAttempts
  ||actual.executionPolicy.totalRuntimeBudgetMs>source.executionPolicy.totalRuntimeBudgetMs
  ||(source.executionPolicy.tokenBudget!==null&&(actual.executionPolicy.tokenBudget===null||actual.executionPolicy.tokenBudget>source.executionPolicy.tokenBudget)))fail("saved-result-runtime-contract-mismatch");
}
export async function assertSavedResultFence(input:LoopStartEnvelope,admission:SavedResultAdmission):Promise<void>{
 const recovery=input.savedResultRecovery!;
 let fence:SavedResultFence;
 try{fence=savedResultFenceSchema.parse(JSON.parse((await privateBytes(join(input.work.sourceDir,"control"),"recovery-fence.json")).toString()));}
 catch{fail("saved-result-source-stale");}
 if(!same(fence,{schema:"ccloop-saved-result-fence-v1",admissionHash:recovery.admissionHash,packageHash:recovery.packageHash,
  runId:input.claim.runId,generation:input.claim.generation,revision:admission.revision,currentRunId:admission.currentRunId,status:"admitted"}))fail("saved-result-source-stale");
}
async function loadPackage(input:LoopStartEnvelope,requireFence=true){
 if(input.protocol!==4||input.mode!=="verify-saved-result"||!input.savedResultRecovery||input.inputCheckpoint!==null)fail("saved-result-mode-invalid");
 const r=input.savedResultRecovery,root=r.packagePath;
 const inputRoot=join(input.work.sourceDir,"input");
 if(dirname(root)!==inputRoot||await realpath(inputRoot)!==inputRoot)fail("saved-result-package-path-invalid");
 const raw=await privateBytes(root,"package.json");if(digest(raw)!==r.packageHash)fail("saved-result-package-hash-mismatch");
 const manifest=savedResultPackageSchema.parse(JSON.parse(raw.toString())),bytes=new Map<string,Buffer>(),files=new Set(["package.json"]);
 for(const e of manifest.artifacts){
  if(files.has(e.file)||bytes.has(e.ref.artifactId))fail("saved-result-package-duplicate");files.add(e.file);
  const value=await privateBytes(root,e.file);if(digest(value)!==e.ref.hash)fail("saved-result-source-hash-mismatch");bytes.set(e.ref.artifactId,value);
 }
 if((await readdir(root)).some(name=>!files.has(name)))fail("saved-result-package-unmanifested");
 const get=(ref:ArtifactRefV1)=>{const b=bytes.get(ref.artifactId);if(!b||digest(b)!==ref.hash)fail("saved-result-source-hash-mismatch");return b;};
 const json=(ref:ArtifactRefV1)=>JSON.parse(get(ref).toString());
 if(manifest.admission.hash!==r.admissionHash||manifest.source.hash!==r.recoveryOf.capsuleHash)fail("saved-result-source-hash-mismatch");
 const admission=savedResultAdmissionSchema.parse(json(manifest.admission));
 if(!same(admission.recoveryOf,r.recoveryOf)||admission.contractHash!==input.contractHash||!same(admission.claim,{runId:input.claim.runId,generation:input.claim.generation,commandId:input.claim.commandId,ownerToken:input.claim.ownerToken,configHash:input.claim.configHash}))fail("saved-result-source-stale");
 for(const key of ["groupId","workItemId","taskId","graphVersion","targetVersion"] as const)if(admission.source[key]!==input.claim[key])fail("saved-result-source-stale");
 if(admission.source.runId!==r.recoveryOf.sourceRunId||admission.source.runId===input.claim.runId)fail("saved-result-source-stale");
 if(admission.predecessor===null){if(admission.currentRunId!==admission.source.runId)fail("saved-result-source-stale");}
 else {
  const p=admission.predecessor;
  if(p.runId!==admission.currentRunId||p.runId===admission.source.runId||!same(p.recoveryOf,r.recoveryOf))fail("saved-result-source-stale");
 }
 if(requireFence)await assertSavedResultFence(input,admission);
 return {manifest,bytes,get,json,admission};
}
async function validateSnapshot(snapshot:LegacySnapshot,get:(ref:ArtifactRefV1)=>Buffer,runId:string,attempt:number,base:string):Promise<string[]>{
 const root=await mkdtemp(join(tmpdir(),"saved-result-check-"));await chmod(root,0o700);
 try{
  await savedGit(root,"init","--bare","-q",`--object-format=${snapshot.head.length===64?"sha256":"sha1"}`);const bundle=join(root,"source.bundle");await writeFile(bundle,get(snapshot.bundle),{mode:0o600});
  await savedGit(root,"bundle","verify",bundle);
  const refs=(await savedGit(root,"bundle","list-heads",bundle)).toString().trim().split("\n");
  const expected=`${snapshot.head} refs/ccloop/${runId}/attempts/${attempt}`;
  if(!refs.includes(expected))fail("saved-result-legacy-ref-missing");
  if(!refs.includes(`${snapshot.head} HEAD`))fail("saved-result-snapshot-head-mismatch");
  await savedGit(root,"fetch","-q",bundle,`refs/ccloop/${runId}/attempts/${attempt}`);
  const parent=(await savedGit(root,"rev-list","--parents","-n","1",snapshot.head)).toString().trim().split(" ");
  if(parent.length!==2||parent[1]!==base)fail("saved-result-original-base-unavailable");
  const entries=(await savedGit(root,"ls-tree","-r","-z",snapshot.head)).toString().split("\0").filter(Boolean);
  const index=snapshot.index.map(e=>`${e.mode} blob ${e.oid}\t${e.path}`);
  if(!same(entries,index))fail("saved-result-snapshot-index-mismatch");
  const all=new Set<string>(),directories=new Set<string>();
  for(const e of snapshot.index){
   if(all.has(e.path))fail("saved-result-snapshot-path-invalid");all.add(e.path);
   const b=get(e.ref),objectHash=createHash(e.oid.length===64?"sha256":"sha1").update(Buffer.from(`blob ${b.length}\0`)).update(b).digest("hex");
   if(objectHash!==e.oid)fail("saved-result-snapshot-index-mismatch");
   const file=snapshot.tree.find(t=>t.path===e.path);
   if(!file||file.kind!=="file"||!get(file.ref).equals(b)||((file.mode&0o111)!==0)!==(e.mode==="100755"))fail("saved-result-snapshot-tree-mismatch");
   let p=dirname(e.path);while(p!=="."){directories.add(p);p=dirname(p);}
  }
  const seen=new Set<string>();for(const e of snapshot.tree){if(seen.has(e.path))fail("saved-result-snapshot-path-invalid");seen.add(e.path);if(e.kind==="file"?!all.has(e.path):!directories.has(e.path))fail("saved-result-snapshot-tree-mismatch");}
  for(const dir of directories)if(!snapshot.tree.some(e=>e.path===dir&&e.kind==="directory"))fail("saved-result-snapshot-tree-mismatch");
  return (await savedGit(root,"diff","--name-only","-z",base,snapshot.head)).toString().split("\0").filter(Boolean);
 }finally{await rm(root,{recursive:true,force:true});}
}
const stopSchema=z.object({executionId:idSchema,generation:positive,isolated:z.literal(true),source:artifactRefSchema}).strict();
const pair=z.object({work:amount,handoff:amount}).strict();
const settlementSchema=z.object({method:z.literal("remaining-grant"),commandId:idSchema,principal:z.string().regex(/^user:.+/),at:safe,
 groupId:idSchema,taskId:idSchema,workItemId:idSchema,runId:idSchema,generation:positive,highWater:safe,charged:pair,
 reservationDisposition:z.enum(["committed","released"]),report:artifactRefSchema,stopProof:stopSchema,
 handoffResolution:z.object({requestId:idSchema,previousState:z.literal("settled-unrecoverable"),previousFailureCode:z.literal("usage-unsettled"),checkpointId:idSchema,checkpointHash:hash}).strict().optional()}).strict();
const receiptSchema=z.object({principal:z.string(),client:z.literal("web"),verb:z.literal("settle-unknown-usage"),commandId:idSchema,
 result:z.object({kind:z.literal("usage-settled"),taskId:idSchema,runId:idSchema,generation:positive,charged:pair,at:safe,method:z.literal("remaining-grant")}).strict()}).strict();
const phaseProcess=z.object({pid:positive,pgid:positive,startedAt:z.string().min(1),phase:z.string()}).strict();
function validateAccounting(admission:SavedResultAdmission,source:LoopStartEnvelope,ledger:any,readLogical:(ref:ArtifactRefV1)=>Buffer,json:(ref:ArtifactRefV1)=>any,expectedOutcome="failed"):void{
 ledger=usageLedgerSchema.parse(ledger);
 const a=admission.accounting,identity=admission.source;
 const report=json(a.report),candidate=report.candidate,proof=json(a.stopProof);
 if(!candidate||report.terminal?.outcome!==expectedOutcome||report.terminal.sourceDir!==source.work.sourceDir||candidate.terminalOutcome!==expectedOutcome||candidate.usageHighWater!==a.highWater)fail("saved-result-accounting-invalid");
 for(const key of ["runId","groupId","workItemId","taskId","generation","graphVersion","targetVersion"] as const)if(candidate[key]!==identity[key])fail("saved-result-accounting-invalid");
 const stop=stopSchema.parse(candidate.stopProof),originalProof=JSON.parse(readLogical(stop.source).toString());
 if(!same(proof,originalProof)||proof.isolated!==true||proof.ownerLeaseReleased!==true||proof.workerSealed!==true||proof.executionId!==identity.executionId||proof.generation!==identity.generation||stop.executionId!==identity.executionId||stop.generation!==identity.generation)fail("saved-result-process-authority-invalid");
 if(ledger.protocol!==1||ledger.nextSeq!==a.highWater+1||!Array.isArray(ledger.events)||ledger.events.length!==a.highWater)fail("saved-result-usage-unsettled");
 const baseline={work:{tokens:0,activeMs:0,attempts:0,sessions:0},handoff:{tokens:0,activeMs:0,attempts:0,sessions:0}};let unknown=false;
 for(const [index,event] of ledger.events.entries()){
  if(event.eventSeq!==index+1||event.runId!==identity.runId||event.generation!==identity.generation||!["work","handoff"].includes(event.bucket))fail("saved-result-usage-unsettled");
  readLogical(artifactRefSchema.parse(event.source));
  if(event.cumulative===null)unknown=true;
  else{const value=amount.parse(event.cumulative),bucket=event.bucket as "work"|"handoff";
   for(const d of ["tokens","activeMs","attempts","sessions"] as const)if(value[d]<baseline[bucket][d])fail("saved-result-usage-unsettled");baseline[bucket]=value;}
 }
 if(unknown){
  if(a.settlement===null||a.receipt===null)fail("saved-result-usage-unsettled");
  const marker=settlementSchema.parse(json(a.settlement)),receipt=receiptSchema.parse(json(a.receipt));
  for(const key of ["runId","groupId","workItemId","taskId","generation"] as const)if(marker[key]!==identity[key])fail("saved-result-settlement-invalid");
  if(marker.highWater!==a.highWater||!same(marker.report,a.report)||!same(marker.stopProof,stop)||marker.commandId!==receipt.commandId||marker.principal!==receipt.principal
   ||!same(receipt.result,{kind:"usage-settled",taskId:identity.taskId,runId:identity.runId,generation:identity.generation,charged:marker.charged,at:marker.at,method:marker.method})
   ||(marker.reservationDisposition==="released")!==(marker.handoffResolution!==undefined))fail("saved-result-settlement-invalid");
  for(const bucket of ["work","handoff"] as const)for(const d of ["tokens","activeMs","attempts","sessions"] as const){
   const ceiling=source.claim.grant[bucket][d],charged=marker.charged[bucket][d];
   if(ceiling===null||charged!==Math.max(ceiling-baseline[bucket][d],0)||a[bucket][d]!==baseline[bucket][d]+charged)fail("saved-result-settlement-invalid");
  }
 }else if(a.settlement!==null||a.receipt!==null||!same(a.work,baseline.work)||!same(a.handoff,baseline.handoff))fail("saved-result-accounting-invalid");
}
type SourceExpectation={runId:string;attempt:number;envelopeHash:string;contractHash:string;snapshotHash?:string};
type SourceBytes={manifest:Pick<SavedResultPackage,"authorityKind"|"source">;get:(ref:ArtifactRefV1)=>Buffer;json:(ref:ArtifactRefV1)=>any;bytes:Map<string,Buffer>};
async function validateSavedSource(loaded:SourceBytes,expected:SourceExpectation){
 const {manifest,get,json,bytes}=loaded;
 if(manifest.authorityKind==="execution-format-failure-v1"){
  const capsule=executionFormatFailureSchema.parse(json(manifest.source));
  if(capsule.identity.runId!==expected.runId||capsule.identity.envelopeHash!==expected.envelopeHash||capsule.attempt!==expected.attempt||(expected.snapshotHash!==undefined&&capsule.snapshot.hash!==expected.snapshotHash))fail("saved-result-source-stale");
  const snapshot=executionSnapshotSchema.parse(json(capsule.snapshot));
  const {usageObservations,...artifacts}=capsule.artifacts;
  for(const ref of [capsule.verifier.proof,...Object.values(artifacts),...usageObservations.map(a=>a.copy),snapshot.index,snapshot.bundle,snapshot.status,...snapshot.files.map(f=>f.ref)])get(ref);
  const ledger=json(capsule.artifacts.usageLedger);
  if(ledger.events.length!==usageObservations.length||usageObservations.some((a,i)=>!same(a.source,ledger.events[i].source)||a.source.artifactId!==`evidence-${a.source.hash}`||a.source.hash!==a.copy.hash))fail("saved-result-source-hash-mismatch");
  const normalized=normalizeExecutionFinal(get(capsule.artifacts.final).toString());
  if(normalized.status!=="available")fail(normalized.reason);
  // This producer recorded failure under this very decoder. Reinterpreting it as success is contradictory evidence.
  fail("saved-result-normalizer-provenance-unavailable");
 }
 const archive=archiveSchema.parse(json(manifest.source));
 if(archive.runId!==expected.runId||(expected.snapshotHash!==undefined&&archive.snapshot.hash!==expected.snapshotHash))fail("saved-result-source-stale");
 const logs=new Map<string,Buffer>(),seenPaths=new Set<string>();
 for(const entry of archive.logs){if(seenPaths.has(entry.path))fail("saved-result-archive-invalid");seenPaths.add(entry.path);if(entry.kind==="file")logs.set(entry.path,get(entry.ref));}
 const log=(path:string)=>logs.get(path)??fail("saved-result-original-evidence-unavailable");
 const obj=(path:string)=>JSON.parse(log(path).toString());
 const logical=(ref:ArtifactRefV1)=>{if(ref.artifactId!==`evidence-${ref.hash}`)fail("saved-result-source-hash-mismatch");const b=log(`control/evidence/${ref.artifactId}.bin`);if(digest(b)!==ref.hash)fail("saved-result-source-hash-mismatch");return b;};
 const source=startEnvelopeSchema.parse(obj("control/envelope.json")) as LoopStartEnvelope;
 if(source.work.kind!=="loop"||source.mode!==undefined||source.claim.runId!==archive.runId||source.contractHash!==expected.contractHash||canonicalHash(source)!==expected.envelopeHash)fail("saved-result-source-stale");
 if(source.work.contract.context.relevantDocs.some(path=>!safeTaskResultPath(path)))fail("saved-result-protected-input-unavailable");
 boundSavedResultRuntime(source.work.contract,loopContractSchema.parse(obj("run/loop-contract.json")));
 const accepted=obj("control/accepted.json"),state=obj("run/loop-state.json"),owner=obj("run/owner-record.json"),attempt=expected.attempt;
 if(owner.runId!==source.work.contract.objective.taskId||owner.ownerStatus!=="current"||owner.supersededByEpoch!==null||!String(owner.currentProcessInstanceId).startsWith(`pid:${accepted.worker?.pid}:`))fail("saved-result-owner-invalid");
 if(accepted.launch!=="sealed"||!accepted.worker||!idSchema.safeParse(accepted.executionId).success||accepted.envelopeHash!==expected.envelopeHash||accepted.configHash!==source.claim.configHash||accepted.generation!==source.claim.generation||owner.leaseAffirmedAt!==null||state.status!=="failed"||state.currentAttempt!==attempt||state.attemptsUsed!==attempt)fail("saved-result-source-stale");
 const config=parseMaterializedAgentConfig(obj("control/config.json"));
 if(config.kind!=="codex")fail("saved-result-provider-original-evidence-unsupported");
 if(agentConfigHash(config)!==source.claim.configHash)fail("saved-result-config-mismatch");
 const events=log("run/events.jsonl").toString().trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
 if(events.some(e=>["attempt_commit_publish_failed","workspace_cleanup_failed","execution_finished","verification_rejected"].includes(e.type)))fail("saved-result-legacy-publication-unproven");
 const executeCalls=archive.logs.filter(e=>e.kind==="directory"&&new RegExp(`^run/codex/${attempt}/execute/call-[^/]+$`).test(e.path));
 const planCalls=archive.logs.filter(e=>e.kind==="directory"&&new RegExp(`^run/codex/${attempt}/plan/call-[^/]+$`).test(e.path));
 if(executeCalls.length!==1||planCalls.length!==1)fail("saved-result-execute-call-ambiguous");
 if(archive.logs.some(e=>e.path.startsWith(`run/codex/${attempt}/verify`)||e.path===`run/attempts/${attempt}/verify.json`))fail("saved-result-verification-already-entered");
 const registered=z.array(phaseProcess.extend({registeredAt:z.string()}).strict()).parse(obj("control/processes.json"));
 const validateCall=(call:string,phase:string)=>{
  const outcome=obj(`${call}/outcome.json`),process=phaseProcess.parse(obj(`${call}/process.json`));
  if(outcome.reason!=="completed"||outcome.code!==0||outcome.signal!==null||outcome.ioError!==undefined||outcome.stdoutTruncated!==false||outcome.stderrTruncated!==false||outcome.finalTruncated!==false)fail("saved-result-process-incomplete");
  if(process.phase!==phase||!registered.some(p=>p.pid===process.pid&&p.pgid===process.pgid&&p.startedAt===process.startedAt&&p.phase===phase))fail("saved-result-process-authority-invalid");
  // Compare only immutable original path strings. Never resolve or read the historical live paths.
  const evidenceDir=join(source.work.sourceDir,call),worktree=join(source.work.sourceDir,"run/worktrees",`attempt-${attempt}`);
  const expectedArgs=[...config.installation.command.slice(1),"exec","--json","--ephemeral","--color","never","--model",config.selection.model,
   "--sandbox",phase==="execute"?config.installation.sandbox:"read-only","-C",worktree,"--output-schema",join(evidenceDir,"schema.json"),"-o",join(evidenceDir,"final.json"),"-"];
  if(outcome.executable!==config.installation.command[0]||!same(outcome.args,expectedArgs)||outcome.evidenceDir!==evidenceDir)fail("saved-result-config-mismatch");
 };
 const execute=executeCalls[0]!.path,planCall=planCalls[0]!.path;validateCall(execute,"execute");validateCall(planCall,"plan");
 if(!same(obj(`${execute}/schema.json`),{type:"object",properties:{result:phaseJsonSchema("execute")},required:["result"],additionalProperties:false})||!same(obj(`${planCall}/schema.json`),phaseJsonSchema("plan")))fail("saved-result-schema-mismatch");
 if(!log(`${execute}/decode-error.txt`).length)fail("saved-result-original-evidence-unavailable");
 const final=log(`${execute}/final.json`).toString(),rawEvents=log(`${execute}/events.jsonl`).toString();
 decodeCodexUsage(rawEvents,true);
 const normalized=normalizeExecutionFinal(final);if(normalized.status!=="available")fail(normalized.reason);
 const plan=decodeCodexResult("plan",log(`${planCall}/events.jsonl`).toString(),log(`${planCall}/final.json`).toString());
 const ledger=obj("control/usage.json");
 const proofs=[...logs.entries()].filter(([path])=>path.startsWith("control/evidence/")).flatMap(([,b])=>{try{return [JSON.parse(b.toString())];}catch{return [];}});
 const proof=proofs.find(p=>p.executionId===accepted.executionId&&p.generation===source.claim.generation&&p.ownerLeaseReleased===true&&p.workerSealed===true&&p.isolated===true);
 if(!proof)fail("saved-result-process-authority-invalid");
 if(!Array.isArray(proof.registered)||!registered.every(p=>proof.registered.some((q:any)=>q.pid===p.pid&&q.pgid===p.pgid&&q.startedAt===p.startedAt&&q.phase===p.phase)))fail("saved-result-process-authority-invalid");
 if(!oid.safeParse(source.work.base).success)fail("saved-result-original-base-unavailable");
 const snapshot=legacySnapshotSchema.parse(json(archive.snapshot));const actualChangedPaths=await validateSnapshot(snapshot,get,source.claim.runId,attempt,source.work.base);
 idSchema.parse(source.claim.taskId);
 const {groupId,workItemId,taskId,runId,generation,graphVersion,targetVersion}=source.claim;
 const identity={groupId,workItemId,taskId,runId,generation,graphVersion,targetVersion,executionId:accepted.executionId,envelopeHash:accepted.envelopeHash};
 return {source,identity,plan,execution:normalized.execution,snapshot,bytes,originalBase:source.work.base,ledger,logical,registered,
  rawExecutionTokens:decodeCodexUsage(rawEvents,true).tokenUsage,snapshotHash:archive.snapshot.hash,actualChangedPaths};
}
/** Execution requires both strict source eligibility and the independently fenced controller admission. */
export async function loadSavedResultRecovery(input:LoopStartEnvelope,requireFence=true):Promise<LoadedSavedResult>{
 const loaded=await loadPackage(input,requireFence),{admission}=loaded,r=input.savedResultRecovery!;
 const original=await validateSavedSource(loaded,{runId:admission.source.runId,attempt:r.recoveryOf.sourceAttempt,envelopeHash:admission.source.envelopeHash,contractHash:admission.contractHash,snapshotHash:r.recoveryOf.snapshotHash});
 if(!same(original.identity,admission.source)||!same(semantic(original.source.work.contract),semantic(input.work.contract)))fail("saved-result-source-stale");
 if(canonicalHash(original.execution)!==r.recoveryOf.normalizedExecutionHash)fail("saved-result-normalization-hash-mismatch");
 validateAccounting(admission,original.source,original.ledger,original.logical,loaded.json);
 const inherited=original.source.tokenPolicy?.inheritedUsage??{tokens:0,activeMs:0,attempts:0,sessions:0};
 const baseInherited=addWork(inherited,admission.accounting.work);
 const expectedInherited=await validateInterruptedPredecessor(input,loaded,baseInherited);
 validateRecoveryFunding(input,admission,loaded.json,expectedInherited);
 if(requireFence)await assertSavedResultFence(input,admission);
 return {...original,input,admission,manifest:loaded.manifest};
}
export async function readSavedResultEligibility(input:LoopStartEnvelope):Promise<SavedResultEligibility>{
 try{const value=await loadSavedResultRecovery(input);return {status:"eligible",authorityKind:value.manifest.authorityKind,normalizedExecutionHash:value.admission.recoveryOf.normalizedExecutionHash};}
 catch(error){return {status:"unavailable",reason:error instanceof Error&&(error.message.startsWith("saved-result-")||["execution-format-invalid","execution-format-ambiguous-or-hidden"].includes(error.message))?error.message:"saved-result-evidence-invalid"};}
}
export async function materializeSavedResult(repo:string,runDir:string,attempt:number,loaded:LoadedSavedResult):Promise<{worktreePath:string}>{
 const {snapshot,bytes}=loaded,bundle=join(runDir,"saved-result.bundle");await writeFile(bundle,bytes.get(snapshot.bundle.artifactId)!,{mode:0o600});
 await savedGit(repo,"fetch","-q",bundle,`refs/ccloop/${loaded.source.claim.runId}/attempts/${loaded.admission.recoveryOf.sourceAttempt}`);
 const existing=join(runDir,"worktrees",`attempt-${attempt}`);
 try{await lstat(existing);await savedGit(repo,"worktree","remove","--force",existing);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const result=await createAttemptWorkspace(repo,runDir,attempt,snapshot.head);
 const tree=result.worktreePath;await chmod(tree,0o700);
 for(const name of await readdir(tree))if(name!==".git")await rm(join(tree,name),{recursive:true,force:true});
 for(const entry of snapshot.tree.filter(e=>e.kind==="directory").sort((a,b)=>a.path.length-b.path.length))await mkdir(join(tree,entry.path),{recursive:true,mode:0o700});
 for(const entry of snapshot.tree)if(entry.kind==="file"){await writeFile(join(tree,entry.path),bytes.get(entry.ref.artifactId)!,{mode:0o600});await chmod(join(tree,entry.path),entry.mode);}
 for(const entry of snapshot.tree.filter(e=>e.kind==="directory").reverse())await chmod(join(tree,entry.path),entry.mode);
 await savedGit(tree,"read-tree",snapshot.head);return result;
}

export const savedResultSourcePackageSchema=savedResultPackageSchema.omit({admission:true}).extend({schema:z.literal("ccloop-saved-result-source-package-v1")}).strict();
export type SavedResultSourcePackage=z.infer<typeof savedResultSourcePackageSchema>;
export interface SavedResultSourceInput {source:LoopStartEnvelope;sourceAttempt:number;packagePath:string;packageHash:string}
export async function readSavedResultSourceEligibility(input:SavedResultSourceInput){
 try{
  positive.parse(input.sourceAttempt);hash.parse(input.packageHash);
  const raw=await privateBytes(input.packagePath,"package.json");if(digest(raw)!==input.packageHash)fail("saved-result-package-hash-mismatch");
  const manifest=savedResultSourcePackageSchema.parse(JSON.parse(raw.toString())),bytes=new Map<string,Buffer>(),files=new Set(["package.json"]);
  for(const e of manifest.artifacts){if(files.has(e.file)||bytes.has(e.ref.artifactId))fail("saved-result-package-duplicate");files.add(e.file);const value=await privateBytes(input.packagePath,e.file);if(digest(value)!==e.ref.hash)fail("saved-result-source-hash-mismatch");bytes.set(e.ref.artifactId,value);}
  if((await readdir(input.packagePath)).some(name=>!files.has(name)))fail("saved-result-package-unmanifested");
  const get=(ref:ArtifactRefV1)=>{const b=bytes.get(ref.artifactId);if(!b||digest(b)!==ref.hash)fail("saved-result-source-hash-mismatch");return b;};
  const original=await validateSavedSource({manifest,bytes,get,json:ref=>JSON.parse(get(ref).toString())},{runId:input.source.claim.runId,attempt:input.sourceAttempt,envelopeHash:canonicalHash(input.source),contractHash:input.source.contractHash});
  return {status:"eligible" as const,authorityKind:manifest.authorityKind,sourceIdentity:original.identity,rawExecutionTokens:original.rawExecutionTokens,
   recoveryOf:{sourceRunId:original.source.claim.runId,sourceAttempt:input.sourceAttempt,capsuleHash:manifest.source.hash,snapshotHash:original.snapshotHash,normalizedExecutionHash:canonicalHash(original.execution)},
   limitation:"published-candidate-only; current membership and settled accounting require controller admission"};
 }catch(error){return {status:"unavailable" as const,reason:error instanceof Error&&(error.message.startsWith("saved-result-")||["execution-format-invalid","execution-format-ambiguous-or-hidden"].includes(error.message))?error.message:"saved-result-evidence-invalid"};}
}

/** Controller publishes this closure only after the interrupted predecessor is reaped and accounting is settled. */
export const interruptedSavedResultSchema=z.object({schema:z.literal("ccloop-saved-result-interrupted-v1"),
 envelope:artifactRefSchema,accepted:artifactRefSchema,package:artifactRefSchema,admission:artifactRefSchema,state:artifactRefSchema,lifecycle:artifactRefSchema,usage:artifactRefSchema,
 accounting:savedResultAdmissionSchema.shape.accounting,artifacts:z.array(artifactRefSchema)}).strict();
export type InterruptedSavedResult=z.infer<typeof interruptedSavedResultSchema>;
async function validateInterruptedPredecessor(input:LoopStartEnvelope,loaded:Awaited<ReturnType<typeof loadPackage>>,baseInherited:z.infer<typeof amount>,depth=0):Promise<z.infer<typeof amount>>{
 if(depth>100)fail("saved-result-lineage-too-large");
 const predecessor=loaded.admission.predecessor;if(!predecessor)return baseInherited;
 const record=interruptedSavedResultSchema.parse(loaded.json(predecessor.record));
 const json=(ref:ArtifactRefV1)=>{if(!record.artifacts.some(r=>same(r,ref)))fail("saved-result-predecessor-invalid");return loaded.json(ref);};
 const prior=startEnvelopeSchema.parse(json(record.envelope)) as LoopStartEnvelope,accepted=json(record.accepted),state=json(record.state);
 if(prior.mode!=="verify-saved-result"||prior.claim.runId!==predecessor.runId||prior.contractHash!==input.contractHash||!same(prior.savedResultRecovery?.recoveryOf,input.savedResultRecovery!.recoveryOf)
  ||!same(semantic(prior.work.contract),semantic(input.work.contract))||accepted.envelopeHash!==canonicalHash(prior)||accepted.configHash!==prior.claim.configHash||accepted.generation!==prior.claim.generation
  ||accepted.launch!=="sealed"||state.status!=="blocked_waiting_human"||!["saved-result-verification-interrupted","saved-result-before-entry-interrupted"].includes(state.stopReason)||!state.savedResult
  ||state.savedResult.mode!=="verify-saved-result"||state.savedResult.packageHash!==prior.savedResultRecovery?.packageHash||!same(state.savedResult.recoveryOf,input.savedResultRecovery!.recoveryOf))fail("saved-result-predecessor-invalid");
 const life=json(record.lifecycle);
 if(life.schema!=="ccloop-saved-result-lifecycle-v1"||life.packageHash!==prior.savedResultRecovery!.packageHash)fail("saved-result-predecessor-invalid");
 if(state.stopReason==="saved-result-before-entry-interrupted"){
  const ledger=json(record.usage),proof=json(record.accounting.stopProof);
  if(life.stage!=="prepared"||!state.savedResult.prepared||!same(life.prepared,state.savedResult.prepared)||state.savedResult.entry!==undefined||!Array.isArray(proof.registered)||proof.registered.length!==0
    ||ledger.events.filter((e:any)=>e.bucket==="work").length!==1)fail("saved-result-predecessor-invalid");
  const event=ledger.events.find((e:any)=>e.bucket==="work"),observed=json(event.source);
  if(observed.kind!=="saved-result-attempt-entry-v1"||observed.providerEntered!==false||observed.runId!==prior.claim.runId||observed.generation!==prior.claim.generation||observed.attempt!==1
    ||!same(event.cumulative,{tokens:0,activeMs:0,attempts:1,sessions:1})||!same(record.accounting.work,event.cumulative))fail("saved-result-predecessor-invalid");
 }else if(life.stage!=="entered"||!state.savedResult.entry||!same(life.entry,state.savedResult.entry))fail("saved-result-predecessor-invalid");
 for(const k of ["groupId","workItemId","taskId","graphVersion","targetVersion"] as const)if(prior.claim[k]!==input.claim[k])fail("saved-result-predecessor-invalid");
 const {groupId,workItemId,taskId,runId,generation,graphVersion,targetVersion}=prior.claim;
 const accountingAdmission={...loaded.admission,source:{groupId,workItemId,taskId:taskId!,runId,generation,graphVersion,targetVersion,executionId:accepted.executionId,envelopeHash:accepted.envelopeHash},accounting:record.accounting};
 validateAccounting(accountingAdmission,prior,json(record.usage),ref=>{json(ref);return loaded.get(ref);},json,state.status);
 const priorPackage=savedResultPackageSchema.parse(json(record.package)),priorAdmission=savedResultAdmissionSchema.parse(json(record.admission));
 if(!same(priorPackage.source,loaded.manifest.source)||priorPackage.authorityKind!==loaded.manifest.authorityKind||record.package.hash!==prior.savedResultRecovery!.packageHash||record.admission.hash!==prior.savedResultRecovery!.admissionHash||!same(priorPackage.admission,record.admission)
  ||!same(priorAdmission.source,loaded.admission.source)||!same(priorAdmission.recoveryOf,input.savedResultRecovery!.recoveryOf)||priorAdmission.contractHash!==input.contractHash
  ||!same(priorAdmission.claim,{runId:prior.claim.runId,generation:prior.claim.generation,commandId:prior.claim.commandId,ownerToken:prior.claim.ownerToken,configHash:prior.claim.configHash})
  ||priorAdmission.currentRunId!==(priorAdmission.predecessor?.runId??priorAdmission.source.runId)||!same(state.savedResult.funding,priorAdmission.funding))fail("saved-result-predecessor-invalid");
 for(const entry of priorPackage.artifacts)loaded.get(entry.ref);
 const priorInherited=await validateInterruptedPredecessor(prior,{...loaded,manifest:priorPackage,admission:priorAdmission},baseInherited,depth+1);
 validateRecoveryFunding(prior,priorAdmission,loaded.json,priorInherited);
 return addWork(priorInherited,record.accounting.work);
}

const unavailableSchema=z.object({status:z.literal("unavailable"),reason:z.string().min(1)}).strict();
export const savedResultEligibilitySchema=z.union([unavailableSchema,z.object({status:z.literal("eligible"),authorityKind:savedResultPackageSchema.shape.authorityKind,normalizedExecutionHash:hash}).strict()]);
export const savedResultSourceEligibilitySchema=z.union([unavailableSchema,z.object({status:z.literal("eligible"),authorityKind:savedResultPackageSchema.shape.authorityKind,sourceIdentity:savedResultAdmissionSchema.shape.source,rawExecutionTokens:safe,recoveryOf:recoveryOfSchema,
 limitation:z.literal("published-candidate-only; current membership and settled accounting require controller admission")}).strict()]);

function addWork(a:z.infer<typeof amount>,b:z.infer<typeof amount>):z.infer<typeof amount>{
 const value={tokens:0,activeMs:0,attempts:0,sessions:0};for(const d of ["tokens","activeMs","attempts","sessions"] as const){value[d]=a[d]+b[d];if(!Number.isSafeInteger(value[d]))fail("saved-result-lineage-invalid");}return value;
}
function validateRecoveryFunding(input:LoopStartEnvelope,admission:SavedResultAdmission,json:(ref:ArtifactRefV1)=>any,inherited:z.infer<typeof amount>):void{
 const f=admission.funding,h=f.historicalPolicy,policy=recoveryPolicyAuthoritySchema.parse(json(h.authority));
 if(!same(policy,{schema:"ccloop-recovery-policy-authority-v1",groupId:admission.source.groupId,workItemId:admission.source.workItemId,taskId:admission.source.taskId,sourceRunId:admission.source.runId,
  contractHash:admission.contractHash,accountingMode:h.accountingMode,authoredWork:h.authoredWork})||h.contractHash!==admission.contractHash||!same(f.freshGrant,input.claim.grant)
  ||f.reservation.runId!==input.claim.runId||f.reservation.revision!==admission.revision||f.reservation.workAllocationId===f.reservation.handoffAllocationId)fail("saved-result-funding-invalid");
 if(!same(f.inheritedUsage,inherited))fail("saved-result-lineage-invalid");
 if(f.kind==="legacy-fresh-grant-v1"){if(input.tokenPolicy!==undefined)fail("saved-result-funding-invalid");}
 else if(!input.tokenPolicy||input.tokenPolicy.authoredTokenCeiling!==h.authoredWork.tokens||!same(input.tokenPolicy.inheritedUsage,inherited))fail("saved-result-funding-invalid");
 for(const d of ["tokens","activeMs","attempts","sessions"] as const){
  const fresh=f.freshGrant.work[d],authored=h.authoredWork[d];
  if(fresh===0)fail("saved-result-authored-budget-exhausted");
  const total=fresh===null?null:inherited[d]+fresh;
  if((total!==null&&!Number.isSafeInteger(total))||f.fundedTotal[d]!==total)fail("saved-result-funding-invalid");
  const remaining=authored===null?null:Math.max(0,authored-(f.kind==="optional-cumulative-v1"?inherited[d]:0));
  if(remaining===0)fail("saved-result-authored-budget-exhausted");
  if(remaining!==null&&(fresh===null||fresh>remaining))fail("saved-result-funding-invalid");
 }
}

export async function assertRestoredSavedCandidate(tree:string,loaded:LoadedSavedResult):Promise<void>{
 const expected=new Map(loaded.snapshot.tree.map(e=>[e.path,e]));
 if(((await lstat(tree)).mode&0o7777)!==0o700||(await savedGit(tree,"rev-parse","HEAD")).toString().trim()!==loaded.snapshot.head)fail("saved-result-modified-during-verification");
 const index=loaded.snapshot.index.map(e=>`${e.mode} ${e.oid} 0\t${e.path}\0`).join("");
 if((await savedGit(tree,"ls-files","--stage","-z")).toString()!==index)fail("saved-result-modified-during-verification");
 async function walk(dir:string,prefix=""):Promise<void>{for(const name of await readdir(dir)){
  if(!prefix&&name===".git")continue;const path=prefix?`${prefix}/${name}`:name,entry=expected.get(path),stat=await lstat(join(dir,name));expected.delete(path);
  if(!entry||stat.isSymbolicLink()||(stat.mode&0o7777)!==entry.mode)fail("saved-result-modified-during-verification");
  if(entry.kind==="directory"){if(!stat.isDirectory())fail("saved-result-modified-during-verification");await walk(join(dir,name),path);}
  else{if(!stat.isFile()||digest(await import("node:fs/promises").then(fs=>fs.readFile(join(dir,name))))!==entry.ref.hash)fail("saved-result-modified-during-verification");}
 }}
 await walk(tree);if(expected.size)fail("saved-result-modified-during-verification");
}
