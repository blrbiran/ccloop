import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {lstat,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {z} from "zod";
import {canonicalHash,canonicalJson,isLoopEnvelope,type ArtifactRefV1,type StartEnvelopeV3} from "../control/protocol.js";
import {readEvidence} from "../control/evidence.js";
import {parseKnownWorkUsageLedger,readUsageEvents} from "../control/usage.js";
import {readTaskResultFile} from "../control/taskResultEvidence.js";import {writeSavedBytes,exhaustedCandidatePath,type ExhaustedCandidate} from "../control/savedResultEvidence.js";
import {captureWorktreeSnapshot} from "./executionFormatFailure.js";
import {parseMaterializedAgentConfig,agentConfigHash} from "../agents/materialize.js";
import type {MaterializedAgentConfigV1} from "../agents/types.js";
import {normalizeExecutionFinal,EXECUTION_NORMALIZER_VERSION} from "../runtime/executionNormalizer.js";
import {decodeCodexResult,decodeCodexUsage,codexModelUsage} from "../runtime/codex/protocol.js";
import {loopContractSchema,type LoopContract} from "../contract/schema.js";
import {appendEvent} from "../persistence/fileStore.js";
import {codexSkillsPendingPath} from "../runtime/codex/codexSkills.js";

const exec=promisify(execFile);
const git=async(cwd:string,...args:string[])=>(await exec("/usr/bin/git",["-c","core.hooksPath=/dev/null",...args],{cwd,maxBuffer:16*1024*1024,timeout:30000})).stdout.trim();
const read=(root:string,path:string)=>readTaskResultFile(root,path,16*1024*1024);
const missing=async(path:string)=>{try{await lstat(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return true;throw e;}};
const processSchema=z.object({pid:z.number().int().positive(),pgid:z.number().int().positive(),startedAt:z.string().min(1),phase:z.literal("execute")}).strict();
const digest=(b:Buffer)=>createHash("sha256").update(b).digest("hex");

export interface ExhaustedCaptureInput {
  input:StartEnvelopeV3;runDir:string;worktreePath:string;attempt:number;attemptStartHead:string;resolvedBase:string|null;
  runtimeContract:LoopContract;actualConfig:MaterializedAgentConfigV1;
  /** The execution the attempt adapter already decoded from this call; the capsule binds it by hash. */
  execution:unknown;
  planPath:string;
  assertHeld:()=>Promise<void>;
}

async function writeCandidate(runDir:string,candidate:ExhaustedCandidate):Promise<void>{
  const path=exhaustedCandidatePath(runDir);
  await writeFile(path,Buffer.from(canonicalJson(candidate)),{mode:0o600});
}

/** One directory, or the refusal says which of the two facts is missing. */
async function onlyCall(root:string):Promise<string>{
  let names:string[];try{names=await readdir(root);}catch{throw new Error("saved-result-execute-call-ambiguous");}
  if(names.length!==1)throw new Error("saved-result-execute-call-ambiguous");
  return join(root,names[0]!);
}
function completedProcess(outcome:any,label:string):void {
  if(outcome.reason!=="completed"||outcome.code!==0||outcome.signal!==null||outcome.ioError!==undefined
    ||outcome.stdoutTruncated!==false||(label==="codex"&&outcome.stderrTruncated!==false)||(label==="codex"&&outcome.finalTruncated!==false))throw new Error("saved-result-process-incomplete");
}

/**
 * The post-execute budget gate's pre-cleanup capture. It runs only when the provider finished normally and the adapter
 * already produced a strict execution result; the published commit is bound later, by the cleanup that publishes it.
 */
export async function captureExhaustedCompletion(input:ExhaustedCaptureInput):Promise<ArtifactRefV1|null>{
  try{
    const {input:envelope,attempt}=input,source=envelope.work.sourceDir;
    if(!isLoopEnvelope(envelope)||input.runDir!==join(source,"run")||input.resolvedBase===null)throw new Error("saved-result-capture-authority-invalid");
    await input.assertHeld();
    const config=parseMaterializedAgentConfig(JSON.parse((await read(source,join(source,"control","config.json"))).toString()));
    if(agentConfigHash(config)!==envelope.claim.configHash||canonicalHash(config)!==canonicalHash(input.actualConfig))throw new Error("saved-result-config-mismatch");
    if(await missing(join(input.runDir,config.kind,String(attempt),"verify"))){/* still absent: not entered */}else throw new Error("saved-result-verification-already-entered");
    const call=await onlyCall(join(input.runDir,config.kind,String(attempt),"execute"));
    const json=async(path:string)=>JSON.parse((await read(source,path)).toString());
    const outcome=await json(join(call,"outcome.json"));
    completedProcess(outcome,config.kind);
    const processRecord=processSchema.parse(await json(join(call,"process.json")));
    const registered=z.array(processSchema.omit({phase:true}).extend({phase:z.string(),registeredAt:z.string()}).strict()).parse(await json(join(source,"control","processes.json")));
    if(!registered.some(p=>p.pid===processRecord.pid&&p.pgid===processRecord.pgid&&p.startedAt===processRecord.startedAt&&p.phase==="execute"))throw new Error("saved-result-process-authority-invalid");
    for(const p of registered){let quiet=false;try{process.kill(-p.pgid,0);}catch(e){if((e as NodeJS.ErrnoException).code==="ESRCH")quiet=true;}if(!quiet)throw new Error("saved-result-process-not-settled");}
    const final=(await read(source,join(call,"final.json"))).toString(),events=(await read(source,join(call,"events.jsonl"))).toString();
    const normalization=normalizeExecutionFinal(final);
    const {tokenUsage:_execTokens,usageEvidence:_execEvidence,modelUsage:_execModels,...executionCore}=input.execution as Record<string,unknown>;
    if(normalization.status!=="available"||canonicalHash(normalization.execution)!==canonicalHash(executionCore))throw new Error("saved-result-execution-normalization-mismatch");
    if(!await missing(codexSkillsPendingPath(input.worktreePath)))throw new Error("saved-result-skills-cleanup-incomplete");
    const plan=await json(input.planPath);
    if(config.kind==="codex"){
      const planCall=await onlyCall(join(input.runDir,"codex",String(attempt),"plan"));
      const decoded=decodeCodexResult("plan",(await read(source,join(planCall,"events.jsonl"))).toString(),(await read(source,join(planCall,"final.json"))).toString()) as Record<string,unknown>;
      const {tokenUsage:_dt,usageEvidence:_du,modelUsage:_dm,...decodedCore}=decoded;
      const {tokenUsage:_t,usageEvidence:_u,modelUsage:_m,...core}=plan;
      if(canonicalHash(decodedCore)!==canonicalHash(core))throw new Error("saved-result-plan-mismatch");
    }
    const usageEvents=await readUsageEvents(source),last=usageEvents.at(-1);
    if(!last||last.bucket!=="work")throw new Error("saved-result-usage-unavailable");
    const phase=JSON.parse((await readEvidence(source,last.source)).toString());
    if(phase.phase!=="execute"||phase.attempt!==attempt)throw new Error("saved-result-usage-observation-mismatch");
    // This execute call's own tokens: the number the legacy reader calls the raw execution total.
    const tokenUsage=typeof phase.tokenUsage==="number"?phase.tokenUsage:null;
    const ledger=await read(source,join(source,"control","usage.json"));
    if(tokenUsage!==null)parseKnownWorkUsageLedger(JSON.parse(ledger.toString()),{runId:envelope.claim.runId,generation:envelope.claim.generation,usageHighWater:last.eventSeq+1});
    const observations=[];for(const event of usageEvents)observations.push({source:event.source,copy:await writeSavedBytes(source,await readEvidence(source,event.source),input.assertHeld)});
    const write=(bytes:Buffer)=>writeSavedBytes(source,bytes,input.assertHeld);
    const owner=await read(source,join(input.runDir,"owner-record.json"));
    const verifierProof=await write(Buffer.from(canonicalJson({schema:"ccloop-execution-verifier-not-entered-v1",runId:envelope.claim.runId,generation:envelope.claim.generation,attempt,entered:false,recordedBy:"controller-at-the-post-execute-budget-gate"})));
    const artifacts:Record<string,unknown>={};
    const retain=async(path:string,key:string)=>{artifacts[key]=await write(await read(source,path));};
    await retain(join(source,"control","envelope.json"),"envelope");
    await retain(join(source,"control","config.json"),"config");
    artifacts.acceptedContract=await write(Buffer.from(canonicalJson(envelope.work.contract)));
    await retain(join(input.runDir,"loop-contract.json"),"runtimeContract");
    await retain(input.planPath,"plan");
    await retain(join(call,"outcome.json"),"outcome");
    await retain(join(call,"final.json"),"final");
    await retain(join(call,"events.jsonl"),"events");
    await retain(join(call,"process.json"),"process");
    if(config.kind==="codex")await retain(join(call,"schema.json"),"schema");
    for(const name of ["usage.json","usage-lower-bound.json"])if(!await missing(join(call,name)))await retain(join(call,name),name.replace(".json","").replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase()));
    artifacts.usageLedger=await write(ledger);
    artifacts.owner=await write(owner);
    artifacts.usageObservations=observations;
    const snapshot=await captureWorktreeSnapshot({envelope,runDir:input.runDir,worktreePath:input.worktreePath,attempt,assertHeld:input.assertHeld});
    // The tree `git add -A` would commit: a temporary index, so the attempt's own index is untouched.
    const scratch=await mkdtemp(join(source,"run","saved-result","tree-"));
    let tree:string;
    try{
      const tmp=join(scratch,"index");
      await exec("/usr/bin/git",["-c","core.hooksPath=/dev/null","add","-A"],{cwd:input.worktreePath,encoding:"buffer",env:{...process.env,GIT_INDEX_FILE:tmp},maxBuffer:16*1024*1024});
      tree=(await exec("/usr/bin/git",["-c","core.hooksPath=/dev/null","write-tree"],{cwd:input.worktreePath,encoding:"utf8",env:{...process.env,GIT_INDEX_FILE:tmp},maxBuffer:16*1024*1024})).stdout.trim();
    }finally{await rm(scratch,{recursive:true,force:true});}
    const candidate:ExhaustedCandidate={
      schema:"ccloop-execution-complete-before-verification-candidate-v1",
      runId:envelope.claim.runId,generation:envelope.claim.generation,attempt,
      executor:{kind:config.kind==="codex"?"codex":"omp",configHash:envelope.claim.configHash},
      frozenContractHash:envelope.contractHash,
      gate:{stage:"post-execute",decision:"budget-exceeded"},
      attemptStartHead:input.attemptStartHead,resolvedBase:input.resolvedBase,worktreeTree:tree,
      decoder:EXECUTION_NORMALIZER_VERSION,normalizedExecutionHash:canonicalHash(normalization.execution),
      usage:{tokenUsage,highWater:last.eventSeq},
      process:{reason:"completed",code:0,signal:null,isolated:true},
      verifier:{entered:false,proof:verifierProof},
      artifacts:artifacts as ExhaustedCandidate["artifacts"],snapshot,
      published:null,
      capturedAt:new Date().toISOString(),
    };
    await writeCandidate(input.runDir,candidate);
    await input.assertHeld();
    return verifierProof;
  }catch(error){
    try{
      await input.assertHeld();
      await appendEvent(input.runDir,{type:"execution_complete_capture_failed",at:new Date().toISOString(),detail:`attempt ${input.attempt}: ${String(error)}`}).catch(()=>undefined);
      await mkdir(join(input.runDir,"saved-result"),{recursive:true,mode:0o700});
      await writeFile(join(input.runDir,"saved-result","exhausted-candidate-unavailable.json"),JSON.stringify({attempt:input.attempt,reason:error instanceof Error&&error.message.startsWith("saved-result-")?error.message:"saved-result-capture-failed"}),{mode:0o600}).catch(()=>undefined);
    }catch{/* the run's own outcome is unchanged */}
    return null;
  }
}

/** The cleanup has published exactly one attempt commit; bind it to the capture it was made from. */
export async function bindExhaustedCandidate(runDir:string,published:{sha:string;base:string;ref:string}):Promise<void>{
  const path=exhaustedCandidatePath(runDir);
  let bytes:Buffer;try{bytes=await readFile(path);}catch{return;}
  const candidate=JSON.parse(bytes.toString()) as ExhaustedCandidate;
  if(candidate.published!==null)return;
  await writeFile(path,Buffer.from(canonicalJson({...candidate,published})),{mode:0o600});
}

/** A hash of the bytes a caller can re-derive; used only in diagnostics. */
export const candidateDigest=(candidate:ExhaustedCandidate):string=>digest(Buffer.from(canonicalJson(candidate)));
