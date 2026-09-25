import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { resolveAgent } from "../../src/agents/materialize.js";
import { canonicalHash, type HandoffRequestV1, type StartEnvelopeV2 } from "../../src/control/protocol.js";
import { codexInstallation, writeAgentsTable } from "./agentsFixture.js";

const binary=resolve("dist/cli.js"),fakeCodex=resolve("tests/fixtures/fake-codex.mjs");
const roots:string[]=[];
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

// Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): every criterion below drives
// the built CLI as `control <method> --agents <table>` over a one-installation table (the same fake-codex command the
// v1 adapter config named) with a protocol-2 envelope whose claim carries the resolved selection and configHash;
// every identity, evidence, handoff and crash-recovery assertion is unchanged.
async function fixture(mode="integration",runId="run-1"){
 const root=await realpath(await mkdtemp(join(tmpdir(),"ccloop-protocol-e2e-")));roots.push(root);const repo=join(root,"target"),sourceDir=join(root,"source"),marker=join(root,"codex-marker");
 await mkdir(repo,{mode:0o700});await mkdir(sourceDir,{mode:0o700});await mkdir(join(sourceDir,"input"),{mode:0o700});
 for(const args of [["init","-q"],["config","user.name","Test"],["config","user.email","test@example.invalid"]])await commandRaw("git",args,undefined,repo);
 await writeFile(join(repo,"answer.txt"),"0\n");await writeFile(join(repo,"check.cjs"),'if(require("fs").readFileSync("answer.txt","utf8")!=="42\\n")process.exit(1);\n');await commandRaw("git",["add","."],undefined,repo);await commandRaw("git",["commit","-qm","base"],undefined,repo);
 const installation=await codexInstallation({command:[process.execPath,fakeCodex,mode,marker],budgetMode:"soft",sandbox:"workspace-write",timeoutMs:10000,killGraceMs:50});
 const {path:tablePath,table}=await writeAgentsTable({codex:installation},root);const {resolution}=await resolveAgent(table,{agent:"codex",model:"fixture"});
 const check=`${process.execPath} check.cjs`;const contract:LoopContract={objective:{taskId:"task-1",goal:"Set answer.txt to 42",successCondition:"answer is 42",nonGoals:[]},context:{repoPath:repo,targetPaths:["answer.txt"],relevantDocs:[],buildTestCommands:[check],constraints:[]},executionPolicy:{autonomyLevel:"L2",maxAttempts:1,perAttemptTimeoutMs:10000,totalRuntimeBudgetMs:30000,tokenBudget:1000,worktreeRequired:true,partialOutcomeRecoveryWindowMs:100},safetyPolicy:{allowlistPaths:["answer.txt"],denylistPaths:[],maxFilesTouched:2,humanGateConditions:[]},verification:{verifierType:"agent",requiredChecks:[check],rejectOn:["failure"],evidenceRequired:[]},escalationAndExit:{escalationTargets:[],pauseOn:[],stopOn:[],terminalStates:["succeeded","blocked_waiting_human","exhausted","cancelled","failed"]}};
 const grant={tokens:2000,activeMs:120000,attempts:6,sessions:3};const envelope:StartEnvelopeV2={protocol:2,claim:{groupId:"group-1",workItemId:"work-1",taskId:"task-1",runId,generation:1,graphVersion:2,targetVersion:1,commandId:"command-1",configHash:resolution.configHash,agent:resolution.selection,grant:{work:grant,handoff:{tokens:200,activeMs:30000,attempts:1,sessions:1}},ownerToken:"owner-1"},contractHash:canonicalHash(contract),inputCheckpoint:null,work:{contract,targetRepo:repo,base:"HEAD",sourceDir}};
 return {root,repo,sourceDir,marker,tablePath,envelope};
}

function commandRaw(executable:string,args:string[],input?:string,cwd?:string,env:NodeJS.ProcessEnv=process.env):Promise<{code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}>{return new Promise((resolve,reject)=>{const child=spawn(executable,args,{cwd,env,stdio:["pipe","pipe","pipe"]});let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);child.on("error",reject);child.on("exit",(code,signal)=>resolve({code,signal,stdout,stderr}));child.stdin.end(input);});}
async function call(f:Awaited<ReturnType<typeof fixture>>,method:string,payload:unknown,env:NodeJS.ProcessEnv=process.env){return commandRaw(binary,["control",method,"--agents",f.tablePath],JSON.stringify(payload),undefined,env);}
async function accepted(f:Awaited<ReturnType<typeof fixture>>,env:NodeJS.ProcessEnv=process.env){const result=await call(f,"accept",f.envelope,env);expect(result.code,result.stderr).toBe(0);return JSON.parse(result.stdout);}
async function collection(f:Awaited<ReturnType<typeof fixture>>){for(let i=0;i<200;i++){const result=await call(f,"collect",{input:f.envelope,afterSeq:0});expect(result.code,result.stderr).toBe(0);const value=JSON.parse(result.stdout);if(value.candidate?.stopProof&&value.terminal)return value;await sleep(50);}throw new Error("collection timeout");}
async function rows(path:string){try{return (await readFile(path,"utf8")).trim().split("\n").filter(Boolean);}catch{return [];}}
async function waitFile(path:string){for(let i=0;i<200;i++){try{return await readFile(path,"utf8");}catch{}await sleep(20);}throw new Error(`marker timeout: ${path}`);}
async function killAndWait(child:ReturnType<typeof spawn>){if(child.exitCode!==null)return;const exited=new Promise<void>(resolve=>child.once("close",()=>resolve()));if(!child.pid)throw new Error("crash child has no pid");process.kill(child.pid,"SIGKILL");await Promise.race([exited,sleep(5000).then(()=>{throw new Error(`SIGKILL did not close child ${child.pid}`);})]);}

describe("control protocol through the built CLI",{timeout:120000},()=>{
 it("keeps one execution identity across dropped/duplicate accept and exposes complete evidence",async()=>{await chmod(binary,0o755);const f=await fixture();const first=await accepted(f);const recovered=await call(f,"inspect",f.envelope);expect(JSON.parse(recovered.stdout)).toMatchObject({executionId:first.executionId});expect((await accepted(f)).executionId).toBe(first.executionId);
  const done=await collection(f);expect(done.events.map((event:any)=>event.bucket)).toEqual(["work","work","work","handoff"]);expect(done.candidate.stopProof.isolated).toBe(true);expect(await readFile(join(f.sourceDir,"repo","answer.txt"),"utf8")).toBe("42\n");expect((await commandRaw("git",["show-ref","refs/ccloop/run/attempts/1"],undefined,f.repo)).code).toBe(0);const evidence=await call(f,"read-evidence",{input:f.envelope,ref:done.candidate.handoff});expect(evidence.code,evidence.stderr).toBe(0);expect(createHash("sha256").update(Buffer.from(JSON.parse(evidence.stdout).base64,"base64")).digest("hex")).toBe(done.candidate.handoff.hash);expect(await rows(f.marker+".calls")).toEqual(["plan","execute","verify"]);
 });
 it("deduplicates named handoff and rejects old generation or changed envelope without another phase",async()=>{await chmod(binary,0o755);const f=await fixture();await accepted(f);await collection(f);const request:HandoffRequestV1={protocol:1,requestId:"request-1",runId:"run-1",generation:1,reason:"context",deadlineAt:new Date(Date.now()+30000).toISOString()};for(let i=0;i<2;i++){const result=await call(f,"handoff",{input:f.envelope,request});expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout).requestId).toBe(request.requestId);}const old=await call(f,"handoff",{input:f.envelope,request:{...request,requestId:"old",generation:2}});expect(old.code).toBe(2);const conflict=await call(f,"inspect",{...f.envelope,contractHash:"f".repeat(64)});expect(conflict.code).toBe(2);expect(await rows(f.marker+".calls")).toEqual(["plan","execute","verify"]);
 });
 it.each(["accepted-fsynced","worker-claimed","handoff-fsynced","candidate-fsynced"])("recovers the synchronized SIGKILL boundary: %s",async point=>{await chmod(binary,0o755);const f=await fixture();const marker=join(f.root,`crash-${point}`),env={...process.env,NODE_ENV:"test",CCLOOP_CONTROL_TEST_CRASH_POINT:point,CCLOOP_CONTROL_TEST_CRASH_MARKER:marker};
  if(point==="accepted-fsynced"){const child=spawn(binary,["control","accept","--agents",f.tablePath],{env,stdio:["pipe","ignore","ignore"]});child.stdin.end(JSON.stringify(f.envelope));await waitFile(marker);await killAndWait(child);const replay=await call(f,"accept",f.envelope);expect(JSON.parse(replay.stdout)).toEqual({kind:"unknown"});expect(await rows(f.marker+".calls")).toHaveLength(0);return;}
  await accepted(f,env);if(point==="worker-claimed"||point==="candidate-fsynced"){await waitFile(marker);const record=JSON.parse(await readFile(join(f.sourceDir,"control","accepted.json"),"utf8"));process.kill(record.worker.pid,"SIGKILL");await sleep(100);const replay=await call(f,"accept",f.envelope);expect(JSON.parse(replay.stdout)).toEqual({kind:"unknown"});if(point==="candidate-fsynced"){const report=JSON.parse((await call(f,"collect",{input:f.envelope,afterSeq:0})).stdout);expect(report.candidate).not.toBeNull();expect(report.candidate.stopProof).toBeNull();}return;}
  await collection(f);const request={protocol:1,requestId:"request-1",runId:"run-1",generation:1,reason:"context",deadlineAt:new Date(Date.now()+30000).toISOString()};const child=spawn(binary,["control","handoff","--agents",f.tablePath],{env,stdio:["pipe","ignore","ignore"]});child.stdin.end(JSON.stringify({input:f.envelope,request}));await waitFile(marker);await killAndWait(child);const replay=await call(f,"handoff",{input:f.envelope,request});expect(replay.code,replay.stderr).toBe(0);expect(await rows(f.marker+".calls")).toEqual(["plan","execute","verify"]);
 });
});
