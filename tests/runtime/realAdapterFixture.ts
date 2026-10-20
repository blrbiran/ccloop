// Real claude/codex/omp adapters over fakes that record the prompt each call sent (spec
// 2026-10-20-verifier-sees-checks-and-last-failure-design.md §9: "through real adapters with the fakes").
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ompDescriptor } from "../../src/agents/omp.js";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { codexFixture } from "./codex/fixture.js";

const fakeClaude = fileURLToPath(new URL("../fixtures/fake-claude-cli.mjs", import.meta.url));

// A minimal OMP binary that records the prompt it read from stdin and answers each phase (the pattern of
// tests/runtime/omp/ompPhase.test.ts:19-45).
async function ompConfig(dir: string, marker: string): Promise<MaterializedAgentConfigV1> {
  const binary = join(dir, "omp");
  await writeFile(binary, `#!/usr/bin/env node
import {readFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);let prompt="";
for await(const chunk of process.stdin) prompt+=chunk.toString();
const systemPrompt=readFileSync(args[args.indexOf("--system-prompt")+1],"utf8");
writeFileSync(${JSON.stringify(marker)},JSON.stringify({prompt}));
const result=systemPrompt.includes("execution phase")?{changedFiles:[],diffPatch:"",commandOutputs:[],stdoutStderrLog:""}
 :systemPrompt.includes("verification phase")?{approved:true,rejectCategory:"",primaryTargetPaths:[],failingCommand:null,safeToRetry:false,evidence:[],pauseSignals:[],stopSignals:[]}
 :{summary:"s",primaryTargetPaths:["answer.txt"]};
const message={role:"assistant",content:[{type:"text",text:JSON.stringify(result)}],provider:"gateway",model:"model-a",stopReason:"stop",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
for(const row of [{type:"session",id:"fake"},{type:"agent_start"},{type:"message_end",message},{type:"agent_end",isTerminal:true,yielded:true,messages:[message]}])process.stdout.write(JSON.stringify(row)+"\\n");
`, { mode: 0o700 });
  return {
    schema: "ccloop-agent-config-v1", kind: "omp",
    installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
    selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" },
  };
}

export async function realAdapter(kind: "claude" | "codex" | "omp", roots: string[]) {
  const f = await codexFixture("ok"); roots.push(f.dir);
  const adapter: RuntimeAdapter = kind === "codex" ? new CodexAdapter(f.config)
    : kind === "claude" ? new ClaudeAgentAdapter({
      schema: "ccloop-agent-config-v1", kind: "claude",
      installation: { kind: "claude", command: [process.execPath, fakeClaude, "ok", f.marker], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
      selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
    })
    : ompDescriptor.createAdapter(await ompConfig(f.dir, f.marker));
  const prompt = async () => (JSON.parse(await readFile(f.marker, "utf8")) as { prompt: string }).prompt;
  return { f, adapter, prompt };
}

