import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LoopContract } from "../../src/contract/schema.js";
import { canonicalHash, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlCommand } from "../../src/control/command.js";
const exec = promisify(execFile);
export const report = { schema: "task-result-v1", goal: "Produce answer", completedWork: ["Wrote answer"], conclusions: ["Agent claim"], limitations: [], outputs: [{path:"answer.txt",label:"Answer"}] };
export const verified = {approved:true,rejectCategory:"",primaryTargetPaths:["answer.txt"],failingCommand:null,safeToRetry:false,evidence:["check passed"],pauseSignals:[],stopSignals:[]};
export async function resultFixture() {
  const root = await realpath(await mkdtemp("/private/tmp/results-task2-"));
  const repo = join(root,"repo"), sourceDir = join(root,"source");
  await mkdir(repo); await mkdir(sourceDir);
  const git = (args:string[]) => exec("/usr/bin/git",["-c","core.hooksPath=/private/tmp/opr26/safe-ccloop-hooks",...args],{cwd:repo});
  await git(["init"]);await git(["config","user.email","task2@example.invalid"]);await git(["config","user.name","Task 2"]);
  await writeFile(join(repo,"answer.txt"),"base\n");await git(["add","answer.txt"]);await git(["commit","-m","fixture"]);
  const contract:LoopContract={objective:{taskId:"task-1",goal:"Produce answer",successCondition:"check",nonGoals:[]},context:{repoPath:repo,targetPaths:["answer.txt"],relevantDocs:[],buildTestCommands:["true"],constraints:[]},executionPolicy:{autonomyLevel:"L2",maxAttempts:2,perAttemptTimeoutMs:10000,totalRuntimeBudgetMs:30000,tokenBudget:1000,worktreeRequired:true,partialOutcomeRecoveryWindowMs:0},safetyPolicy:{allowlistPaths:[],denylistPaths:[],maxFilesTouched:64,humanGateConditions:[]},verification:{verifierType:"agent",requiredChecks:["true"],rejectOn:["check failed"],evidenceRequired:[]},escalationAndExit:{escalationTargets:[],pauseOn:[],stopOn:[],terminalStates:["succeeded","failed","exhausted","cancelled","blocked_waiting_human"]}};
  const amount={tokens:1000,activeMs:30000,attempts:2,sessions:1};
  const input:LoopStartEnvelope={protocol:3,claim:{groupId:"group-1",workItemId:"work-1",taskId:"task-1",runId:"run-1",generation:1,graphVersion:1,targetVersion:1,commandId:"command-1",configHash:"a".repeat(64),agent:{agent:"fake",model:"fake",contextWindow:"agent-default"},grant:{work:amount,handoff:amount},ownerToken:"owner-1"},contractHash:canonicalHash(contract),inputCheckpoint:null,work:{kind:"loop",contract,targetRepo:repo,base:"HEAD",sourceDir}};
  await writeAccepted(sourceDir,{protocol:1,envelopeHash:canonicalHash(input),executionId:"execution-1",configHash:input.claim.configHash,generation:1,acceptedAt:new Date().toISOString(),launch:"sealed",worker:null});
  const rpc=(method:string,payload:unknown)=>runControlCommand([method,"--agents",join(root,"absent-agents.json")],JSON.stringify(payload));
  return {root,repo,sourceDir,runDir:join(sourceDir,"run"),contract,input,rpc};
}
export async function manifestOf(f:Awaited<ReturnType<typeof resultFixture>>,ref:{artifactId:string,hash:string}) {
  const r=await f.rpc("read-task-result-evidence",{input:f.input,manifestRef:ref,ref});
  if(r.code!==0)throw new Error(r.stderr);
  return JSON.parse(Buffer.from(JSON.parse(r.stdout).base64,"base64").toString());
}
