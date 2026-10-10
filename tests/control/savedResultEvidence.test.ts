import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { savedResultPath, savedResultIndexPath, writeSavedBytes } from "../../src/control/savedResultEvidence.js";
const exec=promisify(execFile);
import { afterEach, expect, it } from "vitest";
import { mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { resultFixture } from "./taskResultFixture.js";
import { sealCodex } from "./agentsFixture.js";
import { canonicalHash, canonicalJson } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { atomicReplacePrivateFile } from "../../src/control/paths.js";
import { runControlWorker } from "../../src/control/worker.js";
import { readUsageEvents } from "../../src/control/usage.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function world(mode="invalid") {
  const f=await resultFixture(); roots.push(f.root);
  const fake=join(f.root,"fake.mjs");
  await writeFile(join(f.repo,"delete.txt"),"delete me");
  await exec("/usr/bin/git",["add","delete.txt"],{cwd:f.repo});await exec("/usr/bin/git",["-c","core.hooksPath=/dev/null","commit","-m","tracked deletion fixture"],{cwd:f.repo});
  if(mode==="narrowed") {
    Object.assign(f.input,{protocol:4,tokenPolicy:{authoredTokenCeiling:1000,bindingCauses:["spend-cap"],inheritedUsage:{tokens:0,activeMs:0,attempts:0,sessions:0}}});
    f.input.claim.grant.work={tokens:100,activeMs:10000,attempts:1,sessions:1};
  }
  await writeFile(fake,`import {readFileSync,writeFileSync,unlinkSync,chmodSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
if(process.argv.includes('--version')){console.log('9.9.9-fake');process.exit(0);}
let prompt='';for await(const part of process.stdin)prompt+=part;
const args=process.argv, schema=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
const phase=schema.properties?.result?'execute':schema.properties?.approved?'verify':'plan';
if(phase==='verify')throw new Error('verifier must not enter');
const result=phase==='plan'?{summary:'write answer',primaryTargetPaths:['answer.txt']}:{result:{changedFiles:['answer.txt']}};
if(phase==='execute'){
 unlinkSync('delete.txt');
 writeFileSync('answer.txt','staged\\n');execFileSync('/usr/bin/git',['add','answer.txt']);writeFileSync('answer.txt','unstaged\\n');
 writeFileSync('new.sh','#!/bin/sh\\necho saved\\n');chmodSync('new.sh',0o755);
 writeFileSync('.gitignore','ignored.txt\\n');writeFileSync('ignored.txt','protected');
 if(${JSON.stringify(mode)}==='capture-failure')execFileSync('mkfifo',['pipe']);
 if(${JSON.stringify(mode)}==='rewrite-runtime') {const path=${JSON.stringify(join(f.runDir,'loop-contract.json'))};const c=JSON.parse(readFileSync(path,'utf8'));c.executionPolicy.tokenBudget=999;writeFileSync(path,JSON.stringify(c));}
 if(${JSON.stringify(mode)}==='rewrite-config') {const path=${JSON.stringify(join(f.sourceDir,'control/config.json'))};const c=JSON.parse(readFileSync(path,'utf8'));c.installation.command=[process.execPath,'/not-the-executed-provider.mjs'];writeFileSync(path,JSON.stringify(c));}
}
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(result));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
`);
  const sealed=await sealCodex({command:[process.execPath,fake],model:'fixture',sandbox:'workspace-write',budgetMode:'soft',timeoutMs:10000,killGraceMs:50});
  f.input.claim.agent=sealed.selection;f.input.claim.configHash=sealed.configHash;
  f.input.contractHash='b'.repeat(64); // frozen authority differs from narrowed accepted/runtime bytes
  await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/config.json'),Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,'control/envelope.json'),Buffer.from(canonicalJson(f.input)));
  await writeAccepted(f.sourceDir,{protocol:1,envelopeHash:canonicalHash(f.input),executionId:'execution-1',configHash:sealed.configHash,generation:1,acceptedAt:new Date().toISOString(),launch:'intended',worker:null});
  await runControlWorker(['--source-dir',f.sourceDir,'--execution-id','execution-1','--nonce','nonce-1']);
  return f;
}
async function jsonRef(f:Awaited<ReturnType<typeof world>>,capsuleRef:any,ref:any){
 const r=await f.rpc('read-saved-result-evidence',{input:f.input,capsuleRef,ref});expect(r.code,r.stderr).toBe(0);
 return JSON.parse(Buffer.from(JSON.parse(r.stdout).base64,'base64').toString());
}
it('captures original attempt, usage, full snapshot and exact runtime bytes before cleanup without changing v3',async()=>{
 const f=await world();const response=await f.rpc('saved-result-evidence',{input:f.input});expect(response.code,response.stderr).toBe(0);
 const page=JSON.parse(response.stdout);expect(page.capsule,await readFile(join(f.runDir,"events.jsonl"),"utf8")).not.toBeNull();expect(page.attempt).toBe(1);
 const c=await jsonRef(f,page.capsule,page.capsule);
 expect(c).toMatchObject({schema:'ccloop-execution-format-failure-v1',identity:{runId:'run-1',executionId:'execution-1',envelopeHash:canonicalHash(f.input)},attempt:1,frozenContractHash:'b'.repeat(64),decoder:'strict-execution-v1',executor:{kind:'codex',configHash:f.input.claim.configHash},usage:{tokenUsage:15},verifier:{entered:false},completeness:{complete:true}});
 expect(await jsonRef(f,page.capsule,c.artifacts.runtimeContract)).toEqual(f.contract);
 expect(c.artifacts.runtimeContract.hash).not.toBe(c.frozenContractHash);
 const snap=await jsonRef(f,page.capsule,c.snapshot);
 expect(snap.files.find((x:any)=>x.path==='new.sh')).toMatchObject({mode:0o755,kind:'file'});
 expect(snap.files.map((x:any)=>x.path)).toEqual(['.gitignore','answer.txt','ignored.txt','new.sh']);
 expect(snap.deleted).toEqual(['delete.txt']);expect(snap.head).toBe(c.attemptStartHead);expect(c.resolvedBase).toBe(c.attemptStartHead);expect(snap.index).toBeTruthy();expect(snap.bundle).toBeTruthy();
 const output=await f.rpc('read-saved-result-evidence',{input:f.input,capsuleRef:page.capsule,ref:snap.files.find((x:any)=>x.path==='answer.txt').ref});
 expect(Buffer.from(JSON.parse(output.stdout).base64,'base64').toString()).toBe('unstaged\n');
 const bundleResponse=await f.rpc('read-saved-result-evidence',{input:f.input,capsuleRef:page.capsule,ref:snap.bundle});
 const bundlePath=join(f.root,'restore.bundle');await writeFile(bundlePath,Buffer.from(JSON.parse(bundleResponse.stdout).base64,'base64'));
 const restored=join(f.root,'restored');await exec('/usr/bin/git',['clone','--no-checkout',bundlePath,restored]);
 await exec('/usr/bin/git',['fetch',bundlePath,snap.bundleRefName],{cwd:restored});
 await exec('/usr/bin/git',['checkout','--detach',snap.indexCommit],{cwd:restored});
 expect(await readFile(join(restored,'answer.txt'),'utf8')).toBe('staged\n');
 expect((await exec('/usr/bin/git',['rev-parse',`${snap.indexCommit}^{tree}`],{cwd:restored})).stdout.trim()).toBe(snap.indexTree);
 expect(await readdir(join(f.runDir,'worktrees'))).toEqual([]);
 const usage=await readUsageEvents(f.sourceDir);expect(usage.filter(e=>e.bucket==='work').map(e=>e.cumulative?.tokens)).toEqual([15,30]);
 expect(usage.filter(e=>e.bucket==='work').at(-1)?.byModel).toEqual([{model:'fixture',input:20,output:10,cacheRead:0,cacheWrite:0}]);
 const legacy=await f.rpc('collect',{input:f.input,afterSeq:0});expect(legacy.code,legacy.stderr).toBe(0);
 console.log('TASK5_V3_COLLECTION:'+legacy.stdout.trim());
 const collected=JSON.parse(legacy.stdout);expect(Object.keys(collected)).toEqual(['events','candidate','terminal','progress']);expect(collected.terminal.status).toBe('failed');
 expect(Object.keys(collected.terminal)).toEqual(['status','currentAttempt','attemptsUsed','lastTransitionAt','waitingOnHuman','stopReason','budgetSnapshot','recentFailures']);
 expect(Object.hasOwn(collected.candidate,'capsule')).toBe(false);
 expect(JSON.parse((await f.rpc('features',{})).stdout)).toEqual({protocol:1,tokenPolicy:'optional-v1'});
 const foreign=await writeSavedBytes(f.sourceDir,Buffer.from('private foreign bytes'),async()=>{});
 expect((await f.rpc('read-saved-result-evidence',{input:f.input,capsuleRef:page.capsule,ref:foreign})).code).not.toBe(0);
 const changed=structuredClone(f.input);changed.claim.generation=2;
 expect((await f.rpc('saved-result-evidence',{input:changed})).code).not.toBe(0);
 await writeFile(savedResultPath(f.sourceDir,snap.files[0].ref),'tampered');
 expect((await f.rpc('saved-result-evidence',{input:f.input})).stderr).toContain('control-saved-result-hash-mismatch');
},30000);
it('records capture failure as unavailable and preserves original failed outcome',async()=>{
 const f=await world('capture-failure');const r=await f.rpc('saved-result-evidence',{input:f.input});expect(r.code,r.stderr).toBe(0);
 expect(JSON.parse(r.stdout)).toMatchObject({capsule:null,reason:'saved-result-snapshot-entry-unsupported'});
 expect(JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8')).status).toBe('failed');
},30000);
it('missing original provider evidence is unavailable rather than reconstructed',async()=>{
 const f=await resultFixture();roots.push(f.root);const r=await f.rpc('saved-result-evidence',{input:f.input});
 expect(r.code,r.stderr).toBe(0);expect(JSON.parse(r.stdout)).toMatchObject({capsule:null,reason:'saved-result-original-evidence-unavailable'});
});

it('binds frozen authority separately from a genuinely narrowed protocol4 runtime contract',async()=>{
 const f=await world('narrowed');const r=await f.rpc('saved-result-evidence',{input:f.input});expect(r.code,r.stderr).toBe(0);
 const page=JSON.parse(r.stdout);expect(page.capsule,await readFile(join(f.runDir,'events.jsonl'),'utf8')).not.toBeNull();
 const c=await jsonRef(f,page.capsule,page.capsule);
 const accepted=await jsonRef(f,page.capsule,c.artifacts.acceptedContract),actual=await jsonRef(f,page.capsule,c.artifacts.runtimeContract);
 expect(accepted.executionPolicy.tokenBudget).toBe(1000);expect(actual.executionPolicy.tokenBudget).toBe(100);
 expect(accepted.executionPolicy.maxAttempts).toBe(2);expect(actual.executionPolicy.maxAttempts).toBe(1);
 expect(c.frozenContractHash).toBe('b'.repeat(64));expect(actual.objective).toEqual(accepted.objective);
},30000);

it('refuses a hash-valid capsule with another source identity',async()=>{
 const f=await world();const page=JSON.parse((await f.rpc('saved-result-evidence',{input:f.input})).stdout);
 const c=await jsonRef(f,page.capsule,page.capsule);c.identity.runId='foreign-run';
 const forged=await writeSavedBytes(f.sourceDir,Buffer.from(canonicalJson(c)),async()=>{});
 await writeFile(savedResultIndexPath(f.sourceDir),canonicalJson({...page,capsule:forged}));
 expect((await f.rpc('saved-result-evidence',{input:f.input})).stderr).toContain('control-saved-result-authority-invalid');
},30000);
it('rejects symlinked evidence namespaces even when referenced bytes exist',async()=>{
 const f=await world();const {rename}=await import('node:fs/promises');
 await rename(join(f.sourceDir,'control','saved-result-evidence'),join(f.sourceDir,'saved'));
 await symlink(join(f.sourceDir,'saved'),join(f.sourceDir,'control','saved-result-evidence'));
 expect((await f.rpc('saved-result-evidence',{input:f.input})).code).not.toBe(0);
},30000);
it('unsupported provider original evidence gets an explicit unavailable reason',async()=>{
 const f=await resultFixture();roots.push(f.root);
 await writeFile(join(f.sourceDir,'control/config.json'),JSON.stringify({kind:'claude'}));
 const r=await f.rpc('saved-result-evidence',{input:f.input});expect(r.code,r.stderr).toBe(0);
 expect(JSON.parse(r.stdout)).toMatchObject({capsule:null,reason:'saved-result-provider-original-evidence-unsupported'});
});

it.each([['rewrite-runtime','saved-result-runtime-contract-mismatch'],['rewrite-config','saved-result-config-mismatch']])('refuses %s bytes that differ from the actual execution authority',async(mode,reason)=>{
 const f=await world(mode);const r=await f.rpc('saved-result-evidence',{input:f.input});expect(r.code,r.stderr).toBe(0);
 expect(JSON.parse(r.stdout)).toMatchObject({capsule:null,reason});
 expect(JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8')).status).toBe('failed');
},30000);

it('recursively serves original ledger refs only through exact capsule aliases and validates copied bytes',async()=>{
 const f=await world();const page=JSON.parse((await f.rpc('saved-result-evidence',{input:f.input})).stdout);
 const c=await jsonRef(f,page.capsule,page.capsule),ledger=await jsonRef(f,page.capsule,c.artifacts.usageLedger);
 for(const event of ledger.events){
   const observation=await jsonRef(f,page.capsule,event.source);expect(observation.attempt).toBe(1);
 }
 const alias=c.artifacts.usageObservations[0];
 const sameHashUndeclared={artifactId:'evidence-undeclared',hash:alias.source.hash};
 expect((await f.rpc('read-saved-result-evidence',{input:f.input,capsuleRef:page.capsule,ref:sameHashUndeclared})).stderr).toContain('control-saved-result-authority-invalid');
 const other=await world();const otherPage=JSON.parse((await other.rpc('saved-result-evidence',{input:other.input})).stdout);
 expect((await f.rpc('read-saved-result-evidence',{input:f.input,capsuleRef:otherPage.capsule,ref:alias.source})).stderr).toContain('control-saved-result-authority-invalid');
 await writeFile(savedResultPath(f.sourceDir,alias.copy),'tampered copied observation');
 expect((await f.rpc('read-saved-result-evidence',{input:f.input,capsuleRef:page.capsule,ref:alias.source})).stderr).toContain('control-saved-result-hash-mismatch');
},30000);
