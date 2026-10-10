import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStopRequestSignal, runLoop } from "../../src/controller/runLoop.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { manifestOf, report, resultFixture, verified } from "../control/taskResultFixture.js";

describe("immutable live attempt results",()=>{
  // Removing the execute-boundary capture loses the live observation before any candidate exists.
  it("reads execution while verify pauses, then retains the same bytes after verify edits and cleanup",async()=>{
    const f=await resultFixture();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let executes=0,verifies=0,workspace="";
    const adapter:RuntimeAdapter={plan:async()=>({summary:"write",primaryTargetPaths:["answer.txt"]}),execute:async c=>{executes++;workspace=c.worktreePath;await writeFile(join(workspace,"answer.txt"),"execute bytes\n");return {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",tokenUsage:7,taskResult:report}},verify:async()=>{verifies++;entered();await gate;await writeFile(join(workspace,"answer.txt"),"verifier bytes\n");return verified}};
    const running=runLoop(f.contract,f.runDir,adapter,{taskResultInput:f.input});await ready;
    try{
      const live=await f.rpc("task-results",{input:f.input,afterRevision:0});expect(live.code,live.stderr).toBe(0);
      const collection=JSON.parse(live.stdout);expect(collection).toMatchObject({schema:"ccloop-task-results-v1",currentAttempt:1,revision:1,nextRevision:1});expect(collection.manifests).toHaveLength(1);
      const manifest=await manifestOf(f,collection.manifests[0].ref);expect(manifest).toMatchObject({stage:"execution",attempt:1,explanation:{status:"available"},verificationRef:null});
      const core=await f.rpc("collect",{input:f.input,afterSeq:0});expect(JSON.parse(core.stdout).candidate).toBeNull();
    }finally{release()}
    expect((await running).status).toBe("succeeded");expect([executes,verifies]).toEqual([1,1]);await expect(access(workspace)).rejects.toThrow();
    const page=JSON.parse((await f.rpc("task-results",{input:f.input,afterRevision:0})).stdout);expect(page.manifests.map((m:any)=>m.revision)).toEqual([1,2]);
    const first=await manifestOf(f,page.manifests[0].ref),last=await manifestOf(f,page.manifests[1].ref);expect(last.stage).toBe("verification");expect(last.outputs).toEqual(first.outputs);expect(last.executionRef).toEqual(first.executionRef);
    const bytes=await f.rpc("read-task-result-evidence",{input:f.input,manifestRef:page.manifests[1].ref,ref:last.outputs[0].ref});expect(Buffer.from(JSON.parse(bytes.stdout).base64,"base64").toString()).toBe("execute bytes\n");
    const vr=await f.rpc("read-task-result-evidence",{input:f.input,manifestRef:page.manifests[1].ref,ref:last.verificationRef});expect(JSON.parse(Buffer.from(JSON.parse(vr.stdout).base64,"base64").toString()).approved).toBe(true);
  });
  // A partial==failed shortcut would suppress real verification; missing reports must preserve the execution snapshot.
  it.each([undefined,{bad:"report"},report])("retains partial reports without changing actual verification or usage: %j",async taskResult=>{
    const f=await resultFixture();let verifies=0;
    const adapter:RuntimeAdapter={plan:async()=>({summary:"write",primaryTargetPaths:["answer.txt"]}),execute:async c=>{await writeFile(join(c.worktreePath,"answer.txt"),"partial bytes");return {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",completionStatus:"partial",failureType:"error",failureMessage:"partial",tokenUsage:9,taskResult}},verify:async()=>{verifies++;return verified}};
    const state=await runLoop(f.contract,f.runDir,adapter,{taskResultInput:f.input});expect(state.status).toBe("succeeded");expect(verifies).toBe(1);expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(991);
    const page=JSON.parse((await f.rpc("task-results",{input:f.input,afterRevision:0})).stdout);const m=await manifestOf(f,page.manifests[1].ref);expect(m.explanation.status).toBe(taskResult===undefined?"missing":"bad" in taskResult?"invalid":"available");expect(m.outputs[0].status).toBe("available");
  });
  // Optional namespace refusal must never turn a successful attempt into a failure.
  it("diagnoses capture I/O failure without changing core success",async()=>{
    const f=await resultFixture();await mkdir(join(f.sourceDir,"control","task-result-evidence"));await symlink(f.repo,join(f.sourceDir,"control","task-result-evidence","blocked"));
    const adapter:RuntimeAdapter={plan:async()=>({summary:"write",primaryTargetPaths:["answer.txt"]}),execute:async c=>{await writeFile(join(c.worktreePath,"answer.txt"),"x");await writeFile(join(f.runDir,"task-result-captures"),"blocks directory");return {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",taskResult:report}},verify:async()=>verified};
    const state=await runLoop(f.contract,f.runDir,adapter,{taskResultInput:f.input});expect(state.status).toBe("succeeded");expect(await readFile(join(f.runDir,"events.jsonl"),"utf8")).toContain("task_result_capture_failed");
  });
  // A later successful terminal must never upgrade attempt one's rejected verification.
  it("shows rejected attempt one as history while attempt two executes, then records its separate pass",async()=>{
    const f=await resultFixture();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let verifies=0;
    const adapter:RuntimeAdapter={plan:async()=>({summary:"write",primaryTargetPaths:["answer.txt"]}),execute:async c=>{if(c.attempt===2){entered();await gate}await writeFile(join(c.worktreePath,"answer.txt"),`attempt ${c.attempt}`);return {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",taskResult:report}},verify:async()=>{verifies++;return verifies===1?{...verified,approved:false,rejectCategory:"test-failure",safeToRetry:true}:verified}};
    const running=runLoop(f.contract,f.runDir,adapter,{taskResultInput:f.input});await ready;
    try{const r=await f.rpc("task-results",{input:f.input,afterRevision:0});expect(r.code,r.stderr).toBe(0);const page=JSON.parse(r.stdout);expect(page.currentAttempt).toBe(2);expect(page.manifests).toHaveLength(2);expect((await manifestOf(f,page.manifests[1].ref)).attempt).toBe(1)}finally{release()}
    expect((await running).status).toBe("succeeded");const page=JSON.parse((await f.rpc("task-results",{input:f.input,afterRevision:0})).stdout);expect(page.manifests).toHaveLength(4);const rejected=await manifestOf(f,page.manifests[1].ref);const read=await f.rpc("read-task-result-evidence",{input:f.input,manifestRef:page.manifests[1].ref,ref:rejected.verificationRef});expect(JSON.parse(Buffer.from(JSON.parse(read.stdout).base64,"base64").toString()).approved).toBe(false);
  });

  // Handoff before verify must retain only execution evidence, never a fabricated approval.
  it.each(["plan","execute"] as const)("handoff after %s retains only actually executed observations",async phase=>{
    const f=await resultFixture(),stopRequested=createStopRequestSignal();let verifies=0;
    const adapter:RuntimeAdapter={plan:async()=>({summary:"write",primaryTargetPaths:["answer.txt"]}),execute:async c=>{await writeFile(join(c.worktreePath,"answer.txt"),"handoff bytes");return {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",taskResult:report}},verify:async()=>{verifies++;return verified}};
    await runLoop(f.contract,f.runDir,adapter,{taskResultInput:f.input,stopRequested,onPhaseSettled:async observation=>{if(observation.phase===phase)stopRequested.requested=true}});expect(verifies).toBe(0);const r=await f.rpc("task-results",{input:f.input,afterRevision:0});expect(r.code,r.stderr).toBe(0);const page=JSON.parse(r.stdout);expect(page.manifests).toHaveLength(phase==="plan"?0:1);if(phase==="execute")expect(await manifestOf(f,page.manifests[0].ref)).toMatchObject({stage:"execution",verificationRef:null});
  });

});
