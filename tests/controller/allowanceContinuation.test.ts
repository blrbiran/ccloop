import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import { createContract, createRepo } from "./optionalFixture.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
const plan={summary:"saved plan",primaryTargetPaths:[],tokenUsage:10};
const execution={changedFiles:[],diffPatch:"",commandOutputs:[],stdoutStderrLog:"",tokenUsage:10};
const verified={approved:true,rejectCategory:"",primaryTargetPaths:[],failingCommand:null,safeToRetry:false,evidence:[],pauseSignals:[],stopSignals:[],tokenUsage:0};
const inheritedUsage={tokens:0,activeMs:0,attempts:0,sessions:0};

describe("allowance phase continuation",()=>{
 it("parks only cap/group allowance depletion with completed phase evidence",async()=>{
   const repo=await createRepo(); const dir=await mkdtemp(join(tmpdir(),"allowance-"));
   const calls:string[]=[];const adapter:RuntimeAdapter={plan:async()=>{calls.push("plan");return plan;},execute:async()=>{calls.push("execute");return execution;},verify:async()=>verified};
   const state=await runLoop(createContract(repo,["true"],null),dir,adapter,{workGrant:{tokens:10,activeMs:10000,attempts:3,sessions:1},tokenPolicy:{authoredTokenCeiling:null,bindingCauses:["spend-cap"],inheritedUsage}});
   expect(state.status).toBe("blocked_waiting_human");expect(state.waitingOnHuman).toBe(false);
   expect(state.waitingCause).toBe("token-allowance");expect(state.allowanceNextPhase).toBe("execute");
   expect(calls).toEqual(["plan"]);
   expect(JSON.parse(await readFile(join(dir,"attempts/1/plan.json"),"utf8"))).toEqual(plan);
   expect(await readFile(join(dir,"worktrees/attempt-1/src/index.ts"),"utf8")).toContain("value");
 });
 it.each(["execute","verify"] as const)("renews directly at %s without replaying paid phases or inherited usage",async nextPhase=>{
   const calls:string[]=[];const adapter:RuntimeAdapter={plan:async()=>{throw new Error("planner replayed");},execute:async()=>{calls.push("execute");return execution;},verify:async()=>{calls.push("verify");return verified;}};
   const contract=createContract(await createRepo(),["true"],null);contract.verification.verifierType="agent";
   const observed:any[]=[];
   const state=await runLoop(contract,await mkdtemp(join(tmpdir(),"renewed-")),adapter,{workGrant:{tokens:100,activeMs:10000,attempts:2,sessions:1},tokenPolicy:{authoredTokenCeiling:null,bindingCauses:["group"],inheritedUsage:{tokens:30,activeMs:9000,attempts:3,sessions:3}},allowanceContinuation:{nextPhase,plan,execution:nextPhase==="verify"?execution:null},onPhaseSettled:async e=>{observed.push(e);}});
   expect(calls).toEqual(nextPhase==="verify"?["verify"]:["execute","verify"]);
   expect(state.status).toBe("succeeded");expect(state.attemptsUsed).toBe(1);expect(state.budgetSnapshot.attemptsRemaining).toBe(1);
   expect(observed.map(e=>e.phase)).toEqual(calls);expect(observed.every(e=>e.attempt===1)).toBe(true);
 });
 it("does not renew an authored ceiling or exhausted non-token dimension",async()=>{
   for(const policy of [{authoredTokenCeiling:10,bindingCauses:["task"] as const},{authoredTokenCeiling:null,bindingCauses:["spend-cap"] as const}]){
     const state=await runLoop(createContract(await createRepo(),["true"],policy.authoredTokenCeiling),await mkdtemp(join(tmpdir(),"no-renew-")),{plan:async()=>plan,execute:async()=>execution,verify:async()=>verified},{workGrant:{tokens:10,activeMs:10000,attempts:policy.authoredTokenCeiling===null?1:3,sessions:1},tokenPolicy:{...policy,bindingCauses:[...policy.bindingCauses],inheritedUsage}});
     expect(state.status).toBe("exhausted");expect(state.waitingCause).toBeUndefined();
   }
 });
 it("parks after a genuine retryable verifier rejection, then preserves its retry history",async()=>{
   const contract=createContract(await createRepo(),["true"],null);contract.verification.verifierType="agent";
   const rejection={...verified,approved:false,rejectCategory:"fix",safeToRetry:true,tokenUsage:10};
   const state=await runLoop(contract,await mkdtemp(join(tmpdir(),"verify-allowance-")),{plan:async()=>({...plan,tokenUsage:0}),execute:async()=>({...execution,tokenUsage:0}),verify:async()=>rejection},{workGrant:{tokens:10,activeMs:10000,attempts:3,sessions:1},tokenPolicy:{authoredTokenCeiling:null,bindingCauses:["spend-cap"],inheritedUsage}});
   expect(state).toMatchObject({status:"blocked_waiting_human",waitingCause:"token-allowance",allowanceNextPhase:"plan",recentFailures:[{rejectCategory:"fix",primaryTargetPaths:[],failingCommand:null}]});
   const calls:string[]=[];
   const renewed=await runLoop(contract,await mkdtemp(join(tmpdir(),"verify-renewed-")),{plan:async()=>{calls.push("plan");return {...plan,tokenUsage:0};},execute:async()=>({...execution,tokenUsage:0}),verify:async()=>rejection},{workGrant:{tokens:100,activeMs:10000,attempts:2,sessions:1},tokenPolicy:{authoredTokenCeiling:null,bindingCauses:["spend-cap"],inheritedUsage:{tokens:10,activeMs:100,attempts:1,sessions:1}},allowanceContinuation:{nextPhase:"plan",plan:null,execution:null,recentFailures:state.recentFailures}});
   expect(calls).toEqual(["plan"]);expect(renewed.stopReason).toBe("repeated failure pattern detected");
 });
 it("does not charge a saved execute result when interrupted before renewed verify",async()=>{
   const abort=new AbortController();abort.abort();const observed:string[]=[];
   const state=await runLoop(createContract(await createRepo(),["true"],null),await mkdtemp(join(tmpdir(),"abort-renewal-")),{plan:async()=>{throw new Error("plan replay");},execute:async()=>{throw new Error("execute replay");},verify:async()=>verified},{phaseSignal:abort.signal,allowanceContinuation:{nextPhase:"verify",plan,execution},onPhaseSettled:async e=>{observed.push(e.phase);}});
   expect(observed).toEqual([]);expect(state.attemptsUsed).toBe(1);
 });

});
