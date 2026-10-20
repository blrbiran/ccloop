import {it,expect,vi} from "vitest";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile,writeFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {savedRecoveryFixture} from "./savedRecoveryFixture.js";
import {sealCodex,writeAgentsTable} from "./agentsFixture.js";
import {readUsageEvents} from "../../src/control/usage.js";
const exec=promisify(execFile);
async function nativeWorld(extraEnv:Record<string,string>={}){
 const f=await savedRecoveryFixture(),fake=join(f.root,'verifier.mjs'),calls=join(f.root,'provider-calls'),checks=join(f.root,'checks');
 await writeFile(fake,`import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('9.9.9-fake');process.exit(0);}
if(!process.argv.includes('exec')){const x=process.argv;process.stdout.write(x.includes('mcp')?'[]\\n':x.includes('models')?'{"models":[]}\\n':'',()=>process.exit(0));await new Promise(()=>{});}
for await(const part of process.stdin){}
const a=process.argv,s=JSON.parse(readFileSync(a[a.indexOf('--output-schema')+1],'utf8')),phase=s.properties.result?'execute':s.properties.approved?'verify':'plan';
appendFileSync(${JSON.stringify(calls)},phase+'\\n');if(phase!=='verify')throw Error('paid phase replayed');
if(readFileSync('answer.txt','utf8')!=='saved candidate\\n')throw Error('wrong snapshot');
if(process.env.CCLOOP_RECOVERY_POISON_REPO){const {execFileSync}=await import('node:child_process');execFileSync('/usr/bin/git',['clone','--quiet',process.cwd(),${JSON.stringify(join(f.sourceDir,'repo'))}]);writeFileSync(${JSON.stringify(join(f.sourceDir,'repo/answer.txt'))},'poisoned output');}
writeFileSync(a[a.indexOf('-o')+1],JSON.stringify({approved:true,rejectCategory:'',primaryTargetPaths:['answer.txt'],failingCommand:null,safeToRetry:false,evidence:['checked'],pauseSignals:[],stopSignals:[]}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));`);
 const config=await sealCodex({command:[process.execPath,fake],model:'fixture-new-verifier',sandbox:'workspace-write',budgetMode:'soft',timeoutMs:10000,killGraceMs:50});
 f.input.claim.configHash=config.configHash;f.input.claim.agent=config.selection;f.admission.claim.configHash=config.configHash;await f.seal();
 const table=await writeAgentsTable({codex:config.config.installation},f.root);await rm(join(f.sourceDir,'control/accepted.json'));
 const cli=resolve('dist/cli.js');
 const rpc=async(method:string,input:unknown)=>{
  const {spawn}=await import('node:child_process');
  return await new Promise<{code:number|null;stdout:string;stderr:string}>((ok,fail)=>{
   const p=spawn(process.execPath,[cli,'control',method,'--agents',table.path],{env:{...process.env,...extraEnv,CCLOOP_RECOVERY_CHECK_MARKER:checks},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',fail);p.on('close',code=>ok({code,stdout,stderr}));p.stdin.end(JSON.stringify(input));
  });
 };
 return {...f,calls,checks,rpc};
}
it('built CLI accepts a private package, runs only verification, records new actual usage, and harvests its approved candidate',async()=>{
 const f=await nativeWorld();try{
  const accepted=await f.rpc('accept',f.input);expect(accepted.code,accepted.stderr).toBe(0);
  let result:any;
  for(let i=0;i<100;i++){
   const r=await f.rpc('collect',{input:f.input,afterSeq:0});expect(r.code,r.stderr).toBe(0);result=JSON.parse(r.stdout);
   if(result.terminal)break;await new Promise(r=>setTimeout(r,50));
  }
  expect(result.terminal?.status,JSON.stringify(result)).toBe('succeeded');
  expect(await readFile(f.calls,'utf8')).toBe('verify\n');expect(await readFile(f.checks,'utf8')).toBe('check\n');
  expect(await readFile(join(f.sourceDir,'repo/answer.txt'),'utf8')).toBe('saved candidate\n');
  const events=await readUsageEvents(f.sourceDir);expect(events.filter(e=>e.bucket==='work').map(e=>e.cumulative?.tokens)).toEqual([0,15]);
  expect(events.filter(e=>e.bucket==='work').at(-1)?.cumulative).toMatchObject({attempts:1,sessions:1});
  expect(Object.hasOwn(result.terminal,'savedResult')).toBe(false);
  const replay=await f.rpc('accept',f.input);expect(replay.code,replay.stderr).toBe(0);expect(await readFile(f.calls,'utf8')).toBe('verify\n');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

import {runLoopFromState} from "../../src/controller/runLoop.js";
import {getDescriptor} from "../../src/agents/registry.js";
import {parseMaterializedAgentConfig} from "../../src/agents/materialize.js";
import {mkdtemp,stat} from "node:fs/promises";
async function waitFile(path:string):Promise<void>{for(let i=0;i<300;i++){try{await stat(path);return;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}await new Promise(r=>setTimeout(r,25));}throw Error(`marker did not appear: ${path}`);}
it.each(["before-entry","entry-fsynced","verifier-returned","usage-settled","output-fsynced","result-fsynced","terminal-fsynced"])("native crash at %s preserves mode, entry and result fences",async point=>{
 const root=await mkdtemp('/private/tmp/t6-crash-'),marker=join(root,'crashed');
 const f=await nativeWorld({NODE_ENV:'test',CCLOOP_CONTROL_TEST_CRASH_POINT:`saved-result-${point}`,CCLOOP_CONTROL_TEST_CRASH_MARKER:marker});
 let pid:number|undefined;
 try{
  const accept=await f.rpc('accept',f.input);expect(accept.code,accept.stderr).toBe(0);await waitFile(marker);
  const accepted=JSON.parse(await readFile(join(f.sourceDir,'control/accepted.json'),'utf8'));pid=accepted.worker.pid;process.kill(pid!,'SIGKILL');
  for(let i=0;i<100;i++){try{process.kill(pid!,0);}catch{break;}await new Promise(r=>setTimeout(r,10));}
  const state=JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8'));
  const beforeCalls=await readFile(f.calls,'utf8').catch(()=>''),beforeChecks=await readFile(f.checks,'utf8').catch(()=>'');
  const config=parseMaterializedAgentConfig(JSON.parse(await readFile(join(f.sourceDir,'control/config.json'),'utf8')));
  vi.stubEnv("CCLOOP_RECOVERY_CHECK_MARKER",f.checks);
  const resumed=await runLoopFromState(f.input.work.contract,f.runDir,()=>getDescriptor(config.kind).createAdapter(config),state,undefined,undefined,{savedResultRecovery:f.input,tokenPolicy:f.input.tokenPolicy});
  if(point==='before-entry'){
   expect(resumed.status,resumed.stopReason??'').toBe('succeeded');expect(await readFile(f.calls,'utf8')).toBe('verify\n');expect(await readFile(f.checks,'utf8')).toBe('check\n');expect(resumed.attemptsUsed).toBe(1);
  }else{
   expect(await readFile(f.calls,'utf8').catch(()=>'')).toBe(beforeCalls);expect(await readFile(f.checks,'utf8').catch(()=>'')).toBe(beforeChecks);
   if(['result-fsynced','terminal-fsynced'].includes(point))expect(resumed.status,resumed.stopReason??'').toBe('succeeded');
   else {expect(resumed.status).toBe('blocked_waiting_human');expect(resumed.stopReason).toBe('saved-result-verification-interrupted');expect(resumed.budgetSnapshot.tokenRemainingStatus).toBe(['usage-settled','output-fsynced'].includes(point)?'known':'unknown');}
  }
 }finally{vi.unstubAllEnvs();if(pid)try{process.kill(pid,'SIGKILL');}catch{}await rm(f.root,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
},30000);

it.each(['before-entry','entry-fsynced','usage-settled','result-fsynced','revoked-result'])('explicit mechanical settlement at %s stops a dead claimed worker without rerunning checks or providers',async point=>{
 const root=await mkdtemp('/private/tmp/t6-settle-'),marker=join(root,'crashed');
 const crash=point==='revoked-result'?'result-fsynced':point;
 const f=await nativeWorld({NODE_ENV:'test',CCLOOP_CONTROL_TEST_CRASH_POINT:`saved-result-${crash}`,CCLOOP_CONTROL_TEST_CRASH_MARKER:marker});let pid:number|undefined;
 try{
  const accept=await f.rpc('accept',f.input);expect(accept.code,accept.stderr).toBe(0);await waitFile(marker);
  const alive=await f.rpc('settle-saved-result',{input:f.input});expect(alive.code).not.toBe(0);expect(alive.stderr).toContain('saved-result-owner-not-dead');
  const ownerPath=join(f.runDir,'owner-record.json'),ownerBytes=await readFile(ownerPath),owner=JSON.parse(ownerBytes.toString());
  const ownerPid=owner.currentProcessInstanceId.split(':')[1];await writeFile(ownerPath,JSON.stringify({...owner,currentProcessInstanceId:`pid:${ownerPid}:1`,lastAffirmedAt:'1970-01-01T00:00:00.001Z',leaseAffirmedAt:null}));
  const damaged=await f.rpc('settle-saved-result',{input:f.input});expect(damaged.code).not.toBe(0);expect(damaged.stderr).toContain('saved-result-owner-not-dead');await writeFile(ownerPath,ownerBytes);
  pid=JSON.parse(await readFile(join(f.sourceDir,'control/accepted.json'),'utf8')).worker.pid;process.kill(pid!,'SIGKILL');
  for(let i=0;i<100;i++){try{process.kill(pid!,0);}catch{break;}await new Promise(r=>setTimeout(r,10));}
  if(point==='revoked-result')await rm(join(f.sourceDir,'control/recovery-fence.json'));
  const calls=await readFile(f.calls,'utf8').catch(()=>''),checks=await readFile(f.checks,'utf8').catch(()=>'');
  const settled=await f.rpc('settle-saved-result',{input:f.input});expect(settled.code,settled.stderr).toBe(0);const value=JSON.parse(settled.stdout);
  expect(value.settlement.usageStatus).toBe(['before-entry','usage-settled','result-fsynced','revoked-result'].includes(point)?'known':'unknown');
  expect(value.settlement.disposition).toBe(point==='result-fsynced'?'complete':point==='before-entry'||point==='usage-settled'||point==='entry-fsynced'?'interrupted':'terminal');
  const stateResponse=await f.rpc('read-saved-result-settlement',{input:f.input,settlementRef:value.ref,ref:value.settlement.state});expect(stateResponse.code,stateResponse.stderr).toBe(0);
  const state=JSON.parse(Buffer.from(JSON.parse(stateResponse.stdout).base64,'base64').toString());expect(state.status).toBe(point==='result-fsynced'?'succeeded':'blocked_waiting_human');
  if(point==='revoked-result')expect(state.stopReason).toBe('saved-result-source-stale');
  const collect=await f.rpc('collect',{input:f.input,afterSeq:0});expect(collect.code,collect.stderr).toBe(0);expect(JSON.parse(collect.stdout).candidate.stopProof.isolated).toBe(true);
  const events=await readUsageEvents(f.sourceDir),replay=await f.rpc('settle-saved-result',{input:f.input});expect(replay.code,replay.stderr).toBe(0);expect(JSON.parse(replay.stdout)).toEqual(value);expect(await readUsageEvents(f.sourceDir)).toEqual(events);
  expect(await readFile(f.calls,'utf8').catch(()=>'')).toBe(calls);expect(await readFile(f.checks,'utf8').catch(()=>'')).toBe(checks);
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{}await rm(f.root,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
},30000);

import {canonicalJson,type ArtifactRefV1} from '../../src/control/protocol.js';
import {readSavedResultEligibility} from '../../src/control/savedResultRecovery.js';
it.each(['before-entry','usage-settled'])('admits an explicit successor after %s and carries every work charge exactly once',async crashPoint=>{
 const root=await mkdtemp('/private/tmp/t6-chain-'),marker=join(root,'crashed');
 const f=await nativeWorld({NODE_ENV:'test',CCLOOP_CONTROL_TEST_CRASH_POINT:`saved-result-${crashPoint}`,CCLOOP_CONTROL_TEST_CRASH_MARKER:marker});
 const next=await nativeWorld();let pid:number|undefined;
 try{
  const accepted=await f.rpc('accept',f.input);expect(accepted.code,accepted.stderr).toBe(0);await waitFile(marker);
  pid=JSON.parse(await readFile(join(f.sourceDir,'control/accepted.json'),'utf8')).worker.pid;process.kill(pid!,'SIGKILL');
  for(let i=0;i<100;i++){try{process.kill(pid!,0);}catch{break;}await new Promise(r=>setTimeout(r,10));}
  const response=await f.rpc('settle-saved-result',{input:f.input});expect(response.code,response.stderr).toBe(0);const settled=JSON.parse(response.stdout);
  expect(settled.settlement).toMatchObject({disposition:'interrupted',usageStatus:'known'});
  const refs:ArtifactRefV1[]=[];
  const add=async(ref:ArtifactRefV1,bytes:Buffer)=>{
   if(!next.manifest.artifacts.some(e=>e.ref.artifactId===ref.artifactId)){
    const file=ref.artifactId+'.bin';await writeFile(join(next.input.savedResultRecovery!.packagePath,file),bytes,{mode:0o600});next.manifest.artifacts.push({ref,file});next.bytes.set(ref.artifactId,bytes);
   }
   if(!refs.some(r=>r.artifactId===ref.artifactId))refs.push(ref);return ref;
  };
  const copy=async(ref:ArtifactRefV1)=>{const r=await f.rpc('read-saved-result-settlement',{input:f.input,settlementRef:settled.ref,ref});expect(r.code,r.stderr).toBe(0);return add(ref,Buffer.from(JSON.parse(r.stdout).base64,'base64'));};
  for(const entry of f.manifest.artifacts)await add(entry.ref,await readFile(join(f.input.savedResultRecovery!.packagePath,entry.file)));
  for(const key of ['state','lifecycle','accepted','envelope','usage','stopProof'])await copy(settled.settlement[key]);
  for(const alias of settled.settlement.usageObservations)await copy(alias.source);
  const put=async(value:unknown)=>{const ref=await next.put(value);refs.push(ref);return ref;};
  const packageRef=await put(await readFile(join(f.input.savedResultRecovery!.packagePath,'package.json')));
  const current=JSON.parse((await f.rpc('collect',{input:f.input,afterSeq:0})).stdout);
  const proofRef=current.candidate.stopProof.source;const proofResponse=await f.rpc('read-evidence',{input:f.input,ref:proofRef});expect(proofResponse.code,proofResponse.stderr).toBe(0);
  await add(proofRef,Buffer.from(JSON.parse(proofResponse.stdout).base64,'base64'));
  const state=JSON.parse(next.bytes.get(settled.settlement.state.artifactId)!.toString()),usage=JSON.parse(next.bytes.get(settled.settlement.usage.artifactId)!.toString());
  const report=await put({candidate:current.candidate,terminal:{outcome:state.status,sourceDir:f.sourceDir}});
  const accounting={work:usage.totals.work,handoff:usage.totals.handoff,highWater:usage.nextSeq-1,report,stopProof:proofRef,settlement:null,receipt:null};
  const record={schema:'ccloop-saved-result-interrupted-v1',envelope:settled.settlement.envelope,accepted:settled.settlement.accepted,package:packageRef,admission:f.manifest.admission,state:settled.settlement.state,lifecycle:settled.settlement.lifecycle,usage:settled.settlement.usage,accounting,artifacts:refs};
  const recordRef=await next.put(record);
  Object.assign(next.input.claim,{runId:'recovery-2',generation:3,commandId:'recover-command-2',ownerToken:'recover-owner-2'});
  Object.assign(next.admission.claim,{runId:'recovery-2',generation:3,commandId:'recover-command-2',ownerToken:'recover-owner-2'});
  next.admission.revision=8;next.admission.currentRunId='recovery-1';next.admission.predecessor={runId:'recovery-1',outcome:'interrupted',recoveryOf:next.admission.recoveryOf,record:recordRef};
  const funding=next.admission.funding;funding.reservation={...funding.reservation,runId:'recovery-2',revision:8};
  funding.inheritedUsage={...funding.inheritedUsage};funding.fundedTotal={...funding.fundedTotal};
  for(const d of ['tokens','activeMs','attempts','sessions'] as const){funding.inheritedUsage[d]=f.admission.funding.inheritedUsage[d]+accounting.work[d];funding.fundedTotal[d]=funding.inheritedUsage[d]+funding.freshGrant.work[d]!;}
  await next.seal();expect(await readSavedResultEligibility(next.input)).toMatchObject({status:'eligible'});
  for(const reason of ['saved-result-modified-during-verification','retry after first failed attempt requires human approval']){
   const wrongState=await put({...state,stopReason:reason});const wrong=await next.put({...record,state:wrongState,artifacts:refs});next.admission.predecessor.record=wrong;await next.seal();expect((await readSavedResultEligibility(next.input)).status).toBe('unavailable');
  }
  next.admission.predecessor.record=recordRef;await next.seal();
  const second=await next.rpc('accept',next.input);expect(second.code,second.stderr).toBe(0);
  let result:any;for(let i=0;i<100;i++){const r=await next.rpc('collect',{input:next.input,afterSeq:0});expect(r.code,r.stderr).toBe(0);result=JSON.parse(r.stdout);if(result.terminal)break;await new Promise(r=>setTimeout(r,50));}
  expect(result.terminal?.status,JSON.stringify(result)).toBe('succeeded');expect(await readFile(next.calls,'utf8')).toBe('verify\n');
  expect((await readUsageEvents(next.sourceDir)).filter(e=>e.bucket==='work').at(-1)?.cumulative).toMatchObject({tokens:15,attempts:1,sessions:1});expect(funding.inheritedUsage.tokens).toBe(crashPoint==='before-entry'?1000:1015);expect(funding.inheritedUsage.attempts).toBe(3);
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{}await rm(f.root,{recursive:true,force:true});await rm(next.root,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
},30000);

it('reaps the real isolated validation child group after its controller dies',async()=>{
 const root=await mkdtemp('/private/tmp/t6-reap-'),runDir=join(root,'run'),marker=join(root,'child-running'),script=join(root,'controller.mjs');
 const {mkdir}=await import('node:fs/promises');await mkdir(runDir,{mode:0o700});
 const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
 const command=quote(process.execPath)+' -e '+quote(`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
 await writeFile(script,`import {runSavedResultCheck} from ${JSON.stringify('file://'+resolve('dist/src/controller/verifySavedResult.js'))};await runSavedResultCheck(${JSON.stringify(runDir)},${JSON.stringify(root)},${JSON.stringify(command)},0,undefined);`);
 const {spawn}=await import('node:child_process'),owner=spawn(process.execPath,[script],{stdio:'ignore'});let pgid:number|undefined;
 const closed=new Promise<void>(resolve=>owner.once('close',()=>resolve()));
 try{
  await waitFile(marker);const record=JSON.parse(await readFile(join(runDir,'saved-result-checks/0/process.json'),'utf8'));pgid=record.pgid;
  owner.kill('SIGKILL');await closed;expect(()=>process.kill(-pgid!,0)).not.toThrow();
  const {reapRunProcesses}=await import('../../src/ownership/reapRunProcesses.js');const result=await reapRunProcesses(runDir,{graceMs:100,timeoutMs:1000,pollMs:10});
  expect(result).toEqual({ok:true,reaped:1});expect(()=>process.kill(-pgid!,0)).toThrow();
  expect(await readFile(join(runDir,'events.jsonl'),'utf8')).toContain('verify-check');
 }finally{owner.kill('SIGKILL');if(pgid)try{process.kill(-pgid,'SIGKILL');}catch{}await closed;await rm(root,{recursive:true,force:true});}
},30000);

it.each(['before-entry','entry-fsynced'])('missing lifecycle markers after %s cannot authorize replay or known zero usage',async point=>{
 const root=await mkdtemp('/private/tmp/t6-marker-'),marker=join(root,'crashed');
 const f=await nativeWorld({NODE_ENV:'test',CCLOOP_CONTROL_TEST_CRASH_POINT:`saved-result-${point}`,CCLOOP_CONTROL_TEST_CRASH_MARKER:marker});let pid:number|undefined;
 try{
  const accepted=await f.rpc('accept',f.input);expect(accepted.code,accepted.stderr).toBe(0);await waitFile(marker);
  pid=JSON.parse(await readFile(join(f.sourceDir,'control/accepted.json'),'utf8')).worker.pid;process.kill(pid!,'SIGKILL');
  for(let i=0;i<100;i++){try{process.kill(pid!,0);}catch{break;}await new Promise(r=>setTimeout(r,10));}
  const state=JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8'));
  await rm(join(f.runDir,'saved-result-lifecycle.json'));await rm(join(f.runDir,'saved-result-entry.json'),{force:true});
  let calls=0;const adapter={plan:async()=>{calls++;throw Error('replay');},execute:async()=>{calls++;throw Error('replay');},verify:async()=>{calls++;throw Error('replay');}};
  await expect(runLoopFromState(f.input.work.contract,f.runDir,adapter,state,undefined,undefined,{savedResultRecovery:f.input})).rejects.toThrow('saved-result-lifecycle-unavailable');expect(calls).toBe(0);
  const settled=await f.rpc('settle-saved-result',{input:f.input});expect(settled.code,settled.stderr).toBe(0);const value=JSON.parse(settled.stdout);
  expect(value.settlement).toMatchObject({disposition:'terminal',usageStatus:'unknown'});
  expect(await readFile(f.calls,'utf8').catch(()=>'')).toBe('');expect(await readFile(f.checks,'utf8').catch(()=>'')).toBe('');
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{}await rm(f.root,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
},30000);

it('owner death before validation command release cannot run an empty login shell',async()=>{
 const root=await mkdtemp('/private/tmp/t6-eof-'),home=join(root,'home'),runDir=join(root,'run'),ready=join(root,'registered'),profileMarker=join(root,'profile-ran'),commandMarker=join(root,'command-ran'),script=join(root,'controller.mjs');
 const {mkdir}=await import('node:fs/promises');await mkdir(home,{mode:0o700});await mkdir(runDir,{mode:0o700});
 const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
 await writeFile(join(home,'.profile'),'printf profile > '+quote(profileMarker)+'\n');
 await exec('/bin/sh',['-lc','true'],{cwd:root,env:{...process.env,HOME:home}});expect(await readFile(profileMarker,'utf8')).toBe('profile');await rm(profileMarker);
 const command=quote(process.execPath)+' -e '+quote(`require('node:fs').writeFileSync(${JSON.stringify(commandMarker)},'ran');`);
 await writeFile(script,`import {writeFile} from 'node:fs/promises';import {runSavedResultCheck} from ${JSON.stringify('file://'+resolve('dist/src/controller/verifySavedResult.js'))};await runSavedResultCheck(${JSON.stringify(runDir)},${JSON.stringify(root)},${JSON.stringify(command)},0,undefined,async()=>{await writeFile(${JSON.stringify(ready)},'ready');await new Promise(()=>{});});`);
 const {spawn}=await import('node:child_process'),owner=spawn(process.execPath,[script],{env:{...process.env,HOME:home},stdio:'ignore'});const closed=new Promise<void>(resolve=>owner.once('close',()=>resolve()));let pgid:number|undefined;
 try{
  await waitFile(ready);pgid=JSON.parse(await readFile(join(runDir,'saved-result-checks/0/process.json'),'utf8')).pgid;owner.kill('SIGKILL');await closed;
  let gone=false;for(let i=0;i<300;i++){try{process.kill(-pgid!,0);}catch{gone=true;break;}await new Promise(r=>setTimeout(r,10));}expect(gone).toBe(true);
  await expect(readFile(profileMarker)).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(commandMarker)).rejects.toMatchObject({code:'ENOENT'});
  // Authored whitespace is still an explicitly released shell command; no trim-based reinterpretation.
  await writeFile(script,`import {runSavedResultCheck} from ${JSON.stringify('file://'+resolve('dist/src/controller/verifySavedResult.js'))};await runSavedResultCheck(${JSON.stringify(join(root,'released-run'))},${JSON.stringify(root)}," \n ",0,undefined);`.replace('" \n "',JSON.stringify(' \n ')));
  await exec(process.execPath,[script],{env:{...process.env,HOME:home}});expect(await readFile(profileMarker,'utf8')).toBe('profile');
 }finally{owner.kill('SIGKILL');if(pgid)try{process.kill(-pgid,'SIGKILL');}catch{}await closed;await rm(root,{recursive:true,force:true});}
},15000);

it('does not reuse terminal-fsynced approval for a candidate changed before harvest',async()=>{
 const root=await mkdtemp('/private/tmp/t6-terminal-edit-'),marker=join(root,'crashed');
 const f=await nativeWorld({NODE_ENV:'test',CCLOOP_CONTROL_TEST_CRASH_POINT:'saved-result-terminal-fsynced',CCLOOP_CONTROL_TEST_CRASH_MARKER:marker});let pid:number|undefined;
 try{
  const accepted=await f.rpc('accept',f.input);expect(accepted.code,accepted.stderr).toBe(0);await waitFile(marker);
  const state=JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8'));expect(state.status).toBe('succeeded');
  pid=JSON.parse(await readFile(join(f.sourceDir,'control/accepted.json'),'utf8')).worker.pid;process.kill(pid!,'SIGKILL');
  for(let i=0;i<100;i++){try{process.kill(pid!,0);}catch{break;}await new Promise(r=>setTimeout(r,10));}
  await writeFile(join(f.runDir,'worktrees/attempt-1/answer.txt'),'changed after approval');
  const settled=await f.rpc('settle-saved-result',{input:f.input});expect(settled.code,settled.stderr).toBe(0);const value=JSON.parse(settled.stdout);
  expect(value.settlement).toMatchObject({disposition:'terminal',usageStatus:'known'});
  const response=await f.rpc('read-saved-result-settlement',{input:f.input,settlementRef:value.ref,ref:value.settlement.state});expect(response.code,response.stderr).toBe(0);
  const refused=JSON.parse(Buffer.from(JSON.parse(response.stdout).base64,'base64').toString());expect(refused).toMatchObject({status:'failed',stopReason:'saved-result-modified-during-verification'});
  await writeFile(join(f.runDir,'worktrees/attempt-1/answer.txt'),'saved candidate\n');
  const replay=await runLoopFromState(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async()=>{throw Error('verify replay');}},refused,undefined,undefined,{savedResultRecovery:f.input});
  expect(replay.status).toBe('failed');expect(replay.stopReason).toBe('saved-result-modified-during-verification');
  expect(await readFile(f.calls,'utf8')).toBe('verify\n');expect(await readFile(f.checks,'utf8')).toBe('check\n');
  expect((await readUsageEvents(f.sourceDir)).filter(e=>e.bucket==='work').map(e=>e.cumulative?.tokens)).toEqual([0,15]);
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{}await rm(f.root,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
},30000);

async function completedNative(f:Awaited<ReturnType<typeof nativeWorld>>):Promise<void>{
 const accepted=await f.rpc('accept',f.input);expect(accepted.code,accepted.stderr).toBe(0);
 for(let i=0;i<300;i++){
  const record=JSON.parse(await readFile(join(f.sourceDir,'control/accepted.json'),'utf8'));
  if(record.launch==='sealed'){try{process.kill(record.worker.pid,0);}catch{return;}}
  await new Promise(r=>setTimeout(r,25));
 }
 throw Error('worker did not seal and exit');
}
it.each(['missing-publication','dirty-materialization','symlink-materialization','special-mode-materialization','extra-materialization'])('refuses cleaned success with %s and preserves measured usage',async kind=>{
 const f=await nativeWorld();try{
  await completedNative(f);expect(JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8')).status).toBe('succeeded');
  if(kind==='missing-publication')await exec('/usr/bin/git',['update-ref','-d',`refs/ccloop/${f.input.claim.runId}/attempts/1`],{cwd:f.repo});
  if(kind==='dirty-materialization')await writeFile(join(f.sourceDir,'repo/answer.txt'),'changed materialization');
  if(kind==='symlink-materialization'){const {symlink}=await import('node:fs/promises');await writeFile(join(f.root,'outside'),'saved candidate\n');await rm(join(f.sourceDir,'repo/answer.txt'));await symlink(join(f.root,'outside'),join(f.sourceDir,'repo/answer.txt'));}
  if(kind==='special-mode-materialization'){const {chmod}=await import('node:fs/promises');await chmod(join(f.sourceDir,'repo/answer.txt'),0o4755);}
  if(kind==='extra-materialization')await writeFile(join(f.sourceDir,'repo/extra'),'unexplained');
  const r=await f.rpc('settle-saved-result',{input:f.input});expect(r.code,r.stderr).toBe(0);const value=JSON.parse(r.stdout);expect(value.settlement).toMatchObject({disposition:'terminal',usageStatus:'known'});
  const got=await f.rpc('read-saved-result-settlement',{input:f.input,settlementRef:value.ref,ref:value.settlement.state});expect(got.code,got.stderr).toBe(0);const state=JSON.parse(Buffer.from(JSON.parse(got.stdout).base64,'base64').toString());
  expect(state.stopReason).toBe(kind==='missing-publication'?'saved-result-publication-unavailable':'saved-result-modified-during-verification');expect(state.status).not.toBe('succeeded');
  expect(await readFile(f.calls,'utf8')).toBe('verify\n');expect((await readUsageEvents(f.sourceDir)).filter(e=>e.bucket==='work').map(e=>e.cumulative?.tokens)).toEqual([0,15]);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('never publishes a success whose ordinary result repository was poisoned outside the candidate',async()=>{
 const f=await nativeWorld({CCLOOP_RECOVERY_POISON_REPO:'1'});try{
  await completedNative(f);
  const core=await f.rpc('collect',{input:f.input,afterSeq:0});expect(core.code,core.stderr).toBe(0);const value=JSON.parse(core.stdout);
  expect(value.candidate?.result).not.toBe('complete');expect(value.terminal?.status).not.toBe('succeeded');
  const settled=await f.rpc('settle-saved-result',{input:f.input});expect(settled.code,settled.stderr).toBe(0);expect(JSON.parse(settled.stdout).settlement).toMatchObject({disposition:'terminal',usageStatus:'known'});
  expect(await readFile(f.calls,'utf8')).toBe('verify\n');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it.each(['wrong-parent','changed-tree'])('refuses a cleaned terminal with %s publication even when the ref exists',async kind=>{
 const f=await nativeWorld();try{
  await completedNative(f);
  const {loadSavedResultRecovery}=await import('../../src/control/savedResultRecovery.js'),saved=await loadSavedResultRecovery(f.input);
  const candidate=saved.snapshot.head,tree=(await exec('/usr/bin/git',['rev-parse',`${kind==='changed-tree'?'HEAD':candidate}^{tree}`],{cwd:f.repo})).stdout.trim();
  const parent=kind==='wrong-parent'?saved.originalBase:candidate;
  const replacement=(await exec('/usr/bin/git',['-c','user.name=ccloop','-c','user.email=ccloop@invalid','commit-tree',tree,'-p',parent,'-m','invalid publication'],{cwd:f.repo})).stdout.trim();
  await exec('/usr/bin/git',['update-ref',`refs/ccloop/${f.input.claim.runId}/attempts/1`,replacement],{cwd:f.repo});
  const settled=await f.rpc('settle-saved-result',{input:f.input});expect(settled.code,settled.stderr).toBe(0);const value=JSON.parse(settled.stdout);
  expect(value.settlement).toMatchObject({disposition:'terminal',usageStatus:'known'});
  const response=await f.rpc('read-saved-result-settlement',{input:f.input,settlementRef:value.ref,ref:value.settlement.state});expect(response.code,response.stderr).toBe(0);
  expect(JSON.parse(Buffer.from(JSON.parse(response.stdout).base64,'base64').toString())).toMatchObject({status:'failed',stopReason:'saved-result-publication-unavailable'});
  expect(await readFile(f.calls,'utf8')).toBe('verify\n');expect((await readUsageEvents(f.sourceDir)).filter(e=>e.bucket==='work').map(e=>e.cumulative?.tokens)).toEqual([0,15]);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
