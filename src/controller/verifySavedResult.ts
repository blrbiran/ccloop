import {z} from "zod";
import {StringDecoder} from "node:string_decoder";
import {testCrashPoint} from "../control/testCrashPoint.js";
import {createHash} from "node:crypto";
import {lstat,readdir,readFile,mkdir,realpath} from "node:fs/promises";
import {join,dirname,resolve} from "node:path";
import {canonicalHash,canonicalJson,type LoopStartEnvelope} from "../control/protocol.js";
import {atomicReplacePrivateFile,readPrivateFile} from "../control/paths.js";
import {loadSavedResultRecovery,assertSavedResultFence,assertRestoredSavedCandidate,savedGit,type LoadedSavedResult} from "../control/savedResultRecovery.js";
import {reapRunProcesses} from "../ownership/reapRunProcesses.js";
import type {RunState} from "../state/types.js";
import type {VerificationResult} from "../runtime/types.js";
import {verificationSchema} from "../runtime/codex/protocol.js";

const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
export async function candidateFingerprint(tree:string):Promise<string>{
 if(await realpath(tree)!==tree)throw Error("saved-result-modified-during-verification");
 const entries:unknown[]=[];
 async function walk(path:string,prefix:string):Promise<void>{
  const stat=await lstat(path);if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.mode&0o7000)!==0)throw Error("saved-result-modified-during-verification");
  entries.push({path:prefix,mode:stat.mode&0o7777,kind:stat.isDirectory()?"directory":"file",...(stat.isFile()?{hash:sha(await readFile(path))}:{})});
  if(stat.isDirectory())for(const name of (await readdir(path)).sort()){
   if(name===".git"){if(prefix)throw Error("saved-result-modified-during-verification");continue;}
   await walk(join(path,name),prefix?`${prefix}/${name}`:name);
  }
 }
 await walk(tree,"");
 const gitPointer=await lstat(join(tree,".git"));if(!gitPointer.isFile()||gitPointer.isSymbolicLink())throw Error("saved-result-modified-during-verification");
 const protectedGit:unknown[]=[{name:".git",mode:gitPointer.mode&0o7777,hash:sha(await readFile(join(tree,".git")))}];
 for(const name of ["config","info/attributes","info/exclude"]){
  const path=resolve(tree,(await savedGit(tree,"rev-parse","--git-path",name)).toString().trim());
  try{const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink())throw Error("saved-result-modified-during-verification");protectedGit.push({name,mode:st.mode&0o7777,hash:sha(await readFile(path))});}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;protectedGit.push({name,missing:true});}
 }
 return canonicalHash({entries,protectedGit,head:(await savedGit(tree,"rev-parse","HEAD")).toString(),index:(await savedGit(tree,"ls-files","--stage","-z")).toString()});
}
export async function persistSavedResultMode(runDir:string,input:LoopStartEnvelope):Promise<void>{
 await mkdir(runDir,{recursive:true,mode:0o700});
 const old=await readSavedResultMode(runDir);
 if(old&&canonicalHash(old)!==canonicalHash(input))throw Error("saved-result-mode-conflict");
 if(!old)await atomicReplacePrivateFile(dirname(runDir),join(runDir,"saved-result-mode.json"),Buffer.from(canonicalJson(input)));
}
export async function readSavedResultMode(runDir:string):Promise<LoopStartEnvelope|null>{
 try{await lstat(join(runDir,"saved-result-mode.json"));return JSON.parse((await readPrivateFile(runDir,join(runDir,"saved-result-mode.json"))).toString());}
 catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
}
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const preparedSchema=z.object({candidateHash:hashSchema,protectedInputsHash:hashSchema,preparedAt:z.string().datetime()}).strict();
const entrySchema=z.object({candidateHash:hashSchema,protectedInputsHash:hashSchema,enteredAt:z.string().datetime()}).strict();
const lifecycleSchema=z.discriminatedUnion("stage",[
 z.object({schema:z.literal("ccloop-saved-result-lifecycle-v1"),stage:z.literal("prepared"),packageHash:hashSchema,prepared:preparedSchema}).strict(),
 z.object({schema:z.literal("ccloop-saved-result-lifecycle-v1"),stage:z.literal("entered"),packageHash:hashSchema,entry:entrySchema}).strict(),
]);
async function lifecycle(runDir:string){return lifecycleSchema.parse(JSON.parse((await readPrivateFile(runDir,join(runDir,"saved-result-lifecycle.json"))).toString()));}
export async function prepareSavedResultVerification(runDir:string,tree:string,loaded:LoadedSavedResult,state:RunState):Promise<RunState>{
 await assertRestoredSavedCandidate(tree,loaded);
 const prepared={candidateHash:await candidateFingerprint(tree),protectedInputsHash:await protectedInputHash(runDir),preparedAt:new Date().toISOString()};
 await atomicReplacePrivateFile(dirname(runDir),join(runDir,"saved-result-lifecycle.json"),Buffer.from(canonicalJson({schema:"ccloop-saved-result-lifecycle-v1",stage:"prepared",packageHash:loaded.input.savedResultRecovery!.packageHash,prepared})));
 return {...state,savedResult:{...state.savedResult!,prepared}};
}
export async function hasPreparedSavedResultProof(runDir:string,state:RunState):Promise<boolean>{
 try{const value=await lifecycle(runDir);if(value.stage!=="prepared"||value.packageHash!==state.savedResult?.packageHash||canonicalHash(value.prepared)!==canonicalHash(state.savedResult.prepared)||state.savedResult.entry!==undefined)return false;
  try{await lstat(join(runDir,"saved-result-entry.json"));return false;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")return false;}
  return true;
 }catch{return false;}
}
export async function enterSavedResultVerification(runDir:string,tree:string,loaded:LoadedSavedResult,state:RunState):Promise<RunState>{
 await loadSavedResultRecovery(loaded.input);
 if(!await hasPreparedSavedResultProof(runDir,state))throw Error("saved-result-mode-conflict");
 await assertRestoredSavedCandidate(tree,loaded);
 const entry={candidateHash:await candidateFingerprint(tree),protectedInputsHash:await protectedInputHash(runDir),enteredAt:new Date().toISOString()};
 if(entry.candidateHash!==state.savedResult!.prepared!.candidateHash||entry.protectedInputsHash!==state.savedResult!.prepared!.protectedInputsHash)throw Error("saved-result-modified-during-verification");
 // The prepared -> entered rename is durable before any command can receive input.
 await atomicReplacePrivateFile(dirname(runDir),join(runDir,"saved-result-lifecycle.json"),Buffer.from(canonicalJson({schema:"ccloop-saved-result-lifecycle-v1",stage:"entered",packageHash:loaded.input.savedResultRecovery!.packageHash,entry})));
 // A separate fsynced marker survives a crash before loop-state.json's next rename.
 await atomicReplacePrivateFile(dirname(runDir),join(runDir,"saved-result-entry.json"),Buffer.from(canonicalJson({packageHash:loaded.input.savedResultRecovery!.packageHash,...entry})));
 await testCrashPoint("saved-result-entry-fsynced");
 await assertSavedResultFence(loaded.input,loaded.admission);
 return {...state,savedResult:{...state.savedResult!,entry}};
}
export async function assertSavedResultUnmodified(runDir:string,tree:string,loaded:LoadedSavedResult,state:RunState):Promise<void>{
 const entry=state.savedResult?.entry;
 try{if(!entry||entry.candidateHash!==await candidateFingerprint(tree)||entry.protectedInputsHash!==await protectedInputHash(runDir))throw Error("changed");}
 catch{throw Error("saved-result-modified-during-verification");}
 try{await loadSavedResultRecovery(loaded.input);}catch(error){if(error instanceof Error&&error.message==="saved-result-source-stale")throw error;throw Error("saved-result-modified-during-verification");}
}
/** A cleaned workspace is reusable only through its exact durable terminal and genuine publication. */
export async function assertSavedResultCompletionCandidate(runDir:string,loaded:LoadedSavedResult,state:RunState):Promise<void>{
 const tree=join(runDir,"worktrees/attempt-1");
 try{await lstat(tree);await assertSavedResultUnmodified(runDir,tree,loaded,state);return;}
 catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw Error("saved-result-modified-during-verification");}
 const bytes=await readPrivateFile(runDir,join(runDir,"saved-result-completion.json"));
 const hash=JSON.parse((await readPrivateFile(runDir,join(runDir,"saved-result-completion-hash.json"))).toString());
 const completion=JSON.parse(bytes.toString());
 if(sha(bytes)!==hash.hash||completion.schema!=="ccloop-saved-result-completion-v1"||completion.packageHash!==state.savedResult?.packageHash||canonicalHash(completion.state)!==canonicalHash(state))throw Error("saved-result-publication-unavailable");
 if(state.savedResult?.entry?.protectedInputsHash!==await protectedInputHash(runDir))throw Error("saved-result-modified-during-verification");
 await savedResultPublication(loaded);
}
async function savedResultPublication(loaded:LoadedSavedResult):Promise<string>{
 try{
  const repo=loaded.input.work.contract.context.repoPath,ref=`refs/ccloop/${loaded.input.claim.runId}/attempts/1`;
  const commit=(await savedGit(repo,"rev-parse","--verify",`${ref}^{commit}`)).toString().trim();
  const parents=(await savedGit(repo,"rev-list","--parents","-n","1",commit)).toString().trim().split(" ");
  if(parents.length!==2||parents[1]!==loaded.snapshot.head||(await savedGit(repo,"rev-parse",`${commit}^{tree}`)).toString()!==(await savedGit(repo,"rev-parse",`${loaded.snapshot.head}^{tree}`)).toString())throw Error("publication mismatch");
  return commit;
 }catch{throw Error("saved-result-publication-unavailable");}
}
/** Ordinary Git delivery retains bytes/executable bits, not the verifier's full POSIX permissions. */
export async function assertSavedResultDelivery(runDir:string,loaded:LoadedSavedResult,state:RunState,repository:string):Promise<void>{
 await assertSavedResultCompletionCandidate(runDir,loaded,state);
 const publication=await savedResultPublication(loaded);
 try{
  if(await realpath(repository)!==repository)throw Error("invalid repository path");
  const root=await lstat(repository),git=await lstat(join(repository,".git"));
  if(!root.isDirectory()||root.isSymbolicLink()||(root.mode&0o7000)!==0||!git.isDirectory()||git.isSymbolicLink()||(git.mode&0o7000)!==0)throw Error("invalid repository");
  if((await savedGit(repository,"rev-parse","HEAD")).toString().trim()!==publication)throw Error("wrong HEAD");
  const index=loaded.snapshot.index.map(e=>`${e.mode} ${e.oid} 0\t${e.path}\0`).join("");
  if((await savedGit(repository,"ls-files","--stage","-z")).toString()!==index)throw Error("dirty index");
  const expected=new Map(loaded.snapshot.tree.map(e=>[e.path,e]));
  async function walk(dir:string,prefix=""):Promise<void>{for(const name of await readdir(dir)){
   if(!prefix&&name===".git")continue;
   const path=prefix?`${prefix}/${name}`:name,entry=expected.get(path),stat=await lstat(join(dir,name));expected.delete(path);
   if(!entry||stat.isSymbolicLink()||(stat.mode&0o7000)!==0)throw Error("unsupported projection");
   if(entry.kind==="directory"){if(!stat.isDirectory())throw Error("wrong kind");await walk(join(dir,name),path);}
   else if(!stat.isFile()||((stat.mode&0o111)!==0)!==((entry.mode&0o111)!==0)||sha(await readFile(join(dir,name)))!==entry.ref.hash)throw Error("changed file");
  }}
  await walk(repository);if(expected.size)throw Error("missing protected content");
 }catch{throw Error("saved-result-modified-during-verification");}
}
export async function hasSavedResultEntry(runDir:string):Promise<boolean>{
 try{if((await lifecycle(runDir)).stage==="entered")return true;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")return true;}
 try{await readPrivateFile(runDir,join(runDir,"saved-result-entry.json"));return true;}
 catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}
}
export async function persistSavedResultCompletion(runDir:string,state:RunState,verification:VerificationResult):Promise<void>{
 const bytes=Buffer.from(canonicalJson({schema:"ccloop-saved-result-completion-v1",packageHash:state.savedResult!.packageHash,state,verification}));
 await atomicReplacePrivateFile(dirname(runDir),join(runDir,"saved-result-completion.json"),bytes);
 await testCrashPoint("saved-result-output-fsynced");
 await atomicReplacePrivateFile(dirname(runDir),join(runDir,"saved-result-completion-hash.json"),Buffer.from(canonicalJson({hash:sha(bytes)})));
 await testCrashPoint("saved-result-result-fsynced");
}
/** After durable entry no external command is replayed, including after a partial result write. */
export async function recoverSavedResultEntry(runDir:string,state:RunState,loaded:LoadedSavedResult,allowResult=true):Promise<RunState>{
 const reaped=await reapRunProcesses(runDir);if(!reaped.ok)throw Error(`saved-result-process-not-reaped:${reaped.reason}`);
 try{
  if(!allowResult)throw Error("revoked authority");
  const b=await readPrivateFile(runDir,join(runDir,"saved-result-completion.json")),hash=JSON.parse((await readPrivateFile(runDir,join(runDir,"saved-result-completion-hash.json"))).toString());
  if(sha(b)!==hash.hash)throw Error("completion hash");
  const result=JSON.parse(b.toString()),{tokenUsage,usageEvidence,modelUsage,...core}=result.verification;
  verificationSchema.parse(core);
  if(!Number.isSafeInteger(tokenUsage)||tokenUsage<0||result.schema!=="ccloop-saved-result-completion-v1"||result.packageHash!==state.savedResult?.packageHash
   ||!result.state.savedResult?.entry||result.state.currentAttempt!==1||result.state.attemptsUsed!==1||!["succeeded","failed","exhausted","cancelled","blocked_waiting_human"].includes(result.state.status)
   ||(result.state.status==="succeeded"&&!core.approved))throw Error("completion invalid");
  const entry=JSON.parse((await readPrivateFile(runDir,join(runDir,"saved-result-entry.json"))).toString());
  if(canonicalHash(entry)!==canonicalHash({packageHash:result.packageHash,...result.state.savedResult.entry}))throw Error("entry mismatch");
  const durable=await lifecycle(runDir);
  if(durable.stage!=="entered"||durable.packageHash!==result.packageHash||canonicalHash(durable.entry)!==canonicalHash(result.state.savedResult.entry))throw Error("entry mismatch");
  if(entry.protectedInputsHash!==await protectedInputHash(runDir))throw Error("protected inputs changed");
  if(["failed","exhausted","cancelled","blocked_waiting_human"].includes(state.status)&&canonicalHash(state)!==canonicalHash(result.state))return state;
  await assertSavedResultCompletionCandidate(runDir,loaded,result.state);
  try{await lstat(join(loaded.input.work.sourceDir,"repo"));await assertSavedResultDelivery(runDir,loaded,result.state,join(loaded.input.work.sourceDir,"repo"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  return result.state as RunState;
 }catch(error){
  if(["failed","exhausted","cancelled","blocked_waiting_human"].includes(state.status))return state;
  if(error instanceof Error&&["saved-result-publication-unavailable","saved-result-modified-during-verification"].includes(error.message))return {...state,status:"failed",waitingOnHuman:false,stopReason:error.message,lastTransitionAt:new Date().toISOString(),budgetSnapshot:await readSavedResultBudget(runDir,loaded,state)};
  // Absence/partial output cannot distinguish a spent external request from no request.
  const budgetSnapshot=await readSavedResultBudget(runDir,loaded,state);
  let entry:any;
  try{entry=JSON.parse((await readPrivateFile(runDir,join(runDir,"saved-result-entry.json"))).toString());}catch{const value=await lifecycle(runDir);if(value.stage!=="entered")throw Error("saved-result-mode-conflict");entry={packageHash:value.packageHash,...value.entry};}
  if(entry.packageHash!==loaded.input.savedResultRecovery!.packageHash)throw Error("saved-result-mode-conflict");
  let modified=false;
  try{modified=entry.candidateHash!==await candidateFingerprint(join(runDir,"worktrees/attempt-1"))||entry.protectedInputsHash!==await protectedInputHash(runDir);}catch{modified=true;}
  if(modified)return {...state,status:"failed",waitingOnHuman:false,stopReason:"saved-result-modified-during-verification",lastTransitionAt:new Date().toISOString(),budgetSnapshot};
  try{
   const raw=JSON.parse((await readPrivateFile(runDir,join(runDir,"attempts/1/verify.json"))).toString()),{tokenUsage,usageEvidence,modelUsage,...core}=raw;
   if(verificationSchema.parse(core).approved===false)return {...state,status:"failed",waitingOnHuman:false,stopReason:"saved-result-verification-rejected",lastTransitionAt:new Date().toISOString(),budgetSnapshot};
  }catch{ /* No complete validated rejection artifact. */ }
  return {...state,status:"blocked_waiting_human",waitingOnHuman:true,stopReason:allowResult?"saved-result-verification-interrupted":"saved-result-source-stale",lastTransitionAt:new Date().toISOString(),
   savedResult:{...state.savedResult!,entry:{candidateHash:entry.candidateHash,protectedInputsHash:entry.protectedInputsHash,enteredAt:entry.enteredAt}},budgetSnapshot};
 }
}

import {spawn} from "node:child_process";
import {readProcessStart} from "../ownership/ownerLiveness.js";
/** The shell receives no command until its isolated group identity has been durably registered. */
export async function runSavedResultCheck(runDir:string,tree:string,command:string,index:number,signal:AbortSignal|undefined,onRegistered?: (p:{pid:number;pgid:number;startedAt:string;phase:string})=>Promise<void>):Promise<{stdout:string;stderr:string}>{
 const dir=join(runDir,"saved-result-checks",String(index));await mkdir(dir,{recursive:true,mode:0o700});
 const wrapper="let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{if(s.length===0)process.exit(1);const c=require('node:child_process').spawn('/bin/sh',['-lc',s],{stdio:'inherit'});c.on('error',()=>process.exit(127));c.on('exit',(code,signal)=>process.exit(code??1));});";
 const child=spawn(process.execPath,["-e",wrapper],{cwd:tree,detached:true,stdio:["pipe","pipe","pipe"]});
 let stdout="",stderr="",exceeded=false,aborted=false;let timer:NodeJS.Timeout|undefined;
 // ESRCH: the group is gone. EPERM: on macOS kill() answers EPERM for a group whose members have all exited but are not
 // yet reaped (after SIGTERM the shell and its children are reparented and reaped asynchronously). Nothing is left to
 // signal in either case; throwing there turned an abort, or a passed check, into a failed check.
 const kill=(sig:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,sig);}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code!=="ESRCH"&&code!=="EPERM")throw error;}};
 const abort=()=>{if(aborted)return;aborted=true;kill("SIGTERM");timer=setTimeout(()=>kill("SIGKILL"),100);};
 const closed=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",code=>resolve(code));});
 child.stdin.on("error",()=>undefined);
 const outDecoder=new StringDecoder("utf8"),errDecoder=new StringDecoder("utf8");
 child.stdout.on("data",b=>{if(Buffer.byteLength(stdout)+b.length>10*1024*1024){exceeded=true;abort();}else stdout+=outDecoder.write(b);});
 child.stderr.on("data",b=>{if(Buffer.byteLength(stderr)+b.length>10*1024*1024){exceeded=true;abort();}else stderr+=errDecoder.write(b);});
 signal?.addEventListener("abort",abort,{once:true});
 try{
  await new Promise<void>((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);});
  const startedAt=await readProcessStart(child.pid!);if(!startedAt)throw Error("saved-result-check-process-identity-unavailable");
  const processRecord={pid:child.pid!,pgid:child.pid!,startedAt,phase:"verify-check"};
  await atomicReplacePrivateFile(runDir,join(dir,"process.json"),Buffer.from(canonicalJson(processRecord)));
  await onRegistered?.(processRecord);
  if(signal?.aborted){abort();}else child.stdin.end(command);
  const code=await closed;stdout+=outDecoder.end();stderr+=errDecoder.end();kill("SIGKILL");
  await atomicReplacePrivateFile(runDir,join(dir,"outcome.json"),Buffer.from(canonicalJson({code,aborted,exceeded})));
  if(aborted)throw Object.assign(Error("saved-result-check-aborted"),{name:"AbortError",stdout,stderr});
  if(code!==0||exceeded)throw Object.assign(Error("saved-result-check-failed"),{code,stdout,stderr});
  return {stdout,stderr};
 }finally{signal?.removeEventListener("abort",abort);clearTimeout(timer);kill("SIGKILL");child.stdin.destroy();await closed.catch(()=>undefined);}
}

export async function readSavedResultBudget(runDir:string,loaded:LoadedSavedResult,state:RunState):Promise<RunState["budgetSnapshot"]>{
 try{
  const source=dirname(runDir),ledger=JSON.parse((await readPrivateFile(source,join(source,"control/usage.json"))).toString());
  if(ledger.protocol!==1||!Array.isArray(ledger.events)||ledger.nextSeq!==ledger.events.length+1)throw Error("usage");
  let work:any=null,sawVerification=false,sawEntry=false;
  for(const [index,event] of ledger.events.entries()){
   if(event.runId!==loaded.input.claim.runId||event.generation!==loaded.input.claim.generation||event.eventSeq!==index+1)throw Error("identity");
   if(event.bucket!=="work")continue;
   if(event.cumulative===null||event.source.artifactId!==`evidence-${event.source.hash}`)throw Error("unknown");
   const bytes=await readPrivateFile(source,join(source,"control/evidence",`${event.source.artifactId}.bin`));if(sha(bytes)!==event.source.hash)throw Error("hash");
   const observed=JSON.parse(bytes.toString());
   if(observed.kind==="saved-result-attempt-entry-v1"){
    if(sawEntry||sawVerification||observed.runId!==loaded.input.claim.runId||observed.generation!==loaded.input.claim.generation||observed.attempt!==1||observed.providerEntered!==false
      ||event.cumulative.tokens!==0||event.cumulative.activeMs!==0||event.cumulative.attempts!==1||event.cumulative.sessions!==1)throw Error("entry");
    sawEntry=true;
   }else{if(observed.phase!=="verify"||observed.attempt!==1||!Number.isSafeInteger(observed.tokenUsage)||observed.tokenUsage<0)throw Error("phase");sawVerification=true;}
   for(const d of ["tokens","activeMs","attempts","sessions"]){if(!Number.isSafeInteger(event.cumulative[d])||event.cumulative[d]<0||(work&&event.cumulative[d]<work[d]))throw Error("usage");}
   work=event.cumulative;
  }
  if(!work||work.attempts!==1||work.sessions!==1||canonicalHash(work)!==canonicalHash(ledger.totals.work))throw Error("incomplete");
  if(!sawVerification&&(!sawEntry||!await hasPreparedSavedResultProof(runDir,state)))throw Error("unobserved phase");
  const grant=loaded.admission.funding.freshGrant.work;
  return {...state.budgetSnapshot,timeRemainingMs:Math.max(0,grant.activeMs-work.activeMs),
   tokenBudgetRemaining:grant.tokens===null?null:Math.max(0,grant.tokens-work.tokens),tokenRemainingStatus:grant.tokens===null?"unlimited":"known"};
 }catch{return {...state.budgetSnapshot,tokenBudgetRemaining:null,tokenRemainingStatus:"unknown"};}
}

async function protectedInputHash(runDir:string):Promise<string>{
 const entries:unknown[]=[];
 for(const name of ["loop-contract.json","saved-result-mode.json","../control/envelope.json","../control/config.json"]){
  const path=resolve(runDir,name);
  try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error("saved-result-modified-during-verification");entries.push({name,mode:stat.mode&0o7777,hash:sha(await readFile(path))});}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;entries.push({name,missing:true});}
 }
 return canonicalHash(entries);
}
