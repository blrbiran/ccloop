import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loopContractSchema } from "../../../src/contract/schema.js";
import type { AttemptContext } from "../../../src/runtime/types.js";
export const exec=promisify(execFile);
export async function codexFixture(mode="integration") {
  const dir=await realpath(await mkdtemp(join(tmpdir(),"codex-integration-")));
  const repo=join(dir,"repo"),runDir=join(dir,"run");await mkdir(repo);
  for(const args of [["init"],["config","user.name","Test"],["config","user.email","test@example.com"]])await exec("git",args,{cwd:repo});
  await writeFile(join(repo,"answer.txt"),"0\n");await exec("git",["add","answer.txt"],{cwd:repo});await exec("git",["commit","-m","fixture"],{cwd:repo});
  const check=join(dir,"check.cjs");await writeFile(check,'if(require("fs").readFileSync("answer.txt","utf8")!=="42\\n")process.exit(1);');
  const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
  const command=quote(process.execPath)+" "+quote(check);
  const contract=loopContractSchema.parse({
    objective:{taskId:"codex-test",goal:"Set answer.txt to 42",successCondition:"answer is 42"},
    context:{repoPath:repo,targetPaths:["answer.txt"],buildTestCommands:[command]},
    executionPolicy:{autonomyLevel:"L2",maxAttempts:1,perAttemptTimeoutMs:5000,totalRuntimeBudgetMs:20000,tokenBudget:1000,worktreeRequired:true,partialOutcomeRecoveryWindowMs:1000},
    safetyPolicy:{allowlistPaths:["answer.txt"],maxFilesTouched:1},
    verification:{verifierType:"agent",requiredChecks:[command],rejectOn:["answer differs"]},escalationAndExit:{}
  });
  const context:AttemptContext={contract,runDir,attempt:1,worktreePath:repo,state:{status:"planning",currentAttempt:1,attemptsUsed:1,lastTransitionAt:new Date().toISOString(),waitingOnHuman:false,stopReason:null,budgetSnapshot:{attemptsRemaining:0,timeRemainingMs:20000,tokenBudgetRemaining:1000},recentFailures:[]}};
  const marker=join(dir,"marker");
  const config={command:[process.execPath,fileURLToPath(new URL("../../fixtures/fake-codex.mjs",import.meta.url)),mode,marker],model:"fixture",budgetMode:"soft",sandbox:"workspace-write",timeoutMs:10000,killGraceMs:50};
  return {dir,repo,runDir,contract,context,config,marker};
}
