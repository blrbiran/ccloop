import { describe, expect, it } from "vitest";
import { parseControlRequest } from "../../src/control/protocol.js";
import { resultFixture } from "./taskResultFixture.js";
import { rm } from "node:fs/promises";

describe("saved result recovery wire",()=>{
 it("accepts only an explicit protocol4 immutable recovery package without checkpoint",async()=>{
  const f=await resultFixture();
  try {
   const input={...f.input,protocol:4,mode:"verify-saved-result",savedResultRecovery:{packagePath:f.sourceDir+"/input/recovery",packageHash:"a".repeat(64),admissionHash:"b".repeat(64),recoveryOf:{sourceRunId:"old-run",sourceAttempt:1,capsuleHash:"c".repeat(64),snapshotHash:"d".repeat(64),normalizedExecutionHash:"e".repeat(64)}}};
   expect(parseControlRequest("accept",input)).toEqual(input);
   expect(()=>parseControlRequest("accept",{...input,protocol:3})).toThrow();
   expect(()=>parseControlRequest("accept",{...input,mode:undefined})).toThrow();
   expect(()=>parseControlRequest("accept",{...input,savedResultRecovery:undefined})).toThrow();
   expect(()=>parseControlRequest("accept",{...input,inputCheckpoint:{predecessorRunId:"old-run",checkpointId:"cp",checkpointHash:"a".repeat(64),bundlePath:"/tmp/cp"}})).toThrow();
  }finally{await rm(f.root,{recursive:true,force:true});}
 });
});

import {readSavedResultEligibility} from "../../src/control/savedResultRecovery.js";
import {savedRecoveryFixture} from "./savedRecoveryFixture.js";
it("qualifies a genuine old bare execution only with its complete published archive and accounted admission",async()=>{
 const f=await savedRecoveryFixture();try {
  expect(await readSavedResultEligibility(f.input)).toMatchObject({status:"eligible",authorityKind:"legacy-published-candidate-v1",normalizedExecutionHash:f.admission.recoveryOf.normalizedExecutionHash});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
it.each([
 ['semantic', 'saved-result-source-stale'],['hash','saved-result-source-hash-mismatch'],['fence','saved-result-source-stale'],
 ['settlement','saved-result-usage-unsettled'],['lineage','saved-result-lineage-invalid'],['owner','saved-result-source-stale'],
] as const)('refuses %s before runtime creation',async(kind,reason)=>{
 const f=await savedRecoveryFixture();try{
  if(kind==='semantic')f.input.work.contract.objective.goal='different authority';
  if(kind==='hash'){const path=join(f.input.savedResultRecovery!.packagePath,f.manifest.artifacts[0]!.file);await writeFile(path,Buffer.concat([await readFile(path),Buffer.from('\n')]));}
  if(kind==='fence')await rm(join(f.sourceDir,'control/recovery-fence.json'));
  if(kind==='settlement'){f.admission.accounting.settlement=null;f.admission.accounting.receipt=null;await f.seal();}
  if(kind==='lineage'){(f.admission as any).funding.inheritedUsage={...(f.admission as any).funding.inheritedUsage,attempts:0};await f.seal();}
  if(kind==='owner')f.input.claim.ownerToken='foreign';
  expect(await readSavedResultEligibility(f.input)).toEqual({status:'unavailable',reason});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

import {readSavedResultSourceEligibility} from "../../src/control/savedResultRecovery.js";
import {canonicalHash,canonicalJson} from "../../src/control/protocol.js";
import {mkdir,cp,stat,readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
it("source-only eligibility reads genuine immutable evidence without a new claim, admission, fence or provider",async()=>{
 const f=await savedRecoveryFixture();try{
  const packagePath=join(f.root,'source-probe');await mkdir(packagePath,{mode:0o700});
  const {admission,...rest}=f.manifest;
  const manifest={...rest,schema:'ccloop-saved-result-source-package-v1'};
  for(const e of manifest.artifacts)await cp(join(f.input.savedResultRecovery!.packagePath,e.file),join(packagePath,e.file));
  const bytes=Buffer.from(canonicalJson(manifest));await writeFile(join(packagePath,'package.json'),bytes,{mode:0o600});
  await rm(join(f.sourceDir,'control/recovery-fence.json'));
  const input={source:f.source,sourceAttempt:1,packagePath,packageHash:createHash('sha256').update(bytes).digest('hex')};
  const before=await readdir(f.sourceDir);const result=await f.rpc('saved-result-source-eligibility',{input});
  expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({status:'eligible',rawExecutionTokens:15,recoveryOf:f.admission.recoveryOf});
  expect(await readdir(f.sourceDir)).toEqual(before);await expect(stat(f.runDir)).rejects.toMatchObject({code:'ENOENT'});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

async function rewriteArchive(f:Awaited<ReturnType<typeof savedRecoveryFixture>>){
 const ref=await f.put(f.archive);f.manifest.source=ref;f.admission.recoveryOf.capsuleHash=ref.hash;await f.seal();
}
it.each(['owner','config','partial-snapshot','ambiguous-call','verification-entered','normalization','base'] as const)('rejects hash-valid legacy %s evidence without reconstructing authority',async kind=>{
 const f=await savedRecoveryFixture();try{
  const replace=async(path:string,value:unknown)=>{const entry=f.archive.logs.find((e:any)=>e.path===path);entry.ref=await f.put(value);};
  if(kind==='owner')await replace('run/owner-record.json',{...f.log('run/owner-record.json'),currentProcessInstanceId:'pid:1:other'});
  if(kind==='config'){const config=f.log('control/config.json');config.selection.model='different';await replace('control/config.json',config);}
  if(kind==='partial-snapshot'){const snap=JSON.parse(f.bytes.get(f.archive.snapshot.artifactId)!.toString());snap.missing=['missing-file'];f.archive.snapshot=await f.put(snap);f.admission.recoveryOf.snapshotHash=f.archive.snapshot.hash;}
  if(kind==='ambiguous-call')f.archive.logs.push({path:'run/codex/1/execute/call-other',kind:'directory',mode:0o700});
  if(kind==='verification-entered')f.archive.logs.push({path:'run/codex/1/verify',kind:'directory',mode:0o700});
  if(kind==='normalization'){const entry=f.archive.logs.find((e:any)=>/\/execute\/call-[^/]+\/final.json$/.test(e.path));entry.ref=await f.put(Buffer.from('{"changedFiles":[]}'));}
  if(kind==='base'){
   const source=structuredClone(f.source);source.work.base='f'.repeat(40);await replace('control/envelope.json',source);
   const hash=canonicalHash(source);await replace('control/accepted.json',{...f.log('control/accepted.json'),envelopeHash:hash});f.admission.source.envelopeHash=hash;
  }
  await rewriteArchive(f);
  expect((await readSavedResultEligibility(f.input)).status).toBe('unavailable');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('refuses a standard clone archive whose bundle lost the genuine namespaced attempt ref',async()=>{
 const f=await savedRecoveryFixture();try{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),exec=promisify(execFile);
  const snap=JSON.parse(f.bytes.get(f.archive.snapshot.artifactId)!.toString()),bundle=join(f.root,'original.bundle'),clone=join(f.root,'ordinary-clone'),out=join(f.root,'standard.bundle');
  await writeFile(bundle,f.bytes.get(snap.bundle.artifactId)!);
  await exec('/usr/bin/git',['clone','--no-checkout',bundle,clone]);await exec('/usr/bin/git',['checkout','--detach',snap.head],{cwd:clone});
  await exec('/usr/bin/git',['bundle','create',out,'--all','HEAD'],{cwd:clone});snap.bundle=await f.put(await readFile(out));f.archive.snapshot=await f.put(snap);f.admission.recoveryOf.snapshotHash=f.archive.snapshot.hash;
  await rewriteArchive(f);
  expect(await readSavedResultEligibility(f.input)).toEqual({status:'unavailable',reason:'saved-result-legacy-ref-missing'});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it('legacy funding keeps historical authority, exact inherited work and a separate fresh grant/derived total',async()=>{
 const f=await savedRecoveryFixture();try{
  expect(f.input.tokenPolicy).toBeUndefined();
  expect((f.admission as any).funding).toMatchObject({kind:'legacy-fresh-grant-v1',historicalPolicy:{authoredWork:{tokens:1000}},inheritedUsage:{tokens:1000,attempts:2,sessions:1},freshGrant:{work:{tokens:1000}},fundedTotal:{tokens:2000,attempts:4,sessions:2}});
  expect((await readSavedResultEligibility(f.input)).status).toBe('eligible');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it.each(['tokens','activeMs','attempts','sessions'] as const)('optional cumulative funding refuses exhausted authored %s instead of resetting inherited usage',async dimension=>{
 const f=await savedRecoveryFixture();try{
  const inherited=f.admission.funding.inheritedUsage,authored={tokens:2000,activeMs:60000,attempts:4,sessions:2};authored[dimension]=inherited[dimension];
  const historicalPolicy={...f.admission.funding.historicalPolicy,accountingMode:'optional-v1' as const,authoredWork:authored};
  historicalPolicy.authority=await f.put({schema:'ccloop-recovery-policy-authority-v1',groupId:f.source.claim.groupId,workItemId:f.source.claim.workItemId,taskId:f.source.claim.taskId,sourceRunId:f.source.claim.runId,contractHash:f.source.contractHash,accountingMode:'optional-v1',authoredWork:authored});
  f.admission.funding={...f.admission.funding,kind:'optional-cumulative-v1',historicalPolicy};
  f.input.tokenPolicy={authoredTokenCeiling:authored.tokens,bindingCauses:['task'],inheritedUsage:inherited};await f.seal();
  expect(await readSavedResultEligibility(f.input)).toEqual({status:'unavailable',reason:'saved-result-authored-budget-exhausted'});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it.each(['snapshot','task','total','generic-policy'] as const)('refuses a changed %s recovery authority even when private package hashes are renewed',async kind=>{
 const f=await savedRecoveryFixture();try{
  if(kind==='snapshot')f.admission.recoveryOf.snapshotHash='a'.repeat(64);
  if(kind==='task')f.input.claim.taskId='another-task';
  if(kind==='total')f.admission.funding.fundedTotal.tokens=3000;
  if(kind==='generic-policy')f.input.tokenPolicy={authoredTokenCeiling:2000,bindingCauses:[],inheritedUsage:f.admission.funding.inheritedUsage};
  await f.seal();expect((await readSavedResultEligibility(f.input)).status).toBe('unavailable');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it.each(['--model','--sandbox','-C','--output-schema','-o','evidenceDir'])('refuses hash-valid actual legacy argv drift at %s',async field=>{
 const f=await savedRecoveryFixture();try{
  const entry=f.archive.logs.find((e:any)=>/\/execute\/call-[^/]+\/outcome.json$/.test(e.path));
  const value=JSON.parse(f.bytes.get(entry.ref.artifactId)!.toString());
  if(field==='evidenceDir')value.evidenceDir+='/different';else value.args[value.args.indexOf(field)+1]+='-different';
  entry.ref=await f.put(value);await rewriteArchive(f);
  expect(await readSavedResultEligibility(f.input)).toEqual({status:'unavailable',reason:'saved-result-config-mismatch'});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it.each(['attempt_commit_publish_failed','workspace_cleanup_failed'])('refuses actual legacy %s events without guessing attempt text',async type=>{
 const f=await savedRecoveryFixture();try{
  const entry=f.archive.logs.find((e:any)=>e.path==='run/events.jsonl');const bytes=f.bytes.get(entry.ref.artifactId)!;
  entry.ref=await f.put(Buffer.concat([bytes,Buffer.from('\n'+JSON.stringify({type,at:new Date().toISOString(),detail:'cleanup after terminal decision failed: original failure'})+'\n')]));await rewriteArchive(f);
  expect(await readSavedResultEligibility(f.input)).toEqual({status:'unavailable',reason:'saved-result-legacy-publication-unproven'});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);


it.each(['execution-package','input-parent','fence-control'] as const)('r1 rejects nonprivate %s authority without repairing caller permissions',async kind=>{
 const f=await savedRecoveryFixture();try{
  expect((await readSavedResultEligibility(f.input)).status).toBe('eligible');
  const {chmod,stat}=await import('node:fs/promises'),root=kind==='execution-package'?f.input.savedResultRecovery!.packagePath:join(f.sourceDir,kind==='input-parent'?'input':'control');
  await chmod(root,0o777);expect(await readSavedResultEligibility(f.input)).toEqual({status:'unavailable',reason:kind==='fence-control'?'saved-result-source-stale':'saved-result-package-path-invalid'});
  expect((await stat(root)).mode&0o7777).toBe(0o777);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('r1 rejects a nonprivate source-only package without creating execution authority or changing permissions',async()=>{
 const f=await savedRecoveryFixture();try{
  const {chmod,stat}=await import('node:fs/promises'),packagePath=join(f.root,'source-private-probe');await mkdir(packagePath,{mode:0o700});const {admission,...rest}=f.manifest,manifest={...rest,schema:'ccloop-saved-result-source-package-v1'};
  for(const e of manifest.artifacts)await cp(join(f.input.savedResultRecovery!.packagePath,e.file),join(packagePath,e.file));
  const bytes=Buffer.from(canonicalJson(manifest));await writeFile(join(packagePath,'package.json'),bytes,{mode:0o600});const input={source:f.source,sourceAttempt:1,packagePath,packageHash:createHash('sha256').update(bytes).digest('hex')};
  expect((await readSavedResultSourceEligibility(input)).status).toBe('eligible');await chmod(packagePath,0o777);
  expect(await readSavedResultSourceEligibility(input)).toEqual({status:'unavailable',reason:'saved-result-package-path-invalid'});expect((await stat(packagePath)).mode&0o7777).toBe(0o777);await expect(stat(f.runDir)).rejects.toMatchObject({code:'ENOENT'});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it('r1 refuses nonprivate control authority when a revoked fence is omitted for dead-owner reconciliation',async()=>{
 const f=await savedRecoveryFixture();try{
  const {loadSavedResultRecovery}=await import('../../src/control/savedResultRecovery.js'),{chmod,stat}=await import('node:fs/promises');
  await rm(join(f.sourceDir,'control/recovery-fence.json'));await loadSavedResultRecovery(f.input,false);
  await chmod(join(f.sourceDir,'control'),0o777);const outcome=await loadSavedResultRecovery(f.input,false).then(()=>({status:'loaded'}),error=>({status:'refused',reason:error.message}));expect(outcome).toEqual({status:'refused',reason:'saved-result-package-path-invalid'});expect((await stat(join(f.sourceDir,'control'))).mode&0o7777).toBe(0o777);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
