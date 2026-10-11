import type { LoopContract } from "../contract/schema.js";
import type { MaterializedAgentConfigV1 } from "../agents/types.js";
import { loopContractSchema } from "../contract/schema.js";
import { agentConfigHash, parseMaterializedAgentConfig } from "../agents/materialize.js";
import { ExecutionFormatFailure } from "../runtime/executionNormalizer.js";
export { ExecutionFormatFailure } from "../runtime/executionNormalizer.js";
import { execFile } from "node:child_process";
import { lstat, readdir, mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { appendEvent } from "../persistence/fileStore.js";
import { canonicalHash, canonicalJson, isLoopEnvelope, type ArtifactRefV1, type StartEnvelopeV3 } from "../control/protocol.js";
import { readEvidence } from "../control/evidence.js";
import { parseKnownWorkUsageLedger, readUsageEvents } from "../control/usage.js";
import { publishTaskResultIndex, readTaskResultFile, safeTaskResultPath } from "../control/taskResultEvidence.js";
import { executionFormatFailureSchema, executionSnapshotSchema, savedResultIdentity, savedResultIndexPath, writeSavedBytes } from "../control/savedResultEvidence.js";
import { decodeCodexResult, decodeCodexUsage, codexModelUsage } from "../runtime/codex/protocol.js";
import { normalizeExecutionFinal, EXECUTION_NORMALIZER_VERSION } from "../runtime/executionNormalizer.js";
import { codexSkillsPendingPath } from "../runtime/codex/codexSkills.js";

const exec=promisify(execFile);
const git=async(cwd:string,...args:string[])=>(await exec("/usr/bin/git",["-c","core.hooksPath=/dev/null",...args],{cwd,maxBuffer:16*1024*1024,timeout:30000})).stdout.trim();
const read=(root:string,path:string)=>readTaskResultFile(root,path,16*1024*1024);
/** A checkpoint proves its restored HEAD, not a former symbolic target's value. */
export async function resolveCheckpointOriginalBase(acceptedBase:string,worktreePath:string,restoredHead:string):Promise<string|null>{
  if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(acceptedBase))return null;
  try {
    if(await git(worktreePath,"--no-replace-objects","cat-file","-t",acceptedBase)!=="commit")return null;
    await git(worktreePath,"--no-replace-objects","merge-base","--is-ancestor",acceptedBase,restoredHead);
    return acceptedBase;
  } catch {return null;}
}

const missing=async(path:string)=>{try{await lstat(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return true;throw e;}};
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const processSchema=z.object({pid:positive,pgid:positive,startedAt:z.string().min(1),phase:z.literal("execute")}).strict();
export interface ExecutionFormatCaptureInput {
  input:StartEnvelopeV3;runDir:string;worktreePath:string;attempt:number;attemptStartHead:string;resolvedBase:string|null;
  runtimeContract:LoopContract;actualConfig:MaterializedAgentConfigV1;
  failure:ExecutionFormatFailure;verifierEntered:boolean;assertHeld:()=>Promise<void>;
}
function supportedMode(mode:number):number {
  if ((mode & 0o7000) !== 0) throw new Error("saved-result-mode-unsupported");
  return mode & 0o777;
}
async function snapshot(input:ExecutionFormatCaptureInput):Promise<ArtifactRefV1>{
  const {worktreePath:tree}=input,source=input.input.work.sourceDir;
  const write=(bytes:Buffer)=>writeSavedBytes(source,bytes,input.assertHeld);
  if(!await missing(codexSkillsPendingPath(tree)))throw new Error("saved-result-skills-cleanup-incomplete");
  const rootMode=supportedMode((await lstat(tree)).mode);
  const head=await git(tree,"rev-parse","HEAD");
  const indexPath=await realpath(resolve(tree,await git(tree,"rev-parse","--git-path","index")));
  const indexBytes=await read(dirname(indexPath),indexPath);
  const index=await write(indexBytes);
  if((await git(tree,"ls-files","--stage")).split("\n").some(row=>row.startsWith("160000 ")))throw new Error("saved-result-submodule-unavailable");
  const directories:Array<{path:string;mode:number}>=[];
  const files:Array<{path:string;kind:"file";mode:number;ref:ArtifactRefV1}>=[];
  const walk=async(directory:string)=>{
    for(const name of (await readdir(join(tree,directory))).sort()){
      if(name===".git") {if(directory!=="")throw new Error("saved-result-nested-repository-unavailable");continue;}
      const path=directory?`${directory}/${name}`:name;
      if(!safeTaskResultPath(path))throw new Error("saved-result-snapshot-path-invalid");
      const stat=await lstat(join(tree,path)),mode=supportedMode(stat.mode);
      if(stat.isDirectory()){
        if(directories.length>=10000)throw new Error("saved-result-snapshot-too-large");
        directories.push({path,mode});await walk(path);
      }
      else {
        if(!stat.isFile())throw new Error("saved-result-snapshot-entry-unsupported");
        if(files.length>=10000)throw new Error("saved-result-snapshot-too-large");
        files.push({path,kind:"file",mode,ref:await write(await read(tree,join(tree,path)))});
      }
    }
  };
  await walk("");files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const statusBytes=(await exec("/usr/bin/git",["status","--porcelain=v1","-z","--untracked-files=all"],{cwd:tree,encoding:"buffer",maxBuffer:16*1024*1024})).stdout;
  const deleted=(await exec("/usr/bin/git",["diff","HEAD","--name-only","--diff-filter=D","-z"],{cwd:tree,maxBuffer:16*1024*1024})).stdout.split("\0").filter(Boolean);
  const scratchParent=join(source,"run","saved-result");
  // The evidence writer creates this private directory before temporary bundle construction.
  await publishTaskResultIndex(source,join(scratchParent,"capture-started.json"),Buffer.from(JSON.stringify({attempt:input.attempt})),input.assertHeld);
  const scratch=await mkdtemp(join(scratchParent,"snapshot-"));
  try {
    const repo=join(scratch,"repo");
    await git(tree,"clone","--local","--no-hardlinks","--no-checkout",tree,repo);
    await writeFile(join(repo,".git","index"),indexBytes,{mode:0o600});
    const indexTree=await git(repo,"write-tree");
    const indexCommit=await git(repo,"-c","user.name=ccloop","-c","user.email=ccloop@invalid","commit-tree",indexTree,"-p",head,"-m","saved execution index");
    const bundleRefName=`refs/ccloop/${input.input.claim.runId}/saved-result/${input.attempt}`;
    await git(repo,"update-ref",bundleRefName,indexCommit);
    const bundlePath=join(scratch,"snapshot.bundle");
    await git(repo,"bundle","create",bundlePath,bundleRefName);
    const bundle=await write(await read(source,bundlePath)),status=await write(statusBytes);
    if(head!==await git(tree,"rev-parse","HEAD")||!(await read(dirname(indexPath),indexPath)).equals(indexBytes))throw new Error("saved-result-snapshot-changed");
    if(supportedMode((await lstat(tree)).mode)!==rootMode)throw new Error("saved-result-snapshot-changed");
    const captured=[...files],capturedDirectories=[...directories];files.length=0;directories.length=0;await walk("");files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    if(supportedMode((await lstat(tree)).mode)!==rootMode||canonicalHash(captured)!==canonicalHash(files)||canonicalHash(capturedDirectories)!==canonicalHash(directories))throw new Error("saved-result-snapshot-changed");
    await input.assertHeld();
    return await write(Buffer.from(canonicalJson(executionSnapshotSchema.parse({schema:"ccloop-execution-snapshot-v1",head,indexTree,indexCommit,bundleRefName,index,bundle,status,files,directories,deleted,rootMode}))));
  } finally {await rm(scratch,{recursive:true,force:true});}
}
async function capture(input:ExecutionFormatCaptureInput):Promise<ArtifactRefV1>{
  const {input:envelope,failure}=input,source=envelope.work.sourceDir;
  if(!isLoopEnvelope(envelope)||input.runDir!==join(source,"run")||input.verifierEntered||!positive.safeParse(input.attempt).success)throw new Error("saved-result-capture-authority-invalid");
  await input.assertHeld();
  if(input.resolvedBase===null)throw new Error("saved-result-original-base-unavailable");
  const identity=await savedResultIdentity(envelope),write=(bytes:Buffer)=>writeSavedBytes(source,bytes,input.assertHeld);
  const retain=(path:string)=>read(source,path).then(write);
  const json=async(path:string)=>JSON.parse((await read(source,path)).toString());
  const callRoot=join(input.runDir,"codex",String(input.attempt),"execute");
  const calls=await readdir(callRoot);
  if(calls.length!==1||join(callRoot,calls[0]!)!==failure.evidenceDir)throw new Error("saved-result-execute-call-ambiguous");
  const call=failure.evidenceDir,outcome=await json(join(call,"outcome.json"));
  if(outcome.reason!=="completed"||outcome.code!==0||outcome.signal!==null||outcome.ioError!==undefined||outcome.stdoutTruncated!==false||outcome.stderrTruncated!==false||outcome.finalTruncated!==false)throw new Error("saved-result-process-incomplete");
  const processRecord=processSchema.parse(await json(join(call,"process.json")));
  const registered=z.array(processSchema.omit({phase:true}).extend({phase:z.string(),registeredAt:z.string()}).strict()).parse(await json(join(source,"control","processes.json")));
  if(!registered.some(p=>p.pid===processRecord.pid&&p.pgid===processRecord.pgid&&p.startedAt===processRecord.startedAt&&p.phase==="execute")||!await missing(join(input.runDir,"codex",String(input.attempt),"verify")))throw new Error("saved-result-process-authority-invalid");
  for(const p of registered){
    let quiet=false;try{process.kill(-p.pgid,0);}catch(e){if((e as NodeJS.ErrnoException).code==="ESRCH")quiet=true;}
    if(!quiet)throw new Error("saved-result-process-not-settled");
  }
  const config=parseMaterializedAgentConfig(await json(join(source,"control","config.json")));
  if(config.kind!=="codex"||agentConfigHash(config)!==envelope.claim.configHash||canonicalHash(config)!==canonicalHash(input.actualConfig))throw new Error("saved-result-config-mismatch");
  const originalEvents=(await read(source,join(call,"events.jsonl"))).toString(),originalFinal=(await read(source,join(call,"final.json"))).toString();
  const usage=decodeCodexUsage(originalEvents,true),normalization=normalizeExecutionFinal(originalFinal);
  if(normalization.status!=="unavailable"||canonicalHash(normalization)!==canonicalHash(failure.normalization)||usage.tokenUsage!==failure.observedTokens||canonicalHash(usage.usageEvidence)!==canonicalHash(failure.usageEvidence)||canonicalHash(codexModelUsage(originalEvents,config.selection.model))!==canonicalHash(failure.modelUsage??null))throw new Error("saved-result-original-evidence-mismatch");
  if(canonicalHash(await json(join(source,"control","envelope.json")))!==identity.envelopeHash)throw new Error("saved-result-envelope-mismatch");
  const actual=loopContractSchema.parse(await json(join(input.runDir,"loop-contract.json")));
  const semantic=(contract:typeof actual)=>{const {repoPath:_repo,...context}=contract.context;const {tokenBudget:_tokens,maxAttempts:_attempts,totalRuntimeBudgetMs:_time,...executionPolicy}=contract.executionPolicy;return {...contract,context,executionPolicy};};
  if(canonicalHash(actual)!==canonicalHash(input.runtimeContract)||canonicalHash(semantic(actual))!==canonicalHash(semantic(envelope.work.contract))
    ||actual.executionPolicy.maxAttempts>envelope.work.contract.executionPolicy.maxAttempts
    ||actual.executionPolicy.totalRuntimeBudgetMs>envelope.work.contract.executionPolicy.totalRuntimeBudgetMs
    ||(envelope.work.contract.executionPolicy.tokenBudget!==null&&(actual.executionPolicy.tokenBudget===null||actual.executionPolicy.tokenBudget>envelope.work.contract.executionPolicy.tokenBudget)))throw new Error("saved-result-runtime-contract-mismatch");
  const planPath=join(input.runDir,"attempts",String(input.attempt),"plan.json"),plan=await json(planPath);
  // Saved plan is controller-owned decoded output; strict core validation ignores only measured usage fields.
  const {tokenUsage:_tokens,usageEvidence:_usage,modelUsage:_models,...planCore}=plan;
  decodeCodexResult("plan",originalEvents,JSON.stringify(planCore));
  const usageEvents=await readUsageEvents(source),last=usageEvents.at(-1);
  if(!last||last.cumulative===null||last.bucket!=="work")throw new Error("saved-result-usage-unavailable");
  const ledger=await read(source,join(source,"control","usage.json"));
  parseKnownWorkUsageLedger(JSON.parse(ledger.toString()),{runId:envelope.claim.runId,generation:envelope.claim.generation,usageHighWater:last.eventSeq+1});
  const observations=[];
  for(const event of usageEvents)observations.push({source:event.source,copy:await write(await readEvidence(source,event.source))});
  const lastObservation=JSON.parse((await readEvidence(source,last.source)).toString());
  if(lastObservation.phase!=="execute"||lastObservation.attempt!==input.attempt||lastObservation.tokenUsage!==usage.tokenUsage||lastObservation.completedWithResult!==false)throw new Error("saved-result-usage-observation-mismatch");
  const owner=await json(join(input.runDir,"owner-record.json"));
  const proof=await write(Buffer.from(canonicalJson({schema:"ccloop-execution-verifier-not-entered-v1",identity,attempt:input.attempt,entered:false,recordedBy:"controller-before-execution-failure-cleanup"})));
  const artifacts={envelope:await retain(join(source,"control","envelope.json")),config:await retain(join(source,"control","config.json")),acceptedContract:await write(Buffer.from(canonicalJson(envelope.work.contract))),runtimeContract:await retain(join(input.runDir,"loop-contract.json")),final:await retain(join(call,"final.json")),events:await retain(join(call,"events.jsonl")),schema:await retain(join(call,"schema.json")),decodeError:await retain(join(call,"decode-error.txt")),normalization:await retain(join(call,"execution-normalization.json")),outcome:await retain(join(call,"outcome.json")),process:await retain(join(call,"process.json")),plan:await retain(planPath),usage:await retain(join(call,"usage.json")),usageLedger:await write(ledger),usageObservations:observations,owner:await retain(join(input.runDir,"owner-record.json"))};
  const snapshotRef=await snapshot(input);
  const capsule=executionFormatFailureSchema.parse({schema:"ccloop-execution-format-failure-v1",identity,attempt:input.attempt,executor:{kind:"codex",configHash:envelope.claim.configHash},frozenContractHash:envelope.contractHash,acceptedBase:envelope.work.base,resolvedBase:input.resolvedBase,attemptStartHead:input.attemptStartHead,decoder:EXECUTION_NORMALIZER_VERSION,classification:"execution-format-failure-v1",process:{reason:"completed",code:0,signal:null,isolated:true},usage:{tokenUsage:usage.tokenUsage,highWater:last.eventSeq},verifier:{entered:false,proof},artifacts,snapshot:snapshotRef,completeness:{complete:true,parts:["original-process","original-stream","actual-usage","successful-plan","verifier-not-entered","tree-index-bundle-files"]},capturedAt:new Date().toISOString(),captureOwner:canonicalHash(owner)});
  const capsuleRef=await write(Buffer.from(canonicalJson(capsule)));
  await input.assertHeld();
  await publishTaskResultIndex(source,savedResultIndexPath(source),Buffer.from(canonicalJson({schema:"ccloop-saved-result-evidence-v1",identity,attempt:input.attempt,capsule:capsuleRef,reason:null})),input.assertHeld);
  return capsuleRef;
}
/** Capture failures do not turn the original execution into success or authorize incomplete recovery. */
export async function captureExecutionFormatFailure(input:ExecutionFormatCaptureInput):Promise<ArtifactRefV1|null>{
  try{return await capture(input);}catch(error){
    await input.assertHeld();
    await appendEvent(input.runDir,{type:"execution_format_capture_failed",at:new Date().toISOString(),detail:`attempt ${input.attempt}: ${String(error)}`}).catch(()=>undefined);
    const identity=await savedResultIdentity(input.input);
    await publishTaskResultIndex(input.input.work.sourceDir,savedResultIndexPath(input.input.work.sourceDir),Buffer.from(canonicalJson({schema:"ccloop-saved-result-evidence-v1",identity,attempt:input.attempt,capsule:null,reason:error instanceof Error && error.message.startsWith("saved-result-")?error.message:"saved-result-capture-failed"})),input.assertHeld).catch(async()=>{await input.assertHeld();});
    return null;
  }
}
