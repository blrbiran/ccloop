import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {resultFixture} from './taskResultFixture.js';
import {sealCodex} from './agentsFixture.js';
import {canonicalHash,canonicalJson} from '../../src/control/protocol.js';
import {atomicReplacePrivateFile} from '../../src/control/paths.js';
import {writeAccepted} from '../../src/control/store.js';
import {runControlWorker} from '../../src/control/worker.js';

const git=promisify(execFile);
it('retains a sealed source from a successful execute stopped by the budget gate before verification',async()=>{
 const f=await resultFixture();
 try{
  f.contract.executionPolicy.tokenBudget=25;
  f.input.contractHash=canonicalHash(f.contract);
  const fake=join(f.root,'completed-execute.mjs');
  await writeFile(fake,`import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('9.9.9-fake');process.exit(0)}
if(!process.argv.includes('exec')){process.stdout.write(process.argv.includes('mcp')?'[]\\n':process.argv.includes('models')?'{"models":[]}\\n':'',()=>process.exit(0));await new Promise(()=>{})}
for await(const part of process.stdin){}
const args=process.argv,s=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
const phase=s.properties?.result?'execute':s.properties?.approved?'verify':'plan';
if(phase==='verify')throw Error('verification must not enter');
if(phase==='execute')writeFileSync('answer.txt','complete\\n');
const value=phase==='plan'?{summary:'write answer',primaryTargetPaths:['answer.txt']}:{result:{changedFiles:['answer.txt'],diffPatch:'',commandOutputs:[],stdoutStderrLog:'done'}};
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(value));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
`);
  const sealed=await sealCodex({command:[process.execPath,fake],model:'fixture',sandbox:'workspace-write',budgetMode:'soft',timeoutMs:10000,killGraceMs:50});
  f.input.claim.agent=sealed.selection;f.input.claim.configHash=sealed.configHash;
  await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/config.json'),Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/envelope.json'),Buffer.from(canonicalJson(f.input)));
  await writeAccepted(f.sourceDir,{protocol:1,envelopeHash:canonicalHash(f.input),executionId:'execution-1',configHash:sealed.configHash,generation:1,acceptedAt:new Date().toISOString(),launch:'intended',worker:null});
  await runControlWorker(['--source-dir',f.sourceDir,'--execution-id','execution-1','--nonce','nonce-1']);
  expect(JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8')).status).toBe('exhausted');
  const ref='refs/ccloop/run-1/attempts/1';
  expect((await git('/usr/bin/git',['rev-parse',ref],{cwd:f.repo})).stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
  if(!existsSync(join(f.runDir,'saved-result','exhausted-candidate.json')))throw new Error(await readFile(join(f.runDir,'saved-result','exhausted-candidate-unavailable.json'),'utf8').catch(()=> 'no candidate and no refusal'));
  const response=await f.rpc('saved-result-evidence',{input:f.input});expect(response.code,response.stderr).toBe(0);
  expect(JSON.parse(response.stdout).capsule).not.toBeNull();
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

import {chmod,mkdtemp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {savedResultPath} from '../../src/control/savedResultEvidence.js';
import {readSavedResultSourceEligibility} from '../../src/control/savedResultRecovery.js';
import {canonicalHash as hashOf,canonicalJson as canon} from '../../src/control/protocol.js';

/** The private package Orca builds from the declared closure, as the source-eligibility reader wants it. */
async function packageOf(f:Awaited<ReturnType<typeof resultFixture>>,capsule:{artifactId:string;hash:string}){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'exh-pkg-')));
 await chmod(dir,0o700);
 const fetched=await f.rpc('read-saved-result-evidence',{input:f.input,capsuleRef:capsule,ref:capsule});
 if(fetched.code!==0)throw new Error(fetched.stderr);
 const capsuleBytes=Buffer.from(JSON.parse(fetched.stdout).base64,'base64');
 const parsed=JSON.parse(capsuleBytes.toString());
 const isRef=(v:any)=>v&&typeof v==='object'&&typeof v.artifactId==='string'&&typeof v.hash==='string';
 const snapshot=JSON.parse((await readFile(savedResultPath(f.sourceDir,parsed.snapshot))).toString());
 const collected:any[]=[capsule,parsed.snapshot,parsed.verifier.proof,
   ...Object.values(parsed.artifacts).flatMap((v:any)=>Array.isArray(v)?v:[v]).filter(isRef),
   ...(parsed.artifacts.usageObservations??[]).map((a:any)=>a.copy),
   snapshot.index,snapshot.bundle,snapshot.status,...snapshot.files.map((f:any)=>f.ref)];
 const seen=new Set<string>(),artifacts:Array<{ref:any;file:string}>=[];
 for(const ref of collected){if(seen.has(ref.artifactId))continue;seen.add(ref.artifactId);
  const bytes=ref.artifactId===capsule.artifactId?capsuleBytes:await readFile(savedResultPath(f.sourceDir,ref));
  const file=`blob-${artifacts.length}.bin`;await writeFile(join(dir,file),bytes,{mode:0o600});artifacts.push({ref,file});}
 const manifest={schema:'ccloop-saved-result-source-package-v1',authorityKind:'execution-complete-before-verification-v1',source:capsule,artifacts};
 await writeFile(join(dir,'package.json'),canon(manifest),{mode:0o600});
 return {dir,hash:hashOf(manifest)};
}
async function exhaustedRun(f:Awaited<ReturnType<typeof resultFixture>>){
 f.contract.executionPolicy.tokenBudget=25;f.input.contractHash=canonicalHash(f.contract);
 const fake=join(f.root,'completed-execute.mjs');
 await writeFile(fake,`import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('9.9.9-fake');process.exit(0)}
if(!process.argv.includes('exec')){process.stdout.write(process.argv.includes('mcp')?'[]\\n':process.argv.includes('models')?'{"models":[]}\\n':'',()=>process.exit(0));await new Promise(()=>{})}
for await(const part of process.stdin){}
const args=process.argv,s=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
const phase=s.properties?.result?'execute':s.properties?.approved?'verify':'plan';
if(phase==='verify')throw Error('verification must not enter');
if(phase==='execute')writeFileSync('answer.txt','complete\\n');
const value=phase==='plan'?{summary:'write answer',primaryTargetPaths:['answer.txt']}:{result:{changedFiles:['answer.txt'],diffPatch:'',commandOutputs:[],stdoutStderrLog:'done'}};
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(value));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
`);
 const sealed=await sealCodex({command:[process.execPath,fake],model:'fixture',sandbox:'workspace-write',budgetMode:'soft',timeoutMs:10000,killGraceMs:50});
 f.input.claim.agent=sealed.selection;f.input.claim.configHash=sealed.configHash;
 await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/config.json'),Buffer.from(canonicalJson(sealed.config)));
 await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/envelope.json'),Buffer.from(canonicalJson(f.input)));
 await writeAccepted(f.sourceDir,{protocol:1,envelopeHash:canonicalHash(f.input),executionId:'execution-1',configHash:sealed.configHash,generation:1,acceptedAt:new Date().toISOString(),launch:'intended',worker:null});
 await runControlWorker(['--source-dir',f.sourceDir,'--execution-id','execution-1','--nonce','nonce-1']);
 return JSON.parse((await f.rpc('saved-result-evidence',{input:f.input})).stdout);
}
it('keeps a capsule for a prompt-mode codex installation exhausted before verification (#206)',async()=>{
 const f=await resultFixture();
 try{
  f.contract.executionPolicy.tokenBudget=25;f.input.contractHash=canonicalHash(f.contract);
  const fake=join(f.root,'prompt-execute.mjs');
  // No --output-schema in prompt mode: the schema text rides in the prompt, so the phase is read from it.
  await writeFile(fake,`import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('9.9.9-fake');process.exit(0)}
if(!process.argv.includes('exec')){process.stdout.write(process.argv.includes('mcp')?'[]\\n':process.argv.includes('models')?'{"models":[]}\\n':'',()=>process.exit(0));await new Promise(()=>{})}
let prompt='';for await(const part of process.stdin)prompt+=part;
const args=process.argv,s=args.includes('--output-schema')?readFileSync(args[args.indexOf('--output-schema')+1],'utf8'):prompt;
const phase=s.includes('"approved"')?'verify':s.includes('"changedFiles"')?'execute':'plan';
if(phase==='verify')throw Error('verification must not enter');
if(phase==='execute')writeFileSync('answer.txt','complete\\n');
const value=phase==='plan'?{summary:'write answer',primaryTargetPaths:['answer.txt']}:{result:{changedFiles:['answer.txt'],diffPatch:'',commandOutputs:[],stdoutStderrLog:'done'}};
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(value));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
`);
  const sealed=await sealCodex({command:[process.execPath,fake],model:'fixture',sandbox:'workspace-write',budgetMode:'soft',timeoutMs:10000,killGraceMs:50});
  // structuredOutput is not part of agentConfigHash (prompt-schema spec): the worker reads it from this config.
  (sealed.config.installation as {structuredOutput?:string}).structuredOutput='prompt';
  f.input.claim.agent=sealed.selection;f.input.claim.configHash=sealed.configHash;
  await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/config.json'),Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/envelope.json'),Buffer.from(canonicalJson(f.input)));
  await writeAccepted(f.sourceDir,{protocol:1,envelopeHash:canonicalHash(f.input),executionId:'execution-1',configHash:sealed.configHash,generation:1,acceptedAt:new Date().toISOString(),launch:'intended',worker:null});
  await runControlWorker(['--source-dir',f.sourceDir,'--execution-id','execution-1','--nonce','nonce-1']);
  expect(JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8')).status).toBe('exhausted');
  if(!existsSync(join(f.runDir,'saved-result','exhausted-candidate.json')))throw new Error(await readFile(join(f.runDir,'saved-result','exhausted-candidate-unavailable.json'),'utf8').catch(()=> 'no candidate and no refusal'));
  expect(JSON.parse((await f.rpc('saved-result-evidence',{input:f.input})).stdout).capsule).not.toBeNull();
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('captures the final mechanical handoff event in an exhausted completion source',async()=>{
 const f=await resultFixture();
 try{
  const page=await exhaustedRun(f);
  expect(page.capsule).not.toBeNull();
  const capsule=JSON.parse(Buffer.from(JSON.parse((await f.rpc('read-saved-result-evidence',{input:f.input,capsuleRef:page.capsule,ref:page.capsule})).stdout).base64,'base64').toString());
  const ledger=JSON.parse((await readFile(savedResultPath(f.sourceDir,capsule.artifacts.usageLedger))).toString());
  expect(ledger.events).toHaveLength(3);
  expect(ledger.events[2]).toMatchObject({eventSeq:3,bucket:'handoff'});
  expect(capsule.usage.highWater).toBe(3);
  expect(capsule.artifacts.usageObservations).toHaveLength(3);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('does not turn an unpublished exhausted candidate into a worker failure',async()=>{
 const f=await resultFixture();try{
  await exhaustedRun(f);
  const path=join(f.runDir,'saved-result','exhausted-candidate.json');
  const candidate=JSON.parse(await readFile(path,'utf8'));
  await writeFile(path,canonicalJson({...candidate,published:null}));
  const {finalizeExhaustedCandidate}=await import('../../src/controller/exhaustedCompletion.js');
  await expect(finalizeExhaustedCandidate(f.runDir,3)).resolves.toBeUndefined();
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('does not publish a capsule whose saved high-water mark predates the final handoff',async()=>{
 const f=await resultFixture();try{
  await exhaustedRun(f);
  const path=join(f.runDir,'saved-result','exhausted-candidate.json');
  const candidate=JSON.parse(await readFile(path,'utf8'));
  await writeFile(path,canonicalJson({...candidate,usage:{...candidate.usage,highWater:2}}));
  const page=JSON.parse((await f.rpc('saved-result-evidence',{input:f.input})).stdout);
  expect(page.capsule).toBeNull();
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('accepts a published attempt tree with a tracked newline filename',async()=>{
 const f=await resultFixture();try{
  await writeFile(join(f.repo,'notes\n2026.txt'),'tracked\n');
  await git('/usr/bin/git',['add','-A'],{cwd:f.repo});
  await git('/usr/bin/git',['-c','user.name=fixture','-c','user.email=fixture@invalid','commit','-m','track newline name'],{cwd:f.repo});
  const page=await exhaustedRun(f),pkg=await packageOf(f,page.capsule);
  const answer=await readSavedResultSourceEligibility({source:f.input,sourceAttempt:1,packagePath:pkg.dir,packageHash:pkg.hash});
  expect(answer,JSON.stringify(answer)).toMatchObject({status:'eligible',authorityKind:'execution-complete-before-verification-v1'});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('keeps the published attempt verifiable after the workspace the source envelope names is gone',async()=>{
 const f=await resultFixture();
 try{
  const page=await exhaustedRun(f);
  expect(page.capsule).not.toBeNull();
  const pkg=await packageOf(f,page.capsule);
  // Orca deletes the source run's workspace after settling it; the source envelope still names that path.
  await rm(f.repo,{recursive:true,force:true});
  expect(existsSync(f.repo)).toBe(false);
  const answer=await readSavedResultSourceEligibility({source:f.input,sourceAttempt:1,packagePath:pkg.dir,packageHash:pkg.hash});
  expect(answer,JSON.stringify(answer)).toMatchObject({status:'eligible',authorityKind:'execution-complete-before-verification-v1',recoveryOf:{sourceRunId:'run-1',sourceAttempt:1}});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('answers the source eligible for a sealed exhausted completion and refuses a tampered tree binding',async()=>{
 const f=await resultFixture();
 try{
  f.contract.executionPolicy.tokenBudget=25;f.input.contractHash=canonicalHash(f.contract);
  const fake=join(f.root,'completed-execute.mjs');
  await writeFile(fake,`import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('9.9.9-fake');process.exit(0)}
if(!process.argv.includes('exec')){process.stdout.write(process.argv.includes('mcp')?'[]\\n':process.argv.includes('models')?'{"models":[]}\\n':'',()=>process.exit(0));await new Promise(()=>{})}
for await(const part of process.stdin){}
const args=process.argv,s=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
const phase=s.properties?.result?'execute':s.properties?.approved?'verify':'plan';
if(phase==='verify')throw Error('verification must not enter');
if(phase==='execute')writeFileSync('answer.txt','complete\\n');
const value=phase==='plan'?{summary:'write answer',primaryTargetPaths:['answer.txt']}:{result:{changedFiles:['answer.txt'],diffPatch:'',commandOutputs:[],stdoutStderrLog:'done'}};
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(value));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
`);
  const sealed=await sealCodex({command:[process.execPath,fake],model:'fixture',sandbox:'workspace-write',budgetMode:'soft',timeoutMs:10000,killGraceMs:50});
  f.input.claim.agent=sealed.selection;f.input.claim.configHash=sealed.configHash;
  await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/config.json'),Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/envelope.json'),Buffer.from(canonicalJson(f.input)));
  await writeAccepted(f.sourceDir,{protocol:1,envelopeHash:canonicalHash(f.input),executionId:'execution-1',configHash:sealed.configHash,generation:1,acceptedAt:new Date().toISOString(),launch:'intended',worker:null});
  await runControlWorker(['--source-dir',f.sourceDir,'--execution-id','execution-1','--nonce','nonce-1']);
  const page=JSON.parse((await f.rpc('saved-result-evidence',{input:f.input})).stdout);
  const pkg=await packageOf(f,page.capsule);
  const answer=await readSavedResultSourceEligibility({source:f.input,sourceAttempt:1,packagePath:pkg.dir,packageHash:pkg.hash});
  expect(answer,JSON.stringify(answer)).toMatchObject({status:'eligible',authorityKind:'execution-complete-before-verification-v1',recoveryOf:{sourceRunId:'run-1',sourceAttempt:1},rawExecutionTokens:15});
  // The published commit binding is checked against the repository, not trusted: a capsule naming another commit is refused.
  const manifest=JSON.parse((await readFile(join(pkg.dir,'package.json'),'utf8')).toString());
  const capFile=manifest.artifacts.find((a:any)=>a.ref.artifactId===page.capsule.artifactId).file;
  const cap=JSON.parse((await readFile(join(pkg.dir,capFile))).toString());
  cap.published.sha='1'.repeat(40);
  const forged=Buffer.from(canon(cap)),forgedHash=hashOf(cap);
  await writeFile(join(pkg.dir,capFile),forged,{mode:0o600});
  manifest.source={artifactId:`saved-result-${forgedHash}`,hash:forgedHash};
  for(const a of manifest.artifacts)if(a.ref.artifactId===page.capsule.artifactId)a.ref=manifest.source;
  await writeFile(join(pkg.dir,'package.json'),canon(manifest),{mode:0o600});
  const refused=await readSavedResultSourceEligibility({source:f.input,sourceAttempt:1,packagePath:pkg.dir,packageHash:hashOf(manifest)});
  expect(refused.status).toBe('unavailable');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('leaves a partial or a timed-out execute without a completion source',async()=>{
 for(const mode of ['partial','timeout'] as const){
  const f=await resultFixture();
  try{
   f.contract.executionPolicy.tokenBudget=25;f.contract.executionPolicy.perAttemptTimeoutMs=mode==='timeout'?600:10000;
   f.input.contractHash=canonicalHash(f.contract);
   const fake=join(f.root,'stopped-execute.mjs');
   await writeFile(fake,`import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('9.9.9-fake');process.exit(0)}
if(!process.argv.includes('exec')){process.stdout.write(process.argv.includes('mcp')?'[]\\n':process.argv.includes('models')?'{"models":[]}\\n':'',()=>process.exit(0));await new Promise(()=>{})}
for await(const part of process.stdin){}
const args=process.argv,s=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
const phase=s.properties?.result?'execute':s.properties?.approved?'verify':'plan';
if(phase==='verify')throw Error('verification must not enter');
if(phase==='execute'&&${JSON.stringify(mode)}==='timeout'){console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));await new Promise(r=>setTimeout(r,30000));}
if(phase==='execute')writeFileSync('answer.txt','partial\\n');
const value=phase==='plan'?{summary:'write answer',primaryTargetPaths:['answer.txt']}
 :${JSON.stringify(mode)}==='partial'?{result:{failureType:'error',changedFiles:['answer.txt']}}:{result:{changedFiles:['answer.txt']}};
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(value));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
`);
   const sealed=await sealCodex({command:[process.execPath,fake],model:'fixture',sandbox:'workspace-write',budgetMode:'soft',timeoutMs:2000,killGraceMs:50});
   f.input.claim.agent=sealed.selection;f.input.claim.configHash=sealed.configHash;
   await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/config.json'),Buffer.from(canonicalJson(sealed.config)));
   await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/envelope.json'),Buffer.from(canonicalJson(f.input)));
   await writeAccepted(f.sourceDir,{protocol:1,envelopeHash:canonicalHash(f.input),executionId:'execution-1',configHash:sealed.configHash,generation:1,acceptedAt:new Date().toISOString(),launch:'intended',worker:null});
   await runControlWorker(['--source-dir',f.sourceDir,'--execution-id','execution-1','--nonce','nonce-1']);
   expect(existsSync(join(f.runDir,'saved-result','exhausted-candidate.json')),mode).toBe(false);
   const page=JSON.parse((await f.rpc('saved-result-evidence',{input:f.input})).stdout);
   // A partial may still be a format failure's own capsule; what must never appear is the completion source.
   if(page.capsule!==null){
    const fetched=await f.rpc('read-saved-result-evidence',{input:f.input,capsuleRef:page.capsule,ref:page.capsule});
    expect(fetched.code,mode).toBe(0);
    expect(JSON.parse(Buffer.from(JSON.parse(fetched.stdout).base64,'base64').toString()).schema,mode).not.toBe('ccloop-execution-complete-before-verification-v1');
   }
  }finally{await rm(f.root,{recursive:true,force:true});}
 }
},60000);
