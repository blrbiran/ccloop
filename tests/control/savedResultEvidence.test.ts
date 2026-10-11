import * as workspace from "../../src/workspace/worktreeManager.js";
import * as fs from "node:fs/promises";
import { buildBundle } from "./optionalMaterializeFixture.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { savedResultPath, savedResultIndexPath, writeSavedBytes } from "../../src/control/savedResultEvidence.js";
const exec=promisify(execFile);
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rm, writeFile, symlink, cp, chmod, chown } from "node:fs/promises";
import { join } from "node:path";
import { resultFixture } from "./taskResultFixture.js";
import { sealCodex } from "./agentsFixture.js";
import { canonicalHash, canonicalJson } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { atomicReplacePrivateFile } from "../../src/control/paths.js";
import { runControlWorker } from "../../src/control/worker.js";
import { readUsageEvents } from "../../src/control/usage.js";
vi.mock("node:fs/promises",async importOriginal=>{
 const actual=await importOriginal<typeof fs>();return {...actual,readdir:vi.fn(actual.readdir),writeFile:vi.fn(actual.writeFile)};
});
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function world(mode="invalid") {
  const f=await resultFixture(); roots.push(f.root);
  const fake=join(f.root,"fake.mjs");
  let checkpointHead:string|undefined;
  if(mode.startsWith("continuation")) {
    const bundle=await buildBundle();roots.push(bundle.root);
    const bundlePath=join(f.sourceDir,"input","cp1");await mkdir(join(f.sourceDir,"input"),{recursive:true});await cp(bundle.input.bundlePath,bundlePath,{recursive:true});
    f.input.inputCheckpoint={...bundle.input,bundlePath};f.input.work.targetRepo=bundle.targetRepo;f.contract.context.repoPath=bundle.targetRepo;
    checkpointHead=String(bundle.snapshot.head);
    if(mode==="continuation-immutable")f.input.work.base=checkpointHead;
  }
  await writeFile(join(f.repo,"delete.txt"),"delete me");
  await exec("/usr/bin/git",["add","delete.txt"],{cwd:f.repo});await exec("/usr/bin/git",["-c","core.hooksPath=/dev/null","commit","-m","tracked deletion fixture"],{cwd:f.repo});
  if(mode==="narrowed") {
    Object.assign(f.input,{protocol:4,tokenPolicy:{authoredTokenCeiling:1000,bindingCauses:["spend-cap"],inheritedUsage:{tokens:0,activeMs:0,attempts:0,sessions:0}}});
    f.input.claim.grant.work={tokens:100,activeMs:10000,attempts:1,sessions:1};
  }
  await writeFile(fake,`import {readFileSync,writeFileSync,unlinkSync,chmodSync,mkdirSync,statSync,chownSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
if(process.argv.includes('--version')){console.log('9.9.9-fake');process.exit(0);}
let prompt='';for await(const part of process.stdin)prompt+=part;
const args=process.argv, schema=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
const phase=schema.properties?.result?'execute':schema.properties?.approved?'verify':'plan';
const attempt=Number(process.cwd().split('/').at(-1).split('-').at(-1));
if(phase==='verify' && ${JSON.stringify(mode)}!=='retry')throw new Error('verifier must not enter');
if(phase==='verify')execFileSync('/usr/bin/git',['-C',${JSON.stringify(f.repo)},'-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','target moves before ordinary retry']);
const result=phase==='plan'?{summary:'write answer',primaryTargetPaths:['answer.txt']}:phase==='verify'?{approved:false,rejectCategory:'retry-fixture',primaryTargetPaths:['answer.txt'],failingCommand:null,safeToRetry:true,evidence:[],pauseSignals:[],stopSignals:[]}:${JSON.stringify(mode)}==='retry'&&attempt===1?{result:{changedFiles:['answer.txt'],diffPatch:'',commandOutputs:[],stdoutStderrLog:'done'}}:{result:{changedFiles:['answer.txt']}};
if(phase==='execute' && !${JSON.stringify(mode)}.startsWith('continuation')){
 unlinkSync('delete.txt');
 writeFileSync('answer.txt','staged\\n');execFileSync('/usr/bin/git',['add','answer.txt']);writeFileSync('answer.txt','unstaged\\n');
 writeFileSync('new.sh','#!/bin/sh\\necho saved\\n');chmodSync('new.sh',0o755);
 writeFileSync('.gitignore','ignored.txt\\n');writeFileSync('ignored.txt','protected');
 mkdirSync('regular-dir');chmodSync('regular-dir',0o755);chmodSync('.',0o755);
 if(${JSON.stringify(mode)}==='capture-failure')execFileSync('mkfifo',['pipe']);
 const special=${JSON.stringify(mode)}.match(/^special-(file|directory|root)-(\\d+)$/);
 if(special){const path=special[1]==='file'?'new.sh':special[1]==='root'?'.':'special-dir';if(special[1]==='directory')mkdirSync(path);const mode=Number(special[2]);chownSync(path,process.getuid(),process.getgid());chmodSync(path,mode);if((statSync(path).mode&0o7777)!==mode)throw new Error('special mode setup failed');}
 if(${JSON.stringify(mode)}==='rewrite-runtime') {const path=${JSON.stringify(join(f.runDir,'loop-contract.json'))};const c=JSON.parse(readFileSync(path,'utf8'));c.executionPolicy.tokenBudget=999;writeFileSync(path,JSON.stringify(c));}
 if(${JSON.stringify(mode)}==='rewrite-config') {const path=${JSON.stringify(join(f.sourceDir,'control/config.json'))};const c=JSON.parse(readFileSync(path,'utf8'));c.installation.command=[process.execPath,'/not-the-executed-provider.mjs'];writeFileSync(path,JSON.stringify(c));}
}
if(phase==='execute' && ${JSON.stringify(mode)}.startsWith('continuation'))writeFileSync(${JSON.stringify(join(f.root,'continuation-head'))},execFileSync('/usr/bin/git',['rev-parse','HEAD']));
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
  return {...f,checkpointHead};
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
 expect(snap.rootMode).toBe(0o755);expect(snap.directories).toContainEqual({path:'regular-dir',mode:0o755});
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
 const collected=JSON.parse(legacy.stdout);expect(Object.keys(collected)).toEqual(['events','candidate','terminal','progress']);expect(collected.terminal.status).toBe('failed');
 expect(Object.keys(collected.terminal)).toEqual(['status','currentAttempt','attemptsUsed','lastTransitionAt','waitingOnHuman','stopReason','budgetSnapshot','recentFailures']);
 expect(Object.hasOwn(collected.candidate,'capsule')).toBe(false);
 expect(JSON.parse((await f.rpc('features',{})).stdout)).toEqual({protocol:1,tokenPolicy:'optional-v1',savedResultRecovery:'v1'});
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

it.each(["before", "after"])("fix I1 freezes the materialized base across target movement %s workspace creation",async when=>{
 const create=workspace.createAttemptWorkspace;let initializedHead="";
 vi.spyOn(workspace,"createAttemptWorkspace").mockImplementation(async(...args)=>{
  initializedHead=(await exec("/usr/bin/git",["rev-parse","HEAD"],{cwd:args[0]})).stdout.trim();
  const move=()=>exec("/usr/bin/git",["-c","core.hooksPath=/dev/null","commit","--allow-empty","-m","concurrent target movement"],{cwd:args[0]});
  if(when==="before")await move();const result=await create(...args);if(when==="after")await move();return result;
 });
 const f=await world();const page=JSON.parse((await f.rpc("saved-result-evidence",{input:f.input})).stdout);expect(page.capsule).not.toBeNull();
 const c=await jsonRef(f,page.capsule,page.capsule);
 expect(c.resolvedBase).toBe(initializedHead);expect(c.attemptStartHead).toBe(initializedHead);
 expect((await exec("/usr/bin/git",["rev-parse","HEAD"],{cwd:f.repo})).stdout.trim()).not.toBe(initializedHead);
},30000);
it("fix I1 keeps a distinct continuation HEAD but refuses missing original-base authority",async()=>{
 const f=await world("continuation");
 expect((await readFile(join(f.root,"continuation-head"),"utf8")).trim()).toBe(f.checkpointHead);
 expect((await exec("/usr/bin/git",["rev-parse","HEAD"],{cwd:f.input.work.targetRepo})).stdout.trim()).not.toBe(f.checkpointHead);
 const r=await f.rpc("saved-result-evidence",{input:f.input});expect(r.code,r.stderr).toBe(0);
 expect(JSON.parse(r.stdout)).toMatchObject({capsule:null,reason:"saved-result-original-base-unavailable"});
 expect(JSON.parse(await readFile(join(f.runDir,"loop-state.json"),"utf8")).status).toBe("failed");
},30000);
it.each([["file",0o4755],["file",0o2755],["directory",0o2755],["directory",0o1755],["root",0o1755]])("fix I2 refuses unsupported %s mode %i before complete capture",async(kind,mode)=>{
 const f=await world(`special-${kind}-${mode}`);const r=await f.rpc("saved-result-evidence",{input:f.input});expect(r.code,r.stderr).toBe(0);
 expect(JSON.parse(r.stdout)).toMatchObject({capsule:null,reason:"saved-result-mode-unsupported"});
},30000);
it.each(["file","directory"])("fix I2 refuses %s special bits introduced during the stability pass",async kind=>{
 const readDirectory=fs.readdir;let passes=0;
 vi.spyOn(fs,"readdir").mockImplementation((async(path:any,...args:any[])=>{
  if(String(path).endsWith("/run/worktrees/attempt-1")&&++passes===2){
   const entry=kind==="file"?join(String(path),"new.sh"):join(String(path),"regular-dir");
   await chown(entry,process.getuid!(),process.getgid!());await chmod(entry,kind==="file"?0o4755:0o2755);
  }
  return (readDirectory as any)(path,...args);
 }) as typeof fs.readdir);
 const f=await world();const r=await f.rpc("saved-result-evidence",{input:f.input});expect(r.code,r.stderr).toBe(0);
 expect(JSON.parse(r.stdout)).toMatchObject({capsule:null,reason:"saved-result-mode-unsupported"});expect(passes).toBeGreaterThanOrEqual(2);
},30000);

it("fix I2 refuses root special bits introduced between capture passes",async()=>{
 const write=fs.writeFile;let introduced=false;
 vi.spyOn(fs,"writeFile").mockImplementation((async(path:any,...args:any[])=>{
  const result=await (write as any)(path,...args);
  if(String(path).includes("/saved-result/snapshot-")&&String(path).endsWith("/.git/index")){
   const run=String(path).split("/saved-result/snapshot-")[0];await chmod(join(run,"worktrees/attempt-1"),0o1755);introduced=true;
  }
  return result;
 }) as typeof fs.writeFile);
 const f=await world();expect(introduced).toBe(true);
 const r=await f.rpc("saved-result-evidence",{input:f.input});expect(r.code,r.stderr).toBe(0);
 expect(JSON.parse(r.stdout)).toMatchObject({capsule:null,reason:"saved-result-mode-unsupported"});
},30000);

it("fix I1 recognizes an immutable checkpoint base without widening legacy context authority",async()=>{
 const f=await world("continuation-immutable");expect((await readFile(join(f.root,"continuation-head"),"utf8")).trim()).toBe(f.checkpointHead);
 const r=await f.rpc("saved-result-evidence",{input:f.input});expect(r.code,r.stderr).toBe(0);
 expect(JSON.parse(r.stdout)).toMatchObject({capsule:null,reason:"saved-result-runtime-contract-mismatch"});
},30000);

it("fix I1 preserves ordinary retry choice while binding each attempt's actual origin",async()=>{
 const f=await world("retry"),r=await f.rpc("saved-result-evidence",{input:f.input});expect(r.code,r.stderr).toBe(0);
 const page=JSON.parse(r.stdout);expect(page.capsule,await readFile(join(f.runDir,"events.jsonl"),"utf8")).not.toBeNull();
 const c=await jsonRef(f,page.capsule,page.capsule),current=(await exec("/usr/bin/git",["rev-parse","HEAD"],{cwd:f.repo})).stdout.trim();
 expect(c.attempt).toBe(2);expect(c.resolvedBase).toBe(current);expect(c.attemptStartHead).toBe(current);
 expect((await exec("/usr/bin/git",["rev-parse","HEAD^"],{cwd:f.repo})).stdout.trim()).not.toBe(c.resolvedBase);
},30000);

it("Task6 never turns a genuine current malformed capsule into an invented normalized execution",async()=>{
 const f=await world(),page=JSON.parse((await f.rpc("saved-result-evidence",{input:f.input})).stdout);
 const packagePath=join(f.root,"source-probe");await mkdir(packagePath,{mode:0o700});
 const artifacts:any[]=[],seen=new Set<string>();
 const visit=async(ref:any):Promise<void>=>{
  if(seen.has(ref.artifactId))return;seen.add(ref.artifactId);
  const response=await f.rpc("read-saved-result-evidence",{input:f.input,capsuleRef:page.capsule,ref});expect(response.code,response.stderr).toBe(0);
  const bytes=Buffer.from(JSON.parse(response.stdout).base64,"base64"),file=ref.artifactId+".bin";await writeFile(join(packagePath,file),bytes,{mode:0o600});artifacts.push({ref,file});
  let decoded:unknown;try{decoded=JSON.parse(bytes.toString());}catch{return;}
  const walk=async(value:any):Promise<void>=>{if(value===null||typeof value!=="object")return;if(typeof value.artifactId==="string"&&typeof value.hash==="string"){await visit(value);return;}for(const child of Object.values(value))await walk(child);};
  await walk(decoded);
 };
 await visit(page.capsule);
 const manifest={schema:"ccloop-saved-result-source-package-v1",authorityKind:"execution-format-failure-v1",source:page.capsule,artifacts},bytes=Buffer.from(canonicalJson(manifest));
 await writeFile(join(packagePath,"package.json"),bytes,{mode:0o600});
 const {createHash}=await import("node:crypto"),{readSavedResultSourceEligibility}=await import("../../src/control/savedResultRecovery.js");
 expect(await readSavedResultSourceEligibility({source:f.input,sourceAttempt:page.attempt,packagePath,packageHash:createHash("sha256").update(bytes).digest("hex")})).toEqual({status:"unavailable",reason:"execution-format-invalid"});
},30000);
