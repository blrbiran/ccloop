import {afterEach,expect,it} from "vitest";
import {execFile} from "node:child_process";
import {readFile,writeFile,rm,mkdir,cp,readdir} from "node:fs/promises";
import {join} from "node:path";
import {promisify} from "node:util";
import {resultFixture} from "./taskResultFixture.js";
import {ompInstallation,FAKE_OMP} from "../fixtures/toolRules/argvCapture.js";
import {parseMaterializedAgentConfig,agentConfigHash} from "../../src/agents/materialize.js";
import {writeAccepted} from "../../src/control/store.js";
import {runControlWorker} from "../../src/control/worker.js";
import {canonicalHash,canonicalJson,type ArtifactRefV1} from "../../src/control/protocol.js";
import {atomicReplacePrivateFile} from "../../src/control/paths.js";
import {readSavedResultSourceEligibility,savedResultSourcePackageSchema,loadSavedResultRecovery} from "../../src/control/savedResultRecovery.js";
import {runLoop,runLoopFromState} from "../../src/controller/runLoop.js";
import type {RunState} from "../../src/state/types.js";
import {collectSavedResultEvidence,readSavedResultEvidence} from "../../src/control/savedResultEvidence.js";

const exec=promisify(execFile),roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function source(options:{optIn?:boolean;reported?:Record<string,unknown>;tools?:unknown;exitCode?:number;headMove?:boolean;usageInvalid?:boolean;streamInvalid?:boolean;ignoredFile?:boolean;checkCommand?:string}={}){
 const f=await resultFixture();roots.push(f.root);
 const marker=join(f.root,"marker"),binary=join(f.root,"omp");
 const fake=options.exitCode!==undefined||options.headMove||options.usageInvalid||options.streamInvalid||options.ignoredFile?join(f.root,"fake.mjs"):FAKE_OMP;
 if(fake!==FAKE_OMP)await writeFile(fake,`import {appendFileSync,writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);if(args.includes('--version')){console.log('18.10.1');process.exit(0)}
if(args.includes('models')){console.log(JSON.stringify({models:[{provider:'gateway',kind:'chat',id:'model-a',selector:'gateway/model-a',contextWindow:200000,maxTokens:8192}]}));process.exit(0)}
if(args.includes('config')){console.log(JSON.stringify({value:{default:'gateway/model-a'}}));process.exit(0)}
for await(const part of process.stdin){};const phase=args.includes('--tools')&&args[args.indexOf('--tools')+1].includes('write')?'execute':'plan';
appendFileSync(${JSON.stringify(marker+'.calls')},phase+'\\n');
if(phase==='execute'){writeFileSync('answer.txt','42\\n');${options.ignoredFile?"writeFileSync('.gitignore','ignored.txt\\n');writeFileSync('ignored.txt','ignored');":""}${options.headMove?"execFileSync('/usr/bin/git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-am','move HEAD']);":""}}
const text=phase==='plan'?JSON.stringify({summary:'write',primaryTargetPaths:['answer.txt']}):JSON.stringify({changedFiles:['answer.txt'],unexpected:true});
const message={role:'assistant',content:[{type:'text',text}],provider:'gateway',model:'model-a',stopReason:'stop',usage:${options.usageInvalid?"null":"{input:8,output:2,cacheRead:3,cacheWrite:1,totalTokens:14}"}};
for(const row of [{type:'agent_start'},{type:'message_end',message},{type:'agent_end',isTerminal:true}])console.log(JSON.stringify(row));
${options.streamInvalid?"console.log('{invalid');":""}process.exit(${options.exitCode??0});`);
 const installation=await ompInstallation({dir:f.root,marker} as never);
 await writeFile(binary,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} ${fake===FAKE_OMP?JSON.stringify(marker)+' ':''}"$@"\n`,{mode:0o700});
 if(fake===FAKE_OMP)await writeFile(`${marker}.reported.json`,JSON.stringify(options.reported??{unexpected:true}));
 if(options.tools!==undefined)await writeFile(`${marker}.tools.json`,JSON.stringify(options.tools));
 const config=parseMaterializedAgentConfig({...installation,installation:{...(installation.installation as object),command:[binary]}});
 f.contract.verification={verifierType:"command",requiredChecks:[options.checkCommand??"test \"$(cat answer.txt)\" = 42"],rejectOn:["wrong answer"],evidenceRequired:[],...(options.optIn===false?{}:{commandChecksDecideGoal:true})};
 f.contract.executionPolicy.maxAttempts=1;f.contract.executionPolicy.totalRuntimeBudgetMs=30000;
 if(options.tools!==undefined)f.contract.executionPolicy.toolRules={commands:[],network:false,secretEnv:[]};
 f.input.claim.agent=config.selection;f.input.claim.configHash=agentConfigHash(config);f.input.work.contract=f.contract;f.input.contractHash=canonicalHash(f.contract);
 f.input.work.base=(await exec('/usr/bin/git',['rev-parse','HEAD'],{cwd:f.repo})).stdout.trim();
 await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/config.json'),Buffer.from(canonicalJson(config)));
 await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/envelope.json'),Buffer.from(canonicalJson(f.input)));
 await writeAccepted(f.sourceDir,{protocol:1,envelopeHash:canonicalHash(f.input),executionId:'execution-1',configHash:f.input.claim.configHash,generation:1,acceptedAt:new Date().toISOString(),launch:'intended',worker:null});
 await runControlWorker(['--source-dir',f.sourceDir,'--execution-id','execution-1','--nonce','nonce-1']);
 return {...f,marker};
}

it('publishes an opted-in malformed OMP final as a distinct verification-only capsule with no answer or hash',async()=>{
 const f=await source();const index=await collectSavedResultEvidence(f.input);
 expect(index.capsule,await readFile(join(f.runDir,'events.jsonl'),'utf8')).not.toBeNull();
 const capsule=JSON.parse((await readSavedResultEvidence(f.input,index.capsule!,index.capsule!)).toString());
 expect(capsule.schema).toBe('ccloop-execution-without-final-v1');
 expect(capsule).toMatchObject({published:{ref:'refs/ccloop/run-1/attempts/1'},executor:{kind:'omp'},verifier:{entered:false}});
 expect(capsule).not.toHaveProperty('normalizedExecutionHash');expect(capsule).not.toHaveProperty('execution');
 expect(JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8')).status).toBe('failed');
},30000);

async function sourcePackage(f:Awaited<ReturnType<typeof source>>){
 const page=await collectSavedResultEvidence(f.input);if(!page.capsule)throw Error(page.reason??'missing source');
 const capsule=JSON.parse((await readSavedResultEvidence(f.input,page.capsule,page.capsule)).toString());
 const snapshot=JSON.parse((await readSavedResultEvidence(f.input,page.capsule,capsule.snapshot)).toString());
 const refs:ArtifactRefV1[]=[page.capsule,capsule.snapshot,capsule.verifier.proof,...Object.values(capsule.artifacts).filter((value):value is ArtifactRefV1=>Boolean(value&&typeof value==='object'&&'artifactId' in value)),
   ...capsule.artifacts.usageObservations.map((x:any)=>x.copy),snapshot.index,snapshot.bundle,snapshot.status,...snapshot.files.map((x:any)=>x.ref)];
 const path=join(f.sourceDir,'input/recovery');await mkdir(path,{recursive:true,mode:0o700});
 const artifacts:Array<{ref:ArtifactRefV1;file:string}>=[];for(const ref of refs){if(artifacts.some(e=>e.ref.artifactId===ref.artifactId))continue;
  const bytes=await readSavedResultEvidence(f.input,page.capsule,ref),file=ref.artifactId+'.bin';await writeFile(join(path,file),bytes,{mode:0o600});artifacts.push({ref,file});}
 const manifest=savedResultSourcePackageSchema.parse({schema:'ccloop-saved-result-source-package-v1',authorityKind:'execution-without-final-v1',source:page.capsule,artifacts});
 const raw=Buffer.from(canonicalJson(manifest));await writeFile(join(path,'package.json'),raw,{mode:0o600});
 return {path,hash:canonicalHash(manifest),capsule,snapshot,manifest};
}
it('reads an opted-in OMP source from its self-contained Git bundle without an execution hash',async()=>{
 const f=await source(),p=await sourcePackage(f);
 const eligible=await readSavedResultSourceEligibility({source:f.input,sourceAttempt:1,packagePath:p.path,packageHash:p.hash});
 expect(eligible).toMatchObject({status:'eligible',authorityKind:'execution-without-final-v1',rawExecutionTokens:14,recoveryOf:{sourceRunId:'run-1',sourceAttempt:1,capsuleHash:p.manifest.source.hash,snapshotHash:p.capsule.snapshot.hash,kind:'verification-only-v1'}});
 expect(eligible).not.toHaveProperty('normalizedExecutionHash');if(eligible.status!=='eligible')throw Error(eligible.reason);expect(eligible.recoveryOf).not.toHaveProperty('normalizedExecutionHash');
 const publicResult=await f.rpc('saved-result-source-eligibility',{input:{source:f.input,sourceAttempt:1,packagePath:p.path,packageHash:p.hash}});
 expect(publicResult.code,publicResult.stderr).toBe(0);expect(JSON.parse(publicResult.stdout)).toMatchObject({status:'eligible',verificationOnly:true});
},30000);

async function recovery(f:Awaited<ReturnType<typeof source>>){
 const p=await sourcePackage(f),eligible=await readSavedResultSourceEligibility({source:f.input,sourceAttempt:1,packagePath:p.path,packageHash:p.hash});
 if(eligible.status!=='eligible')throw Error(eligible.reason);
 const g=await resultFixture();roots.push(g.root);
 const packagePath=join(g.sourceDir,'input/recovery');await mkdir(join(g.sourceDir,'input'),{mode:0o700});await cp(p.path,packagePath,{recursive:true});
 const {createHash}=await import('node:crypto');const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 const artifacts=[...p.manifest.artifacts],put=async(value:unknown)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(canonicalJson(value)),hash=sha(bytes),ref={artifactId:`recovery-${hash}`,hash},file=ref.artifactId+'.bin';
   await writeFile(join(packagePath,file),bytes,{mode:0o600});if(!artifacts.some(x=>x.ref.artifactId===ref.artifactId))artifacts.push({ref,file});return ref;};
 const stop=(await f.rpc('collect',{input:f.input,afterSeq:0}));expect(stop.code,stop.stderr).toBe(0);const report=JSON.parse(stop.stdout);
 const proof=report.candidate.stopProof.source as ArtifactRefV1,proofResponse=await f.rpc('read-evidence',{input:f.input,ref:proof});expect(proofResponse.code,proofResponse.stderr).toBe(0);
 const proofBytes=Buffer.from(JSON.parse(proofResponse.stdout).base64,'base64'),proofFile=proof.artifactId+'.bin';await writeFile(join(packagePath,proofFile),proofBytes,{mode:0o600});artifacts.push({ref:proof,file:proofFile});
 const ledger=JSON.parse(await readFile(join(f.sourceDir,'control/usage.json'),'utf8'));
 const reportRef=await put({candidate:report.candidate,terminal:{outcome:'failed',sourceDir:f.sourceDir}});
 const amount=f.input.claim.grant.work,handoff=f.input.claim.grant.handoff;
 g.input.claim={...f.input.claim,runId:'recovery-1',generation:2,commandId:'recovery-command',ownerToken:'recovery-owner',grant:{work:amount,handoff}};
 g.input.work={...f.input.work,sourceDir:g.sourceDir,targetRepo:f.repo};g.input.contractHash=f.input.contractHash;
 const recoveryOf=eligible.recoveryOf;
 Object.assign(g.input,{protocol:4,mode:'verify-saved-result',inputCheckpoint:null,savedResultRecovery:{packagePath,packageHash:'0'.repeat(64),admissionHash:'0'.repeat(64),recoveryOf}});
 const policyRef=await put({schema:'ccloop-recovery-policy-authority-v1',groupId:f.input.claim.groupId,workItemId:f.input.claim.workItemId,taskId:f.input.claim.taskId,sourceRunId:f.input.claim.runId,
   contractHash:f.input.contractHash,accountingMode:'finite-legacy',authoredWork:amount});
 const inherited=ledger.totals.work,fresh=amount;
 const funding={kind:'legacy-fresh-grant-v1',historicalPolicy:{accountingMode:'finite-legacy',authoredWork:amount,contractHash:f.input.contractHash,authority:policyRef},inheritedUsage:inherited,
   freshGrant:{work:fresh,handoff},fundedTotal:Object.fromEntries(Object.keys(fresh).map(key=>[key,(inherited as any)[key]+(fresh as any)[key]])),reservation:{runId:g.input.claim.runId,revision:1,workAllocationId:'allocation-work',handoffAllocationId:'allocation-handoff'}};
 const admission={schema:'ccloop-saved-result-admission-v1',revision:1,funding,source:eligible.sourceIdentity,recoveryOf,contractHash:f.input.contractHash,
  claim:{runId:g.input.claim.runId,generation:g.input.claim.generation,commandId:g.input.claim.commandId,ownerToken:g.input.claim.ownerToken,configHash:g.input.claim.configHash},currentRunId:f.input.claim.runId,predecessor:null,
  accounting:{work:ledger.totals.work,handoff:ledger.totals.handoff,highWater:ledger.nextSeq-1,report:reportRef,stopProof:proof,settlement:null,receipt:null}};
 const admissionRef=await put(admission);
 const manifest={schema:'ccloop-saved-result-package-v1',authorityKind:'execution-without-final-v1',source:p.manifest.source,admission:admissionRef,artifacts};
 const manifestBytes=Buffer.from(canonicalJson(manifest));await writeFile(join(packagePath,'package.json'),manifestBytes,{mode:0o600});
 g.input.savedResultRecovery!.packageHash=sha(manifestBytes);g.input.savedResultRecovery!.admissionHash=admissionRef.hash;
 await writeFile(join(g.sourceDir,'control/recovery-fence.json'),canonicalJson({schema:'ccloop-saved-result-fence-v1',admissionHash:admissionRef.hash,packageHash:sha(manifestBytes),runId:g.input.claim.runId,generation:2,revision:1,currentRunId:f.input.claim.runId,status:'admitted'}),{mode:0o600});
 return g;
}
it('runs a funded verification-only recovery without entering plan, execute or provider verify',async()=>{
 const f=await source(),g=await recovery(f),loaded=await loadSavedResultRecovery(g.input);
 expect(loaded.verificationOnly).toBe(true);expect(loaded.execution).toBeUndefined();
 const adapter={plan:async()=>{throw Error('provider plan entered');},execute:async()=>{throw Error('provider execute entered');},verify:async()=>{throw Error('provider verify entered');}};
 const state=await runLoop(g.input.work.contract,g.runDir,adapter,{taskResultInput:g.input,savedResultRecovery:g.input,workGrant:g.input.claim.grant.work});
 expect(state.status,state.stopReason??'').toBe('succeeded');expect(await readFile(join(g.runDir,'saved-result-checks/0/outcome.json'),'utf8')).toContain('"code":0');
 expect(await readFile(join(g.runDir,'attempts/1/execution.json'),'utf8').catch(()=>'')).toBe('');
},30000);
it('worker publishes a verification-only acceptance without an execution artifact or provider call',async()=>{
 const f=await source(),g=await recovery(f);
 const config=await readFile(join(f.sourceDir,'control/config.json'));
 await atomicReplacePrivateFile(g.sourceDir,join(g.sourceDir,'control/config.json'),config);
 await atomicReplacePrivateFile(g.sourceDir,join(g.sourceDir,'control/envelope.json'),Buffer.from(canonicalJson(g.input)));
 await writeAccepted(g.sourceDir,{protocol:1,envelopeHash:canonicalHash(g.input),executionId:'execution-recovery',configHash:g.input.claim.configHash,generation:2,acceptedAt:new Date().toISOString(),launch:'intended',worker:null});
 await runControlWorker(['--source-dir',g.sourceDir,'--execution-id','execution-recovery','--nonce','nonce-recovery']);
 const collected=await g.rpc('collect',{input:g.input,afterSeq:0});expect(collected.code,collected.stderr).toBe(0);
 const result=JSON.parse(collected.stdout);expect(result.terminal.status).toBe('succeeded');expect(result.candidate).toMatchObject({result:'complete',verificationOnly:true});
 expect(result.candidate.missing).toEqual([]);
 expect(result.decisions).toBeUndefined();expect(await readFile(join(g.runDir,'attempts/1/execution.json'),'utf8').catch(()=>'')).toBe('');
 expect(await readFile(join(g.sourceDir,'repo/answer.txt'),'utf8')).toBe('42\n');
 expect(await readFile(`${f.marker}.calls`,'utf8')).toBe('plan\nexecute\n');
},60000);

it('a completed check cannot run again on a restarted verification-only recovery',async()=>{
 const f=await source(),g=await recovery(f);
 await atomicReplacePrivateFile(g.sourceDir,join(g.sourceDir,'control/config.json'),await readFile(join(f.sourceDir,'control/config.json')));
 await atomicReplacePrivateFile(g.sourceDir,join(g.sourceDir,'control/envelope.json'),Buffer.from(canonicalJson(g.input)));
 await writeAccepted(g.sourceDir,{protocol:1,envelopeHash:canonicalHash(g.input),executionId:'execution-recovery',configHash:g.input.claim.configHash,generation:2,acceptedAt:new Date().toISOString(),launch:'intended',worker:null});
 await runControlWorker(['--source-dir',g.sourceDir,'--execution-id','execution-recovery','--nonce','nonce-recovery']);
 const outcome=await readFile(join(g.runDir,'saved-result-checks/0/outcome.json'));
 const processRecord=await readFile(join(g.runDir,'saved-result-checks/0/process.json'));
 const usage=await readFile(join(g.sourceDir,'control/usage.json'));
 const state=JSON.parse(await readFile(join(g.runDir,'loop-state.json'),'utf8')) as RunState;
 const adapter={plan:async()=>{throw Error('provider plan entered');},execute:async()=>{throw Error('provider execute entered');},verify:async()=>{throw Error('provider verify entered');}};
 const runtime=JSON.parse(await readFile(join(g.runDir,'loop-contract.json'),'utf8'));
 const result=await runLoopFromState(runtime,g.runDir,adapter,state,undefined,undefined,{savedResultRecovery:g.input});
 expect(result.status).toBe('succeeded');expect(await readFile(join(g.runDir,'saved-result-checks/0/outcome.json'))).toEqual(outcome);
 expect(await readFile(join(g.runDir,'saved-result-checks/0/process.json'))).toEqual(processRecord);
 expect(await readFile(join(g.sourceDir,'control/usage.json'))).toEqual(usage);
 expect(await readFile(`${f.marker}.calls`,'utf8')).toBe('plan\nexecute\n');
},60000);

it('a failed decisive command remains unaccepted with no provider verification',async()=>{
 const f=await source({checkCommand:'false'}),g=await recovery(f);
 const adapter={plan:async()=>{throw Error('provider plan entered');},execute:async()=>{throw Error('provider execute entered');},verify:async()=>{throw Error('provider verify entered');}};
 const state=await runLoop(g.input.work.contract,g.runDir,adapter,{taskResultInput:g.input,savedResultRecovery:g.input,workGrant:g.input.claim.grant.work});
 expect(state.status).not.toBe('succeeded');expect(await readFile(join(g.runDir,'saved-result-checks/0/outcome.json'),'utf8')).toContain('"code":1');
},30000);

it('refuses checks that could rely on ignored bytes absent from the published Git tree',async()=>{
 const f=await source({ignoredFile:true});
 const call=(await readdir(join(f.runDir,'omp/1/execute')))[0]!;
 expect((await collectSavedResultEvidence(f.input)).capsule,(await readFile(join(f.runDir,'omp/1/execute',call,'events.jsonl'),'utf8'))+'\n'+(await readFile(join(f.runDir,'events.jsonl'),'utf8'))).not.toBeNull();
 const p=await sourcePackage(f);
 const eligible=await readSavedResultSourceEligibility({source:f.input,sourceAttempt:1,packagePath:p.path,packageHash:p.hash});
 expect(eligible.status).toBe('unavailable');
},30000);

it('rejects a fake published parent or tree even when the capsule and package hashes are internally consistent',async()=>{
 const f=await source(),p=await sourcePackage(f);
 for(const field of ['tree','base'] as const){const forged={...p.capsule,published:{...p.capsule.published,[field]:'f'.repeat(40)}};
  const bytes=Buffer.from(canonicalJson(forged));const {createHash}=await import('node:crypto');const hash=createHash('sha256').update(bytes).digest('hex');
  const ref={artifactId:`saved-result-${hash}`,hash},file=ref.artifactId+'.bin';await writeFile(join(p.path,file),bytes,{mode:0o600});
  const manifest={...p.manifest,source:ref,artifacts:[...p.manifest.artifacts,{ref,file}]};
  const raw=Buffer.from(canonicalJson(manifest));await writeFile(join(p.path,'package.json'),raw,{mode:0o600});
  const result=await readSavedResultSourceEligibility({source:f.input,sourceAttempt:1,packagePath:p.path,packageHash:createHash('sha256').update(raw).digest('hex')});
  expect(result.status).toBe('unavailable');
 }
},30000);

it.each([
 ['no declaration',{optIn:false}],['tool violation',{tools:[{toolName:'bash',args:{command:'curl https://example.invalid'}}]}],
 ['nonzero exit',{exitCode:1}],['changed HEAD',{headMove:true}],['unknown usage',{usageInvalid:true}],['incomplete stream',{streamInvalid:true}],
] as const)('does not publish verification-only proof for %s',async(_,settings)=>{
 const f=await source(settings);const index=await collectSavedResultEvidence(f.input);
 expect(index.capsule,await readFile(join(f.runDir,'events.jsonl'),'utf8')).toBeNull();
},30000);
