import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {join,dirname} from "node:path";
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from "node:fs/promises";
import {canonicalHash,canonicalJson,isLoopEnvelope,type StartEnvelopeV3} from "../control/protocol.js";
import {ompWithoutFinalCandidatePath,ompWithoutFinalCandidateSchema,writeSavedBytes,readSavedBytes,type OmpWithoutFinalCandidate} from "../control/savedResultEvidence.js";
import {captureWorktreeSnapshot} from "./executionFormatFailure.js";
import {parseMaterializedAgentConfig,agentConfigHash} from "../agents/materialize.js";
import {loopContractSchema,type LoopContract} from "../contract/schema.js";
import {readTaskResultFile} from "../control/taskResultEvidence.js";
import {readUsageEvents,parseKnownWorkUsageLedger} from "../control/usage.js";
import {readEvidence} from "../control/evidence.js";
import {OmpStream} from "../runtime/omp/ompStream.js";
import {ompPhaseTools} from "../runtime/omp/phasePrompt.js";
import {foldText} from "../runtime/streamLines.js";
import {normalizeExecutionFinal,EXECUTION_NORMALIZER_VERSION} from "../runtime/executionNormalizer.js";
import {appendEvent} from "../persistence/fileStore.js";
import type {MaterializedAgentConfigV1} from "../agents/types.js";

const exec=promisify(execFile);
const git=async(cwd:string,...args:string[])=>(await exec('/usr/bin/git',['--no-replace-objects','-c','core.hooksPath=/dev/null',...args],{cwd,timeout:30000,maxBuffer:16*1024*1024})).stdout.trim();
const read=(source:string,path:string)=>readTaskResultFile(source,path,16*1024*1024);
export interface OmpWithoutFinalCaptureInput {
 input:StartEnvelopeV3;runDir:string;worktreePath:string;attempt:number;attemptStartHead:string;resolvedBase:string|null;
 runtimeContract:LoopContract;actualConfig:MaterializedAgentConfigV1;observedTokens:number;
 normalization:{reason:string;diagnostic:unknown};verifierEntered:boolean;assertHeld:()=>Promise<void>;
}
export async function captureOmpWithoutFinal(input:OmpWithoutFinalCaptureInput):Promise<void>{
 try{
  const {input:envelope,runDir,attempt}=input,source=envelope.work.sourceDir;
  if(!isLoopEnvelope(envelope)||runDir!==join(source,'run')||input.verifierEntered||input.resolvedBase===null||!Number.isSafeInteger(input.observedTokens)||input.observedTokens<=0
   ||input.runtimeContract.verification.commandChecksDecideGoal!==true||input.runtimeContract.verification.verifierType!=='command'
   ||input.runtimeContract.verification.requiredChecks.length===0||envelope.work.additionalRepos!==undefined||envelope.work.contract.context.additionalRepos!==undefined
   ||input.runtimeContract.context.additionalRepos!==undefined||input.runtimeContract.context.setupCommands!==undefined||envelope.work.contract.context.setupCommands!==undefined)throw Error('saved-result-decisive-checks-unavailable');
  await input.assertHeld();
  const config=parseMaterializedAgentConfig(JSON.parse((await read(source,join(source,'control/config.json'))).toString()));
  if(config.kind!=='omp'||agentConfigHash(config)!==envelope.claim.configHash||canonicalHash(config)!==canonicalHash(input.actualConfig))throw Error('saved-result-config-mismatch');
  const actual=loopContractSchema.parse(JSON.parse((await read(source,join(runDir,'loop-contract.json'))).toString()));
  const semantic=(c:LoopContract)=>{const {repoPath:_repo,...context}=c.context;const {tokenBudget:_t,maxAttempts:_a,totalRuntimeBudgetMs:_m,...executionPolicy}=c.executionPolicy;return {...c,context,executionPolicy};};
  if(canonicalHash(actual)!==canonicalHash(input.runtimeContract)||canonicalHash(semantic(actual))!==canonicalHash(semantic(envelope.work.contract)))throw Error('saved-result-runtime-contract-mismatch');
  if(await git(input.worktreePath,'rev-parse','HEAD')!==input.attemptStartHead)throw Error('saved-result-execute-head-changed');
  const calls=await readdir(join(runDir,'omp',String(attempt),'execute'));
  if(calls.length!==1)throw Error('saved-result-execute-call-ambiguous');
  const call=join(runDir,'omp',String(attempt),'execute',calls[0]!);
  const outcome=JSON.parse((await read(source,join(call,'outcome.json'))).toString());
  if(outcome.reason!=='completed'||outcome.code!==0||outcome.signal!==null||outcome.stdoutTruncated!==false||outcome.transcriptTruncatedAt!==null||outcome.transcriptError!==undefined||outcome.neverStarted!==false)throw Error('saved-result-process-incomplete');
  const expectedArgs=['--profile',config.installation.profile??'default','--no-extensions','--no-skills','--no-tools','--tools',ompPhaseTools('execute').join(','),'--no-session','--no-title','--no-prewalk','--model',config.selection.model,'--mode','json','-p','--system-prompt',join(call,'system-prompt.md'),'--cwd',input.worktreePath];
  if(outcome.executable!==config.installation.command[0]||canonicalHash(outcome.args)!==canonicalHash(expectedArgs))throw Error('saved-result-config-mismatch');
  const record=JSON.parse((await read(source,join(call,'process.json'))).toString());
  const registered=JSON.parse((await read(source,join(source,'control/processes.json'))).toString());
  if(record.phase!=='execute'||!Array.isArray(registered)||!registered.some(p=>p.phase==='execute'&&p.pid===record.pid&&p.pgid===record.pgid&&p.startedAt===record.startedAt)
   ||(await readdir(join(runDir,'omp',String(attempt)))).includes('verify'))throw Error('saved-result-process-authority-invalid');
  for(const p of registered){try{process.kill(-p.pgid,0);throw Error('saved-result-process-not-settled');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
  const events=(await read(source,join(call,'events.jsonl'))).toString();
  const stream=foldText(events,new OmpStream({phase:'execute',selector:config.selection.model,...(actual.executionPolicy.toolRules===undefined?{}:{toolRules:{rules:actual.executionPolicy.toolRules,requiredChecks:actual.verification.requiredChecks}})}));
  if(stream.toolRule?.value()!==null&&stream.toolRule!==null)throw Error('saved-result-tool-rule-violated');
  let decode:any;try{stream.phase!.value();throw Error('saved-result-execution-available');}catch(e){decode=e;}
  if(decode.message!=='omp-result-invalid'||decode.observedTokens!==input.observedTokens||canonicalHash(decode.formatNormalization)!==canonicalHash(input.normalization))throw Error('saved-result-original-evidence-mismatch');
  const rows=events.trim().split('\n').map(row=>JSON.parse(row));
  const assistant=rows.filter(row=>row.type==='message_end'&&row.message?.role==='assistant').at(-1)?.message;
  const final=assistant?.content?.filter((c:any)=>c.type==='text'&&typeof c.text==='string').map((c:any)=>c.text).join('');
  if(typeof final!=='string'||!final.trim())throw Error('saved-result-original-evidence-mismatch');
  const normalization=normalizeExecutionFinal(final);
  if(normalization.status!=='unavailable'||normalization.reason!==input.normalization.reason||canonicalHash(normalization.diagnostic)!==canonicalHash(input.normalization.diagnostic))throw Error('saved-result-normalizer-provenance-unavailable');
  const usageEvents=await readUsageEvents(source),last=usageEvents.at(-1);
  if(!last||last.bucket!=='work'||last.cumulative===null)throw Error('saved-result-usage-unavailable');
  const phase=JSON.parse((await readEvidence(source,last.source)).toString());
  if(phase.phase!=='execute'||phase.attempt!==attempt||phase.tokenUsage!==input.observedTokens||phase.completedWithResult!==false)throw Error('saved-result-usage-observation-mismatch');
  const ledger=await read(source,join(source,'control/usage.json'));
  parseKnownWorkUsageLedger(JSON.parse(ledger.toString()),{runId:envelope.claim.runId,generation:envelope.claim.generation,usageHighWater:last.eventSeq+1});
  const write=(bytes:Buffer)=>writeSavedBytes(source,bytes,input.assertHeld);
  const retain=(path:string)=>read(source,path).then(write);
  const observations=[];for(const event of usageEvents)observations.push({source:event.source,copy:await write(await readEvidence(source,event.source))});
  const proof=await write(Buffer.from(canonicalJson({schema:'ccloop-execution-verifier-not-entered-v1',runId:envelope.claim.runId,generation:envelope.claim.generation,attempt,entered:false,recordedBy:'controller-at-malformed-execute-failure'})));
  const artifacts={envelope:await retain(join(source,'control/envelope.json')),config:await retain(join(source,'control/config.json')),acceptedContract:await write(Buffer.from(canonicalJson(envelope.work.contract))),runtimeContract:await retain(join(runDir,'loop-contract.json')),
   plan:await retain(join(runDir,'attempts',String(attempt),'plan.json')),outcome:await retain(join(call,'outcome.json')),final:await write(Buffer.from(final)),events:await retain(join(call,'events.jsonl')),process:await retain(join(call,'process.json')),
   usageLedger:await write(ledger),owner:await retain(join(runDir,'owner-record.json')),usageObservations:observations};
  const snapshot=await captureWorktreeSnapshot({envelope,runDir,worktreePath:input.worktreePath,attempt,assertHeld:input.assertHeld});
  // Git's real index is left intact while the tree to publish is measured in a temporary index.
  const scratch=await mkdtemp(join(runDir,'saved-result','tree-'));
  let worktreeTree:string;
  try{const env={...process.env,GIT_INDEX_FILE:join(scratch,'index')};await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','add','-A'],{cwd:input.worktreePath,env});worktreeTree=(await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','write-tree'],{cwd:input.worktreePath,env})).stdout.trim();}
  finally{await rm(scratch,{recursive:true,force:true});}
  if(await git(input.worktreePath,'rev-parse','HEAD')!==input.attemptStartHead)throw Error('saved-result-execute-head-changed');
  const candidate:OmpWithoutFinalCandidate=ompWithoutFinalCandidateSchema.parse({schema:'ccloop-execution-without-final-candidate-v1',runId:envelope.claim.runId,generation:envelope.claim.generation,attempt,
   executor:{kind:'omp',configHash:envelope.claim.configHash},frozenContractHash:envelope.contractHash,gate:{stage:'execute-format',decision:'malformed-final'},
   attemptStartHead:input.attemptStartHead,resolvedBase:input.resolvedBase,worktreeTree,decoder:EXECUTION_NORMALIZER_VERSION,
   normalization:{reason:normalization.reason,diagnostic:normalization.diagnostic},usage:{tokenUsage:input.observedTokens,highWater:last.eventSeq},process:{reason:'completed',code:0,signal:null,isolated:true},
   verifier:{entered:false,proof},artifacts,snapshot,published:null,capturedAt:new Date().toISOString()});
  await input.assertHeld();
  await writeFile(ompWithoutFinalCandidatePath(runDir),Buffer.from(canonicalJson(candidate)),{mode:0o600});
 }catch(error){await input.assertHeld();await appendEvent(input.runDir,{type:'execution_without_final_capture_failed',at:new Date().toISOString(),detail:String(error)}).catch(()=>undefined);}
}

export async function bindOmpWithoutFinal(runDir:string,published:{sha:string;base:string;ref:string},assertHeld:()=>Promise<void>):Promise<void>{
 let candidate:OmpWithoutFinalCandidate;
 try{candidate=ompWithoutFinalCandidateSchema.parse(JSON.parse(await readFile(ompWithoutFinalCandidatePath(runDir),'utf8')));}catch{return;}
 if(candidate.published!==null)return;
 const tree=join(runDir,'worktrees',`attempt-${candidate.attempt}`),source=dirname(runDir);
 try{
  await assertHeld();
  const claimRef=`refs/ccloop/${candidate.runId}/attempts/${candidate.attempt}`;
  if(published.base!==candidate.attemptStartHead||await git(tree,'rev-parse',claimRef)!==published.sha
   ||await git(tree,'rev-parse',`${published.sha}^{tree}`)!==candidate.worktreeTree
   ||await git(tree,'rev-parse',`${published.sha}^`)!==candidate.attemptStartHead)throw Error('saved-result-publication-unproven');
  const scratch=await mkdtemp(join(runDir,'saved-result','attempt-'));
  let bundle:Buffer;
  try{const path=join(scratch,'attempt.bundle');await git(tree,'bundle','create',path,claimRef);bundle=await readFile(path);}finally{await rm(scratch,{recursive:true,force:true});}
  const snapshot=JSON.parse((await readSavedBytes(source,candidate.snapshot)).toString());
  const ref=await writeSavedBytes(source,bundle,assertHeld);
  const next={...candidate,published:{...published,ref:claimRef},snapshot:await writeSavedBytes(source,Buffer.from(canonicalJson({...snapshot,bundle:ref})),assertHeld)};
  await assertHeld();await writeFile(ompWithoutFinalCandidatePath(runDir),Buffer.from(canonicalJson(next)),{mode:0o600});
 }catch(error){await assertHeld();await appendEvent(runDir,{type:'execution_without_final_capture_failed',at:new Date().toISOString(),detail:String(error)}).catch(()=>undefined);}
}

export async function finalizeOmpWithoutFinal(runDir:string,highWater:number,assertHeld:()=>Promise<void>):Promise<void>{
 let candidate:OmpWithoutFinalCandidate;
 try{candidate=ompWithoutFinalCandidateSchema.parse(JSON.parse(await readFile(ompWithoutFinalCandidatePath(runDir),'utf8')));}catch{return;}
 if(candidate.published===null||candidate.usage.highWater+1!==highWater)return;
 const source=dirname(runDir),events=await readUsageEvents(source),last=events.at(-1);
 if(events.length!==highWater||last?.eventSeq!==highWater||last.bucket!=='handoff'||last.cumulative===null)return;
 const prior=candidate.artifacts.usageObservations??[];
 if(prior.length!==highWater-1||prior.some((entry,i)=>entry.source.hash!==events[i]?.source.hash))return;
 const copy=await writeSavedBytes(source,await readEvidence(source,last.source),assertHeld);
 const ledger=await writeSavedBytes(source,await read(source,join(source,'control/usage.json')),assertHeld);
 await assertHeld();await writeFile(ompWithoutFinalCandidatePath(runDir),Buffer.from(canonicalJson({...candidate,usage:{...candidate.usage,highWater},artifacts:{...candidate.artifacts,usageLedger:ledger,usageObservations:[...prior,{source:last.source,copy}]}})),{mode:0o600});
}
