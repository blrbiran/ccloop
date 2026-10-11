import {it,expect,vi,afterEach} from "vitest";
import {readFile,writeFile,rm,chmod} from "node:fs/promises";
import {join} from "node:path";
import {savedRecoveryFixture} from "../control/savedRecoveryFixture.js";
import {runLoop,runLoopFromState} from "../../src/controller/runLoop.js";
import {verified} from "../control/taskResultFixture.js";

afterEach(()=>vi.unstubAllEnvs());

it("restores the archived candidate, checks and verifies once without planning/executing/recharging original usage",async()=>{
 const f=await savedRecoveryFixture();try{
  const marker=join(f.root,"checks");vi.stubEnv("CCLOOP_RECOVERY_CHECK_MARKER",marker);
  const observed:any[]=[];let verifications=0;
  const state=await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error("planner replayed");},execute:async()=>{throw Error("executor replayed");},verify:async context=>{
   verifications++;expect(await readFile(join(context.worktreePath,'answer.txt'),'utf8')).toBe('saved candidate\n');return {...verified,tokenUsage:7};
  }},{savedResultRecovery:f.input,tokenPolicy:f.input.tokenPolicy,onPhaseSettled:async (e:any)=>{observed.push(e);}} as any);
  expect(state.status,state.stopReason??"").toBe("succeeded");expect(await readFile(marker,"utf8")).toBe("check\n");expect(verifications).toBe(1);expect(observed.map(e=>e.phase)).toEqual(["verify"]);
  expect(state.attemptsUsed).toBe(1);expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(993);
  expect(f.log("run/loop-state.json").status).toBe("failed");
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it.each(["command","verifier","special-mode"])("refuses candidate modification by %s without landing or retry",async kind=>{
 const f=await savedRecoveryFixture();try{
  if(kind==="command")vi.stubEnv("CCLOOP_RECOVERY_CHECK_MUTATE","1");
  let calls=0;
  const state=await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('planner replay');},execute:async()=>{throw Error('execute replay');},verify:async c=>{calls++;if(kind==='special-mode')await chmod(join(c.worktreePath,'answer.txt'),0o4755);else await writeFile(join(c.worktreePath,'answer.txt'),'modified');return {...verified,tokenUsage:7};}},{savedResultRecovery:f.input,tokenPolicy:f.input.tokenPolicy} as any);
  expect(state.status).toBe('failed');expect(state.stopReason).toContain('saved-result-modified-during-verification');expect(calls).toBe(kind==='command'?0:1);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it("refuses replay of an entered state after its candidate has been cleaned up",async()=>{
 const f=await savedRecoveryFixture();try{
  let entered:any;
  await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('planner replay');},execute:async()=>{throw Error('execute replay');},verify:async()=>{entered=JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8'));throw Error('simulated failure');}},{savedResultRecovery:f.input,tokenPolicy:f.input.tokenPolicy} as any);
  expect(entered?.savedResult?.entry).toBeDefined();
  const calls:string[]=[];
  const resumed=await runLoopFromState(f.input.work.contract,f.runDir,{plan:async()=>{calls.push('plan');throw Error('no');},execute:async()=>{calls.push('execute');throw Error('no');},verify:async()=>{calls.push('verify');throw Error('no');}},entered,undefined,undefined,{savedResultRecovery:f.input,tokenPolicy:f.input.tokenPolicy} as any);
  expect(calls).toEqual([]);expect(resumed.status).toBe('failed');expect(resumed.stopReason).toBe('saved-result-modified-during-verification');expect(resumed.budgetSnapshot.tokenRemainingStatus).toBe('unknown');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it('ends a retryable rejection after one fresh verification and preserves saved source failure',async()=>{
 const f=await savedRecoveryFixture();try{
  let calls=0;const state=await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async()=>{calls++;return {...verified,approved:false,safeToRetry:true,rejectCategory:'needs-change',tokenUsage:7};}},{savedResultRecovery:f.input,tokenPolicy:f.input.tokenPolicy});
  expect(calls).toBe(1);expect(state.status).toBe('blocked_waiting_human');expect(state.stopReason).toBe('retry after first failed attempt requires human approval');expect(f.log('run/loop-state.json').status).toBe('failed');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('replays a complete durable terminal verification result with no new calls or usage',async()=>{
 const f=await savedRecoveryFixture();try{
  const adapter={plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async()=>({...verified,tokenUsage:7})};
  const state=await runLoop(f.input.work.contract,f.runDir,adapter,{savedResultRecovery:f.input,tokenPolicy:f.input.tokenPolicy});
  expect(state.status).toBe('succeeded');
  const replay=await runLoopFromState(f.input.work.contract,f.runDir,{...adapter,verify:async()=>{throw Error('verifier replay');}},state,undefined,undefined,{savedResultRecovery:f.input,tokenPolicy:f.input.tokenPolicy});
  expect(replay).toEqual(state);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it.each(['git-config','runtime-contract'] as const)('protects %s from verifier changes before publication',async kind=>{
 const f=await savedRecoveryFixture();try{
  const state=await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async c=>{
   if(kind==='runtime-contract')await writeFile(join(f.runDir,'loop-contract.json'),'{}');
   else {const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');await promisify(execFile)('/usr/bin/git',['config','user.name','changed'],{cwd:c.worktreePath});}
   return {...verified,tokenUsage:7};
  }},{savedResultRecovery:f.input});
  expect(state.status).toBe('failed');expect(state.stopReason).toContain('saved-result-modified-during-verification');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('refuses to resume recovery as ordinary work when its durable mode marker is missing',async()=>{
 const f=await savedRecoveryFixture();try{
  let entered:any;
  await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async()=>{entered=JSON.parse(await readFile(join(f.runDir,'loop-state.json'),'utf8'));throw Error('interrupted');}},{savedResultRecovery:f.input});
  await rm(join(f.runDir,'saved-result-mode.json'));
  const calls:string[]=[];const adapter={plan:async()=>{calls.push('plan');throw Error('replay');},execute:async()=>{calls.push('execute');throw Error('replay');},verify:async()=>{calls.push('verify');throw Error('replay');}};
  await expect(runLoopFromState(f.input.work.contract,f.runDir,adapter,entered)).rejects.toThrow('saved-result-mode-conflict');expect(calls).toEqual([]);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('verifies the original candidate before harmless current target-tip movement is reconciled',async()=>{
 const f=await savedRecoveryFixture();try{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),exec=promisify(execFile);
  const before=(await exec('/usr/bin/git',['rev-parse','HEAD'],{cwd:f.repo})).stdout.trim();
  const state=await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async c=>{
   expect(await readFile(join(c.worktreePath,'answer.txt'),'utf8')).toBe('saved candidate\n');
   await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','target drift'],{cwd:f.repo});return {...verified,tokenUsage:7};
  }},{savedResultRecovery:f.input});
  expect(state.status,state.stopReason??'').toBe('succeeded');expect((await exec('/usr/bin/git',['rev-parse','HEAD'],{cwd:f.repo})).stdout.trim()).not.toBe(before);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it('checks revocation after process registration and before sending the validation command',async()=>{
 const f=await savedRecoveryFixture();try{
  const marker=join(f.root,'checks');vi.stubEnv('CCLOOP_RECOVERY_CHECK_MARKER',marker);let verifierCalls=0;
  const state=await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async()=>{verifierCalls++;return {...verified,tokenUsage:7};}},{savedResultRecovery:f.input,onProcessRegistered:async()=>{await rm(join(f.sourceDir,'control/recovery-fence.json'));}});
  expect(state.status).toBe('failed');expect(verifierCalls).toBe(0);await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it('enforces actual published Git changes even when the original Agent reports no changed files',async()=>{
 const f=await savedRecoveryFixture('hidden');try{
  let entered=0,calls=0;
  const state=await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async()=>{calls++;return {...verified,tokenUsage:7};}},{savedResultRecovery:f.input,onRecoveryAttemptEntered:async()=>{entered++;}} as any);
  expect(f.normalized.changedFiles).toEqual([]);expect(state.status).toBe('blocked_waiting_human');expect(calls).toBe(0);expect(state.attemptsUsed).toBe(1);expect(entered).toBe(1);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('runs real verification of a strictly valid saved partial without interpreting its reported timeout as a new timeout',async()=>{
 const f=await savedRecoveryFixture('partial');try{
  let calls=0;
  const state=await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async c=>{calls++;expect(c.execution).toMatchObject({completionStatus:'partial',failureType:'timeout'});return {...verified,tokenUsage:7};}},{savedResultRecovery:f.input});
  expect(state.status,state.stopReason??'').toBe('succeeded');expect(calls).toBe(1);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
it('refuses candidate mutation even when the verifier throws before producing a result',async()=>{
 const f=await savedRecoveryFixture();try{
  const state=await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async c=>{await writeFile(join(c.worktreePath,'answer.txt'),'modified');throw Error('provider interrupted');}},{savedResultRecovery:f.input});
  expect(state.status).toBe('failed');expect(state.stopReason).toContain('saved-result-modified-during-verification');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it('does not reuse a complete terminal approval after its protected contract changes',async()=>{
 const f=await savedRecoveryFixture();try{
  const adapter={plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async()=>({...verified,tokenUsage:7})};
  const state=await runLoop(f.input.work.contract,f.runDir,adapter,{savedResultRecovery:f.input});expect(state.status).toBe('succeeded');
  await writeFile(join(f.runDir,'loop-contract.json'),'{}');
  const resumed=await runLoopFromState(f.input.work.contract,f.runDir,{...adapter,verify:async()=>{throw Error('verify replay');}},state,undefined,undefined,{savedResultRecovery:f.input});
  expect(resumed.status).toBe('failed');expect(resumed.stopReason).toBe('saved-result-modified-during-verification');
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);

it('settles observed verifier usage on timeout and never enters an executor retry',async()=>{
 const f=await savedRecoveryFixture();try{
  let calls=0;const observations:any[]=[];
  const state=await runLoop(f.input.work.contract,f.runDir,{plan:async()=>{throw Error('plan replay');},execute:async()=>{throw Error('execute replay');},verify:async c=>{
   calls++;await new Promise<void>(resolve=>c.abortSignal!.addEventListener('abort',()=>resolve(),{once:true}));return {...verified,tokenUsage:3};
  }},{savedResultRecovery:f.input,onPhaseSettled:async o=>{observations.push(o);}});
  expect(state.status).toBe('exhausted');expect(calls).toBe(1);expect(state.attemptsUsed).toBe(1);
  expect(observations).toHaveLength(1);expect(observations[0]).toMatchObject({phase:'verify',tokenUsage:3});expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(997);
 }finally{await rm(f.root,{recursive:true,force:true});}
},20000);

it('refuses a candidate moved behind a workspace path symlink even when every byte and mode matches',async()=>{
 const f=await savedRecoveryFixture();try{
  const {loadSavedResultRecovery,materializeSavedResult}=await import('../../src/control/savedResultRecovery.js');
  const {candidateFingerprint}=await import('../../src/controller/verifySavedResult.js');
  const {rename,symlink,mkdir}=await import('node:fs/promises');await mkdir(f.runDir,{recursive:true,mode:0o700});
  const loaded=await loadSavedResultRecovery(f.input),workspace=await materializeSavedResult(f.repo,f.runDir,1,loaded);
  await candidateFingerprint(workspace.worktreePath);
  const trees=join(f.runDir,'worktrees'),moved=join(f.root,'moved-worktrees');await rename(trees,moved);await symlink(moved,trees);
  await expect(candidateFingerprint(workspace.worktreePath)).rejects.toThrow('saved-result-modified-during-verification');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
