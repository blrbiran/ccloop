import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import { OmpAdapter } from "../../src/runtime/omp/ompAdapter.js";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { codexFixture, exec } from "../runtime/codex/fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(mode = "normal") {
  const f = await codexFixture();
  roots.push(f.dir);
  const binary = join(f.dir, "omp");
  const calls = join(f.dir, "omp-calls.txt");
  await writeFile(binary, `#!/usr/bin/env node
import {appendFileSync,readFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);
let prompt="";for await(const chunk of process.stdin)prompt+=chunk.toString();
const system=readFileSync(args[args.indexOf("--system-prompt")+1],"utf8");
const phase=system.includes("execution phase")?"execute":system.includes("verification phase")?"verify":"plan";
const mode=${JSON.stringify(mode)};
appendFileSync(${JSON.stringify(calls)},phase+"\\n");
if(phase==="execute"){
  writeFileSync("answer.txt","42\\n");
  if(mode==="offpath")writeFileSync("outside.txt","unauthorized\\n");
}
const result=phase==="plan"?{summary:"Set answer to 42",primaryTargetPaths:["answer.txt"]}:phase==="execute"?{changedFiles:["answer.txt"],diffPatch:"",commandOutputs:[],stdoutStderrLog:"wrote answer"}:{approved:true,rejectCategory:"",primaryTargetPaths:["answer.txt"],failingCommand:null,safeToRetry:false,evidence:["answer is 42"],pauseSignals:[],stopSignals:[]};
const message={role:"assistant",content:[{type:"text",text:JSON.stringify(result)}],provider:"gateway",model:"model-a",stopReason:"stop",usage:{input:8,output:2,cacheRead:3,cacheWrite:1,totalTokens:14,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
for(const row of [{type:"session",id:"fake"},{type:"agent_start"},{type:"message_end",message},{type:"agent_end",isTerminal:true,yielded:true,messages:[message]}])process.stdout.write(JSON.stringify(row)+"\\n");
`, { mode: 0o700 });
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "omp",
    installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
    selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" },
  };
  return { ...f, binary, calls, config };
}

describe("OMP through the real ccloop controller", () => {
  it("runs plan, execute and verify, charges their observed usage, and publishes only the allowed answer", async () => {
    const f = await fixture();
    const state = await runLoop(f.contract, f.runDir, new OmpAdapter(f.config));
    expect(state.status).toBe("succeeded");
    expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(958);
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toEqual(["plan", "execute", "verify"]);
    for (const phase of ["plan", "execution", "verify"]) {
      expect(JSON.parse(await readFile(join(f.runDir, "attempts", "1", `${phase}.json`), "utf8"))).toMatchObject({ tokenUsage: 14, usageEvidence: { normalizedTotal: 14 } });
    }
    expect((await exec("git", ["show", `refs/ccloop/${basename(f.runDir)}/attempts/1:answer.txt`], { cwd: f.repo })).stdout).toBe("42\n");
  }, 30_000);

  it("refuses an unreported execute write outside the task target paths", async () => {
    const f = await fixture("offpath");
    const state = await runLoop(f.contract, f.runDir, new OmpAdapter(f.config));
    expect(state.status).not.toBe("succeeded");
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toEqual(["plan", "execute"]);
  }, 30_000);
});
